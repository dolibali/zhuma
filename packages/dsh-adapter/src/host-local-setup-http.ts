import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

export const localSetupPackIds = [
  'zhuma-work-planning',
  'zhuma-interaction-review',
  'zhuma-workflow-diagram',
  'zhuma-engineering-docs',
] as const;
export const hostLocalSetupInputSchema = z.strictObject({
  requestId: z.uuid(),
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/u),
  password: z.string().min(8).max(200),
  teamName: z.string().trim().min(1).max(160),
  packIds: z
    .array(z.enum(localSetupPackIds))
    .min(1)
    .max(4)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type HostLocalSetupInput = z.infer<typeof hostLocalSetupInputSchema>;
export interface HostLocalSetupSnapshot {
  readonly kind: 'unconfigured' | 'pending' | 'configured' | 'recovery-required';
  readonly requestId?: string;
  /** Only the matching successful initialization POST returns this live directory receipt. */
  readonly createdTeam?: { readonly id: string; readonly kind: 'team'; readonly name: string };
  readonly packs: readonly {
    readonly id: (typeof localSetupPackIds)[number];
    readonly version: '1.0.0';
    readonly name: string;
    readonly role: string;
  }[];
}
export interface HostLocalSetupOperations {
  status(): HostLocalSetupSnapshot;
  initialize(input: HostLocalSetupInput): Promise<HostLocalSetupSnapshot>;
}
export class HostLocalSetupError extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'recovery-required' | 'unavailable') {
    super('Local setup is unavailable.');
    this.name = 'HostLocalSetupError';
  }
}

/** Owner control plane only. The official Connection remains the transport fact owner. */
export function openHostLocalSetupHttp(
  ctx: Context,
  current: () => HostLocalSetupOperations | undefined,
) {
  const lifetime = new AbortController();
  const active = new Set<Promise<Response>>();
  const limits = { bodyBytes: 8192, bodyTimeoutMs: 10_000 };
  let closing: Promise<void> | undefined;
  const stops = (['status', 'initialize'] as const).map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-local-setup/${endpoint}`,
      methods: [endpoint === 'status' ? 'GET' : 'POST'],
      requestBody: endpoint === 'status' ? 'buffered' : 'streaming',
      fetch(request) {
        const work = handle(endpoint, request);
        active.add(work);
        void work.finally(() => active.delete(work)).catch(() => undefined);
        return work;
      },
    }),
  );
  function response(value: unknown, status = 200) {
    return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  }
  function failure(code: string, status: number) {
    return response(
      { version: 1, ok: false, error: { code, message: '首次设置尚未完成。' } },
      status,
    );
  }
  function admit(request: Request) {
    if (lifetime.signal.aborted) throw new HostLocalSetupError('unavailable');
    if (ctx.connection.requestRejection({ headers: request.headers })) return 403;
    const admission = ctx.connection.admit({ headers: request.headers });
    if ('rejection' in admission) return admission.rejection;
    return admission.peer.principal.kind === 'owner' ? undefined : 403;
  }
  async function handle(endpoint: 'status' | 'initialize', request: Request): Promise<Response> {
    try {
      const rejected = admit(request);
      if (rejected) return failure('untrusted-request', rejected);
      const source = current();
      if (!source) return failure('unavailable', 503);
      if (endpoint === 'status') return response({ version: 1, ok: true, value: source.status() });
      // Same-origin POST is required even if a future transport adapter relaxes its Origin policy.
      // The official HTTP bridge deliberately uses dsh.internal as Request.url.
      // Its already-validated Host header is the real authority, not that sentinel.
      const rawOrigin = request.headers.get('origin');
      let sameOrigin = false;
      if (rawOrigin) {
        try {
          const origin = new URL(rawOrigin);
          sameOrigin =
            ['http:', 'https:'].includes(origin.protocol) &&
            origin.origin === rawOrigin &&
            origin.host === request.headers.get('host');
        } catch {
          /* Invalid Origin remains rejected. */
        }
      }
      if (!sameOrigin) return failure('untrusted-request', 403);
      const signal = AbortSignal.any([lifetime.signal, request.signal]);
      const input = hostLocalSetupInputSchema.safeParse(
        await readWorkbenchBody(request, limits, signal),
      );
      if (!input.success) return failure('invalid-input', 400);
      signal.throwIfAborted();
      const second = admit(request);
      if (second) return failure('untrusted-request', second);
      if (current() !== source) return failure('unavailable', 503);
      // Once admitted the original initialization owner drains its durable operation.
      // Losing this HTTP reply cannot roll back account/directory/catalog writes.
      return response({ version: 1, ok: true, value: await source.initialize(input.data) });
    } catch (error) {
      if (error instanceof HostLocalSetupError)
        return failure(
          error.code,
          error.code === 'invalid-input' ? 400 : error.code === 'unavailable' ? 503 : 409,
        );
      if (error instanceof WorkbenchBodyError)
        return failure(
          error.status === 413
            ? 'body-too-large'
            : error.status === 408
              ? 'body-timeout'
              : 'invalid-input',
          error.status,
        );
      return failure('unavailable', 503);
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
