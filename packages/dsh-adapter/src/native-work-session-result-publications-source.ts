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
  NATIVE_RESULT_TOOL,
  NativeResultError,
  type NativeResultCut,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';
import {
  NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  nativeResultPublicationsContentSchema,
  type NativeResultPublicationsContent,
  type NativeResultPublicationsIntent,
  type NativePublicationManifestEntry,
} from './native-work-session-result-publications-contract.js';
import { nativeScopeSchema } from './native-work-session-record.js';

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

export const nativePublicationManifestDigest = (
  manifest: readonly NativePublicationManifestEntry[],
) => hash({ version: 1, publications: manifest });
export const nativeResultPublicationsDigest = (
  content: NativeResultPublicationsContent,
  manifestDigest: string,
) =>
  hash({
    protocolVersion: 2,
    text: content.text ?? null,
    links: content.links,
    publications: content.publications,
    manifestDigest,
  });

const completionCallSchema = z.object({
  turn: natural,
  step: natural,
  callId: id,
  name: z.literal(NATIVE_RESULT_TOOL),
  arguments: z.string(),
});
export const nativeResultPublicationsAckSchema = z.strictObject({
  ok: z.literal(true),
  phase: z.literal('declared'),
  protocolVersion: z.literal(2),
  toolVersion: z.literal(NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION),
  intentId: id,
  callId: id,
  digest,
  manifestDigest: digest,
  source: z.strictObject({
    scope: nativeScopeSchema,
    nativeSessionId: id,
    nativeAgentId: id,
    configurationId: id,
  }),
});
export function nativeResultPublicationsAck(
  binding: NativeSessionBinding,
  intent: NativeResultPublicationsIntent,
) {
  return nativeResultPublicationsAckSchema.parse({
    ok: true,
    phase: 'declared',
    protocolVersion: 2,
    toolVersion: NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
    intentId: intent.intentId,
    callId: intent.callId,
    digest: intent.digest,
    manifestDigest: intent.manifestDigest,
    source: {
      scope: binding.scope,
      nativeSessionId: binding.nativeSessionId,
      nativeAgentId: binding.nativeAgentId,
      configurationId: binding.selection.configurationId,
    },
  });
}
/** Read only the actual explicit call. No caller-provided argument reconstruction. */
export function nativeResultPublicationsDeclaration(
  snapshot: NativeResultSnapshot,
  callId: string,
) {
  const call = snapshot.events
    .filter((event) => {
      const data = completionCallSchema.safeParse(event.data);
      return (
        event.type === 'tool/call' &&
        event.seq >= snapshot.inheritedEventCount &&
        data.success &&
        data.data.callId === callId
      );
    })
    .at(-1);
  if (!call) return undefined;
  const data = completionCallSchema.parse(call.data);
  let content: NativeResultPublicationsContent;
  try {
    content = nativeResultPublicationsContentSchema.parse(JSON.parse(data.arguments));
  } catch {
    throw new NativeResultError('result-rejected');
  }
  return { call, data, content };
}
export function assertNativeResultPublicationsDeclaration(
  snapshot: NativeResultSnapshot,
  intent: NativeResultPublicationsIntent,
): undefined {
  const found = nativeResultPublicationsDeclaration(snapshot, intent.callId);
  if (
    !found ||
    nativeResultPublicationsDigest(found.content, intent.manifestDigest) !== intent.digest ||
    snapshot.events.some(
      (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
    )
  )
    throw new NativeResultError('result-rejected');
  if (snapshot.hasPending) throw new NativeResultError('input-pending');
  if (
    snapshot.events.some((event) => {
      const end = z.object({ turn: natural }).safeParse(event.data);
      return (
        event.type === 'turn/end' &&
        event.seq > found.call.seq &&
        end.success &&
        end.data.turn === found.data.turn
      );
    })
  )
    throw new NativeResultError('result-rejected');
  snapshot.check();
  return undefined;
}

/** SDK cut qualification only. The owner must additionally fix the real ledger manifest. */
export function qualifyNativeFixedPublicationsResult(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  intent: NativeResultPublicationsIntent,
  expertVersionId: string,
):
  | {
      content: NativeResultPublicationsContent;
      cut: NativeResultCut;
      evidence: readonly NativePublicationEvidence[];
    }
  | undefined {
  const found = nativeResultPublicationsDeclaration(snapshot, intent.callId);
  if (!found) return undefined;
  if (nativeResultPublicationsDigest(found.content, intent.manifestDigest) !== intent.digest)
    throw new NativeResultError('result-rejected');
  if (snapshot.hasPending) throw new NativeResultError('input-pending');
  const results = snapshot.events.filter(
    (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
  );
  if (!results.length) return undefined;
  if (results.length !== 1) throw new NativeResultError('result-rejected');
  const result = results[0]!,
    parsed = publicationResultSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.turn !== found.data.turn ||
    parsed.data.step !== found.data.step ||
    parsed.data.message.toolCallId !== intent.callId ||
    result.sourceEventSeqs?.length !== 1
  )
    throw new NativeResultError('result-rejected');
  try {
    const ack = nativeResultPublicationsAckSchema.parse(
      JSON.parse(parsed.data.message.content[0].text),
    );
    if (canonicalPayload(ack) !== canonicalPayload(nativeResultPublicationsAck(binding, intent)))
      throw Error();
  } catch {
    throw new NativeResultError('result-rejected');
  }
  const end = snapshot.events.find((event) => {
    const data = z.object({ turn: natural }).safeParse(event.data);
    return (
      event.type === 'turn/end' &&
      event.seq > result.seq &&
      data.success &&
      data.data.turn === found.data.turn
    );
  });
  if (!end) return undefined;
  if (!z.object({ reason: z.object({ kind: z.literal('completed') }) }).safeParse(end.data).success)
    throw new NativeResultError('result-rejected');
  for (const event of snapshot.events) {
    if (event.seq <= found.call.seq) continue;
    if (event.type === 'tool/call' || event.type === 'assistant/message')
      throw new NativeResultError('result-rejected');
    if (event.type === 'user/message' || event.type === 'turn/start')
      throw new NativeResultError('input-pending');
    if (event.type === 'agent/inbox/spliced') {
      const data = z.object({ inserted: z.array(z.unknown()).optional() }).safeParse(event.data);
      if (!data.success || data.data.inserted?.length) throw new NativeResultError('input-pending');
    }
  }
  const cut = {
    callSeq: found.call.seq,
    resultSeq: result.seq,
    turnEndSeq: end.seq,
    asOfSeq: snapshot.asOfSeq,
  };
  if (intent.cut && canonicalPayload(intent.cut) !== canonicalPayload(cut))
    throw new NativeResultError('result-rejected');
  const evidence = qualifyNativePublicationEvidence(
    snapshot,
    binding,
    found.content,
    found.call.seq,
    expertVersionId,
  );
  snapshot.check();
  return { content: found.content, cut, evidence };
}
