import type { ExecutionEngine } from './types.js';
import type { ActorRef } from './handoff.js';
import type { NodeStatus } from './node-status.js';
import { canonicalPayload } from './concurrency.js';

export const RUN_STATUSES = [
  'requested',
  'running',
  'waiting-for-input',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunSignal = 'succeeded' | 'failed' | 'cancel-confirmed' | 'output-arrived';

export type RunTransition =
  | { readonly type: 'executor-acknowledged' }
  | { readonly type: 'input-required' }
  | { readonly type: 'input-supplied' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed' }
  | { readonly type: 'cancel-confirmed' };

export type RunTransitionResult =
  | { readonly ok: true; readonly from: RunStatus; readonly to: RunStatus }
  | {
      readonly ok: false;
      readonly code: 'illegal-run-transition';
      readonly from: RunStatus;
      readonly transition: RunTransition['type'];
    };

const TERMINAL_RUN: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

/** Run lifecycle. A terminal run cannot move again. Requested can fail if the executor never starts, and it cannot succeed before the ack. */
export function transitionRun(from: RunStatus, transition: RunTransition): RunTransitionResult {
  const accept = (to: RunStatus): RunTransitionResult => ({ ok: true, from, to });
  const reject = (): RunTransitionResult => ({
    ok: false,
    code: 'illegal-run-transition',
    from,
    transition: transition.type,
  });
  switch (transition.type) {
    case 'executor-acknowledged':
      return from === 'requested' ? accept('running') : reject();
    case 'input-required':
      return from === 'running' ? accept('waiting-for-input') : reject();
    case 'input-supplied':
      return from === 'waiting-for-input' ? accept('running') : reject();
    case 'succeeded':
      return from === 'running' ? accept('completed') : reject();
    case 'failed':
      return from === 'requested' || from === 'running' || from === 'waiting-for-input'
        ? accept('failed')
        : reject();
    case 'cancel-confirmed':
      return from === 'requested' || from === 'running' || from === 'waiting-for-input'
        ? accept('cancelled')
        : reject();
    default: {
      const unexpected: never = transition;
      throw new Error(`Unknown run transition: ${JSON.stringify(unexpected)}`);
    }
  }
}

/** One execution attempt. Completion of the run is not node delivery. */
export interface RunRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly workflowVersionId: string;
  readonly planRevision: number;
  readonly attempt: number;
  readonly generation: number;
  readonly executor: ExecutionEngine;
  readonly status: RunStatus;
  readonly contextRefs: readonly string[];
  readonly lastEventSequence: number;
  readonly model?: string;
  readonly sessionId?: string;
  readonly configSnapshotId?: string;
}

const ACTIVE_RUN: readonly RunStatus[] = ['requested', 'running', 'waiting-for-input'];

export function requestNodeRun(input: {
  readonly nodeId: string;
  readonly nodeStatus: NodeStatus;
  readonly runs: readonly Pick<RunRecord, 'id' | 'nodeId' | 'status'>[];
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'node-not-executable' }
  | { readonly ok: false; readonly code: 'active-run-exists'; readonly runId: string } {
  if (input.nodeStatus !== 'ready' && input.nodeStatus !== 'needs-revision') {
    return { ok: false, code: 'node-not-executable' };
  }
  const active = input.runs.find(
    (run) => run.nodeId === input.nodeId && ACTIVE_RUN.includes(run.status),
  );
  if (active) return { ok: false, code: 'active-run-exists', runId: active.id };
  return { ok: true };
}

export interface RunObservation {
  readonly mayUpdateRunRecord: boolean;
  readonly mayChangeNodeStatus: boolean;
  readonly mayTriggerDownstream: boolean;
  readonly attachOnly: boolean;
  readonly reason?: 'stale-generation' | 'terminal-run';
  readonly suggestedTransition?: 'execution-failed' | 'cancel-confirmed';
}

function observe(
  fields: Omit<RunObservation, 'reason' | 'suggestedTransition'>,
  extra: Pick<RunObservation, 'reason' | 'suggestedTransition'> = {},
): RunObservation {
  return { ...fields, ...extra };
}

/**
 * Classify a run signal. Stale generations and any terminal run are attachments only.
 * They must not advance the node or release downstream work.
 * A successful process exit updates an active run record only.
 */
export function observeRunSignal(input: {
  readonly runStatus: RunStatus;
  readonly runGeneration: number;
  readonly currentGeneration: number;
  readonly signal: RunSignal;
}): RunObservation {
  const held = {
    mayUpdateRunRecord: false,
    mayChangeNodeStatus: false,
    mayTriggerDownstream: false,
    attachOnly: true,
  } as const;
  if (
    !Number.isSafeInteger(input.runGeneration) ||
    !Number.isSafeInteger(input.currentGeneration) ||
    input.runGeneration !== input.currentGeneration
  ) {
    return observe(held, { reason: 'stale-generation' });
  }
  if (TERMINAL_RUN.includes(input.runStatus)) return observe(held, { reason: 'terminal-run' });
  if (input.runStatus === 'requested') {
    if (input.signal === 'failed') {
      return {
        mayUpdateRunRecord: true,
        mayChangeNodeStatus: false,
        mayTriggerDownstream: false,
        attachOnly: false,
      };
    }
    if (input.signal === 'cancel-confirmed') {
      return observe(
        {
          mayUpdateRunRecord: true,
          mayChangeNodeStatus: true,
          mayTriggerDownstream: false,
          attachOnly: false,
        },
        { suggestedTransition: 'cancel-confirmed' },
      );
    }
    return observe(held);
  }
  if (input.signal === 'failed') {
    return observe(
      {
        mayUpdateRunRecord: true,
        mayChangeNodeStatus: true,
        mayTriggerDownstream: false,
        attachOnly: false,
      },
      { suggestedTransition: 'execution-failed' },
    );
  }
  if (input.signal === 'cancel-confirmed') {
    return observe(
      {
        mayUpdateRunRecord: true,
        mayChangeNodeStatus: true,
        mayTriggerDownstream: false,
        attachOnly: false,
      },
      { suggestedTransition: 'cancel-confirmed' },
    );
  }
  return {
    mayUpdateRunRecord: true,
    mayChangeNodeStatus: false,
    mayTriggerDownstream: false,
    attachOnly: false,
  };
}

export interface ArtifactFileRef {
  readonly id: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly accessPolicyId: string;
  readonly uploadComplete: boolean;
}

export interface ArtifactDraft {
  readonly text?: string;
  readonly files: readonly ArtifactFileRef[];
  readonly links: readonly string[];
}

export interface ArtifactVersion {
  readonly id: string;
  readonly nodeId: string;
  readonly version: number;
  readonly files: readonly ArtifactFileRef[];
  readonly links: readonly string[];
  readonly submittedBy: string;
  readonly text?: string;
  readonly producerRunId?: string;
}

export type ArtifactIssue =
  | 'empty-delivery'
  | 'upload-incomplete'
  | 'invalid-file'
  | 'invalid-link'
  | 'invalid-artifact'
  | 'invalid-history';

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function copyFile(file: ArtifactFileRef): ArtifactFileRef {
  return {
    id: file.id,
    mediaType: file.mediaType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    accessPolicyId: file.accessPolicyId,
    uploadComplete: file.uploadComplete,
  };
}

export function validateDeliveryContent(
  draft: ArtifactDraft,
): { readonly ok: true } | { readonly ok: false; readonly code: ArtifactIssue } {
  const fileIds = new Set<string>();
  for (const file of draft.files) {
    if (
      blank(file.id) ||
      blank(file.mediaType) ||
      blank(file.checksum) ||
      blank(file.accessPolicyId) ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      fileIds.has(file.id)
    ) {
      return { ok: false, code: 'invalid-file' };
    }
    fileIds.add(file.id);
    if (!file.uploadComplete) return { ok: false, code: 'upload-incomplete' };
  }
  const text = draft.text?.trim() ?? '';
  const links = draft.links.map((link) => link.trim()).filter((link) => link.length > 0);
  for (const link of links) {
    if (!isDeliverableLink(link)) return { ok: false, code: 'invalid-link' };
  }
  const substantiveFile = draft.files.some((file) => file.byteSize > 0);
  if (text.length === 0 && !substantiveFile && links.length === 0) {
    return { ok: false, code: 'empty-delivery' };
  }
  return { ok: true };
}

function isDeliverableLink(link: string): boolean {
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Next immutable artifact version. Previous versions are not rewritten. */
export function createArtifactVersion(input: {
  readonly id: string;
  readonly nodeId: string;
  readonly submittedBy: string;
  readonly draft: ArtifactDraft;
  readonly previous: readonly { readonly version: number }[];
  readonly producerRunId?: string;
}):
  | { readonly ok: true; readonly version: ArtifactVersion }
  | { readonly ok: false; readonly code: ArtifactIssue } {
  if (blank(input.id) || blank(input.nodeId) || blank(input.submittedBy)) {
    return { ok: false, code: 'invalid-artifact' };
  }
  if (input.producerRunId !== undefined && blank(input.producerRunId)) {
    return { ok: false, code: 'invalid-artifact' };
  }
  for (const prior of input.previous) {
    if (!Number.isSafeInteger(prior.version) || prior.version < 1) {
      return { ok: false, code: 'invalid-history' };
    }
  }
  const content = validateDeliveryContent(input.draft);
  if (!content.ok) return content;
  const max = input.previous.reduce((highest, prior) => Math.max(highest, prior.version), 0);
  if (max >= Number.MAX_SAFE_INTEGER) return { ok: false, code: 'invalid-history' };
  const text = input.draft.text?.trim() ?? '';
  const version: ArtifactVersion = {
    id: input.id,
    nodeId: input.nodeId,
    version: max + 1,
    files: Object.freeze(input.draft.files.map(copyFile)),
    links: Object.freeze(
      input.draft.links.map((link) => link.trim()).filter((link) => link.length > 0),
    ),
    submittedBy: input.submittedBy,
    ...(text.length > 0 ? { text } : {}),
    ...(input.producerRunId ? { producerRunId: input.producerRunId } : {}),
  };
  return { ok: true, version: Object.freeze(version) };
}

export type CommentTargetType = 'workflow-version' | 'node' | 'artifact-version';
export type CommentAnchorKind = 'text' | 'image-region' | 'pdf-page' | 'file' | 'original-version';
export type CommentStatus = 'open' | 'resolved';

export interface CommentAnchor {
  readonly kind: CommentAnchorKind;
  readonly quote?: string;
  readonly locator?: string;
}

/** A comment thread. Resolving it does not cast or change a review vote. */
export interface Comment {
  readonly id: string;
  readonly targetType: CommentTargetType;
  readonly targetId: string;
  readonly versionId: string;
  readonly anchor: CommentAnchor;
  readonly threadId: string;
  readonly status: CommentStatus;
  readonly authorId: string;
  readonly body: string;
}

export const DISPOSITION_KINDS = [
  'accepted',
  'declined',
  'duplicate',
  'conflict-pending',
  'unreadable',
  'unauthorized',
] as const;

export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

export interface CommentDisposition {
  readonly commentId: string;
  readonly kind: DispositionKind;
  readonly reply: string;
}

export interface FeedbackProposal {
  readonly summary: string;
}

export interface FeedbackBatch {
  readonly id: string;
  readonly commentIds: readonly string[];
  readonly targetVersionId: string;
  readonly idempotencyKey: string;
  readonly dispositions: readonly CommentDisposition[];
  readonly proposal?: FeedbackProposal;
}

export interface AppliedFeedbackBatch {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/**
 * Content identity for one batch. The idempotency key is compared separately.
 * Array order of comment ids and dispositions is part of the identity.
 */
export function feedbackBatchFingerprint(batch: FeedbackBatch): string {
  return canonicalPayload({
    id: batch.id,
    commentIds: [...batch.commentIds],
    targetVersionId: batch.targetVersionId,
    dispositions: batch.dispositions.map((item) => ({
      commentId: item.commentId,
      kind: item.kind,
      reply: item.reply,
    })),
    ...(batch.proposal !== undefined ? { proposal: { summary: batch.proposal.summary } } : {}),
  });
}

/**
 * Preconditions for applying one feedback batch.
 * The same key and the same content replay. Different content under that key mismatches.
 */
export function evaluateFeedbackApplication(input: {
  readonly batch: FeedbackBatch;
  readonly currentTargetVersionId: string;
  readonly authorized: boolean;
  readonly appliedBatches: readonly AppliedFeedbackBatch[];
}):
  | { readonly ok: true; readonly effect: 'applied'; readonly fingerprint: string }
  | { readonly ok: true; readonly effect: 'replayed' }
  | {
      readonly ok: false;
      readonly code:
        | 'version-conflict'
        | 'unauthorized'
        | 'incomplete-disposition'
        | 'duplicate-comment'
        | 'invalid-batch'
        | 'idempotency-mismatch';
    } {
  if (
    blank(input.batch.id) ||
    blank(input.batch.idempotencyKey) ||
    blank(input.batch.targetVersionId)
  ) {
    return { ok: false, code: 'invalid-batch' };
  }
  if (!input.authorized) return { ok: false, code: 'unauthorized' };
  const fingerprint = feedbackBatchFingerprint(input.batch);
  const existing = input.appliedBatches.find(
    (item) => item.idempotencyKey === input.batch.idempotencyKey,
  );
  if (existing) {
    if (existing.fingerprint !== fingerprint) return { ok: false, code: 'idempotency-mismatch' };
    return { ok: true, effect: 'replayed' };
  }
  if (input.batch.commentIds.length === 0) return { ok: false, code: 'invalid-batch' };
  if (input.batch.targetVersionId !== input.currentTargetVersionId) {
    return { ok: false, code: 'version-conflict' };
  }
  if (new Set(input.batch.commentIds).size !== input.batch.commentIds.length) {
    return { ok: false, code: 'duplicate-comment' };
  }
  const expected = new Set(input.batch.commentIds);
  const seen = new Set<string>();
  for (const disposition of input.batch.dispositions) {
    if (
      !expected.has(disposition.commentId) ||
      seen.has(disposition.commentId) ||
      blank(disposition.reply)
    ) {
      return { ok: false, code: 'incomplete-disposition' };
    }
    if (!DISPOSITION_KINDS.includes(disposition.kind))
      return { ok: false, code: 'incomplete-disposition' };
    seen.add(disposition.commentId);
  }
  if (seen.size !== expected.size) return { ok: false, code: 'incomplete-disposition' };
  return { ok: true, effect: 'applied', fingerprint };
}

export const INBOX_KINDS = ['deliver', 'review', 'confirm'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_ACTIONS = [
  'submit',
  'revise',
  'continue-handling',
  'provide-input',
  'retry-or-take-back',
  'review',
  'confirm',
] as const;

export type InboxAction = (typeof INBOX_ACTIONS)[number];

export type DerivedInboxReason =
  | 'assignee-delivery'
  | 'revision-delivery'
  | 'agent-assisted-delivery'
  | 'input-required'
  | 'retry-or-take-back'
  | 'review-assigned'
  | 'parent-confirmation'
  | 'explicit-confirmation'
  | 'owner-input-required'
  | 'owner-take-back';

export interface InboxItem {
  readonly id: string;
  readonly kind: InboxKind;
  readonly actorId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly reason: DerivedInboxReason;
  readonly action: InboxAction;
  readonly detail?: string;
}

export interface InboxNodeFact {
  readonly nodeId: string;
  readonly taskId: string;
  readonly status: NodeStatus;
  readonly assignee: ActorRef;
  readonly access: 'read' | 'write';
  readonly awaitingParentConfirmation: boolean;
  readonly currentRoundId?: string;
  readonly ownerId?: string;
}

export interface InboxRoundFact {
  readonly roundId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly status: 'open' | 'approved' | 'changes-requested' | 'voided';
  readonly reviewerIds: readonly string[];
  readonly terminalReviewerIds: readonly string[];
  readonly current?: boolean;
}

export interface InboxConfirmationFact {
  readonly id: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly confirmed: boolean;
}

const KIND_ORDER: Record<InboxKind, number> = { deliver: 0, review: 1, confirm: 2 };

function isCurrentReviewRound(node: InboxNodeFact, round: InboxRoundFact): boolean {
  if (node.currentRoundId !== undefined) return round.roundId === node.currentRoundId;
  return round.current === true;
}

function deliveryTodo(
  status: NodeStatus,
): { readonly reason: DerivedInboxReason; readonly action: InboxAction } | undefined {
  switch (status) {
    case 'ready':
      return { reason: 'assignee-delivery', action: 'submit' };
    case 'needs-revision':
      return { reason: 'revision-delivery', action: 'revise' };
    case 'running':
      return { reason: 'agent-assisted-delivery', action: 'continue-handling' };
    case 'waiting-for-input':
      return { reason: 'input-required', action: 'provide-input' };
    case 'failed':
      return { reason: 'retry-or-take-back', action: 'retry-or-take-back' };
    default:
      return undefined;
  }
}

/**
 * Inbox rows are derived from node, review, and confirmation facts.
 * Read-only tasks and completed nodes do not create delivery items.
 */
export function deriveInbox(input: {
  readonly actorId: string;
  readonly nodes: readonly InboxNodeFact[];
  readonly rounds: readonly InboxRoundFact[];
  readonly confirmations: readonly InboxConfirmationFact[];
}): readonly InboxItem[] {
  const nodes = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const items: InboxItem[] = [];
  for (const node of input.nodes) {
    if (
      node.access !== 'write' ||
      node.assignee.id !== input.actorId ||
      node.assignee.kind !== 'human'
    ) {
      continue;
    }
    if (node.status === 'ready' && node.awaitingParentConfirmation) {
      items.push({
        id: `confirm:${node.nodeId}:${input.actorId}`,
        kind: 'confirm',
        actorId: input.actorId,
        nodeId: node.nodeId,
        taskId: node.taskId,
        reason: 'parent-confirmation',
        action: 'confirm',
      });
      continue;
    }
    const delivery = deliveryTodo(node.status);
    if (delivery) {
      items.push({
        id: `deliver:${node.nodeId}:${input.actorId}`,
        kind: 'deliver',
        actorId: input.actorId,
        nodeId: node.nodeId,
        taskId: node.taskId,
        reason: delivery.reason,
        action: delivery.action,
      });
    }
  }
  for (const node of input.nodes) {
    if (
      node.access !== 'write' ||
      node.assignee.kind !== 'agent' ||
      node.ownerId === undefined ||
      node.ownerId !== input.actorId
    ) {
      continue;
    }
    const ownerTodo =
      node.status === 'waiting-for-input'
        ? { reason: 'owner-input-required' as const, action: 'provide-input' as const }
        : node.status === 'failed'
          ? { reason: 'owner-take-back' as const, action: 'retry-or-take-back' as const }
          : undefined;
    if (!ownerTodo) continue;
    items.push({
      id: `deliver:${node.nodeId}:${input.actorId}`,
      kind: 'deliver',
      actorId: input.actorId,
      nodeId: node.nodeId,
      taskId: node.taskId,
      reason: ownerTodo.reason,
      action: ownerTodo.action,
    });
  }
  const reviewByNode = new Map<string, InboxItem>();
  for (const round of input.rounds) {
    const node = nodes.get(round.nodeId);
    if (
      !node ||
      node.status !== 'in-review' ||
      node.taskId !== round.taskId ||
      round.status !== 'open' ||
      !isCurrentReviewRound(node, round)
    ) {
      continue;
    }
    if (
      !round.reviewerIds.includes(input.actorId) ||
      round.terminalReviewerIds.includes(input.actorId)
    ) {
      continue;
    }
    reviewByNode.set(round.nodeId, {
      id: `review:${round.roundId}:${input.actorId}`,
      kind: 'review',
      actorId: input.actorId,
      nodeId: round.nodeId,
      taskId: round.taskId,
      reason: 'review-assigned',
      action: 'review',
    });
  }
  items.push(...reviewByNode.values());
  for (const confirmation of input.confirmations) {
    if (
      confirmation.actorId !== input.actorId ||
      confirmation.confirmed ||
      blank(confirmation.reason)
    ) {
      continue;
    }
    const node = nodes.get(confirmation.nodeId);
    if (!node || node.taskId !== confirmation.taskId) continue;
    if (node.status === 'completed' || node.status === 'cancelled') continue;
    items.push({
      id: `confirm:${confirmation.id}`,
      kind: 'confirm',
      actorId: input.actorId,
      nodeId: confirmation.nodeId,
      taskId: confirmation.taskId,
      reason: 'explicit-confirmation',
      action: 'confirm',
      detail: confirmation.reason,
    });
  }
  return Object.freeze(
    items.sort(
      (left, right) =>
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.id.localeCompare(right.id),
    ),
  );
}

export interface TaskGrant {
  readonly actorId: string;
  readonly taskId: string;
  readonly access: 'read' | 'write';
}

export function taskAccess(
  actorId: string,
  taskId: string,
  grants: readonly TaskGrant[],
): 'none' | 'read' | 'write' {
  const matched = grants.filter((grant) => grant.actorId === actorId && grant.taskId === taskId);
  if (matched.some((grant) => grant.access === 'write')) return 'write';
  if (matched.some((grant) => grant.access === 'read')) return 'read';
  return 'none';
}

/** Only the current assignee with write access may submit. Ownership is not a substitute. */
export function canSubmitNode(input: {
  readonly actorId: string;
  readonly assigneeId: string;
  readonly taskAccess: 'none' | 'read' | 'write';
}): boolean {
  return (
    input.taskAccess === 'write' && input.actorId === input.assigneeId && !blank(input.actorId)
  );
}

/** A person votes only on rounds where they are an assigned reviewer. */
export function canCastBallot(actorId: string, reviewerIds: readonly string[]): boolean {
  return !blank(actorId) && reviewerIds.includes(actorId);
}

/**
 * File visibility follows the file's own task grant.
 * An upstream reference does not authorize every downstream actor.
 */
export function canReadFile(input: {
  readonly actorId: string;
  readonly fileTaskId: string;
  readonly grants: readonly TaskGrant[];
  readonly referencedByUpstream: boolean;
}): boolean {
  // The flag is part of the call so an upstream citation is considered and then ignored.
  void input.referencedByUpstream;
  return taskAccess(input.actorId, input.fileTaskId, input.grants) !== 'none';
}

export interface WorkTreeNodeProjection {
  readonly id: string;
  readonly title: string;
  readonly fileNames: readonly string[];
  readonly commentIds: readonly string[];
}

/** Unauthorized ancestors expose an id placeholder and none of the node content. */
export function projectWorkTreeNode(input: {
  readonly canAccess: boolean;
  readonly node: WorkTreeNodeProjection;
}):
  | { readonly access: 'visible'; readonly node: WorkTreeNodeProjection }
  | { readonly access: 'redacted'; readonly id: string } {
  if (!input.canAccess) return { access: 'redacted', id: input.node.id };
  return {
    access: 'visible',
    node: {
      id: input.node.id,
      title: input.node.title,
      fileNames: Object.freeze([...input.node.fileNames]),
      commentIds: Object.freeze([...input.node.commentIds]),
    },
  };
}
