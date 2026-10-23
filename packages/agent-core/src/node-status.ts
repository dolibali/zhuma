import {
  decideCommand,
  type CommandDecision,
  type CommandEnvelope,
  type StoredCommand,
} from './concurrency.js';

/** Node execution states from the confirmed state machine. Not task rollup status. */
export const NODE_STATUSES = [
  'draft',
  'blocked',
  'ready',
  'running',
  'waiting-for-input',
  'child-workflow',
  'in-review',
  'needs-revision',
  'completed',
  'failed',
  'cancelled',
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Status a run was entered from. Recovery and later submit must name it. */
export type NodeEntryStatus = 'ready' | 'needs-revision';

/**
 * Signals that must never move a node by themselves.
 * A process exit, an upload, or a child finishing is not delivery.
 */
export const UNVERIFIED_EXTERNAL_SIGNALS = [
  'process-exit-success',
  'file-uploaded',
  'child-workflow-finished',
  'cancel-unconfirmed',
  'review-unverified',
] as const;

export type UnverifiedExternalSignal = (typeof UNVERIFIED_EXTERNAL_SIGNALS)[number];

export type NodeTransition =
  | { readonly type: 'plan-started'; readonly dependenciesSatisfied: boolean }
  | { readonly type: 'dependencies-changed'; readonly dependenciesSatisfied: boolean }
  | { readonly type: 'execution-acknowledged' }
  | {
      readonly type: 'submit-artifact';
      readonly reviewRequired: boolean;
      readonly entryStatus?: NodeEntryStatus;
    }
  | { readonly type: 'input-required' }
  | { readonly type: 'input-supplied' }
  | { readonly type: 'child-workflow-started' }
  | { readonly type: 'child-workflow-returned' }
  | { readonly type: 'review-resolved'; readonly outcome: 'approved' | 'changes-requested' }
  | { readonly type: 'execution-failed' }
  | { readonly type: 'cancel-confirmed' }
  | { readonly type: 'retry'; readonly returnTo: NodeEntryStatus }
  | { readonly type: 'restart'; readonly returnTo: NodeEntryStatus }
  | { readonly type: 'reopen-for-rework' };

export type AdvancementEffect =
  | 'become-actionable'
  | 'hold-for-dependencies'
  | 'open-review'
  | 'accept-handoff'
  | 'block-downstream'
  | 'await-parent-submit'
  | 'record-failure'
  | 'record-cancellation'
  | 'mark-upstream-affected'
  | 'resume-execution';

export type NodeTransitionResult =
  | {
      readonly ok: true;
      readonly from: NodeStatus;
      readonly to: NodeStatus;
      readonly changed: boolean;
      readonly effects: readonly AdvancementEffect[];
    }
  | {
      readonly ok: false;
      readonly code: 'illegal-transition';
      readonly from: NodeStatus;
      readonly transition: NodeTransition['type'];
    };

const IMPACTED_WITHOUT_RESCHEDULE: readonly NodeStatus[] = [
  'running',
  'waiting-for-input',
  'child-workflow',
  'in-review',
  'needs-revision',
  'completed',
  'failed',
  'cancelled',
];

const CANCELLABLE: readonly NodeStatus[] = [
  'blocked',
  'ready',
  'running',
  'waiting-for-input',
  'child-workflow',
  'in-review',
  'needs-revision',
];

function done(
  from: NodeStatus,
  to: NodeStatus,
  effects: readonly AdvancementEffect[],
): NodeTransitionResult {
  return {
    ok: true,
    from,
    to,
    changed: from !== to,
    effects: Object.freeze([...effects]),
  };
}

function illegal(from: NodeStatus, transition: NodeTransition['type']): NodeTransitionResult {
  return { ok: false, code: 'illegal-transition', from, transition };
}

/** Pure node transition. Does not read a clock, store, or executor. */
export function transitionNode(from: NodeStatus, transition: NodeTransition): NodeTransitionResult {
  if (transition == null || typeof transition !== 'object') {
    return illegal(from, 'unknown' as NodeTransition['type']);
  }
  switch (transition.type) {
    case 'plan-started':
      if (from !== 'draft') return illegal(from, transition.type);
      return transition.dependenciesSatisfied
        ? done(from, 'ready', ['become-actionable'])
        : done(from, 'blocked', ['hold-for-dependencies']);
    case 'dependencies-changed':
      if (from === 'draft') return illegal(from, transition.type);
      if (from === 'blocked') {
        return transition.dependenciesSatisfied
          ? done(from, 'ready', ['become-actionable'])
          : done(from, from, []);
      }
      if (from === 'ready') {
        return transition.dependenciesSatisfied
          ? done(from, from, [])
          : done(from, 'blocked', ['hold-for-dependencies']);
      }
      if (IMPACTED_WITHOUT_RESCHEDULE.includes(from)) {
        return done(from, from, ['mark-upstream-affected']);
      }
      return illegal(from, transition.type);
    case 'execution-acknowledged':
      if (from === 'ready' || from === 'needs-revision') return done(from, 'running', []);
      return illegal(from, transition.type);
    case 'submit-artifact': {
      const entry = transition.entryStatus;
      if (entry !== undefined && entry !== 'ready' && entry !== 'needs-revision') {
        return illegal(from, transition.type);
      }
      if (from === 'needs-revision') {
        if (entry === 'ready' || !transition.reviewRequired) return illegal(from, transition.type);
        return done(from, 'in-review', ['open-review', 'block-downstream']);
      }
      if (from === 'ready') {
        if (entry === 'needs-revision') {
          if (!transition.reviewRequired) return illegal(from, transition.type);
          return done(from, 'in-review', ['open-review', 'block-downstream']);
        }
        return transition.reviewRequired
          ? done(from, 'in-review', ['open-review', 'block-downstream'])
          : done(from, 'completed', ['accept-handoff']);
      }
      if (from === 'running') {
        if (entry !== 'ready' && entry !== 'needs-revision') return illegal(from, transition.type);
        if (entry === 'needs-revision') {
          if (!transition.reviewRequired) return illegal(from, transition.type);
          return done(from, 'in-review', ['open-review', 'block-downstream']);
        }
        return transition.reviewRequired
          ? done(from, 'in-review', ['open-review', 'block-downstream'])
          : done(from, 'completed', ['accept-handoff']);
      }
      return illegal(from, transition.type);
    }
    case 'input-required':
      if (from !== 'running') return illegal(from, transition.type);
      return done(from, 'waiting-for-input', []);
    case 'input-supplied':
      if (from !== 'waiting-for-input') return illegal(from, transition.type);
      return done(from, 'running', ['resume-execution']);
    case 'child-workflow-started':
      if (from !== 'ready' && from !== 'needs-revision') return illegal(from, transition.type);
      return done(from, 'child-workflow', []);
    case 'child-workflow-returned':
      // Status returns to ready. A recorded needs-revision entry stays on the command.
      if (from !== 'child-workflow') return illegal(from, transition.type);
      return done(from, 'ready', ['await-parent-submit']);
    case 'review-resolved':
      // Settlement comes only from applyReviewToNode, which checks the current round.
      return illegal(from, transition.type);
    case 'execution-failed':
      if (from !== 'running' && from !== 'waiting-for-input') return illegal(from, transition.type);
      return done(from, 'failed', ['record-failure', 'block-downstream']);
    case 'cancel-confirmed':
      if (!CANCELLABLE.includes(from)) return illegal(from, transition.type);
      return done(from, 'cancelled', ['record-cancellation', 'block-downstream']);
    case 'retry':
    case 'restart': {
      const expected = transition.type === 'retry' ? 'failed' : 'cancelled';
      if (from !== expected) return illegal(from, transition.type);
      if (transition.returnTo === 'ready') return done(from, 'ready', ['become-actionable']);
      if (transition.returnTo === 'needs-revision') {
        return done(from, 'needs-revision', ['block-downstream']);
      }
      return illegal(from, transition.type);
    }
    case 'reopen-for-rework':
      if (from !== 'completed') return illegal(from, transition.type);
      return done(from, 'needs-revision', ['block-downstream']);
    default: {
      const unexpected: never = transition;
      const recorded = unexpected as { readonly type?: unknown };
      const name = typeof recorded.type === 'string' ? recorded.type : 'unknown';
      return illegal(from, name as NodeTransition['type']);
    }
  }
}

/** These signals are observations. Callers must not treat them as node transitions. */
export function unverifiedSignalChangesNode(signal: UnverifiedExternalSignal): false {
  switch (signal) {
    case 'process-exit-success':
    case 'file-uploaded':
    case 'child-workflow-finished':
    case 'cancel-unconfirmed':
    case 'review-unverified':
      return false;
    default: {
      const unexpected: never = signal;
      throw new Error(`Unknown external signal: ${String(unexpected)}`);
    }
  }
}

export interface AppliedNodeTransition {
  readonly from: NodeStatus;
  readonly to: NodeStatus;
  readonly changed: boolean;
  readonly effects: readonly AdvancementEffect[];
  readonly upstreamAffected: boolean;
}

export interface NodeCommandState {
  readonly status: NodeStatus;
  readonly version: number;
  readonly upstreamAffected: boolean;
  readonly stored: readonly StoredCommand<AppliedNodeTransition>[];
  /**
   * Entry of the current execution. `needs-revision` means review is required
   * again. Commands cannot clear it. Only an approved review settlement does.
   */
  readonly entryStatus?: NodeEntryStatus;
}

/** Version 0 means no accepted command has been recorded yet. */
export function initialNodeCommandState(): NodeCommandState {
  return { status: 'draft', version: 0, upstreamAffected: false, stored: [] };
}

const ENTRY_REQUIRED: readonly NodeStatus[] = [
  'blocked',
  'ready',
  'running',
  'waiting-for-input',
  'child-workflow',
  'in-review',
  'failed',
  'cancelled',
];

/**
 * Statuses that have left draft must already carry an entry.
 * `needs-revision` is itself the record. `draft` and `completed` are not.
 * A missing record is not repaired by the next command.
 * `execution-failed` and `cancel-confirmed` may still close the node.
 */
function entryIsConsistent(state: NodeCommandState): boolean {
  if (
    state.status === 'draft' ||
    state.status === 'completed' ||
    state.status === 'needs-revision'
  ) {
    return true;
  }
  if (!ENTRY_REQUIRED.includes(state.status)) return true;
  return state.entryStatus === 'ready' || state.entryStatus === 'needs-revision';
}

/** Entry the command layer will trust. `ready` counts only when it was persisted. */
function recordedEntry(state: NodeCommandState): NodeEntryStatus | undefined {
  if (state.entryStatus === 'needs-revision' || state.status === 'needs-revision') {
    return 'needs-revision';
  }
  if (state.entryStatus === 'ready') return 'ready';
  return undefined;
}

/**
 * Keep a needs-revision entry until review approval. Callers do not clear it
 * by naming another entry, another return target, or by skipping review.
 */
function nextEntryStatus(
  state: NodeCommandState,
  transition: NodeTransition,
  to: NodeStatus,
): NodeEntryStatus | undefined {
  if (to === 'completed' || to === 'draft') return undefined;
  if (
    to === 'needs-revision' ||
    state.status === 'needs-revision' ||
    state.entryStatus === 'needs-revision'
  ) {
    return 'needs-revision';
  }
  if (state.status === 'draft' && transition.type === 'plan-started') return 'ready';
  if (state.entryStatus === 'ready') return 'ready';
  return undefined;
}

function withEntry(
  state: {
    readonly status: NodeStatus;
    readonly version: number;
    readonly upstreamAffected: boolean;
    readonly stored: NodeCommandState['stored'];
  },
  entry: NodeEntryStatus | undefined,
): NodeCommandState {
  if (entry === undefined) return state;
  return { ...state, entryStatus: entry };
}

/**
 * The public command reads entry and review obligation from domain state.
 * Payload `entryStatus`, `returnTo`, and `reviewRequired: false` cannot override them.
 */
function prepareTransition(
  state: NodeCommandState,
  transition: NodeTransition,
):
  | { readonly ok: true; readonly transition: NodeTransition }
  | { readonly ok: false; readonly code: 'illegal-transition' } {
  if (transition.type === 'submit-artifact') {
    const entry = recordedEntry(state);
    const inFlight = state.status === 'running' || state.status === 'waiting-for-input';
    if (inFlight && entry === undefined) return { ok: false, code: 'illegal-transition' };
    if (entry === undefined && transition.reviewRequired !== true) {
      return { ok: false, code: 'illegal-transition' };
    }
    if (
      transition.entryStatus !== undefined &&
      entry !== undefined &&
      transition.entryStatus !== entry
    ) {
      return { ok: false, code: 'illegal-transition' };
    }
    if (entry === 'needs-revision' && !transition.reviewRequired) {
      return { ok: false, code: 'illegal-transition' };
    }
    if (entry === undefined) return { ok: true, transition };
    return {
      ok: true,
      transition: {
        type: 'submit-artifact',
        reviewRequired: transition.reviewRequired,
        entryStatus: entry,
      },
    };
  }
  if (transition.type === 'retry' || transition.type === 'restart') {
    const entry =
      state.entryStatus ?? (state.status === 'needs-revision' ? 'needs-revision' : undefined);
    if (entry === undefined || transition.returnTo !== entry) {
      return { ok: false, code: 'illegal-transition' };
    }
    return { ok: true, transition: { type: transition.type, returnTo: entry } };
  }
  return { ok: true, transition };
}

/** Close a node that lost its entry. Do not invent a new one. */
function closesWithoutRecord(transition: NodeTransition): boolean {
  return transition.type === 'execution-failed' || transition.type === 'cancel-confirmed';
}

/**
 * Accept a node command once. A repeated idempotency key replays the first
 * accepted result and does not move the node again. Conflicts and illegal
 * transitions leave the version unchanged.
 */
function rejectedCommand(
  state: NodeCommandState | null,
  code: string,
): { readonly state: NodeCommandState; readonly decision: CommandDecision<AppliedNodeTransition> } {
  const kept = state != null && typeof state === 'object' ? state : initialNodeCommandState();
  const version = typeof kept.version === 'number' ? kept.version : 0;
  return { state: kept, decision: { status: 'rejected', code, version } };
}

export function applyNodeTransitionCommand(
  state: NodeCommandState,
  envelope: CommandEnvelope<NodeTransition>,
): { readonly state: NodeCommandState; readonly decision: CommandDecision<AppliedNodeTransition> } {
  if (
    state == null ||
    typeof state !== 'object' ||
    envelope == null ||
    typeof envelope !== 'object' ||
    envelope.payload == null ||
    typeof envelope.payload !== 'object'
  ) {
    return rejectedCommand(state, 'illegal-transition');
  }
  const outcome = decideCommand({
    envelope,
    currentVersion: state.version,
    stored: state.stored,
    apply: (_nextVersion) => {
      if (!entryIsConsistent(state) && !closesWithoutRecord(envelope.payload)) {
        return { disposition: 'reject', code: 'illegal-transition' };
      }
      const prepared = prepareTransition(state, envelope.payload);
      if (!prepared.ok) return { disposition: 'reject', code: prepared.code };
      const result = transitionNode(state.status, prepared.transition);
      if (!result.ok) return { disposition: 'reject', code: result.code };
      if (!result.changed && result.effects.length === 0) {
        return { disposition: 'ignore', code: 'no-effect' };
      }
      return {
        disposition: 'accept',
        result: {
          from: result.from,
          to: result.to,
          changed: result.changed,
          effects: result.effects,
          upstreamAffected:
            state.upstreamAffected || result.effects.includes('mark-upstream-affected'),
        },
      };
    },
  });
  if (outcome.decision.status !== 'applied') {
    return { state: { ...state, stored: outcome.stored }, decision: outcome.decision };
  }
  const applied = outcome.decision.result;
  return {
    decision: outcome.decision,
    state: withEntry(
      {
        status: applied.to,
        version: outcome.version,
        upstreamAffected: applied.upstreamAffected,
        stored: outcome.stored,
      },
      nextEntryStatus(state, envelope.payload, applied.to),
    ),
  };
}
