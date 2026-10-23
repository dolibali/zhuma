import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { z } from 'zod';
import {
  emptyWorkbench,
  WorkbenchSchema,
  WorkbenchError,
  PlanProposalSchema,
  StoredAssetPackageSchema,
  AssetImportError,
} from '@zhuma/agent-core';
import { WorkbenchService, type PlanningModel } from './workbench-service.js';
import { previewAssetImport } from './asset-import.js';

const AuditSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  taskId: z.string(),
  baseRevision: z.number().int(),
  model: z.string(),
  system: z.string(),
  attempts: z.array(z.object({ input: z.string(), output: z.string() })).max(2),
  status: z.enum(['started', 'completed', 'failed']),
  proposal: PlanProposalSchema.optional(),
});
const domainSpec = {
  name: 'zhuma_workbench',
  version: 1,
  global: { schema: WorkbenchSchema, initial: emptyWorkbench() },
  tables: { planning: { valueSchema: AuditSchema } },
};
const packageDomainSpec = {
  name: 'zhuma_asset_packages',
  version: 1,
  layout: 'per-record' as const,
  tables: { versions: { valueSchema: StoredAssetPackageSchema } },
};

export const inject = ['connection', 'storageDomain', 'llm', 'agentDefaultModel'];

/** Loaded as an ordinary DSH Host/Client plugin; storage and transport remain DSH-owned. */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(domainSpec);
  ctx.effect(() => () => domain.close());
  const packageDomain = await ctx.storageDomain.open(packageDomainSpec);
  ctx.effect(() => () => packageDomain.close());
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  const service = new WorkbenchService(
    { read: () => domain.global.get(), write: (value) => domain.global.set(value) },
    {
      get: (key) => domain.table('planning').get(key),
      put: async (audit) => {
        await domain.table('planning').put(audit.id, audit);
        // Keep the latest 100 planning records; no credentials or filesystem data are included.
        const entries = [...domain.table('planning').keys()];
        for (const key of entries.slice(0, Math.max(0, entries.length - 100)))
          await domain.table('planning').delete(key);
      },
    },
    {
      get: (id) => packageDomain.table('versions').get(id),
      put: (record) => packageDomain.table('versions').put(record.versionId, record),
    },
  );
  async function handle(endpoint: string, payload: unknown, callerSignal: AbortSignal) {
    const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(120000)]);
    try {
      signal.throwIfAborted();
      switch (endpoint) {
        case 'preview-import':
          return { ok: true, value: await previewAssetImport(payload, signal) };
        case 'resource-files': {
          const input = z
            .strictObject({
              kind: z.enum(['asset', 'expert']),
              id: z
                .string()
                .min(1)
                .max(100)
                .regex(/^[\w-]+$/u),
            })
            .parse(payload);
          return { ok: true, value: service.resourceFiles(input.kind, input.id) };
        }
        case 'snapshot': {
          z.strictObject({}).parse(payload);
          const selection = ctx.agentDefaultModel.currentSelection();
          return {
            ok: true,
            value: {
              state: service.snapshot(),
              model: `${selection.provider} / ${selection.model}`,
            },
          };
        }
        case 'command':
          return { ok: true, value: await service.command(payload, signal) };
        case 'plan': {
          const route = ctx.agentDefaultModel.currentSelection();
          const model: PlanningModel = {
            name: `${route.provider} / ${route.model}`,
            generate: async (system, input, abort) => {
              const call = await ctx.llm.prepareCall({ ...route, maxTokens: 12000 }, abort);
              let text = '';
              let stopped = false;
              for await (const chunk of call.stream({
                ...call.config,
                system,
                messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
                signal: abort,
              })) {
                abort.throwIfAborted();
                if (chunk.type === 'text-delta') text += chunk.text;
                if (text.length > 150000)
                  throw new WorkbenchError('output-limit', '模型输出过长，请缩小任务范围。');
                if (chunk.type === 'finish') stopped = chunk.reason.kind === 'stop';
              }
              if (!stopped)
                throw new WorkbenchError(
                  'model-incomplete',
                  '模型请求未正常结束，请检查模型连接或缩小任务后重试。',
                );
              return text;
            },
          };
          return { ok: true, value: await service.plan(payload, model, signal) };
        }
        default:
          throw new WorkbenchError('not-found', '不支持的工作台操作。');
      }
    } catch (error) {
      const code =
        error instanceof WorkbenchError
          ? error.code
          : error instanceof AssetImportError
            ? 'asset-import'
            : signal.aborted
              ? 'cancelled'
              : error instanceof z.ZodError
                ? 'validation'
                : 'unavailable';
      // Provider/IO exceptions can contain private paths or request headers. Do not forward them.
      const message =
        error instanceof WorkbenchError || error instanceof AssetImportError
          ? error.message
          : signal.aborted
            ? '操作已取消或超时，原工作流未被规划修改。'
            : error instanceof z.ZodError
              ? '提交的数据格式不正确。'
              : '服务暂不可用，请检查模型设置或本地存储后重试。';
      return { ok: false, error: { code, message, details: {} } };
    }
  }
  // Connection exact routes retain its Host/Origin and owner-only authentication.
  // /api's single RPC interceptor belongs to the official Typert gateway.
  for (const endpoint of ['snapshot', 'command', 'plan', 'preview-import', 'resource-files']) {
    ctx.connection.fetch.register({
      path: `/api/zhuma/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
          return new Response(null, { status: 415 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(null, { status: 400 });
        }
        const envelope = clientRequestSchema.safeParse(body);
        if (!envelope.success || envelope.data.method !== `zhuma/${endpoint}`)
          return new Response(null, { status: 400 });
        const result = await handle(endpoint, envelope.data.payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result });
      },
    });
  }
}
