import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type { NativeSessionBinding } from './native-work-session-contract.js';
import type { NativeResultSnapshot } from './native-work-session-result-contract.js';
import {
  NativeReviewError,
  NATIVE_REVIEW_TOOL,
  NATIVE_REVIEW_TOOL_VERSION,
  NATIVE_REVIEW_READ_TOOL,
  nativeReviewReadRequestSchema,
  nativeReviewReadOutputSchema,
  nativeReviewCompletionOutputSchema,
  parseNativeReviewArguments,
  type NativeReviewContext,
  type NativeReviewIntent,
  type NativeReviewReadManifest,
} from './native-work-session-review-contract.js';
import { validateNativeReviewEvidence } from './native-work-session-review-source.js';

const seq = z.number().int().nonnegative().refine(Number.isSafeInteger);
const id = z.string().min(1).max(200);
const callSchema = z.object({
  turn: seq,
  step: seq,
  callId: id,
  name: z.string(),
  arguments: z.string(),
});
const resultSchema = z.object({
  turn: seq,
  step: seq,
  message: z.object({
    toolCallId: id,
    isError: z.literal(false),
    content: z.tuple([z.strictObject({ type: z.literal('text'), text: z.string() })]),
  }),
});
type Limitations = NativeReviewReadManifest['unavailableRequired'];

export function nativeReviewRunSource(binding: NativeSessionBinding, context: NativeReviewContext) {
  return {
    context,
    nativeSessionId: binding.nativeSessionId,
    nativeAgentId: binding.nativeAgentId,
    configurationId: binding.selection.configurationId,
  };
}
export function nativeReviewAck(
  binding: NativeSessionBinding,
  context: NativeReviewContext,
  intent: NativeReviewIntent,
) {
  return nativeReviewCompletionOutputSchema.parse({
    ok: true,
    phase: 'declared',
    protocolVersion: 1,
    toolVersion: NATIVE_REVIEW_TOOL_VERSION,
    intentId: intent.intentId,
    callId: intent.callId,
    digest: intent.digest,
    readManifestDigest: intent.readManifestDigest,
    source: nativeReviewRunSource(binding, context),
  });
}

/** Reads only the original SDK cut. A successful body page must have exactly
 * one matching call→result edge and the current native source identity. */
export function nativeReviewDeclaration(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  context: NativeReviewContext,
  callId: string,
  unavailableRequired: Limitations,
) {
  const calls = snapshot.events.filter((event) => {
    const parsed = callSchema.safeParse(event.data);
    return (
      event.type === 'tool/call' &&
      event.seq >= snapshot.inheritedEventCount &&
      parsed.success &&
      parsed.data.name === NATIVE_REVIEW_TOOL &&
      parsed.data.callId === callId
    );
  });
  if (!calls.length) return undefined;
  if (calls.length !== 1) throw new NativeReviewError('review-result-rejected');
  const call = calls[0]!,
    data = callSchema.parse(call.data);
  let raw: unknown;
  try {
    raw = JSON.parse(data.arguments);
  } catch {
    throw new NativeReviewError('invalid-arguments');
  }
  const content = parseNativeReviewArguments(raw, data.arguments);
  const reads: NativeReviewReadManifest['reads'] = [];
  const missing = new Map(unavailableRequired.map((item) => [item.resourceRef, item]));
  for (const event of snapshot.events) {
    if (
      event.type !== 'tool/call' ||
      event.seq < snapshot.inheritedEventCount ||
      event.seq >= call.seq
    )
      continue;
    const parsed = callSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.name !== NATIVE_REVIEW_READ_TOOL) continue;
    const readCall = parsed.data;
    const results = snapshot.events.filter(
      (candidate) =>
        candidate.type === 'tool/result' && candidate.sourceEventSeqs?.includes(event.seq),
    );
    if (results.length !== 1) throw new NativeReviewError('review-read-mismatch');
    const result = results[0]!,
      actual = resultSchema.safeParse(result.data);
    if (!actual.success) continue; // Failed tools are never body-read evidence.
    if (
      result.seq <= event.seq ||
      result.seq >= call.seq ||
      result.sourceEventSeqs?.length !== 1 ||
      actual.data.turn !== readCall.turn ||
      actual.data.step !== readCall.step ||
      actual.data.message.toolCallId !== readCall.callId
    )
      throw new NativeReviewError('review-read-mismatch');
    let resultValue: unknown, query: unknown;
    try {
      resultValue = JSON.parse(actual.data.message.content[0].text);
      query = JSON.parse(readCall.arguments);
    } catch {
      throw new NativeReviewError('review-read-mismatch');
    }
    const output = nativeReviewReadOutputSchema.safeParse(resultValue);
    if (!output.success) throw new NativeReviewError('review-read-mismatch');
    if (!output.data.ok) {
      const requested = nativeReviewReadRequestSchema.safeParse(query);
      // This dedicated tool reads the fixed target's required resources only.
      // A Host-produced unsupported error is a limitation, never body evidence.
      if (requested.success && output.data.code === 'review-unsupported-material')
        missing.set(requested.data.resourceRef, {
          resourceRef: requested.data.resourceRef,
          code: 'review-unsupported-material',
        });
      continue;
    }
    const page = output.data,
      requested = nativeReviewReadRequestSchema.safeParse(query);
    if (
      !requested.success ||
      page.callId !== readCall.callId ||
      page.source.resourceRef !== requested.data.resourceRef ||
      page.range.offset !== requested.data.offset ||
      page.range.length > requested.data.length ||
      canonicalPayload({
        context: page.source.context,
        nativeSessionId: page.source.nativeSessionId,
        nativeAgentId: page.source.nativeAgentId,
        configurationId: page.source.configurationId,
      }) !== canonicalPayload(nativeReviewRunSource(binding, context))
    )
      throw new NativeReviewError('review-read-mismatch');
    if (!page.range.length) continue;
    reads.push({
      readRef: page.readRef,
      source: page.source,
      callId: page.callId,
      callSeq: event.seq,
      resultSeq: result.seq,
      range: page.range,
      encoding: page.encoding,
      sha256: page.sha256,
    });
  }
  const facts = validateNativeReviewEvidence(
    content,
    {
      reads,
      unavailableRequired: [...missing.values()].sort((a, b) =>
        a.resourceRef.localeCompare(b.resourceRef),
      ),
    },
    nativeReviewRunSource(binding, context),
    call.seq,
  );
  snapshot.check();
  return { call, data, ...facts };
}

