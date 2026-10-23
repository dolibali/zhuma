import { createNodeHandoffs } from './applied-handoff.js';
import { canonicalPayload, type CommandDecision } from './concurrency.js';
import type { ArtifactVersion } from './delivery.js';
import { readNodeHandoff, type NodeHandoff } from './handoff.js';
import {
  applyNodeTransitionCommand,
  initialNodeCommandState,
  type NodeCommandState,
} from './node-status.js';
import type { CitedComment, ReviewRound } from './review.js';
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
