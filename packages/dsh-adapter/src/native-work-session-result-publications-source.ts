import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload, WorkTaskSchema } from '@zhuma/agent-core';
import {
  ARTIFACT_FILE_LIMITS,
  artifactFileLeaf,
  nativeOutputFileSourceSchema,
  type NativeOutputFileSource,
} from './artifact-files.js';
import { outputRelativePath } from './native-work-session-output-file-source.js';
import {
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
} from './native-work-session-output-file-tool.js';
import type { NativeSessionBinding } from './native-work-session-contract.js';
import {
  NativeResultError,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';
import type { NativeResultPublicationsContent } from './native-work-session-result-publications-contract.js';

const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const publicationAckSchema = z.strictObject({
  ok: z.literal(true),
  phase: z.literal('published'),
  protocolVersion: z.literal(1),
  publicationId: WorkTaskSchema.shape.id,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  bytes: natural.max(ARTIFACT_FILE_LIMITS.maxFileBytes),
  sha256: digest,
  source: nativeOutputFileSourceSchema,
});
const publicationCallSchema = z.object({
  turn: natural,
  step: natural,
  callId: id,
  name: z.literal(NATIVE_OUTPUT_FILE_TOOL),
  arguments: z.string(),
});
const publicationResultSchema = z.object({
  turn: natural,
  step: natural,
  message: z.object({
    toolCallId: id,
    isError: z.literal(false),
    content: z.tuple([z.strictObject({ type: z.literal('text'), text: z.string() })]),
  }),
});
const publicationArguments = z.strictObject({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).optional(),
});
export interface NativePublicationEvidence {
  readonly publicationId: string;
  readonly source: NativeOutputFileSource;
  readonly callSeq: number;
  readonly resultSeq: number;
  readonly selectorFingerprint: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * Qualify only the original SDK publish-call/success-ACK chain before this
 * completion call. This grants no ledger or byte authority; its consumer must
 * also match the original completed record through the original Run owner.
 */
export function qualifyNativePublicationEvidence(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  content: NativeResultPublicationsContent,
  completionCallSeq: number,
  expertVersionId: string,
): readonly NativePublicationEvidence[] {
  snapshot.check();
  if (
    !Number.isSafeInteger(completionCallSeq) ||
    completionCallSeq < snapshot.inheritedEventCount ||
    completionCallSeq > snapshot.asOfSeq
  )
    throw new NativeResultError('result-rejected');
  const selected = new Set(content.publications.map((item) => item.publicationId));
  if (selected.size !== content.publications.length || selected.size > 20)
    throw new NativeResultError('result-rejected');
  const found = new Map<string, NativePublicationEvidence>();
  const events = snapshot.events.filter(
    (event) => event.seq >= snapshot.inheritedEventCount && event.seq < completionCallSeq,
  );
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const result = publicationResultSchema.safeParse(event.data);
    if (!result.success) continue;
    let json: unknown;
    try {
      json = JSON.parse(result.data.message.content[0].text);
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object' || !selected.has(Reflect.get(json, 'publicationId')))
      continue;
    const ack = publicationAckSchema.safeParse(json);
    if (!ack.success) throw new NativeResultError('result-rejected');
    const value = ack.data;
    const seqs = event.sourceEventSeqs;
    const calls = events.filter((item) => item.type === 'tool/call' && seqs?.includes(item.seq));
    if (seqs?.length !== 1 || calls.length !== 1 || found.has(value.publicationId))
      throw new NativeResultError('result-rejected');
    const call = calls[0]!;
    const parsed = publicationCallSchema.safeParse(call.data);
    if (
      !parsed.success ||
      call.seq >= event.seq ||
      parsed.data.turn !== result.data.turn ||
      parsed.data.step !== result.data.step ||
      parsed.data.callId !== result.data.message.toolCallId ||
      parsed.data.callId !== value.source.callId ||
      value.source.toolVersion !== NATIVE_OUTPUT_FILE_VERSION ||
      canonicalPayload(value.source.scope) !== canonicalPayload(binding.scope) ||
      value.source.nativeSessionId !== binding.nativeSessionId ||
      value.source.nativeAgentId !== binding.nativeAgentId ||
      value.source.configurationId !== binding.selection.configurationId ||
      value.source.expertVersionId !== expertVersionId
    )
      throw new NativeResultError('result-rejected');
    let selectorFingerprint: string;
    try {
      const args = publicationArguments.parse(JSON.parse(parsed.data.arguments));
      const path = outputRelativePath(args.path);
      const name = artifactFileLeaf(args.name ?? path.split('/').at(-1)!);
      if (name !== value.name) throw Error();
      selectorFingerprint = hash({ path, name });
    } catch {
      throw new NativeResultError('result-rejected');
    }
    found.set(value.publicationId, {
      publicationId: value.publicationId,
      source: structuredClone(value.source),
      callSeq: call.seq,
      resultSeq: event.seq,
      selectorFingerprint,
      name: value.name,
      mediaType: value.mediaType,
      byteSize: value.bytes,
      sha256: value.sha256,
    });
  }
  if (found.size !== selected.size) throw new NativeResultError('result-rejected');
  snapshot.check();
  return content.publications.map(({ publicationId }) => found.get(publicationId)!);
}
