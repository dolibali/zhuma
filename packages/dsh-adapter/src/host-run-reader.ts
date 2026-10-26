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
import { NativeWorkError, type NativeHistoryEvent } from './native-work-session-contract.js';

export type HostRunModeCapability =
  | { readonly kind: 'available' }
  | {
      readonly kind: 'unavailable';
      readonly code:
        'not-permitted' | 'stopping' | 'detached' | 'dispatch-unconfirmed' | 'not-running';
    }
  | { readonly kind: 'unknown'; readonly code: 'unavailable' };
export type HostRunSendCapabilities = Readonly<
  Record<'followup' | 'steer' | 'queue', HostRunModeCapability>
>;
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
}
export interface HostRunHistoryPage extends ExecutionRunLocator {
  readonly sessionId: string;
  readonly events: readonly NativeHistoryEvent[];
  readonly nextAfter: number;
}
export interface HostRunReader {
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
): HostRunReader {
  return {
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
