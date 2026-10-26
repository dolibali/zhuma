/** Actual pinned SDK, Cookie, original Run manager and original C result issuer.
 * The local model is scripted; this is mechanism proof, not live-model quality or desktop QA.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootNativeResults,
  bootRunFiles,
  toolResponse,
  checked,
  readExecutionRunState,
  businessHashes,
  loseNextPutResponse,
} from './zhuma-execution-native-result-bundle.ts';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-fixed-result-business-sdk-'));
  const h = await bootNativeResults(root);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = await h.upload('Actual accepted input for the fixed result.');
  await h.submit(input, 'business-input');
  await h.ballot('approve', 'business-input-accept');
  const opened = await h.begin();
  t.onTestFinished(() => opened.dispose());
  h.execution.installNativeResultIssuer(h.results);
  return { ...h, root, opened };
}
function submission(h, key = 'business-result') {
  const node = h.row('expert');
  const state = readExecutionRunState(node),
    run = state.runs[0];
  return {
    ...h.locate('expert'),
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    configurationId: run.selection.configurationId,
    expectedNodeVersion: node.command.version,
    expectedRunVersion: state.version,
    idempotencyKey: key,
  };
}
function confirm(h, value) {
  return {
    ...h.locate('expert'),
    runId: value.producerRunId,
    generation: value.generation,
    segmentId: value.segmentId,
    configurationId: value.configurationId,
    idempotencyKey: value.receipt.idempotencyKey,
    intentId: value.intentId,
    digest: value.digest,
    provenanceFingerprint: value.provenanceFingerprint,
  };
}
async function completed(h, text) {
  h.adapter.script.push(
    toolResponse(
      { text, links: ['https://example.com/business-result'] },
      'business-complete',
      'complete_work',
    ),
  );
  await h.native.service.send(h.opened.grant, h.firstMessage());
  await h.actor().whenIdle();
  // These IDs come from the actual original C/SDK binding, not supplied fixtures.
  const binding = h.native.service.open(h.opened.grant).binding;
  const run = readExecutionRunState(h.row('expert')).runs[0];
  checked(
    await h.execution.recordRunEvent(
      h.locate('expert'),
      {
        kind: 'accepted',
        runId: run.attempt.id,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        sequence: run.attempt.lastEventSequence + 1,
        nativeSessionId: binding.nativeSessionId,
        executorRunId: binding.nativeAgentId,
      },
      { grant: h.opened.grant },
    ),
  );
  const ready = await h.results.prepareFixedResult(h.opened.grant, new AbortController().signal);
  assert.equal(ready.status, 'ready');
  assert.equal(h.ctx.agents.list().length, 0, 'original C requires physical writer retirement');
  return ready.ref;
}

for (const text of ['Actual fixed business result.', '中'.repeat(100000)])
  test(`actual C fixed result atomically becomes the original expert delivery (${text.length} characters)`, async (t) => {
    const h = await setup(t),
      ref = await completed(h, text);
    const value = checked(
      await h.execution.submitNativeFixedResult(
        h.requests.chen,
        submission(h),
        h.opened.grant,
        ref,
      ),
    );
    assert.equal(value.disposition, 'applied');
    assert.equal(value.cleanup, undefined, 'normal C auto-release remains a clean durable success');
    assert.ok(
      Buffer.byteLength(JSON.stringify(value)) < 4096,
      'ack never copies body or internal body-bearing fingerprint',
    );
    const row = h.row('expert'),
      run = readExecutionRunState(row).runs[0];
    assert.equal(row.command.status, 'completed');
    assert.equal(run.attempt.status, 'completed');
    assert.equal(run.resources, 'settled');
    assert.equal(row.artifactVersions.length, 1);
    assert.equal(row.artifactVersions[0].text, text);
    assert.equal(row.artifactVersions[0].producerRunId, 'file-run');
    assert.equal(row.artifactVersions[0].submittedBy, 'qa');
    assert.equal(row.rounds.length, 0);
    assert.equal(h.opened.grant.signal.aborted, true, 'terminal put revokes original drive');
    const before = await businessHashes(h.root);
    const count = h.adapter.requests.length;
    assert.equal(
      checked(await h.execution.confirmNativeResultDelivery(h.requests.chen, confirm(h, value)))
        .disposition,
      'confirmed',
    );
    assert.deepEqual(await businessHashes(h.root), before);
    assert.equal(h.adapter.requests.length, count);
  });

test('actual Cookie result confirmation survives lost durable response and a fresh owner with no C issuer or model execution', async (t) => {
  const h = await setup(t),
    ref = await completed(h, 'Durable result with a deliberately lost response.');
  const command = submission(h);
  const restore = loseNextPutResponse({ service: h.execution });
  try {
    assert.equal(
      (await h.execution.submitNativeFixedResult(h.requests.chen, command, h.opened.grant, ref)).ok,
      false,
    );
  } finally {
    restore();
  }
  const run = readExecutionRunState(h.row('expert')).runs[0],
    fixed = run.resultDelivery;
  const body = {
    ...h.locate('expert'),
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    configurationId: run.selection.configurationId,
    idempotencyKey: fixed.receiptKey,
    intentId: fixed.source.intentId,
    digest: fixed.digest,
    provenanceFingerprint: fixed.provenanceFingerprint,
  };
  const original = JSON.stringify(h.row('expert'));
  await h.close();
  const reader = await bootRunFiles(h.root, { first: false });
  t.onTestFinished(() => reader.close());
  // Existing C fixture selects the persisted configuration before attempting drive.
  // The drive must be denied; this does not reconstruct any C result owner or ref.
  await assert.rejects(reader.openExisting());
  const before = await businessHashes(h.root);
  const result = checked(
    await reader.execution.confirmNativeResultDelivery(reader.requests.chen, body),
  );
  assert.equal(result.disposition, 'confirmed');
  assert.equal(JSON.stringify(reader.row('expert')), original);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(reader.adapter.requests.length, 0);
  assert.equal(reader.ctx.agents.list().length, 0);
  await reader.revoke();
  assert.equal(
    (await reader.execution.confirmNativeResultDelivery(reader.requests.chen, body)).ok,
    false,
  );
});

test('real original manager and C refs reject cloning before any business artifact is written', async (t) => {
  const h = await setup(t),
    ref = await completed(h, 'Genuine fixed content.');
  const body = submission(h);
  assert.equal(
    (await h.execution.submitNativeFixedResult(h.requests.chen, body, { ...h.opened.grant }, ref))
      .ok,
    false,
  );
  assert.equal(
    (await h.execution.submitNativeFixedResult(h.requests.chen, body, h.opened.grant, { ...ref }))
      .ok,
    false,
  );
  assert.equal(h.row('expert').artifactVersions.length, 0);
  assert.equal(
    checked(await h.execution.submitNativeFixedResult(h.requests.chen, body, h.opened.grant, ref))
      .disposition,
    'applied',
  );
});
