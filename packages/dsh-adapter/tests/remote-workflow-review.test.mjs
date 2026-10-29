/** Original review/Run/JSON facts and signed wire contracts. Native reader/cuts
 * and member ports are contracts; no real model or native Host acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  canonicalPayload,
  remoteWorkflowViewSchema,
  remoteResultDigestInput,
} from '@zhuma/agent-core';
import { reviewHost, ok, no } from './remote-review-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { readExecutionRunComposition } from '../dist/execution-run-composition.js';
import {
  nativeReviewReadRef,
  nativeReviewManifestDigest,
  nativeReviewContentDigest,
} from '../dist/native-work-session-review-contract.js';
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
async function acceptWork(h, candidate) {
  return ok(
    await h.send(
      h.workEnvelope('accept', {
        target: candidate.target,
        expectedNodeVersion: candidate.expectedNodeVersion,
        expectedRunVersion: candidate.expectedRunVersion,
        purpose: 'work',
        mode: candidate.mode,
        executor: candidate.executor,
        workflow: candidate.workflow,
        ...defaults(),
        credentials: { drive: h.drive.public, cleanup: h.cleanupCredential.public },
      }),
    ),
  );
}
async function completeWork(h, view, text) {
  const scope = view.scope,
    nativeSessionId = `native-${scope.runId}`,
    nativeAgentId = `agent-${scope.runId}`;
  const scoped = (operation, fields = {}, requestId) =>
    h.workEnvelope(operation, { scope, permit: h.drive.public, ...fields }, requestId);
  view = ok(
    await h.send(scoped('event', { event: { kind: 'received', sequence: 1, nativeSessionId } })),
  );
  view = ok(
    await h.send(
      scoped('event', {
        event: { kind: 'accepted', sequence: 2, nativeSessionId, executorRunId: nativeAgentId },
      }),
    ),
  );
  const { backendId, ...nativeScope } = scope,
    draft = { text, links: [], files: [] };
  const result = {
    requestId: randomUUID(),
    digest: nativeResultDigest(draft),
    artifactDigest: hash(remoteResultDigestInput(draft)),
    source: {
      scope: nativeScope,
      nativeSessionId,
      nativeAgentId,
      configurationId: currentExecutionRun(h.read(scope.nodeId)).selection.configurationId,
      intentId: `intent-${scope.runId}`,
      callId: `call-${scope.runId}`,
      toolVersion: 'zhuma-native-result-intent@1',
      cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
    },
  };
  view = ok(
    await h.send(
      scoped('event', {
        event: {
          kind: 'completed',
          sequence: 3,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result,
        },
      }),
    ),
  );
  return ok(
    await h.send(
      scoped(
        'submit-result',
        { expectedNodeVersion: view.nodeVersion, result, draft },
        result.requestId,
      ),
    ),
  );
}

const target = (h) => {
  const { nodeId, ...value } = h.locate();
  return { ...value, spaceId: 'north' };
};
const defaults = () => ({
  model: { provider: 'contract', model: 'local-review-model', maxTokens: 1000 },
  workspace: { kind: 'text-only' },
  capabilities: {
    resultIntent: 'zhuma-native-result-intent@1',
    acceptedInput: '1',
    localTools: [],
  },
});
const start = (h) =>
  h.workEnvelope('workflow-start', {
    target: target(h),
    defaults: defaults(),
    budget: { concurrent: 1, automaticRevisions: 2 },
  });
const ref = (v) => ({ intentId: v.intent.intentId, generation: v.intent.generation });
const control = (h, operation, value, extra = {}) =>
  h.workEnvelope(operation, { target: target(h), workflow: ref(value), ...extra });
const snapshot = (h) =>
  canonicalPayload({
    global: h.domain.global.get(),
    nodes: [...h.domain.table('nodes').entries()],
    plans: [...h.domain.table('plans').entries()],
  });

for (const conclusion of ['approve', 'request-changes']) {
  test(`remote workflow review: independent original ${conclusion} is automatic candidate/fixed vote, held until genuine cleanup and never impersonates the expert`, async (t) => {
    const h = await reviewHost(t),
      intent = ok(await h.send(start(h)));
    h.resetCounts();
    const before = snapshot(h);
    const next = ok(await h.send(control(h, 'workflow-next', intent)));
    assert.equal(next.candidates[0].kind, 'review');
    const candidate = next.candidates[0];
    assert.equal(candidate.reviewerRef.id, 'qa');
    assert.equal(candidate.reviewerRef.version, h.read().planId);
    assert.equal(snapshot(h), before);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    await h.begin('qa', { workflow: candidate.workflow, model: defaults().model });
    const active = ok(await h.send(control(h, 'workflow-status', intent)));
    assert.equal(active.activeReviews.length, 1);
    assert.equal(active.activeReviews[0].scope.actorId, 'chen');
    assert.equal(active.activeReviews[0].scope.review.principal.reviewerRef.id, 'qa');
    remoteWorkflowViewSchema.parse(active);
    const wrong = structuredClone(active);
    wrong.activeReviews[0].deviceId = randomUUID();
    assert.equal(remoteWorkflowViewSchema.safeParse(wrong).success, false);
    assert.deepEqual(ok(await h.send(control(h, 'workflow-next', intent))).candidates, []);
    const fixed = h.fixed({ conclusion });
    await h.seal(fixed);
    ok(await h.submit(fixed));
    assert.equal(h.read().rounds[0].ballots[0].reviewerId, 'qa');
    assert.equal(h.read().rounds[0].ballots[0].action, conclusion);
    assert.equal(
      h.read().rounds[0].ballots[0].comment.includes(fixed.facts.content.rationale),
      true,
    );
    assert.deepEqual(ok(await h.send(control(h, 'workflow-next', intent))).candidates, []);
    ok(await h.cleanup());
    const after = ok(await h.send(control(h, 'workflow-next', intent)));
    assert.equal(after.activeReviews[0].resources, 'settled');
    assert.equal(h.calls.backendModel, 0);
    if (conclusion === 'approve') assert.equal(h.read('consume').command.status, 'ready');
    else {
      assert.equal(h.read().command.status, 'needs-revision');
      assert.equal(after.candidates[0].kind, 'work');
      assert.equal(after.candidates[0].repairIndex, 1);
      const candidate = after.candidates[0];
      const accepted = await h.send(
        h.workEnvelope('accept', {
          target: candidate.target,
          expectedNodeVersion: candidate.expectedNodeVersion,
          expectedRunVersion: candidate.expectedRunVersion,
          purpose: 'work',
          mode: candidate.mode,
          executor: candidate.executor,
          workflow: candidate.workflow,
          ...defaults(),
          credentials: { drive: h.drive.public, cleanup: h.cleanupCredential.public },
        }),
      );
      ok(accepted);
    }
  });
}

test('remote workflow review: Stop uses original review stop facts, retains held resources and refuses late votes/new admission', async (t) => {
  const h = await reviewHost(t),
    intent = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
  await h.begin('qa', { workflow: candidate.workflow, model: defaults().model });
  const stopped = ok(await h.send(control(h, 'workflow-stop', intent)));
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.activeReviews[0].resources, 'held');
  assert.notEqual(stopped.activeReviews[0].stopPhase, 'none');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  no(
    await h.send(
      control(h, 'workflow-resume', stopped, { expectedVersion: stopped.intent.version }),
    ),
    'remote-resource-held',
  );
  no(await h.send(h.accept('qa', { workflow: candidate.workflow, model: defaults().model })));
  ok(await h.cleanup());
  const paused = ok(await h.send(control(h, 'workflow-status', stopped)));
  assert.equal(paused.state, 'paused');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  const resumed = ok(
    await h.send(control(h, 'workflow-resume', paused, { expectedVersion: paused.intent.version })),
  );
  const retry = ok(await h.send(control(h, 'workflow-next', resumed))).candidates[0];
  assert.equal(retry.kind, 'review');
  assert.equal(retry.workflow.generation, 2);
  await h.begin('qa', { workflow: retry.workflow, model: defaults().model });
  const fixed = h.fixed({ conclusion: 'approve' });
  await h.seal(fixed);
  ok(await h.submit(fixed));
  ok(await h.cleanup());
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read('consume').command.status, 'ready');
});

test('remote workflow review: mismatched intent/model/target and another device cannot create an original reservation or vote', async (t) => {
  const h = await reviewHost(t),
    intent = ok(await h.send(start(h))),
    candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
  const before = snapshot(h);
  h.resetCounts();
  no(
    await h.send(
      h.accept('qa', {
        workflow: { ...candidate.workflow, generation: 2 },
        model: defaults().model,
      }),
    ),
  );
  no(
    await h.send(
      h.accept('qa', {
        workflow: candidate.workflow,
        model: { ...defaults().model, model: 'other-model' },
      }),
    ),
  );
  no(
    await h.send(
      h.accept('qa', {
        workflow: candidate.workflow,
        target: { ...candidate.target, artifactVersionId: 'wrong' },
        model: defaults().model,
      }),
    ),
  );
  const other = h.accept('qa', { workflow: candidate.workflow, model: defaults().model });
  other.deviceId = randomUUID();
  no(await h.send(other));
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote workflow review: only signed absent-unadmitted cleanup plus explicit Resume can reuse an unvoted reserved lane', async (t) => {
  const h = await reviewHost(t),
    intent = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
  const reserved = ok(
    await h.send(h.accept('qa', { workflow: candidate.workflow, model: defaults().model })),
  );
  const stopped = ok(await h.send(control(h, 'workflow-stop', intent)));
  no(
    await h.send(
      control(h, 'workflow-resume', stopped, { expectedVersion: stopped.intent.version }),
    ),
    'remote-resource-held',
  );
  ok(
    await h.send(
      h.envelope('cleanup', {
        scope: reserved.scope,
        permit: h.cleanupCredential.public,
        observation: {
          kind: 'drained',
          sequence: reserved.nextSequence,
          evidence: { basis: 'absent-unadmitted' },
        },
      }),
      { secret: h.cleanupCredential.raw, request: { headers: {} } },
    ),
  );
  const resumed = ok(
    await h.send(
      control(h, 'workflow-resume', stopped, { expectedVersion: stopped.intent.version }),
    ),
  );
  const retry = ok(await h.send(control(h, 'workflow-next', resumed))).candidates[0];
  assert.equal(retry.kind, 'review');
  await h.begin('qa', { workflow: retry.workflow, model: defaults().model });
  assert.equal(h.read().nativeExecution.review.attempts.length, 2);
});

test('remote workflow review: two fixed request-changes rounds carry original cited feedback, then the automatic rework budget survives Stop/Resume', async (t) => {
  const h = await reviewHost(t);
  let intent = ok(await h.send(start(h)));
  for (let repair = 1; repair <= 3; repair++) {
    await h.refreshTarget();
    const review = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
    assert.equal(review.kind, 'review');
    await h.begin('qa', { workflow: review.workflow, model: defaults().model });
    const fixed = h.fixed({ conclusion: 'request-changes' });
    await h.seal(fixed);
    ok(await h.submit(fixed));
    ok(await h.cleanup());
    const next = ok(await h.send(control(h, 'workflow-next', intent)));
    const candidate = next.candidates.find((item) => item.target.nodeId === 'produce');
    if (repair === 3) {
      assert.equal(candidate, undefined);
      assert.equal(
        next.attention.find((item) => item.nodeId === 'produce').code,
        'rework-budget-exhausted',
      );
      const stopped = ok(await h.send(control(h, 'workflow-stop', intent)));
      const stoppedNode = structuredClone(h.read());
      intent = ok(
        await h.send(
          control(h, 'workflow-resume', stopped, {
            expectedVersion: stopped.intent.version,
            defaults: {
              ...stopped.intent.defaults,
              workspace: {
                kind: 'local',
                rootId: 'opaque-local-root',
                access: 'write',
                publish: [{ kind: 'directory', path: 'deliverables' }],
              },
            },
          }),
        ),
      );
      assert.equal(intent.intent.intentId, stopped.intent.intentId);
      assert.deepEqual(intent.intent.budget, stopped.intent.budget);
      assert.deepEqual(intent.intent.defaults.workspace.publish, [
        { kind: 'directory', path: 'deliverables' },
      ]);
      assert.deepEqual(h.read(), stoppedNode);
      assert.equal(
        ok(await h.send(control(h, 'workflow-next', intent))).candidates.some(
          (item) => item.target.nodeId === 'produce',
        ),
        false,
      );
      assert.deepEqual(
        intent.revisions.find((item) => item.nodeId === 'produce'),
        { nodeId: 'produce', used: 2, limit: 2 },
      );
      assert.equal(h.read().artifactVersions.length, 3);
      assert.equal(h.calls.backendModel, 0);
      break;
    }
    assert.equal(candidate.kind, 'work');
    assert.equal(candidate.repairIndex, repair);
    const view = await acceptWork(h, candidate);
    const progress = ok(await h.send(control(h, 'workflow-status', intent)));
    assert.deepEqual(
      progress.revisions.find((item) => item.nodeId === 'produce'),
      { nodeId: 'produce', used: repair, limit: 2 },
    );
    const composition = readExecutionRunComposition(currentExecutionRun(h.read()).composition);
    assert.equal(
      composition.payload.returnedRevision.roundId,
      fixed.facts.source.context.review.target.roundId,
    );
    assert.equal(composition.payload.returnedRevision.notes[0].reviewerId, 'qa');
    assert.equal(
      composition.payload.returnedRevision.notes[0].comment.includes(fixed.facts.content.rationale),
      true,
    );
    await completeWork(h, view, `Revised deliverable ${repair}`);
  }
});

test('remote workflow review: a fixed human reviewer remains human work after the independent expert vote, without a fabricated ballot', async (t) => {
  const h = await reviewHost(t, { reviewers: ['qa', 'outside'] }),
    intent = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
  await h.begin('qa', { workflow: candidate.workflow, model: defaults().model });
  const fixed = h.fixed({ conclusion: 'approve' });
  await h.seal(fixed);
  ok(await h.submit(fixed));
  ok(await h.cleanup());
  const before = snapshot(h),
    next = ok(await h.send(control(h, 'workflow-next', intent)));
  assert.equal(h.read().command.status, 'in-review');
  assert.equal(h.read('consume').command.status, 'blocked');
  assert.equal(
    next.candidates.some(
      (item) => item.target.nodeId === 'produce' || item.target.nodeId === 'consume',
    ),
    false,
  );
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read().rounds[0].ballots[0].reviewerId, 'qa');
  assert.equal(snapshot(h), before);
});
for (const releaseFailure of [false, true])
  test(`remote workflow review: Stop fences queue-external review qualification and release failure=${releaseFailure} cannot be reported as paused`, async (t) => {
    const h = await reviewHost(t),
      intent = ok(await h.send(start(h)));
    const entered = Promise.withResolvers(),
      proceed = Promise.withResolvers();
    let wait;
    h.hooks.metadata = (signal) => {
      wait = signal;
      entered.resolve();
      return proceed.promise;
    };
    h.hooks.release = () => {
      if (releaseFailure) throw Error('CONTRACT_RELEASE_UNKNOWN');
    };
    t.after(() => proceed.resolve());
    const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
    const pending = h.send(
      h.accept('qa', { workflow: candidate.workflow, model: defaults().model }),
    );
    await entered.promise;
    const stopped = ok(await h.send(control(h, 'workflow-stop', intent)));
    assert.equal(wait.aborted, true);
    assert.equal(stopped.state, 'stopping');
    no(
      await h.send(
        control(h, 'workflow-resume', stopped, { expectedVersion: stopped.intent.version }),
      ),
      'remote-resource-held',
    );
    proceed.resolve();
    no(await pending);
    const final = ok(await h.send(control(h, 'workflow-status', stopped)));
    assert.equal(final.state, releaseFailure ? 'stopping' : 'paused');
    assert.equal(h.calls.released, 1);
    assert.equal(final.activeReviews.length, 0);
    assert.equal(h.read().rounds[0].ballots.length, 0);
    if (releaseFailure)
      no(
        await h.send(
          control(h, 'workflow-resume', final, { expectedVersion: final.intent.version }),
        ),
        'remote-resource-held',
      );
  });

test('remote workflow review: the automatic candidate reads real AttachmentLocal fixed files and only the complete fixed manifest can unlock downstream', async (t) => {
  const h = await reviewHost(t, { file: true }),
    intent = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates[0];
  await h.begin('qa', { workflow: candidate.workflow, model: defaults().model });
  const listed = ok(await h.send(h.scoped('input-list'))),
    fixed = h.fixed({ conclusion: 'approve' }),
    reads = [];
  for (const [index, resource] of listed.resources.entries()) {
    const page = ok(
      await h.send(
        h.scoped('input-read', { resourceRef: resource.resourceRef, offset: 0, length: 8192 }),
      ),
    );
    const callId = `actual-fixed-read-${index}`;
    if (resource.kind === 'file')
      assert.equal(Buffer.from(page.base64, 'base64').toString(), 'Required file material.');
    reads.push({
      readRef: nativeReviewReadRef(page.source, callId, page.range, page.sha256),
      source: page.source,
      callId,
      callSeq: index * 2,
      resultSeq: index * 2 + 1,
      range: page.range,
      encoding: page.encoding,
      sha256: page.sha256,
    });
  }
  assert.equal(reads.length, 2);
  const facts = fixed.facts;
  facts.readManifest = { reads, unavailableRequired: [] };
  facts.readManifestDigest = nativeReviewManifestDigest(facts.readManifest);
  facts.source.readManifestDigest = facts.readManifestDigest;
  const seq = reads.length * 2 + 2;
  facts.source.cut = { callSeq: seq, resultSeq: seq + 1, turnEndSeq: seq + 2, asOfSeq: seq + 2 };
  facts.content.evidenceRefs = reads.map((item) => item.readRef);
  facts.digest = nativeReviewContentDigest(facts.content, facts.readManifestDigest);
  facts.provenanceFingerprint = hash({
    source: facts.source,
    digest: facts.digest,
    readManifestDigest: facts.readManifestDigest,
  });
  Object.assign(fixed.result, {
    source: facts.source,
    digest: facts.digest,
    readManifestDigest: facts.readManifestDigest,
    provenanceFingerprint: facts.provenanceFingerprint,
  });
  await h.seal(fixed);
  ok(await h.submit(fixed));
  ok(await h.cleanup());
  assert.equal(h.read('consume').command.status, 'ready');
  assert.equal(h.calls.backendModel, 0);
  assert.equal(h.read().rounds[0].ballots[0].artifactVersionId, h.target.artifactVersionId);
});

test('remote workflow review: spare concurrent device slots cannot admit downstream while any predecessor review still holds original resources', async (t) => {
  const h = await reviewHost(t),
    intent = ok(
      await h.send(
        h.workEnvelope('workflow-start', {
          target: target(h),
          defaults: defaults(),
          budget: { concurrent: 3, automaticRevisions: 2 },
        }),
      ),
    );
  const candidate = ok(await h.send(control(h, 'workflow-next', intent))).candidates.find(
    (item) => item.kind === 'review',
  );
  await h.begin('qa', { workflow: candidate.workflow, model: defaults().model });
  const fixed = h.fixed({ conclusion: 'approve' });
  await h.seal(fixed);
  ok(await h.submit(fixed));
  assert.equal(h.read('consume').command.status, 'ready');
  const before = snapshot(h),
    next = ok(await h.send(control(h, 'workflow-next', intent)));
  assert.equal(next.activeReviews[0].resources, 'held');
  assert.equal(
    next.candidates.some((item) => item.target.nodeId === 'parallel'),
    true,
  );
  assert.equal(
    next.candidates.some((item) => item.target.nodeId === 'consume'),
    false,
  );
  const consume = h.read('consume');
  const attempt = () =>
    h.workEnvelope('accept', {
      target: { ...target(h), nodeId: 'consume' },
      expectedNodeVersion: consume.command.version,
      expectedRunVersion: 0,
      purpose: 'work',
      mode: 'begin',
      executor: { kind: 'builtin' },
      workflow: ref(intent),
      ...defaults(),
      credentials: { drive: h.drive.public, cleanup: h.cleanupCredential.public },
    });
  no(await h.send(attempt()));
  assert.equal(snapshot(h), before);
  assert.equal(h.read('consume').nativeExecution, undefined);
  ok(await h.cleanup());
  const ready = ok(await h.send(control(h, 'workflow-next', intent))).candidates.find(
    (item) => item.target.nodeId === 'consume',
  );
  assert.equal(ready.kind, 'work');
  await acceptWork(h, ready);
  assert.equal(h.read('consume').nativeExecution.runs.length, 1);
});
