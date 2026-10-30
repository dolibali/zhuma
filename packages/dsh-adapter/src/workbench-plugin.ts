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
import { createHostRunSkillPolicies } from './host-run-skill-policy.js';
import { openHostTeamCatalog } from './host-team-catalog.js';
import {
  openMemberWorkbenchHttp,
  type MemberWorkbenchHttpHandle,
  type MemberWorkbenchMountOptions,
} from './member-workbench-http.js';
import { MemberAssetService } from './member-asset-service.js';
import { MemberWorkbenchService } from './member-workbench-service.js';
import { openExecutionMemberLease, resolveMember } from './member-session.js';
import { previewAssetImport } from './asset-import.js';
import { authorizeLegacyOwnerRoutes, LEGACY_OWNER_ROUTES } from './member-session.js';
import {
  WORKBENCH_HTTP_LIMITS,
  WorkbenchBodyError,
  readWorkbenchBody,
  type WorkbenchHttpLimits,
} from './workbench-http.js';

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
/**
 * The workbench domain spec, exported so the acceptance fixture can seed a
 * confirmed plan before the Host mounts. Seeding is a Host-level preparation
 * act, recorded as such; it never impersonates member creation.
 */
export const workbenchDomainSpec = {
  name: 'zhuma_workbench',
  version: 1,
  global: { schema: WorkbenchSchema, initial: emptyWorkbench() },
  tables: { planning: { valueSchema: AuditSchema } },
};
const domainSpec = workbenchDomainSpec;
const packageDomainSpec = {
  name: 'zhuma_asset_packages',
  version: 1,
  layout: 'per-record' as const,
  tables: { versions: { valueSchema: StoredAssetPackageSchema } },
};

export const inject = ['connection', 'storageDomain'];

/** SDK-normalized stable facts only. Never surface provider messages, endpoints
 * or request identities; this classification does not retry or change routing. */
function planningFailure(failure: { readonly code: string; readonly status?: number }) {
  const mapped: Record<string, readonly [string, string]> = {
    MISSING_CREDENTIAL: [
      'model-credentials-missing',
      '规划服务未配置所选模型的凭据，请检查当前服务的模型设置。',
    ],
    INVALID_CREDENTIAL: [
      'model-credentials-invalid',
      '所选模型的凭据格式无效，请联系管理员检查模型设置。',
    ],
    AUTH: ['model-access-denied', '模型服务拒绝了请求，请联系管理员检查凭据与访问权限。'],
    QUOTA: ['model-quota', '模型服务额度不足，请联系管理员检查账户额度。'],
    ACCOUNT_QUOTA: ['model-quota', '模型服务额度不足，请联系管理员检查账户额度。'],
    RATE_LIMIT: ['model-rate-limit', '模型服务请求过于频繁，请稍后再发起规划。'],
    TIMEOUT: ['model-timeout', '模型请求超时，请检查服务连接后再发起规划。'],
    TRANSPORT: ['model-connection', '无法连接模型服务，请联系管理员检查网络与服务连接。'],
    SERVER: ['model-service', '模型服务暂不可用，请稍后再发起规划。'],
    NO_ADAPTER: ['model-unavailable', '所选模型适配器不可用，请联系管理员检查模型设置。'],
    CONTEXT_WINDOW_EXCEEDED: [
      'model-context-limit',
      '任务材料超出模型容量，请缩小任务范围或减少材料。',
    ],
    INVALID_REQUEST: [
      'model-request-rejected',
      '模型服务不接受本次请求，请检查任务材料与所选模型设置。',
    ],
  };
  let value = Object.hasOwn(mapped, failure.code) ? mapped[failure.code] : undefined;
  const status = failure.status;
  if (!value && typeof status === 'number' && Number.isInteger(status)) {
    if (status === 401 || status === 403) value = mapped.AUTH;
    else if (status === 402) value = mapped.QUOTA;
    else if (status === 429) value = mapped.RATE_LIMIT;
    else if (status === 408 || status === 504) value = mapped.TIMEOUT;
    else if (status >= 500 && status <= 599) value = mapped.SERVER;
  }
  return new WorkbenchError(
    ...(value ??
      (['model-incomplete', '模型请求未正常结束，请检查模型连接或缩小任务后重试。'] as const)),
  );
}

/** Reading and manual editing do not require a configured model service. */
function planningModel(ctx: Context): PlanningModel | undefined {
  const llm = ctx.get('llm');
  const defaults = ctx.get('agentDefaultModel');
  if (!llm || !defaults) return undefined;
  let route: ReturnType<typeof defaults.currentSelection>;
  try {
    route = defaults.currentSelection();
  } catch {
    return undefined;
  }
  return {
    name: `${route.provider} / ${route.model}`,
    generate: async (system, input, abort) => {
      const call = await llm.prepareCall({ ...route, maxTokens: 12000 }, abort);
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
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error') throw planningFailure(chunk.reason.failure);
          stopped = chunk.reason.kind === 'stop';
        }
      }
      if (!stopped)
        throw new WorkbenchError(
          'model-incomplete',
          '模型请求未正常结束，请检查模型连接或缩小任务后重试。',
        );
      return text;
    },
  };
}

export interface OpenedWorkbench {
  openTeamCatalog(
    options: Pick<
      Parameters<typeof openHostTeamCatalog>[0],
      'grants' | 'directory' | 'initialize' | 'defaultForTeams'
    >,
  ): ReturnType<typeof openHostTeamCatalog>;
  createRunSkillPolicies(
    execution: Parameters<typeof createHostRunSkillPolicies>[0]['execution'],
  ): ReturnType<typeof createHostRunSkillPolicies>;
  readWorkbench(): ReturnType<WorkbenchService['snapshot']>;
  planningModel(): PlanningModel | undefined;
  /** Facade over this already-opened Workbench and the same member catalog. */
  openMemberAssets(
    ctx: Context,
    options: Omit<MemberWorkbenchMountOptions, 'workbench'>,
  ): MemberAssetService;
  openMemberWorkbench(
    ctx: Context,
    options: Omit<MemberWorkbenchMountOptions, 'workbench'>,
  ): MemberWorkbenchHttpHandle;
}

