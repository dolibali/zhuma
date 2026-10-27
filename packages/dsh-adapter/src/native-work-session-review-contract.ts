import { createHash } from 'node:crypto';
import { z } from 'zod';
import { REVIEW_ACTIONS, canonicalPayload } from '@zhuma/agent-core';
import {
  executionReviewBindingSchema,
  executionReviewScopeSchema,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import {
  NATIVE_LINEAGE_LIMITS,
  currentBinding,
  previousBindings,
  nativeScopeSchema,
  nativeWorkSessionKey,
  nativeWorkSessionRecordSchema,
} from './native-work-session-record.js';
import {
  NATIVE_RESULT_LIMITS,
  nativeResultCutSchema,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';

export const NATIVE_REVIEW_TOOL = 'complete_review';
export const NATIVE_REVIEW_TOOL_VERSION = 'zhuma-native-review-intent@1';
export const NATIVE_REVIEW_READ_TOOL = 'read_review_target';
export const NATIVE_REVIEW_READ_TOOL_VERSION = 'zhuma-native-review-read@1';
export const NATIVE_REVIEW_LIMITS = Object.freeze({
  rationaleCharacters: NATIVE_RESULT_LIMITS.textCharacters,
  argumentBytes: 120_000,
  publicFrameBytes: 262_144,
  frameEnvelopeBytes: 16_384,
  anchors: 50,
  reads: 16,
  readBytes: 65_536,
  pageBytes: 8_192,
  outputBytes: 24_576,
  resources: 64,
  readers: NATIVE_RESULT_LIMITS.readers,
  readTimeoutMs: 5_000,
  waitMs: NATIVE_RESULT_LIMITS.waitMs,
  scanBytes: NATIVE_RESULT_LIMITS.scanBytes,
});
export const NATIVE_REVIEW_ERRORS = [
  'invalid-arguments',
  'review-unavailable',
  'review-authority-denied',
  'review-target-changed',
  'review-read-required',
  'review-read-mismatch',
  'review-range-invalid',
  'review-unsupported-material',
  'review-input-pending',
  'review-result-rejected',
  'review-capacity',
  'review-read-budget-exceeded',
  'read-timeout',
  'output-too-large',
  'cancelled',
] as const;
export type NativeReviewErrorCode = (typeof NATIVE_REVIEW_ERRORS)[number];
export class NativeReviewError extends Error {
  constructor(readonly code: NativeReviewErrorCode) {
    super('独立评审原生操作未完成。');
    this.name = 'NativeReviewError';
  }
}
const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const readRef = z.string().regex(/^review_read_[a-f0-9]{64}$/u);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

/** Data, not a grant. actorId is the actual human controller of this review Run. */
export const nativeReviewContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    role: z.literal('review'),
    scope: nativeScopeSchema,
    review: executionReviewBindingSchema,
  })
  .refine(
    ({ scope, review }) => executionReviewScopeSchema.safeParse({ ...scope, review }).success,
  );
export type NativeReviewContext = z.infer<typeof nativeReviewContextSchema>;
/** Data projection only. The original live review grant is still required. */
export function nativeReviewContextFromScope(raw: ExecutionReviewScope): NativeReviewContext {
  const { review, ...scope } = executionReviewScopeSchema.parse(raw);
  return nativeReviewContextSchema.parse({ schemaVersion: 1, role: 'review', scope, review });
}

/** The legacy author key is neither changed nor reused for a review lane. */
export function nativeReviewSessionKey(raw: NativeReviewContext): string {
  const { scope, review } = nativeReviewContextSchema.parse(raw);
  return JSON.stringify([
    'review',
    1,
    [scope.actorId, scope.spaceId, scope.taskId, scope.planId, scope.revision, scope.nodeId],
    review,
  ]);
}
export function nativeReviewScopeKey(raw: NativeReviewContext): string {
  const context = nativeReviewContextSchema.parse(raw);
  const { scope } = context;
  return JSON.stringify([
    nativeReviewSessionKey(context),
    scope.runId,
    scope.generation,
    scope.segmentId,
  ]);
}

export const nativeReviewReadRequestSchema = z
  .strictObject({
    resourceRef: id,
    offset: natural,
    length: natural.min(1).max(NATIVE_REVIEW_LIMITS.pageBytes),
  })
  .refine((value) => Number.isSafeInteger(value.offset + value.length));
