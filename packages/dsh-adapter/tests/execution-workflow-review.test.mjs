import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { checked, refused, open } from './execution-service-run-fixture.mjs';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { host } from './execution-review-service-fixture.mjs';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { reviewDescriptors } from './execution-review-composition-fixture.mjs';
import { workflowReviewRequestId } from '../dist/execution-workflow-reviews.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';

// Real original Service, queue and DSH JSON. Member, model, issuer/cut/drain
// remain explicit contracts; these tests do not run A's automatic pump or SDK.
function control(h, requestId, view = h.workflowView) {
  return {
    ...h.workflowLocation,
    requestId,
    intentId: view.intent.intentId,
    generation: view.intent.generation,
  };
}
function claim(h, view = h.workflowView) {
  const { requestId: _request, ...body } = control(h, 'unused', view);
  return h.service.claimWorkflowExecution(h.request, body);
}
test('workflow review: only the original retained claim/request can reserve automatic review; old manual API stays independent', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  for (const forged of [undefined, { ...h.workflowClaim }, {}]) {
    h.resetCounts();
    refused(
      await h.service.prepareExpertReview(
        h.request,
        { ...h.query, configurationId: h.composition.configurationId },
        forged,
      ),
      'workflow-authority-denied',
    );
    assert.equal(h.counters.nodes, 0);
  }
  const other = Object.freeze({ headers: {} });
  h.members.set(other, 'chen');
  refused(
    await h.service.prepareExpertReview(
      other,
      { ...h.query, configurationId: h.composition.configurationId },
      h.workflowClaim,
    ),
    'workflow-authority-denied',
  );
  const replay = checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...h.query, configurationId: h.composition.configurationId },
      h.workflowClaim,
    ),
  );
  assert.equal(replay.disposition, 'replayed');
  const live = checked(await h.service.openExpertReviewDrive(h.request, h.locator));
  live.dispose();
  assert.equal(h.read().rounds[0].ballots.length, 0);
});

