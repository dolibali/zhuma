import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  castBallot,
  settleReview,
  interpretAgentReview,
  type Comment,
  type ExecutionNodeRecord,
  type ReviewAction,
} from '@zhuma/agent-core';
import type { ExecutionReviewAttempt, ExecutionReviewScope } from './execution-review-contract.js';
import { executionReviewScopeSchema } from './execution-review-contract.js';
import {
  executionReviewTarget,
  readExecutionReviewState,
  type ExecutionReviewNode,
} from './execution-review-state.js';
import { recordExecutionReviewEvent } from './execution-review-lifecycle.js';
import { reviewTargetResources } from './execution-review-target-reader.js';
import {
  NATIVE_REVIEW_TOOL_VERSION,
  NativeReviewError,
  nativeReviewRunSourceSchema,
  nativeReviewContentDigest,
  parseNativeReviewArguments,
  type NativeFixedReviewLease,
  type NativeReviewContent,
} from './native-work-session-review-contract.js';
import { nativeResultCutSchema } from './native-work-session-result-contract.js';
import { validateNativeReviewEvidence } from './native-work-session-review-source.js';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const metadataSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: id,
  fingerprint: digest,
  source: z.unknown(),
  digest,
  provenanceFingerprint: digest,
  action: z.enum(['approve', 'request-changes', 'comment']),
  anchors: z.unknown(),
  evidenceRefs: z.unknown(),
  commentId: id,
});
const failureSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: id,
  code: z.enum([
    'review-read-required',
    'review-unsupported-material',
    'review-read-budget-exceeded',
    'output-too-large',
    'review-result-rejected',
  ]),
  resourceRefs: z.array(id).max(64),
  fingerprint: digest,
});
export type ExecutionReviewFailure = z.infer<typeof failureSchema>;
export type ExecutionReviewFixedFacts = Pick<
  NativeFixedReviewLease,
  'source' | 'content' | 'readManifest' | 'readManifestDigest' | 'digest' | 'provenanceFingerprint'
>;
export interface ExecutionReviewFixedReceipt {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly source: NativeFixedReviewLease['source'];
  readonly digest: string;
  readonly provenanceFingerprint: string;
  readonly action: ReviewAction;
  readonly anchors: NativeReviewContent['anchors'];
  readonly evidenceRefs: NativeReviewContent['evidenceRefs'];
  readonly commentId: string;
}
export class ExecutionReviewFixedResultError extends Error {
  constructor(
    readonly code:
      | 'review-result-invalid'
      | 'review-result-state-invalid'
      | 'review-result-stale'
      | 'review-result-conflict'
      | 'review-result-not-running'
      | 'review-read-required'
      | 'review-ballot-rejected'
      | 'review-unsupported-material',
    readonly resourceRefs: readonly string[] = [],
  ) {
    super('独立评审结果未记录。');
    this.name = 'ExecutionReviewFixedResultError';
  }
}
const refuse = (code: ExecutionReviewFixedResultError['code']): never => {
  throw new ExecutionReviewFixedResultError(code);
};
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
export const expertReviewBallotKey = (scope: ExecutionReviewScope, requestId: string) =>
  `expert-review:${hash([scope, requestId])}`;
function sourceFrom(raw: unknown): NativeFixedReviewLease['source'] {
  // Evaluate the existing C schema at call time, avoiding a contract/runtime cycle.
  return nativeReviewRunSourceSchema
    .safeExtend({
      toolVersion: z.literal(NATIVE_REVIEW_TOOL_VERSION),
      intentId: id,
      callId: id,
      cut: nativeResultCutSchema,
      readManifestDigest: digest,
    })
    .parse(raw);
}
function scopeFrom(source: NativeFixedReviewLease['source']): ExecutionReviewScope {
  return executionReviewScopeSchema.parse({
    ...source.context.scope,
    review: source.context.review,
  });
}
function provenance(source: NativeFixedReviewLease['source'], value: string) {
  return hash({ source, digest: value, readManifestDigest: source.readManifestDigest });
}
function fingerprint(value: Omit<ExecutionReviewFixedReceipt, 'fingerprint'>): string {
  return hash(value);
}

