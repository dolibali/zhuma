/** Isolated bridge port contracts, not Service authorization, SDK or desktop evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeWorkflowBridge } from '../dist/native-work-session-workflow-bridge.js';
import { workflowFixture, turns, ok, fail } from './native-work-session-workflow-fixture.mjs';

test('backend switch fence contract: armed empty workflow and pending claim stay occupied until an authenticated stopped view settles', async () => {
  const h = workflowFixture(),
    pending = Promise.withResolvers();
  assert.equal(h.bridge.canSwitchBackend(), true);
  h.setClaim(() => pending.promise);
  const attaching = h.bridge.attach(h.original, h.view());
  await turns();
  assert.equal(h.bridge.canSwitchBackend(), false);
  pending.resolve(ok(h.claim()));
  await attaching;
  await turns();
  const before = structuredClone(h.calls);
  for (let index = 0; index < 20; index++) assert.equal(h.bridge.canSwitchBackend(), false);
  assert.deepEqual(h.calls, before, 'pure checks neither claim nor stop');
  h.setRead(() => ok(h.view({ state: 'paused', intent: { ...h.intent, status: 'paused' } })));
  assert.equal((await h.bridge.stop(h.original, h.control())).ok, true);
  await turns();
  assert.equal(h.bridge.canSwitchBackend(), true);
  await h.bridge.close();
});

test('backend switch fence contract: a failed claim cannot erase the observed running intent', async () => {
  const h = workflowFixture();
  h.setClaim(() => fail('workflow-authority-denied'));
  await assert.rejects(h.bridge.attach(h.original, h.view()), {
    code: 'workflow-authority-denied',
  });
  await turns();
  assert.equal(h.bridge.canSwitchBackend(), false);
  assert.equal(h.calls.begin.length, 0);
  await h.bridge.close();
});

test('bridge contract: repeated attach/wakes retain the first original request and do not cancel or repeat an in-flight ticket', async () => {
  const h = workflowFixture(),
    gate = Promise.withResolvers();
  const permit = h.ticket('produce');
  h.offered.push([permit]);
  h.setBegin(async () => {
    await gate.promise;
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await h.bridge.attach({ headers: { cookie: 'equivalent-new-request' } }, h.view());
  h.offered.push([permit]);
  const before = h.calls.claim.length;
  for (let index = 0; index < 30; index++) h.emit();
  await turns();
  assert.equal(h.calls.claim.length, before + 1);
  assert.equal(h.calls.begin.length, 1);
  assert.equal(h.calls.begin[0].request, h.original);
  assert.equal(h.calls.begin[0].ticket, permit);
  assert.equal(permit.signal.aborted, false);
  gate.resolve();
  await h.bridge.close();
});

test('bridge contract: a blocked preparation and a busy workspace do not hold the other tickets; busy retries require another wake', async () => {
  const h = workflowFixture(),
    gate = Promise.withResolvers();
  h.offered.push(['a', 'b', 'c'].map((name) => h.ticket(name)));
  let busy = true;
  h.setBegin(async (_request, ticket) => {
    if (ticket.reservation.nodeId === 'a') await gate.promise;
    if (ticket.reservation.nodeId === 'b' && busy) return fail('run-workspace-busy');
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await turns();
  assert.deepEqual(
    h.calls.begin.map((call) => call.ticket.reservation.nodeId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(h.calls.deferred, ['request-b']);
  const before = h.calls.claim.length;
  await turns();
  assert.equal(h.calls.claim.length, before);
  busy = false;
  h.offered.push([h.ticket('b')]);
  h.emit();
  await turns();
  assert.equal(h.calls.begin.length, 4);
  gate.resolve();
  await h.bridge.close();
});

test('bridge contract: unknown receipt, thrown dispatch and non-busy refusal preserve IDs without redispatch or false terminal events', async () => {
  for (const outcome of ['unknown', 'throws', 'refused']) {
    const h = workflowFixture();
    h.offered.push([h.ticket('produce')]);
    h.setBegin(async () => {
      if (outcome === 'throws') throw Error('contract admission outcome unknown');
      if (outcome === 'refused') return fail('run-authority-unavailable');
      return ok({ dispatch: 'unknown' });
    });
    await h.bridge.attach(h.original, h.view());
    await turns();
    h.offered.push([h.ticket('produce')]);
    h.emit();
    await turns();
    assert.equal(h.calls.begin.length, 1);
    assert.equal(h.calls.begin[0].ticket.reservation.newRunId, 'run-produce');
    assert.equal(h.calls.deferred.length, 0);
    assert.equal(h.calls.stop.length, 0);
    await h.bridge.close();
  }
});

test('bridge contract: a busy permit already yielded by D can receive a fresh permit on a later wake', async () => {
  const h = workflowFixture();
  let blocked = true;
  h.offered.push([h.ticket('produce')]);
  h.setBegin(async (_request, ticket) => {
    if (blocked) {
      ticket.deferBusy();
      return fail('run-workspace-busy');
    }
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await turns();
  assert.deepEqual(h.calls.deferred, ['request-produce']);
  blocked = false;
  h.offered.push([h.ticket('produce')]);
  h.emit();
  await turns();
  assert.equal(h.calls.begin.length, 2);
  await h.bridge.close();
});

test('bridge contract: cold requires-resume, inactive and completed projections never arm native work', async () => {
  const h = workflowFixture();
  await h.bridge.attach(h.original, h.view({ requiresResume: true, state: 'requires-resume' }));
  await h.bridge.attach(h.original, h.view({ intent: undefined, state: 'inactive' }));
  await h.bridge.attach(h.original, h.view({ state: 'completed' }));
  await turns();
  assert.equal(h.calls.claim.length, 0);
  assert.equal(h.calls.begin.length, 0);
  assert.equal(h.calls.read.length, 0);
  await h.bridge.close();
});

test('bridge contract: revocation cuts pending admission and close joins it after the original owner is allowed to drain', async () => {
  const h = workflowFixture(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let admitted = false;
  h.offered.push([h.ticket('produce')]);
  h.setBegin(async (_request, ticket, wait) => {
    entered.resolve();
    await release.promise;
    wait.throwIfAborted();
    ticket.check();
    admitted = true;
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await entered.promise;
  h.lifetime.abort();
  let closed = false;
  const closing = h.bridge.close().then(() => {
    closed = true;
  });
  await turns();
  assert.equal(closed, false);
  assert.equal(h.calls.begin[0].wait.aborted, true);
  release.resolve(); // Explicit original owner completion, not a fabricated drain receipt.
  await closing;
  assert.equal(admitted, false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.calls.stop.length, 0);
});

test('bridge contract: a late claim after fence is disposed and cannot admit a native Run', async () => {
  const h = workflowFixture(),
    gate = Promise.withResolvers();
  const permit = h.ticket('produce');
  h.setClaim(() => gate.promise);
  const attaching = h.bridge.attach(h.original, h.view());
  await turns(1);
  h.bridge.fence();
  const rejected = assert.rejects(attaching);
  gate.resolve(ok(h.claim([permit])));
  await rejected;
  await h.bridge.close();
  assert.equal(permit.signal.aborted, true);
  assert.equal(h.calls.begin.length, 0);
  assert.equal(h.calls.fences > 0, true);
});

test('bridge contract: Stop joins a reserved preparation that has not created any Run', async () => {
  const h = workflowFixture(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let runPuts = 0;
  h.offered.push([h.ticket('produce')]);
  h.setBegin(async (_request, ticket) => {
    entered.resolve();
    await release.promise;
    ticket.check();
    runPuts++;
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await entered.promise;
  let stopped = false;
  const stopping = h.bridge.stop(h.original, h.control()).then((value) => {
    stopped = true;
    return value;
  });
  await turns();
  assert.equal(stopped, false);
  assert.equal(h.calls.stop.length, 0);
  h.setState('paused'); // Injected D projection only; this contract is not native drain proof.
  release.resolve();
  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'paused');
  assert.equal(runPuts, 0);
  await h.bridge.close();
});

test('bridge contract: active Stop uses the real Run generation and segment; a pending owner never becomes paused from its label', async () => {
  const h = workflowFixture();
  const row = h.activeRun();
  await h.bridge.attach(h.original, h.view());
  const result = await h.bridge.stop(h.original, h.control());
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'stopping');
  assert.equal(h.calls.stop.length, 1);
  const { command, wait } = h.calls.stop[0];
  assert.equal(command.generation, 1);
  assert.notEqual(command.generation, h.intent.generation);
  assert.equal(command.segmentId, 'actual-segment');
  assert.equal(command.expectedNodeVersion, row.command.version);
  assert.equal(command.expectedRunVersion, row.nativeExecution.version);
  assert.equal(wait.aborted, false);
  assert.equal(command.requestId, 'stop-contract');
  await h.bridge.close();
});

test('bridge contract: denied, stale, conflicting and capacity-refused Stop cannot fence the retained owner', async () => {
  const h = workflowFixture(),
    gate = Promise.withResolvers();
  const permit = h.ticket('produce');
  h.offered.push([permit]);
  h.setBegin(async () => {
    await gate.promise;
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  for (const code of [
    'workflow-authority-denied',
    'workflow-stale-generation',
    'workflow-conflict',
    'workflow-capacity',
  ]) {
    h.setControl(async () => fail(code));
    const result = await h.bridge.stop(
      { headers: { cookie: 'refused-contract-caller' } },
      h.control(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(permit.signal.aborted, false);
  }
  assert.equal(h.calls.stop.length, 0);
  gate.resolve();
  await h.bridge.close();
});

test('bridge contract: a slow original stop cannot keep the other active Runs from receiving Stop', async () => {
  const h = workflowFixture(),
    gate = Promise.withResolvers();
  h.activeRun(2);
  await h.bridge.attach(h.original, h.view());
  h.setStop(async (_request, command) => {
    if (command.nodeId === 'produce') await gate.promise;
    return ok({ status: 'pending' });
  });
  const stopping = h.bridge.stop(h.original, h.control());
  await turns();
  assert.deepEqual(
    h.calls.stop.map((call) => call.command.nodeId),
    ['produce', 'consume'],
  );
  gate.resolve();
  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'stopping');
  await h.bridge.close();
});

test('bridge contract: an accepted old Stop cannot stop a newly resumed generation during its later fact read', async () => {
  const h = workflowFixture();
  h.activeRun();
  await h.bridge.attach(h.original, h.view());
  h.setRead(async () =>
    ok(
      h.view({
        intent: { ...h.intent, generation: h.intent.generation + 1 },
        state: 'running',
      }),
    ),
  );
  const result = await h.bridge.stop(h.original, h.control());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'workflow-stale-generation');
  assert.equal(h.calls.stop.length, 0);
  await h.bridge.close();
});

test('bridge contract: one bridge owns the same Service until a successful joined close', async () => {
  const h = workflowFixture();
  assert.throws(
    () =>
      createNativeWorkflowBridge({ execution: h.execution, runs: h.runs, signal: h.host.signal }),
    { code: 'workflow-owner-unavailable' },
  );
  const closing = h.bridge.close();
  assert.equal(h.bridge.close(), closing);
  await closing;
  const next = createNativeWorkflowBridge({
    execution: h.execution,
    runs: h.runs,
    signal: h.host.signal,
  });
  await next.close();
});

test('bridge contract: cleanup failure remains visible and does not release an uncertain owner identity', async () => {
  const h = workflowFixture();
  await h.bridge.attach(h.original, h.view());
  h.failUnsubscribe();
  await assert.rejects(h.bridge.close(), AggregateError);
  assert.throws(
    () =>
      createNativeWorkflowBridge({ execution: h.execution, runs: h.runs, signal: h.host.signal }),
    { code: 'workflow-owner-unavailable' },
  );
});

test('bridge review callback contract: forwards each exact original claim without waiting for model work', async () => {
  const calls = [];
  const h = workflowFixture({
    consumeClaim: (original, claim) => {
      calls.push({ original, claim });
    },
  });
  const claim = h.claim([]);
  h.setClaim(async () => ok(claim));
  await h.bridge.attach(h.original, h.view());
  await turns();
  assert.equal(calls[0].original, h.original);
  assert.equal(calls[0].claim, claim);
  assert.equal(h.calls.begin.length, 0);
  await h.bridge.close();
});

test('bridge review callback contract: a refused review cannot fence the same claim author tickets', async () => {
  const h = workflowFixture({
    consumeClaim() {
      throw Error('explicit review capacity refusal');
    },
  });
  const permit = h.ticket('produce');
  h.offered.push([permit]);
  const finish = Promise.withResolvers();
  h.setBegin(async () => {
    await finish.promise;
    return ok({ dispatch: 'received' });
  });
  await h.bridge.attach(h.original, h.view());
  await turns();
  assert.equal(h.calls.begin.length, 1);
  assert.equal(h.calls.fences, 0);
  assert.equal(permit.signal.aborted, false);
  finish.resolve();
  await h.bridge.close();
});