test('workflow review: the original Host qualifies an independent review budget while the author selection stays frozen', async (t) => {
  let qualifications = 0;
  const h = await host(t, {
    reviewerIds: ['qa'],
    assertReviewConfiguration(_memberId, _spaceId, _node, composition) {
      qualifications++;
      assert.equal(composition.payload.model.provider, 'contract');
      assert.equal(composition.payload.model.model, 'review-contract');
      // Explicit source contract, not real Host/model/runtime qualification.
      return undefined;
    },
  });
  const location = { ...h.locate(), spaceId: 'north' };
  delete location.nodeId;
  const authorModel = { provider: 'contract', model: 'review-contract', maxTokens: 4096 };
  const view = checked(
    await h.service.startWorkflowExecution(h.request, {
      ...location,
      requestId: 'start-independent-review-budget',
      defaults: { model: authorModel, tools: 'text-only', workspace: { kind: 'text-only' } },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    }),
  );
  const retained = checked(
    await h.service.claimWorkflowExecution(h.request, {
      ...location,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    }),
  );
  const query = retained.reviewCandidates[0];
  const preparation = checked(await h.service.readExpertReviewPreparation(h.request, query));
  const composition = freezeExecutionReviewComposition({
    ...preparation,
    model: { ...authorModel, maxTokens: 16_384 },
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  const { attempt } = checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...query, configurationId: composition.configurationId },
      retained,
    ),
  );
  const frozen = JSON.stringify(composition);
  const substituted = freezeExecutionReviewComposition({
    ...preparation,
    model: { ...authorModel, maxTokens: 8192 },
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  assert.notEqual(substituted.configurationId, composition.configurationId);
  h.resetCounts();
  refused(
    await h.service.admitExpertReview(h.request, {
      ...h.locate(),
      spaceId: 'north',
      runId: attempt.scope.runId,
      expectedAttemptVersion: attempt.version,
      composition: substituted,
    }),
    'review-target-stale',
  );
  assert.equal(readExecutionReviewState(h.read()).attempts[0].status, 'prepared');
  assert.equal(
    readExecutionReviewState(h.read()).attempts[0].configurationId,
    composition.configurationId,
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  refused(
    await h.service.admitExpertReview(h.request, {
      ...h.locate(),
      spaceId: 'north',
      runId: attempt.scope.runId,
      expectedAttemptVersion: attempt.version + 1,
      composition,
    }),
    'review-conflict',
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  qualifications = 0;
  h.resetCounts();
  const admitted = checked(
    await h.service.admitExpertReview(h.request, {
      ...h.locate(),
      spaceId: 'north',
      runId: attempt.scope.runId,
      expectedAttemptVersion: attempt.version,
      composition,
    }),
  );
  assert.equal(admitted.attempt.status, 'requested');
  assert.equal(admitted.attempt.composition.payload.model.maxTokens, 16_384);
  assert.equal(qualifications, 1);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
  assert.deepEqual(
    checked(await h.service.readWorkflowExecution(h.request, location)).intent.defaults.model,
    authorModel,
  );
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(admitted.attempt.nativeSessionId, undefined);
  assert.equal(JSON.stringify(composition), frozen);
});

test('workflow review: independent composition must use the same explicit workflow model selection', async (t) => {
  for (const change of [
    { provider: 'different-provider' },
    { model: 'different-model' },
    { reasoningEffort: 'different-reasoning' },
  ]) {
    const h = await nativeReviewHost(t, {
      workflow: {},
      prepareOnly: true,
      model: { provider: 'contract', model: 'review-contract', maxTokens: 16_384, ...change },
    });
    h.resetCounts();
    refused(
      await h.service.admitExpertReview(h.request, {
        ...h.locator,
        expectedAttemptVersion: h.attempt.version,
        composition: h.composition,
      }),
      'workflow-authority-denied',
    );
    assert.equal(readExecutionReviewState(h.read()).attempts[0].status, 'prepared');
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  }
});

test('workflow review: original wakeup projects metadata candidates while author IDs remain unchanged', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, reviewerIds: ['qa', 'qa-two'] });
  assert.equal(h.workflowClaim.reviewCandidates.length, 1);
  assert.equal(h.workflowClaim.reviewCandidates[0].reviewerRef.id, 'qa');
  assert.equal(checked(await claim(h)).reviewCandidates.length, 0);
  let wakes = 0;
  const unsubscribe = h.workflowClaim.onChange(() => {
    wakes++;
  });
  t.after(unsubscribe);
  h.hooks.retire = () => ({ status: 'pending' });
  assert.equal(
    checked(await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant)).cleanup,
    'pending',
  );
  const held = checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation));
  assert.deepEqual(held.activeRunIds, []);
  assert.equal(held.reviewResources.length, 1);
  assert.equal(held.reviewResources[0].resources, 'held');
  assert.equal(checked(await claim(h)).reviewCandidates.length, 0);
  delete h.hooks.retire;
  checked(await h.service.settleNativeReviewCleanup(h.drive.grant.scope));
  const next = checked(await claim(h)).reviewCandidates;
  assert.equal(next.length, 1);
  assert.equal(next[0].reviewerRef.id, 'qa-two');
  assert.notEqual(next[0].requestId, h.query.requestId);
  assert.equal(wakes > 0, true);
});

test('workflow review: Stop fences automatic driving before cleanup and current owner can stop after expert revocation', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  const view = checked(await h.service.stopWorkflowExecution(h.request, control(h, 'stop-review')));
  assert.equal(h.drive.grant.signal.aborted, true);
  assert.equal(view.state, 'stopping');
  assert.deepEqual(view.activeRunIds, []);
  assert.equal(view.reviewResources[0].scope.runId, h.locator.runId);
  h.setWorkbench((w) => ({
    ...w,
    participants: w.participants.map((p) => (p.id === 'qa' ? { ...p, available: false } : p)),
  }));
  const version = readExecutionReviewState(h.read()).attempts[0].version;
  refused(
    await h.service.requestExpertReviewStop(h.request, {
      ...h.locator,
      expectedAttemptVersion: version - 1,
    }),
    'review-conflict',
  );
  const stopped = checked(
    await h.service.requestExpertReviewStop(h.request, {
      ...h.locator,
      expectedAttemptVersion: version,
    }),
  );
  assert.equal(stopped.stopPhase, 'requested');
  assert.equal(stopped.resources, 'held');
  const cleanup = checked(await h.service.settleNativeReviewCleanup(stopped.scope));
  assert.equal(cleanup.status, 'settled');
  const actual = readExecutionReviewState(h.read()).attempts[0];
  assert.equal(actual.status, 'cancelled');
  assert.equal(actual.resources, 'settled');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(
    checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation)).state,
    'paused',
  );
});

