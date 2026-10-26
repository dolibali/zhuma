import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nodeRecordKey } from '@zhuma/agent-core';
import { afterExecutionRunCommit } from '../dist/execution-run-effects.js';
import { currentExecutionRun, beginExecutionRun } from '../dist/execution-run-state.js';
import { ExecutionService } from '../dist/execution-service.js';
import { open, caller, checked, refused, stable } from './execution-service-run-fixture.mjs';
import { available, command, localWorkspace, records } from './execution-run-fixture.mjs';

async function hostFor(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-service-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = await open(root, options);
  t.after(() => host.close());
  return { ...host, root };
}
function committed(promise) {
  return promise.then((result) => {
    if (!result.ok) throw Object.assign(Error(result.error.message), { code: result.error.code });
    return result.value;
  });
}
async function bytes(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(directory, entry.name);
    if (entry.isDirectory())
      result.push(...(await bytes(file)).map(([name, body]) => [`${entry.name}/${name}`, body]));
    else result.push([entry.name, (await readFile(file)).toString('base64')]);
  }
  return result;
}

test('real JSON service: explicit durable marker and node commit precede effects; failures dispatch nothing', async (t) => {
  const h = await hostFor(t);
  h.resetCounts();
  let dispatches = 0;
  const driver = {
    async dispatch(effect) {
      dispatches++;
      assert.equal(h.read().nativeExecution.currentRunId, effect.scope.runId);
    },
    async reconcile() {},
    async stop() {},
  };
  assert.deepEqual(h.service.readRunGlobal(), { schemaVersion: 1 });
  refused(await h.service.beginRun(h.request, h.begin()), 'run-writer-unavailable');
  h.faults.global = true;
  refused(await h.service.enableRunWriter(), 'run-writer-unavailable');
  await assert.rejects(
    afterExecutionRunCommit(() => committed(h.service.beginRun(h.request, h.begin())), driver),
    { code: 'run-writer-unavailable' },
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  h.faults.global = false;
  checked(await h.service.enableRunWriter());
  checked(await h.service.enableRunWriter());
  assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
  const before = h.read();
  h.faults.node = true;
  await assert.rejects(
    afterExecutionRunCommit(() => committed(h.service.beginRun(h.request, h.begin())), driver),
    { code: 'unavailable' },
  );
  assert.deepEqual(h.read(), before);
  assert.equal(dispatches, 0);
  h.faults.node = false;
  await afterExecutionRunCommit(() => committed(h.service.beginRun(h.request, h.begin())), driver);
  assert.equal(dispatches, 1);
  assert.equal(h.counters.nodes, 1);
});

test('real JSON service: same-key concurrent begins write once; effect wait does not occupy the original queue', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  h.resetCounts();
  const input = h.begin();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => h.service.beginRun(h.request, input)),
  );
  const decisions = results.map(checked);
  assert.equal(decisions.filter((d) => d.disposition === 'applied').length, 1);
  assert.equal(decisions.filter((d) => d.effect.kind === 'reconcile').length, 7);
  assert.equal(h.counters.nodes, 1);
  refused(
    await h.service.beginRun(h.request, { ...input, inputFingerprint: 'b'.repeat(64) }),
    'composition-mismatch',
  );
  assert.equal(h.counters.nodes, 1);
  let release;
  let entered;
  const entry = new Promise((resolve) => {
    entered = resolve;
  });
  const effect = afterExecutionRunCommit(() => committed(h.service.beginRun(h.request, input)), {
    dispatch: () => assert.fail('replay must never dispatch'),
    stop: () => assert.fail('replay must never stop'),
    async reconcile() {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await entry;
  try {
    const count = await Promise.race([
      h.service.inboxCounts(caller(), { spaceId: 'north' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('native effect held execution queue')), 1000).unref(),
      ),
    ]);
    checked(count);
  } finally {
    release();
    await effect;
  }
});

