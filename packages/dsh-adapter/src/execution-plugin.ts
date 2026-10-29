import type { IncomingHttpHeaders } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { registerProductFetch } from './member-web-transport.js';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { Workbench } from '@zhuma/agent-core';
import { WorkbenchError, type ExecutionNodeRecord } from '@zhuma/agent-core';
import { z } from 'zod';
import {
  ExecutionService,
  type ExecutionStorage,
  type PlanReceipt,
  type ExecutionFileAuthority,
  type ExecutionFileAuthoritySource,
  type AuthorizedFileContent,
} from './execution-service.js';
import { openExecutionMemberLease, resolveMember, type MemberRequest } from './member-session.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import { spaceDirectoryFor } from './space-directory.js';
import type { MemberWorkbenchDirectory } from './member-workbench-dto.js';
import type { ProjectSpaceDirectory } from './project-space.js';
import { readExecutionRunState } from './execution-run-state.js';
import { executionRunGlobalSchema } from './execution-run-protocol.js';
import { executionPlanReceiptSchema } from './execution-workflow-contract.js';
import { workspaceApprovalStateSchema } from './execution-workspace-approval-contract.js';
import {
  ArtifactUploadError,
  openArtifactFileStore,
  type ArtifactFileStore,
} from './artifact-files.js';

