import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { caller, checked, refused, open } from './execution-service-run-fixture.mjs';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { host } from './execution-review-service-fixture.mjs';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { reviewDescriptors } from './execution-review-composition-fixture.mjs';
import { workflowReviewRequestId } from '../dist/execution-workflow-reviews.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { nodeRecordKey } from '@zhuma/agent-core';

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
async function reserveCandidate(h, retained) {
  const query = retained.reviewCandidates[0];
  assert.ok(query);
  const facts = checked(await h.service.readExpertReviewPreparation(h.request, query));
  const composition = freezeExecutionReviewComposition({
    ...facts,
    model: { ...retained.view.intent.defaults.model, maxTokens: 16_384 },
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  const prepared = checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...query, configurationId: composition.configurationId },
      retained,
    ),
  );
  return {
    query,
    composition,
    prepared,
    command: {
      ...h.locate(),
      spaceId: 'north',
      runId: prepared.attempt.scope.runId,
      expectedAttemptVersion: prepared.attempt.version,
      composition,
    },
  };
}

test('workflow review: explicit Stop and real retirement permit one new scope for a cancelled unvoted review without changing the peer vote', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, reviewerIds: ['qa', 'outside'] });
  const round = h.read().rounds[0];
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'peer-approval'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'approve',
      comment: 'Peer checked the fixed version.',
    }),
  );
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-unvoted-review')),
  );
  assert.equal(stopped.state, 'stopping');
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-before-retirement', stopped),
      expectedVersion: stopped.intent.version,
    }),
    'workflow-recovery-required',
  );
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(h.drive.grant.scope));
  const old = structuredClone(h.read());
  const resumed = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-unvoted-review', stopped),
      expectedVersion: stopped.intent.version,
    }),
  );
  assert.equal(resumed.intent.generation, stopped.intent.generation + 1);
  assert.equal(h.drive.grant.signal.aborted, true);
  refused(await h.service.openExpertReviewDrive(h.request, h.locator), 'review-authority-denied');
  const retained = checked(await claim(h, resumed));
  assert.equal(retained.reviewCandidates.length, 1);
  h.resetCounts();
  const fresh = await reserveCandidate(h, retained);
  assert.notEqual(fresh.prepared.attempt.scope.runId, h.locator.runId);
  assert.deepEqual(fresh.prepared.attempt.scope.review, h.drive.grant.scope.review);
  assert.equal(
    checked(await h.service.admitExpertReview(h.request, fresh.command)).disposition,
    'applied',
  );
  assert.equal(
    checked(await h.service.admitExpertReview(h.request, fresh.command)).disposition,
    'replayed',
  );
  assert.equal(checked(await claim(h, resumed)).reviewCandidates.length, 0);
  const current = h.read();
  assert.deepEqual(
    current.nativeExecution.review.attempts[0],
    old.nativeExecution.review.attempts[0],
  );
  assert.deepEqual(
    current.nativeExecution.review.receipts[0],
    old.nativeExecution.review.receipts[0],
  );
  for (const key of ['command', 'artifactVersions', 'rounds', 'comments', 'receipts'])
    assert.deepEqual(current[key], old[key]);
  assert.equal(current.rounds[0].ballots[0].reviewerId, 'outside');
  assert.equal(current.rounds[0].ballots.length, 1);
  assert.equal(current.nativeExecution.review.attempts.length, 2);
  assert.deepEqual(h.counters, { global: 0, nodes: 2, plans: 0 });
});

