import { z } from 'zod';
import { WorkTaskSchema, validateDeliveryContent, type ArtifactDraft } from '@zhuma/agent-core';
import {
  NATIVE_RESULT_LIMITS,
  nativeResultCutSchema,
  type NativeFixedResultSource,
} from './native-work-session-result-contract.js';
import type { UploadFileRecord } from './artifact-files.js';
import type { NativePublicationEvidence } from './native-work-session-result-publications-source.js';

export const NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION = 'zhuma-native-result-intent@2';
export const NATIVE_RESULT_PUBLICATIONS_LIMIT = 20;

/** Model selectors only. A selector never authenticates a receipt or its bytes. */
export const nativeResultPublicationsContentSchema = z
  .strictObject({
    text: z.string().max(NATIVE_RESULT_LIMITS.textCharacters).optional(),
    links: z.array(z.string()).max(NATIVE_RESULT_LIMITS.links),
    publications: z
      .array(z.strictObject({ publicationId: WorkTaskSchema.shape.id }))
      .max(NATIVE_RESULT_PUBLICATIONS_LIMIT),
  })
  .superRefine((value, ctx) => {
    if (
      value.links.some((link) => !validateDeliveryContent({ links: [link], files: [] }).ok) ||
      (!value.publications.length &&
        !validateDeliveryContent({
          ...(value.text === undefined ? {} : { text: value.text }),
          links: value.links,
          files: [],
        }).ok)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Nonempty content and safe HTTP(S) links required.',
      });
    if (
      new Set(value.publications.map((item) => item.publicationId)).size !==
      value.publications.length
    )
      ctx.addIssue({ code: 'custom', message: 'Publication selectors must be unique.' });
  })
  .transform((value) => ({
    ...(value.text === undefined ? {} : { text: value.text.trim() }),
    links: Object.freeze(value.links.map((link) => link.trim())),
    publications: Object.freeze(value.publications.map((item) => Object.freeze({ ...item }))),
  }));
export type NativeResultPublicationsContent = z.infer<typeof nativeResultPublicationsContentSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(200);
/** Versioned metadata only; selectors and content remain in the original SDK log. */
export const nativeResultPublicationsIntentSchema = z.strictObject({
  protocolVersion: z.literal(2),
  toolVersion: z.literal(NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION),
  intentId: id,
  callId: id,
  digest,
  manifestDigest: digest,
  cut: nativeResultCutSchema.optional(),
});
export type NativeResultPublicationsIntent = z.infer<typeof nativeResultPublicationsIntentSchema>;
export interface NativePublicationManifestEntry {
  readonly evidence: NativePublicationEvidence;
  readonly record: UploadFileRecord;
}
export interface NativeFixedResultPublicationsSource extends Omit<
  NativeFixedResultSource,
  'toolVersion'
> {
  readonly toolVersion: typeof NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION;
  readonly manifestDigest: string;
  readonly expertVersionId: string;
}
/** Original-owner fixed result only. The manifest contains no FS path or file body. */
export interface NativeFixedResultPublicationsLease {
  readonly source: NativeFixedResultPublicationsSource;
  readonly content: ArtifactDraft;
  readonly manifest: readonly NativePublicationManifestEntry[];
  readonly manifestDigest: string;
  readonly digest: string;
  readonly provenanceFingerprint: string;
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