const ENDPOINTS = [
  'start-plan',
  'inbox',
  'startable',
  'submit',
  'ballot',
  'settle',
  'report',
  'revision',
  'review-outcome',
  'draft',
  'upstream-content',
  'project-artifacts',
  'task-progress',
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

const nodeSchema = z.custom<ExecutionNodeRecord>((value) => {
  if (!isNodeRecord(value)) return false;
  try {
    readExecutionRunState(value);
    return true;
  } catch {
    return false;
  }
});
const planSchema = executionPlanReceiptSchema;
const domainSpec = {
  name: 'zhuma_execution',
  version: 1,
  global: {
    schema: executionRunGlobalSchema,
    initial: { schemaVersion: 1 as const },
  },
  tables: {
    nodes: { valueSchema: nodeSchema },
    plans: { valueSchema: planSchema },
    workspace_approvals: { valueSchema: workspaceApprovalStateSchema },
  },
};

export const inject = ['connection', 'storageDomain'] as const;

/** Reads the workbench A already opened. The member comes from `resolveMember`. */
export interface ExecutionPluginConfig {
  readWorkbench(): Workbench;
  /** Host-only live account/space facts, never a browser DTO or a cached roster. */
  memberDirectory?(): MemberWorkbenchDirectory | undefined;
  /**
   * Directory A injects at the Host. B delivers the formal catalog on #29.
   * Omission rejects every project. This plugin does not store the mapping
   * or treat a project id as a space id.
   */
  readonly projectSpaces?: ProjectSpaceDirectory;
  /** Host-only publication of this existing owner, never an RPC or a second service.
   * The disposer drains native work and commits cleanup before the execution domain closes.
   */
  publishRunService?(service: ExecutionService): void | (() => void | Promise<void>);
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

/** One request scope over the existing lease and the SAME live directory. */
async function openFileAuthority(
  ctx: Context,
  request: MemberRequest,
  signal: AbortSignal,
): Promise<ExecutionFileAuthority> {
  const original = await openExecutionMemberLease(ctx, request);
  const directory = spaceDirectoryFor(ctx);
  if (!directory || directory.signal.aborted) {
    original.release();
    throw new Error('Current file directory is unavailable.');
  }
  const changed = new AbortController();
  let bound: { projectId: string; spaceId: string } | undefined;
  let released = false;
  const assertProjectSpace = (projectId: string, spaceId: string) => {
    if (
      released ||
      changed.signal.aborted ||
      directory.signal.aborted ||
      spaceDirectoryFor(ctx) !== directory
    )
      throw new Error('Current file directory changed.');
    const current = directory.spaceForProjectNow(projectId);
    if (!current.ok || current.spaceId !== spaceId)
      throw new Error('Current file project changed.');
    if (bound && (bound.projectId !== projectId || bound.spaceId !== spaceId))
      throw new Error('A file request cannot change its project binding.');
    bound = { projectId, spaceId };
  };
  let stop: () => void;
  try {
    stop = ctx.on(
      'domain/changed',
      (event) => {
        if (event.domain !== 'zhuma_spaces' || event.table !== 'project_spaces' || !bound) return;
        try {
          assertProjectSpace(bound.projectId, bound.spaceId);
        } catch {
          changed.abort();
        }
      },
      { global: true },
    );
  } catch (error) {
    original.release();
    throw error;
  }
  return {
    lease: {
      memberId: original.memberId,
      expiresAt: original.expiresAt,
      signal: AbortSignal.any([signal, original.signal, directory.signal, changed.signal]),
      assertCurrent: (spaceId) => original.assertCurrent(spaceId),
      release() {
        if (released) return;
        released = true;
        stop();
        original.release();
        changed.abort();
      },
    },
    assertProjectSpace,
  };
}

/**
 * Transport cap for `/api/zhuma-exec`. It sits above the service contract so a
 * legal body is not refused here.
 * Submit text and ballot comments stop at 100_000 characters. A draft's text,
 * links, and file strings together stop at 262_144 characters. `JSON.stringify`
 * writes one character as at most 6 bytes (`\u00XX` for U+0000–U+001F).
 * 262_144 × 6 = 1_572_864. Two mebibytes cover that plus the RPC envelope
 * (`type`, `method`, `rpcId`, and field names). UTF-8's 4 bytes per character
 * (262_144 × 4 = 1_048_576) is inside the same cap.
 */
export const EXECUTION_BODY_BYTE_LIMIT = 2 * 1024 * 1024;
const MAX_BODY_BYTES = EXECUTION_BODY_BYTE_LIMIT;
const BODY_READ_MS = 5_000;

class BodyRejected extends Error {
  constructor(
    readonly status: 413 | 408,
    readonly code: 'body-too-large' | 'body-timeout',
  ) {
    super(code);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** return() cancels a pending read immediately, rather than queuing behind it. */
function streamBytes(body: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let ended = false;
  let pending = 0;
  let released = false;
  let cancelled: Promise<IteratorResult<Uint8Array>> | undefined;
  const release = () => {
    if (ended && pending === 0 && !released) {
      released = true;
      reader?.releaseLock();
    }
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (ended) return { done: true, value: undefined };
      reader ??= body.getReader();
      pending++;
      try {
        const chunk = await reader.read();
        if (chunk.done) ended = true;
        return chunk.done ? { done: true, value: undefined } : { done: false, value: chunk.value };
      } finally {
        pending--;
        release();
      }
    },
    return() {
      cancelled ??= (async () => {
        if (ended) return { done: true as const, value: undefined };
        ended = true;
        try {
          await reader?.cancel();
        } finally {
          release();
        }
        return { done: true as const, value: undefined };
      })();
      return cancelled;
    },
  };
}

/** Reads at most the transport limit for 5s; a declared oversize body is not pulled. */
async function readLimitedJson(request: Request, signal: AbortSignal): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new BodyRejected(413, 'body-too-large');
  }
  const body = request.body;
  if (body === null) throw new SyntaxError('empty body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), BODY_READ_MS);
  });
  const aborted = waitForAbort(signal).then(() => 'abort' as const);
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const read = reader.read();
      pending = read;
      const outcome = await Promise.race([
        read.then((value) => ({ kind: 'chunk' as const, value })),
        timedOut.then((kind) => ({ kind })),
        aborted.then((kind) => ({ kind })),
      ]);
      pending = undefined;
      if (outcome.kind === 'timeout') {
        void read.catch(() => undefined);
        throw new BodyRejected(408, 'body-timeout');
      }
      if (outcome.kind === 'abort') {
        void read.catch(() => undefined);
        throw new DOMException('aborted', 'AbortError');
      }
      if (outcome.value.done) break;
      total += outcome.value.value.byteLength;
      if (total > MAX_BODY_BYTES) throw new BodyRejected(413, 'body-too-large');
      chunks.push(outcome.value.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (pending !== undefined) void pending.catch(() => undefined);
    void reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  if (text.trim() === '') throw new SyntaxError('empty body');
  return JSON.parse(text) as unknown;
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

const FILE_RESPONSE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'same-origin',
};

function safeTextPreview(name: string, mediaType: string, bytes: Uint8Array): boolean {
  const type = mediaType.split(';')[0]?.trim().toLowerCase();
  if (
    ![
      'text/plain',
      'text/markdown',
      'application/json',
      'text/csv',
      'text/yaml',
      'application/yaml',
    ].includes(type ?? '') ||
    /\.(?:html?|svg|xml|m?js|cjs|pdf)$/iu.test(name) ||
    bytes.includes(0) ||
    bytes.includes(60)
  )
    return false;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < bytes.length; offset += 65536)
      decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true });
    decoder.decode();
    return true;
  } catch {
    return false;
  }
}

