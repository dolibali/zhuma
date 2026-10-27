/** Real original SDK/factory/persistence and file I/O. Model/authority/target
 * selection are synthetic fixtures; no D authentication or ballot proof. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import {
  bootNativeReviews,
  bootNativeResults,
  toolResponse,
  NATIVE_REVIEW_LIMITS,
  boot,
  ScriptedAdapter,
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

test('original SDK isolated Skill: only the original execution result releases its review read before completion', async (t) => {
  const h = await setup(t, { isolatedSkill: true }),
    r = h.reviewer('isolated-skill-reviewer'),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    ready = Promise.withResolvers();
  t.onTestFinished(() => release.resolve());
  t.onTestFinished(
    h.review.onReviewReady((actual, ref) => {
      if (actual === r.grant) ready.resolve(ref);
    }),
  );
  const stop = h.ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      if (exec.name === 'read_review_target') {
        entered.resolve({ exec, result });
        await release.promise;
      }
      return next();
    },
    { global: true },
  );
  t.onTestFinished(stop);
  h.adapter.script.push(toolResponse({ name: 'selected-review' }, 'load-selected-review', 'skill'));
  h.planReview(r);
  await h.start(r);
  const { exec, result } = await entered.promise;
  assert.equal(h.leases.size, 1);
  let drained = false;
  const draining = h.service.whenInputReadsIdle(r.grant.scope).then(() => (drained = true));
  // Synthetic negative notifications cannot release the real SDK execution:
  // foreign token, borrowed token with another Agent, or a copied execution.
  for (const foreign of [
    { ...exec, token: Symbol('foreign-tool-execution') },
    { ...exec, agent: { ...exec.agent } },
    { ...exec },
  ])
    h.ctx.emit('tools/result', foreign, result);
  await new Promise(setImmediate);
  assert.equal(drained, false);
  assert.equal(h.leases.size, 1);
  release.resolve();
  await draining;
  await r.actor().whenIdle();
  const ref = await ready.promise;
  h.review.assertFixedReview(r.grant, ref);
  assert.equal(h.leases.size, 0);
  assert.equal(h.adapter.requests.length, 3);
  const events = await history(h, r.grant);
  assert.match(JSON.stringify(events), /SELECTED_ORIGINAL_SKILL_BODY/u);
  assert.deepEqual(completionErrors(events), []);
});

for (const destination of ['author-only', 'other-review-owner'])
  test(`original SDK capability: copied review grants cannot fall back to author routing in ${destination}`, async (t) => {
    const source = await setup(t),
      reviewer = source.reviewer('nontransferable-reviewer'),
      root = await mkdtemp(join(tmpdir(), 'zhuma-review-copy-destination-'));
    const target =
      destination === 'author-only'
        ? await boot(root, new ScriptedAdapter())
        : await bootNativeReviews(root);
    t.onTestFinished(async () => {
      await target.close();
      await rm(root, { recursive: true, force: true });
    });
    const input = {
      requestId: 'reject-copy',
      text: 'A copied review capability must never execute as an author.',
      mode: 'followup',
      selection: reviewer.selection,
    };
    await assert.rejects(async () => target.service.send(reviewer.grant, input), {
      code: 'review-authority-denied',
    });
    const freshSignal = () => new AbortController().signal;
    const freshScope = () => structuredClone(reviewer.grant.scope);
    const variants = [
      ['shallow', { ...reviewer.grant }],
      ['deep-scope', { ...reviewer.grant, scope: freshScope() }],
      ['scope-only', { scope: reviewer.grant.scope, signal: freshSignal(), assertCurrent() {} }],
      ['signal-only', { scope: freshScope(), signal: reviewer.grant.signal, assertCurrent() {} }],
      [
        'method-only',
        { scope: freshScope(), signal: freshSignal(), assertCurrent: reviewer.grant.assertCurrent },
      ],
      [
        'bound-method',
        {
          scope: freshScope(),
          signal: freshSignal(),
          assertCurrent: reviewer.grant.assertCurrent.bind(reviewer.grant),
        },
      ],
      [
        'forwarded-method',
        {
          scope: freshScope(),
          signal: freshSignal(),
          assertCurrent(action) {
            reviewer.grant.assertCurrent(action);
          },
        },
      ],
    ] as const;
    for (const [name, copied] of variants) {
      target.adapter.script.push('This copied review grant must never reach a model.');
      let refused;
      try {
        await target.service.send(copied, { ...input, requestId: name });
        const binding = target.service.open(copied)?.binding;
        await target.ctx.agents.get(binding?.nativeAgentId)?.whenIdle();
      } catch (error) {
        refused = error;
      }
      assert.equal(
        refused?.code,
        'review-authority-denied',
        `${name}: model calls=${target.adapter.requests.length}`,
      );
      assert.equal(target.adapter.requests.length, 0);
      assert.deepEqual(
        [...target.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries()],
        [],
      );
    }
    // A normal original author still follows the unchanged author contract.
    target.adapter.script.splice(
      0,
      target.adapter.script.length,
      'A normal author remains usable.',
    );
    await target.service.send(source.author, source.authorMessage);
    const author = target.service.open(source.author).binding;
    await target.ctx.agents.get(author.nativeAgentId).whenIdle();
    assert.equal(target.adapter.requests.length, 1);
    assert.deepEqual(target.adapter.requests[0].tools ?? [], []);
    source.adapter.script.push('The original reviewer remains usable.');
    await source.start(reviewer);
    await reviewer.actor().whenIdle();
    assert.equal(source.adapter.requests.length, 1);
    assert.deepEqual(source.adapter.requests[0].tools.map((tool) => tool.name).sort(), [
      'complete_review',
      'read_review_target',
    ]);
  });

for (const ending of ['stop', 'revoke'])
  test(`original SDK cleanup: warm routed review after ${ending} retains its original role and physically retires`, async (t) => {
    const h = await setup(t),
      r = h.reviewer();
    h.adapter.script.push('Review is waiting for a controller decision.');
    await h.start(r);
    await r.actor().whenIdle();
    const before = h.service.open(r.grant).binding;
    // Explicit D-style original-issuer cleanup contract, independent of drive.
    const originals = new WeakSet<object>();
    const cleanup = Object.freeze({
      scope: r.grant.scope,
      assertCurrent() {
        assert.ok(originals.has(cleanup));
        return undefined;
      },
    });
    originals.add(cleanup);
    if (ending === 'stop') assert.equal((await h.service.stop(r.grant)).status, 'stopped');
    else r.revoke();
    const result = await h.service.retireForCleanup(cleanup, new AbortController().signal);
    assert.equal(result.status, 'retired');
    if (result.status !== 'retired') throw Error('actual retirement did not finish');
    assert.equal(result.binding?.nativeSessionId, before.nativeSessionId);
    assert.equal(result.binding?.nativeAgentId, before.nativeAgentId);
    assert.equal(result.drain.basis, 'flushed-and-closed');
    result.drain.assertCurrent();
    assert.equal(h.ctx.agents.get(before.nativeAgentId), undefined);
    assert.equal(h.runtime.migrationDrain(before.nativeSessionId).basis, 'flushed-and-closed');
    assert.equal(h.adapter.requests.length, 1);
  });

for (const ending of ['stop', 'revoke'])
  test(`original SDK cleanup: ${ending} retains the actual review source I/O until physical retirement finishes`, async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const h = await setup(t, {
        beforeRead: async () => {
          entered.resolve();
          await release.promise;
        },
      }),
      r = h.reviewer();
    h.planReview(r);
    await h.start(r);
    await entered.promise;
    const before = h.service.open(r.grant).binding;
    const originals = new WeakSet<object>();
    const cleanup = Object.freeze({
      scope: r.grant.scope,
      assertCurrent() {
        assert.ok(originals.has(cleanup));
        return undefined;
      },
    });
    originals.add(cleanup);
    const stopped = ending === 'stop' ? h.service.stop(r.grant) : undefined;
    if (ending === 'revoke') r.revoke();
    const waiter = new AbortController(),
      retiring = h.service.retireForCleanup(cleanup, waiter.signal);
    waiter.abort();
    assert.deepEqual(await retiring, { status: 'pending' });
    let idle = false;
    const drain = h.service.whenRetirementsIdle().then(() => (idle = true));
    await new Promise(setImmediate);
    assert.equal(idle, false);
    release.resolve();
    if (stopped) assert.equal((await stopped).status, 'stopped');
    await drain;
    const result = await h.service.retireForCleanup(cleanup, new AbortController().signal);
    assert.equal(result.status, 'retired');
    if (result.status !== 'retired') throw Error('actual review I/O did not drain');
    assert.equal(result.binding?.nativeSessionId, before.nativeSessionId);
    assert.equal(result.drain.basis, 'flushed-and-closed');
    result.drain.assertCurrent();
    assert.equal(h.ctx.agents.get(before.nativeAgentId), undefined);
    assert.equal(h.leases.size, 0);
    assert.equal(h.adapter.requests.length, 1);
  });

// Run this case in two separately launched original SDK worker processes. The
// producer closes before the consumer starts. Only persisted locators travel;
// the consumer's cleanup issuer identity is a new explicit Host-port fixture.
const cleanupPhase = process.env.ZHUMA_REVIEW_CLEANUP_PHASE;
(cleanupPhase ? test : test.skip)(
  'original SDK cleanup process: a new OS owner cleans the persisted v3 review without reacquiring send/read or constructing an Agent',
  async (t) => {
    const root = process.env.ZHUMA_REVIEW_CLEANUP_HOME;
    if (!root || !['producer', 'consumer'].includes(cleanupPhase!))
      throw Error('explicit isolated cleanup phase/home required');
    const factsPath = join(root, 'cleanup-facts.json');
    if (cleanupPhase === 'producer') {
      const h = await bootNativeReviews(root);
      t.onTestFinished(() => h.close());
      h.adapter.script.push('Author history must stay separate.');
      await h.service.send(h.author, h.authorMessage);
      await h.actors.get('author').whenIdle();
      const author = h.service.open(h.author).binding;
      const reviewer = h.reviewer('cold-cleanup');
      h.adapter.script.push('Persist the review session for independent cleanup.');
      await h.start(reviewer);
      await reviewer.actor().whenIdle();
      const binding = h.service.open(reviewer.grant).binding;
      assert.notEqual(author.nativeSessionId, binding.nativeSessionId);
      await writeFile(
        factsPath,
        JSON.stringify({ scope: reviewer.scope, binding, author, producerPid: process.pid }),
      );
      return;
    }
    const facts = JSON.parse(await readFile(factsPath, 'utf8'));
    assert.notEqual(process.pid, facts.producerPid);
    const hashes = async () => {
      const result: Record<string, string> = {};
      for (const base of ['domains', 'sessions'])
        for (const relative of await readdir(join(root, base), { recursive: true }))
          if (relative.endsWith('.json') || relative.endsWith('.jsonl'))
            result[`${base}/${relative}`] = createHash('sha256')
              .update(await readFile(join(root, base, relative)))
              .digest('hex');
      return result;
    };
    const before = await hashes(),
      original = Object.freeze({}),
      originals = new WeakMap<object, unknown>([[original, facts.scope]]),
      forbidden: string[] = [];
    const refuse = (name: string) => () => {
      forbidden.push(name);
      throw Error(`cleanup attempted ${name}`);
    };
    const adapter = new ScriptedAdapter();
    const h = await boot(
      root,
      adapter,
      refuse('Agent composition'),
      {},
      {
        authorize: refuse('send qualification'),
        readTarget: refuse('target read'),
        unavailableRequired: refuse('target catalog'),
        authorizeCleanup(value: object) {
          if (!originals.has(value)) throw Error('not the new cleanup issuer original');
          return originals.get(value);
        },
      },
    );
    t.onTestFinished(() => h.close());
    assert.throws(() => h.service.reviewGrant(original));
    assert.deepEqual(forbidden, ['send qualification']);
    forbidden.length = 0;
    await assert.rejects(
      h.service.retireReviewForCleanup({ ...original }, new AbortController().signal),
    );
    const result = await h.service.retireReviewForCleanup(original, new AbortController().signal);
    assert.equal(result.status, 'retired');
    if (result.status !== 'retired') throw Error('persisted review was not physically retired');
    assert.equal(result.binding?.nativeSessionId, facts.binding.nativeSessionId);
    assert.equal(result.binding?.nativeAgentId, facts.binding.nativeAgentId);
    assert.equal(
      result.binding?.selection.configurationId,
      facts.binding.selection.configurationId,
    );
    assert.equal(result.drain.basis, 'flushed-and-closed');
    result.drain.assertCurrent();
    assert.equal(h.runtime.isConnected(facts.binding.nativeSessionId), false);
    assert.equal(h.ctx.agents.get(facts.binding.nativeAgentId), undefined);
    assert.equal(h.ctx.agents.get(facts.author.nativeAgentId), undefined);
    assert.equal(adapter.requests.length, 0);
    assert.deepEqual(forbidden, []);
    assert.deepEqual(await hashes(), before);
    await writeFile(
      join(root, 'cleanup-consumer.json'),
      JSON.stringify({
        producerPid: facts.producerPid,
        consumerPid: process.pid,
        basis: result.drain.basis,
        nativeSessionId: result.binding?.nativeSessionId,
        modelCalls: adapter.requests.length,
        forbidden,
        before,
        after: await hashes(),
      }),
    );
  },
);

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
