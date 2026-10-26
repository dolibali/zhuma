import { z } from 'zod';
import { validateDeliveryContent } from '@zhuma/agent-core';
import type { NativeWorkScope, NativeHistoryEvent } from './native-work-session-contract.js';

export const NATIVE_RESULT_TOOL = 'complete_work';
export const NATIVE_RESULT_TOOL_VERSION = 'zhuma-native-result-intent@1';
export const NATIVE_RESULT_LIMITS = Object.freeze({
  textCharacters: 100_000,
  links: 20,
  scanBytes: 8 * 1024 * 1024,
  readers: 8,
  waitMs: 5_000,
});
const id = z.string().min(1).max(200);
const seq = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Same delivery semantics as the existing core; no model file/path/hash claims. */
export const nativeResultContentSchema = z
  .strictObject({
    text: z.string().max(NATIVE_RESULT_LIMITS.textCharacters).optional(),
    links: z.array(z.string()).max(NATIVE_RESULT_LIMITS.links),
  })
  .superRefine((value, ctx) => {
    const draft = {
      ...(value.text === undefined ? {} : { text: value.text }),
      links: value.links,
      files: [],
    };
    if (
      !validateDeliveryContent(draft).ok ||
      value.links.some((link) => !validateDeliveryContent({ links: [link], files: [] }).ok)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Nonempty text or safe HTTP(S) links without userinfo required.',
      });
  })
  .transform((value) => ({
    ...(value.text === undefined ? {} : { text: value.text.trim() }),
    links: Object.freeze(value.links.map((link) => link.trim())),
  }));
export type NativeResultContent = z.infer<typeof nativeResultContentSchema>;

export const nativeResultCutSchema = z
  .strictObject({
    callSeq: seq,
    resultSeq: seq,
    turnEndSeq: seq,
    asOfSeq: seq,
  })
  .superRefine((cut, ctx) => {
    if (!(
      cut.callSeq < cut.resultSeq &&
      cut.resultSeq < cut.turnEndSeq &&
      cut.turnEndSeq <= cut.asOfSeq
    ))
      ctx.addIssue({ code: 'custom', message: 'Invalid native result cut order.' });
  });
export type NativeResultCut = z.infer<typeof nativeResultCutSchema>;
export const nativeResultIntentSchema = z.strictObject({
  protocolVersion: z.literal(1),
  toolVersion: z.literal(NATIVE_RESULT_TOOL_VERSION),
  intentId: id,
  callId: id,
  digest,
  cut: nativeResultCutSchema.optional(),
});
export type NativeResultIntent = z.infer<typeof nativeResultIntentSchema>;

/** Host-only bounded snapshot of one official native log/projection cut. */
export interface NativeResultSnapshot {
  readonly asOfSeq: number;
  readonly inheritedEventCount: number;
  readonly hasPending: boolean;
  readonly pendingMessageIds: readonly string[];
  readonly events: readonly (NativeHistoryEvent & {
    readonly sourceEventSeqs?: readonly number[];
  })[];
  check(): void;
}
export interface NativeFixedResultSource {
  readonly scope: NativeWorkScope;
  readonly nativeSessionId: string;
  readonly nativeAgentId: string;
  readonly configurationId: string;
  readonly toolVersion: typeof NATIVE_RESULT_TOOL_VERSION;
  readonly intentId: string;
  readonly callId: string;
  readonly cut: NativeResultCut;
}
declare const nativeFixedResultBrand: unique symbol;
/** An actual owner-issued object; matching JSON is not a reference or authorization. */
export interface NativeFixedResultRef {
  readonly [nativeFixedResultBrand]: true;
}
export interface NativeFixedResultLease {
  readonly source: NativeFixedResultSource;
  readonly content: NativeResultContent;
  readonly digest: string;
  readonly provenanceFingerprint: string;
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
export type NativeFixedResultPreparation =
  | {
      readonly status: 'pending';
      readonly reason: 'not-declared' | 'running' | 'draining' | 'not-durable';
    }
  | { readonly status: 'ready'; readonly ref: NativeFixedResultRef };

export const NATIVE_RESULT_ERRORS = [
  'invalid-arguments',
  'completion-pending',
  'input-pending',
  'result-rejected',
  'result-unavailable',
  'cancelled',
  'capacity',
] as const;
export type NativeResultErrorCode = (typeof NATIVE_RESULT_ERRORS)[number];
export class NativeResultError extends Error {
  constructor(readonly code: NativeResultErrorCode) {
    super(code);
    this.name = 'NativeResultError';
  }
}
