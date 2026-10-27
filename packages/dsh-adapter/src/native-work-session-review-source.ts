import { canonicalPayload } from '@zhuma/agent-core';
import {
  NativeReviewError,
  parseNativeReviewArguments,
  nativeReviewReadManifestSchema,
  nativeReviewRunSourceSchema,
  nativeReviewContentDigest,
  nativeReviewManifestDigest,
  type NativeReviewContent,
  type NativeReviewReadManifest,
  type NativeReviewRunSource,
} from './native-work-session-review-contract.js';

/** Public consistency check only. The caller must separately authenticate SDK
 * call/result linkage, actual returned bytes, source leases and the fixed cut.
 * This function cannot mint a grant, fixed ref, read lease or approval. */
export function validateNativeReviewEvidence(
  rawContent: unknown,
  rawManifest: unknown,
  rawSource: NativeReviewRunSource,
  completionCallSeq: number,
): {
  readonly content: NativeReviewContent;
  readonly readManifest: NativeReviewReadManifest;
  readonly readManifestDigest: string;
  readonly digest: string;
} {
  const content = parseNativeReviewArguments(rawContent);
  const parsedManifest = nativeReviewReadManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    if (
      rawManifest &&
      typeof rawManifest === 'object' &&
      'reads' in rawManifest &&
      Array.isArray(rawManifest.reads) &&
      rawManifest.reads.length === 0
    )
      throw new NativeReviewError('review-read-required');
    throw new NativeReviewError('review-read-mismatch');
  }
  const parsedSource = nativeReviewRunSourceSchema.safeParse(rawSource);
  if (!parsedSource.success || !Number.isSafeInteger(completionCallSeq) || completionCallSeq < 0)
    throw new NativeReviewError('review-read-mismatch');
  const readManifest = parsedManifest.data;
  const origin = (source: NativeReviewRunSource) =>
    canonicalPayload({
      context: source.context,
      nativeSessionId: source.nativeSessionId,
      nativeAgentId: source.nativeAgentId,
      configurationId: source.configurationId,
    });
  const expected = origin(parsedSource.data);
  if (
    readManifest.reads.some(
      (read) => origin(read.source) !== expected || read.resultSeq >= completionCallSeq,
    )
  )
    throw new NativeReviewError('review-read-mismatch');
  const selected = new Set(content.evidenceRefs);
  // The Host supplies the full actual body-read manifest; the model cannot hide
  // one of its reads or smuggle a foreign read reference into the declaration.
  if (
    selected.size !== readManifest.reads.length ||
    readManifest.reads.some((read) => !selected.has(read.readRef))
  )
    throw new NativeReviewError('review-read-mismatch');
  for (const anchor of content.anchors) {
    const ranges = readManifest.reads
      .filter((read) => read.source.resourceRef === anchor.resourceRef)
      .map((read) => read.range)
      .sort((a, b) => a.offset - b.offset);
    let end = anchor.offset;
    for (const range of ranges) {
      if (range.offset > end) break;
      end = Math.max(end, range.offset + range.length);
      if (end >= anchor.offset + anchor.length) break;
    }
    if (end < anchor.offset + anchor.length) throw new NativeReviewError('review-range-invalid');
  }
  if (readManifest.unavailableRequired.length > 0 && content.conclusion !== 'comment')
    throw new NativeReviewError('review-unsupported-material');
  const readManifestDigest = nativeReviewManifestDigest(readManifest);
  return {
    content,
    readManifest,
    readManifestDigest,
    digest: nativeReviewContentDigest(content, readManifestDigest),
  };
}
