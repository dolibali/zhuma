import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AppliedPlanSchema,
  ParticipantSchema,
  canonicalPayload,
  createExecutionHandoff,
  createNodeHandoffs,
  type ExecutionNodeRecord,
  type Workbench,
  type VersionedRef,
} from '@zhuma/agent-core';
import { ACCEPTED_INPUT_TOOL, acceptedInputRef } from './native-work-session-input-tool.js';
import type { NativeSessionSelection, NativeWorkScope } from './native-work-session-contract.js';
import type { UpstreamInputView } from './upstream-inputs.js';
import {
  executionRunResourcesSchema,
  executionResourceToolNames,
  freezeExecutionRunResources,
  type ExecutionRunResourceCatalog,
  EXECUTION_RESOURCE_SOURCE_VERSION,
} from './execution-run-resource-snapshot.js';

export const EXECUTION_COMPOSITION_LIMITS = Object.freeze({
  snapshotBytes: 65_536,
  contextBytes: 49_152,
  contextCharacters: 20_000,
  inputs: 100,
});
const id = z.string().trim().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const ref = z.strictObject({ id, version: id });
const scopeSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
  generation: positive,
  segmentId: id,
});
const modelSchema = z.strictObject({
  provider: id,
  model: id,
  reasoningEffort: id.optional(),
  maxTokens: positive.max(65_536),
});
const builtinSchema = z.strictObject({
  id: z.literal('zhuma-basic-task-executor'),
  version: z.literal('1.0.0'),
  name: z.literal('Zhuma基础任务执行者'),
  instructions: z.string().min(1).max(4000),
});
const builtin = Object.freeze({
  id: 'zhuma-basic-task-executor' as const,
  version: '1.0.0' as const,
  name: 'Zhuma基础任务执行者' as const,
  instructions:
    '只处理当前节点指定的工作，遵守固定计划和明确的工具权限。按需读取清单中已接受的固定输入；引用不代表正文已读取，输入缺失时停止并说明。返回可核对的产物草稿与必要说明，不把会话结束、工具成功或自己的判断当作提交、评审通过或下游已完成。',
});
export const BASIC_TASK_EXECUTOR = Object.freeze({ ...builtin, digest: hash(builtin) });
const executorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin'), definition: builtinSchema, digest: sha }),
  z.strictObject({
    kind: z.literal('plan-expert'),
    ref,
    definition: ParticipantSchema,
    digest: sha,
  }),
]);
const executorChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin') }),
  z.strictObject({ kind: z.literal('plan-expert'), ref }),
]);
const jsonObject = z.record(z.string(), z.json());
const toolSchema = z.strictObject({
  name: z.literal(ACCEPTED_INPUT_TOOL),
  description: z.string().min(1).max(4000),
  parameters: jsonObject.refine((value) => value.type === 'object'),
  outputSchema: jsonObject,
  sourceVersion: id,
});
/** Accept C's readonly descriptor without copying its declaration or trusting its JSON shape. */
export interface AcceptedInputToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema: unknown;
  readonly sourceVersion: string;
}
/** Only a ready Host port supplies C's exact registered descriptor; this is not a grant. */
export interface AcceptedFileToolDefinition extends AcceptedInputToolDefinition {
  readonly name: 'read_accepted_file';
  readonly sourceVersion: 'zhuma-accepted-files@2';
}
const acceptedFileToolName = 'read_accepted_file';
// C's SDK-supported v2 descriptor, canonical fields of source artifact SHA256
// d2fa881375b612a32f2dcb554984145f00eb8e49f7fa2d3a4a15f5f6723b448b.
// The SDK declaration is flat; C's strict parser enforces conditional file rules.
const acceptedFileToolSchema = toolSchema
  .extend({
    name: z.literal(acceptedFileToolName),
    sourceVersion: z.literal('zhuma-accepted-files@2'),
  })
  .refine(
    (value) => hash(value) === '6e676da0e4023d3daf24872e7598f9f7f382978cdbec746c13613efb7bdd96f9',
  );
