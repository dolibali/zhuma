/** Actual original SDK reviewer/cuts/read ledger over real HTTP and Service.
 * Synthetic member leases/HTTP mount; no real model, GUI or two App proof. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  bootMemberLocalReview,
  toolResponse,
  response,
  readExecutionReviewState,
} from './zhuma-member-local-review-bundle.ts';
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-member-sdk-review-')),
    closes = [];
  t.onTestFinished(async () => {
    for (const close of closes.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  return bootMemberLocalReview(root, (close) => closes.push(close), options);
}
async function until(read, accept, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() >= deadline)
      throw Error(
        'Original remote reviewer did not reach expected state: ' + JSON.stringify(value),
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function find(value, predicate) {
  if (value && typeof value === 'object') {
    if (predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = find(child, predicate);
      if (found) return found;
    }
  } else if (typeof value === 'string') {
    try {
      return find(JSON.parse(value), predicate);
    } catch {}
  }
}
test('member native review: same original owner reads fixed text/file, seals without voting, then commits one ballot and independently drains', async (t) => {
  const heldSeal = Promise.withResolvers(),
    releaseSeal = Promise.withResolvers();
  const h = await setup(t, {
    beforeReply: async (body) => {
      if (body.operation === 'event' && body.payload.event.kind === 'sealed') {
        heldSeal.resolve();
        await releaseSeal.promise;
      }
    },
  });
  const run = await (await h.review.prepareAccept(randomUUID(), h.input)).send();
  await assert.rejects(h.owner.startReview({ ...run }));
  assert.equal(h.adapter.requests.length, 0);
  for (const r of run.composition.payload.targetResources)
    h.adapter.script.push(
      toolResponse(
        { resourceRef: r.resourceRef, offset: 0, length: r.bytes },
        `read-${r.resourceRef}`,
        'read_review_target',
      ),
    );
  h.adapter.script.push((request) => {
    const refs = [...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu))];
    assert.equal(refs.length, 2);
    return toolResponse(
      {
        conclusion: 'approve',
        rationale: '已阅读固定正文与文件。',
        anchors: [],
        evidenceRefs: refs,
      },
      'member-native-complete',
      'complete_review',
    )();
  });
  const work = h.owner.startReview(run);
  try {
    await heldSeal.promise;
    const attempt = readExecutionReviewState(h.backend.read()).attempts[0];
    assert.equal(attempt.status, 'running');
    assert.equal(attempt.resources, 'held');
    assert.equal(h.backend.read().rounds[0].ballots.length, 0);
    assert.equal(h.owner.canSwitchBackend(), false);
    assert.equal(
      h.ctx.agents.list().length,
      0,
      'same original SDK reviewer was actually retired before sealing',
    );
  } finally {
    releaseSeal.resolve();
  }
  await work;
  const done = await until(
    () => h.owner.readReview(run),
    (v) => v.phase === 'submitted',
  );
  assert.equal(done.remote.resources, 'settled');
  assert(done.receipt);
  assert.equal(h.backend.read().rounds[0].ballots.length, 1);
  assert.equal(h.backend.read('consume').command.status, 'ready');
  const reads = h.seen.filter((v) => v.operation === 'input-read');
  assert.equal(reads.length, 2);
  assert(reads.every((v) => v.result.ok));
  assert(find(h.adapter.requests[2], (v) => v.ok === true && v.text === 'Required file material.'));
  assert(!JSON.stringify(h.adapter.requests[0]).includes('Required file material.'));
  assert.equal(h.adapter.requests.length, 3);
  assert.equal(h.backend.calls.backendModel, 0);
  const submit = h.seen.find((v) => v.operation === 'submit-result');
  assert.equal(submit.payload.fixed.source.nativeSessionId, done.binding.nativeSessionId);
  assert.equal(submit.payload.fixed.readManifest.reads.length, 2);
  assert(submit.payload.fixed.source.cut.callSeq < submit.payload.fixed.source.cut.resultSeq);
  assert.equal(
    h.seen.find((v) => v.operation === 'event' && v.payload.event.kind === 'sealed').ballots,
    0,
  );
  await until(() => h.owner.canSwitchBackend(), Boolean);
});

test('member native review: actual Stop keeps a retained SDK model source held and never casts a ballot', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = await setup(t, {
    script: [
      async () => {
        entered.resolve();
        await release.promise;
        return response('Late review response.');
      },
    ],
  });
  const run = await (await h.review.prepareAccept(randomUUID(), h.input)).send();
  await h.owner.startReview(run);
  await entered.promise;
  const before = h.owner.readReview(run),
    stopping = h.owner.stopReview(run, {
      requestId: randomUUID(),
      expectedAttemptVersion: before.remote.attemptVersion,
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.owner.readReview(run).remote.resources, 'held');
    assert.equal(h.owner.canSwitchBackend(), false);
    assert.equal(h.backend.read().rounds[0].ballots.length, 0);
  } finally {
    release.resolve();
  }
  await stopping;
  await until(
    () => h.owner.readReview(run),
    (v) => v.remote.resources === 'settled',
  );
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.backend.read().rounds[0].ballots.length, 0);
});

test('member native review: a late genuine unstarted accept has original cleanup without a new native Agent', async (t) => {
  const h = await setup(t),
    run = await (await h.review.prepareAccept(randomUUID(), h.input)).send();
  await h.owner.stopReview(run, {
    requestId: randomUUID(),
    expectedAttemptVersion: run.value.attemptVersion,
  });
  await h.owner.close();
  assert.equal(h.owner.readReview(run).remote.resources, 'settled');
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.backend.read().rounds[0].ballots.length, 0);
  assert.equal(
    h.seen.find((v) => v.operation === 'cleanup').payload.observation.evidence.basis,
    'absent-unadmitted',
  );
});

test('member native review: an omitted required file records the original fixed-target refusal and never votes or releases downstream', async (t) => {
  const h = await setup(t),
    run = await (await h.review.prepareAccept(randomUUID(), h.input)).send(),
    text = run.composition.payload.targetResources.find((r) => r.kind === 'text');
  h.adapter.script.push(
    toolResponse(
      { resourceRef: text.resourceRef, offset: 0, length: text.bytes },
      'read-text-only',
      'read_review_target',
    ),
    (request) => {
      const refs = [...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu))];
      return toolResponse(
        {
          conclusion: 'approve',
          rationale: 'Only the text was read.',
          anchors: [],
          evidenceRefs: refs,
        },
        'missing-file-completion',
        'complete_review',
      )();
    },
    'Review remains incomplete.',
  );
  await h.owner.startReview(run);
  await until(
    () => h.owner.readReview(run),
    (v) => v.remote.resources === 'settled',
  );
  assert.equal(h.backend.read().rounds[0].ballots.length, 0);
  assert.equal(h.backend.read('consume').command.status, 'blocked');
  const failed = h.seen.find((v) => v.operation === 'result-status');
  assert.equal(failed.result.value.status, 'needs-attention');
  assert.equal(failed.result.value.failure.code, 'review-read-required');
  assert.equal(h.ctx.agents.list().length, 0);
});
