import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativeResultContentSchema,
  nativeResultIntentSchema,
} from '../dist/native-work-session-result-contract.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { nativeWorkSessionRecordSchema } from '../dist/native-work-session-record.js';
import { legacyNativeBindingSchema } from './native-work-session-result-legacy-binding.mjs';
import {
  nativeResultAck,
  nativeResultDigest,
  assertNativeResultDeclaration,
  qualifyNativeFixedResult,
} from '../dist/native-work-session-result-source.js';

test('native result text and links preserve the existing 100000/20 delivery limits without truncation', () => {
  const text = '中'.repeat(100000);
  const result = nativeResultContentSchema.parse({ text, links: [] });
  assert.equal(result.text, text);
  assert.equal(Buffer.byteLength(result.text), 300000);
  assert.equal(
    nativeResultContentSchema.safeParse({ text: text + '中', links: [] }).success,
    false,
  );
  const links = Array.from({ length: 20 }, (_, i) => `https://example.com/result/${i}`);
  assert.deepEqual(nativeResultContentSchema.parse({ links }).links, links);
  assert.equal(
    nativeResultContentSchema.safeParse({ links: [...links, 'https://example.com/21'] }).success,
    false,
  );
});

test('native result declarations reject empty, unsafe, file/path/hash and extra authority claims', () => {
  for (const value of [
    { links: [] },
    { text: '  ', links: [] },
    { text: 'content' },
    ...[
      'javascript:alert(1)',
      'file:///tmp/file',
      '/relative',
      'https://user@example.com/',
      'https://user:pass@example.com/',
      '',
    ].map((link) => ({ links: [link] })),
    ...[{ files: [] }, { path: '/tmp/file' }, { digest: '0'.repeat(64) }, { actorId: 'other' }].map(
      (extra) => ({ text: 'content', links: [], ...extra }),
    ),
  ])
    assert.equal(nativeResultContentSchema.safeParse(value).success, false, JSON.stringify(value));
  assert.deepEqual(
    nativeResultContentSchema.parse({ text: ' text ', links: [' https://example.com/result '] }),
    { text: 'text', links: ['https://example.com/result'] },
  );
});

test('result descriptor is a supported owned SDK declaration with no model-selected scope or completion proof', () => {
  const first = describeNativeResultTool();
  const original = JSON.stringify(first);
  assert.equal(first.sourceVersion, 'zhuma-native-result-intent@1');
  assert.deepEqual(first.parameters.required, ['links']);
  assert.deepEqual(Object.keys(first.parameters.properties).sort(), ['links', 'text']);
  first.parameters.properties.links.description = 'consumer mutation';
  assert.equal(JSON.stringify(describeNativeResultTool()), original);
});

test('result intent metadata requires versioned source and an ordered exact cut', () => {
  const intent = {
    protocolVersion: 1,
    toolVersion: 'zhuma-native-result-intent@1',
    intentId: 'intent',
    callId: 'call',
    digest: 'a'.repeat(64),
  };
  assert.deepEqual(nativeResultIntentSchema.parse(intent), intent);
  assert.equal(
    nativeResultIntentSchema.safeParse({ ...intent, protocolVersion: 2 }).success,
    false,
  );
  assert.equal(
    nativeResultIntentSchema.safeParse({ ...intent, text: 'not a second body store' }).success,
    false,
  );
  assert.equal(
    nativeResultIntentSchema.safeParse({
      ...intent,
      cut: { callSeq: 3, resultSeq: 2, turnEndSeq: 4, asOfSeq: 4 },
    }).success,
    false,
  );
});

function sourceContract() {
  const binding = {
    schemaVersion: 1,
    scope: {
      actorId: 'member',
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      runId: 'run',
      generation: 1,
      segmentId: 'segment',
    },
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    selection: {
      provider: 'contract',
      model: 'contract',
      maxTokens: 1000,
      configurationId: 'configuration',
    },
    receipts: [],
  };
  const content = { text: 'Fixed text', links: ['https://example.com/result'] };
  const intent = {
    protocolVersion: 1,
    toolVersion: 'zhuma-native-result-intent@1',
    intentId: 'intent',
    callId: 'completion',
    digest: nativeResultDigest(content),
  };
  const call = {
    seq: 0,
    time: 1,
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: intent.callId,
      name: 'complete_work',
      arguments: JSON.stringify(content),
    },
  };
  const result = {
    seq: 1,
    time: 2,
    type: 'tool/result',
    sourceEventSeqs: [0],
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: intent.callId,
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(nativeResultAck(binding, intent)) }],
      }),
    },
  };
  const end = {
    seq: 2,
    time: 3,
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
  };
  const snapshot = {
    asOfSeq: 2,
    inheritedEventCount: 0,
    hasPending: false,
    events: [call, result, end],
    check() {},
  };
  return { binding, content, intent, snapshot, call, result, end };
}

