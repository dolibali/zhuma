import type { ReactNode } from 'react';
/** Member-authorized projections only. These view hints never grant execution permission. */
export interface NativeRunTarget {
  readonly spaceId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly title: string;
  /** Complete display-only node goal. Never included in execution locator requests. */
  readonly description?: string;
}

export interface NativeRunModel {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly reasoningEffort?: string | undefined;
}
export type NativeRunExecutor =
  | { readonly kind: 'builtin' }
  | {
      readonly kind: 'plan-expert';
      readonly ref: { readonly id: string; readonly version: string };
    };
export interface NativeRunSelection {
  readonly model: NativeRunModel;
  readonly executor: NativeRunExecutor;
  readonly knowledge?: { readonly libraryId: string; readonly allowDrafts: boolean };
  readonly workspace?:
    | { readonly kind: 'text-only' }
    | {
        readonly kind: 'local';
        readonly id: string;
        readonly publish?: readonly {
          readonly kind: 'file' | 'directory';
          readonly path: string;
        }[];
      }
    | { readonly kind: 'unavailable' };
}
export interface NativeRunWorkspaceChoice {
  readonly id: string;
  readonly label: string;
  readonly access: 'read' | 'write';
  readonly publish: boolean;
  readonly publication?: 'per-run';
}
export interface NativeRunModelChoice {
  readonly id: string;
  readonly label: string;
  readonly value: NativeRunModel;
}
export interface NativeRunExpertChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: NativeRunExecutor;
}
export type NativeRunChoices<T> =
  | { readonly kind: 'ready'; readonly items: readonly T[] }
  | { readonly kind: 'loading' | 'unavailable'; readonly message: string };
export type NativeRunAction =
  | { readonly kind: 'available' }
  | { readonly kind: 'unknown' | 'unavailable'; readonly message: string };
export type NativeRunSendMode = 'followup' | 'steer' | 'queue';
export type NativeRunResultDelivery =
  | {
      readonly kind: 'pending';
      readonly phase: 'draining' | 'not-durable' | 'delivery-unconfirmed';
    }
  | ({
      readonly kind: 'delivered';
      readonly artifactVersionId: string;
      readonly artifactVersion: number;
      readonly roundId?: string;
      readonly receipt: { readonly idempotencyKey: string; readonly version: number };
    } & (
      | { readonly protocolVersion?: never; readonly manifestDigest?: never }
      | { readonly protocolVersion: 2; readonly manifestDigest: string }
    ));

/** Exact read projection from the member Run transport, never a raw SDK Agent handle. */
export interface NativeRunSummary {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly runId: string;
  readonly generation: number;
  readonly segmentId: string;
  readonly nodeVersion: number;
  /** Only the original remote result receipt; no locally invented delivery version. */
  readonly submission?: { readonly artifactVersionId: string; readonly roundId?: string };
  readonly runVersion: number;
  readonly status:
    'requested' | 'running' | 'waiting-for-input' | 'completed' | 'failed' | 'cancelled';
  readonly dispatch: 'reserved' | 'received' | 'unknown';
  readonly resources: 'held' | 'settled';
  readonly acknowledged: boolean;
  readonly stopPhase: 'none' | 'requested' | 'confirmed' | 'receipt-rejected';
  readonly resultDelivery?: NativeRunResultDelivery;
  readonly native: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly status: 'idle' | 'running' | 'detached';
  } | null;
}

/** A projects known native history records. Unknown/raw payloads are not render props. */
export interface NativeRunMessage {
  readonly id: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly text: string;
  readonly label?: string | undefined;
  readonly nativeId?: string | undefined;
  readonly delivery?: 'received' | 'recorded' | 'streaming' | 'syncing' | undefined;
}
export interface NativeRunResource {
  readonly id: string;
  readonly kind: 'skill' | 'mcp' | 'input';
  readonly name: string;
  readonly status: 'fixed' | 'unavailable' | 'unknown';
}
export type NativeRunPanelView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly run: NativeRunSummary | null;
      readonly messages: readonly NativeRunMessage[];
      readonly hasEarlier: boolean;
      readonly turnEnd?: Extract<NativeConversationFrame, { type: 'turn-end' }>;
      readonly selection: NativeRunSelection | null;
      readonly models: NativeRunChoices<NativeRunModelChoice>;
      readonly knowledgeLibraries?: NativeRunChoices<{
        readonly id: string;
        readonly label: string;
      }>;
      readonly experts: NativeRunChoices<NativeRunExpertChoice>;
      readonly resources: readonly NativeRunResource[];
      readonly workspaces?: readonly NativeRunWorkspaceChoice[];
      readonly workspaceApprovalScope?: { readonly spaceId: string; readonly projectId: string };
      readonly actions: {
        readonly start: NativeRunAction;
        readonly send: Readonly<Record<NativeRunSendMode, NativeRunAction>>;
        readonly stop: NativeRunAction;
      };
    };

