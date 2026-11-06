/** Host handle/transport contracts with synthetic authority/native ports; no actual Agent/model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostNativeChat } from '../dist/host-native-chat.js';
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
  return { chat, raw, sends, settled, control, counts: () => ({ opens, releases, stops }) };
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
