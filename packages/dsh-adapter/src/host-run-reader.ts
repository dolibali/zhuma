import { z } from 'zod';
import type {
  ExecutionService,
  ExecutionResult,
  ExecutionNodeLocator,
} from './execution-service.js';
import type { ExecutionRunAuthorities, ExecutionRunLocator } from './execution-run-authority.js';
import {
  ExecutionRunError,
  readExecutionRunState,
  type ExecutionRun,
} from './execution-run-state.js';
import type { MemberRequest } from './member-session.js';
import { NATIVE_WORK_LIMITS, type NativeWorkSessionService } from './native-work-session.js';
import {
  NativeWorkError,
  type NativeHistoryEvent,
  type NativeConversationFrame,
} from './native-work-session-contract.js';
import { canonicalPayload } from '@zhuma/agent-core';

export type HostRunModeCapability =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'unavailable';
      readonly code:
        | 'not-permitted'
        | 'stopping'
        | 'detached'
        | 'dispatch-unconfirmed'
        | 'not-running'
        | 'completion-pending';
    }
  | { readonly kind: 'unknown'; readonly code: 'unavailable' };
export type HostRunSendCapabilities = Readonly<
  Record<'followup' | 'steer' | 'queue', HostRunModeCapability>
>;
export type HostRunResultPending = 'draining' | 'not-durable' | 'delivery-unconfirmed';
export type HostRunResultDelivery =
  | { readonly kind: 'pending'; readonly phase: HostRunResultPending }
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
export interface HostRunReadView extends ExecutionNodeLocator {
  readonly runId: string;
  readonly generation: number;
  readonly segmentId: string;
  readonly nodeVersion: number;
  readonly runVersion: number;
  readonly status: ExecutionRun['attempt']['status'];
  readonly dispatch: ExecutionRun['dispatch'];
  readonly resources: ExecutionRun['resources'];
  readonly acknowledged: boolean;
  readonly stopPhase: ExecutionRun['attempt']['stopPhase'];
  readonly native: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly status: 'idle' | 'running' | 'detached';
  } | null;
  readonly sendCapabilities?: HostRunSendCapabilities;
  readonly resultDelivery?: HostRunResultDelivery;
}
export interface HostRunHistoryPage extends ExecutionRunLocator {
  readonly sessionId: string;
  readonly events: readonly NativeHistoryEvent[];
  readonly nextAfter: number;
}
export type HostRunConversationTarget = ExecutionRunLocator & {
  readonly spaceId: string;
  readonly generation: number;
  readonly segmentId: string;
};
export type HostRunConversationFrame = (NativeConversationFrame | { readonly type: 'ready' }) & {
  readonly target: HostRunConversationTarget;
  readonly sessionId: string;
};
export interface HostRunInboxView {
  readonly target: HostRunConversationTarget;
  readonly sessionId: string;
  readonly asOfSeq: number;
  readonly receipts: readonly {
    readonly requestId: string;
    readonly messageId: string;
    readonly mode: 'followup' | 'steer' | 'queue';
    readonly status: 'received' | 'claimed' | 'unknown';
  }[];
  readonly items: readonly {
    readonly id: string;
    readonly text: string;
    readonly target: 'next-turn' | 'next-step';
    readonly requestId: string;
    readonly mode: 'followup' | 'steer' | 'queue';
    readonly status: 'received';
  }[];
}
export type HostRunFrameSink = (
  frame: HostRunConversationFrame,
  signal: AbortSignal,
) => Promise<void>;
export interface HostRunReader {
  inbox(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostRunInboxView>>;
  observe(
    request: MemberRequest,
    payload: unknown,
    sink: HostRunFrameSink,
    wait?: AbortSignal,
  ): Promise<void>;
  read(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostRunReadView>>;
  history(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostRunHistoryPage>>;
}

const id = z.string().min(1).max(200);
const historyRequest = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
  runId: id,
  after: z.number().int().min(-1).refine(Number.isSafeInteger).default(-1),
  limit: z.number().int().min(1).max(NATIVE_WORK_LIMITS.historyEvents).default(50),
});

const inboxRequest = historyRequest.omit({ after: true, limit: true });
const observeRequest = historyRequest.omit({ limit: true });
export function conversationTarget(
  scope: import('./native-work-session-contract.js').NativeWorkScope,
): HostRunConversationTarget {
  const { spaceId, taskId, planId, revision, nodeId, runId, generation, segmentId } = scope;
  return { spaceId, taskId, planId, revision, nodeId, runId, generation, segmentId };
}
/** Project exact known fields, even if a future native version adds private fields. */
export function publicFrame(value: NativeConversationFrame): NativeConversationFrame {
  switch (value.type) {
    case 'turn-end':
      return {
        type: value.type,
        seq: value.seq,
        time: value.time,
        turn: value.turn,
        reason: { kind: value.reason.kind },
      };
    case 'message':
      return {
        type: value.type,
        seq: value.seq,
        time: value.time,
        messageKey: value.messageKey,
        role: value.role,
        id: value.id,
        text: value.text,
        ...(value.interrupted ? { interrupted: true } : {}),
      };
    case 'status':
      return { type: value.type, status: value.status };
    case 'gap':
      return { type: value.type, after: value.after };
    case 'assistant-stream': {
      const frame = value.frame;
      if (frame.type === 'snapshot')
        return {
          type: value.type,
          frame: {
            type: 'snapshot',
            revision: frame.revision,
            ...(frame.activeAttempt
              ? {
                  activeAttempt: {
                    attemptId: frame.activeAttempt.attemptId,
                    startedAfterSeq: frame.activeAttempt.startedAfterSeq,
                    nextIndex: frame.activeAttempt.nextIndex,
                    text: frame.activeAttempt.text,
                    toolNames: [...frame.activeAttempt.toolNames],
                  },
                }
              : {}),
          },
        };
      const common = { type: frame.type, attemptId: frame.attemptId, revision: frame.revision };
      if (frame.type === 'start') return { type: value.type, frame: { ...common, type: 'start' } };
      if (frame.type === 'chunk')
        return {
          type: value.type,
          frame: {
            ...common,
            type: 'chunk',
            index: frame.index,
            ...(frame.text === undefined ? {} : { text: frame.text }),
            ...(frame.toolName === undefined ? {} : { toolName: frame.toolName }),
          },
        };
      return {
        type: value.type,
        frame: {
          ...common,
          type: 'end',
          index: frame.index,
          outcome:
            frame.outcome.kind === 'abandoned'
              ? { kind: 'abandoned' }
              : {
                  kind: 'committed',
                  eventType: frame.outcome.eventType,
                  seq: frame.outcome.seq,
                  messageKey: frame.outcome.messageKey,
                },
        },
      };
    }
  }
}

/** Reads use a fresh read grant; they never connect, resume, send, or enable a writer. */
export function createHostRunReader(
  execution: ExecutionService,
  authorities: ExecutionRunAuthorities,
  native: NativeWorkSessionService,
  capabilities?: (
    request: MemberRequest,
    locator: ExecutionRunLocator,
    wait?: AbortSignal,
  ) => Promise<HostRunSendCapabilities>,
  pendingResult?: (
    scope: import('./native-work-session-contract.js').NativeWorkScope,
  ) => HostRunResultPending | undefined,
): HostRunReader {
  return {
    async inbox(request, payload, wait) {
      wait?.throwIfAborted();
      const parsed = inboxRequest.safeParse(payload);
      if (!parsed.success) throw new ExecutionRunError('run-validation');
      const opened = await authorities.open(request, parsed.data, 'read');
      try {
        const page = await native.readInbox(opened.grant, wait);
        wait?.throwIfAborted();
        opened.grant.assertCurrent('history');
        if (canonicalPayload(page.binding.scope) !== canonicalPayload(opened.grant.scope))
          throw new NativeWorkError('scope-mismatch');
        return {
          ok: true,
          value: {
            target: conversationTarget(opened.grant.scope),
            sessionId: page.binding.nativeSessionId,
            asOfSeq: page.asOfSeq,
            receipts: page.receipts.map(({ requestId, messageId, mode, status }) => ({
              requestId,
              messageId,
              mode,
              status,
            })),
            items: page.items.map(({ id, text, target, requestId, mode, status }) => ({
              id,
              text,
              target,
              requestId,
              mode,
              status,
            })),
          },
        };
      } finally {
        opened.dispose();
      }
    },
    async observe(request, payload, sink, wait) {
      wait?.throwIfAborted();
      const parsed = observeRequest.safeParse(payload);
      if (!parsed.success) throw new ExecutionRunError('run-validation');
      const { after, ...locator } = parsed.data;
      const opened = await authorities.open(request, locator, 'read');
      const watching = new AbortController();
      const signal = AbortSignal.any([
        watching.signal,
        opened.grant.signal,
        ...(wait ? [wait] : []),
      ]);
      let stop: (() => Promise<unknown>) | undefined;
      try {
        signal.throwIfAborted();
        const current = native.open(opened.grant);
        if (!current) throw new NativeWorkError('not-started');
        const source = native.observe(opened.grant, after, signal);
        let next = source.next();
        void next.catch(() => undefined);
        stop = async () => {
          watching.abort();
          await source.return(undefined);
        };
        // Flush a read-only handshake even when the live inbox is quiet. Starting
        // the native iterator first installs its history/live observation path.
        opened.grant.assertCurrent('follow');
        await sink(
          {
            type: 'ready',
            target: conversationTarget(opened.grant.scope),
            sessionId: current.binding.nativeSessionId,
          },
          signal,
        );
        for (;;) {
          const item = await next;
          if (item.done) break;
          const frame = item.value;
          signal.throwIfAborted();
          opened.grant.assertCurrent('follow');
          if (
            canonicalPayload(frame.scope) !== canonicalPayload(opened.grant.scope) ||
            frame.nativeSessionId !== current.binding.nativeSessionId
          )
            throw new NativeWorkError('scope-mismatch');
          await sink(
            {
              target: conversationTarget(opened.grant.scope),
              sessionId: frame.nativeSessionId,
              ...publicFrame(frame),
            },
            signal,
          );
          signal.throwIfAborted();
          opened.grant.assertCurrent('follow');
          next = source.next();
        }
      } finally {
        try {
          await stop?.();
        } finally {
          opened.dispose();
        }
      }
    },
    async read(request, payload, wait) {
      wait?.throwIfAborted();
      const opened = await authorities.open(request, payload, 'read');
      try {
        wait?.throwIfAborted();
        const scope = opened.grant.scope;
        const node = execution.readRunNode(scope);
        const state = node && readExecutionRunState(node);
        const run = state?.runs.find((item) => item.attempt.id === scope.runId);
        if (!node || !state || !run) throw new ExecutionRunError('run-state-invalid');
        const current = native.open(opened.grant);
        if (
          run.attempt.sessionId !== undefined &&
          current?.binding.nativeSessionId !== run.attempt.sessionId
        )
          throw new NativeWorkError('binding-state-invalid');
        const sendCapabilities = await capabilities?.(
          request,
          {
            taskId: scope.taskId,
            planId: scope.planId,
            revision: scope.revision,
            nodeId: scope.nodeId,
            runId: scope.runId,
          },
          wait,
        );
        let resultDelivery: HostRunResultDelivery | undefined;
        if (run.resultDelivery) {
          const delivered = run.resultDelivery;
          // A fresh original member/history check confirms the persisted business
          // receipt, including after restart. Never reopen a writer or mint a C ref.
          const confirmed = await execution.confirmNativeResultDelivery(
            request,
            {
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              nodeId: scope.nodeId,
              runId: scope.runId,
              generation: scope.generation,
              segmentId: scope.segmentId,
              configurationId: run.selection.configurationId,
              idempotencyKey: delivered.receiptKey,
              intentId: delivered.source.intentId,
              digest: delivered.digest,
              provenanceFingerprint: delivered.provenanceFingerprint,
              ...(delivered.protocolVersion === 2
                ? { protocolVersion: 2, manifestDigest: delivered.manifestDigest }
                : {}),
            },
            wait,
          );
          if (!confirmed.ok) return confirmed;
          const receipt = confirmed.value;
          resultDelivery = {
            kind: 'delivered',
            artifactVersionId: receipt.artifactVersionId,
            artifactVersion: receipt.artifactVersion,
            ...(receipt.roundId === undefined ? {} : { roundId: receipt.roundId }),
            receipt: {
              idempotencyKey: receipt.receipt.idempotencyKey,
              version: receipt.receipt.version,
            },
            ...(delivered.protocolVersion === 2
              ? { protocolVersion: 2 as const, manifestDigest: delivered.manifestDigest }
              : {}),
          };
        } else if (
          current?.binding.resultIntent &&
          run.resources === 'held' &&
          run.attempt.stopPhase === 'none'
        ) {
          resultDelivery = { kind: 'pending', phase: pendingResult?.(scope) ?? 'not-durable' };
        }
        opened.grant.assertCurrent('open');
        return {
          ok: true,
          value: {
            taskId: scope.taskId,
            planId: scope.planId,
            revision: scope.revision,
            nodeId: scope.nodeId,
            runId: scope.runId,
            generation: scope.generation,
            segmentId: scope.segmentId,
            nodeVersion: node.command.version,
            runVersion: state.version,
            status: run.attempt.status,
            dispatch: run.dispatch,
            resources: run.resources,
            acknowledged: run.attempt.acknowledged,
            stopPhase: run.attempt.stopPhase,
            ...(sendCapabilities ? { sendCapabilities } : {}),
            ...(resultDelivery ? { resultDelivery } : {}),
            native: current
              ? {
                  sessionId: current.binding.nativeSessionId,
                  agentId: current.binding.nativeAgentId,
                  status: current.status,
                }
              : null,
          },
        };
      } finally {
        opened.dispose();
      }
    },
    async history(request, payload, wait) {
      wait?.throwIfAborted();
      const parsed = historyRequest.safeParse(payload);
      if (!parsed.success) throw new ExecutionRunError('run-validation');
      const { after, limit, ...locator } = parsed.data;
      const opened = await authorities.open(request, locator, 'read');
      try {
        const page = await native.history(opened.grant, after, undefined, wait);
        const events = page.events.slice(0, limit);
        opened.grant.assertCurrent('history');
        return {
          ok: true,
          value: {
            ...locator,
            sessionId: page.binding.nativeSessionId,
            events,
            nextAfter: events.at(-1)?.seq ?? after,
          },
        };
      } finally {
        opened.dispose();
      }
    },
  };
}
