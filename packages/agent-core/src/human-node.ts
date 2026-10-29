import { createNodeHandoffs } from './applied-handoff.js';
import { canonicalPayload, type CommandDecision, type DomainEvent } from './concurrency.js';
import {
  canSubmitNode,
  createArtifactVersion,
  deriveInbox,
  taskAccess,
  type ArtifactDraft,
  type ArtifactFileRef,
  type ArtifactVersion,
  type InboxItem,
  type InboxNodeFact,
  type InboxRoundFact,
  type TaskGrant,
} from './delivery.js';
import {
  assigneeUsesAgentRuntime,
  readNodeHandoff,
  type ContextInputRef,
  type NodeExecutionReport,
  type NodeHandoff,
} from './handoff.js';
import {
  applyNodeTransitionCommand,
  initialNodeCommandState,
  type NodeCommandState,
} from './node-status.js';
import {
  aggregateReview,
  applyReviewSettlementCommand,
  openReviewRound,
  replaceReviewRound,
  submitBallot,
  type CitedComment,
  type ReviewBallot,
  type ReviewRound,
} from './review.js';
import { WorkbenchError, type AppliedPlan, type AppliedPlanRef } from './workbench.js';

/**
 * One persisted node. `ownerId` is the business owner copied from the applied
 * plan. It is never the actor who happened to send a command.
 */
export interface ExecutionNodeRecord {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly ownerId: string | null;
  readonly handoff: NodeHandoff;
  readonly command: NodeCommandState;
  readonly rounds: readonly ReviewRound[];
  readonly currentRoundId?: string;
  readonly artifactVersions: readonly ArtifactVersion[];
  readonly acceptedArtifactVersionId?: string;
  readonly comments: readonly CitedComment[];
  readonly receipts: readonly ExecutionReceipt[];
  /**
   * Facts for this node, in sequence order. They share this record so a command
   * and its event are one write.
   */
  readonly events?: readonly DomainEvent<{ readonly status: string; readonly version: number }>[];
  /**
   * Human assignee's unsent delivery. A stored submit clears the body and
   * advances `version` by one, counting a missing draft as 0, so the next
   * round cannot reuse the old expectedVersion.
   */
  readonly deliveryDraft?: {
    readonly version: number;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly text: string;
    readonly links: readonly string[];
    readonly files: readonly ArtifactFileRef[];
  };
}

/** Business idempotency. Node command receipts do not cover delivery text. */
export interface ExecutionReceipt {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly version: number;
  readonly disposition: 'applied' | 'ignored';
}

export type NodeCommandResult =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed' | 'ignored';
      readonly record: ExecutionNodeRecord;
    }
  | {
      readonly ok: false;
      readonly disposition: 'rejected' | 'conflict' | 'idempotency-mismatch';
      readonly code: string;
      readonly record: ExecutionNodeRecord;
    };

export type PlanStartResult =
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly records: readonly ExecutionNodeRecord[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly records: readonly ExecutionNodeRecord[];
    };

export function nodeRecordKey(record: {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
}): string {
  return `${record.taskId}:${record.planId}:${record.revision}:${record.nodeId}`;
}

/** Stable across retries. `sourceId` is the settled round, or `artifact:<id>`. */
export function unlockKey(sourceId: string, downstreamNodeId: string): string {
  return `unlock:${sourceId}:${downstreamNodeId}`;
}

export function completionSource(record: ExecutionNodeRecord): string | undefined {
  if (record.command.status !== 'completed') return undefined;
  if (record.currentRoundId !== undefined) return record.currentRoundId;
  if (record.acceptedArtifactVersionId !== undefined) {
    return `artifact:${record.acceptedArtifactVersionId}`;
  }
  return undefined;
}

export function downstreamRecords(
  records: readonly ExecutionNodeRecord[],
  nodeId: string,
): readonly ExecutionNodeRecord[] {
  return records.filter((record) => record.handoff.dependencyNodeIds.includes(nodeId));
}