/** Bounded attention reason on the same original attempt, never a review vote. */
export function readExecutionReviewFailure(
  record: ExecutionNodeRecord,
  attempt: ExecutionReviewAttempt,
): ExecutionReviewFailure | undefined {
  if (attempt.status === 'prepared' || attempt.failure === undefined) return undefined;
  try {
    const failure = failureSchema.parse(attempt.failure);
    const { fingerprint: stored, ...value } = failure;
    const artifact = record.artifactVersions.find(
      (item) => item.id === attempt.scope.review.target.artifactVersionId,
    );
    const resources = artifact && reviewTargetResources(artifact);
    if (
      attempt.status !== 'failed' ||
      stored !== hash(value) ||
      new Set(value.resourceRefs).size !== value.resourceRefs.length ||
      !resources ||
      value.resourceRefs.some((ref) => !resources.some((item) => item.resourceRef === ref))
    )
      return refuse('review-result-state-invalid');
    return failure;
  } catch {
    return refuse('review-result-state-invalid');
  }
}

/** Original Service calls only after authenticating its current driver and the
 * original C result/failure. This does not infer native drain from a failure. */
export function recordExecutionReviewFailure(
  record: ExecutionNodeRecord,
  scope: ExecutionReviewScope,
  input: Pick<ExecutionReviewFailure, 'requestId' | 'code' | 'resourceRefs'>,
) {
  const state = readExecutionReviewState(record);
  const attempt = state?.attempts.find((item) => item.scope.runId === scope.runId);
  if (!attempt || canonicalPayload(attempt.scope) !== canonicalPayload(scope))
    return refuse('review-result-stale');
  const prior = readExecutionReviewFailure(record, attempt);
  if (prior) {
    if (
      prior.requestId !== input.requestId ||
      prior.code !== input.code ||
      canonicalPayload(prior.resourceRefs) !== canonicalPayload(input.resourceRefs)
    )
      return refuse('review-result-conflict');
    return {
      disposition: 'replayed' as const,
      record: record as ExecutionReviewNode,
      failure: prior,
    };
  }
  if (attempt.status !== 'running' || attempt.stopPhase !== 'none')
    return refuse('review-result-not-running');
  const failed = recordExecutionReviewEvent(record, {
    scope,
    kind: 'failed',
    sequence: attempt.lastEventSequence + 1,
  });
  const value = { protocolVersion: 1 as const, ...input };
  const failure = failureSchema.parse({ ...value, fingerprint: hash(value) });
  const native = failed.record.nativeExecution;
  const next: ExecutionReviewNode = {
    ...failed.record,
    nativeExecution: {
      ...native,
      review: {
        ...native.review,
        attempts: native.review.attempts.map((item) =>
          item.scope.runId === scope.runId ? { ...item, failure } : item,
        ),
      },
    },
  };
  readExecutionReviewState(next);
  return { disposition: 'applied' as const, record: next, failure };
}

/** Historical receipt integrity only. It never recreates a native ref or read proof.
 * Rationale remains in the original ballot/comment, not another result-content store. */
export function readExecutionReviewFixedReceipt(
  record: ExecutionNodeRecord,
  attempt: ExecutionReviewAttempt,
): ExecutionReviewFixedReceipt | undefined {
  if (attempt.status === 'prepared' || attempt.result === undefined) return undefined;
  try {
    const raw = metadataSchema.parse(attempt.result),
      source = sourceFrom(raw.source);
    const target = source.context.review.target,
      reviewerId = source.context.review.principal.reviewerRef.id;
    const round = record.rounds.find((item) => item.id === target.roundId);
    const ballot = round?.ballots.find(
      (item) =>
        item.reviewerId === reviewerId &&
        item.roundId === target.roundId &&
        item.artifactVersionId === target.artifactVersionId &&
        item.action === raw.action,
    );
    const comment = record.comments.find((item) => item.id === raw.commentId);
    if (
      !ballot?.comment ||
      !comment ||
      comment.versionId !== target.artifactVersionId ||
      comment.targetId !== target.artifactVersionId ||
      attempt.status !== 'completed' ||
      canonicalPayload(scopeFrom(source)) !== canonicalPayload(attempt.scope) ||
      source.configurationId !== attempt.configurationId ||
      source.nativeSessionId !== attempt.nativeSessionId ||
      source.nativeAgentId !== attempt.nativeAgentId ||
      raw.provenanceFingerprint !== provenance(source, raw.digest) ||
      !record.receipts.some(
        (item) => item.idempotencyKey === expertReviewBallotKey(attempt.scope, raw.requestId),
      )
    )
      return refuse('review-result-state-invalid');
    const content = parseNativeReviewArguments({
      conclusion: raw.action,
      rationale: ballot.comment,
      anchors: raw.anchors,
      evidenceRefs: raw.evidenceRefs,
    });
    if (nativeReviewContentDigest(content, source.readManifestDigest) !== raw.digest)
      return refuse('review-result-state-invalid');
    const value = {
      protocolVersion: 1 as const,
      requestId: raw.requestId,
      source,
      digest: raw.digest,
      provenanceFingerprint: raw.provenanceFingerprint,
      action: raw.action,
      anchors: content.anchors,
      evidenceRefs: content.evidenceRefs,
      commentId: raw.commentId,
    };
    if (raw.fingerprint !== fingerprint(value)) return refuse('review-result-state-invalid');
    return { ...value, fingerprint: raw.fingerprint };
  } catch {
    return refuse('review-result-state-invalid');
  }
}

