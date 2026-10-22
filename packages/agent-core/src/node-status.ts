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
  | { readonly type: 'submit-artifact'; readonly reviewRequired: boolean }
  | { readonly type: 'input-required' }
  | { readonly type: 'input-supplied' }
  | { readonly type: 'child-workflow-started' }
  | { readonly type: 'child-workflow-returned' }
  | { readonly type: 'review-resolved'; readonly outcome: 'approved' | 'changes-requested' }
  | { readonly type: 'execution-failed' }
  | { readonly type: 'cancel-confirmed' }
  | { readonly type: 'retry' }
  | { readonly type: 'restart' }
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
    case 'submit-artifact':
      if (from === 'needs-revision') {
        if (!transition.reviewRequired) return illegal(from, transition.type);
        return done(from, 'in-review', ['open-review', 'block-downstream']);
      }
      if (from !== 'ready' && from !== 'running') return illegal(from, transition.type);
      return transition.reviewRequired
        ? done(from, 'in-review', ['open-review', 'block-downstream'])
        : done(from, 'completed', ['accept-handoff']);
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
      if (from !== 'failed') return illegal(from, transition.type);
      return done(from, 'ready', ['become-actionable']);
    case 'restart':
      if (from !== 'cancelled') return illegal(from, transition.type);
      return done(from, 'ready', ['become-actionable']);
    case 'reopen-for-rework':
      if (from !== 'completed') return illegal(from, transition.type);
      return done(from, 'needs-revision', ['block-downstream']);
    default: {
      const unexpected: never = transition;
      throw new Error(`Unknown node transition: ${JSON.stringify(unexpected)}`);
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
}

/** Version 0 means no accepted command has been recorded yet. */
export function initialNodeCommandState(): NodeCommandState {
  return { status: 'draft', version: 0, upstreamAffected: false, stored: [] };
}

/**
 * Accept a node command once. A repeated idempotency key replays the first
 * accepted result and does not move the node again. Conflicts and illegal
 * transitions leave the version unchanged.
 */
export function applyNodeTransitionCommand(
  state: NodeCommandState,
  envelope: CommandEnvelope<NodeTransition>,
): { readonly state: NodeCommandState; readonly decision: CommandDecision<AppliedNodeTransition> } {
  const outcome = decideCommand({
    envelope,
    currentVersion: state.version,
    stored: state.stored,
    apply: (_nextVersion) => {
      const result = transitionNode(state.status, envelope.payload);
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
    state: {
      status: applied.to,
      version: outcome.version,
      upstreamAffected: applied.upstreamAffected,
      stored: outcome.stored,
    },
  };
}