test('workflow review: labels cannot replace the actual retained cleanup view for pause or resume', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  const life = new AbortController();
  h.hooks.retire = (authority) => ({
    status: 'retired',
    binding: h.binding,
    drain: {
      basis: 'flushed-and-closed',
      signal: life.signal,
      assertCurrent() {
        life.signal.throwIfAborted();
        h.service.assertExpertReviewCleanupAuthority(authority);
      },
    },
  });
  checked(await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant));
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-completed-review')),
  );
  assert.equal(stopped.state, 'paused');
  life.abort();
  const missing = checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation));
  assert.equal(missing.state, 'stopping');
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-without-review-drain', missing),
      expectedVersion: missing.intent.version,
    }),
    'workflow-recovery-required',
  );
  delete h.hooks.retire;
  checked(await h.service.settleNativeReviewCleanup(h.drive.grant.scope));
  const fresh = checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation));
  assert.equal(fresh.state, 'paused');
  assert.equal(
    checked(
      await h.service.resumeWorkflowExecution(h.request, {
        ...control(h, 'resume-after-review-drain', fresh),
        expectedVersion: fresh.intent.version,
      }),
    ).state,
    'running',
  );
});

test('workflow review: new Service cannot dispatch a persisted automatic attempt using an old claim or recreate its physical drain', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  checked(await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant));
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.snapshot });
  t.after(() => cold.close());
  const view = checked(await cold.service.readWorkflowExecution(cold.request, h.workflowLocation));
  assert.equal(view.requiresResume, true);
  assert.equal(view.reviewResources[0].resources, 'settled');
  assert.throws(() => cold.service.assertExpertReviewDrained(h.drive.grant.scope));
  refused(
    await cold.service.prepareExpertReview(
      cold.request,
      { ...h.query, configurationId: h.composition.configurationId },
      h.workflowClaim,
    ),
    'workflow-authority-denied',
  );
  refused(
    await cold.service.claimWorkflowExecution(cold.request, {
      ...h.workflowLocation,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    }),
    'workflow-authority-denied',
  );
  assert.equal(cold.counters.nodes, 0);
});

test('workflow review: author admission and review preparation share the original concurrency budget', async (t) => {
  const h = await host(t, {
    parallelExpert: true,
    reviewerIds: ['qa'],
    assertReviewConfiguration() {},
  });
  const location = { ...h.locate(), spaceId: 'north' };
  delete location.nodeId;
  const model = { provider: 'contract', model: 'review-contract', maxTokens: 1000 };
  const view = checked(
    await h.service.startWorkflowExecution(h.request, {
      ...location,
      requestId: 'start-shared-budget',
      defaults: { model, tools: 'text-only', workspace: { kind: 'text-only' } },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    }),
  );
  const claimBody = {
    ...location,
    intentId: view.intent.intentId,
    generation: view.intent.generation,
  };
  const first = checked(await h.service.claimWorkflowExecution(h.request, claimBody));
  assert.equal(first.tickets.length, 1);
  assert.equal(first.reviewCandidates.length, 0);
  const target = checked(
    await h.service.readExpertReviewTarget(h.request, { ...h.locate(), spaceId: 'north' }),
  );
  const query = {
    target,
    requestId: workflowReviewRequestId(view.intent, target, 'qa'),
    expectedReviewVersion: 0,
    reviewerRef: { id: 'qa', version: target.planId },
  };
  const facts = checked(await h.service.readExpertReviewPreparation(h.request, query));
  const composition = freezeExecutionReviewComposition({
    ...facts,
    model,
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  h.resetCounts();
  refused(
    await h.service.prepareExpertReview(
      h.request,
      { ...query, configurationId: composition.configurationId },
      first,
    ),
    'workflow-capacity',
  );
  assert.equal(h.counters.nodes, 0);
  first.tickets[0].deferBusy();
  const second = checked(await h.service.claimWorkflowExecution(h.request, claimBody));
  assert.equal(second.reviewCandidates.length, 1);
  checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...query, configurationId: composition.configurationId },
      second,
    ),
  );
  const full = checked(await h.service.claimWorkflowExecution(h.request, claimBody));
  assert.equal(full.tickets.length, 0);
  assert.equal(full.reviewCandidates.length, 0, 'prepared review also retains the shared slot');
});

