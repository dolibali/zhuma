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
const fixture = (kind = 'work') => {
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
    candidates:
      state.done < 2
        ? [
            kind === 'review'
              ? {
                  kind,
                  target: {
                    ...candidate().target,
                    roundId: 'round',
                    artifactVersionId: 'artifact',
                  },
                  expectedReviewVersion: 0,
                  reviewerRef: { id: 'expert', version: target.planId, digest: 'a'.repeat(64) },
                  workflow: flow,
                }
              : candidate(),
          ]
        : [],
    attention: [],
  });
  const protocol = {
    backendId: 'backend',
    actorId: 'member',
    deviceId: 'device',
    canSwitchBackend: () => true,
    pendingWorkflowAccept: async () => undefined,
    rememberWorkflowAccept: async () => undefined,
    forgetWorkflowAccept: async () => undefined,
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
    prepareReview: async ({ candidate: c }) => ({
      target: c.target,
      workflow: c.workflow,
      expectedReviewVersion: c.expectedReviewVersion,
      reviewerRef: { id: c.reviewerRef.id, version: c.reviewerRef.version },
      model: defaults.model,
      workspace: defaults.workspace,
      capabilities: {
        reader: 'zhuma-native-review-read@1',
        resultIntent: 'zhuma-native-review-intent@1',
      },
    }),
  };
  const review = { ...protocol };
  native.startReview = native.start;
  native.readReview = native.read;
  native.stopReview = native.stop;
  const consumer = new NativeMemberWorkflowConsumer({
    protocol,
    native,
    ...(kind === 'review' ? { review } : {}),
    hooks,
    signal: new AbortController().signal,
    pollMs: 250,
  });
  return { consumer, protocol, review, native, hooks, state };
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

for (const other of [undefined, 'scope', 'device'])
  test(`member workflow derive contract: same-scope owner cleanup retires only its tracked Stop projection; other held scope=${other}`, async () => {
    const h = fixture(),
      issued = Promise.withResolvers(),
      reply = Promise.withResolvers();
    const scope = {
        ...target,
        actorId: 'member',
        backendId: randomUUID(),
        nodeId: 'node-0',
        runId: randomUUID(),
        generation: 1,
        segmentId: randomUUID(),
      },
      deviceId = randomUUID();
    const held = { scope, deviceId, resources: 'held' };
    h.protocol.workflowStop = async () => ({
      ...(await h.protocol.workflowStatus()),
      state: 'stopping',
      candidates: [],
      activeWork: [
        held,
        ...(other
          ? [
              {
                ...held,
                ...(other === 'device'
                  ? { deviceId: randomUUID() }
                  : { scope: { ...scope, runId: randomUUID() } }),
              },
            ]
          : []),
      ],
    });
    h.protocol.prepareAccept = async () => ({
      send: async () => {
        issued.resolve();
        return reply.promise;
      },
    });
    h.native.start = async () => assert.fail('Stop closed admission');
    h.native.read = () => ({
      phase: h.state.resources === 'settled' ? 'retired' : 'retiring',
      remote: { scope, deviceId, resources: h.state.resources },
    });
    await h.consumer.start(randomUUID(), { target, defaults });
    await issued.promise;
    await h.consumer.stop(randomUUID());
    reply.resolve({ value: { scope, deviceId, resources: 'held', nodeVersion: 1, runVersion: 1 } });
    await h.consumer.close();
    assert.equal(
      h.consumer.view().remote.activeWork[0].resources,
      'held',
      'Original server snapshot is not forged',
    );
    assert.equal(
      h.consumer.canSwitchBackend(),
      !other,
      'Only exact scope/device cleanup can retire a stale projection',
    );
  });

test('member workflow contract: failed durable locator prevents actual accept dispatch', async () => {
  const h = fixture();
  h.protocol.rememberWorkflowAccept = async () => {
    throw Error('CONTRACT_DURABILITY_FAILURE');
  };
  await h.consumer.start(randomUUID(), { target, defaults });
  await until(() => h.consumer.view().blocked === 'unavailable');
  h.consumer.fence();
  await h.consumer.close();
  assert(!h.state.events.some((v) => v.startsWith('accept:')));
  assert(!h.state.events.some((v) => v.startsWith('native:')));
});
test('member workflow contract: explicit cold unknown reconciliation uses exact old request, never arms or starts recovered handle', async () => {
  const h = fixture(),
    requestId = randomUUID();
  const candidate = (await h.protocol.workflowNext()).candidates[0];
  h.state.calls = 0;
  h.protocol.pendingWorkflowAccept = async () => ({ requestId, candidate });
  h.protocol.recover = async (input) => {
    assert.deepEqual(input, { target: candidate.target, acceptRequestId: requestId });
    h.state.events.push('reconcile-old');
    return { value: { resources: 'held', nodeVersion: 1, runVersion: 1 } };
  };
  h.native.start = async () => assert.fail('A recovered handle has no drive');
  await h.consumer.inspect(target);
  h.consumer.wake();
  assert.deepEqual(h.state.events, [], 'Passive inspect is not reconcile');
  await h.consumer.recover(target);
  assert.equal(h.consumer.view().armed, false);
  assert.equal(h.state.calls, 0);
  assert.deepEqual(h.state.events, ['reconcile-old']);
  assert.equal(h.consumer.canSwitchBackend(), false);
  await h.consumer.close();
  assert.equal(h.consumer.canSwitchBackend(), true);
});

