import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { resolveMember, type MemberRequest } from './member-session.js';
import type { ExecutionResult } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import { ExecutionRunProtocolError } from './execution-run-protocol.js';
import { NativeWorkError } from './native-work-session-contract.js';
import { ExecutionRunCompositionError } from './execution-run-composition.js';
import {
  readWorkbenchBody,
  WorkbenchBodyError,
  type WorkbenchHttpLimits,
} from './workbench-http.js';

import type { HostRunFrameSink } from './host-run-reader.js';
import { hostRunStream } from './host-run-stream.js';

export const hostRunEndpoints = [
  'begin',
  'send',
  'stop',
  'read',
  'history',
  'options',
  'inbox',
  'observe',
] as const;
// A maximum-size 16,384-unit message, fully JSON-escaped IDs and the RPC
// envelope fit here. Archive/upload budgets must not widen these operations.
export const HOST_RUN_BODY_BYTES = 128 * 1024;
export type HostRunEndpoint = (typeof hostRunEndpoints)[number];

/** Host-owned operations return public projections, never grants or native handles. */
export interface HostRunOperations {
  inbox(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  observe(
    request: MemberRequest,
    payload: unknown,
    sink: HostRunFrameSink,
    wait?: AbortSignal,
  ): Promise<void>;
  options(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  begin(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  send(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  stop(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  read(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  history(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
}

const failure = (code: string) => ({
  ok: false as const,
  error: { code, message: '本地运行操作未完成。', details: {} },
});

/** Same-origin RPC carrier. Run authority and side effects remain in the original owners. */
export function openHostRunHttp(
  ctx: Context,
  options: {
    current(): HostRunOperations | undefined;
    readonly limits: WorkbenchHttpLimits;
  },
) {
  const lifetime = new AbortController();
  const limits = {
    ...options.limits,
    bodyBytes: Math.min(options.limits.bodyBytes, HOST_RUN_BODY_BYTES),
  };
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const stops = hostRunEndpoints.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-run/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch(request) {
        const work = handle(endpoint, request);
        active.add(work);
        void work.finally(() => active.delete(work)).catch(() => undefined);
        return work;
      },
    }),
  );

  async function handle(endpoint: HostRunEndpoint, request: Request): Promise<Response> {
    let rpcId = '';
    const reply = (result: ExecutionResult<unknown>, status = 200) =>
      Response.json({ type: 'server-response', rpcId, result }, { status });
    try {
      if (lifetime.signal.aborted) return reply(failure('cancelled'), 503);
      const original: MemberRequest = { headers: Object.fromEntries(request.headers) };
      // Transport identity only. Every operation still obtains a fresh live
      // execution lease from this same Host's issuer; no resolution is cached.
      const member = await resolveMember(ctx, original);
      if (!member.ok) return reply(failure(member.code), member.status);
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const body = clientRequestSchema.safeParse(await readWorkbenchBody(request, limits, signal));
      if (!body.success || body.data.method !== `zhuma-run/${endpoint}`)
        return reply(failure('invalid-request'), 400);
      rpcId = body.data.rpcId;
      signal.throwIfAborted();
      const owner = options.current();
      if (!owner) return reply(failure('run-authority-unavailable'), 503);
      if (endpoint === 'observe') {
        const observed = hostRunStream({
          rpcId,
          signal,
          observe: (sink, wait) => owner.observe(original, body.data.payload, sink, wait),
          failure: (error) =>
            failure(
              error instanceof ExecutionRunError || error instanceof NativeWorkError
                ? error.code
                : 'unavailable',
            ),
        });
        active.add(observed.drained);
        void observed.drained.finally(() => active.delete(observed.drained)).catch(() => undefined);
        return observed.response;
      }
      // UI cancellation does not enter a Run's lifetime. The owner tracks and
      // drains admitted operations; a lost reply retries the same request key.
      return reply(await owner[endpoint](original, body.data.payload, signal));
    } catch (error) {
      if (error instanceof WorkbenchBodyError)
        return reply(
          failure(
            error.status === 413
              ? 'body-too-large'
              : error.status === 408
                ? 'body-timeout'
                : 'invalid-request',
          ),
          error.status,
        );
      if (
        error instanceof ExecutionRunError ||
        error instanceof ExecutionRunProtocolError ||
        error instanceof ExecutionRunCompositionError ||
        error instanceof NativeWorkError
      )
        return reply(failure(error.code));
      return reply(
        failure(lifetime.signal.aborted || request.signal.aborted ? 'cancelled' : 'unavailable'),
        503,
      );
    }
  }

  return {
    /** Fence the runtime before awaiting this carrier together with native cleanup. */
    close(): Promise<void> {
      if (closing) return closing;
      lifetime.abort();
      for (const stop of stops) stop();
      return (closing = (async () => {
        // A request admitted before close may still publish its read-drain promise.
        while (active.size) await Promise.allSettled([...active]);
      })());
    },
  };
}