test('workflow review: a stopped unadmitted reservation needs explicit attention rather than reviving the old target or inventing a retry', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-before-admit')),
  );
  assert.equal(stopped.state, 'paused', 'no native admission exists to drain');
  assert.equal(stopped.reviewAttention[0].code, 'review-attempt-reserved');
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-stopped-reservation', stopped),
      expectedVersion: stopped.intent.version,
    }),
    'workflow-review-attention-required',
  );
  refused(
    await h.service.admitExpertReview(h.request, {
      ...h.locator,
      expectedAttemptVersion: h.attempt.version,
      composition: h.composition,
    }),
    'workflow-authority-denied',
  );
  assert.equal(h.read().rounds[0].ballots.length, 0);
});

test('workflow review: Stop during the original result read aborts admission and final voting before the queued durable stop', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  let release, pendingSignal;
  h.hooks.read = (signal) => {
    pendingSignal = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant);
  while (!release) await setImmediate();
  checked(await h.service.stopWorkflowExecution(h.request, control(h, 'stop-pending-result')));
  assert.equal(pendingSignal.aborted, true);
  release();
  assert.equal((await pending).ok, false);
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.read('consume').command.status, 'blocked');
  const attempt = readExecutionReviewState(h.read()).attempts[0];
  checked(
    await h.service.requestExpertReviewStop(h.request, {
      ...h.locator,
      expectedAttemptVersion: attempt.version,
    }),
  );
  checked(await h.service.settleNativeReviewCleanup(attempt.scope));
  assert.equal(
    checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation)).state,
    'paused',
  );
});

test('workflow review: invalid cleanup bindings cannot populate the physical proof cache or report pause', async (t) => {
  for (const fault of ['scope', 'configuration', 'async']) {
    const h = await nativeReviewHost(t, { workflow: {} });
    h.hooks.retire = () => ({
      status: 'retired',
      binding: {
        ...h.binding,
        scope: fault === 'scope' ? { ...h.binding.scope, runId: 'wrong-run' } : h.binding.scope,
        selection:
          fault === 'configuration'
            ? { ...h.binding.selection, configurationId: 'wrong-configuration' }
            : h.binding.selection,
      },
      drain: {
        basis: 'flushed-and-closed',
        signal: new AbortController().signal,
        assertCurrent: fault === 'async' ? async () => undefined : () => undefined,
      },
    });
    const outcome = checked(
      await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
    );
    assert.equal(outcome.status, 'committed');
    assert.equal(outcome.cleanup, 'failed', fault);
    assert.equal(readExecutionReviewState(h.read()).attempts[0].resources, 'held');
    assert.throws(() => h.service.assertExpertReviewDrained(h.drive.grant.scope), fault);
    const stopped = checked(
      await h.service.stopWorkflowExecution(h.request, control(h, `stop-${fault}`)),
    );
    assert.equal(stopped.state, 'stopping');
  }
});

test('workflow review: a cold running automatic attempt cannot reopen even with valid current member and configuration contracts', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  await h.close();
  const cold = await open(h.root, {
    seed: false,
    workbench: h.snapshot,
    assertReviewConfiguration() {},
  });
  t.after(() => cold.close());
  const view = checked(await cold.service.readWorkflowExecution(cold.request, h.workflowLocation));
  assert.equal(view.requiresResume, true);
  assert.equal(view.reviewResources[0].status, 'running');
  refused(
    await cold.service.openExpertReviewDrive(cold.request, h.locator),
    'review-authority-denied',
  );
  assert.equal(cold.counters.nodes, 0);
});

