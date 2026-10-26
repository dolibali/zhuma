import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type { NativeSessionBinding } from './native-work-session-contract.js';
import { nativeScopeSchema } from './native-work-session-record.js';
import {
  NATIVE_RESULT_TOOL,
  NATIVE_RESULT_TOOL_VERSION,
  NativeResultError,
  nativeResultContentSchema,
  type NativeResultContent,
  type NativeResultCut,
  type NativeResultIntent,
  type NativeResultSnapshot,
} from './native-work-session-result-contract.js';

export const nativeResultDigest = (content: NativeResultContent): string =>
  createHash('sha256')
    .update(canonicalPayload({ text: content.text ?? null, links: content.links }))
    .digest('hex');
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const id = z.string().min(1).max(200);
const callSchema = z.object({
  turn: natural,
  step: natural,
  callId: id,
  name: z.literal(NATIVE_RESULT_TOOL),
  arguments: z.string(),
});
const resultSchema = z.object({
  turn: natural,
  step: natural,
  message: z.object({
    toolCallId: id,
    isError: z.literal(false),
    content: z.tuple([z.strictObject({ type: z.literal('text'), text: z.string() })]),
  }),
});
export const nativeResultAckSchema = z.strictObject({
  ok: z.literal(true),
  phase: z.literal('declared'),
  protocolVersion: z.literal(1),
  toolVersion: z.literal(NATIVE_RESULT_TOOL_VERSION),
  intentId: id,
  callId: id,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.strictObject({
    scope: nativeScopeSchema,
    nativeSessionId: id,
    nativeAgentId: id,
    configurationId: id,
  }),
});
export function nativeResultAck(binding: NativeSessionBinding, intent: NativeResultIntent) {
  return nativeResultAckSchema.parse({
    ok: true,
    phase: 'declared',
    protocolVersion: 1,
    toolVersion: NATIVE_RESULT_TOOL_VERSION,
    intentId: intent.intentId,
    callId: intent.callId,
    digest: intent.digest,
    source: {
      scope: binding.scope,
      nativeSessionId: binding.nativeSessionId,
      nativeAgentId: binding.nativeAgentId,
      configurationId: binding.selection.configurationId,
    },
  });
}

function declaration(snapshot: NativeResultSnapshot, intent: NativeResultIntent) {
  const call = snapshot.events
    .filter((event) => {
      const data = callSchema.safeParse(event.data);
      return (
        event.type === 'tool/call' &&
        event.seq >= snapshot.inheritedEventCount &&
        data.success &&
        data.data.callId === intent.callId
      );
    })
    .at(-1);
  if (!call) return undefined;
  const data = callSchema.parse(call.data);
  let content: NativeResultContent;
  try {
    content = nativeResultContentSchema.parse(JSON.parse(data.arguments));
  } catch {
    throw new NativeResultError('result-rejected');
  }
  if (nativeResultDigest(content) !== intent.digest) throw new NativeResultError('result-rejected');
  return { call, data, content };
}

/** Called inside the same send queue before metadata is declared, never from a UI DTO. */
export function assertNativeResultDeclaration(
  snapshot: NativeResultSnapshot,
  intent: NativeResultIntent,
): undefined {
  const found = declaration(snapshot, intent);
  if (
    !found ||
    snapshot.events.some(
      (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
    )
  )
    throw new NativeResultError('result-rejected');
  if (snapshot.hasPending) throw new NativeResultError('input-pending');
  for (const event of snapshot.events) {
    const end = z.object({ turn: natural }).safeParse(event.data);
    if (
      event.type === 'turn/end' &&
      event.seq > found.call.seq &&
      end.success &&
      end.data.turn === found.data.turn
    )
      throw new NativeResultError('result-rejected');
  }
  snapshot.check();
  return undefined;
}

/** One SDK cut and explicit call→result→completed-turn chain; no last-message inference. */
export function qualifyNativeFixedResult(
  snapshot: NativeResultSnapshot,
  binding: NativeSessionBinding,
  intent: NativeResultIntent,
): { content: NativeResultContent; cut: NativeResultCut } | undefined {
  const found = declaration(snapshot, intent);
  if (!found) return undefined;
  if (snapshot.hasPending) throw new NativeResultError('input-pending');
  const results = snapshot.events.filter(
    (event) => event.type === 'tool/result' && event.sourceEventSeqs?.includes(found.call.seq),
  );
  if (!results.length) return undefined;
  if (results.length !== 1) throw new NativeResultError('result-rejected');
  const result = results[0]!;
  const parsed = resultSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.turn !== found.data.turn ||
    parsed.data.step !== found.data.step ||
    parsed.data.message.toolCallId !== intent.callId ||
    result.sourceEventSeqs?.length !== 1
  )
    throw new NativeResultError('result-rejected');
  try {
    const ack = nativeResultAckSchema.parse(JSON.parse(parsed.data.message.content[0].text));
    if (canonicalPayload(ack) !== canonicalPayload(nativeResultAck(binding, intent))) throw Error();
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
  snapshot.check();
  return { content: found.content, cut };
}
