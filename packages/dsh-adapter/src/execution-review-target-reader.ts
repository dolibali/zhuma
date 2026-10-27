import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload, type ArtifactVersion } from '@zhuma/agent-core';
import type { ExecutionReviewScope } from './execution-review-contract.js';

const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const reviewTargetReadSchema = z
  .strictObject({
    resourceRef: z.string().min(1).max(200),
    offset: natural,
    length: natural.min(1).max(8192),
  })
  .refine((value) => Number.isSafeInteger(value.offset + value.length));
export interface ExecutionReviewResource {
  readonly resourceRef: string;
  readonly kind: 'text' | 'file' | 'external-reference';
  readonly required: true;
  readonly mediaType: string;
  readonly bytes: number;
  readonly resourceFingerprint: string;
}
export interface ExecutionReviewTargetReadLease {
  readonly scope: ExecutionReviewScope;
  readonly resource: ExecutionReviewResource;
  readonly range: { readonly offset: number; readonly length: number; readonly total: number };
  readonly bytes: Uint8Array;
  readonly encoding: 'utf-8' | 'binary';
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const reviewFileResourceRef = (id: string) => `review_file_${hash(id)}`;
/** Metadata only. It never proves any body/file bytes were read by an Agent. */
export function reviewTargetResources(artifact: ArtifactVersion): ExecutionReviewResource[] {
  const result: ExecutionReviewResource[] = [];
  if (artifact.text !== undefined) {
    const bytes = Buffer.from(artifact.text, 'utf8');
    result.push({
      resourceRef: 'review_text',
      kind: 'text',
      required: true,
      mediaType: 'text/plain',
      bytes: bytes.length,
      resourceFingerprint: hash(bytes),
    });
  }
  for (const file of artifact.files)
    result.push({
      resourceRef: reviewFileResourceRef(file.id),
      kind: 'file',
      required: true,
      mediaType: file.mediaType,
      bytes: file.byteSize,
      resourceFingerprint: hash(canonicalPayload(file)),
    });
  if (artifact.links.length)
    result.push({
      resourceRef: 'review_external_references',
      kind: 'external-reference',
      required: true,
      mediaType: 'application/json',
      bytes: Buffer.byteLength(JSON.stringify(artifact.links)),
      resourceFingerprint: hash(canonicalPayload(artifact.links)),
    });
  return result;
}
