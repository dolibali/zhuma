import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import {
  HostSharedBackend,
  SharedBackendError,
  sharedBackendRequestSchema,
  sharedBackendSelectionSchema,
} from './host-shared-backend.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

/** All three exact routes retain the ORIGINAL local Connection owner policy.
 * They are intentionally never registered as public member Web routes. */
export function mountHostSharedBackend(ctx: Context): void {
  ctx.plugin({
    name: 'zhuma-shared-backend-connection',
    inject: ['credentials', 'connection'],
    apply(child: Context) {
      const owner = new HostSharedBackend(child);
      const empty = z.strictObject({});
      for (const endpoint of ['status', 'select', 'request'] as const) {
        child.connection.fetch.register({
          path: `/api/zhuma-backend/${endpoint}`,
          methods: ['POST'],
          requestBody: 'streaming',
          async fetch(request) {
            if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
              return new Response(null, { status: 415 });
            let raw: unknown;
            try {
              raw = await readWorkbenchBody(request, {
                bodyBytes: 1200 * 1024,
                bodyTimeoutMs: 5000,
              });
            } catch (error) {
              return new Response(null, {
                status: error instanceof WorkbenchBodyError ? error.status : 400,
              });
            }
            const envelope = clientRequestSchema.safeParse(raw);
            if (!envelope.success || envelope.data.method !== `zhuma-backend/${endpoint}`)
              return new Response(null, { status: 400 });
            let result;
            try {
              const value =
                endpoint === 'status'
                  ? (empty.parse(envelope.data.payload), await owner.status())
                  : endpoint === 'select'
                    ? await owner.select(sharedBackendSelectionSchema.parse(envelope.data.payload))
                    : await owner.request(
                        sharedBackendRequestSchema.parse(envelope.data.payload),
                        request.signal,
                      );
              request.signal.throwIfAborted();
              result = { ok: true, value };
            } catch (error) {
              result = {
                ok: false,
                error: {
                  code:
                    error instanceof SharedBackendError
                      ? `backend-${error.code}`
                      : error instanceof z.ZodError
                        ? 'backend-invalid'
                        : 'backend-unavailable',
                  message: '共享服务暂不可用，请检查连接后重试。',
                  details: {},
                },
              };
            }
            return Response.json(
              { type: 'server-response', rpcId: envelope.data.rpcId, result },
              { headers: { 'cache-control': 'no-store' } },
            );
          },
        });
      }
      child.effect(() => () => owner.close());
    },
  });
}
