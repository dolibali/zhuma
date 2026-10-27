import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { open, caller, checked, refused } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { command, available } from './execution-run-fixture.mjs';
import {
  beginExecutionRun,
  readExecutionRunState,
  withExecutionRunState,
} from '../dist/execution-run-state.js';
import {
  enableExecutionReviewWriter,
  prepareExecutionReviewWriter,
  prepareExecutionRunWriter,
  assertExecutionRunStoreCompatibility,
} from '../dist/execution-run-protocol.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';

// Product Service/original DSH JSON and queue. Member/config/native inputs are
// explicit contracts; no real login, native review or model is exercised. Only
// explicit local-attachment cases below prove real fixed file bytes.
function workbench() {
  const f = fixture();
  f.state.participants.find((p) => p.id === 'qa').instructions =
    'Review the fixed content independently.';
  f.state.participants.push({ ...f.state.participants.find((p) => p.id === 'qa'), id: 'qa-two' });
  return applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      status: 'ready',
      participantIds: ['chen', 'qa', 'qa-two', 'outside'],
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [
            { ...f.node, id: 'produce', skillIds: [], reviewerIds: ['qa', 'qa-two', 'outside'] },
            { ...f.node, id: 'parallel', skillIds: [], reviewerIds: [], reviewRequired: false },
            {
              ...f.node,
              id: 'consume',
              skillIds: [],
              dependsOn: ['produce'],
              reviewerIds: [],
              reviewRequired: false,
            },
          ],
        },
      ],
    },
  });
}
async function host(t, { file, links = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-service-'));
  const snapshot = workbench();
  let media, attachments;
  if (file) {
    const ctx = new Context();
    media = ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'attachments') });
    await media;
    attachments = ctx.attachments;
  }
  const h = await open(root, { workbench: snapshot, attachments });
  t.after(async () => {
    await h.close();
    await media?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const files = [];
  if (file) {
    const bytes = Buffer.from(file.text);
    const upload = checked(
      await h.service.uploadFile(
        caller(),
        {
          ...h.locate(),
          spaceId: 'north',
          idempotencyKey: 'upload-fixed-review-file',
          declare: {
            name: file.name,
            mediaType: file.mediaType,
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          data: (async function* () {
            yield bytes;
          })(),
        },
        {
          lease: {
            memberId: 'chen',
            expiresAt: Date.now() + 60_000,
            signal: new AbortController().signal,
            assertCurrent(spaceId) {
              assert.equal(spaceId, 'north');
            },
            release() {},
          },
          assertProjectSpace(projectId, spaceId) {
            assert.equal(projectId, 'project');
            assert.equal(spaceId, 'north');
          },
        },
      ),
    );
    files.push(upload.reference);
  }
  checked(
    await h.service.submit(
      caller(),
      {
        ...h.human('produce', 'deliver'),
        text: 'POST /login requires a valid challenge.',
        files,
        links,
      },
      file
        ? async () => ({
            lease: {
              memberId: 'chen',
              expiresAt: Date.now() + 60_000,
              signal: new AbortController().signal,
              assertCurrent(spaceId) {
                assert.equal(spaceId, 'north');
              },
              release() {},
            },
            assertProjectSpace(projectId, spaceId) {
              assert.equal(projectId, 'project');
              assert.equal(spaceId, 'north');
            },
          })
        : undefined,
    ),
  );
  h.resetCounts();
  return { ...h, root, snapshot, attachments };
}
async function body(h, patch = {}) {
  const target = checked(
    await h.service.readExpertReviewTarget(h.request, { ...h.locate(), spaceId: 'north' }),
  );
  return {
    requestId: 'prepare-review',
    expectedReviewVersion: h.read().nativeExecution?.review?.version ?? 0,
    target,
    reviewerRef: { id: 'qa', version: target.planId },
    configurationId: 'reserved-review-configuration',
    ...patch,
  };
}

test('review Service: discovery is zero-write; original queue persists marker before the first v2 node and never votes', async (t) => {
  const h = await host(t);
  const beforeDiscovery = await businessHashes(h.root);
  const request = await body(h);
  assert.deepEqual(await businessHashes(h.root), beforeDiscovery);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  h.faults.afterGlobalWrite = () => {
    assert.equal(h.domain.global.get().nativeReviewWriter, 1);
    assert.equal(h.read().nativeExecution, undefined, 'barrier is durable before any review row');
  };
  const before = structuredClone(h.read());
  const prepared = checked(await h.service.prepareExpertReview(h.request, request));
  assert.equal(prepared.disposition, 'applied');
  assert.equal(prepared.attempt.scope.actorId, 'chen');
  assert.equal(prepared.attempt.scope.review.principal.reviewerRef.id, 'qa');
  assert.deepEqual(h.domain.global.get(), {
    schemaVersion: 1,
    nativeExecutionWriter: 1,
    nativeReviewWriter: 1,
  });
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  assert.deepEqual(h.read().command, before.command);
  assert.deepEqual(h.read().rounds, before.rounds);
  assert.deepEqual(h.read().artifactVersions, before.artifactVersions);
  assert.deepEqual(h.read().receipts, before.receipts);
  assert.equal(h.read('consume').command.status, 'blocked');
  assert.equal(readExecutionRunState(h.read()), undefined);
  assert.equal(readExecutionReviewState(h.read()).attempts.length, 1);
  const stored = await businessHashes(h.root);
  prepared.attempt.scope.review.principal.reviewerRef.id = 'mutated-client-copy';
  assert.deepEqual(await businessHashes(h.root), stored);
  assert.equal(
    h.read().nativeExecution.review.attempts[0].scope.review.principal.reviewerRef.id,
    'qa',
  );
});

test('review Service: a lost successful reply recovers the same receipt with zero new writes', async (t) => {
  const h = await host(t),
    request = await body(h);
  let lost = false;
  h.faults.afterNodeWrite = () => {
    if (!lost) {
      lost = true;
      throw Error('CONTRACT_LOST_REPLY');
    }
  };
  refused(await h.service.prepareExpertReview(h.request, request), 'unavailable');
  const stored = await businessHashes(h.root),
    runId = h.read().nativeExecution.review.attempts[0].scope.runId;
  h.resetCounts();
  const replay = checked(await h.service.prepareExpertReview(h.request, request));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.attempt.scope.runId, runId);
  assert.deepEqual(await businessHashes(h.root), stored);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('review Service: concurrent reviewers serialize reservations and retain separate per-attempt versions', async (t) => {
  const h = await host(t),
    first = await body(h);
  const second = {
    ...first,
    requestId: 'prepare-second',
    reviewerRef: { ...first.reviewerRef, id: 'qa-two' },
  };
  const results = await Promise.all([
    h.service.prepareExpertReview(h.request, first),
    h.service.prepareExpertReview(h.request, second),
  ]);
  checked(results[0]);
  refused(results[1], 'review-conflict');
  checked(await h.service.prepareExpertReview(h.request, { ...second, expectedReviewVersion: 1 }));
  assert.deepEqual(
    h.read().nativeExecution.review.attempts.map((a) => a.version),
    [1, 1],
  );
  assert.notEqual(
    h.read().nativeExecution.review.attempts[0].scope.runId,
    h.read().nativeExecution.review.attempts[1].scope.runId,
  );
  assert.deepEqual(h.counters, { global: 1, nodes: 2, plans: 0 });
});

test('review Service: old human ballot writer preserves review and cannot pass the expert obligation', async (t) => {
  const h = await host(t);
  checked(await h.service.prepareExpertReview(h.request, await body(h)));
  const original = JSON.stringify(h.read().nativeExecution);
  const round = h.read().rounds[0];
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'human-vote'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'approve',
    }),
  );
  assert.equal(JSON.stringify(h.read().nativeExecution), original);
  assert.equal(h.read().command.status, 'in-review');
  assert.equal(h.read('consume').command.status, 'blocked');
  refused(
    await h.service.ballot(caller('qa'), {
      ...h.human('produce', 'fake-expert-vote'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'approve',
    }),
    'not-in-directory',
  );
  assert.throws(() => beginExecutionRun(h.read(), command(h.read()), [h.read()], available), {
    code: 'run-active',
  });
});

for (const fault of ['global', 'node', 'revoked-after-marker'])
  test(`review Service: ${fault} failure never puts a review row before its barrier`, async (t) => {
    const h = await host(t),
      request = await body(h);
    if (fault === 'revoked-after-marker') h.faults.afterGlobalWrite = () => h.member.abort();
    else h.faults[fault] = true;
    refused(
      await h.service.prepareExpertReview(h.request, request),
      fault === 'global'
        ? 'run-writer-unavailable'
        : fault === 'node'
          ? 'unavailable'
          : 'run-authority-denied',
    );
    assert.equal(h.read().nativeExecution, undefined);
    assert.equal(h.counters.nodes, 0);
    assert.equal(h.domain.global.get().nativeReviewWriter, fault === 'global' ? undefined : 1);
    const before = await businessHashes(h.root);
    await h.close();
    const cold = await open(h.root, { seed: false, workbench: h.snapshot });
    try {
      assert.equal(cold.read().nativeExecution, undefined);
      assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
      assert.deepEqual(await businessHashes(h.root), before);
    } finally {
      await cold.close();
    }
  });

test('review Service: original trusted member, current owner and current expert are checked before marker writes', async (t) => {
  const h = await host(t),
    request = await body(h);
  const unknown = Object.freeze({ headers: {} });
  refused(await h.service.prepareExpertReview(unknown, request), 'run-authority-denied');
  h.members.set(unknown, 'outside');
  refused(await h.service.prepareExpertReview(unknown, request), 'review-not-controller');
  refused(
    await h.service.prepareExpertReview(h.request, { ...request, actorId: 'qa' }),
    'actor-from-body',
  );
  refused(
    await h.service.prepareExpertReview(h.request, {
      ...request,
      reviewerRef: { ...request.reviewerRef, version: 'old-plan' },
    }),
    'review-plan-mismatch',
  );
  refused(
    await h.service.prepareExpertReview(h.request, {
      ...request,
      target: { ...request.target, artifactFingerprint: 'f'.repeat(64) },
    }),
    'review-target-stale',
  );
  h.setWorkbench((w) => ({
    ...w,
    participants: w.participants.map((p) => (p.id === 'qa' ? { ...p, available: false } : p)),
  }));
  refused(await h.service.prepareExpertReview(h.request, request), 'review-expert-unavailable');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

for (const row of [false, true])
  test(`real DSH JSON: cold OS process reads review=${row}; old native-aware schema rejects even marker-only without writes`, async (t) => {
    const h = await host(t);
    if (row) checked(await h.service.prepareExpertReview(h.request, await body(h)));
    else await h.domain.global.set(prepareExecutionReviewWriter(h.domain.global.get()));
    const expected = structuredClone(h.read());
    await h.close();
    const before = await businessHashes(h.root);
    const childPath = fileURLToPath(new URL('./fixtures/review-reopen-child.mjs', import.meta.url));
    for (const mode of ['modern', 'old-native-aware']) {
      const child = await promisify(execFile)(process.execPath, [childPath, h.root, mode]);
      const result = JSON.parse(child.stdout.split('\n').find((line) => line.startsWith('{')));
      assert.deepEqual(
        result,
        mode === 'modern'
          ? { mode, reviews: row ? 1 : 0, authorRuns: 0 }
          : { mode, refused: 'invalid-record' },
      );
      assert.deepEqual(await businessHashes(h.root), before, `${mode} is byte-for-byte zero-write`);
    }
    const cold = await open(h.root, { seed: false, workbench: h.snapshot });
    try {
      assert.deepEqual(cold.read(), expected);
      assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
      assert.deepEqual(await businessHashes(h.root), before);
      if (row) {
        const request = await body(cold);
        const replay = checked(await cold.service.prepareExpertReview(cold.request, request));
        assert.equal(replay.disposition, 'replayed');
        assert.deepEqual(await businessHashes(h.root), before);
      }
    } finally {
      await cold.close();
    }
  });

test('review writer protocol: stale or failed marker writes refuse; enabling the author writer cannot strip an existing review marker', async () => {
  let global = { schemaVersion: 1 };
  await assert.rejects(
    enableExecutionReviewWriter(
      () => global,
      async () => {},
      [],
    ),
    { code: 'run-writer-unavailable' },
  );
  await assert.rejects(
    enableExecutionReviewWriter(
      () => global,
      async () => {
        throw Error('CONTRACT_WRITE_FAIL');
      },
      [],
    ),
    { code: 'run-writer-unavailable' },
  );
  await enableExecutionReviewWriter(
    () => global,
    async (next) => {
      global = next;
    },
    [],
  );
  assert.deepEqual(prepareExecutionRunWriter(global), global);
  assert.throws(
    () =>
      assertExecutionRunStoreCompatibility({ schemaVersion: 1, nativeExecutionWriter: 1 }, [
        { nativeExecution: { schemaVersion: 2, review: {} } },
      ]),
    { code: 'run-writer-unavailable' },
  );
});

test('review-aware author writer retains review on actual original Run state replacement', async (t) => {
  const h = await host(t);
  // This node has no author Run; adding arbitrary author facts is still rejected.
  checked(await h.service.prepareExpertReview(h.request, await body(h)));
  const record = h.read(),
    before = JSON.stringify(record.nativeExecution.review);
  assert.throws(
    () =>
      withExecutionRunState(record, {
        schemaVersion: 1,
        version: 1,
        currentRunId: 'fake',
        runs: [],
        receipts: [],
      }),
    { code: 'run-state-invalid' },
  );
  assert.throws(
    () => withExecutionRunState(record, { schemaVersion: 1 }),
    { code: 'run-state-invalid' },
    'an incomplete author replacement must not silently become review-only',
  );
  assert.equal(JSON.stringify(h.read().nativeExecution.review), before);
});

test('original storage guard refuses a legacy writer that drops review metadata before any put', async (t) => {
  const h = await host(t);
  checked(await h.service.prepareExpertReview(h.request, await body(h)));
  const { nativeExecution: _native, ...dropped } = h.read();
  const before = await businessHashes(h.root);
  h.resetCounts();
  // TypeScript-private original storage guard, not a new transport or authority.
  await assert.rejects(h.service.writeNode(dropped), { code: 'run-state-invalid' });
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

async function readAuthority(h) {
  const prepared = checked(await h.service.prepareExpertReview(h.request, await body(h)));
  const locator = { ...h.locate(), spaceId: 'north', runId: prepared.attempt.scope.runId };
  return { locator, ...checked(await h.service.openExpertReviewRead(h.request, locator)) };
}

test('review read authority: original live member opens a genuine immutable read grant with zero read-time writes', async (t) => {
  const h = await host(t),
    owned = await readAuthority(h),
    grant = owned.grant;
  const before = await businessHashes(h.root);
  h.resetCounts();
  assert.equal(grant.purpose, 'review-target');
  assert.equal(grant.scope.actorId, 'chen');
  assert.equal(grant.assertCurrent('read-target'), undefined);
  assert.equal(h.service.assertExpertReviewReadGrant(grant), undefined);
  assert.ok(Object.isFrozen(grant.scope.review.target));
  for (const clone of [
    { ...grant },
    structuredClone({ purpose: grant.purpose, scope: grant.scope }),
    {},
  ]) {
    assert.throws(() => h.service.assertExpertReviewReadGrant(clone), {
      code: 'review-authority-denied',
    });
  }
  assert.throws(() => ({ ...grant }).assertCurrent('read-target'), {
    code: 'review-authority-denied',
  });
  assert.throws(() => grant.assertCurrent('send'), { code: 'review-authority-denied' });
  assert.throws(() => h.authorities.assertGrant(grant, 'send'), { code: 'run-authority-denied' });
  owned.dispose();
  owned.dispose();
  assert.equal(grant.signal.aborted, true);
  assert.throws(() => grant.assertCurrent('read-target'), { code: 'review-authority-denied' });
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

test('review read authority: JSON member snapshots, another controller and another Service cannot borrow the capability', async (t) => {
  const h = await host(t),
    owned = await readAuthority(h),
    other = await host(t);
  t.after(() => owned.dispose());
  refused(
    await h.service.openExpertReviewRead(
      { headers: {}, member: { ok: true, memberId: 'chen' } },
      owned.locator,
    ),
    'review-authority-denied',
  );
  const outsider = Object.freeze({ headers: {} });
  h.members.set(outsider, 'outside');
  refused(await h.service.openExpertReviewRead(outsider, owned.locator), 'review-authority-denied');
  refused(
    await h.service.openExpertReviewRead(h.request, { ...owned.locator, actorId: 'chen' }),
    'actor-from-body',
  );
  assert.throws(() => other.service.assertExpertReviewReadGrant(owned.grant), {
    code: 'review-authority-denied',
  });
  assert.equal(owned.grant.signal.aborted, false);
});

test('review read authority: peer review preparations and ballots keep exact target permission; a returned round revokes it', async (t) => {
  const h = await host(t),
    owned = await readAuthority(h);
  t.after(() => owned.dispose());
  checked(
    await h.service.prepareExpertReview(
      h.request,
      await body(h, {
        requestId: 'peer-preparation',
        reviewerRef: { id: 'qa-two', version: owned.grant.scope.planId },
      }),
    ),
  );
  const round = h.read().rounds[0];
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'peer-comment'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'comment',
      comment: 'Clarify the error code.',
    }),
  );
  assert.equal(owned.grant.assertCurrent('read-target'), undefined);
  assert.equal(owned.grant.signal.aborted, false);
  const latest = h.read();
  await h.domain.table('nodes').put(nodeRecordKey(latest), {
    ...latest,
    command: { ...latest.command, version: latest.command.version + 1 },
  });
  assert.equal(
    owned.grant.assertCurrent('read-target'),
    undefined,
    'ordinary node CAS version is not the fixed review target',
  );
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'peer-return'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'request-changes',
      comment: 'Missing invalid challenge handling.',
    }),
  );
  assert.equal(owned.grant.signal.aborted, true);
  assert.throws(() => h.service.assertExpertReviewReadGrant(owned.grant), {
    code: 'review-authority-denied',
  });
});

for (const revoke of ['member', 'host', 'expert'])
  test(`review read authority: ${revoke} revocation aborts the retained capability`, async (t) => {
    const h = await host(t),
      owned = await readAuthority(h);
    t.after(() => owned.dispose());
    if (revoke === 'member') h.member.abort();
    else if (revoke === 'host') h.source.abort();
    else
      h.setWorkbench((w) => ({
        ...w,
        participants: w.participants.map((p) => (p.id === 'qa' ? { ...p, available: false } : p)),
      }));
    assert.equal(owned.grant.signal.aborted, true);
    assert.throws(() => owned.grant.assertCurrent('read-target'), {
      code: 'review-authority-denied',
    });
  });

test('review read authority: expiration and failed lease release fail closed without reviving old grants', async (t) => {
  const h = await host(t);
  const initial = await readAuthority(h);
  initial.dispose();
  h.faults.leaseDurationMs = 1000;
  const owned = {
    locator: initial.locator,
    ...checked(await h.service.openExpertReviewRead(h.request, initial.locator)),
  };
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(owned.grant.signal.aborted, true);
  h.faults.leaseDurationMs = 60_000;
  const next = checked(await h.service.openExpertReviewRead(h.request, owned.locator));
  h.faults.release = true;
  next.dispose();
  h.faults.release = false;
  refused(
    await h.service.openExpertReviewRead(h.request, owned.locator),
    'review-authority-denied',
  );
  assert.equal(next.grant.signal.aborted, true);
});

test('fixed review reader: exact bounded text bytes, genuine lease checks, EOF and metadata never write', async (t) => {
  const h = await host(t),
    owned = await readAuthority(h),
    signal = new AbortController().signal;
  t.after(() => owned.dispose());
  const before = await businessHashes(h.root);
  const catalog = h.service.listExpertReviewResources(owned.grant);
  assert.equal(catalog[0].resourceRef, 'review_text');
  const page = await h.service.readExpertReviewResource(
    owned.grant,
    { resourceRef: 'review_text', offset: 0, length: 8 },
    signal,
  );
  assert.equal(Buffer.from(page.bytes).toString(), 'POST /lo');
  assert.equal(page.bytes.buffer.byteLength, 8);
  assert.deepEqual(page.range, {
    offset: 0,
    length: 8,
    total: Buffer.byteLength('POST /login requires a valid challenge.'),
  });
  assert.equal(page.check(), undefined);
  page.release();
  page.release();
  assert.throws(() => page.check(), { code: 'cancelled' });
  const eof = await h.service.readExpertReviewResource(
    owned.grant,
    { resourceRef: 'review_text', offset: catalog[0].bytes, length: 4 },
    signal,
  );
  assert.equal(eof.bytes.length, 0);
  eof.release();
  await assert.rejects(
    h.service.readExpertReviewResource(
      { ...owned.grant },
      { resourceRef: 'review_text', offset: 0, length: 8 },
      signal,
    ),
    { code: 'review-authority-denied' },
  );
  for (const query of [
    { resourceRef: 'review_text', offset: -1, length: 8 },
    { resourceRef: 'review_text', offset: 0, length: 8193 },
    { resourceRef: 'review_text', offset: 0, length: 8, actorId: 'qa' },
  ])
    await assert.rejects(h.service.readExpertReviewResource(owned.grant, query, signal), {
      code: 'invalid-request',
    });
  await assert.rejects(
    h.service.readExpertReviewResource(
      owned.grant,
      { resourceRef: 'other-artifact', offset: 0, length: 8 },
      signal,
    ),
    { code: 'not-found' },
  );
  assert.deepEqual(await businessHashes(h.root), before);
});

for (const file of [
  {
    name: 'spec.md',
    mediaType: 'text/markdown',
    text: 'FIXED review file bytes. 中文。',
    encoding: 'utf-8',
  },
  {
    name: 'spec.pdf',
    mediaType: 'application/pdf',
    text: '%PDF-1.7\nnot text evidence',
    encoding: 'binary',
  },
])
  test(`real local attachment: ${file.encoding} fixed target file is readable before acceptance under a review lease`, async (t) => {
    const h = await host(t, { file }),
      owned = await readAuthority(h);
    t.after(() => owned.dispose());
    assert.equal(h.read().acceptedArtifactVersionId, undefined);
    const before = await businessHashes(h.root);
    const resource = h.service
      .listExpertReviewResources(owned.grant)
      .find((r) => r.kind === 'file');
    const page = await h.service.readExpertReviewResource(
      owned.grant,
      { resourceRef: resource.resourceRef, offset: 0, length: 8192 },
      new AbortController().signal,
    );
    assert.equal(Buffer.from(page.bytes).toString(), file.text);
    assert.equal(page.encoding, file.encoding);
    assert.equal(page.check(), undefined);
    page.release();
    assert.deepEqual(await businessHashes(h.root), before);
  });

test('fixed review reader: links remain explicit unsupported material, never fetched or claimed as content', async (t) => {
  const h = await host(t, { links: ['https://example.test/reference'] }),
    owned = await readAuthority(h);
  t.after(() => owned.dispose());
  const resource = h.service
    .listExpertReviewResources(owned.grant)
    .find((r) => r.kind === 'external-reference');
  assert.equal(resource.required, true);
  await assert.rejects(
    h.service.readExpertReviewResource(
      owned.grant,
      { resourceRef: resource.resourceRef, offset: 0, length: 8 },
      new AbortController().signal,
    ),
    { code: 'review-unsupported-material' },
  );
});

test('fixed review reader: text and actual file leases share the original eight slots', async (t) => {
  const h = await host(t, { file: { name: 'a.txt', mediaType: 'text/plain', text: 'FILE' } }),
    owned = await readAuthority(h);
  t.after(() => owned.dispose());
  const signal = new AbortController().signal,
    leases = [];
  const file = h.service.listExpertReviewResources(owned.grant).find((r) => r.kind === 'file');
  leases.push(
    await h.service.readExpertReviewResource(
      owned.grant,
      { resourceRef: file.resourceRef, offset: 0, length: 4 },
      signal,
    ),
  );
  for (let i = 0; i < 7; i++)
    leases.push(
      await h.service.readExpertReviewResource(
        owned.grant,
        { resourceRef: 'review_text', offset: 0, length: 4 },
        signal,
      ),
    );
  await assert.rejects(
    h.service.readExpertReviewResource(
      owned.grant,
      { resourceRef: 'review_text', offset: 0, length: 4 },
      signal,
    ),
    { code: 'quota-exceeded' },
  );
  leases.forEach((lease) => lease.release());
});

test('real local attachment: cancellation and close wait for the original physical read drain', async (t) => {
  const h = await host(t, { file: { name: 'a.txt', mediaType: 'text/plain', text: 'FIXED file' } }),
    owned = await readAuthority(h);
  t.after(() => owned.dispose());
  const entered = Promise.withResolvers(),
    unblock = Promise.withResolvers();
  t.after(() => unblock.resolve());
  const original = h.attachments.readFileStream.bind(h.attachments);
  h.attachments.readFileStream = async function* (...args) {
    entered.resolve();
    await unblock.promise;
    yield* original(...args);
  };
  const file = h.service.listExpertReviewResources(owned.grant).find((r) => r.kind === 'file');
  const pending = h.service.readExpertReviewResource(
    owned.grant,
    { resourceRef: file.resourceRef, offset: 0, length: 4 },
    new AbortController().signal,
  );
  const rejected = assert.rejects(pending);
  await entered.promise;
  owned.dispose();
  let closed = false;
  const close = h.service.closeFileReads().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  assert.equal(
    h.service.fileReadResources.size,
    1,
    'aborted physical read still holds the original slot',
  );
  unblock.resolve();
  await rejected;
  await close;
  assert.equal(h.service.fileReadResources.size, 0);
});

test('review read authority: failed open plus failed lease release immediately aborts every live grant and held physical reader', async (t) => {
  const h = await host(t, {
    file: { name: 'held.txt', mediaType: 'text/plain', text: 'HELD fixed review bytes' },
  });
  const first = await readAuthority(h),
    second = checked(await h.service.openExpertReviewRead(h.request, first.locator));
  const entered = Promise.withResolvers(),
    unblock = Promise.withResolvers();
  t.after(() => {
    unblock.resolve();
    first.dispose();
    second.dispose();
  });
  const original = h.attachments.readFileStream.bind(h.attachments);
  let physicalSignal;
  h.attachments.readFileStream = async function* (...args) {
    physicalSignal = args[1];
    entered.resolve();
    await unblock.promise;
    yield* original(...args);
  };
  const file = h.service.listExpertReviewResources(first.grant).find((r) => r.kind === 'file');
  const reading = h.service.readExpertReviewResource(
    first.grant,
    { resourceRef: file.resourceRef, offset: 0, length: 4 },
    new AbortController().signal,
  );
  const rejected = assert.rejects(reading);
  await entered.promise;
  const before = await businessHashes(h.root);
  h.resetCounts();
  const other = Object.freeze({ headers: {} });
  h.members.set(other, 'outside');
  try {
    h.faults.release = true;
    refused(await h.service.openExpertReviewRead(other, first.locator), 'review-authority-denied');
    assert.equal(first.grant.signal.aborted, true, 'no follow-up assertion is needed');
    assert.equal(second.grant.signal.aborted, true);
    assert.equal(physicalSignal.aborted, true);
    assert.equal(
      h.service.fileReadResources.size,
      1,
      'actual pending IO retains its physical slot',
    );
    assert.deepEqual(await businessHashes(h.root), before);
    assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
    h.faults.release = false;
    refused(
      await h.service.openExpertReviewRead(h.request, first.locator),
      'review-authority-denied',
    );
  } finally {
    h.faults.release = false;
    unblock.resolve();
  }
  await rejected;
  assert.equal(h.service.fileReadResources.size, 0);
});

test('review read authority: pending opens cannot mint grants after the owner is poisoned', async (t) => {
  const h = await host(t),
    owned = await readAuthority(h);
  const entered = Promise.withResolvers(),
    unblock = Promise.withResolvers();
  t.after(() => {
    unblock.resolve();
    owned.dispose();
  });
  const original = h.service.runHost.memberLease.bind(h.service.runHost);
  const pendingRequest = Object.freeze({ headers: {} });
  h.members.set(pendingRequest, 'chen');
  h.service.runHost.memberLease = async (request) => {
    if (request === pendingRequest) {
      entered.resolve();
      await unblock.promise;
    }
    return original(request);
  };
  const before = await businessHashes(h.root);
  h.resetCounts();
  const pending = h.service.openExpertReviewRead(pendingRequest, owned.locator);
  await entered.promise;
  h.faults.release = true;
  owned.dispose();
  assert.equal(owned.grant.signal.aborted, true);
  h.faults.release = false;
  unblock.resolve();
  refused(await pending, 'review-authority-denied');
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});
