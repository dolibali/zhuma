/** Host handle/transport contracts with synthetic authority/native ports; no actual Agent/model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostNativeChat } from '../dist/host-native-chat.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
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
  const control = new AbortController(),
    settled = Promise.withResolvers();
  const binding = {
    scope: { ...target, actorId: 'member' },
    nativeSessionId: 'native',
    nativeAgentId: 'native',
    selection: {},
  };
  const grant = {
    actorId: 'member',
    spaceId: 'space',
    origin: binding,
    signal: control.signal,
    chatEpoch: 1,
  };
  let opens = 0,
    releases = 0,
    epoch = 0,
    stops = 0;
  const sends = [];
  let fault,
    unknownSlot = false;
  const valid = new WeakSet();
  const authorities = {
    async openRead() {
      const ticket = { ...grant, chatEpoch: epoch, signal: new AbortController().signal };
      valid.add(ticket);
      return {
        grant: ticket,
        dispose() {
          releases++;
          valid.delete(ticket);
        },
      };
    },
    assertReadGrant(value) {
      assert(valid.has(value));
    },
    async observeSendEligibility() {
      return { eligible: true };
    },
    async open() {
      opens++;
      epoch = 1;
      return { grant, dispose() {} };
    },
    assertGrant(value) {
      assert.equal(value, grant);
      control.signal.throwIfAborted();
    },
    whenSettled(value) {
      assert.equal(value, grant);
      return settled.promise;
    },
    async stop(value) {
      assert.equal(value, grant);
      stops++;
      control.abort();
      return 'pending';
    },
    async close() {
      control.abort();
      await settled.promise;
    },
  };
  const native = {
    open: () => ({ binding, status: 'idle' }),
    async send(value, request) {
      assert.equal(value, grant);
      sends.push(request);
      if (fault === 'conflict') throw new NativeWorkError('idempotency-mismatch');
      if (fault === 'discarded')
        return { ...request, messageId: request.requestId, status: 'discarded' };
      if (fault === 'unknown') {
        unknownSlot = true;
        return { ...request, messageId: request.requestId, status: 'unknown' };
      }
      return { ...request, messageId: request.requestId, status: 'received' };
    },
  };
  const chat = createHostNativeChat({
    authorities,
    native,
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  const raw = (request = {}, patch = {}) => ({
    actorId: 'member',
    spaceId: 'space',
    sessionId: 'native',
    target,
    request,
    ...patch,
  });
  const openView = native.open;
  native.open = (...args) => {
    if (unknownSlot) throw new NativeWorkError('migration-not-ready');
    return openView(...args);
  };
  return {
    chat,
    raw,
    sends,
    settled,
    control,
    setFault(value) {
      fault = value;
    },
    counts: () => ({ opens, releases, stops }),
  };
}
test('passive status opens only a read ticket and send eligibility, never a chat epoch', async () => {
  const h = setup();
  assert.deepEqual(await h.chat.status({}, h.raw()), {
    chatEpoch: 0,
    status: 'idle',
    eligible: true,
    canStop: false,
  });
  assert.deepEqual(h.counts(), { opens: 0, releases: 1, stops: 0 });
  h.settled.resolve();
  await h.chat.close();
});
test('two explicit messages preserve SDK request IDs and reuse one retained send grant', async () => {
  const h = setup();
  await h.chat.send({}, h.raw({ requestId: 'sdk-first', text: '第一条' }));
  await h.chat.send({}, h.raw({ requestId: 'sdk-second', text: '第二条' }));
  assert.equal(h.counts().opens, 1);
  assert.deepEqual(h.sends, [
    { requestId: 'sdk-first', text: '第一条' },
    { requestId: 'sdk-second', text: '第二条' },
  ]);
  assert.equal(h.chat.canSwitchBackend(), false);
  h.settled.resolve();
  await h.chat.close();
});
test('pending stop retains the Host handle until the original issuer confirms physical settlement', async () => {
  const h = setup();
  await h.chat.send({}, h.raw({ requestId: 'sdk-first', text: '第一条' }));
  assert.equal((await h.chat.stop({}, h.raw())).status, 'pending');
  assert.equal(h.control.signal.aborted, true);
  assert.equal(h.chat.canSwitchBackend(), false);
  let closed = false;
  const closing = h.chat.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  h.settled.resolve();
  await closing;
  assert.equal(h.chat.canSwitchBackend(), true);
});
test('substituted session/scope/actor cannot reserve any native send owner', async () => {
  for (const patch of [
    { sessionId: 'other' },
    { actorId: 'other' },
    { target: { ...target, generation: 2 } },
  ]) {
    const h = setup();
    await assert.rejects(h.chat.send({}, h.raw({ requestId: 'sdk', text: 'text' }, patch)));
    assert.equal(h.counts().opens, 0);
    assert.equal(h.sends.length, 0);
    h.settled.resolve();
    await h.chat.close();
  }
});

for (const fault of ['conflict', 'discarded'])
  test(`a rejected ${fault} send does not prevent fresh status or stopping the retained owner`, async () => {
    const h = setup();
    try {
      await h.chat.send({}, h.raw({ requestId: 'original', text: 'original' }));
      h.setFault(fault);
      await assert.rejects(h.chat.send({}, h.raw({ requestId: 'original', text: 'changed' })));
      const before = h.counts().releases;
      const state = await h.chat.status({}, h.raw());
      assert.equal(state.canStop, true);
      assert.equal(
        h.counts().releases,
        before + 1,
        'status acquires and releases a fresh read ticket',
      );
      assert.equal((await h.chat.stop({}, h.raw())).status, 'pending');
      assert.equal(
        h.chat.canSwitchBackend(),
        false,
        'a failed admission or aborted signal is not physical drain',
      );
    } finally {
      h.settled.resolve();
      await h.chat.close();
    }
  });

test('after a rejected unknown receipt the fresh native read still fences the unknown slot', async () => {
  const h = setup();
  try {
    await h.chat.send({}, h.raw({ requestId: 'original', text: 'original' }));
    h.setFault('unknown');
    await assert.rejects(
      h.chat.send({}, h.raw({ requestId: 'later', text: 'later' })),
      (error) => error.code === 'delivery-unknown',
    );
    await assert.rejects(
      h.chat.status({}, h.raw()),
      (error) => error.code === 'migration-not-ready',
    );
    assert.equal(h.chat.canSwitchBackend(), false);
    assert.equal(h.counts().stops, 0);
  } finally {
    h.settled.resolve();
    await h.chat.close();
  }
});
