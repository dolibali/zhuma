import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AppliedPlanSchema,
  ParticipantSchema,
  canonicalPayload,
  createNodeHandoffs,
  type AppliedPlan,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import { EXECUTION_COMPOSITION_LIMITS } from './execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceToolNames,
  executionRunResourcesSchema,
  freezeExecutionRunResources,
  type ExecutionRunResourceCatalog,
} from './execution-run-resource-snapshot.js';
import {
  executionReviewScopeSchema,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import { executionReviewTarget } from './execution-review-state.js';
import { readExecutionRunState } from './execution-run-state.js';
import { reviewTargetResources } from './execution-review-target-reader.js';
import type { NativeSessionSelection } from './native-work-session-contract.js';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonObject = z.record(z.string(), z.json());

/** C's original getters at 14ead7c6. Only descriptors, never a native issuer or read proof. */
const descriptorDigests = {
  readTarget: 'e6410258a46ecdf244fdd55c4d41cd3509e843b22bcd0a02ccc4e5cb17ad8626',
  completeReview: '36565a38b1b325a82b40c525478e7a29e47503a8e12ca4d9a5da5838342f058c',
} as const;
export interface ExecutionReviewToolDefinition {
  readonly name: string;
  readonly sourceVersion: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema: unknown;
}
const descriptorSchema = z.strictObject({
  name: id,
  sourceVersion: id,
  description: z.string().min(1).max(4000),
  parameters: jsonObject.refine((value) => value.type === 'object'),
  outputSchema: jsonObject,
});
const toolsSchema = z.strictObject({
  readTarget: descriptorSchema.refine((value) => hash(value) === descriptorDigests.readTarget),
  completeReview: descriptorSchema.refine(
    (value) => hash(value) === descriptorDigests.completeReview,
  ),
});
const sourceSchema = z.strictObject({
  scope: executionReviewScopeSchema,
  plan: z.strictObject({
    projectId: id,
    title: z.string().max(160),
    goal: z.string().max(8000),
  }),
  node: z.strictObject({
    goal: z.string().min(1).max(8400),
    expectedOutput: z.string().max(8000),
    assigneeId: id,
    submittedBy: id,
    producerRunId: id.optional(),
  }),
  reviewer: ParticipantSchema,
  model: z.strictObject({
    provider: id,
    model: id,
    reasoningEffort: id.optional(),
    maxTokens: positive.max(65_536),
  }),
  tools: toolsSchema,
  resources: executionRunResourcesSchema,
  targetResources: z
    .array(
      z.strictObject({
        resourceRef: id,
        kind: z.enum(['text', 'file', 'external-reference']),
        required: z.literal(true),
        mediaType: z.string().min(1).max(200),
        bytes: natural,
        resourceFingerprint: digest,
      }),
    )
    .min(1)
    .max(64),
});
type Source = z.infer<typeof sourceSchema>;
const payloadSchema = sourceSchema.extend({
  context: z.string().min(1).max(EXECUTION_COMPOSITION_LIMITS.contextCharacters),
  firstMessage: z.strictObject({
    text: z.string().min(1).max(EXECUTION_COMPOSITION_LIMITS.contextCharacters),
    mode: z.literal('followup'),
    inputFingerprint: digest,
  }),
  toolAllowlist: z.array(id).min(2).max(35),
});
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal('independent-review'),
  configurationId: id,
  payload: payloadSchema,
});
export type FrozenExecutionReviewComposition = z.infer<typeof snapshotSchema>;