export const nativeReviewAnchorSchema = z
  .strictObject({
    resourceRef: id,
    offset: natural,
    length: natural.min(1).max(NATIVE_REVIEW_LIMITS.readBytes),
  })
  .refine((value) => Number.isSafeInteger(value.offset + value.length));
const withinArgumentBudget = (serialized: string): boolean =>
  Buffer.byteLength(serialized, 'utf8') <= NATIVE_REVIEW_LIMITS.argumentBytes &&
  Buffer.byteLength(JSON.stringify({ arguments: serialized }), 'utf8') +
    NATIVE_REVIEW_LIMITS.frameEnvelopeBytes <=
    NATIVE_REVIEW_LIMITS.publicFrameBytes;
const serializedArguments = (raw: unknown): string | undefined => {
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
};
const reviewContentBodySchema = z
  .strictObject({
    conclusion: z.enum(REVIEW_ACTIONS),
    rationale: z.string().trim().min(1).max(NATIVE_REVIEW_LIMITS.rationaleCharacters),
    anchors: z.array(nativeReviewAnchorSchema).max(NATIVE_REVIEW_LIMITS.anchors),
    evidenceRefs: z.array(readRef).min(1).max(NATIVE_REVIEW_LIMITS.reads),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate read reference.' });
  });
/** Check the original value before trim/normalization. A declaration may fit
 * the character budget while its UTF-8/JSON escaping exceeds the frame budget. */
export const nativeReviewContentSchema = z.preprocess((raw, ctx) => {
  const serialized = serializedArguments(raw);
  if (serialized === undefined || !withinArgumentBudget(serialized)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid or over-budget review arguments.' });
    return z.NEVER;
  }
  return raw;
}, reviewContentBodySchema);
export type NativeReviewContent = z.infer<typeof nativeReviewContentSchema>;
/** callArguments is original SDK source text supplied by the Host, not a model
 * field. The actual runtime must call this before persisting an intent or ACK. */
export function parseNativeReviewArguments(
  raw: unknown,
  callArguments?: string,
): NativeReviewContent {
  if (callArguments !== undefined && !withinArgumentBudget(callArguments))
    throw new NativeReviewError('output-too-large');
  const serialized = serializedArguments(raw);
  if (serialized === undefined) throw new NativeReviewError('invalid-arguments');
  if (!withinArgumentBudget(serialized)) throw new NativeReviewError('output-too-large');
  const parsed = nativeReviewContentSchema.safeParse(raw);
  if (!parsed.success) throw new NativeReviewError('invalid-arguments');
  return parsed.data;
}
export const nativeReviewRunSourceSchema = z
  .strictObject({
    context: nativeReviewContextSchema,
    nativeSessionId: id,
    nativeAgentId: id,
    configurationId: id,
  })
  .refine((value) => value.nativeSessionId === value.nativeAgentId);
export type NativeReviewRunSource = z.infer<typeof nativeReviewRunSourceSchema>;
export const nativeReviewReadSourceSchema = nativeReviewRunSourceSchema.safeExtend({
  resourceRef: id,
  resourceFingerprint: digest,
});
export const nativeReviewRangeSchema = z
  .strictObject({
    offset: natural,
    length: natural.max(NATIVE_REVIEW_LIMITS.pageBytes),
    total: natural,
  })
  .refine(
    (value) =>
      Number.isSafeInteger(value.offset + value.length) &&
      value.offset <= value.total &&
      value.length <= value.total - value.offset,
  );
export type NativeReviewReadSource = z.infer<typeof nativeReviewReadSourceSchema>;
export type NativeReviewRange = z.infer<typeof nativeReviewRangeSchema>;

/** Hash consistency is public data consistency, NEVER evidence of an actual read. */
const readRefForData = (
  source: NativeReviewReadSource,
  callId: string,
  range: NativeReviewRange,
  sha256: string,
) => `review_read_${hash({ source, callId, range, sha256 })}`;
export const nativeReviewReadRef = (
  source: NativeReviewReadSource,
  callId: string,
  range: NativeReviewRange,
  sha256: string,
) =>
  readRefForData(
    nativeReviewReadSourceSchema.parse(source),
    id.parse(callId),
    nativeReviewRangeSchema.parse(range),
    digest.parse(sha256),
  );