test('real JSON service: old human writes are blocked while active; Run events and later review preserve whole-node fields', async (t) => {
  const h = await hostFor(t);
  const first = checked(
    await h.service.submit(caller(), {
      ...h.human('produce', 'submit-original'),
      text: 'first fixed delivery',
    }),
  );
  const round = first.node.rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return-original'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'request-changes',
      comment: 'cover the boundary',
    }),
  );
  const original = h.read();
  await h.domain.table('nodes').put(nodeRecordKey(original), {
    ...original,
    comments: [
      { id: 'prior-resolved-comment', status: 'resolved', versionId: round.artifactVersionId },
    ],
  });
  checked(
    await h.service.draft(caller(), {
      ...h.locate(),
      expectedVersion: h.read().deliveryDraft.version,
      idempotencyKey: 'draft-before-run',
      text: 'unsent revision',
      links: ['https://example.test/fixed-spec'],
      files: [
        {
          id: 'contract-file-ref',
          mediaType: 'text/plain',
          byteSize: 3,
          checksum: 'abc',
          accessPolicyId: 'private',
          uploadComplete: false,
        },
      ],
    }),
  );
  const saved = h.read();
  checked(await h.service.enableRunWriter());
  h.resetCounts();
  checked(await h.service.beginRun(h.request, h.begin()));
  assert.equal(h.counters.nodes, 1);
  refused(
    await h.service.submit(caller(), {
      ...h.human('produce', 'overwrite-active'),
      text: 'racing submit',
    }),
    'run-active',
  );
  refused(
    await h.service.draft(caller(), {
      ...h.locate(),
      expectedVersion: 1,
      idempotencyKey: 'overwrite-draft',
      text: 'racing draft',
    }),
    'run-active',
  );
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  const auth = { grant: opened.grant };
  refused(
    await h.native(
      'accepted',
      { grant: { ...opened.grant } },
      { nativeSessionId: 'forged', executorRunId: 'forged' },
    ),
    'run-authority-denied',
  );
  checked(
    await h.native('accepted', auth, { nativeSessionId: 'native-1', executorRunId: 'executor-1' }),
  );
  checked(await h.native('idle', auth));
  assert.equal(h.counters.nodes, 3);
  for (const key of [
    'ownerId',
    'handoff',
    'deliveryDraft',
    'artifactVersions',
    'rounds',
    'comments',
    'receipts',
    'events',
    'currentRoundId',
  ])
    assert.deepEqual(h.read()[key], saved[key], key);
  checked(await h.native('completed', auth, stable));
  assert.equal(h.read().command.status, 'needs-revision');
  assert.equal(
    h.read('consume').command.status,
    'blocked',
    'native completion is not product acceptance',
  );
  assert.equal(opened.grant.signal.aborted, true);
  const native = h.read().nativeExecution;
  const second = checked(
    await h.service.submit(caller(), {
      ...h.human('produce', 'submit-revised'),
      text: 'revised fixed delivery',
    }),
  );
  assert.deepEqual(h.read().nativeExecution, native);
  assert.equal(h.read().deliveryDraft.version, saved.deliveryDraft.version + 1);
  assert.equal(h.read().deliveryDraft.text, '');
  const revisedRound = second.node.rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'approve-revised'),
      roundId: revisedRound.id,
      artifactVersionId: revisedRound.artifactVersionId,
      action: 'approve',
    }),
  );
  assert.equal(h.read().command.status, 'completed');
  assert.deepEqual(h.read().nativeExecution, native);
  assert.equal(h.read().artifactVersions.length, 2);
  assert.equal(h.read().rounds.length, 2);
  assert.equal(h.read().comments.length, 1);
  assert.equal(h.read('consume').command.status, 'ready');
  assert.deepEqual(h.read('consume').handoff.inputRefs, [
    { sourceNodeId: 'produce', artifactVersionId: revisedRound.artifactVersionId },
  ]);
});

test('real JSON service: stop is durable once; revoked member cleanup survives; stale generations cannot mutate retry', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  const reader = await h.authorities.open(h.request, h.runLocator(), 'read');
  refused(
    await h.native(
      'accepted',
      { grant: reader.grant },
      { nativeSessionId: 'forged', executorRunId: 'forged' },
    ),
    'run-authority-denied',
  );
  reader.dispose();
  const cleanup = h.authorities.cleanupAfterCommit(h.runLocator());
  const drive = await h.authorities.open(h.request, h.runLocator(), 'drive');
  checked(
    await h.native(
      'accepted',
      { grant: drive.grant },
      { nativeSessionId: 'native-1', executorRunId: 'executor-1' },
    ),
  );
  const row = h.read();
  const run = currentExecutionRun(row);
  const stop = {
    ...h.locate(),
    spaceId: 'north',
    requestId: 'stop-1',
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    expectedNodeVersion: row.command.version,
    expectedRunVersion: row.nativeExecution.version,
  };
  h.resetCounts();
  checked(await h.service.stopRun(h.request, stop));
  checked(await h.service.stopRun(h.request, stop));
  assert.equal(h.counters.nodes, 1);
  h.member.abort();
  assert.equal(drive.grant.signal.aborted, true);
  refused(await h.native('completed', { cleanup }, stable), 'run-authority-denied');
  checked(await h.native('stopped', { cleanup }, stable));
  assert.equal(h.read().nativeExecution.runs[0].resources, 'settled');
  const old = h.read();
  h.service.fenceRuns();
  refused(
    await h.service.beginRun(
      h.request,
      h.begin({
        mode: 'restart',
        requestId: 'restart',
        newRunId: 'run-2',
        newSegmentId: 'segment-2',
      }),
    ),
    'run-authority-unavailable',
  );
  assert.deepEqual(h.read(), old);
});