function planFail(records: readonly ExecutionNodeRecord[], code: string): PlanStartResult {
  return { ok: false, code, records };
}

function reject(
  record: ExecutionNodeRecord,
  code: string,
): Extract<NodeCommandResult, { ok: false }> {
  return { ok: false, disposition: 'rejected', code, record };
}

function failDecision(
  record: ExecutionNodeRecord,
  decision: CommandDecision<unknown>,
): Extract<NodeCommandResult, { ok: false }> | undefined {
  if (decision.status === 'conflict') {
    return { ok: false, disposition: 'conflict', code: 'conflict', record };
  }
  if (decision.status === 'idempotency-mismatch') {
    return {
      ok: false,
      disposition: 'idempotency-mismatch',
      code: 'idempotency-mismatch',
      record,
    };
  }
  if (decision.status === 'rejected') return reject(record, decision.code);
  return undefined;
}

function replayReceipt(
  record: ExecutionNodeRecord,
  idempotencyKey: string,
  fingerprint: string,
): NodeCommandResult | undefined {
  const existing = record.receipts.find((item) => item.idempotencyKey === idempotencyKey);
  if (!existing) return undefined;
  if (existing.fingerprint !== fingerprint) {
    return {
      ok: false,
      disposition: 'idempotency-mismatch',
      code: 'idempotency-mismatch',
      record,
    };
  }
  return { ok: true, disposition: 'replayed', record };
}

function withReceipt(record: ExecutionNodeRecord, receipt: ExecutionReceipt): ExecutionNodeRecord {
  return { ...record, receipts: [...record.receipts, receipt] };
}

function blankRecord(
  requested: AppliedPlanRef,
  handoff: NodeHandoff,
  ownerId: string | null,
): ExecutionNodeRecord {
  return {
    taskId: requested.taskId,
    planId: requested.planId,
    revision: requested.revision,
    nodeId: handoff.nodeId,
    ownerId,
    handoff,
    command: initialNodeCommandState(),
    rounds: [],
    artifactVersions: [],
    comments: [],
    receipts: [],
  };
}

/**
 * Start the exact applied revision. A different revision is `plan-not-found`
 * and is not replaced with a newer snapshot. Entry status is stored on each node.
 */
export function startAppliedPlan(input: {
  readonly requested: AppliedPlanRef;
  readonly applied: AppliedPlan;
  readonly actorId: string;
  readonly existing: readonly ExecutionNodeRecord[];
}): PlanStartResult {
  const { requested, applied, actorId, existing } = input;
  if (
    requested.taskId.trim() === '' ||
    requested.planId.trim() === '' ||
    !Number.isSafeInteger(requested.revision) ||
    requested.revision < 1
  ) {
    return planFail(existing, 'plan-reference-required');
  }
  if (
    applied.taskId !== requested.taskId ||
    applied.id !== requested.planId ||
    applied.revision !== requested.revision ||
    applied.task.id !== requested.taskId ||
    applied.task.status !== 'ready'
  ) {
    return planFail(existing, 'plan-not-found');
  }
  let handoffs: NodeHandoff[];
  try {
    handoffs = createNodeHandoffs(applied);
  } catch (error) {
    if (error instanceof WorkbenchError) return planFail(existing, error.code);
    throw error;
  }
  const relevant = existing.filter(
    (record) =>
      record.taskId === requested.taskId &&
      record.planId === requested.planId &&
      record.revision === requested.revision,
  );
  const known = new Map(relevant.map((record) => [record.nodeId, record]));
  const started: ExecutionNodeRecord[] = [];
  let appliedAny = false;
  for (const handoff of handoffs) {
    const read = readNodeHandoff(handoff);
    if (!read.ok) return planFail(existing, read.code);
    const prior = known.get(read.handoff.nodeId);
    const base = prior ?? blankRecord(requested, read.handoff, applied.task.ownerId);
    // Always blocked when this node has dependencies. plan-started does not
    // write inputRefs, and the flag must stay stable when a retry sees an
    // upstream node that completed after the first attempt.
    const dependenciesSatisfied = read.handoff.dependencyNodeIds.length === 0;
    const outcome = applyNodeTransitionCommand(base.command, {
      idempotencyKey: `start:${nodeRecordKey(base)}`,
      actorId,
      objectId: read.handoff.nodeId,
      expectedVersion: base.command.version,
      payload: { type: 'plan-started', dependenciesSatisfied },
    });
    const failure = failDecision(prior ?? base, outcome.decision);
    if (failure) return planFail(existing, failure.code);
    if (outcome.decision.status === 'replayed' || outcome.decision.status === 'ignored') {
      started.push(base);
      continue;
    }
    if (outcome.decision.status !== 'applied') return planFail(existing, 'illegal-transition');
    appliedAny = true;
    started.push({ ...base, command: outcome.state });
  }
  return { ok: true, disposition: appliedAny ? 'applied' : 'replayed', records: started };
}

