import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { WorkbenchError } from '@zhuma/agent-core';
import { resolveMember } from './member-session.js';
import { MemberWorkbenchService } from './member-workbench-service.js';
import type { MemberWorkbenchOptions } from './member-workbench-dto.js';
import type { WorkbenchService } from './workbench-service.js';
import { readWorkbenchBody, WORKBENCH_HTTP_LIMITS, WorkbenchBodyError } from './workbench-http.js';

export const memberWorkbenchEndpoints = ['snapshot', 'command', 'plan'] as const;
export interface MemberWorkbenchMountOptions extends Omit<MemberWorkbenchOptions, 'resolve'> {
  readonly workbench: WorkbenchService;
}

/** A mounts this beside the old owner routes, never by reopening those routes to members. */
export function applyMemberWorkbench(ctx: Context, options: MemberWorkbenchMountOptions): void {
  const lifetime = new AbortController();
  const stops = memberWorkbenchEndpoints.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-member/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const signal = AbortSignal.any([
          request.signal,
          lifetime.signal,
          AbortSignal.timeout(120_000),
        ]);
        const headers = Object.fromEntries(request.headers.entries());
        const resolve = () => resolveMember(ctx, { headers });
        let rpcId: string | undefined;
        try {
          signal.throwIfAborted();
          const admission = await resolve();
          if (!admission.ok)
            return Response.json(
              { ok: false, error: { code: admission.code } },
              { status: admission.status },
            );
          if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
            return new Response(null, { status: 415 });
          const body = await readWorkbenchBody(request, WORKBENCH_HTTP_LIMITS);
          const envelope = clientRequestSchema.safeParse(body);
          if (!envelope.success || envelope.data.method !== `zhuma-member/${endpoint}`)
            return new Response(null, { status: 400 });
          rpcId = envelope.data.rpcId;
          const service = new MemberWorkbenchService(options.workbench, { ...options, resolve });
          const payload = envelope.data.payload;
          signal.throwIfAborted();
          const value =
            endpoint === 'snapshot'
              ? await service.snapshot(payload)
              : endpoint === 'command'
                ? await service.command(payload, signal)
                : await service.plan(payload, signal);
          signal.throwIfAborted();
          return Response.json(
            { type: 'server-response', rpcId, result: { ok: true, value } },
            { headers: { 'cache-control': 'no-store' } },
          );
        } catch (error) {
          if (error instanceof WorkbenchBodyError)
            return new Response(null, { status: error.status });
          if (rpcId === undefined)
            return new Response(null, { status: signal.aborted ? 408 : 400 });
          const code = signal.aborted
            ? 'cancelled'
            : error instanceof WorkbenchError
              ? error.code
              : error instanceof z.ZodError
                ? 'validation'
                : 'unavailable';
          // Never return provider errors, paths, request headers, schema input or account verifiers.
          const message = signal.aborted
            ? '操作已取消或超时，请刷新确认结果。'
            : error instanceof WorkbenchError
              ? error.message
              : error instanceof z.ZodError
                ? '提交的数据格式不正确。'
                : '服务暂不可用，请稍后重试。';
          return Response.json(
            { type: 'server-response', rpcId, result: { ok: false, error: { code, message } } },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
      },
    }),
  );
  ctx.effect(() => () => {
    lifetime.abort();
    for (const stop of stops) void stop();
  });
}
