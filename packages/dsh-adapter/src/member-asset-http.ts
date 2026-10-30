import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import {
  MemberAssetCommandSchema,
  MemberAssetErrorCodeSchema,
  MemberAssetLegacySourceSchema,
  MemberAssetListQuerySchema,
  MemberAssetReadQuerySchema,
  MemberAssetReferenceSchema,
  TeamAssetCatalogQuerySchema,
  type MemberAssetErrorCode,
} from '@zhuma/agent-core';
import type { MemberAssetService } from './member-asset-service.js';
import type { TeamAssetCatalogService } from './team-asset-catalog.js';
import { resolveMember } from './member-session.js';
import { registerProductFetch } from './member-web-transport.js';
import {
  readWorkbenchBody,
  WORKBENCH_HTTP_LIMITS,
  WorkbenchBodyError,
  type WorkbenchHttpLimits,
} from './workbench-http.js';

export const MEMBER_ASSET_ENDPOINTS = [
  'asset-list',
  'asset-read',
  'asset-reference',
  'asset-command',
  'asset-sources',
  'asset-source',
  'asset-catalog',
] as const;
export interface MemberAssetHttpSources {
  readonly assets: MemberAssetService;
  readonly catalog: TeamAssetCatalogService;
}
const messages: Record<MemberAssetErrorCode, string> = {
  'asset-unavailable': '资产服务暂不可用，请稍后重试。',
  'asset-not-found': '找不到该资产或固定版本。',
  'asset-forbidden': '当前账号没有此资产的操作权限。',
  'asset-conflict': '资产已更新，请重新读取后再试。',
  'asset-request-reused': '此请求已用于其他内容，请核对原操作结果。',
  'asset-quota': '资产或操作已达到容量限制。',
  'asset-invalid': '提交的数据不完整，请检查后再试。',
  'asset-dependency-required': '请明确选择有权使用的固定依赖版本。',
  'asset-reference-denied': '当前不能引用此资产或依赖版本。',
  'asset-upload-pending': '该资产已有上传正在处理，请等待结束。',
  'asset-file-invalid': '文件长度、摘要或固定引用校验失败。',
  'asset-cancelled': '操作已取消或超时，请刷新核对原结果。',
};
function errorStatus(code: MemberAssetErrorCode) {
  return code === 'asset-not-found'
    ? 404
    : ['asset-forbidden', 'asset-reference-denied'].includes(code)
      ? 403
      : [
            'asset-conflict',
            'asset-request-reused',
            'asset-upload-pending',
            'asset-dependency-required',
          ].includes(code)
        ? 409
        : code === 'asset-quota'
          ? 413
          : code === 'asset-cancelled'
            ? 408
            : code === 'asset-unavailable'
              ? 503
              : 400;
}

/** Normal member metadata routes. Byte upload/read remain E's original routes;
 * this transport never opens a database or infers an actor from request JSON. */
export function openMemberAssetHttp(
  ctx: Context,
  current: () => MemberAssetHttpSources | undefined,
  limits: WorkbenchHttpLimits = WORKBENCH_HTTP_LIMITS,
) {
  const lifetime = new AbortController();
  const active = new Set<Promise<Response>>();
  const stops: (() => Promise<void>)[] = [];
  let closed = false,
    closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    lifetime.abort();
    return (closing = (async () => {
      const results = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
      while (active.size) await Promise.allSettled([...active]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Asset metadata transport close failed.');
    })());
  };
  ctx.effect(() => close);
  try {
    for (const endpoint of MEMBER_ASSET_ENDPOINTS) {
      stops.push(
        registerProductFetch(ctx, {
          path: `/api/zhuma-member/${endpoint}`,
          methods: ['POST'],
          requestBody: 'streaming',
          fetch(request) {
            if (closed) return Promise.resolve(new Response(null, { status: 503 }));
            const operation = Promise.resolve().then(() => handle(endpoint, request));
            active.add(operation);
            void operation.then(
              () => active.delete(operation),
              () => active.delete(operation),
            );
            return operation;
          },
        }),
      );
    }
  } catch (error) {
    void close().catch(() => undefined);
    throw error;
  }
  async function handle(endpoint: (typeof MEMBER_ASSET_ENDPOINTS)[number], request: Request) {
    const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(120_000)]);
    const original = { headers: Object.fromEntries(request.headers.entries()) };
    let rpcId: string | undefined;
    try {
      signal.throwIfAborted();
      const member = await resolveMember(ctx, original);
      signal.throwIfAborted();
      if (!member.ok)
        return Response.json(
          { ok: false, error: { code: member.code } },
          { status: member.status },
        );
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        return new Response(null, { status: 415 });
      const source = current();
      const check = () => {
        signal.throwIfAborted();
        const next = current();
        if (closed || !source || next?.assets !== source.assets || next?.catalog !== source.catalog)
          throw Object.assign(new Error('Asset owner unavailable'), { code: 'asset-unavailable' });
      };
      check();
      const body = await readWorkbenchBody(new Request(request, { signal }), limits);
      check();
      const envelope = clientRequestSchema.safeParse(body);
      if (!envelope.success || envelope.data.method !== `zhuma-member/${endpoint}`)
        return new Response(null, { status: 400 });
      rpcId = envelope.data.rpcId;
      const raw = envelope.data.payload;
      const value = await (async () => {
        switch (endpoint) {
          case 'asset-list':
            return source!.assets.list(original, MemberAssetListQuerySchema.parse(raw), signal);
          case 'asset-read':
            return source!.assets.read(original, MemberAssetReadQuerySchema.parse(raw), signal);
          case 'asset-reference':
            return source!.assets.reference(
              original,
              MemberAssetReferenceSchema.parse(raw),
              signal,
            );
          case 'asset-command':
            return source!.assets.command(original, MemberAssetCommandSchema.parse(raw), signal);
          case 'asset-source':
            return source!.assets.source(
              original,
              MemberAssetLegacySourceSchema.parse(raw),
              signal,
            );
          case 'asset-sources':
            return source!.assets.sources(
              original,
              MemberAssetListQuerySchema.pick({ spaceId: true }).parse(raw),
              signal,
            );
          case 'asset-catalog':
            return source!.catalog.list(original, TeamAssetCatalogQuerySchema.parse(raw), signal);
        }
      })();
      check();
      return Response.json(
        { type: 'server-response', rpcId, result: { ok: true, value } },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (error) {
      if (error instanceof WorkbenchBodyError) return new Response(null, { status: error.status });
      const candidate = MemberAssetErrorCodeSchema.safeParse(
        error && typeof error === 'object' && 'code' in error ? error.code : undefined,
      );
      const code = signal.aborted
        ? 'asset-cancelled'
        : candidate.success
          ? candidate.data
          : error instanceof z.ZodError
            ? 'asset-invalid'
            : 'asset-unavailable';
      if (!rpcId) return new Response(null, { status: errorStatus(code) });
      return Response.json(
        {
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code, message: messages[code] } },
        },
        {
          status: errorStatus(code),
          headers: { 'cache-control': 'no-store' },
        },
      );
    }
  }
  return { close };
}
