/** SDK-event shape contracts only; these synthetic events grant no ledger/file authority. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyNativePublicationEvidence } from '../dist/native-work-session-result-publications-source.js';
import { nativeResultPublicationsContentSchema } from '../dist/native-work-session-result-publications-contract.js';

const binding = {
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
  nativeSessionId: 'session',
  nativeAgentId: 'agent',
  selection: { configurationId: 'configuration' },
};
const source = (callId) => ({
  scope: structuredClone(binding.scope),
  nativeSessionId: binding.nativeSessionId,
  nativeAgentId: binding.nativeAgentId,
  configurationId: binding.selection.configurationId,
  expertVersionId: 'expert-v1',
  toolVersion: 'zhuma-native-output-file@1',
  callId,
});
const pair = (id, seq = 0) => {
  const callId = `publish-${id}`;
  const ack = {
    ok: true,
    phase: 'published',
    protocolVersion: 1,
    publicationId: id,
    name: 'result.bin',
    mediaType: 'application/octet-stream',
    bytes: 8,
    sha256: 'a'.repeat(64),
    source: source(callId),
  };
  return [
    {
      type: 'tool/call',
      seq,
      data: {
        turn: 1,
        step: 1,
        callId,
        name: 'publish_output_file',
        arguments: JSON.stringify({ path: 'outputs/result.bin' }),
      },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      sourceEventSeqs: [seq],
      data: {
        turn: 1,
        step: 1,
        message: {
          toolCallId: callId,
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(ack) }],
        },
      },
    },
  ];
};
function snapshot(events) {
  return {
    asOfSeq: 20,
    inheritedEventCount: 0,
    hasPending: false,
    pendingMessageIds: [],
    events,
    check() {},
  };
}
function qualify(events, ids = ['publication'], extra = {}) {
  return qualifyNativePublicationEvidence(
    { ...snapshot(events), ...extra },
    binding,
    nativeResultPublicationsContentSchema.parse({
      links: [],
      publications: ids.map((publicationId) => ({ publicationId })),
    }),
    10,
    'expert-v1',
  );
}
function changeAck(events, mutate) {
  const next = structuredClone(events),
    message = next[1].data.message;
  const ack = JSON.parse(message.content[0].text);
  mutate(ack);
  message.content[0].text = JSON.stringify(ack);
  return next;
}

test('publication evidence contract: exact linked calls/ACKs retain selection order and no raw path or bytes', () => {
  const value = qualify(
    [...pair('first'), ...pair('second', 2), ...pair('unselected', 4)],
    ['second', 'first'],
  );
  assert.deepEqual(
    value.map((item) => item.publicationId),
    ['second', 'first'],
  );
  assert.deepEqual(
    value.map((item) => [item.callSeq, item.resultSeq]),
    [
      [2, 3],
      [0, 1],
    ],
  );
  assert.equal(value[0].selectorFingerprint.length, 64);
  assert.equal(JSON.stringify(value).includes('outputs/result.bin'), false);
  assert.equal(Object.hasOwn(value[0], 'data'), false);
});

test('publication evidence contract: every foreign scope/native/configuration/expert/source claim is rejected', () => {
  const events = pair('publication');
  for (const key of Object.keys(binding.scope)) {
    const bad = changeAck(events, (ack) => {
      ack.source.scope[key] = typeof binding.scope[key] === 'number' ? 2 : 'foreign';
    });
    assert.throws(() => qualify(bad), { code: 'result-rejected' });
  }
  for (const key of [
    'nativeSessionId',
    'nativeAgentId',
    'configurationId',
    'expertVersionId',
    'callId',
    'toolVersion',
  ])
    assert.throws(
      () =>
        qualify(
          changeAck(events, (ack) => {
            ack.source[key] = 'foreign';
          }),
        ),
      { code: 'result-rejected' },
    );
});

test('publication evidence contract: unlinked/fake/late/inherited/ambiguous ACKs cannot satisfy selection', () => {
  const events = pair('publication');
  const badCases = [
    (e) => {
      delete e[1].sourceEventSeqs;
    },
    (e) => {
      e[1].sourceEventSeqs = [0, 2];
    },
    (e) => {
      e[1].sourceEventSeqs = [2];
    },
    (e) => {
      e[1].type = 'assistant/message';
    },
    (e) => {
      e[1].data.message.isError = true;
    },
    (e) => {
      e[1].data.step = 2;
    },
    (e) => {
      e[1].data.turn = 2;
    },
    (e) => {
      e[1].data.message.toolCallId = 'foreign';
    },
    (e) => {
      e[0].data.name = 'complete_work';
    },
    (e) => {
      e[0].seq = 2;
      e[1].sourceEventSeqs = [2];
    },
    (e) => {
      e[1].seq = 11;
    },
    (e) => {
      e.push(structuredClone(e[1]));
    },
  ];
  for (const mutate of badCases) {
    const next = structuredClone(events);
    mutate(next);
    assert.throws(() => qualify(next), { code: 'result-rejected' });
  }
  assert.throws(() => qualify(events, ['publication'], { inheritedEventCount: 1 }), {
    code: 'result-rejected',
  });
});

test('publication evidence contract: changed model arguments and malformed success metadata fail closed', () => {
  const events = pair('publication');
  for (const args of [
    { path: '../private' },
    { path: '/private' },
    { path: 'outputs/result.bin', actorId: 'foreign' },
    { path: 'outputs/result.bin', name: 'changed.bin' },
  ]) {
    const next = structuredClone(events);
    next[0].data.arguments = JSON.stringify(args);
    assert.throws(() => qualify(next), { code: 'result-rejected' });
  }
  for (const mutate of [
    (ack) => {
      ack.phase = 'declared';
    },
    (ack) => {
      ack.protocolVersion = 2;
    },
    (ack) => {
      ack.bytes = 20 * 1024 * 1024 + 1;
    },
    (ack) => {
      ack.bytes = -1;
    },
    (ack) => {
      ack.sha256 = 'forged';
    },
    (ack) => {
      ack.name = '../private';
    },
    (ack) => {
      ack.path = 'outputs/result.bin';
    },
  ])
    assert.throws(() => qualify(changeAck(events, mutate)), { code: 'result-rejected' });
  assert.throws(() => qualify(events, ['missing']), { code: 'result-rejected' });
  assert.throws(
    () =>
      qualify(events, ['publication'], {
        check() {
          throw Error('revoked snapshot');
        },
      }),
    /revoked snapshot/,
  );
});