test('member workflow contract: close joins an explicitly issued cold reconcile before original owner cleanup', async () => {
  const h = fixture(),
    issued = Promise.withResolvers(),
    reply = Promise.withResolvers(),
    requestId = randomUUID();
  const candidate = (await h.protocol.workflowNext()).candidates[0];
  h.protocol.pendingWorkflowAccept = async () => ({ requestId, candidate });
  h.protocol.recover = async () => {
    issued.resolve();
    return reply.promise;
  };
  const recovery = h.consumer.recover(target);
  await issued.promise;
  assert.equal(h.consumer.recover(target), recovery, 'Same recovery joins the actual source');
  await assert.rejects(h.consumer.recover({ ...target, taskId: 'other' }), {
    code: 'scope-mismatch',
  });
  await assert.rejects(h.consumer.start(randomUUID(), { target, defaults }), {
    code: 'unavailable',
  });
  h.consumer.fence();
  let joined = false;
  const join = h.consumer.whenAdmissionsIdle().then(() => {
    joined = true;
  });
  const closed = h.consumer.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(joined, false);
  assert.deepEqual(
    h.state.events,
    [],
    'Original owner is still alive for the late recovery handle',
  );
  reply.resolve({ value: { resources: 'held', nodeVersion: 1, runVersion: 1 } });
  await recovery;
  await join;
  await closed;
  assert.deepEqual(h.state.events, ['stop']);
  assert.equal(h.consumer.canSwitchBackend(), true);
});

for (const kind of ['work', 'review']) {
  test(`member workflow contract: ${kind} known ACK retains its cold locator until real owner settlement`, async () => {
    const h = fixture(kind),
      accepted = Promise.withResolvers(),
      release = Promise.withResolvers(),
      drain = Promise.withResolvers();
    h.hooks[kind === 'work' ? 'workAccepted' : 'reviewAccepted'] = async () => {
      accepted.resolve();
      await release.promise;
    };
    h.protocol.forgetWorkflowAccept = async () => h.state.events.push('locator-cleared');
    h.native[kind === 'work' ? 'start' : 'startReview'] = async () =>
      assert.fail('A late accepted source must never start after fence');
    h.native[kind === 'work' ? 'stop' : 'stopReview'] = async () => {
      h.state.events.push('original-cleanup');
      await drain.promise;
      h.state.resources = 'settled';
    };
    await h.consumer.start(randomUUID(), { target, defaults });
    await accepted.promise;
    assert(!h.state.events.includes('locator-cleared'));
    const closing = h.consumer.close();
    release.resolve();
    await until(() => h.state.events.includes('original-cleanup'));
    assert(!h.state.events.includes('locator-cleared'));
    drain.resolve();
    await closing;
    assert.equal(h.state.events.filter((v) => v === 'locator-cleared').length, 1);
  });
  test(`member workflow contract: ${kind} cold reconcile keeps its locator until explicit cleanup`, async () => {
    const h = fixture(kind),
      requestId = randomUUID(),
      candidate = (await h.protocol.workflowNext()).candidates[0],
      carrier = kind === 'work' ? h.protocol : h.review;
    h.protocol.pendingWorkflowAccept = async () => ({ requestId, candidate });
    h.protocol.forgetWorkflowAccept = async () => h.state.events.push('locator-cleared');
    carrier.recover = async (input) => {
      if (kind === 'review')
        assert.deepEqual(input.reviewerRef, {
          id: candidate.reviewerRef.id,
          version: candidate.reviewerRef.version,
        });
      return { value: { resources: 'settled' } };
    };
    carrier.status = async () => ({ resources: 'settled' });
    h.native[kind === 'work' ? 'read' : 'readReview'] = () =>
      assert.fail('Already settled recovery has no active local owner source');
    await h.consumer.recover(target);
    assert.deepEqual(h.state.events, []);
    await h.consumer.close();
    assert.deepEqual(h.state.events, ['locator-cleared']);
    assert.equal(h.consumer.canSwitchBackend(), true);
  });
}
test('member workflow contract: review hook cannot substitute a different expert', async () => {
  const h = fixture('review'),
    original = h.hooks.prepareReview;
  h.hooks.prepareReview = async (input) => ({
    ...(await original(input)),
    reviewerRef: { id: 'other-expert', version: target.planId },
  });
  await h.consumer.start(randomUUID(), { target, defaults });
  await until(() => h.consumer.view().blocked === 'scope-mismatch');
  await h.consumer.close();
  assert(!h.state.events.some((value) => value.startsWith('accept:')));
});