/** Integrity was checked completely before this body exists; hold its slot through backpressure. */
function fileResponse(content: AuthorizedFileContent): Response {
  content.check();
  if (content.info.request.mode === 'metadata') {
    try {
      return Response.json({ ok: true, value: content.info }, { headers: FILE_RESPONSE_HEADERS });
    } finally {
      content.release();
    }
  }
  const bytes = content.bytes;
  if (!bytes) {
    content.release();
    throw new Error('Verified file bytes are absent.');
  }
  const preview =
    content.info.request.mode === 'preview' &&
    safeTextPreview(content.info.name, content.info.mediaType, bytes);
  let offset = 0;
  let finished = false;
  let cancel: () => void = () => {};
  const finish = () => {
    if (finished) return;
    finished = true;
    content.signal.removeEventListener('abort', cancel);
    content.release();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      cancel = () => {
        controller.error(new DOMException('aborted', 'AbortError'));
        finish();
      };
      content.signal.addEventListener('abort', cancel, { once: true });
      if (content.signal.aborted) cancel();
    },
    pull(controller) {
      try {
        content.check();
        if (offset >= bytes.length) {
          controller.close();
          finish();
          return;
        }
        const next = Math.min(offset + 65536, bytes.length);
        // A queued socket tail must not retain the complete verified buffer.
        controller.enqueue(bytes.slice(offset, next));
        offset = next;
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
  const name = encodeURIComponent(content.info.name).replace(
    /['()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return new Response(body, {
    headers: {
      ...FILE_RESPONSE_HEADERS,
      'content-type': preview ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'content-disposition': `${preview ? 'inline' : 'attachment'}; filename="file"; filename*=UTF-8''${name}`,
      'content-length': String(bytes.length),
      'x-zhuma-file-context': encodeURIComponent(JSON.stringify(content.info.request)),
      'x-zhuma-file-sha256': content.info.sha256,
      'x-zhuma-file-upload-id': content.info.uploadId,
    },
  });
}

function run(
  service: ExecutionService,
  endpoint: Endpoint,
  member: Awaited<ReturnType<typeof resolveMember>>,
  payload: unknown,
  original: MemberRequest,
  fileAuthority?: ExecutionFileAuthoritySource,
) {
  const caller = { member };
  switch (endpoint) {
    case 'start-plan':
      return service.startPlan(caller, payload);
    case 'inbox':
      return service.inbox(caller, payload);
    case 'startable':
      return service.startable(caller, payload);
    case 'submit':
      return service.submit(caller, payload, fileAuthority);
    case 'ballot':
      return service.ballot(caller, payload);
    case 'settle':
      return service.settle(caller, payload);
    case 'report':
      return service.report(caller, payload);
    case 'revision':
      return service.revision(caller, payload);
    case 'review-outcome':
      return service.readReviewOutcome(original, payload);
    case 'upstream-content':
      return service.upstreamContent(caller, payload);
    case 'project-artifacts':
      return service.projectArtifacts(caller, payload, fileAuthority);
    case 'task-progress':
      return service.taskProgress(caller, payload, fileAuthority);
    case 'draft':
      return service.draft(caller, payload, fileAuthority);
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
  const lifetime = new AbortController();
  let mountedService: ExecutionService | undefined;
  let unpublish: void | (() => void | Promise<void>);
  let closing: Promise<void> | undefined;
  let fileOpening: Promise<ArtifactFileStore> | undefined;
  const bodyDrains = new Set<Promise<unknown>>();
  // Cordis unload runs independent effects in parallel. Reserve one close job,
  // even before service construction, so cleanup always precedes domain close.
  ctx.effect(() => () => {
    closing ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const release = async (work: () => unknown) => {
        try {
          await work();
        } catch (error) {
          failures.push(error);
        }
      };
      await release(() => {
        lifetime.abort();
        mountedService?.fenceRuns();
        mountedService?.sealUploads();
        mountedService?.sealFileReads();
      });
      await release(() => unpublish?.());
      await release(() => mountedService?.closeRuns());
      await release(() => mountedService?.closeUploads());
      await release(() => mountedService?.closeFileReads());
      await release(async () => {
        while (bodyDrains.size) await Promise.allSettled([...bodyDrains]);
      });
      await release(async () => (await fileOpening)?.close());
      await release(() => domain.close());
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Execution shutdown did not finish cleanly.');
    });
    return closing;
  });
  const nodes = domain.table('nodes');
  const plans = domain.table('plans');
  const workspaceApprovals = domain.table('workspace_approvals');
  if ([...workspaceApprovals.entries()].some(([key]) => key !== 'state'))
    throw new WorkbenchError('unavailable', '工作区授权存储不兼容。');
  const storage: ExecutionStorage = {
    readNode: (key) => nodes.get(key),
    writeNode: (key, value) => nodes.put(key, value),
    listNodes: () => [...nodes.entries()].map(([, value]) => value),
    readPlan: (key) => plans.get(key),
    writePlan: (key, value: PlanReceipt) =>
      plans.put(key, { ...value, nodeIds: [...value.nodeIds] }),
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
    readGlobal: () => domain.global.get(),
    writeGlobal: (next) => domain.global.set(next),
    workspaceApprovals: {
      read: () => workspaceApprovals.get('state'),
      write: (state) => workspaceApprovals.put('state', state),
    },
  };
  // The attachment service is mounted by the Host (A 装配); the metadata
  // ledger opens on this storage domain. Without either, uploads fail closed.
  const attachments = ctx.get?.('attachments') as
    import('@deepseek-ai/dsh-attachment').AttachmentStore | undefined;
  fileOpening = openArtifactFileStore(ctx);
  const fileStore = await fileOpening;
  ctx.fiber.assertActive();
  if (lifetime.signal.aborted) throw new Error('Execution plugin disposed during startup.');
  const service = new ExecutionService(
    storage,
    {
      readWorkbench: () => config.readWorkbench(),
      ...('memberDirectory' in config
        ? {
            memberDirectory: () => {
              if (typeof config.memberDirectory !== 'function')
                throw new WorkbenchError('unavailable', '成员目录暂不可用。');
              return config.memberDirectory();
            },
          }
        : {}),
    },
    projectSpaces,
    attachments,
    fileStore,
  );
  mountedService = service;
  const reconciled = await service.reconcile();
  ctx.fiber.assertActive();
  if (!reconciled.ok) throw new WorkbenchError(reconciled.error.code, reconciled.error.message);
  unpublish = config.publishRunService?.(service);
  const stops = ENDPOINTS.map((endpoint) =>
    registerProductFetch(ctx, {
      path: `/api/zhuma-exec/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const signal = AbortSignal.any([request.signal, lifetime.signal]);
        let rpcId = '';
        try {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const original = { headers: fetchHeaders(request) };
          const member = await resolveMember(ctx, original);
          if (!member.ok) {
            return Response.json(
              { ok: false, error: { code: member.code } },
              { status: member.status },
            );
          }
          if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
            return new Response(null, { status: 415 });
          }
          const body = await readLimitedJson(request, signal);
          const envelope = clientRequestSchema.safeParse(body);
          if (!envelope.success || envelope.data.method !== `zhuma-exec/${endpoint}`) {
            return new Response(null, { status: 400 });
          }
          rpcId = envelope.data.rpcId;
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const result = await run(service, endpoint, member, envelope.data.payload, original, () =>
            openFileAuthority(ctx, original, signal),
          );
          return Response.json({ type: 'server-response', rpcId, result });
        } catch (error) {
          if (error instanceof BodyRejected) {
            return Response.json(
              { ok: false, error: { code: error.code } },
              { status: error.status },
            );
          }
          if (signal.aborted) {
            return Response.json({
              type: 'server-response',
              rpcId,
              result: unavailable(true),
            });
          }
          if (rpcId === '') return new Response(null, { status: 400 });
          return Response.json({
            type: 'server-response',
            rpcId,
            result: unavailable(false),
          });
        }
      },
    }),
  );
  // Raw byte upload rides the same member gate but never enters the JSON
  // envelope: declarations ride headers, the body is the byte stream.
  const uploadStop = registerProductFetch(ctx, {
    path: '/api/zhuma-exec/upload-file',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async (request) => {
      let lease: ExecutionMemberLease | undefined;
      let data: AsyncIterableIterator<Uint8Array> | undefined;
      let signal = AbortSignal.any([request.signal, lifetime.signal]);
      try {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        const original = { headers: fetchHeaders(request) };
        const member = await resolveMember(ctx, original);
        if (!member.ok) {
          return Response.json(
            { ok: false, error: { code: member.code } },
            { status: member.status },
          );
        }
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') {
          return new Response(null, { status: 415 });
        }
        const headers = request.headers;
        const declaredBytes = Number(headers.get('x-zhuma-file-size') ?? '');
        const revision = Number(headers.get('x-zhuma-revision') ?? '');
        if (
          !Number.isSafeInteger(declaredBytes) ||
          declaredBytes < 0 ||
          !Number.isSafeInteger(revision) ||
          revision <= 0
        ) {
          return Response.json({ ok: false, error: { code: 'validation' } }, { status: 400 });
        }
        // The name header is ASCII-safe: clients percent-encode UTF-8, the
        // service strictly decodes. A bad encoding refuses, never garbles.
        const rawName = headers.get('x-zhuma-file-name') ?? '';
        let decodedName = '';
        try {
          decodedName = decodeURIComponent(rawName);
        } catch {
          return Response.json({ ok: false, error: { code: 'validation' } }, { status: 400 });
        }
        const required = {
          name: decodedName,
          mediaType: headers.get('x-zhuma-file-type') ?? '',
          sha256: headers.get('x-zhuma-file-sha256') ?? '',
          spaceId: headers.get('x-zhuma-space') ?? '',
          taskId: headers.get('x-zhuma-task') ?? '',
          planId: headers.get('x-zhuma-plan') ?? '',
          nodeId: headers.get('x-zhuma-node') ?? '',
          idempotencyKey: headers.get('x-zhuma-idempotency-key') ?? '',
        };
        if (Object.values(required).some((value) => value.trim() === '')) {
          return Response.json({ ok: false, error: { code: 'validation' } }, { status: 400 });
        }
        const body = request.body;
        if (body === null) return new Response(null, { status: 400 });
        const authority = await openFileAuthority(ctx, original, signal);
        lease = authority.lease;
        signal = AbortSignal.any([signal, lease.signal]);
        data = streamBytes(body);
        const result = await service.uploadFile(
          { member },
          {
            declare: {
              name: required.name,
              mediaType: required.mediaType,
              byteSize: declaredBytes,
              sha256: required.sha256,
            },
            taskId: required.taskId,
            planId: required.planId,
            revision,
            nodeId: required.nodeId,
            spaceId: required.spaceId,
            idempotencyKey: required.idempotencyKey,
            data,
            signal,
          },
          authority,
        );
        return Response.json({
          ok: result.ok,
          ...(result.ok ? { value: result.value } : { error: result.error }),
        });
      } catch (error) {
        if (error instanceof BodyRejected) {
          return Response.json(
            { ok: false, error: { code: error.code } },
            { status: error.status },
          );
        }
        if (signal.aborted) {
          return Response.json({ ok: false, error: { code: 'cancelled' } });
        }
        return Response.json({ ok: false, error: { code: 'unavailable' } });
      } finally {
        lease?.release();
        // An unread request remains owned by the official HTTP bridge, which
        // closes its carrier after sending this refusal. Only cancel a reader
        // this route actually opened; cancelling an unopened toWeb bridge can
        // race its scheduled IncomingMessage data event on Node 24.
        const cleanup = data?.return?.();
        if (cleanup) {
          bodyDrains.add(cleanup);
          void cleanup.then(
            () => bodyDrains.delete(cleanup),
            () => bodyDrains.delete(cleanup),
          );
        }
      }
    },
  });
  stops.push(uploadStop);

  stops.push(
    registerProductFetch(ctx, {
      path: '/api/zhuma-exec/file',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const signal = AbortSignal.any([request.signal, lifetime.signal]);
        let opened: AuthorizedFileContent | undefined;
        let transferred = false;
        try {
          const original = { headers: fetchHeaders(request) };
          const member = await resolveMember(ctx, original);
          if (!member.ok)
            return Response.json(
              { ok: false, error: { code: member.code } },
              { status: member.status, headers: FILE_RESPONSE_HEADERS },
            );
          const query: Record<string, unknown> = Object.create(null);
          for (const [key, value] of new URL(request.url).searchParams) {
            if (Object.hasOwn(query, key))
              return Response.json(
                { ok: false, error: { code: 'validation' } },
                { status: 400, headers: FILE_RESPONSE_HEADERS },
              );
            query[key] = key === 'revision' ? Number(value) : value;
          }
          const result = await service.fileContent({ member }, query, () =>
            openFileAuthority(ctx, original, signal),
          );
          if (!result.ok)
            return Response.json(result, {
              status:
                result.error.code === 'not-found'
                  ? 404
                  : ['validation', 'unknown-field'].includes(result.error.code)
                    ? 400
                    : result.error.code === 'unauthenticated'
                      ? 401
                      : 409,
              headers: FILE_RESPONSE_HEADERS,
            });
          opened = result.value;
          const response = fileResponse(opened);
          transferred = true;
          return response;
        } catch (error) {
          const code =
            error instanceof ArtifactUploadError
              ? error.code
              : signal.aborted
                ? 'cancelled'
                : 'unavailable';
          return Response.json(
            { ok: false, error: { code } },
            { status: code === 'not-found' ? 404 : 409, headers: FILE_RESPONSE_HEADERS },
          );
        } finally {
          if (!transferred) opened?.release();
        }
      },
    }),
  );

  ctx.effect(() => () => {
    for (const stop of stops) void stop();
  });
}

export const executionEndpoints = ENDPOINTS;