function assigneeGrants(record: ExecutionNodeRecord): readonly TaskGrant[] {
  if (record.handoff.assignee.kind !== 'human') return [];
  return [{ actorId: record.handoff.assignee.id, taskId: record.taskId, access: 'write' }];
}

/**
 * Submit text or file metadata. Incomplete uploads and empty deliveries do not
 * take a version or write a receipt. Only the human assignee may submit.
 * Authorization runs before any replay, and the receipt fingerprint includes
 * the actor, so another caller resending the same key is refused.
 */
export function submitDelivery(input: {
  readonly record: ExecutionNodeRecord;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly draft: ArtifactDraft;
  readonly artifactId: string;
  readonly roundId: string;
}): NodeCommandResult {
  const allowed = canSubmitNode({
    actorId: input.actorId,
    assigneeId: input.record.handoff.assignee.id,
    taskAccess: taskAccess(input.actorId, input.record.taskId, assigneeGrants(input.record)),
  });
  if (!allowed) return reject(input.record, 'not-assignee');
  const fingerprint = canonicalPayload({
    kind: 'submit',
    actorId: input.actorId,
    nodeId: input.record.nodeId,
    text: input.draft.text ?? null,
    files: input.draft.files,
    links: input.draft.links,
  });
  return commitDelivery(input, input.actorId, fingerprint);
}

/**
 * Pure expert-node commit only. A trusted adapter must separately validate the
 * actual persisted result, current Run/generation/segment and submission right.
 * The adapter supplies a digest of that full provenance; it is NOT a grant or a native
 * completion signal. Human-assisted work continues through submitDelivery.
 */
export function submitExpertDelivery(input: {
  readonly record: ExecutionNodeRecord;
  readonly expertId: string;
  readonly producerRunId: string;
  readonly provenanceFingerprint: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly draft: ArtifactDraft & { readonly files: readonly [] };
  readonly artifactId: string;
  readonly roundId: string;
}): NodeCommandResult {
  if (
    input.record.handoff.assignee.kind !== 'expert' ||
    input.record.handoff.assignee.id !== input.expertId
  )
    return reject(input.record, 'not-assignee');
  if (
    typeof input.producerRunId !== 'string' ||
    !input.producerRunId.trim() ||
    input.producerRunId.length > 200 ||
    typeof input.provenanceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.provenanceFingerprint)
  )
    return reject(input.record, 'invalid-provenance');
  // This first domain slice accepts text and safe links, never file claims.
  if (!Array.isArray(input.draft.files) || input.draft.files.length)
    return reject(input.record, 'files-not-accepted');
  const fingerprint = canonicalPayload({
    kind: 'expert-submit',
    expertId: input.expertId,
    nodeId: input.record.nodeId,
    producerRunId: input.producerRunId,
    provenanceFingerprint: input.provenanceFingerprint,
    text: input.draft.text ?? null,
    files: input.draft.files,
    links: input.draft.links,
  });
  return commitDelivery(input, input.expertId, fingerprint, input.producerRunId);
}