/** Public data checks only. The original Service must FIRST authenticate C's
 * same-owner opaque ref/lease and actual read/cut/retirement provenance. */
export function commitExecutionReviewFixedResult(
  record: ExecutionNodeRecord,
  scope: ExecutionReviewScope,
  requestId: string,
  fixed: ExecutionReviewFixedFacts,
): {
  readonly disposition: 'applied' | 'replayed';
  readonly record: ExecutionReviewNode;
  readonly receipt: ExecutionReviewFixedReceipt;
} {
  try {
    id.parse(requestId);
    executionReviewScopeSchema.parse(scope);
    const state = readExecutionReviewState(record);
    const attempt = state?.attempts.find((item) => item.scope.runId === scope.runId);
    if (
      !state ||
      !attempt ||
      attempt.status === 'prepared' ||
      canonicalPayload(attempt.scope) !== canonicalPayload(scope)
    )
      return refuse('review-result-not-running');
    const source = sourceFrom(fixed.source);
    const checked = validateNativeReviewEvidence(
      fixed.content,
      fixed.readManifest,
      {
        context: source.context,
        nativeSessionId: source.nativeSessionId,
        nativeAgentId: source.nativeAgentId,
        configurationId: source.configurationId,
      },
      source.cut.callSeq,
    );
    if (
      canonicalPayload(scopeFrom(source)) !== canonicalPayload(scope) ||
      source.configurationId !== attempt.configurationId ||
      source.nativeSessionId !== attempt.nativeSessionId ||
      source.nativeAgentId !== attempt.nativeAgentId ||
      checked.digest !== fixed.digest ||
      checked.readManifestDigest !== fixed.readManifestDigest ||
      source.readManifestDigest !== fixed.readManifestDigest ||
      fixed.provenanceFingerprint !== provenance(source, fixed.digest)
    )
      return refuse('review-result-invalid');
    const meaningful = interpretAgentReview({
      conclusion: checked.content.conclusion,
      rationale: checked.content.rationale,
      anchors: checked.content.anchors.map((item) => canonicalPayload(item)),
      evidence: checked.content.evidenceRefs,
    });
    if (
      !meaningful.ok ||
      !checked.content.rationale.replace(/[\u200B-\u200D\uFEFF\u2060\u180E\u00AD]/gu, '').trim()
    )
      return refuse('review-result-invalid');
    const prior = readExecutionReviewFixedReceipt(record, attempt);
    if (prior) {
      if (
        prior.requestId !== requestId ||
        prior.digest !== fixed.digest ||
        prior.provenanceFingerprint !== fixed.provenanceFingerprint
      )
        return refuse('review-result-conflict');
      return { disposition: 'replayed', record: record as ExecutionReviewNode, receipt: prior };
    }
    if (
      attempt.status !== 'running' ||
      attempt.stopPhase !== 'none' ||
      attempt.resources !== 'held'
    )
      return refuse('review-result-not-running');
    if (
      canonicalPayload(executionReviewTarget(record, scope.spaceId)) !==
      canonicalPayload(scope.review.target)
    )
      return refuse('review-result-stale');
    const target = scope.review.target;
    const artifact = record.artifactVersions.find((item) => item.id === target.artifactVersionId)!;
    const catalog = reviewTargetResources(artifact);
    for (const read of checked.readManifest.reads) {
      const resource = catalog.find((item) => item.resourceRef === read.source.resourceRef);
      if (
        !resource ||
        resource.kind === 'external-reference' ||
        resource.resourceFingerprint !== read.source.resourceFingerprint ||
        resource.bytes !== read.range.total
      )
        return refuse('review-result-invalid');
    }
    // Approval covers the entire fixed delivery. Partial pages remain useful
    // for comments/located changes, but cannot silently approve unread material.
    const missing: string[] = [];
    if (checked.content.conclusion === 'approve')
      for (const resource of catalog) {
        let covered = 0;
        for (const read of checked.readManifest.reads
          .filter((item) => item.source.resourceRef === resource.resourceRef)
          .sort((a, b) => a.range.offset - b.range.offset)) {
          if (read.range.offset > covered) break;
          covered = Math.max(covered, read.range.offset + read.range.length);
        }
        if (covered < resource.bytes) missing.push(resource.resourceRef);
      }
    if (missing.length) throw new ExecutionReviewFixedResultError('review-read-required', missing);
    const commentId = `review-comment-${hash([scope, source.intentId, requestId])}`;
    const primary = checked.content.anchors[0];
    const resource = primary && catalog.find((item) => item.resourceRef === primary.resourceRef);
    const comment: Comment = {
      id: commentId,
      targetType: 'artifact-version',
      targetId: artifact.id,
      versionId: artifact.id,
      anchor: primary
        ? { kind: resource?.kind === 'text' ? 'text' : 'file', locator: canonicalPayload(primary) }
        : { kind: 'original-version' },
      threadId: `review-thread-${hash([scope, source.intentId])}`,
      status: checked.content.conclusion === 'approve' ? 'resolved' : 'open',
      authorId: scope.review.principal.reviewerRef.id,
      body: checked.content.rationale,
    };
    const complete = recordExecutionReviewEvent(record, {
      scope,
      sequence: attempt.lastEventSequence + 1,
      kind: 'completed',
    });
    const ballot = castBallot({
      record: complete.record,
      actorId: comment.authorId,
      idempotencyKey: expertReviewBallotKey(scope, requestId),
      expectedVersion: complete.record.command.version,
      ballot: {
        reviewerId: comment.authorId,
        roundId: target.roundId,
        artifactVersionId: artifact.id,
        action: checked.content.conclusion,
        comment: checked.content.rationale,
        ...(checked.content.conclusion === 'request-changes'
          ? { unresolvedCommentIds: [commentId] }
          : {}),
      },
      comments: [comment],
    });
    if (!ballot.ok) return refuse('review-ballot-rejected');
    let next = ballot.record;
    const round = next.rounds.find((item) => item.id === target.roundId)!;
    if (round.status !== 'open') {
      const settled = settleReview({
        record: next,
        actorId: comment.authorId,
        idempotencyKey: `settle:${target.roundId}`,
        expectedVersion: next.command.version,
        roundId: target.roundId,
        artifactVersionId: artifact.id,
      });
      if (!settled.ok) return refuse('review-ballot-rejected');
      next = settled.record;
    }
    const values: Omit<ExecutionReviewFixedReceipt, 'fingerprint'> = {
      protocolVersion: 1,
      requestId,
      source,
      digest: fixed.digest,
      provenanceFingerprint: fixed.provenanceFingerprint,
      action: checked.content.conclusion,
      anchors: checked.content.anchors,
      evidenceRefs: checked.content.evidenceRefs,
      commentId,
    };
    const receipt: ExecutionReviewFixedReceipt = { ...values, fingerprint: fingerprint(values) };
    const native = (next as ExecutionReviewNode).nativeExecution;
    const result: ExecutionReviewNode = {
      ...next,
      nativeExecution: {
        ...native,
        review: {
          ...native.review,
          attempts: native.review.attempts.map((item) =>
            item.scope.runId === scope.runId ? { ...item, result: receipt } : item,
          ),
        },
      },
    };
    readExecutionReviewState(result);
    return { disposition: 'applied', record: result, receipt };
  } catch (error) {
    if (error instanceof ExecutionReviewFixedResultError) throw error;
    if (error instanceof NativeReviewError && error.code === 'review-unsupported-material')
      return refuse('review-unsupported-material');
    return refuse('review-result-invalid');
  }
}
