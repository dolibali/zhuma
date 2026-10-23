import type { IncomingHttpHeaders } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { Workbench } from '@zhuma/agent-core';
import { WorkbenchError, type ExecutionNodeRecord } from '@zhuma/agent-core';
import { z } from 'zod';
import { ExecutionService, type ExecutionStorage, type PlanReceipt } from './execution-service.js';
import { resolveMember } from './member-session.js';
import type { ProjectSpaceDirectory } from './project-space.js';

const ENDPOINTS = [
  'start-plan',
  'inbox',
  'submit',
  'ballot',
  'settle',
  'report',
  'revision',
  'draft',
  'inbox-counts',
  'events',
] as const;

type Endpoint = (typeof ENDPOINTS)[number];

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item));
  if (typeof value === 'object') return Object.values(value).every((item) => isJson(item));
  return false;
}

function isNodeRecord(value: unknown): value is ExecutionNodeRecord {
  if (!isJson(value) || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const command = record.command;
  return (
    typeof record.taskId === 'string' &&
    typeof record.planId === 'string' &&
    typeof record.revision === 'number' &&
    typeof record.nodeId === 'string' &&
    (record.ownerId === null || typeof record.ownerId === 'string') &&
    record.handoff !== null &&
    typeof record.handoff === 'object' &&
    command !== null &&
    typeof command === 'object' &&
    !Array.isArray(command) &&
    typeof (command as { status?: unknown }).status === 'string' &&
    typeof (command as { version?: unknown }).version === 'number' &&
    Array.isArray(record.rounds) &&
    Array.isArray(record.artifactVersions) &&
    Array.isArray(record.comments) &&
    Array.isArray(record.receipts)
  );
}

const nodeSchema = z.custom<ExecutionNodeRecord>((value) => isNodeRecord(value));
const planSchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
});
const domainSpec = {
  name: 'zhuma_execution',
  version: 1,
  global: {
    schema: z.strictObject({ schemaVersion: z.literal(1) }),
    initial: { schemaVersion: 1 as const },
  },
  tables: {
    nodes: { valueSchema: nodeSchema },
    plans: { valueSchema: planSchema },
  },
};

export const inject = ['connection', 'storageDomain'] as const;

/** Reads the workbench A already opened. The member comes from `resolveMember`. */
export interface ExecutionPluginConfig {
  readWorkbench(): Workbench;
  /**
   * Injected by A's Host/space module. Omission rejects every project.
   * This plugin does not store the mapping or treat a project id as a space id.
   */
  readonly projectSpaces?: ProjectSpaceDirectory;
}

function fetchHeaders(request: Request): IncomingHttpHeaders {
  const headers: Record<string, string | string[]> = {};
  request.headers.forEach((value, key) => {
    const prior = headers[key];
    if (prior === undefined) headers[key] = value;
    else if (Array.isArray(prior)) prior.push(value);
    else headers[key] = [prior, value];
  });
  return headers;
}

function unavailable(aborted: boolean) {
  return {
    ok: false as const,
    error: {
      code: aborted ? 'cancelled' : 'unavailable',
      message: aborted ? '操作已取消。' : '服务暂不可用，请稍后重试。',
      details: {},
    },
  };
}

function run(
  service: ExecutionService,
  endpoint: Endpoint,
  member: Awaited<ReturnType<typeof resolveMember>>,
  payload: unknown,
) {
  const caller = { member };
  switch (endpoint) {
    case 'start-plan':
      return service.startPlan(caller, payload);
    case 'inbox':
      return service.inbox(caller, payload);
    case 'submit':
      return service.submit(caller, payload);
    case 'ballot':
      return service.ballot(caller, payload);
    case 'settle':
      return service.settle(caller, payload);
    case 'report':
      return service.report(caller, payload);
    case 'revision':
      return service.revision(caller, payload);
    case 'draft':
      return service.draft(caller, payload);
    case 'inbox-counts':
      return service.inboxCounts(caller, payload);
    case 'events':
      return service.events(caller, payload);
  }
}

/**
 * Host routes `/api/zhuma-exec/<endpoint>`.
 * `rpc.handle` drops request headers, so the member cookie never arrives.
 * `connection.fetch.register` keeps the Fetch request. Connection still admits
 * only an owner peer; `resolveMember` then reads the member cookie.
 */
export async function apply(ctx: Context, config: ExecutionPluginConfig): Promise<void> {
  if (typeof config?.readWorkbench !== 'function') {
    throw new WorkbenchError('unavailable', '执行插件需要读取已打开的工作台。');
  }
  const projectSpaces =
    typeof config.projectSpaces?.spaceForProject === 'function' ? config.projectSpaces : undefined;
  const domain = await ctx.storageDomain.open(domainSpec);
  ctx.effect(() => () => domain.close());
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  const nodes = domain.table('nodes');
  const plans = domain.table('plans');
  const storage: ExecutionStorage = {
    readNode: (key) => nodes.get(key),
    writeNode: (key, value) => nodes.put(key, value),
    listNodes: () => [...nodes.entries()].map(([, value]) => value),
    readPlan: (key) => plans.get(key),
    writePlan: (key, value: PlanReceipt) =>
      plans.put(key, { ...value, nodeIds: [...value.nodeIds] }),
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
  };
  const service = new ExecutionService(
    storage,
    { readWorkbench: () => config.readWorkbench() },
    projectSpaces,
  );
  const reconciled = await service.reconcile();
  if (!reconciled.ok) throw new WorkbenchError(reconciled.error.code, reconciled.error.message);
  const stops = ENDPOINTS.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-exec/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
          return new Response(null, { status: 415 });
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(null, { status: 400 });
        }
        const envelope = clientRequestSchema.safeParse(body);
        if (!envelope.success || envelope.data.method !== `zhuma-exec/${endpoint}`) {
          return new Response(null, { status: 400 });
        }
        const signal = AbortSignal.any([request.signal, lifetime.signal]);
        try {
          signal.throwIfAborted();
          const member = await resolveMember(ctx, { headers: fetchHeaders(request) });
          const result = await run(service, endpoint, member, envelope.data.payload);
          return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result });
        } catch {
          return Response.json({
            type: 'server-response',
            rpcId: envelope.data.rpcId,
            result: unavailable(signal.aborted),
          });
        }
      },
    }),
  );
  ctx.effect(() => () => {
    for (const stop of stops) void stop();
  });
}

export const executionEndpoints = ENDPOINTS;