/** Current Host facts, not a member capability. A supplies its real model/resource producers. */
export interface ExecutionReviewPreparation {
  readonly scope: ExecutionReviewScope;
  readonly applied: AppliedPlan;
  readonly node: ExecutionNodeRecord;
}
export interface ExecutionReviewCompositionInput extends ExecutionReviewPreparation {
  readonly model: Omit<NativeSessionSelection, 'configurationId'>;
  readonly tools: {
    readonly readTarget: ExecutionReviewToolDefinition;
    readonly completeReview: ExecutionReviewToolDefinition;
  };
  readonly resourceCatalog?: ExecutionRunResourceCatalog;
}
export class ExecutionReviewCompositionError extends Error {
  constructor(
    readonly code:
      | 'review-composition-invalid'
      | 'review-composition-source-mismatch'
      | 'review-composition-resource-unavailable'
      | 'review-composition-budget'
      | 'review-composition-mismatch',
  ) {
    super('独立评审配置无法核实。');
    this.name = 'ExecutionReviewCompositionError';
  }
}
function fail(code: ExecutionReviewCompositionError['code']): never {
  throw new ExecutionReviewCompositionError(code);
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
function bound(value: unknown): void {
  if (Buffer.byteLength(canonicalPayload(value)) > EXECUTION_COMPOSITION_LIMITS.snapshotBytes)
    fail('review-composition-budget');
}
function derive(source: Source) {
  const { scope, reviewer, node, resources, targetResources } = source;
  const reference = scope.review.principal.reviewerRef;
  const skillRefs = (reviewer.resourceBindings?.skillIds ?? []).map((id) => ({
    id,
    version: scope.planId,
  }));
  const mcpRefs = (reviewer.resourceBindings?.mcpIds ?? []).map((id) => ({
    id,
    version: scope.planId,
  }));
  if (
    reviewer.id !== reference.id ||
    hash(reviewer) !== reference.digest ||
    reviewer.kind !== 'expert' ||
    !reviewer.available ||
    !reviewer.instructions.trim() ||
    reviewer.origin?.missing.length ||
    reviewer.id === node.assigneeId ||
    reviewer.id === node.submittedBy ||
    scope.runId === node.producerRunId ||
    canonicalPayload(resources.skills.map((item) => item.ref)) !== canonicalPayload(skillRefs) ||
    canonicalPayload(resources.mcp.map((item) => item.ref)) !== canonicalPayload(mcpRefs) ||
    new Set(targetResources.map((item) => item.resourceRef)).size !== targetResources.length
  )
    fail('review-composition-source-mismatch');
  const context = `独立评审当前固定产物。按专家职责核对任务目标和实际内容，不继续作者工作、不改写或提交产物。清单只是元信息，必须通过 read_review_target 读取实际字节；部分读取只证明返回范围。缺失、二进制或不支持的必需材料不能判为通过。用 complete_review 声明意见，真正读证据和落票由平台另行校验。\n${JSON.stringify(
    {
      task: source.plan,
      node,
      reviewer,
      target: scope.review.target,
      resources: targetResources,
    },
  )}`;
  if (
    context.length > EXECUTION_COMPOSITION_LIMITS.contextCharacters ||
    Buffer.byteLength(context) > EXECUTION_COMPOSITION_LIMITS.contextBytes
  )
    fail('review-composition-budget');
  const text = `独立评审：${node.goal}\n预期产物：${node.expectedOutput}\n先按固定清单读取内容，再给出有依据的评审意见。不要把会话结束当作评审通过。`;
  return {
    ...source,
    context,
    firstMessage: {
      text,
      mode: 'followup' as const,
      inputFingerprint: createHash('sha256')
        .update(JSON.stringify(['followup', text]))
        .digest('hex'),
    },
    toolAllowlist: [
      'read_review_target',
      'complete_review',
      ...executionResourceToolNames(resources),
    ],
  };
}
/** Serialized prompt/tool/resource binding only. Parsing does not authorize open/send/vote. */
export function readExecutionReviewComposition(value: unknown): FrozenExecutionReviewComposition {
  try {
    bound(value);
    const snapshot = snapshotSchema.parse(value);
    const source = sourceSchema.parse(
      Object.fromEntries(
        Object.keys(sourceSchema.shape).map((key) => [key, snapshot.payload[key as keyof Source]]),
      ),
    );
    const payload = derive(source);
    const canonical = canonicalPayload(payload);
    if (
      canonical !== canonicalPayload(snapshot.payload) ||
      snapshot.configurationId !==
        `review_composition_${createHash('sha256').update(canonical).digest('hex')}`
    )
      fail('review-composition-mismatch');
    return freeze(snapshot);
  } catch (error) {
    if (error instanceof ExecutionReviewCompositionError) throw error;
    return fail('review-composition-invalid');
  }
}
/** Derive reviewer resources from its frozen definition, never from the author's handoff. */
export function freezeExecutionReviewComposition(
  input: ExecutionReviewCompositionInput,
): FrozenExecutionReviewComposition {
  try {
    const scope = executionReviewScopeSchema.parse(input.scope);
    const applied = AppliedPlanSchema.parse(input.applied);
    const node = input.node;
    const expected = createNodeHandoffs(applied).find((item) => item.nodeId === scope.nodeId);
    const reviewer = applied.participants.find(
      (item) => item.id === scope.review.principal.reviewerRef.id,
    );
    const round = node.rounds.find((item) => item.id === scope.review.target.roundId);
    if (
      applied.id !== scope.planId ||
      applied.taskId !== scope.taskId ||
      applied.revision !== scope.revision ||
      applied.task.ownerId !== scope.actorId ||
      node.ownerId !== scope.actorId ||
      !expected ||
      canonicalPayload({ ...expected, inputRefs: node.handoff.inputRefs }) !==
        canonicalPayload(node.handoff) ||
      !applied.participants.some(
        (item) => item.id === scope.actorId && item.kind === 'human' && item.available,
      ) ||
      !reviewer ||
      !applied.task.participantIds.includes(reviewer.id) ||
      !node.handoff.reviewerIds.includes(reviewer.id) ||
      !round?.reviewerIds.includes(reviewer.id) ||
      round.ballots.some((item) => item.reviewerId === reviewer.id && item.action !== 'comment') ||
      canonicalPayload(executionReviewTarget(node, scope.spaceId)) !==
        canonicalPayload(scope.review.target)
    )
      fail('review-composition-source-mismatch');
    const artifact = node.artifactVersions.find(
      (item) => item.id === scope.review.target.artifactVersionId,
    )!;
    const author = readExecutionRunState(node);
    if (
      author?.runs.some((item) => item.resources !== 'settled') ||
      (artifact.producerRunId &&
        !author?.runs.some(
          (item) =>
            item.attempt.id === artifact.producerRunId && item.attempt.status === 'completed',
        ))
    )
      fail('review-composition-source-mismatch');
    const refs = {
      skillRefs: (reviewer.resourceBindings?.skillIds ?? []).map((id) => ({
        id,
        version: applied.id,
      })),
      mcpRefs: (reviewer.resourceBindings?.mcpIds ?? []).map((id) => ({ id, version: applied.id })),
    };
    if ((refs.skillRefs.length || refs.mcpRefs.length) && !input.resourceCatalog)
      fail('review-composition-resource-unavailable');
    let resources;
    try {
      resources = freezeExecutionRunResources(
        applied,
        refs,
        reviewer,
        input.resourceCatalog ?? {
          sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
          mcp: [],
        },
      );
    } catch {
      return fail('review-composition-resource-unavailable');
    }
    const source = sourceSchema.parse({
      scope,
      plan: {
        projectId: applied.task.projectId,
        title: applied.task.title,
        goal: applied.task.goal,
      },
      node: {
        goal: node.handoff.goal,
        expectedOutput: node.handoff.expectedOutput,
        assigneeId: node.handoff.assignee.id,
        submittedBy: artifact.submittedBy,
        ...(artifact.producerRunId ? { producerRunId: artifact.producerRunId } : {}),
      },
      reviewer,
      model: input.model,
      tools: input.tools,
      resources,
      targetResources: reviewTargetResources(artifact),
    });
    const payload = derive(source);
    return readExecutionReviewComposition({
      schemaVersion: 1,
      purpose: 'independent-review',
      configurationId: `review_composition_${hash(payload)}`,
      payload,
    });
  } catch (error) {
    if (error instanceof ExecutionReviewCompositionError) throw error;
    return fail('review-composition-invalid');
  }
}
export function assertExecutionReviewComposition(
  saved: unknown,
  current: ExecutionReviewCompositionInput,
): undefined {
  if (
    canonicalPayload(readExecutionReviewComposition(saved)) !==
    canonicalPayload(freezeExecutionReviewComposition(current))
  )
    fail('review-composition-mismatch');
  return undefined;
}
export function executionReviewCompositionRequest(saved: unknown) {
  const snapshot = readExecutionReviewComposition(saved);
  return freeze({
    scope: snapshot.payload.scope,
    selection: { ...snapshot.payload.model, configurationId: snapshot.configurationId },
    context: snapshot.payload.context,
    firstMessage: snapshot.payload.firstMessage,
    toolAllowlist: snapshot.payload.toolAllowlist,
  });
}