/** C owns the controlled panel. A owns authorized data loading and handlers.
 * Mount, target changes and refresh must never call onStart/onSend implicitly.
 * A held/active Run freezes selection; changing it requires an explicit new Run.
 * No handler exposes raw owner RPC, grants, filesystem paths or SDK methods.
 */
export interface NativeRunPanelProps {
  readonly reviewAction?: ReactNode;
  readonly target: NativeRunTarget;
  readonly view: NativeRunPanelView;
  readonly busy?: 'start' | 'send' | 'stop' | 'refresh' | 'history' | 'open' | undefined;
  readonly error?: string | undefined;
  /** Ephemeral unsent-input presence only. No draft text or persistence crosses this seam. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /** Embedded workspaces can place their close action beside the node title. */
  onClose?: (() => void) | undefined;
  onManageWorkspaces?: (() => void) | undefined;
  /** Explicit navigation to the same authorized native Session, never a start. */
  onOpenSession?: (() => Promise<void>) | undefined;
  onSelectionChange(selection: NativeRunSelection): void;
  onStart(selection: NativeRunSelection): Promise<void>;
  onSend(text: string, mode: NativeRunSendMode): Promise<void>;
  onStop(): Promise<void>;
  onRefresh(): Promise<void>;
  onLoadEarlier(): Promise<void>;
}

/** Read-only native presentation. A transport frame is never an execution command. */
export type NativeConversationTarget = Pick<
  NativeRunTarget,
  'spaceId' | 'taskId' | 'planId' | 'revision' | 'nodeId'
> &
  Pick<NativeRunSummary, 'runId' | 'generation' | 'segmentId'>;
export interface NativeRunInbox {
  readonly asOfSeq: number;
  readonly receipts: readonly {
    readonly requestId: string;
    readonly messageId: string;
    readonly mode: NativeRunSendMode;
    readonly status: 'received' | 'claimed' | 'unknown';
  }[];
  readonly items: readonly {
    readonly id: string;
    readonly text: string;
    readonly target: 'next-turn' | 'next-step';
    readonly requestId: string;
    readonly mode: NativeRunSendMode;
    readonly status: 'received';
  }[];
}
export type NativeConversationFrame =
  | {
      readonly type: 'turn-end';
      readonly seq: number;
      readonly time: number;
      readonly turn: number;
      readonly reason: {
        readonly kind:
          | 'completed'
          | 'blocked'
          | 'max-tokens'
          | 'error'
          | 'aborted'
          | 'interrupted'
          | 'forked'
          | 'unknown';
      };
    }
  | { readonly type: 'ready' }
  | {
      readonly type: 'message';
      readonly seq: number;
      readonly messageKey: string;
      readonly id: string;
      readonly role: 'user' | 'assistant';
      readonly text: string;
      readonly interrupted?: true;
    }
  | { readonly type: 'status'; readonly status: 'idle' | 'running' }
  | { readonly type: 'gap'; readonly after: number }
  | {
      readonly type: 'assistant-stream';
      readonly frame:
        | {
            readonly type: 'snapshot';
            readonly revision: number;
            readonly activeAttempt?: {
              readonly attemptId: string;
              readonly startedAfterSeq: number;
              readonly nextIndex: number;
              readonly text: string;
              readonly toolNames: readonly string[];
            };
          }
        | { readonly type: 'start'; readonly attemptId: string; readonly revision: number }
        | {
            readonly type: 'chunk';
            readonly attemptId: string;
            readonly revision: number;
            readonly index: number;
            readonly text?: string;
            readonly toolName?: string;
          }
        | {
            readonly type: 'end';
            readonly attemptId: string;
            readonly revision: number;
            readonly index: number;
            readonly outcome:
              | { readonly kind: 'abandoned' }
              | {
                  readonly kind: 'committed';
                  readonly eventType: 'assistant/message' | 'assistant/attempt';
                  readonly seq: number;
                  readonly messageKey: string;
                };
          };
    };