test('workflow review: a cold cancelled settled label cannot retry before the original C retirement proof is recovered', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  const scope = h.drive.grant.scope;
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-before-cold-retry')),
  );
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(scope));
  const old = JSON.stringify(h.read().nativeExecution.review);
  await h.close();
  const cold = await open(h.root, {
    seed: false,
    workbench: h.snapshot,
    assertReviewConfiguration() {},
  });
  t.after(() => cold.close());
  let retires = 0;
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
    async retireForCleanup(authority) {
      retires++;
      cold.service.assertExpertReviewCleanupAuthority(authority);
      return {
        status: 'retired',
        binding: h.binding,
        drain: {
          basis: 'flushed-and-closed',
          signal: new AbortController().signal,
          assertCurrent() {
            cold.service.assertExpertReviewCleanupAuthority(authority);
          },
        },
      };
    },
  });
  refused(
    await cold.service.resumeWorkflowExecution(cold.request, {
      ...control(h, 'cold-resume-without-proof', stopped),
      expectedVersion: stopped.intent.version,
    }),
    'workflow-recovery-required',
  );
  checked(await cold.service.recoverStoppedWorkflowReviewCleanup(scope));
  assert.equal(retires, 1);
  assert.equal(JSON.stringify(cold.read().nativeExecution.review), old);
  const resumed = checked(
    await cold.service.resumeWorkflowExecution(cold.request, {
      ...control(h, 'cold-resume-after-proof', stopped),
      expectedVersion: stopped.intent.version,
    }),
  );
  const retained = checked(
    await cold.service.claimWorkflowExecution(cold.request, {
      ...h.workflowLocation,
      intentId: resumed.intent.intentId,
      generation: resumed.intent.generation,
    }),
  );
  const fresh = await reserveCandidate(cold, retained);
  checked(await cold.service.admitExpertReview(cold.request, fresh.command));
  assert.equal(cold.read().nativeExecution.review.attempts.length, 2);
  assert.deepEqual(cold.read().nativeExecution.review.attempts[0], JSON.parse(old).attempts[0]);
  refused(
    await cold.service.openExpertReviewDrive(cold.request, h.locator),
    'review-authority-denied',
  );
});

test('workflow review: wrong Stop, unknown dispatch and an existing expert opinion keep the original retry refusal', async (t) => {
  for (const fault of ['wrong-stop', 'unknown-dispatch', 'expert-vote']) {
    const h = await nativeReviewHost(t, { workflow: {} });
    if (fault === 'unknown-dispatch') {
      const attempt = readExecutionReviewState(h.read()).attempts[0];
      checked(
        await h.service.recordNativeReviewEvent(h.drive.grant, {
          scope: attempt.scope,
          sequence: attempt.lastEventSequence + 1,
          kind: 'dispatch-unknown',
        }),
      );
    }
    if (fault === 'expert-vote') {
      h.hooks.facts = { conclusion: 'comment' };
      checked(await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant));
      assert.equal(h.read().rounds[0].ballots[0].reviewerId, 'qa');
    }
    const stopped = checked(
      await h.service.stopWorkflowExecution(h.request, control(h, `stop-${fault}`)),
    );
    checked(await h.service.recoverStoppedWorkflowReviewCleanup(h.drive.grant.scope));
    if (fault === 'wrong-stop') {
      const [key, value] = [...h.domain.table('plans').entries()][0];
      const row = structuredClone(value);
      row.workflowExecution.commandReceipts.find((r) => r.kind === 'stop').fingerprint = '0'.repeat(
        64,
      );
      await h.domain.table('plans').put(key, row);
    }
    const before = JSON.stringify(h.read());
    h.resetCounts();
    refused(
      await h.service.resumeWorkflowExecution(h.request, {
        ...control(h, `resume-${fault}`, stopped),
        expectedVersion: stopped.intent.version,
      }),
      'workflow-review-attention-required',
    );
    assert.equal(JSON.stringify(h.read()), before);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  }
});

test('workflow review: a C proof revoked after new preparation cannot survive through admission replay', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {} });
  const lifetime = new AbortController();
  h.hooks.retire = (authority) => ({
    status: 'retired',
    binding: h.binding,
    drain: {
      basis: 'flushed-and-closed',
      signal: lifetime.signal,
      assertCurrent() {
        lifetime.signal.throwIfAborted();
        h.service.assertExpertReviewCleanupAuthority(authority);
      },
    },
  });
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-proof-replay')),
  );
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(h.drive.grant.scope));
  const resumed = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-proof-replay', stopped),
      expectedVersion: stopped.intent.version,
    }),
  );
  const fresh = await reserveCandidate(h, checked(await claim(h, resumed)));
  lifetime.abort();
  h.resetCounts();
  refused(
    await h.service.admitExpertReview(h.request, fresh.command),
    'workflow-recovery-required',
  );
  assert.equal(readExecutionReviewState(h.read()).attempts[1].status, 'prepared');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});
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

