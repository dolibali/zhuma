import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AssetSchema,
  REMOTE_RUN_RESOURCE_SOURCE_VERSION,
  canonicalPayload,
  type AppliedPlan,
  type NodeHandoff,
  type Participant,
} from '@zhuma/agent-core';

/** Bump when the adopted SDK APIs, descriptor projection or lifecycle changes. */
export const EXECUTION_RESOURCE_SOURCE_VERSION = REMOTE_RUN_RESOURCE_SOURCE_VERSION;
export const EXECUTION_RESOURCE_LIMITS = Object.freeze({
  skills: 8,
  skillBodyBytes: 16_384,
  totalSkillBytes: 32_768,
  connections: 4,
  toolsPerConnection: 8,
  descriptorsBytes: 16_384,
});
const id = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const ref = z.strictObject({ id, version: id });
const invocationSchema = z.strictObject({
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
});
const policySourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual-default') }),
  z.strictObject({
    kind: z.literal('asset-package'),
    versionId: z.uuid(),
    digest,
    entryPath: z.string().min(1).max(1000),
  }),
]);
export interface QualifiedExecutionSkillPolicy {
  readonly ref: { readonly id: string; readonly version: string };
  readonly definitionDigest: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly policySource: z.infer<typeof policySourceSchema>;
}
const jsonObject = z.record(z.string(), z.json());
export const executionResourceToolSchema = z.strictObject({
  name: z
    .string()
    .regex(/^mcp__[A-Za-z0-9_-]{1,32}__[A-Za-z0-9_-]+$/u)
    .max(64),
  description: z.string().max(4000),
  parameters: jsonObject.refine((value) => value.type === 'object'),
  outputSchema: jsonObject,
  deferLoading: z.literal(true).optional(),
});
export type ExecutionResourceTool = z.infer<typeof executionResourceToolSchema>;
const mcpSchema = z.strictObject({
  ref,
  definitionDigest: digest,
  connectionRef: ref,
  serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  tools: z
    .array(executionResourceToolSchema)
    .min(1)
    .max(EXECUTION_RESOURCE_LIMITS.toolsPerConnection),
});
export type FrozenMcpResource = z.infer<typeof mcpSchema>;
export const executionRunResourcesSchema = z
  .strictObject({
    sourceVersion: z.literal(EXECUTION_RESOURCE_SOURCE_VERSION),
    skills: z
      .array(
        z.strictObject({
          ref,
          name: z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
            .max(100),
          description: z.string().min(1).max(2000),
          definition: AssetSchema.refine(
            (asset) => asset.kind === 'skill' && asset.available && !asset.origin?.missing.length,
          ),
          definitionDigest: digest,
          invocation: invocationSchema,
          policySource: policySourceSchema,
        }),
      )
      .max(EXECUTION_RESOURCE_LIMITS.skills),
    mcp: z.array(mcpSchema).max(EXECUTION_RESOURCE_LIMITS.connections),
  })
  .superRefine((value, context) => {
    const names = value.skills.map((item) => item.name);
    const refs = [...value.skills, ...value.mcp].map((item) => canonicalPayload(item.ref));
    const connections = value.mcp.map((item) => canonicalPayload(item.connectionRef));
    const namespaces = value.mcp.map((item) => item.serverName);
    const tools = value.mcp.flatMap((item) => item.tools.map((tool) => tool.name));
    if (
      value.skills.some(
        (item) =>
          item.definitionDigest !== executionResourceDigest(item.definition) ||
          item.definition.id !== item.ref.id ||
          !item.definition.content.trim(),
      ) ||
      value.skills.some((item) =>
        item.definition.origin
          ? item.policySource.kind !== 'asset-package' ||
            item.policySource.versionId !== item.definition.origin.versionId ||
            item.policySource.entryPath !== item.definition.origin.entryPath
          : item.policySource.kind !== 'manual-default' ||
            !item.invocation.modelInvocable ||
            !item.invocation.userInvocable,
      ) ||
      new Set(names).size !== names.length ||
      new Set(refs).size !== refs.length ||
      new Set(connections).size !== connections.length ||
      new Set(namespaces).size !== namespaces.length ||
      new Set(tools).size !== tools.length ||
      value.skills.some(
        (item) =>
          Buffer.byteLength(item.definition.content) > EXECUTION_RESOURCE_LIMITS.skillBodyBytes,
      ) ||
      value.skills.reduce((size, item) => size + Buffer.byteLength(item.definition.content), 0) >
        EXECUTION_RESOURCE_LIMITS.totalSkillBytes ||
      value.mcp.some((item) =>
        item.tools.some((tool) => !tool.name.startsWith(`mcp__${item.serverName}__`)),
      ) ||
      Buffer.byteLength(canonicalPayload(value.mcp.map((item) => item.tools))) >
        EXECUTION_RESOURCE_LIMITS.descriptorsBytes
    )
      context.addIssue({ code: 'custom', message: 'Invalid bounded execution resource catalog.' });
  });