/** Loaded as an ordinary DSH Host/Client plugin; storage and transport remain DSH-owned. */
export async function openWorkbench(
  ctx: Context,
  limits: WorkbenchHttpLimits = WORKBENCH_HTTP_LIMITS,
  lifecycle: { beforeClose?(): Promise<void> } = {},
): Promise<OpenedWorkbench> {
  let service: WorkbenchService | undefined;
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  async function handle(endpoint: string, payload: unknown, callerSignal: AbortSignal) {
    const signal = AbortSignal.any([callerSignal, lifetime.signal, AbortSignal.timeout(120000)]);
    try {
      signal.throwIfAborted();
      const active = service;
      if (!active) throw new WorkbenchError('unavailable', '工作台尚未就绪。');
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
          return { ok: true, value: active.resourceFiles(input.kind, input.id) };
        }
        case 'snapshot': {
          z.strictObject({}).parse(payload);
          return {
            ok: true,
            value: {
              state: active.snapshot(),
              model: planningModel(ctx)?.name ?? '未配置模型',
            },
          };
        }
        case 'command':
          return { ok: true, value: await active.command(payload, signal) };
        case 'plan': {
          const model = planningModel(ctx);
          if (!model) throw new WorkbenchError('model-unavailable', '请先配置规划模型。');
          return { ok: true, value: await active.plan(payload, model, signal) };
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
  for (const endpoint of LEGACY_OWNER_ROUTES) {
    ctx.connection.fetch.register({
      path: `/api/zhuma/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const admission = authorizeLegacyOwnerRoutes(ctx);
        if (!admission.ok) return new Response(null, { status: admission.status });
        if (!service) return new Response(null, { status: 503 });
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
          return new Response(null, { status: 415 });
        let body: unknown;
        try {
          body = await readWorkbenchBody(request, limits);
        } catch (error) {
          return new Response(null, {
            status: error instanceof WorkbenchBodyError ? error.status : 400,
          });
        }
        const envelope = clientRequestSchema.safeParse(body);
        if (!envelope.success || envelope.data.method !== `zhuma/${endpoint}`)
          return new Response(null, { status: 400 });
        const result = await handle(endpoint, envelope.data.payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result });
      },
    });
  }
  const domain = await ctx.storageDomain.open(domainSpec);
  ctx.effect(
    () => async () => {
      try {
        await lifecycle.beforeClose?.();
      } finally {
        await domain.close();
      }
    },
    'zhuma-workbench.close',
  );
  const packageDomain = await ctx.storageDomain.open(packageDomainSpec);
  ctx.effect(() => async () => {
    try {
      await lifecycle.beforeClose?.();
    } finally {
      await packageDomain.close();
    }
  });
  lifetime.signal.throwIfAborted();
  service = new WorkbenchService(
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

  return {
    openTeamCatalog(options) {
      if (lifetime.signal.aborted || !service)
        throw new WorkbenchError('unavailable', '工作台已关闭。');
      const current = service;
      return openHostTeamCatalog({
        ...options,
        signal: lifetime.signal,
        readWorkbench: () => current.snapshot(),
        readPackage: (versionId) => packageDomain.table('versions').get(versionId),
        importPackage: (request) => current.command(request, lifetime.signal),
      });
    },
    createRunSkillPolicies(execution) {
      if (lifetime.signal.aborted || !service)
        throw new WorkbenchError('unavailable', '工作台已关闭。');
      const current = service;
      return createHostRunSkillPolicies({
        execution,
        signal: lifetime.signal,
        readWorkbench: () => current.snapshot(),
        // Host-only immutable table. The producer checks the original member
        // request and exact confirmed origin before reaching this closure.
        readPackage: (versionId) => packageDomain.table('versions').get(versionId),
      });
    },
    planningModel: () => {
      if (lifetime.signal.aborted) return undefined;
      return planningModel(ctx);
    },
    openMemberAssets: (memberCtx, options) => {
      if (lifetime.signal.aborted || !service)
        throw new WorkbenchError('unavailable', '工作台已关闭。');
      const original = service;
      return new MemberAssetService(original, {
        signal: lifetime.signal,
        memberLease: (request) => openExecutionMemberLease(memberCtx, request),
        directory: options.directory,
        ...(options.catalog ? { catalog: options.catalog } : {}),
        sources: async (request, input, signal) => {
          if (lifetime.signal.aborted || service !== original)
            throw new WorkbenchError('asset-unavailable', '资产服务暂不可用。');
          const member = new MemberWorkbenchService(original, {
            ...options,
            resolve: () => resolveMember(memberCtx, request),
          });
          return member.assetSources(input, signal);
        },
      });
    },
    openMemberWorkbench: (memberCtx, options) => {
      if (lifetime.signal.aborted || !service)
        throw new WorkbenchError('unavailable', '工作台已关闭。');
      return openMemberWorkbenchHttp(memberCtx, { ...options, workbench: service });
    },
    readWorkbench: () => {
      if (lifetime.signal.aborted || !service)
        throw new WorkbenchError('unavailable', '工作台已关闭。');
      return service.snapshot();
    },
  };
}

/** Internal compatibility entry; the distribution loads host-plugin's explicit composition. */
export async function apply(ctx: Context): Promise<void> {
  await openWorkbench(ctx);
}
