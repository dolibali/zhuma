import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { resolveMember, type MemberRequest } from './member-session.js';
import {
  readWorkbenchBody,
  WorkbenchBodyError,
  type WorkbenchHttpLimits,
} from './workbench-http.js';
import { ExecutionWorkflowError } from './execution-workflow-contract.js';
import { ExecutionRunError } from './execution-run-state.js';
import type { HostWorkflowOperations } from './host-workflow-owner.js';
import { HOST_RUN_BODY_BYTES } from './host-run-http.js';

export const hostWorkflowEndpoints = ['options', 'read', 'start', 'resume', 'stop'] as const;
const failure = (code: string) => ({
  ok: false as const,
  error: { code, message: '工作流操作未完成。', details: {} },
});

/** Same official member carrier; public JSON never receives a claim or ticket. */
export function openHostWorkflowHttp(
  ctx: Context,
  options: {
    current(): HostWorkflowOperations | undefined;
    readonly limits: WorkbenchHttpLimits;
  },
) {
  const lifetime = new AbortController();
  const limits = {
    ...options.limits,
    bodyBytes: Math.min(options.limits.bodyBytes, HOST_RUN_BODY_BYTES),
  };
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const stops = hostWorkflowEndpoints.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-workflow/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch(request) {
        const work = handle(endpoint, request);
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => undefined);
        return work;
      },
    }),
  );
  async function handle(
    endpoint: (typeof hostWorkflowEndpoints)[number],
    request: Request,
  ): Promise<Response> {
    let rpcId = '';
    const reply = (result: unknown, status = 200) =>
      Response.json({ type: 'server-response', rpcId, result }, { status });
    try {
      if (lifetime.signal.aborted) return reply(failure('cancelled'), 503);
      const original: MemberRequest = { headers: Object.fromEntries(request.headers) };
      const member = await resolveMember(ctx, original);
      if (!member.ok) return reply(failure(member.code), member.status);
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const body = clientRequestSchema.safeParse(await readWorkbenchBody(request, limits, signal));
      if (!body.success || body.data.method !== `zhuma-workflow/${endpoint}`)
        return reply(failure('workflow-validation'), 400);
      rpcId = body.data.rpcId;
      signal.throwIfAborted();
      const owner = options.current();
      if (!owner) return reply(failure('workflow-authority-unavailable'), 503);
      return reply(await owner[endpoint](original, body.data.payload, signal));
    } catch (error) {
      if (error instanceof WorkbenchBodyError)
        return reply(
          failure(
            error.status === 413
              ? 'body-too-large'
              : error.status === 408
                ? 'body-timeout'
                : 'workflow-validation',
          ),
          error.status,
        );
      if (error instanceof ExecutionWorkflowError || error instanceof ExecutionRunError)
        return reply(failure(error.code));
      return reply(
        failure(
          lifetime.signal.aborted || request.signal.aborted ? 'cancelled' : 'workflow-unavailable',
        ),
        503,
      );
    }
  }
  return {
    close(): Promise<void> {
      if (closing) return closing;
      lifetime.abort();
      for (const stop of stops) stop();
      return (closing = (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      })());
    },
  };
}
