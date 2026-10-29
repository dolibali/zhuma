import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  KnowledgeErrorCodeSchema,
  KnowledgeLibrarySchema,
  KnowledgeReadRequestSchema,
  KnowledgeReadValueSchema,
  KnowledgeSaveDraftRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchValueSchema,
  KnowledgeWriteValueSchema,
  remoteRunScopeSchema,
  type KnowledgeErrorCode,
  type KnowledgeLibrary,
} from '@zhuma/agent-core';
import type { HostSharedBackend } from './host-shared-backend.js';
import type { MemberKnowledgeToolPorts } from './member-knowledge-tool.js';
import type { NativeWorkScope } from './native-work-session-contract.js';

export interface HostMemberKnowledgePortOptions {
  readonly backend: Pick<HostSharedBackend, 'request'>;
  readonly connectionId: string;
  readonly scope: NativeWorkScope;
  readonly library: KnowledgeLibrary;
  readonly allowDrafts: boolean;
  /** Original Host/Run admission and live consent check, never model supplied. */
  assertCurrent(signal: AbortSignal): void | Promise<void>;
}
const requestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('search'), payload: KnowledgeSearchRequestSchema }),
  z.strictObject({ action: z.literal('read'), payload: KnowledgeReadRequestSchema }),
  z.strictObject({ action: z.literal('propose-draft'), payload: KnowledgeSaveDraftRequestSchema }),
]);
const envelopeSchema = z.strictObject({
  type: z.literal('server-response'),
  rpcId: z.uuid(),
  result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), value: z.unknown() }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({ code: KnowledgeErrorCodeSchema, message: z.string() }),
    }),
  ]),
});
const failure = (code: KnowledgeErrorCode) => ({
  ok: false as const,
  error: { code, message: '知识操作尚未确认，请核对当前运行与空间。' },
});

/** One private transport closure. It owns no library, Run or retry facts and
 * performs no I/O at construction. Membership/author permission stays in the
 * original backend and exact knowledge routes on every invocation. */
export function createHostMemberKnowledgePort(
  options: HostMemberKnowledgePortOptions,
): MemberKnowledgeToolPorts {
  const connectionId = z.uuid().parse(options.connectionId);
  const scope = Object.freeze(remoteRunScopeSchema.omit({ backendId: true }).parse(options.scope));
  const library = Object.freeze(KnowledgeLibrarySchema.parse(options.library));
  const allowDrafts = z.boolean().parse(options.allowDrafts);
  if (
    library.spaceId !== scope.spaceId ||
    typeof options.backend?.request !== 'function' ||
    typeof options.assertCurrent !== 'function'
  )
    throw new TypeError('Invalid private knowledge port');
  const request = options.backend.request.bind(options.backend);
  const assertCurrent = options.assertCurrent;
  async function gate(signal: AbortSignal) {
    signal.throwIfAborted();
    await assertCurrent(signal);
    signal.throwIfAborted();
  }
  const sameLibrary = (ref: { spaceId: string; libraryId: string }) =>
    ref.spaceId === scope.spaceId && ref.libraryId === library.id;
  return Object.freeze<MemberKnowledgeToolPorts>({
    catalog: Object.freeze({ scope, library }),
    allowDrafts,
    assertCurrent: gate,
    async invoke(raw, signal) {
      try {
        await gate(signal);
        const parsed = requestSchema.safeParse(raw);
        if (!parsed.success) return failure('invalid');
        const input = parsed.data;
        if (
          input.payload.spaceId !== scope.spaceId ||
          (input.action === 'search'
            ? input.payload.libraryIds.length !== 1 || input.payload.libraryIds[0] !== library.id
            : input.payload.libraryId !== library.id)
        )
          return failure('forbidden');
        if (input.action === 'read' && !input.payload.checksum) return failure('invalid');
        if (
          input.action === 'propose-draft' &&
          (!allowDrafts || input.payload.content.sources.some((ref) => !sameLibrary(ref)))
        )
          return failure('forbidden');
        const rpcId = randomUUID();
        // Await the actual tracked source. An aborted caller must not release
        // the tool's reservation while an uncooperative request still settles.
        const response = await request(
          { connectionId, operation: `knowledge.${input.action}`, rpcId, payload: input.payload },
          signal,
        );
        await gate(signal);
        if (response.connectionId !== connectionId || response.status !== 200)
          return failure('unavailable');
        const envelope = envelopeSchema.parse(response.body);
        if (envelope.rpcId !== rpcId) return failure('unavailable');
        if (!envelope.result.ok) return envelope.result;
        const result = envelope.result.value;
        if (input.action === 'search') {
          const value = KnowledgeSearchValueSchema.parse(result);
          if (
            value.actorId !== scope.actorId ||
            value.spaceId !== scope.spaceId ||
            value.libraryIds.length !== 1 ||
            value.libraryIds[0] !== library.id ||
            value.query !== input.payload.query ||
            value.hits.length > input.payload.limit ||
            value.hits.some(({ reference }) => !sameLibrary(reference))
          )
            return failure('unavailable');
          return { ok: true, value };
        }
        if (input.action === 'read') {
          const value = KnowledgeReadValueSchema.parse(result);
          if (
            value.actorId !== scope.actorId ||
            !sameLibrary(value.reference) ||
            value.spaceId !== scope.spaceId ||
            value.reference.pageId !== input.payload.pageId ||
            value.reference.version !== input.payload.version ||
            value.reference.checksum !== input.payload.checksum ||
            value.part !== input.payload.part ||
            value.offset !== input.payload.offset ||
            value.length > input.payload.length ||
            value.length !== Buffer.byteLength(value.text) ||
            value.nextOffset !== value.offset + value.length ||
            value.nextOffset > value.totalBytes ||
            value.sources.some((ref) => !sameLibrary(ref))
          )
            return failure('unavailable');
          return { ok: true, value };
        }
        const value = KnowledgeWriteValueSchema.parse(result);
        if (
          value.actorId !== scope.actorId ||
          value.spaceId !== scope.spaceId ||
          value.libraryId !== library.id ||
          value.pageId !== input.payload.pageId ||
          value.operation !== 'save-draft' ||
          !['saved', 'replayed'].includes(value.disposition) ||
          value.reference !== undefined
        )
          return failure('unavailable');
        return { ok: true, value };
      } catch {
        // A write may already be durable. No retry, new key, rollback or empty
        // version is inferred from a lost reply or caller cancellation.
        return failure(signal.aborted ? 'cancelled' : 'unavailable');
      }
    },
  });
}
