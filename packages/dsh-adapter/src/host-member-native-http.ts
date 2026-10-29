import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import type { openHostMemberNativeOwner } from './host-member-native-owner.js';
import { readWorkbenchBody } from './workbench-http.js';
import { HOST_RUN_BODY_BYTES } from './host-run-http.js';
import { hostRunStream } from './host-run-stream.js';
import type { openHostRunOwner } from './host-run-owner.js';
import type { HostSharedBackend } from './host-shared-backend.js';
import { conversationTarget } from './host-run-reader.js';

export type HostMemberNativeOwner = Awaited<ReturnType<typeof openHostMemberNativeOwner>>;
const endpoints = [
  'options',
  'begin',
  'read',
  'history',
  'inbox',
  'observe',
  'send',
  'stop',
  'lookup',
  'review-options',
  'review-start',
  'review-read',
  'review-stop',
  'review-session',
  'review-recover',
  'review-session-stop',
  'workflow-options',
  'workflow-read',
  'workflow-start',
  'workflow-resume',
  'workflow-stop',
] as const;
const payload = z.strictObject({
  connectionId: z.uuid().nullable(),
  actorId: z.string().min(1).max(200),
  spaceId: z.string().min(1).max(200),
  query: z.unknown(),
});
const failure = () => ({
  ok: false as const,
  error: {
    code: 'run-authority-unavailable',
    message: '本机 Agent 操作尚未确认，请刷新后重试。',
    details: {},
  },
});

/** Local SDK owner HTTP only. Never a member-Web route, raw Session RPC,
 * caller-selected backend URL or remotely supplied model credential carrier. */
export function openHostMemberNativeHttp(
  ctx: Context,
  current: () => HostMemberNativeOwner | undefined,
  local?: {
    source(): Awaited<ReturnType<typeof openHostRunOwner>> | undefined;
    backend(): HostSharedBackend | undefined;
  },
) {
  const lifetime = new AbortController(),
    jobs = new Set<Promise<unknown>>();
  const stops = endpoints.map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-member-native/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch(request) {
        const work = handle(endpoint, request);
        jobs.add(work);
        void work.finally(() => jobs.delete(work)).catch(() => undefined);
        return work;
      },
    }),
  );
  async function handle(endpoint: (typeof endpoints)[number], request: Request) {
    let rpcId = '';
    const signal = AbortSignal.any([lifetime.signal, request.signal]);
    const reply = (result: unknown, status = 200) =>
      Response.json(
        { type: 'server-response', rpcId, result },
        { status, headers: { 'cache-control': 'no-store' } },
      );
    try {
      const rejected = ctx.connection.requestRejection({ headers: request.headers });
      if (rejected) return reply(failure(), rejected);
      const admitted = ctx.connection.admit({ headers: request.headers });
      if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner')
        return reply(failure(), 403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        return reply(failure(), 415);
      const wire = clientRequestSchema.parse(
        await readWorkbenchBody(
          request,
          { bodyBytes: HOST_RUN_BODY_BYTES, bodyTimeoutMs: 5000 },
          signal,
        ),
      );
      if (wire.method !== `zhuma-member-native/${endpoint}`) return reply(failure(), 400);
      rpcId = wire.rpcId;
      const input = payload.parse(wire.payload),
        source = current();
      if (endpoint === 'lookup' && !source) {
        const original = local?.source(),
          backend = local?.backend();
        if (!original || !backend) return reply(failure(), 409);
        const selected = await backend.status();
        const { sessionId } = z
          .strictObject({ sessionId: z.string().min(1).max(200) })
          .parse(input.query);
        if (selected.origin !== null || selected.connectionId !== input.connectionId)
          return reply(failure(), 409);
        const found = await original.lookupNativeSession(sessionId);
        if (found === null) return reply({ ok: true, value: { kind: 'ordinary' } });
        if (found.role !== 'work' || found.binding.scope.actorId !== input.actorId)
          return reply(failure(), 403);
        const scope = found.binding.scope;
        const read = await original.operations.read(
          { headers: Object.fromEntries(request.headers) },
          {
            taskId: scope.taskId,
            planId: scope.planId,
            revision: scope.revision,
            nodeId: scope.nodeId,
            runId: scope.runId,
          },
          signal,
        );
        if (
          !read.ok ||
          !z.object({ native: z.object({ sessionId: z.literal(sessionId) }) }).safeParse(read.value)
            .success ||
          local?.source() !== original
        )
          return reply(failure(), 403);
        return reply({
          ok: true,
          value: { kind: 'task', target: conversationTarget(scope), sessionId },
        });
      }
      if (!source || input.connectionId !== source.connectionId || input.actorId !== source.actorId)
        return reply(failure(), 409);
      const query = input.query;
      if (query === null || typeof query !== 'object' || Array.isArray(query))
        return reply(failure(), 400);
      if ('spaceId' in query && query.spaceId !== input.spaceId) return reply(failure(), 400);
      const adapted = ['history', 'send', 'observe'].includes(endpoint)
        ? { spaceId: input.spaceId, query }
        : ['read', 'inbox'].includes(endpoint)
          ? { ...query, spaceId: input.spaceId }
          : query;
      if (endpoint === 'observe') {
        const stream = hostRunStream({
          rpcId,
          signal,
          observe: (sink, reading) =>
            source.observe(
              adapted,
              async (frame, authority) => {
                if (current() !== source) throw Error('Native owner changed');
                await sink(frame, authority);
              },
              reading,
            ),
          failure,
        });
        jobs.add(stream.drained);
        void stream.drained.finally(() => jobs.delete(stream.drained)).catch(() => undefined);
        return stream.response;
      }
      const value = await source.handle(endpoint, adapted, signal);
      signal.throwIfAborted();
      if (current() !== source) return reply(failure(), 409);
      return reply({ ok: true, value });
    } catch {
      return reply(failure());
    }
  }
  const close = async () => {
    lifetime.abort();
    await Promise.allSettled(stops.map((stop) => stop()));
    await Promise.allSettled([...jobs]);
  };
  ctx.effect(() => close);
  return { close };
}
