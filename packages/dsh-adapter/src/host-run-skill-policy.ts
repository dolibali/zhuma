import { createHash } from 'node:crypto';
import { isAlias, isMap, isScalar, parseDocument, visit } from 'yaml';
import {
  AppliedPlanSchema,
  AssetSchema,
  ASSET_IMPORT_LIMITS,
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  packageFileBytes,
  packageFileText,
  StoredAssetPackageSchema,
  type TeamAsset,
  type Workbench,
} from '@zhuma/agent-core';
import type { ExecutionService } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import type { MemberRequest } from './member-session.js';

type Locator = Parameters<ExecutionService['readRunNode']>[0] & { readonly spaceId: string };
/** Host-private result. Never accepted from a browser or used as an authorization grant. */
export interface HostQualifiedSkillPolicy {
  readonly ref: { readonly id: string; readonly version: string };
  readonly definitionDigest: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly policySource:
    | { readonly kind: 'manual-default' }
    | {
        readonly kind: 'asset-package';
        readonly versionId: string;
        readonly digest: string;
        readonly entryPath: string;
      };
}
function unavailable(): never {
  // No package body, parser diagnostics, local paths or metadata escape this boundary.
  throw new ExecutionRunError('run-authority-unavailable');
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Fixed 687f SkillFileSystem invocation semantics, using a static YAML subset. */
function invocation(text: string): HostQualifiedSkillPolicy['invocation'] {
  if (text.length > ASSET_IMPORT_LIMITS.skillChars) unavailable();
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);
  if (!match || !match[2]!.trim()) unavailable();
  const doc = parseDocument(match[1]!, { schema: 'core', strict: true, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) unavailable();
  visit(doc, (_key, node) => {
    if (
      isAlias(node) ||
      (node &&
        typeof node === 'object' &&
        (('tag' in node && node.tag) || ('anchor' in node && node.anchor)))
    )
      unavailable();
  });
  for (const pair of doc.contents.items)
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') unavailable();
  const meta: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) unavailable();
  const data = meta as Record<string, unknown>;
  if (
    typeof data.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(data.name) ||
    typeof data.description !== 'string' ||
    !data.description.length ||
    ['disableModelInvocation', 'modelInvocable', 'userInvocable'].some((key) =>
      Object.hasOwn(data, key),
    )
  )
    unavailable();
  const boolean = (key: string): boolean | undefined => {
    if (!Object.hasOwn(data, key)) return undefined;
    const value = data[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') {
      if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true;
      if (['false', 'no', 'off'].includes(value.toLowerCase())) return false;
    }
    return unavailable();
  };
  return {
    modelInvocable: boolean('disable-model-invocation') !== true,
    userInvocable: boolean('user-invocable') !== false,
  };
}

function importedPolicy(
  definition: TeamAsset,
  raw: unknown,
): Pick<HostQualifiedSkillPolicy, 'invocation' | 'policySource'> {
  const origin = definition.origin;
  if (
    !origin ||
    origin.format !== 'agent-skill' ||
    origin.missing.length ||
    origin.entryPath.split('/').at(-1) !== 'SKILL.md' ||
    new Set(origin.filePaths).size !== origin.filePaths.length ||
    !origin.filePaths.includes(origin.entryPath)
  )
    unavailable();
  const parsed = StoredAssetPackageSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  const stored = parsed.data;
  if (
    stored.versionId !== origin.versionId ||
    new Set(stored.files.map((file) => file.path)).size !== stored.files.length ||
    stored.files.some((file) => packageFileBytes(file) > ASSET_IMPORT_LIMITS.fileBytes) ||
    stored.files.reduce((sum, file) => sum + packageFileBytes(file), 0) >
      ASSET_IMPORT_LIMITS.totalBytes ||
    digest(JSON.stringify(stored.files)) !== stored.digest ||
    origin.filePaths.some((path) => !stored.files.some((file) => file.path === path))
  )
    unavailable();
  const files = stored.files.filter((file) => origin.filePaths.includes(file.path));
  if (files.reduce((sum, file) => sum + packageFileBytes(file), 0) !== origin.totalBytes)
    unavailable();
  const entries = files.filter((file) => file.path === origin.entryPath);
  if (entries.length !== 1) unavailable();
  return {
    invocation: invocation(packageFileText(entries[0]!)),
    policySource: {
      kind: 'asset-package',
      versionId: stored.versionId,
      digest: stored.digest,
      entryPath: origin.entryPath,
    },
  };
}