/** Explicit new-Run completion intent only; its descriptor is not submission authority. */
export interface ResultIntentToolDefinition extends AcceptedInputToolDefinition {
  readonly name: 'complete_work';
  readonly sourceVersion: 'zhuma-native-result-intent@1';
}
const resultIntentToolName = 'complete_work';
// C's SDK-registered declaration candidate. Full invocation/cut qualification
// remains separate. Source artifact SHA256:
// 241bae9b4e21db3acbf9f4a4743d10e0934e1abc473ef1c259304f6518215931.
const resultIntentToolSchema = toolSchema
  .extend({
    name: z.literal(resultIntentToolName),
    sourceVersion: z.literal('zhuma-native-result-intent@1'),
  })
  .refine(
    (value) => hash(value) === 'fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386',
  );
/** C's exact publisher description only; workspace and publication grants remain separate. */
export interface OutputFilePublisherToolDefinition extends AcceptedInputToolDefinition {
  readonly name: 'publish_output_file';
  readonly sourceVersion: 'zhuma-native-output-file@1';
}
const outputFilePublisherToolName = 'publish_output_file';
// Original C getter at 4ffe66c6; pretty JSON+LF source artifact SHA256
// 05b8afb17725bffd3a5d778fe449d453bfd085dc3ef308f041ee9cb58c28e63b.
// Freeze the complete descriptor without importing the SDK or copying its JSON.
const outputFilePublisherToolSchema = toolSchema
  .extend({
    name: z.literal(outputFilePublisherToolName),
    sourceVersion: z.literal('zhuma-native-output-file@1'),
  })
  .refine(
    (value) => hash(value) === '9396477fb52178087d78975767bf745c6d57d9061f2b3bc7aeaf8ea5d25a9edd',
  );
export type LocalFileToolName = 'read' | 'write' | 'edit';
export interface LocalFileToolDefinition extends AcceptedInputToolDefinition {
  readonly name: LocalFileToolName;
}
export interface ForegroundShellToolDefinition extends AcceptedInputToolDefinition {
  readonly name: 'bash';
  readonly budget: {
    readonly defaultTimeoutMs: number;
    readonly maxTimeoutMs: number;
    readonly maxAttempts: number;
  };
}
export type ExecutionCompositionTools =
  | { readonly kind: 'text-only' }
  | { readonly kind: 'accepted-input-reader'; readonly definition: AcceptedInputToolDefinition }
  | {
      readonly kind: 'local-tools';
      readonly definitions: readonly LocalFileToolDefinition[];
      readonly shell?: ForegroundShellToolDefinition | undefined;
      readonly acceptedInputReader?: AcceptedInputToolDefinition | undefined;
    };
const localFileToolSchema = toolSchema.omit({ name: true }).extend({
  name: z.enum(['read', 'write', 'edit']),
});
const toolsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({ kind: z.literal('accepted-input-reader'), definition: toolSchema }),
  z.strictObject({
    kind: z.literal('local-tools'),
    definitions: z.array(localFileToolSchema).min(1).max(3),
    shell: toolSchema
      .omit({ name: true })
      .extend({
        name: z.literal('bash'),
        budget: z
          .strictObject({
            defaultTimeoutMs: positive.max(600_000),
            maxTimeoutMs: positive.max(600_000),
            maxAttempts: positive.max(32),
          })
          .refine((budget) => budget.defaultTimeoutMs <= budget.maxTimeoutMs),
      })
      .optional(),
    acceptedInputReader: toolSchema.optional(),
  }),
]);
const inputRefSchema = z.strictObject({
  sourceNodeId: id,
  artifactVersionId: id,
  contextPackId: id.optional(),
});
const handoffSchema = z
  .strictObject({
    nodeId: id,
    taskId: id,
    workflowVersionId: id,
    revision: positive,
    goal: z.string().min(1).max(8400),
    assignee: z.strictObject({ id, kind: z.enum(['human', 'expert']) }),
    expertRef: ref.optional(),
    dependencyNodeIds: z.array(id).max(100),
    reviewRequired: z.boolean(),
    reviewerIds: z.array(id).max(100),
    inputRefs: z.array(inputRefSchema).max(100),
    skillRefs: z.array(ref).max(100),
    mcpRefs: z.array(ref).max(100),
    inputNote: z.string().max(8000),
    expectedOutput: z.string().max(8000),
    childTaskId: id.optional(),
  })
  .refine(
    (value) =>
      value.assignee.kind === 'human' ||
      (value.expertRef?.id === value.assignee.id &&
        value.expertRef.version === value.workflowVersionId),
  );
