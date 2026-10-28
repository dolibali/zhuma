/** Original backend facts and explicit member/native contracts, not SDK/model acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPayload } from '@zhuma/agent-core';
import { reviewHost, ok, no } from './remote-review-fixture.mjs';
import { readExecutionReviewState } from '../dist/execution-review-state.js';

const attempt = (h) =>
  readExecutionReviewState(h.read()).attempts.find(
    (a) => a.scope.runId === h.reviewView.scope.runId,
  );

test('remote independent review: original passive qualification, fixed target reads, seal without vote, original atomic ballot then separate cleanup', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  assert.equal(h.calls.backendModel, 0);
  assert.deepEqual(h.calls, { metadata: 1, released: 1, backendModel: 0 });
  const resources = ok(await h.send(h.scoped('input-list'))).resources;
  const read = ok(
    await h.send(
      h.scoped('input-read', { resourceRef: resources[0].resourceRef, offset: 0, length: 8192 }),
    ),
  );
  assert.equal(Buffer.from(read.base64, 'base64').toString(), h.read().artifactVersions[0].text);
  assert.equal(read.source.nativeSessionId, 'native-qa');
  assert.equal(h.service.fileReadResources.size, 0);
  const value = h.fixed();
  await h.seal(value);
  assert.equal(attempt(h).status, 'running');
  assert.equal(attempt(h).resources, 'held');
  assert.equal(h.reviewView.authority, 'commit-only');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  const committed = ok(await h.submit(value));
  assert.equal(committed.status, 'committed');
  assert.equal(attempt(h).status, 'completed');
  assert.equal(attempt(h).resources, 'held');
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read().comments.length, 1);
  assert.equal(h.read('consume').command.status, 'ready');
  const status = ok(await h.send(h.scoped('status')));
  h.setView(status);
  assert.equal(status.authority, 'cleanup-only');
  assert.deepEqual(status.receipt, committed.receipt);
  const repeated = ok(await h.submit(value));
  assert.equal(repeated.status, 'confirmed');
  assert.deepEqual(repeated.receipt, committed.receipt);
  assert.equal(h.read().comments.length, 1);
  const retired = ok(await h.cleanup());
  assert.equal(retired.resources, 'settled');
  assert.equal('receipt' in retired, false);
  assert.equal('result' in retired, false);
});

test('remote independent review: default disabled purpose, self-review and wrong device proof cannot invoke private qualification', async (t) => {
  const h = await reviewHost(t, { enabled: false });
  const info = ok(await h.service.remoteRun(h.request, h.workEnvelope('info', {})));
  assert.deepEqual(info.purposes, ['work']);
  no(await h.send(h.accept()), 'remote-protocol-unsupported');
  assert.equal(h.calls.metadata, 0);
  await h.service.enableRemoteRuns({ independentReviews: true });
  const actual = ok(await h.service.remoteRun(h.request, h.workEnvelope('info', {})));
  assert(actual.purposes.includes('review'));
  const body = h.accept('chen');
  no(await h.send(body));
  assert.equal(h.calls.metadata, 0);
  const invalid = h.accept();
  invalid.deviceId = '00000000-0000-4000-8000-000000000000';
  no(await h.send(invalid), 'remote-device-mismatch');
  assert.equal(h.calls.metadata, 0);
  assert.equal(readExecutionReviewState(h.read()), undefined);
});

test('remote independent review: same original cut retries and changed facts cannot create a second ballot or comment', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const value = h.fixed();
  const before = canonicalPayload(h.read());
  no(await h.submit(value), 'remote-recovery-required');
  assert.equal(canonicalPayload(h.read()), before);
  const sealed = h.scoped('event', {
    event: {
      kind: 'sealed',
      sequence: h.reviewView.nextSequence,
      idle: true,
      flushed: true,
      resourcesSettled: true,
      result: value.result,
    },
  });
  h.setView(ok(await h.send(sealed)));
  assert.equal(ok(await h.send(sealed)).disposition, 'replayed');
  const changed = structuredClone(sealed);
  changed.payload.event.result.digest = '0'.repeat(64);
  no(await h.send(changed), 'remote-idempotency-mismatch');
  const receipt = ok(await h.submit(value));
  const forged = structuredClone(value);
  forged.facts.content.rationale = 'Replaced after seal.';
  no(await h.submit(forged));
  assert.equal(h.read().comments.length, 1);
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.deepEqual(
    ok(await h.send(h.scoped('result-status', { resultRequestId: value.result.requestId })))
      .receipt,
    receipt.receipt,
  );
});

test('remote independent review: original local read/drive/admit factories refuse remote attempts before any backend model lookup', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const a = attempt(h),
    locator = { ...h.locate(), spaceId: 'north', runId: a.scope.runId };
  const before = canonicalPayload(h.read());
  assert.equal((await h.service.openExpertReviewRead(h.request, locator)).ok, false);
  assert.equal((await h.service.openExpertReviewDrive(h.request, locator)).ok, false);
  assert.equal(
    (
      await h.service.admitExpertReview(h.request, {
        ...locator,
        expectedAttemptVersion: a.version,
        composition: a.composition,
      })
    ).ok,
    false,
  );
  assert.equal(h.calls.backendModel, 0);
  assert.equal(canonicalPayload(h.read()), before);
  const issuer = h.service.remoteRunAuthorities.reviews;
  assert.throws(() =>
    issuer.assertTargetGrant({ scope: a.scope, signal: new AbortController().signal }),
  );
});

test('remote independent review: two fixed reviewers commit through original atomic ballots without a client node-version CAS', async (t) => {
  const h = await reviewHost(t, { reviewers: ['qa', 'qa-two'] });
  await h.begin('qa');
  const first = h.fixed();
  await h.seal(first);
  const firstView = h.reviewView;
  await h.begin('qa-two');
  const second = h.fixed();
  await h.seal(second);
  const secondView = h.reviewView;
  h.setView(firstView);
  const one = h.submit(first);
  h.setView(secondView);
  const two = h.submit(second);
  const [a, b] = await Promise.all([one, two]);
  ok(a);
  ok(b);
  assert.equal(h.read().rounds[0].ballots.length, 2);
  assert.equal(h.read().comments.length, 2);
  assert.equal(h.read('consume').command.status, 'ready');
  assert(
    readExecutionReviewState(h.read()).attempts.every(
      (item) => item.status === 'completed' && item.resources === 'held',
    ),
  );
});

test('remote independent review: full-read failure records original needs-attention outcome, never approves, and waits for actual cleanup', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const value = h.fixed({ ranges: [[0, 1]] });
  await h.seal(value);
  no(await h.submit(value), 'remote-validation');
  const outcome = ok(
    await h.send(h.scoped('result-status', { resultRequestId: value.result.requestId })),
  );
  assert.equal(outcome.status, 'needs-attention');
  assert.equal(outcome.failure.code, 'review-read-required');
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.read().comments.length, 0);
  assert.equal(attempt(h).status, 'failed');
  assert.equal(attempt(h).resources, 'held');
  h.setView(ok(await h.send(h.scoped('status'))));
  assert.equal(ok(await h.cleanup()).resources, 'settled');
});

for (const action of ['stop', 'revoke'])
  test(`remote independent review: ${action} fences driving and result commit, while old-scope cleanup remains reachable`, async (t) => {
    const h = await reviewHost(t);
    await h.begin();
    const value = h.fixed(),
      scope = h.reviewView.scope;
    if (action === 'stop') {
      const body = h.envelope('stop', {
        scope,
        expectedAttemptVersion: h.reviewView.attemptVersion,
      });
      h.setView(ok(await h.send(body)));
      assert.equal(h.reviewView.resources, 'held');
      assert.equal(ok(await h.send(body)).disposition, 'replayed');
    } else h.member.abort();
    no(await h.send(h.scoped('input-read', { resourceRef: 'review_text', offset: 0, length: 10 })));
    no(await h.submit(value));
    assert.equal(h.read().rounds[0].ballots.length, 0);
    const retired = ok(await h.cleanup());
    assert.equal(retired.resources, 'settled');
    assert.equal(attempt(h).status, 'cancelled');
    assert.equal(h.read().artifactVersions.length, 1);
  });

test('remote independent review: renew preserves the original retained lease and subsequent real target reads', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const body = h.scoped('renew');
  h.setView(ok(await h.send(body)));
  assert.equal(ok(await h.send(body)).authority, 'drive');
  const page = ok(
    await h.send(h.scoped('input-read', { resourceRef: 'review_text', offset: 0, length: 2 })),
  );
  assert.equal(Buffer.from(page.base64, 'base64').toString(), 'Re');
});

test('remote independent review: same accept replays one reserved lane and changed model cannot replace the frozen composition', async (t) => {
  const h = await reviewHost(t);
  const body = h.accept();
  const first = ok(await h.send(body));
  const replay = ok(await h.send(body));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.scope, first.scope);
  const changed = structuredClone(body);
  changed.payload.model.model = 'another-local-model';
  no(await h.send(changed), 'remote-idempotency-mismatch');
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  assert.equal(h.calls.metadata, 1);
  assert.equal(h.calls.backendModel, 0);
});

test('remote independent review: cold recovery never grants driving; only the original sealed cut can be reauthorized and committed', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const value = h.fixed();
  await h.seal(value);
  const original = h.reviewView,
    root = h.root,
    identity = h.identity;
  await h.close();
  const cold = await reviewHost(t, { root, seed: false, identity });
  cold.setView(original);
  const wrong = cold.scoped('reconcile', { lastSequence: 999 });
  no(await cold.send(wrong), 'remote-scope-mismatch');
  const recovered = ok(
    await cold.send(
      cold.scoped('reconcile', {
        lastSequence: original.nextSequence - 1,
        resultRequestId: value.result.requestId,
      }),
    ),
  );
  cold.setView(recovered);
  assert.equal(recovered.authority, 'commit-only');
  no(
    await cold.send(
      cold.scoped('input-read', { resourceRef: 'review_text', offset: 0, length: 1 }),
    ),
    'remote-recovery-required',
  );
  assert.equal(ok(await cold.submit(value)).status, 'committed');
  assert.equal(cold.read().rounds[0].ballots.length, 1);
  await cold.close();
});

test('remote independent review: real AttachmentLocal file page is read through the original fixed target reader', async (t) => {
  const h = await reviewHost(t, { file: true });
  await h.begin();
  const resource = ok(await h.send(h.scoped('input-list'))).resources.find(
    (item) => item.kind === 'file',
  );
  const before = canonicalPayload(h.read()),
    reads = h.counts.read;
  const page = ok(
    await h.send(
      h.scoped('input-read', { resourceRef: resource.resourceRef, offset: 0, length: 8192 }),
    ),
  );
  assert.equal(Buffer.from(page.base64, 'base64').toString(), 'Required file material.');
  assert.equal(h.counts.read, reads + 1);
  assert.equal(h.service.fileReadResources.size, 0);
  assert.equal(canonicalPayload(h.read()), before);
  assert.equal(h.calls.backendModel, 0);
});

for (const action of ['stop', 'revoke'])
  test(`remote independent review: ${action} cannot settle while original attachment reader return is still pending`, async (t) => {
    const h = await reviewHost(t, { file: true });
    await h.begin();
    const resource = ok(await h.send(h.scoped('input-list'))).resources.find(
      (item) => item.kind === 'file',
    );
    const { deferred } = await import('./remote-review-fixture.mjs');
    const input = deferred(),
      drain = deferred(),
      entered = deferred();
    h.controls.input = input;
    h.controls.drain = drain;
    let returned = 0;
    h.attachments.readFileStream = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        entered.resolve();
        await input.promise;
        return { done: true };
      },
      async return() {
        returned++;
        await drain.promise;
        return { done: true };
      },
    });
    let readDone = false;
    const reading = h
      .send(h.scoped('input-read', { resourceRef: resource.resourceRef, offset: 0, length: 1 }))
      .then((value) => {
        readDone = true;
        return value;
      });
    await entered.promise;
    if (action === 'stop')
      h.setView(
        ok(
          await h.send(
            h.envelope('stop', {
              scope: h.reviewView.scope,
              expectedAttemptVersion: h.reviewView.attemptVersion,
            }),
          ),
        ),
      );
    else h.member.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert(returned > 0);
    assert.equal(readDone, false);
    let cleanupDone = false;
    const retiring = h.cleanup().then((value) => {
      cleanupDone = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupDone, false);
    assert.equal(attempt(h).resources, 'held');
    await h.service.remoteRunAuthorities.source.enqueue(async () => undefined);
    input.resolve();
    drain.resolve();
    no(await reading);
    assert.equal(ok(await retiring).resources, 'settled');
    assert.equal(h.service.fileReadResources.size, 0);
    assert.equal(h.read().rounds[0].ballots.length, 0);
  });

test('remote independent review: closed real scope before first received ACK retires only the reserved review lane', async (t) => {
  const h = await reviewHost(t);
  const view = ok(await h.send(h.accept()));
  h.setView(view);
  const body = h.envelope('cleanup', {
    scope: view.scope,
    permit: h.cleanupCredential.public,
    observation: {
      kind: 'drained',
      sequence: 1,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'closed-before-ack',
        nativeAgentId: 'closed-before-ack',
      },
    },
  });
  const value = ok(
    await h.send(body, { secret: h.cleanupCredential.raw, request: { headers: {} } }),
  );
  assert.equal(value.resources, 'settled');
  assert.equal(attempt(h).status, 'cancelled');
  assert.equal(attempt(h).nativeSessionId, undefined);
  assert.equal(attempt(h).nativeAgentId, undefined);
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  assert.equal(h.read().rounds[0].ballots.length, 0);
});

test('remote independent review: current target and native IDs stay pinned; borrowed IDs and changed target refuse with no vote', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const before = canonicalPayload(h.read());
  const body = h.scoped('event', {
    event: {
      kind: 'received',
      sequence: h.reviewView.nextSequence,
      nativeSessionId: 'borrowed',
      nativeAgentId: 'borrowed',
    },
  });
  no(await h.send(body));
  assert.equal(canonicalPayload(h.read()), before);
  const target = structuredClone(h.scoped('status'));
  target.payload.scope.review.target.artifactFingerprint = '0'.repeat(64);
  no(await h.send(target), 'remote-scope-mismatch');
  const secret = h.scoped('input-read', { resourceRef: 'review_text', offset: 0, length: 1 });
  no(await h.send(secret, { secret: h.cleanupCredential.raw }), 'remote-permit-revoked');
  assert.equal(h.read().comments.length, 0);
});

test('remote independent review: signed proof is checked before private resource qualification and accept lookup binds the entire target', async (t) => {
  const h = await reviewHost(t),
    body = h.accept();
  const signed = h.signBody(structuredClone(body));
  signed.proof.signature = 'A'.repeat(86);
  no(await h.service.remoteRun(h.request, signed, h.drive.raw), 'remote-proof-invalid');
  assert.equal(h.calls.metadata, 0);
  const accepted = ok(await h.send(body));
  h.setView(accepted);
  const lookup = h.envelope('reconcile', {
    target: { ...body.payload.target, artifactFingerprint: '0'.repeat(64) },
    reviewerRef: body.payload.reviewerRef,
    acceptRequestId: body.requestId,
    permit: h.drive.public,
  });
  no(await h.send(lookup));
  assert.equal(h.read().rounds[0].ballots.length, 0);
});

test('remote independent review: lost atomic ballot ACK retries one original receipt and reconciles the downstream unlock', async (t) => {
  const h = await reviewHost(t);
  await h.begin();
  const value = h.fixed();
  await h.seal(value);
  h.faults.afterNodeWrite = (node) => {
    if (node.nodeId === 'produce' && node.command.status === 'completed')
      throw Error('LOST_BALLOT_ACK');
  };
  no(await h.submit(value));
  h.faults.afterNodeWrite = undefined;
  const returned = ok(await h.submit(value));
  assert.equal(returned.status, 'confirmed');
  assert.equal(h.read().rounds[0].ballots.length, 1);
  assert.equal(h.read().comments.length, 1);
  assert.equal(h.read('consume').command.status, 'ready');
});