const errorOutput = z.strictObject({ ok: z.literal(false), code: z.enum(NATIVE_REVIEW_ERRORS) });
const readSuccess = z
  .strictObject({
    ok: z.literal(true),
    protocolVersion: z.literal(1),
    toolVersion: z.literal(NATIVE_REVIEW_READ_TOOL_VERSION),
    callId: id,
    readRef,
    source: nativeReviewReadSourceSchema,
    range: nativeReviewRangeSchema,
    encoding: z.literal('utf-8'),
    sha256: digest,
    text: z.string(),
  })
  .superRefine((value, ctx) => {
    const bytes = Buffer.from(value.text, 'utf8');
    if (
      bytes.byteLength !== value.range.length ||
      createHash('sha256').update(bytes).digest('hex') !== value.sha256 ||
      readRefForData(value.source, value.callId, value.range, value.sha256) !== value.readRef ||
      Buffer.byteLength(JSON.stringify(value)) > NATIVE_REVIEW_LIMITS.outputBytes
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent read page.' });
  });
export const nativeReviewReadOutputSchema = z.union([errorOutput, readSuccess]);
export type NativeReviewReadOutput = z.infer<typeof nativeReviewReadOutputSchema>;

/** SDK-linked metadata only. Parsing this object confers no source authority. */
export const nativeReviewReadEvidenceSchema = z
  .strictObject({
    readRef,
    source: nativeReviewReadSourceSchema,
    callId: id,
    callSeq: natural,
    resultSeq: natural,
    range: nativeReviewRangeSchema,
    encoding: z.literal('utf-8'),
    sha256: digest,
  })
  .superRefine((value, ctx) => {
    if (
      value.callSeq >= value.resultSeq ||
      value.range.length === 0 ||
      readRefForData(value.source, value.callId, value.range, value.sha256) !== value.readRef
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent read provenance.' });
  });
export const nativeReviewReadManifestSchema = z
  .strictObject({
    reads: z.array(nativeReviewReadEvidenceSchema).min(1).max(NATIVE_REVIEW_LIMITS.reads),
    /** Host-computed limitations, never model-selected success evidence. */
    unavailableRequired: z
      .array(
        z.strictObject({
          resourceRef: id,
          code: z.enum(['review-unsupported-material', 'review-unavailable']),
        }),
      )
      .max(NATIVE_REVIEW_LIMITS.resources),
  })
  .superRefine((value, ctx) => {
    const first = value.reads[0]!;
    const origin = (source: NativeReviewReadSource) =>
      canonicalPayload({
        context: source.context,
        nativeSessionId: source.nativeSessionId,
        nativeAgentId: source.nativeAgentId,
        configurationId: source.configurationId,
      });
    const resources = new Map<string, string>();
    let mixedResource = false;
    for (const item of value.reads) {
      const identity = canonicalPayload([item.source.resourceFingerprint, item.range.total]);
      const previous = resources.get(item.source.resourceRef);
      if (previous !== undefined && previous !== identity) mixedResource = true;
      resources.set(item.source.resourceRef, identity);
    }
    if (
      mixedResource ||
      new Set(value.reads.map((item) => item.readRef)).size !== value.reads.length ||
      new Set(value.reads.map((item) => item.callId)).size !== value.reads.length ||
      value.reads.some(
        (item, index) =>
          origin(item.source) !== origin(first.source) ||
          (index > 0 && item.callSeq <= value.reads[index - 1]!.callSeq),
      ) ||
      value.reads.reduce((sum, item) => sum + item.range.length, 0) >
        NATIVE_REVIEW_LIMITS.readBytes ||
      new Set(value.unavailableRequired.map((item) => item.resourceRef)).size !==
        value.unavailableRequired.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent read manifest.' });
  });
export type NativeReviewReadManifest = z.infer<typeof nativeReviewReadManifestSchema>;
export const nativeReviewManifestDigest = (manifest: NativeReviewReadManifest) =>
  hash({ version: 1, ...nativeReviewReadManifestSchema.parse(manifest) });
export const nativeReviewContentDigest = (
  content: NativeReviewContent,
  readManifestDigest: string,
) =>
  hash({
    protocolVersion: 1,
    ...nativeReviewContentSchema.parse(content),
    readManifestDigest: digest.parse(readManifestDigest),
  });

export const nativeReviewIntentSchema = z.strictObject({
  protocolVersion: z.literal(1),
  toolVersion: z.literal(NATIVE_REVIEW_TOOL_VERSION),
  intentId: id,
  callId: id,
  digest,
  readManifestDigest: digest,
  cut: nativeResultCutSchema.optional(),
});
export type NativeReviewIntent = z.infer<typeof nativeReviewIntentSchema>;
/** Actual bytes charged by the original SDK cut reader, not an estimated DTO size. */
export interface NativeReviewSnapshot extends NativeResultSnapshot {
  readonly sourceBytes: number;
}
export const nativeReviewReadBudgetSchema = z
  .strictObject({
    attempts: natural.max(NATIVE_REVIEW_LIMITS.reads),
    chargedBytes: natural.max(NATIVE_REVIEW_LIMITS.readBytes),
  })
  .refine(
    (value) =>
      value.chargedBytes >= value.attempts &&
      value.chargedBytes <= value.attempts * NATIVE_REVIEW_LIMITS.pageBytes,
  );
export type NativeReviewReadBudget = z.infer<typeof nativeReviewReadBudgetSchema>;
export const nativeReviewRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    role: z.literal('review'),
    context: nativeReviewContextSchema,
    binding: nativeWorkSessionRecordSchema,
    /** Charged before source I/O; retries/recovery do not reset the current Run budget. */
    readBudget: nativeReviewReadBudgetSchema.optional(),
    reviewIntent: nativeReviewIntentSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const current = currentBinding(value.binding);
    const bindings = [current, ...previousBindings(value.binding).map((item) => item.binding)];
    if (
      canonicalPayload(current.scope) !== canonicalPayload(value.context.scope) ||
      bindings.some(
        (item) =>
          nativeWorkSessionKey(item.scope) !== nativeWorkSessionKey(value.context.scope) ||
          item.nativeAgentId !== item.nativeSessionId ||
          item.resultIntent !== undefined ||
          item.inputReadBudget !== undefined,
      ) ||
      Buffer.byteLength(JSON.stringify(value)) > NATIVE_LINEAGE_LIMITS.bytes
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid review binding.' });
  });
export type NativeReviewRecord = z.infer<typeof nativeReviewRecordSchema>;
export const nativeReviewAwareRecordSchema = z.union([
  nativeWorkSessionRecordSchema,
  nativeReviewRecordSchema,
]);
export const nativeReviewGlobalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nativeReviewWriter: z.literal(1).optional(),
});
export const NATIVE_REVIEW_WRITER_MARKER = Object.freeze({
  schemaVersion: 1 as const,
  nativeReviewWriter: 1 as const,
});