const inputSchema = z.strictObject({
  access: z.literal('visible'),
  blocking: z.literal(false),
  sourceNodeId: id,
  artifactVersionId: id,
  version: positive,
  name: z.string().max(200),
  sourceGoal: z.string().max(2000).optional(),
});
const sourceSchema = z.strictObject({
  scope: scopeSchema,
  plan: z.strictObject({
    ref: z.strictObject({ taskId: id, planId: id, revision: positive }),
    sourceWorkbenchRevision: z.number().int().nonnegative(),
    projectId: id,
    title: z.string().max(160),
    goal: z.string().max(8000),
  }),
  handoff: handoffSchema,
  executor: executorSchema,
  model: modelSchema,
  tools: toolsSchema,
  inputs: z.array(inputSchema).max(EXECUTION_COMPOSITION_LIMITS.inputs),
});
const extendedFields = {
  resources: executionRunResourcesSchema.optional(),
  acceptedFileReader: acceptedFileToolSchema.optional(),
  resultIntentTool: resultIntentToolSchema.optional(),
  outputFilePublisherTool: outputFilePublisherToolSchema.optional(),
};
const extendedSourceSchema = sourceSchema.extend(extendedFields);
type Source = z.infer<typeof extendedSourceSchema>;
const messageSchema = z.strictObject({
  text: z.string().min(1).max(20_000),
  mode: z.literal('followup'),
  inputFingerprint: sha,
});
const payloadSchema = sourceSchema.extend({
  context: z.string().max(20_000),
  contextRefs: z.array(id).max(100),
  firstMessage: messageSchema,
  toolAllowlist: z.array(z.enum([ACCEPTED_INPUT_TOOL, 'read', 'write', 'edit', 'bash'])).max(5),
});
const legacySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configurationId: id,
  payload: payloadSchema,
});
const extendedPayloadSchema = payloadSchema.extend({
  ...extendedFields,
  toolAllowlist: z.array(z.string().min(1).max(64)).max(40),
});
const snapshotSchema = z.discriminatedUnion('schemaVersion', [
  legacySnapshotSchema,
  z.strictObject({
    schemaVersion: z.literal(2),
    configurationId: id,
    payload: extendedPayloadSchema,
  }),
]);
export type FrozenExecutionRunComposition = z.infer<typeof snapshotSchema>;
export interface ExecutionRunCompositionInput {
  readonly workbench: Workbench;
  readonly node: ExecutionNodeRecord;
  readonly scope: NativeWorkScope;
  readonly model: Omit<NativeSessionSelection, 'configurationId'>;
  readonly executor:
    { readonly kind: 'builtin' } | { readonly kind: 'plan-expert'; readonly ref: VersionedRef };
  /** Echo from the normal, currently authorized B projection; these fields do not grant access. */
  readonly inputs: {
    readonly actorId: string;
    readonly spaceId: string;
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
    readonly nodeId: string;
    readonly items: readonly UpstreamInputView[];
  };
  readonly tools: ExecutionCompositionTools;
  /** Explicit new-Run capability only, from C's ready authorized Host port. Never inferred from files. */
  readonly acceptedFileReader?: AcceptedFileToolDefinition;
  /** C's exact ready tool description, explicitly selected for this new Run. Never backfilled. */
  readonly resultIntentTool?: ResultIntentToolDefinition;
  /** Explicit new-Run metadata from C's getter. This is not filesystem/publication authority. */
  readonly outputFilePublisherTool?: OutputFilePublisherToolDefinition;
  /** Qualified metadata only; absence preserves legacy refusal and exact schema-1 replay. */
  readonly resourceCatalog?: ExecutionRunResourceCatalog;
}
export class ExecutionRunCompositionError extends Error {
  constructor(
    readonly code:
      | 'composition-invalid'
      | 'composition-source-mismatch'
      | 'composition-input-unavailable'
      | 'composition-input-reader-required'
      | 'composition-expert-unavailable'
      | 'composition-resource-unsupported'
      | 'composition-budget'
      | 'composition-mismatch',
  ) {
    super('运行配置无法核实。');
    this.name = 'ExecutionRunCompositionError';
  }
}
function fail(code: ExecutionRunCompositionError['code']): never {
  throw new ExecutionRunCompositionError(code);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail('composition-invalid');
}
function bound(value: unknown, max: number): void {
  try {
    if (Buffer.byteLength(canonicalPayload(value), 'utf8') > max) fail('composition-budget');
  } catch (error) {
    if (error instanceof ExecutionRunCompositionError) throw error;
    fail('composition-invalid');
  }
}
function derive(source: Source) {
  const {
    scope,
    handoff,
    plan,
    executor,
    inputs,
    tools,
    acceptedFileReader,
    resultIntentTool,
    outputFilePublisherTool,
  } = source;
  if (
    plan.ref.taskId !== scope.taskId ||
    plan.ref.planId !== scope.planId ||
    plan.ref.revision !== scope.revision ||
    handoff.nodeId !== scope.nodeId ||
    handoff.taskId !== scope.taskId ||
    handoff.workflowVersionId !== scope.planId ||
    handoff.revision !== scope.revision
  )
    fail('composition-source-mismatch');
  const resources = source.resources;
  if (!resources && (handoff.skillRefs.length || handoff.mcpRefs.length))
    fail('composition-resource-unsupported');
  if (
    resources &&
    ((!resources.skills.length && !resources.mcp.length) ||
      canonicalPayload(resources.skills.map((item) => item.ref)) !==
        canonicalPayload(handoff.skillRefs) ||
      canonicalPayload(resources.mcp.map((item) => item.ref)) !==
        canonicalPayload(handoff.mcpRefs) ||
      [...handoff.skillRefs, ...handoff.mcpRefs].some((item) => item.version !== scope.planId))
  )
    fail('composition-source-mismatch');
  if (executor.digest !== hash(executor.definition)) fail('composition-invalid');
  if (executor.kind === 'builtin') {
    if (
      canonicalPayload(executor.definition) !== canonicalPayload(builtin) ||
      handoff.assignee.kind === 'expert' ||
      handoff.expertRef
    )
      fail('composition-expert-unavailable');
  } else {
    if (
      executor.ref.id !== executor.definition.id ||
      executor.ref.version !== scope.planId ||
      executor.definition.kind !== 'expert' ||
      !executor.definition.available ||
      !executor.definition.instructions.trim() ||
      executor.definition.origin?.missing.length ||
      (handoff.expertRef && canonicalPayload(handoff.expertRef) !== canonicalPayload(executor.ref))
    )
      fail('composition-expert-unavailable');
    if (
      !resources &&
      (executor.definition.resourceBindings?.skillIds.length ||
        executor.definition.resourceBindings?.mcpIds.length)
    )
      fail('composition-resource-unsupported');
    if (
      resources &&
      (executor.definition.resourceBindings?.skillIds.some(
        (id) => !handoff.skillRefs.some((item) => item.id === id),
      ) ||
        executor.definition.resourceBindings?.mcpIds.some(
          (id) => !handoff.mcpRefs.some((item) => item.id === id),
        ))
    )
      fail('composition-source-mismatch');
  }
  const pins = handoff.inputRefs;
  if (acceptedFileReader && !inputs.length) fail('composition-input-unavailable');
  if (
    new Set(pins.map((pin) => pin.sourceNodeId)).size !== pins.length ||
    new Set(inputs.map((input) => input.sourceNodeId)).size !== inputs.length ||
    pins.length !== inputs.length
  )
    fail('composition-input-unavailable');
  for (const dependency of handoff.dependencyNodeIds)
    if (!pins.some((pin) => pin.sourceNodeId === dependency)) fail('composition-input-unavailable');
  for (const pin of pins)
    if (
      !inputs.some(
        (input) =>
          input.sourceNodeId === pin.sourceNodeId &&
          input.artifactVersionId === pin.artifactVersionId,
      )
    )
      fail('composition-input-unavailable');
  if (inputs.length && tools.kind === 'text-only') fail('composition-input-reader-required');
  if (!inputs.length && tools.kind === 'accepted-input-reader') fail('composition-invalid');
  if (tools.kind === 'local-tools') {
    const names = tools.definitions.map((tool) => tool.name);
    if (new Set(names).size !== names.length || !names.includes('read'))
      fail('composition-invalid');
    if (inputs.length && !tools.acceptedInputReader) fail('composition-input-reader-required');
    if (!inputs.length && tools.acceptedInputReader) fail('composition-invalid');
  }
  const catalog = inputs.map((input) => ({
    ...input,
    required: true,
    inputRef: acceptedInputRef(scope, input),
  }));
  const context = `按固定配置处理当前工作；清单是来源引用，不代表已经读取正文。工具和提交权限由平台另行校验。\n${JSON.stringify({ task: plan, node: handoff, executor, inputs: catalog })}`;
  if (
    context.length > EXECUTION_COMPOSITION_LIMITS.contextCharacters ||
    Buffer.byteLength(context, 'utf8') > EXECUTION_COMPOSITION_LIMITS.contextBytes
  )
    fail('composition-budget');
  const text = `执行当前节点：${handoff.goal}\n预期产物：${handoff.expectedOutput}\n节点输入说明：${handoff.inputNote}\n按固定输入清单处理，返回产物草稿与必要说明。`;
  return {
    ...source,
    context,
    contextRefs: catalog.map((input) => input.inputRef),
    firstMessage: {
      text,
      mode: 'followup',
      inputFingerprint: createHash('sha256')
        .update(JSON.stringify(['followup', text]))
        .digest('hex'),
    },
    toolAllowlist: [
      ...(tools.kind === 'text-only'
        ? []
        : tools.kind === 'accepted-input-reader'
          ? [ACCEPTED_INPUT_TOOL]
          : [
              ...tools.definitions.map((tool) => tool.name),
              ...(tools.shell ? (['bash'] as const) : []),
              ...(tools.acceptedInputReader ? ([ACCEPTED_INPUT_TOOL] as const) : []),
            ]),
      ...(acceptedFileReader ? [acceptedFileToolName] : []),
      ...(outputFilePublisherTool ? [outputFilePublisherToolName] : []),
      ...(resultIntentTool ? [resultIntentToolName] : []),
      ...(resources ? executionResourceToolNames(resources) : []),
    ],
  };
}
/** Strict serializable format for the existing Run wrapper, not a separate configuration store. */
export const executionRunCompositionSchema = z.preprocess(
  (value) => {
    try {
      bound(value, EXECUTION_COMPOSITION_LIMITS.snapshotBytes);
      return value;
    } catch {
      return null;
    }
  },
  snapshotSchema.superRefine((value, context) => {
    try {
      bound(value, EXECUTION_COMPOSITION_LIMITS.snapshotBytes);
      if (
        value.schemaVersion === 2 &&
        !value.payload.resources &&
        !value.payload.acceptedFileReader &&
        !value.payload.resultIntentTool &&
        !value.payload.outputFilePublisherTool
      )
        throw Error();
      const schema = value.schemaVersion === 1 ? sourceSchema : extendedSourceSchema;
      const source = schema.parse(
        Object.fromEntries(
          Object.keys(schema.shape).map((key) => [
            key,
            value.payload[key as keyof typeof value.payload],
          ]),
        ),
      );
      const derived = derive(source);
      if (
        canonicalPayload(derived) !== canonicalPayload(value.payload) ||
        value.configurationId !== `composition_${hash(derived)}`
      )
        throw Error();
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid frozen execution composition.' });
    }
  }),
);
export function readExecutionRunComposition(value: unknown): FrozenExecutionRunComposition {
  bound(value, EXECUTION_COMPOSITION_LIMITS.snapshotBytes);
  return freeze(checked(executionRunCompositionSchema, value));
}
/** Host-only current facts. No model, package install, source-body fetch or authority minting. */
export function freezeExecutionRunComposition(
  input: ExecutionRunCompositionInput,
): FrozenExecutionRunComposition {
  try {
    const scope = checked(scopeSchema, input.scope);
    const locator = { taskId: scope.taskId, planId: scope.planId, revision: scope.revision };
    if (
      input.workbench.appliedPlans.filter(
        (plan) =>
          plan.taskId === locator.taskId &&
          plan.id === locator.planId &&
          plan.revision === locator.revision,
      ).length !== 1
    )
      fail('composition-source-mismatch');
    const applied = AppliedPlanSchema.parse(createExecutionHandoff(locator, input.workbench));
    const expected = createNodeHandoffs(applied).find((node) => node.nodeId === scope.nodeId);
    const node = input.node;
    if (
      !expected ||
      node.taskId !== scope.taskId ||
      node.planId !== scope.planId ||
      node.revision !== scope.revision ||
      node.nodeId !== scope.nodeId ||
      !Array.isArray(node.handoff.inputRefs) ||
      canonicalPayload({ ...expected, inputRefs: node.handoff.inputRefs }) !==
        canonicalPayload(node.handoff)
    )
      fail('composition-source-mismatch');
    const echo = input.inputs;
    if (
      !echo ||
      echo.actorId !== scope.actorId ||
      echo.spaceId !== scope.spaceId ||
      echo.taskId !== scope.taskId ||
      echo.planId !== scope.planId ||
      echo.revision !== scope.revision ||
      echo.nodeId !== scope.nodeId ||
      !Array.isArray(echo.items) ||
      echo.items.some((item) => item.access !== 'visible' || item.blocking)
    )
      fail('composition-input-unavailable');
    if (echo.items.length > EXECUTION_COMPOSITION_LIMITS.inputs) fail('composition-budget');
    const choice = checked(executorChoiceSchema, input.executor);
    let executor: Source['executor'];
    if (choice.kind === 'builtin')
      executor = {
        kind: 'builtin',
        definition: { ...builtin },
        digest: BASIC_TASK_EXECUTOR.digest,
      };
    else {
      const reference = choice.ref;
      const expert = applied.participants.find(
        (item) => item.id === reference.id && item.kind === 'expert',
      );
      if (
        !expert ||
        reference.version !== applied.id ||
        !applied.task.participantIds.includes(expert.id)
      )
        fail('composition-expert-unavailable');
      executor = { kind: 'plan-expert', ref: reference, definition: expert, digest: hash(expert) };
    }
    const selectedResources = node.handoff.skillRefs.length || node.handoff.mcpRefs.length;
    if (
      input.resourceCatalog &&
      input.resourceCatalog.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION
    )
      fail('composition-resource-unsupported');
    if (
      !selectedResources &&
      (input.resourceCatalog?.mcp.length || input.resourceCatalog?.skills?.length)
    )
      fail('composition-source-mismatch');
    const resources =
      selectedResources && input.resourceCatalog
        ? freezeExecutionRunResources(
            applied,
            node.handoff,
            executor.kind === 'plan-expert' ? executor.definition : undefined,
            input.resourceCatalog,
          )
        : undefined;
    const extended =
      resources !== undefined ||
      input.acceptedFileReader !== undefined ||
      input.resultIntentTool !== undefined ||
      input.outputFilePublisherTool !== undefined;
    const source = checked(extended ? extendedSourceSchema : sourceSchema, {
      scope,
      plan: {
        ref: locator,
        sourceWorkbenchRevision: applied.sourceWorkbenchRevision,
        projectId: applied.task.projectId,
        title: applied.task.title,
        goal: applied.task.goal,
      },
      handoff: node.handoff,
      executor,
      model: input.model,
      tools: input.tools,
      inputs: [...echo.items].sort((a, b) =>
        ('sourceNodeId' in a ? a.sourceNodeId : '').localeCompare(
          'sourceNodeId' in b ? b.sourceNodeId : '',
        ),
      ),
      ...(resources ? { resources } : {}),
      ...(input.acceptedFileReader !== undefined
        ? { acceptedFileReader: input.acceptedFileReader }
        : {}),
      ...(input.resultIntentTool !== undefined ? { resultIntentTool: input.resultIntentTool } : {}),
      ...(input.outputFilePublisherTool !== undefined
        ? { outputFilePublisherTool: input.outputFilePublisherTool }
        : {}),
    });
    const payload = derive(source);
    return readExecutionRunComposition({
      schemaVersion: extended ? 2 : 1,
      configurationId: `composition_${hash(payload)}`,
      payload,
    });
  } catch (error) {
    if (error instanceof ExecutionRunCompositionError) throw error;
    return fail('composition-invalid');
  }
}
export function executionRunCompositionRequest(snapshot: FrozenExecutionRunComposition) {
  const saved = readExecutionRunComposition(snapshot);
  return freeze({
    selection: { ...saved.payload.model, configurationId: saved.configurationId },
    expertVersionId:
      saved.payload.executor.kind === 'builtin'
        ? `${saved.payload.executor.definition.id}@${saved.payload.executor.definition.version}`
        : saved.payload.executor.ref.version,
    contextRefs: [...saved.payload.contextRefs],
    inputFingerprint: saved.payload.firstMessage.inputFingerprint,
    firstMessage: { ...saved.payload.firstMessage },
  });
}
/** Bind serialized content to the exact admitted Run; this does not grant access. */
export function assertExecutionRunCompositionBinding(
  saved: unknown,
  scope: NativeWorkScope,
  request: {
    selection: NativeSessionSelection;
    expertVersionId: string;
    contextRefs: readonly string[];
    inputFingerprint: string;
  },
): undefined {
  const snapshot = readExecutionRunComposition(saved);
  const projected = executionRunCompositionRequest(snapshot);
  if (
    canonicalPayload(snapshot.payload.scope) !== canonicalPayload(scope) ||
    canonicalPayload(request.selection) !== canonicalPayload(projected.selection) ||
    request.expertVersionId !== projected.expertVersionId ||
    request.inputFingerprint !== projected.inputFingerprint ||
    canonicalPayload(request.contextRefs) !== canonicalPayload(projected.contextRefs)
  )
    fail('composition-mismatch');
  return undefined;
}
/** For A's synchronous assertConfiguration: caller provides fresh authorized source facts. */
export function assertExecutionRunComposition(
  saved: unknown,
  current: ExecutionRunCompositionInput,
  request: {
    selection: NativeSessionSelection;
    expertVersionId: string;
    contextRefs: readonly string[];
    inputFingerprint: string;
  },
): undefined {
  const snapshot = readExecutionRunComposition(saved);
  const expected = freezeExecutionRunComposition(current);
  const projected = executionRunCompositionRequest(snapshot);
  if (
    canonicalPayload(snapshot) !== canonicalPayload(expected) ||
    canonicalPayload(request.selection) !== canonicalPayload(projected.selection) ||
    request.expertVersionId !== projected.expertVersionId ||
    request.inputFingerprint !== projected.inputFingerprint ||
    canonicalPayload(request.contextRefs) !== canonicalPayload(projected.contextRefs)
  )
    fail('composition-mismatch');
  return undefined;
}
