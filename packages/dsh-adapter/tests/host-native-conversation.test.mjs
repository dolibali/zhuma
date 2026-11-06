/** Member/history adapter contracts with fake SDK/authority ports; no model or physical Session proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostNativeConversation } from '../dist/host-native-conversation.js';
const target = {
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
};
function setup() {
  let disposed = 0,
    opened = 0,
    reads = 0,
    allowed = true;
  const abort = new AbortController();
  const scope = { ...target, actorId: 'member' };
  const grant = {
    scope,
    signal: abort.signal,
    assertCurrent() {
      abort.signal.throwIfAborted();
      if (!allowed) throw Error('revoked');
    },
  };
  const originalFrame = {
    type: 'snapshot',
    header: { id: 'native' },
    cursor: 0,
    records: [
      {
        kind: 'event',
        event: { type: 'tool/result', data: { originalToolOutput: 'fixture' }, seq: 0 },
      },
    ],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
    assistantStream: { revision: 0 },
  };
  let page = async () => ({ records: originalFrame.records, hasMore: false });
  let follow = async function* () {
    yield originalFrame;
  };
  let historyIdentity = {};
  const conversation = createHostNativeConversation({
    authorities: {
      async open(request, locator, purpose) {
        opened++;
        assert.equal(request, memberRequest);
        assert.equal(purpose, 'read');
        assert.deepEqual(locator, {
          taskId: 'task',
          planId: 'plan',
          revision: 1,
          nodeId: 'node',
          runId: 'run',
        });
        return {
          grant,
          dispose() {
            disposed++;
          },
        };
      },
    },
    native: { open: () => ({ binding: { nativeSessionId: 'native' } }) },
    signal: new AbortController().signal,
    assertCurrent() {},
    history: () => ({
      identity: historyIdentity,
      source: {
        page: async (...args) => {
          reads++;
          return page(...args);
        },
        followReadOnly: (...args) => {
          reads++;
          return follow(...args);
        },
      },
    }),
  });
  const memberRequest = { headers: { cookie: 'synthetic-member' } };
  return {
    conversation,
    memberRequest,
    abort,
    originalFrame,
    raw: (query = {}) => ({
      actorId: 'member',
      spaceId: 'space',
      target,
      sessionId: 'native',
      request: { address: { kind: 'session', sessionId: 'native' }, ...query },
    }),
    setPage(fn) {
      page = fn;
    },
    setFollow(fn) {
      follow = fn;
    },
    deny() {
      allowed = false;
    },
    replaceHistory() {
      historyIdentity = {};
    },
    counts: () => ({ disposed, opened, reads }),
  };
}
test('full original SDK pages pass through only after exact member/scope/session authorization', async () => {
  const h = setup();
  const page = await h.conversation.page(h.memberRequest, h.raw({ throughSeq: 0 }), h.abort.signal);
  assert.equal(page.records, h.originalFrame.records);
  assert.deepEqual(h.counts(), { disposed: 1, opened: 1, reads: 1 });
});
test('original SDK snapshot capability is checked without driving an Agent; unsupported logs keep task controls', async () => {
  const h = setup();
  assert.equal(await h.conversation.available(h.memberRequest, h.raw(), h.abort.signal), true);
  assert.equal(h.counts().disposed, 1);
  h.setFollow(async function* () {
    throw Error('not an SDK log');
  });
  assert.equal(await h.conversation.available(h.memberRequest, h.raw(), h.abort.signal), false);
  h.deny();
  await assert.rejects(
    h.conversation.available(h.memberRequest, h.raw(), h.abort.signal),
    /revoked/,
  );
});
test('actor, space, generation, segment, Session and address substitutions cannot reach the SDK', async () => {
  for (const patch of [
    { actorId: 'other' },
    { spaceId: 'other' },
    { sessionId: 'other' },
    { target: { ...target, generation: 2 } },
    { target: { ...target, segmentId: 'other' } },
    { request: { address: { kind: 'session', sessionId: 'other' }, throughSeq: 0 } },
  ]) {
    const h = setup();
    await assert.rejects(
      h.conversation.page(
        h.memberRequest,
        { ...h.raw({ throughSeq: 0 }), ...patch },
        h.abort.signal,
      ),
    );
    assert.deepEqual(h.counts(), { disposed: 1, opened: 1, reads: 0 });
  }
});
test('revocation while a page is pending prevents content publication and releases the lease', async () => {
  const h = setup();
  h.setPage(async () => {
    h.deny();
    return { records: h.originalFrame.records };
  });
  await assert.rejects(
    h.conversation.page(h.memberRequest, h.raw({ throughSeq: 0 }), h.abort.signal),
    /revoked/,
  );
  assert.equal(h.counts().disposed, 1);
});
test('replacing the original SDK history owner prevents a late page from publishing', async () => {
  const h = setup();
  h.setPage(async () => {
    h.replaceHistory();
    return { records: h.originalFrame.records };
  });
  await assert.rejects(
    h.conversation.page(h.memberRequest, h.raw({ throughSeq: 0 }), h.abort.signal),
  );
  assert.equal(h.counts().disposed, 1);
});
test('follow preserves original full frames and rechecks authority around each delivery', async () => {
  const h = setup();
  const seen = [];
  h.setFollow(async function* () {
    yield h.originalFrame;
    yield { type: 'assistant-stream', frame: { original: true } };
  });
  await assert.rejects(
    h.conversation.follow(
      h.memberRequest,
      h.raw({ assistantStream: true }),
      async (frame) => {
        seen.push(frame);
        h.deny();
      },
      h.abort.signal,
    ),
    /revoked/,
  );
  assert.deepEqual(seen, [h.originalFrame]);
  assert.equal(h.counts().disposed, 1);
});