export type FrozenExecutionRunResources = z.infer<typeof executionRunResourcesSchema>;
/** Already qualified Host metadata only. Resolving this catalog must not start a Run,
 * connect a server or interpret an asset's text as executable connection configuration.
 */
export interface ExecutionRunResourceCatalog {
  readonly sourceVersion: typeof EXECUTION_RESOURCE_SOURCE_VERSION;
  readonly mcp: readonly FrozenMcpResource[];
  /** Imported metadata must come from its authorized immutable original package. */
  readonly skills?: readonly QualifiedExecutionSkillPolicy[];
}
export class ExecutionRunResourceError extends Error {
  constructor(readonly code: 'resources-unavailable' | 'resources-mismatch' | 'resources-budget') {
    super('本次运行的资源无法核实。');
    this.name = 'ExecutionRunResourceError';
  }
}
function fail(code: ExecutionRunResourceError['code'] = 'resources-mismatch'): never {
  throw new ExecutionRunResourceError(code);
}
export function executionResourceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function readExecutionRunResources(value: unknown): FrozenExecutionRunResources {
  const parsed = executionRunResourcesSchema.safeParse(value);
  return parsed.success ? freeze(parsed.data) : fail();
}
/** Pure derivation from the same immutable plan. No current/global asset lookup. */
export function freezeExecutionRunResources(
  applied: AppliedPlan,
  handoff: Pick<NodeHandoff, 'skillRefs' | 'mcpRefs'>,
  expert: Participant | undefined,
  catalog: ExecutionRunResourceCatalog,
): FrozenExecutionRunResources {
  if (catalog.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION || !Array.isArray(catalog.mcp))
    fail('resources-unavailable');
  const selected = [...handoff.skillRefs, ...handoff.mcpRefs];
  if (
    new Set(selected.map((item) => item.id)).size !== selected.length ||
    selected.some((item) => item.version !== applied.id)
  )
    fail();
  if (
    expert?.resourceBindings?.skillIds.some(
      (id) => !handoff.skillRefs.some((item) => item.id === id),
    ) ||
    expert?.resourceBindings?.mcpIds.some((id) => !handoff.mcpRefs.some((item) => item.id === id))
  )
    fail();
  const asset = (reference: { id: string; version: string }, kind: 'skill' | 'mcp') => {
    const matches = applied.assets.filter((item) => item.id === reference.id);
    if (matches.length !== 1) return fail('resources-unavailable');
    const parsed = AssetSchema.safeParse(matches[0]);
    if (
      !parsed.success ||
      parsed.data.kind !== kind ||
      !parsed.data.available ||
      parsed.data.origin?.missing.length
    )
      return fail('resources-unavailable');
    return parsed.data;
  };
  const skills = handoff.skillRefs.map((reference) => {
    const definition = asset(reference, 'skill');
    const policies =
      catalog.skills?.filter(
        (item) => canonicalPayload(item.ref) === canonicalPayload(reference),
      ) ?? [];
    if (policies.length > 1 || (definition.origin && policies.length !== 1))
      fail('resources-unavailable');
    const policy = policies[0];
    if (policy && policy.definitionDigest !== executionResourceDigest(definition))
      fail('resources-unavailable');
    return {
      ref: { ...reference },
      name:
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.id) && definition.id.length <= 100
          ? definition.id
          : `skill-${executionResourceDigest(reference).slice(0, 24)}`,
      description: `${definition.name}：${definition.description}`.slice(0, 2000),
      definition,
      definitionDigest: executionResourceDigest(definition),
      invocation: policy?.invocation ?? { modelInvocable: true, userInvocable: true },
      policySource: policy?.policySource ?? { kind: 'manual-default' as const },
    };
  });
  if (
    catalog.skills?.some(
      (item) =>
        !handoff.skillRefs.some(
          (selected) => canonicalPayload(selected) === canonicalPayload(item.ref),
        ),
    )
  )
    fail();
  if (catalog.mcp.length !== handoff.mcpRefs.length) fail();
  const mcp = handoff.mcpRefs.map((reference) => {
    const definition = asset(reference, 'mcp');
    const matches = catalog.mcp.filter(
      (item) => canonicalPayload(item.ref) === canonicalPayload(reference),
    );
    if (
      matches.length !== 1 ||
      matches[0]!.definitionDigest !== executionResourceDigest(definition)
    )
      fail('resources-unavailable');
    // Never copy MCP asset content, endpoint, command, credentials or headers into a Run.
    return matches[0]!;
  });
  return readExecutionRunResources({
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    skills,
    mcp,
  });
}
export function executionResourceToolNames(resources: FrozenExecutionRunResources): string[] {
  if (!resources.skills.length && !resources.mcp.length) return [];
  return [
    // Nonempty frozen resources retain the original generic loader capability.
    'skill',
    ...resources.mcp.flatMap((item) => item.tools.map((tool) => tool.name)),
  ];
}