export const nativeReviewCompletionOutputSchema = z.union([
  errorOutput,
  z.strictObject({
    ok: z.literal(true),
    phase: z.literal('declared'),
    protocolVersion: z.literal(1),
    toolVersion: z.literal(NATIVE_REVIEW_TOOL_VERSION),
    intentId: id,
    callId: id,
    digest,
    readManifestDigest: digest,
    source: nativeReviewRunSourceSchema,
  }),
]);
declare const nativeFixedReviewBrand: unique symbol;
/** A same-owner WeakMap capability, never a serialized summary or successful parse. */
export interface NativeFixedReviewRef {
  readonly [nativeFixedReviewBrand]: true;
}
export type NativeFixedReviewPreparation =
  | {
      readonly status: 'pending';
      readonly reason: 'not-declared' | 'running' | 'draining' | 'not-durable';
    }
  | { readonly status: 'ready'; readonly ref: NativeFixedReviewRef };
export interface NativeFixedReviewLease {
  readonly source: {
    readonly context: NativeReviewContext;
    readonly nativeSessionId: string;
    readonly nativeAgentId: string;
    readonly configurationId: string;
    readonly toolVersion: typeof NATIVE_REVIEW_TOOL_VERSION;
    readonly intentId: string;
    readonly callId: string;
    readonly cut: z.infer<typeof nativeResultCutSchema>;
    readonly readManifestDigest: string;
  };
  readonly content: NativeReviewContent;
  readonly readManifest: NativeReviewReadManifest;
  readonly readManifestDigest: string;
  readonly digest: string;
  readonly provenanceFingerprint: string;
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
/** Original fixed target reader output; a public copied source/page is not this lease. */
export interface NativeReviewReadLease {
  readonly source: NativeReviewReadSource;
  readonly range: NativeReviewRange;
  readonly bytes: Uint8Array;
  readonly encoding: 'utf-8' | 'binary';
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
