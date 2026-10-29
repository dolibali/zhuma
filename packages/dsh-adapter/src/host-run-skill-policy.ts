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
  type AppliedPlan,
  type TeamAsset,
  type Workbench,
  type RemoteWorkflowRef,
} from '@zhuma/agent-core';
import type { ExecutionService } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import type { MemberRequest } from './member-session.js';
import type { ExecutionReviewPreparation } from './execution-review-composition.js';
import {
  executionReviewScopeSchema,
  type ExecutionReviewTarget,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import { executionReviewTarget } from './execution-review-state.js';

/** Exact input of D's passive preparation read. Content only, never review authority. */
export interface HostReviewPreparationRequest {
  readonly workflow?: RemoteWorkflowRef;
  readonly requestId: string;
  readonly expectedReviewVersion: number;
  readonly target: ExecutionReviewTarget;
  readonly reviewerRef: Pick<
    ExecutionReviewScope['review']['principal']['reviewerRef'],
    'id' | 'version'
  >;
}

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
/** Metadata lifetime only; a genuine Run grant remains independently required. */
export interface HostRunSkillPolicyQualification {
  readonly policies: readonly HostQualifiedSkillPolicy[];
  assertCurrent(): undefined;
}
export interface HostReviewSkillPolicyQualification extends HostRunSkillPolicyQualification {
  readonly preparation: ExecutionReviewPreparation;
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
  readonly execution: Pick<ExecutionService, 'readRunCompositionInputs' | 'readRunNode'> &
    Partial<Pick<ExecutionService, 'readExpertReviewPreparation'>>;
  readWorkbench(): Workbench;
  readPackage(versionId: string): unknown;
  readonly signal: AbortSignal;
}) {
  const { execution, readWorkbench, readPackage, signal } = options;
  const readInputs = execution.readRunCompositionInputs;
  const readNode = execution.readRunNode;
  const readReview = execution.readExpertReviewPreparation;
  const active = () => {
    if (
      signal.aborted ||
      options.signal !== signal ||
      options.execution !== execution ||
      options.readWorkbench !== readWorkbench ||
      options.readPackage !== readPackage ||
      execution.readRunCompositionInputs !== readInputs ||
      execution.readRunNode !== readNode
    )
      unavailable();
  };
  function reviewPolicies(
    preparation: ExecutionReviewPreparation,
    synchronousApplied?: AppliedPlan,
  ): HostRunSkillPolicyQualification {
    try {
      active();
      if (!readReview || execution.readExpertReviewPreparation !== readReview) unavailable();
      const scope = executionReviewScopeSchema.parse(preparation.scope);
      const applied = AppliedPlanSchema.parse(
        synchronousApplied ?? createExecutionHandoff(scope, readWorkbench.call(options)),
      );
      const fingerprint = canonicalPayload(applied);
      const handoffFingerprint = canonicalPayload(preparation.node.handoff);
      const reviewer = applied.participants.find(
        (item) => item.id === scope.review.principal.reviewerRef.id,
      );
      if (
        canonicalPayload(applied) !== canonicalPayload(preparation.applied) ||
        !reviewer ||
        reviewer.kind !== 'expert' ||
        !reviewer.available ||
        reviewer.origin?.missing.length ||
        digest(canonicalPayload(reviewer)) !== scope.review.principal.reviewerRef.digest
      )
        unavailable();
      const checkSource = (sameCallApplied?: AppliedPlan) => {
        active();
        if (execution.readExpertReviewPreparation !== readReview) unavailable();
        const current = readNode.call(execution, scope);
        const round = current?.rounds.find((item) => item.id === scope.review.target.roundId);
        if (
          !current ||
          current.ownerId !== scope.actorId ||
          applied.task.ownerId !== scope.actorId ||
          canonicalPayload(current.handoff) !== handoffFingerprint ||
          canonicalPayload(executionReviewTarget(current, scope.spaceId)) !==
            canonicalPayload(scope.review.target) ||
          !round?.reviewerIds.includes(reviewer.id) ||
          round.ballots.some(
            (item) => item.reviewerId === reviewer.id && item.action !== 'comment',
          ) ||
          canonicalPayload(
            sameCallApplied ??
              AppliedPlanSchema.parse(createExecutionHandoff(scope, readWorkbench.call(options))),
          ) !== fingerprint
        )
          unavailable();
      };
      checkSource(synchronousApplied ? applied : undefined);
      const refs = reviewer.resourceBindings?.skillIds ?? [];
      if (new Set(refs).size !== refs.length) unavailable();
      const originals = new Map<string, { raw: unknown; fingerprint: string }>();
      const policies = refs.map((id) => {
        const matches = applied.assets.filter((asset) => asset.id === id);
        if (matches.length !== 1) unavailable();
        const definition = AssetSchema.parse(matches[0]);
        if (definition.kind !== 'skill' || !definition.available) unavailable();
        let policy: Pick<HostQualifiedSkillPolicy, 'invocation' | 'policySource'>;
        if (definition.origin) {
          const version = definition.origin.versionId;
          let original = originals.get(version);
          if (!original) {
            const raw = readPackage.call(options, version);
            original = { raw, fingerprint: digest(canonicalPayload(raw)) };
            originals.set(version, original);
          }
          policy = importedPolicy(definition, original.raw);
        } else
          policy = {
            invocation: { modelInvocable: true, userInvocable: true },
            policySource: { kind: 'manual-default' },
          };
        return Object.freeze({
          ref: Object.freeze({ id, version: applied.id }),
          definitionDigest: digest(canonicalPayload(definition)),
          invocation: Object.freeze(policy.invocation),
          policySource: Object.freeze(policy.policySource),
        });
      });
      const packages = new Map(
        [...originals].map(([version, item]) => [version, item.fingerprint]),
      );
      originals.clear();
      const assertCurrent = (): undefined => {
        try {
          checkSource();
          for (const [version, fingerprint] of packages) {
            if (digest(canonicalPayload(readPackage.call(options, version))) !== fingerprint)
              unavailable();
          }
          active();
          return undefined;
        } catch {
          return unavailable();
        }
      };
      // A synchronous catalog consumes the already fresh plan once. The returned
      // continuing assertion still ALWAYS reads live sources, including after an
      // await; the supplied same-call plan is not used by that closure.
      if (!synchronousApplied) assertCurrent();
      active();
      return Object.freeze({ policies: Object.freeze(policies), assertCurrent });
    } catch {
      return unavailable();
    }
  }
  async function qualify(
    request: MemberRequest,
    locator: Locator,
  ): Promise<HostRunSkillPolicyQualification> {
    try {
      active();
      locator = Object.freeze({ ...locator });
      const authorize = async () => {
        active();
        const response = await readInputs.call(execution, request, locator);
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
      const node = readNode.call(execution, locator);
      if (!node) unavailable();
      const state = readWorkbench.call(options);
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
      const originals = new Map<string, { raw: unknown; fingerprint: string }>();
      const policies = handoff.skillRefs.map((ref) => {
        if (ref.version !== applied.id) unavailable();
        const matches = applied.assets.filter((asset) => asset.id === ref.id);
        if (matches.length !== 1) unavailable();
        const definition = AssetSchema.parse(matches[0]);
        if (definition.kind !== 'skill' || !definition.available) unavailable();
        active();
        let policy: Pick<HostQualifiedSkillPolicy, 'invocation' | 'policySource'>;
        if (definition.origin) {
          const version = definition.origin.versionId;
          let original = originals.get(version);
          if (!original) {
            const raw = readPackage.call(options, version);
            original = { raw, fingerprint: digest(canonicalPayload(raw)) };
            originals.set(version, original);
          }
          policy = importedPolicy(definition, original.raw);
        } else
          policy = {
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
      const current = readNode.call(execution, locator);
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
      const fingerprint = canonicalPayload(applied);
      const packageFingerprints = new Map(
        [...originals].map(([version, original]) => [version, original.fingerprint]),
      );
      originals.clear();
      const assertCurrent = (): undefined => {
        try {
          active();
          const current = readNode.call(execution, locator);
          const state = readWorkbench.call(options);
          if (
            !current ||
            canonicalPayload(current.handoff) !== handoffFingerprint ||
            state.appliedPlans.filter(
              (plan) =>
                plan.id === locator.planId &&
                plan.taskId === locator.taskId &&
                plan.revision === locator.revision,
            ).length !== 1 ||
            canonicalPayload(AppliedPlanSchema.parse(createExecutionHandoff(locator, state))) !==
              fingerprint
          )
            unavailable();
          // Parse invocation metadata once. Rehash each distinct original record
          // to detect replacement/corruption without reparsing YAML per step.
          for (const [version, fingerprint] of packageFingerprints) {
            const current = readPackage.call(options, version);
            active();
            if (digest(canonicalPayload(current)) !== fingerprint) unavailable();
          }
          active();
          return undefined;
        } catch {
          return unavailable();
        }
      };
      return Object.freeze({ policies: Object.freeze(policies), assertCurrent });
    } catch {
      return unavailable();
    }
  }
  return {
    /** Synchronous metadata re-derivation for D's current authorized facts, not a grant. */
    review: reviewPolicies,
    async qualifyReview(
      request: MemberRequest,
      input: HostReviewPreparationRequest,
    ): Promise<HostReviewSkillPolicyQualification> {
      try {
        active();
        if (!readReview || execution.readExpertReviewPreparation !== readReview) unavailable();
        const query = Object.freeze(structuredClone(input));
        const first = await readReview.call(execution, request, query);
        active();
        if (!first.ok) unavailable();
        const policy = reviewPolicies(first.value);
        const second = await readReview.call(execution, request, query);
        active();
        if (
          !second.ok ||
          canonicalPayload(first.value.scope) !== canonicalPayload(second.value.scope) ||
          canonicalPayload(first.value.applied) !== canonicalPayload(second.value.applied) ||
          execution.readExpertReviewPreparation !== readReview
        )
          unavailable();
        policy.assertCurrent();
        return Object.freeze({ preparation: second.value, ...policy });
      } catch {
        return unavailable();
      }
    },
    qualify,
    async read(
      request: MemberRequest,
      locator: Locator,
    ): Promise<readonly HostQualifiedSkillPolicy[]> {
      return (await qualify(request, locator)).policies;
    },
  };
}