/**
 * Commit an expert result with an adapter-verified fixed file manifest. This
 * pure function does not authenticate file receipts, bytes or native completion;
 * the trusted adapter must do so before calling it and bind the complete
 * manifest and Run provenance in provenanceFingerprint. The text-only entry
 * above retains its original rejection of all file claims.
 */
export function submitExpertManifestDelivery(input: {
  readonly record: ExecutionNodeRecord;
  readonly expertId: string;
  readonly producerRunId: string;
  readonly provenanceFingerprint: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly draft: ArtifactDraft;
  readonly artifactId: string;
  readonly roundId: string;
}): NodeCommandResult {
  if (
    input.record.handoff.assignee.kind !== 'expert' ||
    input.record.handoff.assignee.id !== input.expertId
  )
    return reject(input.record, 'not-assignee');
  if (
    typeof input.producerRunId !== 'string' ||
    !input.producerRunId.trim() ||
    input.producerRunId.length > 200 ||
    typeof input.provenanceFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.provenanceFingerprint)
  )
    return reject(input.record, 'invalid-provenance');
  if (!Array.isArray(input.draft.files)) return reject(input.record, 'invalid-file');
  const fingerprint = canonicalPayload({
    kind: 'expert-manifest-submit',
    expertId: input.expertId,
    nodeId: input.record.nodeId,
    producerRunId: input.producerRunId,
    provenanceFingerprint: input.provenanceFingerprint,
    text: input.draft.text ?? null,
    files: input.draft.files,
    links: input.draft.links,
  });
  return commitDelivery(input, input.expertId, fingerprint, input.producerRunId);
}

/** Shared artifact / round / receipt landing; caller-specific gates stay above. */
function commitDelivery(
  input: {
    readonly record: ExecutionNodeRecord;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
    readonly draft: ArtifactDraft;
    readonly artifactId: string;
    readonly roundId: string;
  },
  submittedBy: string,
  fingerprint: string,
  producerRunId?: string,
): NodeCommandResult {
  const replay = replayReceipt(input.record, input.idempotencyKey, fingerprint);
  if (replay) return replay;
  if (
    producerRunId !== undefined &&
    input.record.command.status !== 'ready' &&
    input.record.command.status !== 'needs-revision'
  )
    return reject(input.record, 'node-not-ready-for-delivery');
  const content = createArtifactVersion({
    id: input.artifactId,
    nodeId: input.record.nodeId,
    submittedBy,
    draft: input.draft,
    previous: input.record.artifactVersions,
    ...(producerRunId === undefined ? {} : { producerRunId }),
  });
  if (!content.ok) return reject(input.record, content.code);
  if (
    input.record.handoff.reviewRequired &&
    input.record.rounds.some((round) => round.id === input.roundId)
  ) {
    return reject(input.record, 'invalid-round');
  }
  if (input.record.handoff.reviewRequired) {
    const preview = openReviewRound({
      id: input.roundId,
      artifactVersionId: content.version.id,
      reviewerIds: input.record.handoff.reviewerIds,
    });
    if (!preview.ok) return reject(input.record, preview.code);
  }
  if (input.expectedVersion !== input.record.command.version) {
    return { ok: false, disposition: 'conflict', code: 'conflict', record: input.record };
  }
  const outcome = applyNodeTransitionCommand(input.record.command, {
    idempotencyKey: input.idempotencyKey,
    actorId: submittedBy,
    objectId: input.record.nodeId,
    expectedVersion: input.expectedVersion,
    payload: { type: 'submit-artifact', reviewRequired: input.record.handoff.reviewRequired },
  });
  const failure = failDecision(input.record, outcome.decision);
  if (failure) return failure;
  if (outcome.decision.status !== 'applied') {
    return { ok: true, disposition: 'ignored', record: input.record };
  }
  let next: ExecutionNodeRecord = {
    ...input.record,
    command: outcome.state,
    artifactVersions: [...input.record.artifactVersions, content.version],
    ...(outcome.state.status === 'completed'
      ? { acceptedArtifactVersionId: content.version.id }
      : {}),
  };
  if (input.record.handoff.reviewRequired) {
    const current = input.record.currentRoundId
      ? input.record.rounds.find((round) => round.id === input.record.currentRoundId)
      : undefined;
    const replaced = replaceReviewRound(current?.status === 'open' ? current : undefined, {
      id: input.roundId,
      artifactVersionId: content.version.id,
      reviewerIds: input.record.handoff.reviewerIds,
    });
    if (!replaced.ok) return reject(input.record, replaced.code);
    const rounds = input.record.rounds.map((round) =>
      replaced.superseded !== undefined && round.id === replaced.superseded.id
        ? replaced.superseded
        : round,
    );
    next = { ...next, rounds: [...rounds, replaced.round], currentRoundId: replaced.round.id };
  }
  return {
    ok: true,
    disposition: 'applied',
    record: withReceipt(next, {
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      version: next.command.version,
      disposition: 'applied',
    }),
  };
}