test('workflow review: explicit Stop and Resume keep an unadmitted marker intact and admit only one new-generation scope', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  const old = JSON.stringify(h.read().nativeExecution.review);
  const before = checked(await h.service.readWorkflowExecution(h.request, h.workflowLocation));
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-without-stop', before),
      expectedVersion: before.intent.version,
    }),
    'workflow-review-attention-required',
  );
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'stop-before-admit')),
  );
  assert.equal(stopped.state, 'paused', 'no native admission exists to drain');
  assert.equal(h.workflowClaim.signal.aborted, true);
  assert.deepEqual(stopped.reviewAttention ?? [], []);
  assert.equal(JSON.stringify(h.read().nativeExecution.review), old);
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-wrong-version', stopped),
      expectedVersion: stopped.intent.version + 1,
    }),
    'workflow-conflict',
  );
  const resumed = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-stopped-reservation', stopped),
      expectedVersion: stopped.intent.version,
    }),
  );
  assert.equal(resumed.intent.generation, stopped.intent.generation + 1);
  assert.equal(JSON.stringify(h.read().nativeExecution.review), old);
  refused(
    await h.service.admitExpertReview(h.request, {
      ...h.locator,
      expectedAttemptVersion: h.attempt.version,
      composition: h.composition,
    }),
    'workflow-authority-denied',
  );
  refused(await h.service.openExpertReviewDrive(h.request, h.locator), 'review-authority-denied');
  const retained = checked(await claim(h, resumed));
  assert.equal(retained.reviewCandidates.length, 1);
  assert.notEqual(retained.reviewCandidates[0].requestId, h.query.requestId);
  refused(
    await h.service.prepareExpertReview(
      h.request,
      {
        ...h.query,
        configurationId: h.composition.configurationId,
        stoppedPreparedRunIds: [h.attempt.scope.runId],
      },
      retained,
    ),
    'unknown-field',
  );
  refused(
    await h.service.prepareExpertReview(
      h.request,
      { ...h.query, configurationId: h.composition.configurationId },
      retained,
    ),
    'workflow-authority-denied',
  );
  const fresh = await reserveCandidate(h, retained);
  assert.notEqual(fresh.prepared.attempt.scope.runId, h.attempt.scope.runId);
  assert.notEqual(fresh.prepared.attempt.scope.segmentId, h.attempt.scope.segmentId);
  assert.equal(checked(await claim(h, resumed)).reviewCandidates.length, 0);
  const replayed = checked(
    await h.service.prepareExpertReview(
      h.request,
      { ...fresh.query, configurationId: fresh.composition.configurationId },
      retained,
    ),
  );
  assert.equal(replayed.disposition, 'replayed');
  assert.equal(
    checked(await h.service.admitExpertReview(h.request, fresh.command)).disposition,
    'applied',
  );
  assert.equal(
    checked(await h.service.admitExpertReview(h.request, fresh.command)).disposition,
    'replayed',
  );
  const state = readExecutionReviewState(h.read());
  const original = JSON.parse(old);
  assert.deepEqual(state.attempts[0], original.attempts[0]);
  assert.deepEqual(state.receipts[0], original.receipts[0]);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[0].resources, 'held');
  assert.equal(state.attempts[1].status, 'requested');
  assert.equal(state.attempts[1].nativeSessionId, undefined);
  assert.equal(h.read().rounds[0].ballots.length, 0);
});