test('source contract needs explicit linked result and completed turn, not an idle/last-message hint', () => {
  const h = sourceContract();
  assert.deepEqual(qualifyNativeFixedResult(h.snapshot, h.binding, h.intent), {
    content: h.content,
    cut: { callSeq: 0, resultSeq: 1, turnEndSeq: 2, asOfSeq: 2 },
  });
  assert.equal(
    qualifyNativeFixedResult(
      {
        ...h.snapshot,
        events: [
          {
            seq: 0,
            type: 'assistant/message',
            data: { content: [{ type: 'text', text: 'I am done' }] },
          },
          h.end,
        ],
      },
      h.binding,
      h.intent,
    ),
    undefined,
  );
  assertNativeResultDeclaration({ ...h.snapshot, events: [h.call] }, h.intent);
  assert.throws(() => assertNativeResultDeclaration(h.snapshot, h.intent), {
    code: 'result-rejected',
  });
});

test('legacy binding bytes are preserved and the actual pre-result strict validator refuses new intent metadata', () => {
  const h = sourceContract();
  const before = JSON.stringify(h.binding);
  assert.equal(JSON.stringify(nativeWorkSessionRecordSchema.parse(h.binding)), before);
  assert.equal(JSON.stringify(legacyNativeBindingSchema.parse(h.binding)), before);
  const declared = { ...h.binding, resultIntent: h.intent };
  assert.equal(nativeWorkSessionRecordSchema.safeParse(declared).success, true);
  assert.equal(legacyNativeBindingSchema.safeParse(declared).success, false);
  assert.equal(
    nativeWorkSessionRecordSchema.safeParse({
      ...declared,
      resultIntent: { ...h.intent, protocolVersion: 2 },
    }).success,
    false,
  );
});

test('source contract rejects wrong scope/links/order, policy value changes and internal or later work', () => {
  const h = sourceContract();
  for (const change of [
    { sourceEventSeqs: [9] },
    { data: { ...h.result.data, message: { ...h.result.data.message, toolCallId: 'different' } } },
    { data: { ...h.result.data, message: { ...h.result.data.message, isError: true } } },
    {
      data: {
        ...h.result.data,
        message: {
          ...h.result.data.message,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...nativeResultAck(h.binding, h.intent),
                digest: '0'.repeat(64),
              }),
            },
          ],
        },
      },
    },
  ]) {
    const read = () =>
      qualifyNativeFixedResult(
        { ...h.snapshot, events: [h.call, { ...h.result, ...change }, h.end] },
        h.binding,
        h.intent,
      );
    if (change.sourceEventSeqs) assert.equal(read(), undefined);
    else assert.throws(read, { code: 'result-rejected' });
  }
  assert.throws(
    () => qualifyNativeFixedResult({ ...h.snapshot, hasPending: true }, h.binding, h.intent),
    { code: 'input-pending' },
  );
  for (const late of [
    { type: 'user/message', code: 'input-pending' },
    { type: 'tool/call', code: 'result-rejected' },
    {
      type: 'agent/inbox/spliced',
      data: { inserted: [{ role: 'system' }] },
      code: 'input-pending',
    },
  ])
    assert.throws(
      () =>
        qualifyNativeFixedResult(
          {
            ...h.snapshot,
            asOfSeq: 3,
            events: [
              ...h.snapshot.events,
              { seq: 3, time: 4, type: late.type, data: late.data ?? {} },
            ],
          },
          h.binding,
          h.intent,
        ),
      { code: late.code },
    );
  const changed = { ...h.binding, scope: { ...h.binding.scope, generation: 2 } };
  assert.throws(() => qualifyNativeFixedResult(h.snapshot, changed, h.intent), {
    code: 'result-rejected',
  });
});
