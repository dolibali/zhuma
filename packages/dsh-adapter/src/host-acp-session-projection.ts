import { z } from 'zod';
import type { NativeSessionAdmissionSource } from './host-session-admission.js';

// Adapter boundary for the fixed 28ccc674 plugin's contract/remote.ts. These
// schemas validate its existing result, not a second source of session facts.
const text = z.string().max(16_384);
const sessionId = z.string().min(1).max(256);
const timestamp = z.number().finite().nonnegative();
const capabilities = z.strictObject({
  loadSession: z.boolean(),
  sessionList: z.boolean(),
  sessionClose: z.boolean(),
  sessionDelete: z.boolean(),
  promptImage: z.boolean(),
  promptAudio: z.boolean(),
  promptEmbeddedContext: z.boolean(),
  mcpHttp: z.boolean(),
  mcpSse: z.boolean(),
});
const cleanupState = z.enum(['done', 'not-advertised', 'failed']);
const probe = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('never'), at: z.null() }),
  z.strictObject({
    status: z.literal('ok'),
    at: timestamp,
    modelCount: z.number().int().nonnegative(),
    authMethods: z
      .array(
        z.strictObject({
          id: text,
          name: text,
          description: text.nullable().optional(),
        }),
      )
      .max(128)
      .nullable(),
    agentInfo: z.strictObject({ name: text, version: text }).nullable(),
    capabilities: capabilities.nullable(),
    cleanup: z
      .strictObject({ close: cleanupState, delete: cleanupState, message: text.nullable() })
      .nullable(),
    capabilityHash: text.nullable(),
    protocolVersion: z.number().int().nonnegative().nullable(),
    versionCompatibility: z.enum(['current', 'different', 'unknown']).nullable(),
    matrix: z
      .array(
        z.strictObject({
          id: text,
          advertised: z.boolean().nullable(),
          adapterPath: text,
          hostSeam: text.nullable(),
          status: z.enum(['supported', 'degraded', 'unsupported']),
          note: text.optional(),
        }),
      )
      .max(128),
  }),
  z.strictObject({
    status: z.literal('error'),
    at: timestamp,
    failureKind: text,
    message: text,
    phase: z.enum(['initialize', 'session']).nullable(),
  }),
]);
const provider = z.strictObject({
  id: z
    .string()
    .max(196)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: text,
  command: text,
  args: z.array(text).max(256),
  loginHint: text.nullable(),
  executable: z.boolean(),
  version: text.nullable(),
  state: z.enum(['saved-unverified', 'ready', 'auth-required', 'unavailable', 'incompatible']),
  probe,
});
const health = z.strictObject({
  providers: z.array(provider).max(128),
  liveSessions: z
    .array(
      z.strictObject({
        sessionId,
        continuity: z.strictObject({
          status: z.enum(['ok', 'blocked']),
          cause: text.nullable(),
          detail: text.nullable(),
        }),
      }),
    )
    .max(4096)
    .nullable(),
});
const children = z.strictObject({ sessionIds: z.array(sessionId).max(4096) });
const unavailable = () => new Error('Session catalog projection is unavailable.');

/** Capture current() before invoking the Remote. It is checked before dispatch,
 * after every original lookup, and before publishing a fresh result object. */
export function prepareHostAcpSessionProjection(
  method: string,
  source: NativeSessionAdmissionSource,
  assertCurrent: () => void,
  signal: AbortSignal,
) {
  if (method !== 'health' && method !== 'projectedSubagentIds') throw unavailable();
  function current() {
    signal.throwIfAborted();
    assertCurrent();
  }
  async function ordinary(id: string) {
    current();
    let binding: object | null;
    try {
      binding = await source.lookupNativeSession(id);
    } catch {
      current();
      throw unavailable();
    }
    current();
    if (binding === null) return true;
    if (typeof binding !== 'object' || Array.isArray(binding)) throw unavailable();
    return false;
  }
  current();
  return {
    assertCurrent: current,
    async project(value: unknown): Promise<unknown> {
      current();
      try {
        // The fixed plugin returns JSON only. Bound allocation before cloning;
        // neither the source data nor its unknown fields are edited in place.
        if (JSON.stringify(value).length > 1_048_576) throw unavailable();
        if (method === 'health') {
          const parsed = health.parse(value);
          if (new Set(parsed.providers.map((row) => row.id)).size !== parsed.providers.length)
            throw unavailable();
          if (parsed.liveSessions === null) {
            current();
            return parsed;
          }
          const kept: NonNullable<typeof parsed.liveSessions> = [];
          const seen = new Set<string>();
          for (const row of parsed.liveSessions) {
            if (seen.has(row.sessionId)) throw unavailable();
            seen.add(row.sessionId);
            if (await ordinary(row.sessionId)) kept.push(row);
          }
          current();
          return { providers: parsed.providers, liveSessions: kept };
        }
        const parsed = children.parse(value);
        const kept: string[] = [];
        const seen = new Set<string>();
        for (const id of parsed.sessionIds) {
          if (seen.has(id)) throw unavailable();
          seen.add(id);
          if (await ordinary(id)) kept.push(id);
        }
        current();
        return { sessionIds: kept };
      } catch {
        current();
        throw unavailable();
      }
    },
  };
}
