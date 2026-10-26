/** Bridge + original Service/WeakMap tickets/queue/JSON contracts. Member,
 * configuration and A's native dispatch/Stop producers are explicit fixtures.
 * This does not prove login, Agent execution, native drain or a real A Host port.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkflowBridge } from '../dist/native-work-session-workflow-bridge.js';
import { openWorkflowContract } from './execution-workflow-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { checked } from './execution-service-run-fixture.mjs';
import { turns, ok } from './native-work-session-workflow-fixture.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-workflow-bridge-service-'));
  const h = await openWorkflowContract(root);
  const source = new AbortController();
  const calls = { begin: [], stop: [] };
  const opened = [];
  let prepare = async () => {};
  const committed = Promise.withResolvers();
  const bridge = createNativeWorkflowBridge({
    execution: h.service,
    signal: source.signal,
    runs: {
      async beginWorkflowRun(original, ticket, wait) {
        calls.begin.push({ original, ticket });
        await prepare(ticket, wait);
        ticket.check();
        const input = h.beginBody(ticket);
        const clone = await h.service.startRun(original, input, { ...ticket });
        assert.equal(clone.ok, false);
        assert.equal(clone.error.code, 'workflow-start-ticket-invalid');
        const decision = await h.service.startRun(original, input, ticket);
        if (!decision.ok) {
          committed.resolve(decision);
          return decision;
        }
        const openedRun = await h.authorities.open(
          original,
          { ...h.locate(ticket.reservation.nodeId), runId: decision.value.run.attempt.id },
          'drive',
        );
        opened.push(openedRun);
        committed.resolve(decision);
        // No native event is fabricated. The dispatch producer is unknown;
        // the original Service Run remains reserved/held in its real JSON row.
        return ok({ dispatch: 'unknown' });
      },
      async stop(original, command) {
        calls.stop.push({ original, command });
        const requested = await h.service.stopRun(original, command);
        if (!requested.ok) return requested;
        // Deliberately untrusted producer label. No stopped/settled event or
        // migration proof is injected; D's original view must stay stopping.
        return ok({ status: 'stopped' });
      },
    },
  });
  t.after(async () => {
    bridge.fence();
    for (const run of opened) run.dispose();
    await h.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...h,
    root,
    bridge,
    calls,
    opened,
    committed,
    prepare(handler) {
      prepare = handler;
    },
  };
}

test('bridge Service contract: genuine tickets reach the final original Run put; unknown dispatch and duplicate attach never start twice', async (t) => {
  const h = await setup(t);
  const view = await h.start();
  await h.bridge.attach(h.request, view);
  const decision = checked(await h.committed.promise);
  await turns();
  assert.equal(h.calls.begin.length, 1);
  assert.equal(h.calls.begin[0].original, h.request);
  const permit = h.calls.begin[0].ticket;
  assert.equal(decision.run.attempt.id, permit.reservation.newRunId);
  assert.equal(decision.run.segmentId, permit.reservation.newSegmentId);
  assert.equal(h.row('first').nativeExecution.runs.length, 1);
  assert.equal(permit.signal.aborted, true, 'the consumed permit is disposable');
  h.authorities.assertGrant(h.opened[0].grant, 'send');
  const nextRequest = Object.freeze({ headers: {} });
  h.members.set(nextRequest, 'chen');
  const replay = checked(await h.service.startWorkflowExecution(nextRequest, h.startBody()));
  assert.equal(replay.disposition, 'replayed');
  await h.bridge.attach(nextRequest, replay);
  h.setWorkbench((current) => current);
  await turns();
  assert.equal(h.calls.begin.length, 1);
  assert.equal(h.row('first').nativeExecution.runs.length, 1);
  const stopped = checked(await h.bridge.stop(h.request, h.control(view, 'bridge-stop')));
  assert.equal(h.calls.stop.length, 1);
  assert.equal(stopped.state, 'stopping');
  assert.equal(h.row('first').nativeExecution.runs[0].resources, 'held');
  assert.equal(h.row('first').nativeExecution.runs[0].attempt.stopPhase, 'requested');
});

test('bridge Service contract: unauthorized, stale and conflicting Stop preserve a pending genuine ticket and its eventual original Run', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  const h = await setup(t);
  h.prepare(async () => {
    entered.resolve();
    await release.promise;
  });
  const view = await h.start();
  await h.bridge.attach(h.request, view);
  await entered.promise;
  const ticket = h.calls.begin[0].ticket;
  const before = await businessHashes(h.root);
  const unauthorized = Object.freeze({ headers: {} });
  h.members.set(unauthorized, 'outside');
  for (const [request, command, code] of [
    [unauthorized, h.control(view, 'wrong-controller'), 'workflow-authority-denied'],
    [
      h.request,
      { ...h.control(view, 'old-control'), generation: view.intent.generation + 1 },
      'workflow-stale-generation',
    ],
    [
      h.request,
      h.control(view, view.intent.commandReceipts[0].requestId),
      'workflow-idempotency-mismatch',
    ],
  ]) {
    const refused = await h.bridge.stop(request, command);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, code);
    assert.equal(ticket.signal.aborted, false);
    ticket.check();
    assert.deepEqual(await businessHashes(h.root), before);
  }
  assert.equal(h.calls.stop.length, 0);
  release.resolve();
  const decision = checked(await h.committed.promise);
  assert.equal(decision.run.attempt.id, ticket.reservation.newRunId);
  assert.equal(h.row(ticket.reservation.nodeId).nativeExecution.runs.length, 1);
});
