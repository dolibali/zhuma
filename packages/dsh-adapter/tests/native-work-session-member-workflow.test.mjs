/** Consumer orchestration contracts only. Ports/effects here are synthetic, not native SDK or backend authority proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { NativeMemberWorkflowConsumer } from '../dist/native-work-session-member-workflow.js';
const target = { spaceId: 'team', taskId: 'task', planId: 'plan', revision: 1 };
const defaults = {
  model: { provider: 'contract', model: 'model', maxTokens: 1000 },
  workspace: { kind: 'text-only' },
  capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
};
const flow = { intentId: randomUUID(), generation: 1 };
const fixture = () => {
  const state = { done: 0, events: [], calls: 0, resources: 'held' };
  const candidate = () => ({
    kind: 'work',
    target: { ...target, nodeId: 'node-' + state.done },
    expectedNodeVersion: 1,
    expectedRunVersion: 0,
    mode: 'begin',
    executor: { kind: 'builtin' },
    workflow: flow,
    repairIndex: 0,
  });
  const view = () => ({
    disposition: 'unchanged',
    scope: { ...target, ...flow, actorId: 'member', deviceId: randomUUID() },
    intent: { ...flow, defaults },
    state: state.done >= 2 ? 'completed' : 'running',
    requiresResume: false,
    activeWork: [],
    activeReviews: [],
    candidates: state.done < 2 ? [candidate()] : [],
    attention: [],
  });
  const protocol = {
    backendId: 'backend',
    actorId: 'member',
    deviceId: 'device',
    canSwitchBackend: () => true,
    workflowStatus: async () => view(),
    workflowStart: async () => view(),
    workflowNext: async () => {
      state.calls++;
      return view();
    },
    workflowStop: async () => ({ ...view(), state: 'stopping', candidates: [] }),
    prepareAccept: async (id, input) => ({
      send: async () => {
        state.events.push('accept:' + input.target.nodeId);
        return { value: { resources: 'held', nodeVersion: 1, runVersion: 1 } };
      },
    }),
    status: async (run) => ({ ...run.value, resources: state.resources }),
  };
  const native = {
    canSwitchBackend: () => true,
    start: async () => {
      state.events.push('native:' + state.done);
      state.done++;
      state.resources = 'settled';
    },
    read: () => ({
      phase: state.resources === 'settled' ? 'submitted' : 'retiring',
      remote: {
        resources: state.resources,
        runStatus: state.resources === 'settled' ? 'completed' : 'running',
        ...(state.resources === 'settled' ? { receipt: {} } : {}),
      },
    }),
    refresh: async () => assert.fail('Observation must not renew a terminal drive'),
    stop: async () => {
      state.events.push('stop');
      state.resources = 'settled';
    },
  };
  const hooks = {
    prepareWork: async ({ candidate: c, requestId }) => {
      state.events.push('prepare:' + c.target.nodeId);
      return {
        target: c.target,
        expectedNodeVersion: c.expectedNodeVersion,
        expectedRunVersion: c.expectedRunVersion,
        purpose: 'work',
        mode: c.mode,
        executor: c.executor,
        workflow: c.workflow,
        ...defaults,
      };
    },
    workAccepted: async () => state.events.push('bind'),
  };
  const consumer = new NativeMemberWorkflowConsumer({
    protocol,
    native,
    hooks,
    signal: new AbortController().signal,
    pollMs: 250,
  });
  return { consumer, protocol, native, hooks, state };
};
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('CONTRACT_WAIT_TIMEOUT');
    await new Promise((r) => setTimeout(r, 10));
  }
}
test('member workflow contract: construction and inspection are cold; wake cannot arm or accept', async () => {
  const h = fixture();
  await h.consumer.inspect(target);
  h.consumer.wake();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.consumer.view().armed, false);
  assert.equal(h.state.calls, 0);
  assert.deepEqual(h.state.events, []);
  await h.consumer.close();
});
test('member workflow contract: coalesced wake uses prepare→actual accept→bind→original start once per ready candidate', async () => {
  const h = fixture();
  await h.consumer.start(randomUUID(), { target, defaults });
  for (let i = 0; i < 50; i++) h.consumer.wake();
  await until(() => h.state.done === 2 && !h.consumer.view().armed);
  await h.consumer.close();
  assert.deepEqual(h.state.events, [
    'prepare:node-0',
    'accept:node-0',
    'bind',
    'native:0',
    'prepare:node-1',
    'accept:node-1',
    'bind',
    'native:1',
  ]);
  assert.equal(h.consumer.canSwitchBackend(), true);
});
test('member workflow contract: Stop receives the late genuine source handle and never starts its Agent before actual cleanup', async () => {
  const h = fixture(),
    issued = Promise.withResolvers(),
    reply = Promise.withResolvers(),
    drained = Promise.withResolvers();
  h.protocol.prepareAccept = async () => ({
    send: async () => {
      h.state.events.push('issued');
      issued.resolve();
      return reply.promise;
    },
  });
  h.native.start = async () => assert.fail('late accepted work must not start');
  h.native.stop = async () => {
    h.state.events.push('original-stop');
    await drained.promise;
    h.state.resources = 'settled';
  };
  await h.consumer.start(randomUUID(), { target, defaults });
  await issued.promise;
  await h.consumer.stop(randomUUID());
  assert.equal(h.consumer.view().armed, false);
  assert.equal(h.consumer.canSwitchBackend(), false);
  reply.resolve({ value: { resources: 'held', nodeVersion: 1, runVersion: 1 } });
  await until(() => h.state.events.includes('original-stop'));
  assert.equal(h.consumer.canSwitchBackend(), false);
  drained.resolve();
  await h.consumer.close();
  assert.equal(h.consumer.canSwitchBackend(), true);
  assert.equal(h.state.events.filter((v) => v === 'original-stop').length, 1);
  assert.equal(h.state.events.includes('bind'), false);
});

test('member workflow contract: current auth closure cannot block the original cleanup after all late accepts are joined', async () => {
  const h = fixture(),
    issued = Promise.withResolvers(),
    reply = Promise.withResolvers(),
    drain = Promise.withResolvers();
  h.protocol.prepareAccept = async () => ({
    send: async () => {
      issued.resolve();
      return reply.promise;
    },
  });
  h.native.start = async () => assert.fail('closed admission');
  h.protocol.status = async () => {
    throw Error('CONTRACT_CURRENT_AUTH_CLOSED');
  };
  h.native.stop = async () => {
    h.state.events.push('cleanup-started');
    void drain.promise.then(() => {
      h.state.resources = 'settled';
    });
    throw Error('CONTRACT_STOP_AUTH_CLOSED');
  };
  await h.consumer.start(randomUUID(), { target, defaults });
  await issued.promise;
  h.consumer.fence();
  let joined = false;
  const joining = h.consumer.whenAdmissionsIdle().then(() => {
    joined = true;
  });
  const closing = h.consumer.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(joined, false);
  reply.resolve({ value: { resources: 'held', nodeVersion: 1, runVersion: 1 } });
  await joining;
  await until(() => h.state.events.includes('cleanup-started'));
  assert.equal(h.consumer.canSwitchBackend(), false);
  drain.resolve();
  await closing;
  assert.equal(h.consumer.canSwitchBackend(), true);
});