function mergeComments(
  existing: readonly CitedComment[],
  incoming: readonly CitedComment[],
): readonly CitedComment[] {
  const seen = new Set(existing.map((comment) => comment.id));
  return [...existing, ...incoming.filter((comment) => !seen.has(comment.id))];
}

/**
 * Record one trusted actor's ballot. The actor is not read from the ballot alone.
 * Reviewer membership is checked before replay, and the fingerprint includes the actor.
 */
export function castBallot(input: {
  readonly record: ExecutionNodeRecord;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly ballot: ReviewBallot;
  readonly comments?: readonly CitedComment[];
}): NodeCommandResult {
  if (!input.record.handoff.reviewerIds.includes(input.actorId)) {
    return reject(input.record, 'not-assigned-reviewer');
  }
  if (input.ballot.reviewerId !== input.actorId) {
    return reject(input.record, 'actor-mismatch');
  }
  const comments = input.comments ?? [];
  const fingerprint = canonicalPayload({
    kind: 'ballot',
    actorId: input.actorId,
    reviewerId: input.ballot.reviewerId,
    roundId: input.ballot.roundId,
    artifactVersionId: input.ballot.artifactVersionId,
    action: input.ballot.action,
    comment: input.ballot.comment ?? null,
    unresolvedCommentIds: input.ballot.unresolvedCommentIds ?? [],
    availability: input.ballot.availability ?? null,
    comments,
  });
  const replay = replayReceipt(input.record, input.idempotencyKey, fingerprint);
  if (replay) return replay;
  if (input.expectedVersion !== input.record.command.version) {
    return { ok: false, disposition: 'conflict', code: 'conflict', record: input.record };
  }
  const round = input.record.rounds.find((item) => item.id === input.ballot.roundId);
  if (!round) return reject(input.record, 'stale-round');
  if (round.status === 'voided') return reject(input.record, 'voided-round');
  if (round.id !== input.record.currentRoundId) return reject(input.record, 'stale-round');
  const decision = submitBallot(round, input.ballot, input.actorId, comments);
  if (!decision.ok) return reject(input.record, decision.code);
  const receipt: ExecutionReceipt = {
    idempotencyKey: input.idempotencyKey,
    fingerprint,
    version: input.record.command.version,
    disposition: decision.recorded ? 'applied' : 'ignored',
  };
  if (!decision.recorded) {
    return { ok: true, disposition: 'ignored', record: withReceipt(input.record, receipt) };
  }
  return {
    ok: true,
    disposition: 'applied',
    record: withReceipt(
      {
        ...input.record,
        rounds: input.record.rounds.map((item) =>
          item.id === decision.round.id ? decision.round : item,
        ),
        comments: mergeComments(input.record.comments, comments),
      },
      receipt,
    ),
  };
}

