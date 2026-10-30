import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { CodeArtsMcpPolicy } from './policy.js';

const sessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9_-]{1,180}$/u);
export const codeArtsPermissionRuleSchema = z.strictObject({
  permission: z.string().min(1).max(200),
  pattern: z.string().min(1).max(4096),
  action: z.enum(['deny', 'ask', 'allow']),
});
export type CodeArtsPermissionRule = z.infer<typeof codeArtsPermissionRuleSchema>;
const sessionSchema = z.object({
  id: sessionIdSchema,
  directory: z.string(),
  title: z.string().optional(),
  permission: z.array(codeArtsPermissionRuleSchema).max(128).optional(),
});
export type CodeArtsSession = z.infer<typeof sessionSchema>;
const eventSchema = z.object({
  type: z.string().min(1).max(160),
  properties: z.record(z.string(), z.unknown()),
});
export type CodeArtsSessionEvent = z.infer<typeof eventSchema>;
type Failure =
  | 'invalid-endpoint'
  | 'invalid-session'
  | 'cancelled'
  | 'rejected'
  | 'unavailable'
  | 'dispatch-unknown'
  | 'invalid-response'
  | 'response-too-large';

/** No provider response, prompt, Basic credential or raw fetch cause in diagnostics. */
export class CodeArtsHttpError extends Error {
  constructor(
    readonly code: Failure,
    readonly httpStatus?: number,
  ) {
    super(`CodeArts HTTP ${code}`);
    this.name = 'CodeArtsHttpError';
  }
}

export interface CodeArtsHttpOptions {
  /** Owned server only. No external host, proxy, userinfo or URL path. */
  readonly origin: string;
  /** Generated for this owned process; never a model/provider credential. */
  readonly basicAuthorization: string;
  /** Caller supplies the canonical, already-authorized workspace. */
  readonly directory: string;
  readonly fetch?: typeof globalThis.fetch;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_CHARACTERS = 512 * 1024;
const ownRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function eventSession(event: CodeArtsSessionEvent): unknown {
  const props = event.properties;
  const ids: unknown[] = [];
  for (const record of [props, ownRecord(props.part), ownRecord(props.info)])
    if (record && Object.hasOwn(record, 'sessionID')) ids.push(record.sessionID);
  const info = ownRecord(props.info);
  if (event.type.startsWith('session.') && info && Object.hasOwn(info, 'id')) ids.push(info.id);
  if (ids.some((id) => !sessionIdSchema.safeParse(id).success || id !== ids[0]))
    throw new CodeArtsHttpError('invalid-response');
  return ids[0];
}

/** Internal transport only. Session metadata/SSE are not Run authority or completion. */
export class CodeArtsHttpClient {
  readonly #origin: string;
  readonly #authorization: string;
  readonly #directory: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #owned = new Set<string>();
  readonly #created = new Set<string>();
  readonly #permissions = new Map<string, string>();

