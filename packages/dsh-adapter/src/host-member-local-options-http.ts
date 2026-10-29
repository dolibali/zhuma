import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type { ExecutionResult } from './execution-service.js';
import { ExecutionRunError } from './execution-run-state.js';
import { resolveMember, type MemberRequest } from './member-session.js';
import { registerProductFetch } from './member-web-transport.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';
import { HOST_RUN_BODY_BYTES } from './host-run-http.js';

type Reader = (
  request: MemberRequest,
  payload: unknown,
  wait?: AbortSignal,
) => Promise<ExecutionResult<unknown>>;

/** One product metadata projection. No generic Run dispatcher, SDK Session,
 * model discovery, execution admission or native factory is mounted here. */
export function openHostMemberLocalOptionsHttp(
  ctx: Context,
  current: () => Reader | undefined,
  endpoint: 'local-run-options' | 'local-review-options' = 'local-run-options',
) {
  const lifetime = new AbortController(),
    active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const failure = (code: string) => ({
    ok: false as const,
    error: { code, message: '暂时无法读取工作节点，请刷新后重试。', details: {} },
  });
  const stop = registerProductFetch(ctx, {
    path: `/api/zhuma-member/${endpoint}`,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch(request) {
      const pending = handle(request);
      active.add(pending);
      void pending.finally(() => active.delete(pending)).catch(() => undefined);
      return pending;
    },
  });
  async function handle(request: Request) {
    let rpcId = '';
    const reply = (result: ExecutionResult<unknown>, status = 200) =>
      Response.json(
        { type: 'server-response', rpcId, result },
        { status, headers: { 'cache-control': 'no-store' } },
      );
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    try {
      signal.throwIfAborted();
      const original = { headers: Object.fromEntries(request.headers) };
      const member = await resolveMember(ctx, original);
      signal.throwIfAborted();
      if (!member.ok) return reply(failure(member.code), member.status);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        return reply(failure('run-validation'), 415);
      const envelope = clientRequestSchema.safeParse(
        await readWorkbenchBody(
          request,
          { bodyBytes: HOST_RUN_BODY_BYTES, bodyTimeoutMs: 5000 },
          signal,
        ),
      );
      if (!envelope.success || envelope.data.method !== `zhuma-member/${endpoint}`)
        return reply(failure('run-validation'), 400);
      rpcId = envelope.data.rpcId;
      const source = current();
      if (!source) return reply(failure('run-authority-unavailable'), 503);
      const result = await source(original, envelope.data.payload, signal);
      signal.throwIfAborted();
      if (current() !== source) return reply(failure('run-authority-unavailable'), 503);
      return reply(result);
    } catch (error) {
      return reply(
        failure(error instanceof ExecutionRunError ? error.code : 'run-authority-unavailable'),
        error instanceof WorkbenchBodyError ? error.status : 200,
      );
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      await stop();
      await Promise.allSettled(active);
    })());
  ctx.effect(() => close);
  return { close };
}