/**
 * Settle the current round from its ballots. One approval leaves the node
 * in review. Approval by every reviewer completes it. A send-back does not
 * unlock downstream.
 */
export function settleReview(input: {
  readonly record: ExecutionNodeRecord;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly roundId: string;
  readonly artifactVersionId: string;
}): NodeCommandResult {
  const round = input.record.rounds.find((item) => item.id === input.roundId);
  const current = input.record.currentRoundId
    ? input.record.rounds.find((item) => item.id === input.record.currentRoundId)
    : undefined;
  if (!round || !current) return reject(input.record, 'stale-round');
  const outcome = applyReviewSettlementCommand(
    input.record.command,
    {
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      objectId: input.record.nodeId,
      expectedVersion: input.expectedVersion,
      payload: { roundId: input.roundId, artifactVersionId: input.artifactVersionId },
    },
    round,
    { roundId: current.id, artifactVersionId: current.artifactVersionId },
  );
  const failure = failDecision(input.record, outcome.decision);
  if (failure) return failure;
  if (outcome.decision.status === 'replayed') {
    return { ok: true, disposition: 'replayed', record: input.record };
  }
  if (outcome.decision.status !== 'applied') {
    return { ok: true, disposition: 'ignored', record: input.record };
  }
  return {
    ok: true,
    disposition: 'applied',
    record: {
      ...input.record,
      command: outcome.state,
      ...(outcome.state.status === 'completed'
        ? { acceptedArtifactVersionId: input.artifactVersionId }
        : {}),
    },
  };
}

function dependencyRefs(
  record: ExecutionNodeRecord,
  dependencies: readonly ExecutionNodeRecord[],
): { readonly satisfied: boolean; readonly refs: readonly ContextInputRef[] } {
  const byId = new Map(dependencies.map((item) => [item.nodeId, item]));
  const refs: ContextInputRef[] = [];
  for (const dependencyId of record.handoff.dependencyNodeIds) {
    const dependency = byId.get(dependencyId);
    if (
      dependency?.command.status !== 'completed' ||
      dependency.acceptedArtifactVersionId === undefined
    ) {
      return { satisfied: false, refs: [] };
    }
    refs.push({
      sourceNodeId: dependencyId,
      artifactVersionId: dependency.acceptedArtifactVersionId,
    });
  }
  return { satisfied: true, refs };
}

/**
 * Move one downstream node when every dependency is accepted.
 * The caller supplies `unlock:{source}:{downstream}` so a retry replays.
 * Accepted upstream refs are written even when the status transition itself
 * has nothing left to change.
 */
export function unlockDownstream(input: {
  readonly record: ExecutionNodeRecord;
  readonly dependencies: readonly ExecutionNodeRecord[];
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}): NodeCommandResult {
  const dependencies = dependencyRefs(input.record, input.dependencies);
  let handoff = input.record.handoff;
  if (dependencies.satisfied) {
    const read = readNodeHandoff({ ...input.record.handoff, inputRefs: dependencies.refs });
    if (!read.ok) return reject(input.record, read.code);
    handoff = read.handoff;
  }
  const outcome = applyNodeTransitionCommand(input.record.command, {
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    objectId: input.record.nodeId,
    expectedVersion: input.expectedVersion,
    payload: { type: 'dependencies-changed', dependenciesSatisfied: dependencies.satisfied },
  });
  const failure = failDecision(input.record, outcome.decision);
  if (failure) return failure;
  const refsFilled =
    dependencies.satisfied &&
    canonicalPayload(input.record.handoff.inputRefs) !== canonicalPayload(handoff.inputRefs);
  // A late repair from another already accepted predecessor is not a new
  // upstream change. Keep validation/replay checks above, and retain any flag
  // already recorded for a genuine change; do not persist this synthetic mark.
  if (
    dependencies.satisfied &&
    !refsFilled &&
    outcome.decision.status === 'applied' &&
    outcome.decision.result.effects.length === 1 &&
    outcome.decision.result.effects[0] === 'mark-upstream-affected'
  )
    return { ok: true, disposition: 'ignored', record: input.record };
  if (outcome.decision.status === 'applied') {
    return {
      ok: true,
      disposition: 'applied',
      record: { ...input.record, command: outcome.state, handoff },
    };
  }
  if (refsFilled) {
    return { ok: true, disposition: 'applied', record: { ...input.record, handoff } };
  }
  if (outcome.decision.status === 'replayed') {
    return { ok: true, disposition: 'replayed', record: input.record };
  }
  return { ok: true, disposition: 'ignored', record: input.record };
}