test('real JSON service: retry rotates generations, rejects old capabilities and preserves metadata on a failed event write', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  const cleanup = h.authorities.cleanupAfterCommit(h.runLocator());
  checked(await h.native('failed', { cleanup }, { resourcesSettled: true }));
  checked(
    await h.service.beginRun(
      h.request,
      h.begin({ mode: 'retry', requestId: 'retry', newRunId: 'run-2', newSegmentId: 'segment-2' }),
    ),
  );
  const before = h.read();
  h.resetCounts();
  const stale = {
    kind: 'cleanup',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
    sequence: 2,
    ...stable,
  };
  refused(await h.service.recordRunEvent(h.locate(), stale, { cleanup }), 'run-authority-denied');
  assert.deepEqual(h.read(), before);
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  const auth = { grant: opened.grant };
  refused(
    await h.native('accepted', auth, {
      generation: 1,
      nativeSessionId: 'native-2',
      executorRunId: 'executor-2',
    }),
    'run-scope-mismatch',
  );
  h.faults.node = true;
  refused(
    await h.native('accepted', auth, { nativeSessionId: 'native-2', executorRunId: 'executor-2' }),
    'unavailable',
  );
  assert.deepEqual(h.read(), before);
  assert.equal(h.counters.nodes, 0);
  h.faults.node = false;
  checked(
    await h.native('accepted', auth, { nativeSessionId: 'native-2', executorRunId: 'executor-2' }),
  );
  assert.equal(h.counters.nodes, 1);
  assert.equal(currentExecutionRun(h.read()).attempt.generation, 2);
});

