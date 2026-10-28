/** Real Service/JSON/queue contract. The C producer and member resolver below are doubles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fork } from 'node:child_process';
import {
  openResultContract,
  confirmation,
  deferred,
  loseNextPutResponse,
  businessHashes,
} from './execution-native-result-service-fixture.mjs';
import { checked, refused, caller } from './execution-service-run-fixture.mjs';
import { command } from './execution-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { nativeResultProvenance } from '../dist/execution-native-result-delivery.js';
import { readExecutionRunState } from '../dist/execution-run-state.js';

async function host(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-result-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await openResultContract(root, options);
  t.after(() => h.close());
  return { ...h, root };
}
const submit = (h, body = h.submission(), grant = h.opened.grant, ref = h.ref) =>
  h.service.submitNativeFixedResult(h.request, body, grant, ref);
const entered = (barrier, pending) =>
  Promise.race([
    barrier.promise,
    pending.then((result) =>
      assert.fail(`operation ended before barrier: ${JSON.stringify(result)}`),
    ),
  ]);

test('result Service contract: the original queue atomically lands terminal Run, artifact, round, receipt and event', async (t) => {
  const h = await host(t);
  h.controls.reenter = true;
  const value = checked(await submit(h));
  assert.equal(value.disposition, 'applied');
  assert.equal(h.read().artifactVersions.length, 1);
  assert.equal(h.read().rounds.length, 1);
  assert.equal(h.read().command.status, 'in-review');
  const state = readExecutionRunState(h.read());
  assert.equal(state.runs[0].attempt.status, 'completed');
  assert.equal(state.runs[0].resources, 'settled');
  assert.equal(state.runs[0].resultDelivery.artifactVersionId, value.artifactVersionId);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
  assert.equal(h.counts.released, 1);
  assert.equal(h.opened.grant.signal.aborted, true, 'terminal put intentionally revokes driving');
  const before = JSON.stringify(h.read());
  h.resetCounts();
  const confirmed = checked(
    await h.service.confirmNativeResultDelivery(h.request, confirmation(h, value)),
  );
  assert.equal(confirmed.disposition, 'confirmed');
  assert.equal(JSON.stringify(h.read()), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.counts.read, 1, 'readonly confirmation never calls C');
});

test('result Service contract: a failed put creates no terminal/delivery metadata and exact retry commits once', async (t) => {
  const h = await host(t);
  const body = h.submission();
  const before = JSON.stringify(h.read());
  h.faults.node = true;
  refused(await submit(h, body), 'unavailable');
  assert.equal(JSON.stringify(h.read()), before);
  assert.equal(h.counts.released, 1);
  h.faults.node = false;
  checked(await submit(h, body));
  assert.equal(h.read().artifactVersions.length, 1);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
});

test('result Service contract: concurrent same-key prepared requests write once and confirm with read authority', async (t) => {
  const h = await host(t);
  h.controls.afterRead = deferred();
  const body = h.submission();
  const first = submit(h, body);
  const second = submit(h, body);
  try {
    await entered(h.controls.twoReadersEntered, Promise.race([first, second]));
  } finally {
    h.controls.afterRead.resolve();
  }
  const values = (await Promise.all([first, second])).map(checked);
  assert.deepEqual(values.map((value) => value.disposition).sort(), ['applied', 'confirmed']);
  assert.equal(h.read().artifactVersions.length, 1);
  assert.equal(h.read().rounds.length, 1);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
  assert.equal(h.counts.released, 2);
});

test('result Service contract: foreign request, drive clone and result clone cannot read fixed content or commit', async (t) => {
  const h = await host(t);
  const body = h.submission();
  assert.equal(
    (await h.service.submitNativeFixedResult({ headers: {} }, body, h.opened.grant, h.ref)).ok,
    false,
  );
  assert.equal((await submit(h, body, { ...h.opened.grant })).ok, false);
  assert.equal((await submit(h, body, h.opened.grant, { ...h.ref })).ok, false);
  assert.equal(h.controls.privateLookup, 0);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

for (const [name, patch] of [
  [
    'wrong source scope',
    (lease) => {
      lease.source.scope = { ...lease.source.scope, nodeId: 'foreign' };
    },
  ],
  [
    'wrong configuration',
    (lease) => {
      lease.source.configurationId = 'foreign';
    },
  ],
  [
    'wrong digest',
    (lease) => {
      lease.digest = '0'.repeat(64);
    },
  ],
  [
    'claimed files',
    (lease) => {
      lease.content = { ...lease.content, files: [] };
    },
  ],
  [
    'asynchronous check',
    (lease) => {
      lease.check = async () => undefined;
    },
  ],
])
  test(`result Service contract: ${name} never lands a version`, async (t) => {
    const h = await host(t);
    h.controls.mutate = patch;
    assert.equal((await submit(h)).ok, false);
    assert.equal(h.read().artifactVersions.length, 0);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    assert.equal(h.counts.released, 1);
  });

test('result Service contract: Stop during actual preparation wins over delivery', async (t) => {
  const h = await host(t);
  h.controls.gate = deferred();
  const body = h.submission();
  const sending = submit(h, body);
  try {
    await entered(h.controls.prepareEntered, sending);
    const run = readExecutionRunState(h.read());
    checked(
      await h.service.stopRun(h.request, {
        ...h.locate(),
        spaceId: 'north',
        requestId: 'stop-result',
        runId: 'run-1',
        generation: 1,
        segmentId: 'segment-1',
        expectedNodeVersion: h.read().command.version,
        expectedRunVersion: run.version,
      }),
    );
  } finally {
    h.controls.gate.resolve();
  }
  assert.equal((await sending).ok, false);
  assert.equal(h.read().artifactVersions.length, 0);
});

test('result Service contract: cleanup failure does not turn an already durable delivery into another write', async (t) => {
  const h = await host(t);
  h.controls.releaseFailure = true;
  const value = checked(await submit(h));
  assert.equal(value.cleanup, 'failed');
  assert.equal(h.read().artifactVersions.length, 1);
  const before = JSON.stringify(h.read());
  checked(await h.service.confirmNativeResultDelivery(h.request, confirmation(h, value)));
  assert.equal(JSON.stringify(h.read()), before);
  await assert.rejects(h.service.closeRuns(), { code: 'native-result-cleanup-failed' });
});

test('result Service contract: close fences and waits for the real late preparation', async (t) => {
  const h = await host(t);
  h.controls.gate = deferred();
  const sending = submit(h);
  await entered(h.controls.prepareEntered, sending);
  let closed = false;
  const closing = h.service.closeRuns().then(() => {
    closed = true;
  });
  try {
    await setImmediate();
    assert.equal(closed, false);
  } finally {
    h.controls.gate.resolve();
  }
  assert.equal((await sending).ok, false);
  await closing;
  assert.equal(closed, true);
  assert.equal(h.read().artifactVersions.length, 0);
});

test('result Service contract: completed facts confirm under a new JSON owner without a C issuer', async (t) => {
  const h = await host(t);
  const value = checked(await submit(h));
  const body = confirmation(h, value);
  const before = JSON.stringify(h.read());
  await h.close();
  const reader = await openResultContract(h.root, { readerOnly: true });
  t.after(() => reader.close());
  assert.equal(
    checked(await reader.service.confirmNativeResultDelivery(reader.request, body)).disposition,
    'confirmed',
  );
  assert.equal(JSON.stringify(reader.read()), before);
  assert.deepEqual(reader.counters, { global: 0, nodes: 0, plans: 0 });
});

test('result Service contract: actual durable put with lost reply confirms in a new process without changing JSON bytes', async (t) => {
  const h = await host(t);
  const request = h.submission();
  const restore = loseNextPutResponse(h);
  try {
    refused(await submit(h, request), 'unavailable');
  } finally {
    restore();
  }
  const record = h.read();
  const run = readExecutionRunState(record).runs[0];
  const fixed = run.resultDelivery;
  const body = {
    ...h.locate(),
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    configurationId: run.selection.configurationId,
    idempotencyKey: request.idempotencyKey,
    intentId: fixed.source.intentId,
    digest: fixed.digest,
    provenanceFingerprint: fixed.provenanceFingerprint,
  };
  refused(await submit(h, request), 'native-result-confirmation-required');
  assert.equal(h.counts.read, 1);
  await h.close();
  const before = await businessHashes(h.root);
  const child = fork(
    new URL('./fixtures/native-result-confirm-child.mjs', import.meta.url),
    [h.root, JSON.stringify(body)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let output = '';
  child.stdout.on('data', (value) => {
    output += value;
  });
  child.stderr.on('data', (value) => {
    output += value;
  });
  const message = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(Error(`child exited before reply: ${code} ${output}`)));
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`child failed: ${code} ${output}`)),
    );
  });
  const value = await message;
  await exit;
  checked(value.result);
  assert.equal(value.result.value.disposition, 'confirmed');
  assert.deepEqual(value.before, before);
  assert.deepEqual(value.after, before);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(value.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(value.counts, {
    artifacts: 1,
    rounds: 1,
    receipts: record.receipts.length,
    events: record.events.length,
  });
});

test('result Service contract: exact historical receipt remains readable after rejection and a real next generation', async (t) => {
  let drained = false;
  const drain = new AbortController();
  const h = await host(t, {
    migrationDrain(scope) {
      assert.equal(scope.runId, 'run-1');
      assert.equal(scope.generation, 1);
      return drained
        ? {
            signal: drain.signal,
            assertCurrent() {
              drain.signal.throwIfAborted();
            },
          }
        : undefined;
    },
  });
  const receipt = checked(await submit(h));
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'result-return'),
      roundId: receipt.roundId,
      artifactVersionId: receipt.artifactVersionId,
      action: 'request-changes',
      comment: 'Refine the fixed result.',
    }),
  );
  const node = h.read();
  const { actorId, ...raw } = command(node, {
    requestId: 'next-generation',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
  });
  const { configurationId: _configuration, ...model } = raw.selection;
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node,
    scope: {
      ...h.locate(),
      actorId,
      spaceId: 'north',
      runId: 'run-2',
      generation: 2,
      segmentId: 'segment-2',
    },
    model,
    executor: { kind: 'plan-expert', ref: node.handoff.expertRef },
    tools: { kind: 'text-only' },
    resultIntentTool: describeNativeResultTool(),
    inputs: { ...h.locate(), actorId, spaceId: 'north', items: [] },
  });
  const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
  const request = { ...h.locate(), ...raw, ...projection, composition };
  assert(composition.payload.context.includes('Refine the fixed result.'));
  assert.equal(composition.payload.returnedRevision.roundId, receipt.roundId);
  const returned = h.read();
  refused(await h.service.startRun(h.request, request), 'run-migration-pending');
  assert.deepEqual(h.read(), returned, 'settled metadata is not a physical drain proof');
  drained = true;
  refused(await h.service.startRun({ headers: {} }, request), 'run-authority-denied');
  refused(
    await h.service.startRun(h.request, {
      ...request,
      expectedNodeVersion: request.expectedNodeVersion - 1,
    }),
    'run-conflict',
  );
  const next = checked(await h.service.startRun(h.request, request));
  assert.equal(next.run.attempt.id, 'run-2');
  assert.equal(next.run.attempt.generation, 2);
  assert.equal(next.effect.kind, 'dispatch');
  assert.deepEqual(h.read().artifactVersions, returned.artifactVersions);
  assert.deepEqual(h.read().rounds, returned.rounds);
  assert.deepEqual(h.read().nativeExecution.runs[0], returned.nativeExecution.runs[0]);
  const replay = checked(await h.service.startRun(h.request, request));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.effect.kind, 'reconcile');
  assert.equal(h.read().nativeExecution.runs.length, 2);
  refused(
    await h.service.recordRunEvent(
      h.locate(),
      {
        kind: 'idle',
        runId: 'run-1',
        generation: 1,
        segmentId: 'segment-1',
        sequence: 999,
      },
      { grant: h.opened.grant },
    ),
    'run-authority-denied',
  );
  const before = JSON.stringify(h.read());
  h.resetCounts();
  assert.equal(
    checked(await h.service.confirmNativeResultDelivery(h.request, confirmation(h, receipt)))
      .producerRunId,
    'run-1',
  );
  refused(
    await h.service.confirmNativeResultDelivery(h.request, {
      ...confirmation(h, receipt),
      runId: 'run-2',
      generation: 2,
      segmentId: 'segment-2',
      configurationId: composition.configurationId,
    }),
    'native-result-terminal-no-receipt',
  );
  assert.equal(JSON.stringify(h.read()), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('result Service contract: confirmation rejects altered locators and source/receipt claims and revoked membership with no writes', async (t) => {
  const h = await host(t);
  const receipt = checked(await submit(h));
  const body = confirmation(h, receipt);
  const before = JSON.stringify(h.read());
  h.resetCounts();
  for (const patch of [
    { nodeId: 'foreign' },
    { runId: 'foreign' },
    { generation: 2 },
    { segmentId: 'foreign' },
    { configurationId: 'foreign' },
    { idempotencyKey: 'foreign' },
    { intentId: 'foreign' },
    { digest: '0'.repeat(64) },
    { provenanceFingerprint: '0'.repeat(64) },
  ])
    assert.equal(
      (await h.service.confirmNativeResultDelivery(h.request, { ...body, ...patch })).ok,
      false,
      JSON.stringify(patch),
    );
  h.member.abort();
  assert.equal((await h.service.confirmNativeResultDelivery(h.request, body)).ok, false);
  assert.equal(JSON.stringify(h.read()), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('result Service contract: human assignment never auto-submits and a missing original issuer refuses before C IO', async (t) => {
  const human = await host(t, { human: true });
  refused(await submit(human), 'native-result-not-expert');
  assert.equal(human.counts.prepared, 0);
  assert.equal(human.read().artifactVersions.length, 0);
  const missing = await host(t, { install: false });
  refused(await submit(missing), 'native-result-unavailable');
  assert.equal(missing.counts.prepared, 0);
  assert.throws(() =>
    missing.service.installNativeResultIssuer({ ...missing.issuer, readFixedResult: undefined }),
  );
  missing.service.installNativeResultIssuer(missing.issuer);
  assert.throws(() => missing.service.installNativeResultIssuer(missing.issuer));
});

test('result Service contract: member revocation after lease read defeats the final write and still releases it', async (t) => {
  const h = await host(t);
  h.controls.afterRead = deferred();
  const pending = submit(h);
  try {
    await entered(h.controls.leaseEntered, pending);
    h.member.abort();
  } finally {
    h.controls.afterRead.resolve();
  }
  assert.equal((await pending).ok, false);
  assert.equal(h.counts.released, 1);
  assert.equal(h.read().artifactVersions.length, 0);
});

test('result Service contract: invalid asynchronous release is physically drained before close finishes', async (t) => {
  const h = await host(t);
  h.controls.releaseGate = deferred();
  const pending = submit(h);
  await entered(h.controls.releaseEntered, pending);
  let done = false;
  const closing = h.service.closeRuns().then(
    () => assert.fail('invalid async release must be reported'),
    (error) => {
      assert.equal(error.code, 'native-result-cleanup-failed');
      done = true;
    },
  );
  try {
    await setImmediate();
    assert.equal(done, false);
    assert.equal(h.read().artifactVersions.length, 1);
  } finally {
    h.controls.releaseGate.resolve();
  }
  assert.equal(checked(await pending).cleanup, 'failed');
  await closing;
  assert.equal(done, true);
});

test('result Service contract: invalid async C check cannot write, but its physical completion remains owned', async (t) => {
  const h = await host(t);
  const gate = deferred(),
    started = deferred();
  h.controls.mutate = (lease) => {
    lease.check = () => {
      started.resolve();
      return gate.promise;
    };
  };
  const pending = submit(h);
  await entered(started, pending);
  let done = false;
  const closing = h.service.closeRuns().catch((error) => {
    assert.equal(error.code, 'native-result-cleanup-failed');
    done = true;
  });
  try {
    await setImmediate();
    assert.equal(done, false);
    assert.equal(h.read().artifactVersions.length, 0);
  } finally {
    gate.resolve();
  }
  assert.equal((await pending).ok, false);
  await closing;
  assert.equal(h.counts.released, 1);
  assert.equal(done, true);
});

test('result Service contract: concurrent same-key different fixed bodies cannot reuse one receipt', async (t) => {
  const h = await host(t);
  h.controls.afterRead = deferred();
  h.controls.mutate = (lease) => {
    if (h.counts.read === 2) {
      lease.content = { text: 'Different fixed body.', links: [] };
      lease.digest = nativeResultDigest(lease.content);
      lease.provenanceFingerprint = nativeResultProvenance(lease.source, lease.digest);
    }
  };
  const body = h.submission(),
    first = submit(h, body),
    second = submit(h, body);
  try {
    await entered(h.controls.twoReadersEntered, Promise.race([first, second]));
  } finally {
    h.controls.afterRead.resolve();
  }
  const values = await Promise.all([first, second]);
  assert.equal(values.filter((result) => result.ok).length, 1);
  refused(
    values.find((result) => !result.ok),
    'native-result-delivery-conflict',
  );
  assert.equal(h.read().artifactVersions.length, 1);
  assert.equal(h.read().rounds.length, 1);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
});

test('result Service contract: bounded inflight admission and caller cancellation retain real late ownership', async (t) => {
  const h = await host(t);
  const gate = deferred(),
    all = deferred();
  h.controls.gate = gate;
  h.controls.onPrepare = () => {
    if (h.counts.prepared === 8) all.resolve();
  };
  const cancellation = new AbortController();
  const before = JSON.stringify(h.read());
  const pending = Array.from({ length: 8 }, (_, index) =>
    h.service.submitNativeFixedResult(
      h.request,
      h.submission(`capacity-${index}`),
      h.opened.grant,
      h.ref,
      cancellation.signal,
    ),
  );
  try {
    await entered(all, Promise.race(pending));
    refused(await submit(h), 'native-result-capacity');
    cancellation.abort();
    assert.equal(h.counts.prepared, 8);
    assert.equal(h.counts.read, 0);
  } finally {
    gate.resolve();
  }
  assert.ok((await Promise.all(pending)).every((result) => !result.ok));
  assert.equal(JSON.stringify(h.read()), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('result Service contract: terminal without exact receipt is not repaired or reconstructed from native completion', async (t) => {
  const h = await host(t);
  const body = h.submission();
  checked(
    await h.native(
      'completed',
      { grant: h.opened.grant },
      { idle: true, flushed: true, resourcesSettled: true },
    ),
  );
  h.resetCounts();
  const before = JSON.stringify(h.read());
  refused(await submit(h, body), 'native-result-terminal-no-receipt');
  assert.equal(JSON.stringify(h.read()), before);
  assert.equal(h.counts.prepared, 0);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});