test('workflow review: cold metadata alone never retries; the new original writer requires explicit valid Stop before a new scope', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  const old = JSON.stringify(h.read().nativeExecution.review);
  await h.close();
  assert.equal(h.workflowClaim.signal.aborted, true);
  const cold = await open(h.root, {
    seed: false,
    workbench: h.snapshot,
    assertReviewConfiguration() {},
  });
  t.after(() => cold.close());
  const view = checked(await cold.service.readWorkflowExecution(cold.request, h.workflowLocation));
  assert.equal(view.requiresResume, true);
  assert.equal(view.reviewAttention[0].code, 'review-attempt-reserved');
  assert.equal(JSON.stringify(cold.read().nativeExecution.review), old);
  assert.equal(cold.counters.nodes, 0);
  const stopped = checked(
    await cold.service.stopWorkflowExecution(cold.request, control(h, 'cold-stop', view)),
  );
  const resumed = checked(
    await cold.service.resumeWorkflowExecution(cold.request, {
      ...control(h, 'cold-resume', stopped),
      expectedVersion: stopped.intent.version,
    }),
  );
  const retained = checked(
    await cold.service.claimWorkflowExecution(cold.request, {
      ...h.workflowLocation,
      intentId: resumed.intent.intentId,
      generation: resumed.intent.generation,
    }),
  );
  const fresh = await reserveCandidate(cold, retained);
  checked(await cold.service.admitExpertReview(cold.request, fresh.command));
  assert.deepEqual(readExecutionReviewState(cold.read()).attempts[0], JSON.parse(old).attempts[0]);
  assert.equal(readExecutionReviewState(cold.read()).attempts.length, 2);
  assert.equal(cold.read('consume').command.status, 'blocked');
});

test('workflow review: forged Stop facts and non-v1 reservations cannot create the internal retry exception', async (t) => {
  for (const fault of ['stop-fingerprint', 'stop-generation', 'prepared-version']) {
    const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
    const stopped = checked(
      await h.service.stopWorkflowExecution(h.request, control(h, `stop-${fault}`)),
    );
    if (fault === 'prepared-version') {
      const row = h.read();
      row.nativeExecution.review.attempts[0].version = 2;
      await h.domain.table('nodes').put(nodeRecordKey(row), row);
    } else {
      const [key, plan] = [...h.domain.table('plans').entries()][0];
      const row = structuredClone(plan);
      const stop = row.workflowExecution.commandReceipts.find((item) => item.kind === 'stop');
      if (fault === 'stop-fingerprint') stop.fingerprint = '0'.repeat(64);
      else stop.generation++;
      await h.domain.table('plans').put(key, row);
    }
    h.resetCounts();
    refused(
      await h.service.resumeWorkflowExecution(h.request, {
        ...control(h, `resume-${fault}`, stopped),
        expectedVersion: stopped.intent.version,
      }),
      'workflow-review-attention-required',
    );
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  }
});

test('workflow review: Stop waits for an in-flight admission and cannot reclassify its persisted requested record as never admitted', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  let release, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  h.faults.afterNodeWrite = async (row) => {
    if (row.nativeExecution?.review?.attempts[0]?.status === 'requested') {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  };
  const pending = h.service.admitExpertReview(h.request, {
    ...h.locator,
    expectedAttemptVersion: h.attempt.version,
    composition: h.composition,
  });
  await waiting;
  const stopping = h.service.stopWorkflowExecution(h.request, control(h, 'stop-during-admit'));
  while (!h.workflowClaim.signal.aborted) await setImmediate();
  release();
  checked(await pending);
  delete h.faults.afterNodeWrite;
  const stopped = checked(await stopping);
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.reviewResources[0].status, 'requested');
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-after-inflight-admit', stopped),
      expectedVersion: stopped.intent.version,
    }),
    'workflow-recovery-required',
  );
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  assert.equal(readExecutionReviewState(h.read()).attempts[0].resources, 'held');
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

