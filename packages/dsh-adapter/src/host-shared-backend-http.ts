import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import {
  HostSharedBackend,
  SharedBackendError,
  sharedBackendRequestSchema,
  sharedBackendSelectionSchema,
  SHARED_BACKEND_BODY_BYTE_LIMIT,
} from './host-shared-backend.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';
import { MEMBER_ASSET_IMPORT_LIMITS } from '@zhuma/agent-core';

/** Exact routes retain the ORIGINAL local Connection owner policy.
 * They are intentionally never registered as public member Web routes. */
export function mountHostSharedBackend(
  ctx: Context,
  lifecycle?: {
    publish(owner: HostSharedBackend): void | (() => void);
    selection: NonNullable<Parameters<HostSharedBackend['select']>[1]>;
  },
) {
  return ctx.plugin({
    name: 'zhuma-shared-backend-connection',
    inject: ['credentials', 'connection'],
    apply(child: Context) {
      const owner = new HostSharedBackend(child);
      const unpublish = lifecycle?.publish(owner);
      if (unpublish) child.effect(() => unpublish);
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
                bodyBytes: SHARED_BACKEND_BODY_BYTE_LIMIT,
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
                    ? await owner.select(
                        sharedBackendSelectionSchema.parse(envelope.data.payload),
                        lifecycle?.selection,
                      )
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
      // Only these two original static-import operations use the 8MiB local
      // owner Fetch lane. They never enter the generic Gateway JSON carrier.
      for (const endpoint of ['asset-preview-import', 'asset-import-drafts'] as const) {
        child.connection.fetch.register({
          path: `/api/zhuma-backend/${endpoint}`,
          methods: ['POST'],
          requestBody: 'streaming',
          async fetch(request) {
            const rejected = child.connection.requestRejection({ headers: request.headers });
            if (rejected) return new Response(null, { status: rejected });
            const admitted = child.connection.admit({ headers: request.headers });
            if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner')
              return new Response(null, { status: 403 });
            if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
              return new Response(null, { status: 415 });
            try {
              const connectionId = z
                .uuid()
                .parse(request.headers.get('x-zhuma-backend-connection'));
              const envelope = clientRequestSchema.parse(
                await readWorkbenchBody(request, {
                  bodyBytes: MEMBER_ASSET_IMPORT_LIMITS.requestBytes,
                  bodyTimeoutMs: 10000,
                }),
              );
              if (envelope.method !== `zhuma-member/${endpoint}`)
                return new Response(null, { status: 400 });
              const currentRejection = child.connection.requestRejection({
                headers: request.headers,
              });
              if (currentRejection) return new Response(null, { status: currentRejection });
              const currentAdmission = child.connection.admit({ headers: request.headers });
              if (
                'rejection' in currentAdmission ||
                currentAdmission.peer.principal.kind !== 'owner'
              )
                return new Response(null, { status: 403 });
              const value = await owner.request(
                {
                  connectionId,
                  operation: `member.${endpoint}`,
                  rpcId: envelope.rpcId,
                  payload: envelope.payload,
                },
                request.signal,
              );
              request.signal.throwIfAborted();
              return Response.json(value.body, {
                status: value.status,
                headers: {
                  'cache-control': 'no-store',
                  'x-zhuma-backend-connection': value.connectionId,
                },
              });
            } catch (error) {
              return new Response(null, {
                status:
                  error instanceof WorkbenchBodyError
                    ? error.status
                    : error instanceof z.ZodError
                      ? 400
                      : 409,
                headers: { 'cache-control': 'no-store' },
              });
            }
          },
        });
      }
      for (const endpoint of [
        'file',
        'upload-file',
        'asset-file-read',
        'asset-file-upload',
      ] as const) {
        child.connection.fetch.register({
          path: `/api/zhuma-backend/${endpoint}`,
          methods: ['POST'],
          requestBody: 'streaming',
          async fetch(request) {
            const rejected = child.connection.requestRejection({ headers: request.headers });
            if (rejected) return new Response(null, { status: rejected });
            const admitted = child.connection.admit({ headers: request.headers });
            if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner')
              return new Response(null, { status: 403 });
            try {
              return await owner.file(endpoint, request);
            } catch (error) {
              return Response.json(
                {
                  ok: false,
                  error: { code: error instanceof z.ZodError ? 'validation' : 'unavailable' },
                },
                {
                  status: error instanceof z.ZodError ? 400 : 409,
                  headers: { 'cache-control': 'no-store' },
                },
              );
            }
          },
        });
      }
      child.effect(() => () => owner.close());
    },
  });
}
