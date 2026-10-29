import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type { KnowledgeService } from './knowledge-service.js';
import { resolveMember } from './member-session.js';
import { registerProductFetch } from './member-web-transport.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

const knowledgeMethods = {
  libraries: 'libraries',
  list: 'list',
  search: 'search',
  read: 'read',
  drafts: 'drafts',
  draft: 'draft',
  'save-draft': 'saveDraft',
  'propose-draft': 'proposeDraft',
  publish: 'publish',
  'project-links': 'projectLinks',
  'save-project-links': 'saveProjectLinks',
} as const;
type Endpoint = keyof typeof knowledgeMethods;
export const knowledgeEndpoints = Object.keys(knowledgeMethods) as Endpoint[];

/** Exact member operations. Proposals use the same member/page-author authority;
 * Agent authorship is metadata, not evidence of a Run or permission to publish. */
export function openKnowledgeHttp(ctx: Context, current: () => KnowledgeService | undefined) {
  const lifetime = new AbortController();
  const pending = new Set<Promise<Response>>();
  let closing: Promise<void> | undefined;
  const stops = knowledgeEndpoints.map((endpoint) =>
    registerProductFetch(ctx, {
      path: `/api/zhuma-knowledge/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch(request) {
        const work = handle(endpoint, request);
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => undefined);
        return work;
      },
    }),
  );
  async function handle(endpoint: Endpoint, request: Request) {
    let rpcId = '';
    const reply = (result: unknown, status = 200) =>
      Response.json(
        { type: 'server-response', rpcId, result },
        { status, headers: { 'cache-control': 'no-store' } },
      );
    const fail = (code: string, status = 200) =>
      reply(
        { ok: false, error: { code, message: '知识操作未完成，请重新确认当前空间。' } },
        status,
      );
    try {
      if (lifetime.signal.aborted) return fail('unavailable', 503);
      const original = { headers: Object.fromEntries(request.headers) };
      const member = await resolveMember(ctx, original);
      if (!member.ok)
        return fail(
          member.code === 'untrusted-request' ? 'forbidden' : 'unauthenticated',
          member.status,
        );
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        return fail('invalid', 415);
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const envelope = clientRequestSchema.safeParse(
        await readWorkbenchBody(
          request,
          {
            bodyBytes:
              endpoint === 'save-draft' || endpoint === 'propose-draft' ? 1024 * 1024 : 16_384,
            bodyTimeoutMs: 10_000,
          },
          signal,
        ),
      );
      if (!envelope.success || envelope.data.method !== `zhuma-knowledge/${endpoint}`)
        return fail('invalid', 400);
      rpcId = envelope.data.rpcId;
      signal.throwIfAborted();
      const owner = current();
      return owner
        ? reply(await owner[knowledgeMethods[endpoint]](original, envelope.data.payload, signal))
        : fail('unavailable', 503);
    } catch (error) {
      if (error instanceof WorkbenchBodyError)
        return fail(
          error.status === 413 ? 'limit' : error.status === 408 ? 'cancelled' : 'invalid',
          error.status,
        );
      return fail(
        request.signal.aborted || lifetime.signal.aborted ? 'cancelled' : 'unavailable',
        503,
      );
    }
  }
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      await Promise.allSettled(stops.map((stop) => stop()));
      await Promise.allSettled(pending);
    })());
  ctx.effect(() => close);
  return { close };
}