test('review cleanup: a later workflow Stop retains the actual historical receipt generation and still requires original retirement', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, reviewerIds: ['qa', 'outside'] });
  const scope = h.drive.grant.scope;
  const first = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'first-review-stop')),
  );
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(scope));
  const round = h.read().rounds[0];
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return-historical-round'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'request-changes',
      comment: 'Revise this fixed version.',
    }),
  );
  const second = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...control(h, 'resume-second-generation', first),
      expectedVersion: first.intent.version,
    }),
  );
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, control(h, 'second-review-stop', second)),
  );
  assert.equal(stopped.intent.generation, 2);
  assert.equal(scope.generation, 1);
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.snapshot });
  t.after(() => cold.close());
  let retires = 0;
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
    async retireForCleanup(authority) {
      retires++;
      cold.service.assertExpertReviewCleanupAuthority(authority);
      assert.deepEqual(authority.scope, scope);
      return {
        status: 'retired',
        binding: h.binding,
        drain: {
          basis: 'flushed-and-closed',
          signal: new AbortController().signal,
          assertCurrent() {
            cold.service.assertExpertReviewCleanupAuthority(authority);
          },
        },
      };
    },
  });
  assert.throws(() => cold.service.assertExpertReviewDrained(scope));
  const [key, saved] = [...cold.domain.table('plans').entries()][0];
  const forged = structuredClone(saved);
  forged.workflowExecution.commandReceipts = forged.workflowExecution.commandReceipts.filter(
    (receipt) => !(receipt.kind === 'stop' && receipt.generation === 1),
  );
  await cold.domain.table('plans').put(key, forged);
  refused(await cold.service.recoverStoppedWorkflowReviewCleanup(scope), 'review-authority-denied');
  assert.equal(
    retires,
    0,
    'a current-generation Stop cannot substitute for the original receipt generation',
  );
  await cold.domain.table('plans').put(key, saved);
  const wrong = structuredClone(scope);
  wrong.review.target.roundId = 'foreign-round';
  refused(await cold.service.recoverStoppedWorkflowReviewCleanup(wrong), 'review-authority-denied');
  assert.equal(retires, 0);
  const before = JSON.stringify(cold.read().nativeExecution.review);
  cold.resetCounts();
  assert.equal(
    checked(await cold.service.recoverStoppedWorkflowReviewCleanup(scope)).status,
    'settled',
  );
  assert.equal(retires, 1);
  assert.equal(cold.service.assertExpertReviewDrained(scope), undefined);
  assert.equal(JSON.stringify(cold.read().nativeExecution.review), before);
  assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
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

