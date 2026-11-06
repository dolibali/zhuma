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
    actorId: 'member',
    spaceId: 'space',
    chatEpoch: 0,
    origin: { scope, nativeSessionId: 'native' },
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
      assertReadGrant(value) {
        assert.equal(value, grant);
        grant.assertCurrent();
      },
      async openRead(request, locator) {
        grant.assertCurrent();
        opened++;
        assert.equal(request, memberRequest);
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
    async transition() {},
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

test('revoked epoch uses a fresh passive ticket before requesting a new SDK physical generation', async () => {
  let epoch = 0,
    opens = 0,
    releases = 0;
  const tickets = [];
  const frame = {
    type: 'snapshot',
    header: { id: 'native' },
    cursor: -1,
    records: [],
    hasMore: false,
    assistantStream: { revision: 0 },
  };
  const source = {};
  const conversation = createHostNativeConversation({
    authorities: {
      async openRead() {
        opens++;
        const control = new AbortController();
        const grant = {
          actorId: 'member',
          spaceId: 'space',
          chatEpoch: epoch,
          signal: control.signal,
          origin: { scope: { ...target, actorId: 'member' }, nativeSessionId: 'native' },
        };
        tickets.push({ grant, control });
        return {
          grant,
          dispose() {
            releases++;
            control.abort();
          },
        };
      },
      assertReadGrant(grant) {
        grant.signal.throwIfAborted();
        assert.equal(grant.chatEpoch, epoch);
      },
    },
    native: { open: () => ({ binding: { nativeSessionId: 'native' } }) },
    signal: new AbortController().signal,
    assertCurrent() {},
    async transition() {
      assert.equal(epoch, 1);
    },
    history: () => ({
      identity: source,
      source: {
        async *followReadOnly(_query, signal) {
          yield frame;
          if (!signal.aborted)
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true }),
            );
        },
      },
    }),
  });
  const seen = [];
  await conversation.follow(
    {},
    {
      actorId: 'member',
      spaceId: 'space',
      sessionId: 'native',
      target,
      request: { address: { kind: 'session', sessionId: 'native' } },
    },
    async (value, authority) => {
      authority.throwIfAborted();
      seen.push(value);
      if (value.type === 'snapshot') {
        epoch = 1;
        tickets[0].control.abort();
      } else assert.equal(opens, 2);
    },
    new AbortController().signal,
  );
  assert.deepEqual(seen, [frame, { type: 'history-restart', chatEpoch: 1 }]);
  assert.equal(releases, 2);
});
