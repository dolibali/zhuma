import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nativeWorkResultIntentSchema } from './native-work-session-result-intent.js';
import type { NativeConversationSession } from './native-work-session-conversation-contract.js';
import {
  NativeWorkError,
  type NativeWorkScope,
  type NativeSessionSelection,
  type NativeSessionBinding,
  type NativeSessionLineage,
  type NativeWorkSessionRecord,
} from './native-work-session-contract.js';

export const NATIVE_LINEAGE_LIMITS = Object.freeze({ segments: 64, bytes: 2 * 1024 * 1024 });
const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeScopeSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
  generation: positive,
  segmentId: id,
});
export const nativeSelectionSchema = z.strictObject({
  provider: id,
  model: id,
  reasoningEffort: id.optional(),
  maxTokens: positive.max(65_536),
  configurationId: id,
});
/** Legacy bytes remain unchanged without the optional versioned result metadata. */
export const nativeWorkSessionBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: nativeScopeSchema,
  nativeSessionId: id,
  nativeAgentId: id,
  selection: nativeSelectionSchema,
  receipts: z
    .array(
      z.strictObject({
        requestId: id,
        messageId: id,
        fingerprint: digest,
        mode: z.enum(['followup', 'steer', 'queue']),
        status: z.enum(['reserved', 'received', 'claimed', 'discarded', 'unknown']),
      }),
    )
    .max(256),
  inputReadBudget: z
    .strictObject({
      attempts: z.number().int().min(0).max(16),
      chargedBytes: z.number().int().min(0).max(65_536),
    })
    .optional(),
  resultIntent: nativeWorkResultIntentSchema.optional(),
});

export function nativeWorkSessionKey(scope: NativeWorkScope): string {
  return JSON.stringify([
    scope.actorId,
    scope.spaceId,
    scope.taskId,
    scope.planId,
    scope.revision,
    scope.nodeId,
  ]);
}
export const nativeScopeKey = (scope: NativeWorkScope) =>
  JSON.stringify([nativeWorkSessionKey(scope), scope.runId, scope.generation, scope.segmentId]);
export function migrationFingerprint(
  previous: NativeWorkScope,
  next: NativeWorkScope,
  selection: NativeSessionSelection,
  inputFingerprint: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        nativeScopeKey(previous),
        nativeScopeKey(next),
        [
          selection.provider,
          selection.model,
          selection.reasoningEffort ?? null,
          selection.maxTokens,
          selection.configurationId,
        ],
        inputFingerprint,
      ]),
    )
    .digest('hex');
}
export function validMigrationPair(previous: NativeWorkScope, next: NativeWorkScope): boolean {
  return (
    nativeWorkSessionKey(previous) === nativeWorkSessionKey(next) &&
    previous.runId !== next.runId &&
    previous.segmentId !== next.segmentId &&
    next.generation > previous.generation
  );
}
export const nativeMigrationDataSchema = z.strictObject({
  requestId: id,
  inputFingerprint: digest,
  previousScope: nativeScopeSchema,
  scope: nativeScopeSchema,
  selection: nativeSelectionSchema,
});

export const nativeConversationPrefixSchema = z.strictObject({
  asOfSeq: z.number().int().min(-1).refine(Number.isSafeInteger),
  eventCount: z.number().int().min(0).max(10_000),
  inheritedEventCount: z.number().int().min(0).refine(Number.isSafeInteger),
  headerDigest: digest,
  eventsDigest: digest,
});
const conversationSessionSchema = z
  .strictObject({
    origin: nativeWorkSessionBindingSchema.pick({
      scope: true,
      nativeSessionId: true,
      nativeAgentId: true,
      selection: true,
    }),
    prefix: nativeConversationPrefixSchema,
    chatEpoch: positive,
    actorId: id,
    backendId: id,
    phase: z.enum(['reserved', 'active', 'retiring', 'settled', 'unknown']),
    receipts: z
      .array(
        z.strictObject({
          requestId: id,
          messageId: id,
          fingerprint: digest,
          mode: z.literal('followup'),
          status: z.enum(['reserved', 'received', 'claimed', 'discarded', 'unknown']),
          actorId: id,
          backendId: id,
          chatEpoch: positive,
        }),
      )
      .max(256),
  })
  .superRefine((value, context) => {
    const keys = value.receipts.map((r) => JSON.stringify([r.actorId, r.backendId, r.requestId]));
    if (
      new Set(keys).size !== keys.length ||
      value.receipts.some((r) => r.chatEpoch > value.chatEpoch)
    )
      context.addIssue({ code: 'custom', message: 'Invalid conversation receipts.' });
  });
const conversationMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sessions: z.array(conversationSessionSchema).min(1).max(NATIVE_LINEAGE_LIMITS.segments),
  })
  .superRefine((value, context) => {
    if (new Set(value.sessions.map((s) => s.origin.nativeSessionId)).size !== value.sessions.length)
      context.addIssue({ code: 'custom', message: 'Duplicate conversation Session.' });
  });

const lineageSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    version: positive.max(NATIVE_LINEAGE_LIMITS.segments),
    current: nativeWorkSessionBindingSchema,
    prior: z
      .array(
        z.strictObject({
          binding: nativeWorkSessionBindingSchema,
          migration: z.strictObject({
            requestId: id,
            inputFingerprint: digest,
            fingerprint: digest,
          }),
        }),
      )
      .min(1)
      .max(NATIVE_LINEAGE_LIMITS.segments - 1),
  })
  .superRefine((record, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'binding-state-invalid' });
    if (record.version !== record.prior.length + 1) fail();
    const all = [...record.prior.map((entry) => entry.binding), record.current];
    if (all.some((binding) => binding.nativeSessionId !== binding.nativeAgentId)) fail();
    for (const field of ['nativeSessionId', 'nativeAgentId'] as const)
      if (new Set(all.map((binding) => binding[field])).size !== all.length) fail();
    for (const field of ['runId', 'segmentId'] as const)
      if (new Set(all.map((binding) => binding.scope[field])).size !== all.length) fail();
    if (
      new Set(record.prior.map((entry) => entry.migration.requestId)).size !== record.prior.length
    )
      fail();
    record.prior.forEach((entry, index) => {
      const next = all[index + 1]!;
      if (
        !validMigrationPair(entry.binding.scope, next.scope) ||
        entry.migration.fingerprint !==
          migrationFingerprint(
            entry.binding.scope,
            next.scope,
            next.selection,
            entry.migration.inputFingerprint,
          )
      )
        fail();
    });
  });
export const nativeWorkSessionRecordSchema = z
  .union([
    nativeWorkSessionBindingSchema.extend({ conversation: conversationMetadataSchema.optional() }),
    lineageSchema.safeExtend({ conversation: conversationMetadataSchema.optional() }),
  ])
  .superRefine((record, ctx) => {
    if (Buffer.byteLength(JSON.stringify(record)) > NATIVE_LINEAGE_LIMITS.bytes)
      ctx.addIssue({ code: 'custom', message: 'binding-state-invalid' });
    const bindings =
      record.schemaVersion === 1
        ? [record]
        : [record.current, ...record.prior.map((r) => r.binding)];
    for (const chat of record.conversation?.sessions ?? []) {
      const origin = bindings.find((b) => b.nativeSessionId === chat.origin.nativeSessionId);
      if (
        !origin ||
        nativeScopeKey(origin.scope) !== nativeScopeKey(chat.origin.scope) ||
        origin.nativeAgentId !== chat.origin.nativeAgentId ||
        JSON.stringify(origin.selection) !== JSON.stringify(chat.origin.selection) ||
        (origin.resultIntent?.cut && origin.resultIntent.cut.asOfSeq !== chat.prefix.asOfSeq)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid conversation origin.' });
    }
  });
export function readNativeRecord(value: unknown): NativeWorkSessionRecord {
  const parsed = nativeWorkSessionRecordSchema.safeParse(value);
  if (!parsed.success) throw new NativeWorkError('binding-state-invalid');
  return parsed.data;
}
export const currentBinding = (record: NativeWorkSessionRecord): NativeSessionBinding => {
  if (record.schemaVersion === 2) return record.current;
  if (!record.conversation) return record;
  const { conversation: _conversation, ...binding } = record;
  return binding;
};
export function preserveNativeConversation(
  previous: NativeWorkSessionRecord,
  next: NativeWorkSessionRecord,
): NativeWorkSessionRecord {
  return previous.conversation ? { ...next, conversation: previous.conversation } : next;
}
export function nativeConversationSession(
  record: NativeWorkSessionRecord,
  sessionId: string,
): NativeConversationSession | undefined {
  return record.conversation?.sessions.find((entry) => entry.origin.nativeSessionId === sessionId);
}
export const previousBindings = (record: NativeWorkSessionRecord): NativeSessionLineage['prior'] =>
  record.schemaVersion === 1 ? [] : record.prior;
export function bindingForScope(
  record: NativeWorkSessionRecord,
  scope: NativeWorkScope,
): NativeSessionBinding | undefined {
  const all = [currentBinding(record), ...previousBindings(record).map((entry) => entry.binding)];
  return all.find((binding) => nativeScopeKey(binding.scope) === nativeScopeKey(scope));
}