test('review cleanup: resumed cold history recovers exact stopped scopes while keeping the prepared reservation and peer vote', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, reviewerIds: ['qa', 'outside'] });
  const firstScope = h.drive.grant.scope;
  const stop = async (view, key) =>
    checked(await h.service.stopWorkflowExecution(h.request, control(h, key, view)));
  const resume = async (view, key) =>
    checked(
      await h.service.resumeWorkflowExecution(h.request, {
        ...control(h, key, view),
        expectedVersion: view.intent.version,
      }),
    );
  const one = await stop(h.workflowView, 'history-stop-one');
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(firstScope));
  const oldRound = h.read().rounds[0];
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return-old-target'),
      roundId: oldRound.id,
      artifactVersionId: oldRound.artifactVersionId,
      action: 'request-changes',
      comment: 'Revise the fixed target.',
    }),
  );
  checked(
    await h.service.submit(caller(), {
      ...h.human('produce', 'submit-new-target'),
      text: 'Revised fixed body.',
    }),
  );
  const two = await resume(one, 'history-resume-two');
  const prepared = await reserveCandidate(h, checked(await claim(h, two)));
  const stopTwo = await stop(two, 'history-stop-two');
  const three = await resume(stopTwo, 'history-resume-three');
  const fresh = await reserveCandidate(h, checked(await claim(h, three)));
  checked(await h.service.admitExpertReview(h.request, fresh.command));
  const drive = checked(
    await h.service.openExpertReviewDrive(h.request, {
      ...h.locate(),
      spaceId: 'north',
      runId: fresh.prepared.attempt.scope.runId,
    }),
  );
  t.after(() => drive.dispose());
  checked(
    await h.service.recordNativeReviewEvent(drive.grant, {
      scope: drive.grant.scope,
      kind: 'accepted',
      sequence: 1,
      nativeSessionId: 'third-contract-native',
      nativeAgentId: 'third-contract-native',
    }),
  );
  const { review: _review, ...thirdScope } = drive.grant.scope;
  const thirdBinding = {
    scope: thirdScope,
    nativeSessionId: 'third-contract-native',
    nativeAgentId: 'third-contract-native',
    selection: drive.grant.selection,
  };
  const bindings = new Map([
    [firstScope.runId, h.binding],
    [thirdScope.runId, thirdBinding],
  ]);
  h.hooks.retire = (authority) => ({
    status: 'retired',
    binding: bindings.get(authority.scope.runId),
    drain: {
      basis: 'flushed-and-closed',
      signal: new AbortController().signal,
      assertCurrent() {
        h.service.assertExpertReviewCleanupAuthority(authority);
      },
    },
  });
  const peerRound = h.read().rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'peer-approve-new-target'),
      roundId: peerRound.id,
      artifactVersionId: peerRound.artifactVersionId,
      action: 'approve',
      comment: 'Peer accepted this version.',
    }),
  );
  const stopThree = await stop(three, 'history-stop-three');
  checked(await h.service.recoverStoppedWorkflowReviewCleanup(drive.grant.scope));
  const four = await resume(stopThree, 'history-resume-four');
  const before = JSON.stringify(h.read()),
    old = readExecutionReviewState(h.read());
  assert.deepEqual(
    old.attempts.map((a) => [a.status, a.resources]),
    [
      ['cancelled', 'settled'],
      ['prepared', 'held'],
      ['cancelled', 'settled'],
    ],
  );
  assert.notDeepEqual(old.attempts[0].scope.review.target, old.attempts[2].scope.review.target);
  assert.deepEqual(old.attempts[1].scope.review.target, old.attempts[2].scope.review.target);
  await h.close();
  const cold = await open(h.root, {
    seed: false,
    workbench: h.snapshot,
    assertReviewConfiguration() {},
  });
  t.after(() => cold.close());
  const calls = [];
  const no = () => {
    throw Error('no model/drive/read');
  };
  cold.service.installNativeReviewPorts({
    issuer: {
      registerNativeReviewTools: no,
      prepareFixedReview: no,
      assertFixedReview: no,
      readFixedReview: no,
    },
    grantFor: no,
    async retireForCleanup(authority) {
      calls.push(authority.scope.runId);
      cold.service.assertExpertReviewCleanupAuthority(authority);
      return {
        status: 'retired',
        binding: bindings.get(authority.scope.runId),
        drain: {
          basis: 'flushed-and-closed',
          signal: new AbortController().signal,
          assertCurrent() {
            cold.service.assertExpertReviewCleanupAuthority(authority);
          },
        },
      };
    },
  });
  refused(
    await cold.service.recoverStoppedWorkflowReviewCleanup(prepared.prepared.attempt.scope),
    'review-result-not-running',
  );
  assert.deepEqual(calls, []);
  assert.equal(four.intent.status, 'running');
  assert.throws(() => cold.service.assertExpertReviewDrained(firstScope));
  const [planKey, savedPlan] = [...cold.domain.table('plans').entries()][0];
  const changedPlan = structuredClone(savedPlan);
  changedPlan.workflowExecution.commandReceipts =
    changedPlan.workflowExecution.commandReceipts.filter(
      (receipt) => !(receipt.kind === 'stop' && receipt.generation === three.intent.generation),
    );
  await cold.domain.table('plans').put(planKey, changedPlan);
  refused(
    await cold.service.recoverStoppedWorkflowReviewCleanup(drive.grant.scope),
    'review-authority-denied',
  );
  assert.deepEqual(calls, [], 'an unrelated older Stop cannot authorize this history');
  await cold.domain.table('plans').put(planKey, savedPlan);
  checked(await cold.service.recoverStoppedWorkflowReviewCleanup(firstScope));
  checked(await cold.service.recoverStoppedWorkflowReviewCleanup(drive.grant.scope));
  assert.equal(JSON.stringify(cold.read()), before);
  assert.deepEqual(calls, [firstScope.runId, thirdScope.runId]);
  assert.deepEqual(readExecutionReviewState(cold.read()).attempts[1], old.attempts[1]);
  assert.equal(cold.read().rounds.at(-1).ballots[0].reviewerId, 'outside');
  assert.equal(cold.read().rounds.at(-1).ballots[0].action, 'approve');
  const next = checked(
    await cold.service.resumeWorkflowExecution(cold.request, {
      ...control(h, 'cold-resume-five', four),
      expectedVersion: four.intent.version,
    }),
  );
  const retained = checked(
    await cold.service.claimWorkflowExecution(cold.request, {
      ...h.workflowLocation,
      intentId: next.intent.intentId,
      generation: next.intent.generation,
    }),
  );
  assert.equal(retained.reviewCandidates.length, 1);
});