test('real JSON service: same workspace has one writer across nodes; forged caller and missing current facts refuse', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  const input = h.begin({ workspace: localWorkspace });
  for (const fault of ['configuration', 'workspace']) {
    h.faults[fault] = true;
    refused(await h.service.beginRun(h.request, input), 'run-authority-denied');
    h.faults[fault] = false;
  }
  refused(
    await h.service.beginRun(
      { member: { ok: true, memberId: 'chen', spaceIds: ['north'] } },
      input,
    ),
    'run-authority-denied',
  );
  refused(await h.service.beginRun(h.request, { ...input, actorId: 'chen' }), 'actor-from-body');
  refused(
    await h.service.beginRun(h.request, { ...input, spaceId: 'south' }),
    'run-authority-denied',
  );
  h.resetCounts();
  const results = await Promise.all([
    h.service.beginRun(h.request, input),
    h.service.beginRun(
      h.request,
      h.begin(
        {
          requestId: 'parallel-run',
          newRunId: 'parallel-run',
          newSegmentId: 'parallel-segment',
          workspace: { ...localWorkspace, grantId: 'different-grant-same-root' },
        },
        'parallel',
      ),
    ),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  refused(
    results.find((r) => !r.ok),
    'run-workspace-busy',
  );
  assert.equal(h.counters.nodes, 1);
  const snapshot = h.service.readRunNode(h.locate());
  snapshot.nativeExecution.runs.length = 0;
  assert.equal(
    h.read().nativeExecution.runs.length,
    1,
    'Host read ports cannot edit the live domain',
  );
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  const before = h.read();
  h.setWorkbench((workbench) => ({ ...workbench, tasks: [] }));
  assert.equal(
    opened.grant.signal.aborted,
    true,
    'current task removal revokes an existing drive grant',
  );
  refused(await h.service.beginRun(h.request, input), 'run-authority-denied');
  assert.deepEqual(h.read(), before);
});

for (const port of ['project', 'configuration', 'workspace']) {
  test(`real JSON service: ${port} assertion must finish synchronously with undefined before admission`, async (t) => {
    const h = await hostFor(t);
    checked(await h.service.enableRunWriter());
    h.resetCounts();
    const before = h.read();
    let dispatches = 0;
    const driver = {
      async dispatch() {
        dispatches++;
      },
      async reconcile() {
        dispatches++;
      },
      async stop() {
        dispatches++;
      },
    };
    for (const produce of [
      () => Promise.resolve(undefined),
      () => Promise.reject(Error('PRIVATE_ASYNC_ASSERTION_FAILURE')),
      () => ({
        then(resolve) {
          resolve(undefined);
        },
      }),
      () => ({
        then(_resolve, reject) {
          reject(Error('PRIVATE_THENABLE_FAILURE'));
        },
      }),
      () => false,
      () => true,
      () => null,
      () => ({}),
    ]) {
      h.assertionResults[port] = produce;
      await assert.rejects(
        afterExecutionRunCommit(() => committed(h.service.beginRun(h.request, h.begin())), driver),
        { code: 'run-authority-unavailable' },
      );
      assert.deepEqual(h.read(), before);
      assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    }
    assert.equal(dispatches, 0);
    delete h.assertionResults[port];
    checked(await h.service.beginRun(h.request, h.begin()));
    assert.equal(h.counters.nodes, 1, 'a completed synchronous assertion still admits normally');
  });
}

for (const port of ['project', 'workspace']) {
  test(`real JSON service: ${port} assertion cannot become async after a grant was issued`, async (t) => {
    const h = await hostFor(t);
    checked(await h.service.enableRunWriter());
    checked(await h.service.beginRun(h.request, h.begin()));
    const before = h.read();
    const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
    h.resetCounts();
    h.assertionResults[port] = () => Promise.reject(Error('PRIVATE_ASYNC_ASSERTION_FAILURE'));
    assert.throws(() => opened.grant.assertCurrent('send'), { code: 'run-authority-denied' });
    assert.equal(opened.grant.signal.aborted, true);
    await assert.rejects(h.authorities.open(h.request, h.runLocator(), 'drive'), {
      code: 'run-authority-denied',
    });
    assert.deepEqual(h.read(), before);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  });
}

test('real JSON service: same-disk new process reopens read-only without enable, dispatch or resend', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  const saved = h.read();
  await h.close();
  const before = await bytes(h.root);
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./execution-service-run-reopen.mjs', import.meta.url)),
    h.root,
  ]);
  const reopened = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(reopened.node, saved);
  assert.deepEqual(reopened.composition, saved.nativeExecution.runs[0].composition);
  assert.equal(
    reopened.composition.configurationId,
    saved.nativeExecution.runs[0].selection.configurationId,
  );
  assert.deepEqual(reopened.global, { schemaVersion: 1, nativeExecutionWriter: 1 });
  assert.deepEqual(reopened.writes, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await bytes(h.root), before);
});

test('real Cordis fiber + JSON: held unpublish keeps the domain open for trusted cleanup before close', async (t) => {
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = await hostFor(t, {
    beforePublish: () => async () => {
      enter();
      await gate;
    },
  });
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  const cleanup = h.authorities.cleanupAfterCommit(h.runLocator());
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  let disposed = false;
  const stopping = h.disposeExecution().then(() => {
    disposed = true;
  });
  try {
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(h.closeState.calls, 0);
    assert.equal(h.closeState.closed, false);
    assert.equal(opened.grant.signal.aborted, true, 'fence precedes the native drain wait');
    refused(await h.service.beginRun(h.request, h.begin()), 'run-authority-unavailable');
    checked(await h.native('failed', { cleanup }, { resourcesSettled: false }));
    assert.equal(currentExecutionRun(h.read()).resources, 'held');
    checked(await h.native('cleanup', { cleanup }, stable));
    assert.equal(currentExecutionRun(h.read()).resources, 'settled');
    assert.deepEqual(h.service.readRunGlobal(), { schemaVersion: 1, nativeExecutionWriter: 1 });
    assert.equal(h.closeState.calls, 0, 'cleanup writes happen while unpublish is still held');
  } finally {
    release();
    await stopping;
  }
  assert.equal(h.closeState.calls, 1);
  assert.equal(h.closeState.closed, true);
  assert.deepEqual(h.closeState.errors, []);
  assert.throws(() => h.service.readRunGlobal());
});