export function toNodeExecutionReport(record: ExecutionNodeRecord): NodeExecutionReport {
  const round = record.currentRoundId
    ? record.rounds.find((item) => item.id === record.currentRoundId)
    : undefined;
  let reviewOutcome: NodeExecutionReport['reviewOutcome'];
  if (round && round.status !== 'voided') {
    const evaluation = aggregateReview(round);
    if (
      evaluation.outcome === 'pending' ||
      evaluation.outcome === 'approved' ||
      evaluation.outcome === 'changes-requested'
    ) {
      reviewOutcome = evaluation.outcome;
    }
  }
  return {
    nodeId: record.nodeId,
    taskId: record.taskId,
    workflowVersionId: record.handoff.workflowVersionId,
    revision: record.revision,
    status: record.command.status,
    upstreamAffected: record.command.upstreamAffected,
    ...(record.command.status === 'blocked' ? { blockReason: '等待前置节点完成' } : {}),
    ...(record.acceptedArtifactVersionId !== undefined
      ? { acceptedArtifactVersionId: record.acceptedArtifactVersionId }
      : {}),
    ...(reviewOutcome !== undefined ? { reviewOutcome } : {}),
  };
}

function terminalReviewerIds(round: ReviewRound): readonly string[] {
  return round.reviewerIds.filter((reviewerId) =>
    round.ballots.some(
      (ballot) =>
        ballot.reviewerId === reviewerId &&
        ballot.roundId === round.id &&
        ballot.artifactVersionId === round.artifactVersionId &&
        (ballot.action === 'approve' || ballot.action === 'request-changes'),
    ),
  );
}

/** Inbox rows for one actor. The business owner is not treated as the assignee. */
export function executionInbox(input: {
  readonly actorId: string;
  readonly records: readonly ExecutionNodeRecord[];
}): readonly InboxItem[] {
  const nodes: InboxNodeFact[] = input.records.map((record) => ({
    nodeId: record.nodeId,
    taskId: record.taskId,
    status: record.command.status,
    assignee: record.handoff.assignee,
    access:
      (record.handoff.assignee.kind === 'human' && record.handoff.assignee.id === input.actorId) ||
      (assigneeUsesAgentRuntime(record.handoff.assignee.kind) && record.ownerId === input.actorId)
        ? 'write'
        : 'read',
    awaitingParentConfirmation: false,
    ...(record.currentRoundId !== undefined ? { currentRoundId: record.currentRoundId } : {}),
    ...(record.ownerId !== null ? { ownerId: record.ownerId } : {}),
  }));
  const rounds: InboxRoundFact[] = input.records.flatMap((record) =>
    record.rounds.map((round) => ({
      roundId: round.id,
      nodeId: record.nodeId,
      taskId: record.taskId,
      status: round.status,
      reviewerIds: round.reviewerIds,
      terminalReviewerIds: terminalReviewerIds(round),
      ...(record.currentRoundId === round.id ? { current: true } : {}),
    })),
  );
  return deriveInbox({
    actorId: input.actorId,
    nodes,
    rounds,
    confirmations: [],
  });
}