test('review cleanup: original genuine cleanup retires and settles after member revocation without reacquiring a member or promoting JSON', async (t) => {
  const h = await nativeReviewHost(t);
  h.members.clear();
  h.member.abort();
  h.resetCounts();
  refused(
    await h.service.retireExpertReviewForCleanup({ ...h.drive.cleanup }),
    'review-authority-denied',
  );
  assert.equal(h.counters.nodes, 0);
  assert.equal(h.calls.retire, 0);
  const outcome = checked(await h.service.retireExpertReviewForCleanup(h.drive.cleanup));
  assert.equal(outcome.status, 'settled');
  assert.equal(h.calls.retire, 1);
  const attempt = readExecutionReviewState(h.read()).attempts[0];
  assert.equal(attempt.status, 'cancelled');
  assert.equal(attempt.resources, 'settled');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.calls.prepare, 0);
  assert.equal(h.calls.read, 0);
  assert.throws(() => h.service.assertExpertReviewDriveGrant(h.drive.cleanup, 'send'));
});

test('review cleanup: a cold committed workflow Stop qualifies only its exact automatic attempt without a member session', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  checked(await h.service.stopWorkflowExecution(h.request, control(h, 'stop-before-process-exit')));
  const scope = h.drive.grant.scope;
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.snapshot });
  t.after(() => cold.close());
  cold.members.clear();
  cold.member.abort();
  let retire = 0;
  cold.service.installNativeReviewPorts({
    issuer: {
      registerNativeReviewTools() {
        throw Error('no dispatch');
      },
      prepareFixedReview() {
        throw Error('no dispatch');
      },
      assertFixedReview() {
        throw Error('no read');
      },
      readFixedReview() {
        throw Error('no read');
      },
    },
    grantFor() {
      throw Error('no drive');
    },
    async retireForCleanup(original) {
      retire++;
      cold.service.assertExpertReviewCleanupAuthority(original);
      assert.deepEqual(original.scope, scope);
      return {
        status: 'retired',
        binding: h.binding,
        drain: {
          signal: new AbortController().signal,
          basis: 'flushed-and-closed',
          assertCurrent() {
            cold.service.assertExpertReviewCleanupAuthority(original);
          },
        },
      };
    },
  });
  const wrong = structuredClone(scope);
  wrong.review.target.roundId = 'other-round';
  refused(await cold.service.recoverStoppedWorkflowReviewCleanup(wrong), 'review-authority-denied');
  assert.equal(cold.counters.nodes, 0);
  const result = checked(await cold.service.recoverStoppedWorkflowReviewCleanup(scope));
  assert.equal(result.status, 'settled');
  assert.equal(retire, 1);
  assert.equal(readExecutionReviewState(cold.read()).attempts[0].status, 'cancelled');
  assert.equal(cold.read().rounds[0].ballots.length, 0);
});

test('review cleanup: a cold running intent without a committed Stop cannot manufacture cleanup from known scope metadata', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  const scope = h.drive.grant.scope;
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.snapshot });
  t.after(() => cold.close());
  cold.members.clear();
  cold.member.abort();
  refused(await cold.service.recoverStoppedWorkflowReviewCleanup(scope), 'review-authority-denied');
  assert.equal(cold.counters.nodes, 0);
  assert.equal(readExecutionReviewState(cold.read()).attempts[0].status, 'running');
});

test('review cleanup: dispatch fencing leaves only the original cleanup lane open until domain shutdown seals it', async (t) => {
  const h = await nativeReviewHost(t);
  h.members.clear();
  h.member.abort();
  h.source.abort();
  h.service.fenceRuns();
  assert.throws(() => h.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'));
  assert.equal(
    checked(await h.service.retireExpertReviewForCleanup(h.drive.cleanup)).status,
    'settled',
  );
  assert.equal(h.read().rounds[0].ballots.length, 0);
  await h.service.closeRuns();
  assert.throws(() => h.service.assertExpertReviewCleanupAuthority(h.drive.cleanup));
  refused(
    await h.service.retireExpertReviewForCleanup(h.drive.cleanup),
    'run-authority-unavailable',
  );
});
