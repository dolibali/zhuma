/** Member-authorized projections only. These view hints never grant execution permission. */
export interface NativeRunTarget {
  readonly spaceId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly title: string;
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
  readonly runVersion: number;
  readonly status:
    'requested' | 'running' | 'waiting-for-input' | 'completed' | 'failed' | 'cancelled';
  readonly dispatch: 'reserved' | 'received' | 'unknown';
  readonly resources: 'held' | 'settled';
  readonly acknowledged: boolean;
  readonly stopPhase: 'none' | 'requested' | 'confirmed' | 'receipt-rejected';
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
      readonly selection: NativeRunSelection | null;
      readonly models: NativeRunChoices<NativeRunModelChoice>;
      readonly experts: NativeRunChoices<NativeRunExpertChoice>;
      readonly resources: readonly NativeRunResource[];
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
  readonly target: NativeRunTarget;
  readonly view: NativeRunPanelView;
  readonly busy?: 'start' | 'send' | 'stop' | 'refresh' | 'history' | undefined;
  readonly error?: string | undefined;
  onSelectionChange(selection: NativeRunSelection): void;
  onStart(selection: NativeRunSelection): Promise<void>;
  onSend(text: string, mode: NativeRunSendMode): Promise<void>;
  onStop(): Promise<void>;
  onRefresh(): Promise<void>;
  onLoadEarlier(): Promise<void>;
}