test('real Cordis fiber + JSON: failed drain still closes service/domain without inventing resource settlement', async (t) => {
  const failure = Error('CONTRACT_NATIVE_DRAIN_FAILURE');
  const h = await hostFor(t, {
    beforePublish: () => async () => {
      throw failure;
    },
  });
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  await h.disposeExecution(); // Cordis reports disposer errors through its logger.
  assert.equal(h.closeState.calls, 1);
  assert.equal(h.closeState.closed, true);
  assert.equal(h.closeState.errors[0], failure, 'the original drain error is retained');
  await h.close();
  const reopened = await open(h.root, { seed: false, mount: false });
  t.after(() => reopened.close());
  const run = currentExecutionRun(reopened.read());
  assert.equal(run.resources, 'held');
  assert.equal(run.attempt.status, 'requested');
  assert.deepEqual(reopened.counters, { global: 0, nodes: 0, plans: 0 });
});

test('real Cordis fiber + JSON: authority close failure still attempts domain close', async (t) => {
  const h = await hostFor(t);
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  h.faults.release = true; // Contract lease release fault; actual manager.close rejects.
  await h.disposeExecution();
  assert.equal(opened.grant.signal.aborted, true);
  assert.equal(h.closeState.calls, 1);
  assert.equal(h.closeState.closed, true);
  assert.equal(h.closeState.errors[0].code, 'run-authority-unavailable');
});

test('real Cordis fiber + JSON: drain and domain-close failures remain separate, with no false close success', async (t) => {
  const drainFailure = Error('CONTRACT_NATIVE_DRAIN_FAILURE');
  const h = await hostFor(t, {
    beforePublish: () => async () => {
      throw drainFailure;
    },
  });
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin()));
  h.faults.close = true; // Explicit contract fault before the real domain close.
  try {
    await h.disposeExecution();
    assert.equal(h.closeState.calls, 1);
    assert.equal(h.closeState.closed, false);
    const failure = h.closeState.errors[0];
    assert(failure instanceof AggregateError);
    assert.equal(failure.errors[0], drainFailure);
    assert.equal(failure.errors[1].message, 'CONTRACT_DOMAIN_CLOSE_FAILURE');
    assert.equal(currentExecutionRun(h.read()).resources, 'held');
    assert.equal(currentExecutionRun(h.read()).attempt.status, 'requested');
  } finally {
    await h.domain.close(); // Test cleanup, not a successful product close receipt.
  }
});

for (const phase of ['constructor', 'reconcile', 'publish']) {
  test(`real Cordis fiber + JSON: ${phase} failure still closes the opened execution domain once`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-run-init-close-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const closeState = { calls: 0, closed: false, errors: [] };
    await assert.rejects(
      open(root, {
        closeState,
        startupFailure: phase,
        ...(phase === 'constructor'
          ? {
              prepareDomain: async (domain) => {
                const legacy = records()[0];
                const native = beginExecutionRun(
                  legacy,
                  command(legacy),
                  [legacy],
                  available,
                ).record;
                await domain.table('nodes').put(nodeRecordKey(native), native);
              },
            }
          : {}),
        ...(phase === 'publish'
          ? {
              beforePublish: () => {
                throw Error('CONTRACT_PUBLISH_FAILURE');
              },
            }
          : {}),
      }),
      phase === 'constructor'
        ? { code: 'run-writer-unavailable' }
        : new RegExp(`CONTRACT_${phase.toUpperCase()}_FAILURE`),
    );
    assert.equal(closeState.calls, 1);
    assert.equal(closeState.closed, true);
    assert.deepEqual(closeState.errors, []);
  });
}

test('service startup rejects missing/future marker and malformed native rows before any write', async (t) => {
  const h = await hostFor(t);
  const legacy = h.read();
  const native = beginExecutionRun(legacy, command(legacy), [legacy], available).record;
  for (const [global, row, code] of [
    [{ schemaVersion: 1 }, native, 'run-writer-unavailable'],
    [{ schemaVersion: 1, nativeExecutionWriter: 2 }, native, 'run-writer-incompatible'],
    [
      available.writerState,
      { ...native, nativeExecution: { schemaVersion: 2 } },
      'run-state-invalid',
    ],
  ]) {
    let writes = 0;
    assert.throws(
      () =>
        new ExecutionService(
          {
            readGlobal: () => global,
            listNodes: () => [row],
            writeNode: async () => {
              writes++;
            },
            writePlan: async () => {
              writes++;
            },
          },
          {
            readWorkbench: () => {
              throw Error('not read');
            },
          },
          undefined,
        ),
      { code },
    );
    assert.equal(writes, 0);
  }
});
