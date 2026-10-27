import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { resolveMember, type MemberRequest } from './member-session.js';
import type { HostWorkspaceApprovalOperations } from './host-workspace-approvals.js';
import {
  readWorkbenchBody,
  WorkbenchBodyError,
  type WorkbenchHttpLimits,
} from './workbench-http.js';

export const hostWorkspaceApprovalEndpoints = ['options', 'approve', 'revoke'] as const;
/** Same-origin SDK owner control plane plus the original product member. The
 * private D owner/qualification/snapshot never crosses this transport. */
export function openHostWorkspaceApprovalHttp(
  ctx: Context,
  options: {
    current(): HostWorkspaceApprovalOperations | undefined;
    readonly limits: WorkbenchHttpLimits;
  },
) {
  const lifetime = new AbortController();
  const limits = { ...options.limits, bodyBytes: Math.min(options.limits.bodyBytes, 16_384) };
  const active = new Set<Promise<Response>>();
  let closing: Promise<void> | undefined;
  const stops = hostWorkspaceApprovalEndpoints.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-workspaces/${endpoint}`,
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
  async function handle(
    endpoint: (typeof hostWorkspaceApprovalEndpoints)[number],
    request: Request,
  ): Promise<Response> {
    let rpcId = '';
    const reply = (result: unknown, status = 200) =>
      Response.json(
        { type: 'server-response', rpcId, result },
        {
          status,
          headers: { 'cache-control': 'no-store' },
        },
      );
    const failure = (code: string, status: number) =>
      reply(
        { ok: false, error: { code, message: '工作目录授权操作未完成。', details: {} } },
        status,
      );
    const assertOwner = () => {
      if (lifetime.signal.aborted) return 503;
      if (ctx.connection.requestRejection({ headers: request.headers })) return 403;
      const admission = ctx.connection.admit({ headers: request.headers });
      if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return 403;
      const raw = request.headers.get('origin');
      if (!raw) return 403;
      try {
        const origin = new URL(raw);
        if (
          !['http:', 'https:'].includes(origin.protocol) ||
          origin.origin !== raw ||
          origin.host !== request.headers.get('host')
        )
          return 403;
      } catch {
        return 403;
      }
      return undefined;
    };
    try {
      const rejected = assertOwner();
      if (rejected) return failure('workspace-owner-required', rejected);
      const original: MemberRequest = { headers: Object.fromEntries(request.headers) };
      const member = await resolveMember(ctx, original);
      if (!member.ok) return failure(member.code, member.status);
      const wait = AbortSignal.any([lifetime.signal, request.signal]);
      const body = clientRequestSchema.safeParse(await readWorkbenchBody(request, limits, wait));
      if (!body.success || body.data.method !== `zhuma-workspaces/${endpoint}`)
        return failure('invalid-request', 400);
      rpcId = body.data.rpcId;
      wait.throwIfAborted();
      const second = assertOwner();
      if (second) return failure('workspace-owner-required', second);
      const owner = options.current();
      if (!owner) return failure('workspace-source-unavailable', 503);
      return reply(await owner[endpoint](original, body.data.payload, wait));
    } catch (error) {
      if (error instanceof WorkbenchBodyError)
        return failure(
          error.status === 413
            ? 'body-too-large'
            : error.status === 408
              ? 'body-timeout'
              : 'invalid-request',
          error.status,
        );
      return failure('workspace-source-unavailable', 503);
    }
  }
  return {
    close(): Promise<void> {
      if (closing) return closing;
      lifetime.abort();
      for (const stop of stops) stop();
      return (closing = (async () => {
        while (active.size) await Promise.allSettled([...active]);
      })());
    },
  };
}