/** Build only from a fresh same-node member read and that confirmed plan's selected origins.
 * readPackage is the existing immutable package table, kept inside the Host closure.
 * It must not be Workbench.resourceFiles, a current asset lookup or a public RPC.
 */
export function createHostRunSkillPolicies(options: {
  readonly execution: Pick<ExecutionService, 'readRunCompositionInputs' | 'readRunNode'>;
  readWorkbench(): Workbench;
  readPackage(versionId: string): unknown;
  readonly signal: AbortSignal;
}) {
  const active = () => {
    if (options.signal.aborted) unavailable();
  };
  return {
    async read(
      request: MemberRequest,
      locator: Locator,
    ): Promise<readonly HostQualifiedSkillPolicy[]> {
      try {
        active();
        locator = Object.freeze({ ...locator });
        const authorize = async () => {
          active();
          const response = await options.execution.readRunCompositionInputs(request, locator);
          active();
          if (!response.ok) unavailable();
          const echo = response.value;
          if (
            !echo.actorId ||
            echo.spaceId !== locator.spaceId ||
            echo.taskId !== locator.taskId ||
            echo.planId !== locator.planId ||
            echo.revision !== locator.revision ||
            echo.nodeId !== locator.nodeId ||
            !Array.isArray(echo.items) ||
            echo.items.some((item) => item.access !== 'visible' || item.blocking)
          )
            unavailable();
          return echo.actorId;
        };
        const actorId = await authorize();
        const node = options.execution.readRunNode(locator);
        if (!node) unavailable();
        const state = options.readWorkbench();
        if (
          state.appliedPlans.filter(
            (plan) =>
              plan.id === locator.planId &&
              plan.taskId === locator.taskId &&
              plan.revision === locator.revision,
          ).length !== 1
        )
          unavailable();
        const applied = AppliedPlanSchema.parse(createExecutionHandoff(locator, state));
        const handoff = createNodeHandoffs(applied).find((item) => item.nodeId === locator.nodeId);
        if (
          !handoff ||
          node.taskId !== locator.taskId ||
          node.planId !== locator.planId ||
          node.revision !== locator.revision ||
          node.nodeId !== locator.nodeId ||
          canonicalPayload({ ...handoff, inputRefs: node.handoff.inputRefs }) !==
            canonicalPayload(node.handoff) ||
          new Set(handoff.skillRefs.map((ref) => ref.id)).size !== handoff.skillRefs.length
        )
          unavailable();
        const nodeVersion = node.command.version;
        const handoffFingerprint = canonicalPayload(node.handoff);
        const policies = handoff.skillRefs.map((ref) => {
          if (ref.version !== applied.id) unavailable();
          const matches = applied.assets.filter((asset) => asset.id === ref.id);
          if (matches.length !== 1) unavailable();
          const definition = AssetSchema.parse(matches[0]);
          if (definition.kind !== 'skill' || !definition.available) unavailable();
          active();
          const policy = definition.origin
            ? importedPolicy(definition, options.readPackage(definition.origin.versionId))
            : {
                invocation: { modelInvocable: true, userInvocable: true },
                policySource: { kind: 'manual-default' as const },
              };
          active();
          return {
            ref: { ...ref },
            definitionDigest: digest(canonicalPayload(definition)),
            ...policy,
          };
        });
        // Permission may be revoked while reading inputs. Recheck the original
        // MemberRequest, not a caller-supplied actor/space echo, before publishing.
        if ((await authorize()) !== actorId) unavailable();
        const current = options.execution.readRunNode(locator);
        if (
          !current ||
          current.command.version !== nodeVersion ||
          canonicalPayload(current.handoff) !== handoffFingerprint
        )
          unavailable();
        active();
        for (const policy of policies) {
          Object.freeze(policy.ref);
          Object.freeze(policy.invocation);
          Object.freeze(policy.policySource);
          Object.freeze(policy);
        }
        return Object.freeze(policies);
      } catch {
        return unavailable();
      }
    },
  };
}