export function assertNativeReviewDeclaration(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  context: NativeReviewContext,
  intent: NativeReviewIntent,
  unavailableRequired: Limitations,
): undefined {
  const found = nativeReviewDeclaration(
    snapshot,
    binding,
    context,
    intent.callId,
    unavailableRequired,
  );
  if (
    !found ||
    found.digest !== intent.digest ||
    found.readManifestDigest !== intent.readManifestDigest ||
    snapshot.events.some(
      (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
    )
  )
    throw new NativeReviewError('review-result-rejected');
  if (snapshot.hasPending) throw new NativeReviewError('review-input-pending');
  if (
    snapshot.events.some(
      (event) =>
        event.type === 'turn/end' &&
        event.seq > found.call.seq &&
        z.object({ turn: z.literal(found.data.turn) }).safeParse(event.data).success,
    )
  )
    throw new NativeReviewError('review-result-rejected');
  snapshot.check();
  return undefined;
}

export function qualifyNativeFixedReview(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  context: NativeReviewContext,
  intent: NativeReviewIntent,
  unavailableRequired: Limitations,
) {
  const found = nativeReviewDeclaration(
    snapshot,
    binding,
    context,
    intent.callId,
    unavailableRequired,
  );
  if (!found) return undefined;
  if (snapshot.hasPending) throw new NativeReviewError('review-input-pending');
  if (found.digest !== intent.digest || found.readManifestDigest !== intent.readManifestDigest)
    throw new NativeReviewError('review-result-rejected');
  const results = snapshot.events.filter(
    (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
  );
  if (!results.length) return undefined;
  if (results.length !== 1) throw new NativeReviewError('review-result-rejected');
  const result = results[0]!,
    parsed = resultSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.turn !== found.data.turn ||
    parsed.data.step !== found.data.step ||
    parsed.data.message.toolCallId !== intent.callId ||
    result.sourceEventSeqs?.length !== 1
  )
    throw new NativeReviewError('review-result-rejected');
  let ack: unknown;
  try {
    ack = JSON.parse(parsed.data.message.content[0].text);
  } catch {
    throw new NativeReviewError('review-result-rejected');
  }
  if (canonicalPayload(ack) !== canonicalPayload(nativeReviewAck(binding, context, intent)))
    throw new NativeReviewError('review-result-rejected');
  const end = snapshot.events.find(
    (event) =>
      event.type === 'turn/end' &&
      event.seq > result.seq &&
      z.object({ turn: z.literal(found.data.turn) }).safeParse(event.data).success,
  );
  if (!end) return undefined;
  if (
    result.seq <= found.call.seq ||
    !z.object({ reason: z.object({ kind: z.literal('completed') }) }).safeParse(end.data).success
  )
    throw new NativeReviewError('review-result-rejected');
  for (const event of snapshot.events) {
    if (event.seq <= found.call.seq) continue;
    if (event.type === 'tool/call' || event.type === 'assistant/message')
      throw new NativeReviewError('review-result-rejected');
    if (event.type === 'user/message' || event.type === 'turn/start')
      throw new NativeReviewError('review-input-pending');
    if (
      event.type === 'agent/inbox/spliced' &&
      !z.object({ inserted: z.array(z.unknown()).max(0).optional() }).safeParse(event.data).success
    )
      throw new NativeReviewError('review-input-pending');
  }
  const cut = {
    callSeq: found.call.seq,
    resultSeq: result.seq,
    turnEndSeq: end.seq,
    asOfSeq: snapshot.asOfSeq,
  };
  if (intent.cut && canonicalPayload(intent.cut) !== canonicalPayload(cut))
    throw new NativeReviewError('review-result-rejected');
  snapshot.check();
  return {
    content: found.content,
    readManifest: found.readManifest,
    readManifestDigest: found.readManifestDigest,
    digest: found.digest,
    cut,
  };
}