  constructor(options: CodeArtsHttpOptions) {
    let url: URL;
    try {
      url = new URL(options.origin);
    } catch {
      throw new CodeArtsHttpError('invalid-endpoint');
    }
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.port === '0' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !/^Basic [A-Za-z0-9+/]+={0,2}$/u.test(options.basicAuthorization) ||
      !isAbsolute(options.directory)
    )
      throw new CodeArtsHttpError('invalid-endpoint');
    this.#origin = url.origin;
    this.#authorization = options.basicAuthorization;
    this.#directory = resolve(options.directory);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async health(signal: AbortSignal): Promise<{ readonly healthy: true; readonly version: string }> {
    return this.#parse(
      z.object({ healthy: z.literal(true), version: z.string().min(1).max(100) }),
      await this.#json('GET', '/global/health', signal, false),
    );
  }

  async createSession(input: {
    readonly title: string;
    readonly permission: readonly CodeArtsPermissionRule[];
    readonly signal: AbortSignal;
  }): Promise<CodeArtsSession> {
    const body = z
      .strictObject({
        title: z.string().min(1).max(1000),
        permission: z.array(codeArtsPermissionRuleSchema).min(1).max(128),
      })
      .safeParse({ title: input.title, permission: input.permission });
    if (!body.success) throw new CodeArtsHttpError('invalid-session');
    const session = this.#session(
      await this.#json('POST', '/session', input.signal, true, body.data),
    );
    // The echoed rules are a configuration fact, not proof that all native tools enforce them.
    if (JSON.stringify(session.permission) !== JSON.stringify(body.data.permission))
      throw new CodeArtsHttpError('invalid-response');
    this.#owned.add(session.id);
    this.#created.add(session.id);
    return session;
  }

  /** An explicit durable binding supplies the ID. Failure never creates a replacement. */
  async resumeSession(sessionId: string, signal: AbortSignal): Promise<CodeArtsSession> {
    const id = this.#id(sessionId);
    const session = this.#session(await this.#json('GET', `/session/${id}`, signal, true));
    if (session.id !== id) throw new CodeArtsHttpError('invalid-response');
    this.#owned.add(id);
    return session;
  }

  async messages(sessionId: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const id = this.#ownedId(sessionId);
    const value = await this.#json('GET', `/session/${id}/message`, signal, true);
    const rows = this.#parse(
      z
        .array(
          z
            .object({
              info: z.object({ id: z.string(), sessionID: sessionIdSchema }).passthrough(),
              parts: z.array(z.record(z.string(), z.unknown())),
            })
            .passthrough(),
        )
        .max(10_000),
      value,
    );
    if (
      rows.some(
        (row) => row.info.sessionID !== id || row.parts.some((part) => part.sessionID !== id),
      )
    )
      throw new CodeArtsHttpError('invalid-response');
    return rows;
  }

  /** A provider acknowledgement cannot certify physical process/tool drain. */
  async abort(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ readonly status: 'acknowledged' }> {
    const id = this.#ownedId(sessionId);
    if ((await this.#json('POST', `/session/${id}/abort`, signal, true)) !== true)
      throw new CodeArtsHttpError('invalid-response');
    return { status: 'acknowledged' };
  }

  /** One explicit dispatch; admission is not completion and unknown outcomes never replay. */
  async sendPrompt(
    sessionId: string,
    policy: CodeArtsMcpPolicy,
    text: string,
    signal: AbortSignal,
    model?: { readonly providerID: string; readonly modelID: string },
  ): Promise<void> {
    const id = this.#ownedId(sessionId);
    const response = await this.#request('POST', `/session/${id}/prompt_async`, signal, true, {
      agent: policy.agentName,
      // Replace persisted old bridge rules on an explicit send after resume.
      tools: policy.tools,
      ...(model === undefined ? {} : { model }),
      parts: [{ type: 'text', text }],
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new CodeArtsHttpError('dispatch-unknown');
  }

  /** Unexpected native/CodeArts approval cannot grant extra task capabilities. */
  async rejectPermission(sessionId: string, requestId: string, signal: AbortSignal): Promise<void> {
    const id = this.#ownedId(sessionId);
    if (this.#permissions.get(requestId) !== id) throw new CodeArtsHttpError('invalid-session');
    const accepted = await this.#json(
      'POST',
      `/permission/${encodeURIComponent(requestId)}/reply`,
      signal,
      true,
      {
        reply: 'reject',
      },
    );
    if (accepted !== true) throw new CodeArtsHttpError('dispatch-unknown');
    this.#permissions.delete(requestId);
  }

  /** Explicit cleanup of a newly created test/abandoned setup only; never deletes restored history. */
  async discardCreatedSession(sessionId: string, signal: AbortSignal): Promise<void> {
    const id = this.#ownedId(sessionId);
    if (!this.#created.has(id)) throw new CodeArtsHttpError('invalid-session');
    if ((await this.#json('DELETE', `/session/${id}`, signal, true)) !== true)
      throw new CodeArtsHttpError('invalid-response');
    this.#created.delete(id);
    this.#owned.delete(id);
  }

  async *events(
    sessionId: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<CodeArtsSessionEvent> {
    const id = this.#ownedId(sessionId);
    const response = await this.#request('GET', '/event', signal, true);
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new CodeArtsHttpError('invalid-response');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let data: string[] = [];
    let frameCharacters = 0;
    try {
      onOpen?.();
      for (;;) {
        const next = await reader.read();
        signal.throwIfAborted();
        text += decoder.decode(next.value, { stream: !next.done });
        let end: number;
        while ((end = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, end).replace(/\r$/u, '');
          text = text.slice(end + 1);
          frameCharacters += line.length;
          if (frameCharacters > MAX_EVENT_CHARACTERS)
            throw new CodeArtsHttpError('response-too-large');
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
          if (line !== '') continue;
          frameCharacters = 0;
          if (data.length === 0) continue;
          let raw: unknown;
          try {
            raw = JSON.parse(data.join('\n'));
          } catch {
            throw new CodeArtsHttpError('invalid-response');
          }
          data = [];
          const event = this.#parse(eventSchema, raw);
          if (eventSession(event) === id) {
            if (event.type === 'permission.asked') {
              const requestId = event.properties.id;
              if (
                typeof requestId !== 'string' ||
                !/^[A-Za-z0-9_-]{1,200}$/u.test(requestId) ||
                this.#permissions.size >= 64
              )
                throw new CodeArtsHttpError('invalid-response');
              this.#permissions.set(requestId, id);
            }
            yield event;
          }
          // Unscoped status/heartbeat and another session's data never enter a task stream.
        }
        if (text.length + frameCharacters > MAX_EVENT_CHARACTERS)
          throw new CodeArtsHttpError('response-too-large');
        if (next.done) {
          if (text || data.length) throw new CodeArtsHttpError('invalid-response');
          return;
        }
      }
    } catch (error) {
      if (error instanceof CodeArtsHttpError) throw error;
      throw new CodeArtsHttpError(signal.aborted ? 'cancelled' : 'unavailable');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  #id(value: string): string {
    const parsed = sessionIdSchema.safeParse(value);
    if (!parsed.success) throw new CodeArtsHttpError('invalid-session');
    return parsed.data;
  }
  #ownedId(value: string): string {
    const id = this.#id(value);
    if (!this.#owned.has(id)) throw new CodeArtsHttpError('invalid-session');
    return id;
  }
  #session(value: unknown): CodeArtsSession {
    const session = this.#parse(sessionSchema, value);
    if (session.directory !== this.#directory) throw new CodeArtsHttpError('invalid-response');
    return session;
  }
  #parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CodeArtsHttpError('invalid-response');
    return parsed.data;
  }
  async #json(
    method: string,
    path: string,
    signal: AbortSignal,
    scoped: boolean,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.#request(method, path, signal, scoped, body);
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new CodeArtsHttpError(method === 'GET' ? 'invalid-response' : 'dispatch-unknown');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new CodeArtsHttpError('response-too-large');
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof CodeArtsHttpError) throw error;
      throw new CodeArtsHttpError(method === 'GET' ? 'invalid-response' : 'dispatch-unknown');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async #request(
    method: string,
    path: string,
    signal: AbortSignal,
    scoped: boolean,
    body?: unknown,
  ): Promise<Response> {
    if (signal.aborted) throw new CodeArtsHttpError('cancelled');
    const query = scoped ? `?directory=${encodeURIComponent(this.#directory)}` : '';
    let response: Response;
    try {
      response = await this.#fetch(this.#origin + path + query, {
        method,
        signal,
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Authorization: this.#authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CodeArtsHttpError(
        method === 'GET' ? (signal.aborted ? 'cancelled' : 'unavailable') : 'dispatch-unknown',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CodeArtsHttpError(
        response.status >= 500 && method !== 'GET' ? 'dispatch-unknown' : 'rejected',
        response.status,
      );
    }
    return response;
  }
}
