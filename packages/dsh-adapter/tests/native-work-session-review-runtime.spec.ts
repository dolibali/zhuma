/** Real original SDK/factory/persistence and file I/O. Model/authority/target
 * selection are synthetic fixtures; no D authentication or ballot proof. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import {
  bootNativeReviews,
  bootNativeResults,
  toolResponse,
  NATIVE_REVIEW_LIMITS,
} from './zhuma-native-review-runtime-bundle.ts';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-sdk-'));
  const h = await bootNativeReviews(root, options);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return h;
}
async function history(h, grant) {
  const events = [];
  for (;;) {
    const page = await h.service.history(grant, events.at(-1)?.seq ?? -1);
    events.push(...page.events);
    if (page.events.length < 100) return events;
  }
}
function completionErrors(events) {
  return events
    .filter((event) => event.type === 'tool/result')
    .flatMap((event) => {
      try {
        const value = JSON.parse(event.data.message.content[0].text);
        return value.ok === false ? [value.code] : [];
      } catch {
        return [];
      }
    });
}

test('original SDK: author and two independent reviewer sessions/tools/history remain isolated; actual returned bytes produce original-owner fixed reviews only after retirement', async (t) => {
  const h = await setup(t);
  h.adapter.script.push('Author-only conversation.');
  await h.service.send(h.author, h.authorMessage);
  await h.actors.get('author').whenIdle();
  const author = h.service.open(h.author).binding;
  const a = h.reviewer('expert-a'),
    b = h.reviewer('expert-b');
  const fixed = [];
  for (const reviewer of [a, b]) {
    h.planReview(reviewer);
    await h.start(reviewer);
    await reviewer.actor().whenIdle();
    const prepared = await h.review.prepareFixedReview(
      reviewer.grant,
      new AbortController().signal,
    );
    assert.equal(prepared.status, 'ready');
    const lease = await h.review.readFixedReview(
      reviewer.grant,
      prepared.ref,
      new AbortController().signal,
    );
    assert.equal(lease.content.conclusion, 'approve');
    assert.equal(lease.source.context.scope.actorId, h.author.scope.actorId);
    assert.equal(lease.source.context.scope.nodeId, h.author.scope.nodeId);
    assert.equal(
      lease.source.context.review.principal.reviewerRef.id,
      reviewer.scope.review.principal.reviewerRef.id,
    );
    assert.equal(lease.readManifest.reads.length, 1);
    assert.deepEqual(lease.readManifest.reads[0].range, {
      offset: 0,
      length: 32,
      total: Buffer.byteLength(h.text),
    });
    assert.equal(lease.readManifest.reads[0].source.resourceRef, 'fixed-body');
    assert.ok(lease.readManifest.reads[0].resultSeq < lease.source.cut.callSeq);
    assert.ok(
      lease.source.cut.callSeq < lease.source.cut.resultSeq &&
        lease.source.cut.resultSeq < lease.source.cut.turnEndSeq,
    );
    assert.equal(h.ctx.agents.get(lease.source.nativeSessionId), undefined);
    assert.equal(
      h.runtime.migrationDrain(lease.source.nativeSessionId).basis,
      'flushed-and-closed',
    );
    const events = await history(h, reviewer.grant);
    assert.ok(JSON.stringify(events).includes('Fixed target: API status'));
    assert.equal(JSON.stringify(events).includes('Author-only conversation.'), false);
    assert.throws(() => h.review.assertFixedReview(reviewer.grant, { ...prepared.ref }), {
      code: 'review-result-rejected',
    });
    lease.check();
    lease.release();
    assert.throws(() => lease.check(), { code: 'cancelled' });
    fixed.push({ prepared, source: lease.source, grant: reviewer.grant });
  }
  assert.notEqual(fixed[0].source.nativeSessionId, fixed[1].source.nativeSessionId);
  assert.notEqual(fixed[0].source.nativeSessionId, author.nativeSessionId);
  assert.throws(() => h.review.assertFixedReview(b.grant, fixed[0].prepared.ref), {
    code: 'review-result-rejected',
  });
  assert.equal(JSON.stringify(await history(h, h.author)).includes('Fixed target:'), false);
  assert.deepEqual(h.adapter.requests[0].tools ?? [], []);
  for (const request of h.adapter.requests.slice(1))
    assert.deepEqual(request.tools.map((tool) => tool.name).sort(), [
      'complete_review',
      'read_review_target',
    ]);
  assert.equal(h.reads.length, 2);
  assert.equal(h.leases.size, 0);
});

test('original SDK: idle/ACK/turnEnd cannot issue a fixed review while the actual retirement barrier is held', async (t) => {
  const h = await setup(t),
    r = h.reviewer();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const retire = h.runtime.retire.bind(h.runtime);
  h.runtime.retire = async (...args) => {
    entered.resolve();
    await release.promise;
    return retire(...args);
  };
  t.onTestFinished(() => release.resolve());
  h.planReview(r);
  await h.start(r);
  await r.actor().whenIdle();
  await entered.promise;
  await assert.rejects(h.service.updateQueue(r.grant, { kind: 'reorder', messageIds: [] }), {
    code: 'completion-pending',
  });
  await assert.rejects(h.service.reserveInputRead(r.grant), { code: 'completion-pending' });
  const wait = new AbortController();
  const pending = h.review.prepareFixedReview(r.grant, wait.signal);
  wait.abort();
  assert.deepEqual(await pending, { status: 'pending', reason: 'draining' });
  assert.notEqual(h.ctx.agents.get(h.service.open(r.grant).binding.nativeSessionId), undefined);
  release.resolve();
  const fixed = await h.review.prepareFixedReview(r.grant, new AbortController().signal);
  assert.equal(fixed.status, 'ready');
  h.review.assertFixedReview(r.grant, fixed.ref);
});

test('original SDK: fabricated evidence with no successful body read never creates an intent or fixed review', async (t) => {
  const h = await setup(t),
    r = h.reviewer();
  h.adapter.script.push(
    toolResponse(
      {
        conclusion: 'approve',
        rationale: 'Unsupported assertion.',
        anchors: [],
        evidenceRefs: [`review_read_${'f'.repeat(64)}`],
      },
      'unread-completion',
      'complete_review',
    ),
    'Cannot decide without reading.',
  );
  await h.start(r);
  await r.actor().whenIdle();
  assert.ok(completionErrors(await history(h, r.grant)).includes('review-read-required'));
  assert.equal(h.service.reviewIntent(r.grant), undefined);
  assert.deepEqual(await h.review.prepareFixedReview(r.grant, new AbortController().signal), {
    status: 'pending',
    reason: 'not-declared',
  });
  assert.equal(h.reads.length, 0);
});

test('original SDK: oversized UTF-8 review is rejected before intent/positive ACK and public projection does not truncate the native log', async (t) => {
  const h = await setup(t),
    r = h.reviewer();
  h.planReview(r, 'approve', '审'.repeat(100000));
  h.adapter.script.push('Review is too large.');
  await h.start(r);
  await r.actor().whenIdle();
  assert.ok(completionErrors(await history(h, r.grant)).includes('output-too-large'));
  assert.equal(h.service.reviewIntent(r.grant), undefined);
  const raw = await h.service.readReviewSnapshot(r.grant, r.grant.signal);
  assert.ok(
    raw.events.some(
      (event) =>
        event.type === 'tool/call' &&
        event.data.name === 'complete_review' &&
        event.data.arguments.includes('审'.repeat(100000)),
    ),
  );
  assert.deepEqual(await h.review.prepareFixedReview(r.grant, new AbortController().signal), {
    status: 'pending',
    reason: 'not-declared',
  });
});

test('original SDK: actual private log scan headroom is checked before accepting an otherwise valid declaration', async (t) => {
  const h = await setup(t),
    r = h.reviewer();
  h.planReview(r);
  const complete = h.adapter.script[1];
  h.adapter.script[1] = (request) => {
    appendPluginRecord(r.actor().session, 'plugin:zhuma/review-proof-padding', {
      text: 'x'.repeat(8200000),
    });
    return complete(request);
  };
  h.adapter.script.push('Insufficient fixed-cut headroom.');
  await h.start(r);
  await r.actor().whenIdle();
  const raw = await h.service.readReviewSnapshot(r.grant, r.grant.signal);
  assert.ok(raw.sourceBytes < NATIVE_REVIEW_LIMITS.scanBytes);
  assert.ok(
    raw.sourceBytes + NATIVE_REVIEW_LIMITS.publicFrameBytes > NATIVE_REVIEW_LIMITS.scanBytes,
  );
  assert.ok(completionErrors(raw.events).includes('output-too-large'));
  assert.equal(h.service.reviewIntent(r.grant), undefined);
});

for (const action of ['stop', 'revoke'])
  test(`original SDK: ${action} during an actual pending read issues no fixed review and retains the source drain until I/O settles`, async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const h = await setup(t, {
      beforeRead: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const r = h.reviewer();
    t.onTestFinished(() => release.resolve());
    h.adapter.script.push(
      toolResponse(
        { resourceRef: 'fixed-body', offset: 0, length: 32 },
        'held-read',
        'read_review_target',
      ),
    );
    await h.start(r);
    await entered.promise;
    let drained = false;
    const drain = h.service.whenInputReadsIdle(r.grant.scope).then(() => {
      drained = true;
    });
    let stopping;
    if (action === 'stop') stopping = h.service.stop(r.grant);
    else r.revoke();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    if (action === 'stop')
      assert.deepEqual(await h.review.prepareFixedReview(r.grant, new AbortController().signal), {
        status: 'pending',
        reason: 'not-declared',
      });
    else await assert.rejects(h.review.prepareFixedReview(r.grant, new AbortController().signal));
    release.resolve();
    await drain;
    await stopping;
    assert.equal(h.leases.size, 0);
  });

test('original SDK: copied locator, author grant and another owner cannot start review work', async (t) => {
  const h = await setup(t),
    other = await setup(t),
    r = h.reviewer();
  for (const raw of [{ ...r.original }, h.author, r.scope])
    assert.throws(() => h.service.reviewGrant(raw), { code: 'review-authority-denied' });
  assert.throws(() => other.service.send(r.grant, { ...h.authorMessage, selection: r.selection }), {
    code: 'review-authority-denied',
  });
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(other.adapter.requests.length, 0);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(other.ctx.agents.list().length, 0);
});

test('original SDK: a Chinese UTF-8 page with BOM exposes only complete characters and reports the actual byte prefix', async (t) => {
  const h = await setup(t, { text: '\ufeff' + '审'.repeat(3000) }),
    r = h.reviewer();
  h.planReview(r);
  await h.start(r);
  await r.actor().whenIdle();
  const prepared = await h.review.prepareFixedReview(r.grant, new AbortController().signal);
  assert.equal(prepared.status, 'ready');
  const lease = await h.review.readFixedReview(r.grant, prepared.ref, new AbortController().signal);
  assert.deepEqual(lease.readManifest.reads[0].range, { offset: 0, length: 30, total: 9003 });
  assert.equal(
    h.reads[0].range.length,
    32,
    'Actual source read and exposed body prefix remain separate facts',
  );
  assert.ok(JSON.stringify(h.adapter.requests[1]).includes('\ufeff' + '审'.repeat(9)));
  lease.check();
  lease.release();
});

test('original SDK: Host-declared required unsupported material prevents decisions while a comment preserves the limitation', async (t) => {
  const limitation = [{ resourceRef: 'required-pdf', code: 'review-unsupported-material' }];
  const h = await setup(t, { unavailableRequired: limitation });
  for (const conclusion of ['approve', 'request-changes', 'comment']) {
    const r = h.reviewer(`expert-${conclusion}`);
    h.planReview(r, conclusion);
    if (conclusion !== 'comment') h.adapter.script.push('A required material cannot be reviewed.');
    await h.start(r);
    await r.actor().whenIdle();
    const prepared = await h.review.prepareFixedReview(r.grant, new AbortController().signal);
    if (conclusion === 'comment') {
      assert.equal(prepared.status, 'ready');
      const lease = await h.review.readFixedReview(
        r.grant,
        prepared.ref,
        new AbortController().signal,
      );
      assert.equal(lease.content.conclusion, 'comment');
      assert.deepEqual(lease.readManifest.unavailableRequired, limitation);
      lease.release();
    } else {
      assert.deepEqual(prepared, { status: 'pending', reason: 'not-declared' });
      assert.ok(
        completionErrors(await history(h, r.grant)).includes('review-unsupported-material'),
      );
    }
  }
});

for (const text of ['Author compatibility result.', '中'.repeat(100000)])
  test(`original SDK author compatibility: original Cookie/Run completion still accepts ${text.length} characters without review tools`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-review-author-compat-'));
    const h = await bootNativeResults(root);
    t.onTestFinished(async () => {
      await h.close();
      await rm(root, { recursive: true, force: true });
    });
    const input = await h.upload('Original author upstream content.');
    await h.submit(input, 'review-author-input');
    await h.ballot('approve', 'review-author-input-approved');
    const opened = await h.begin();
    t.onTestFinished(() => opened.dispose());
    h.adapter.script.push(toolResponse({ text, links: [] }, 'author-complete', 'complete_work'));
    await h.native.service.send(opened.grant, h.firstMessage());
    await h.actor().whenIdle();
    const fixed = await h.results.prepareFixedResult(opened.grant, new AbortController().signal);
    assert.equal(fixed.status, 'ready');
    const lease = await h.results.readFixedResult(
      opened.grant,
      fixed.ref,
      new AbortController().signal,
    );
    assert.equal(lease.content.text, text);
    lease.check();
    lease.release();
    assert.equal(
      h.adapter.requests[0].tools.some(
        (tool) => tool.name === 'complete_review' || tool.name === 'read_review_target',
      ),
      false,
    );
  });
