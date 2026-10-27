/** Actual pinned SDK, original Cookie/member/Run/C owner, FS, attachment store
 * and JSON. The model is scripted and path policy explicit; no live-model or GUI proof.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootPublicationResults,
  readExecutionRunState,
  businessHashes,
} from './zhuma-execution-native-manifest-bundle.ts';

function checked(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-manifest-business-'));
  const h = await bootPublicationResults(root, options);
  h.execution.installNativeResultIssuer(h.resultOwner.v1Issuer, h.resultOwner);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  await h.admit();
  return { ...h, root };
}
function submission(h) {
  const node = h.row('expert'),
    state = readExecutionRunState(node),
    run = state.runs[0];
  return {
    ...h.locate('expert'),
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    configurationId: run.selection.configurationId,
    expectedNodeVersion: node.command.version,
    expectedRunVersion: state.version,
    idempotencyKey: 'sdk-manifest-submit',
  };
}
function confirmation(h, value) {
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
    ...(value.protocolVersion === 2
      ? { protocolVersion: 2, manifestDigest: value.manifestDigest }
      : {}),
  };
}

test('actual SDK file completion lands in the original Service after the workspace source is removed', async (t) => {
  const h = await setup(t);
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'business-publication');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await h.declare(
    { links: [], publications: [{ publicationId: ack.publicationId }] },
    { callId: 'business-complete' },
  );
  const ready = await h.ready();
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(h.ctx.agents.list().length, 0, 'the actual completed writer has retired');
  await unlink(join(h.workspaceRoot, 'outputs/result.bin'));
  const fsCounts = [h.ctx.fs.reads, h.ctx.fs.stats];
  const value = checked(
    await h.execution.submitNativeFixedResult(
      h.requests.chen,
      submission(h),
      h.opened.grant,
      ready.ref,
    ),
  );
  assert.equal(value.protocolVersion, 2);
  assert.equal(value.disposition, 'applied');
  assert.equal(value.cleanup, undefined);
  const node = h.row('expert'),
    run = readExecutionRunState(node).runs[0];
  assert.equal(node.command.status, 'completed');
  assert.equal(run.attempt.status, 'completed');
  assert.equal(run.resources, 'settled');
  assert.equal(node.artifactVersions.length, 1);
  assert.equal(node.artifactVersions[0].submittedBy, 'qa');
  assert.equal(node.artifactVersions[0].files[0].id, ack.publicationId);
  assert.equal(node.artifactVersions[0].files[0].checksum, ack.sha256);
  assert.equal(run.resultDelivery.publications[0].source.nativeAgentId, h.binding.nativeAgentId);
  assert.equal(
    run.resultDelivery.publications[0].source.nativeSessionId,
    h.binding.nativeSessionId,
  );
  assert.deepEqual(
    [h.ctx.fs.reads, h.ctx.fs.stats],
    fsCounts,
    'consumer verifies immutable attachments, never rereads the workspace',
  );
  const before = await businessHashes(h.root),
    requests = h.adapter.requests.length;
  const confirmed = checked(
    await h.execution.confirmNativeResultDelivery(h.requests.chen, confirmation(h, value)),
  );
  assert.equal(confirmed.disposition, 'confirmed');
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(h.adapter.requests.length, requests);
});

test('actual SDK dual owner preserves v1 Service completion without manifest metadata', async (t) => {
  const h = await setup(t, { version: 1, ownerVersion: 2 });
  await h.declare({ text: 'Legacy completion through the same original owner.', links: [] });
  const ready = await h.ready();
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const value = checked(
    await h.execution.submitNativeFixedResult(
      h.requests.chen,
      submission(h),
      h.opened.grant,
      ready.ref,
    ),
  );
  assert.equal(value.protocolVersion, undefined);
  assert.equal(value.manifestDigest, undefined);
  assert.equal(readExecutionRunState(h.row('expert')).runs[0].resultDelivery.protocolVersion, 1);
  assert.equal(
    h.row('expert').artifactVersions[0].text,
    'Legacy completion through the same original owner.',
  );
});

test('actual SDK permits a verified empty attachment when the fixed result contains substantive text', async (t) => {
  const h = await setup(t);
  await writeFile(join(h.workspaceRoot, 'outputs/empty.txt'), '');
  const ack = await h.invoke({ path: 'outputs/empty.txt' }, 'business-empty-publication');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.bytes, 0);
  await h.declare({
    text: 'The input set was empty; the export intentionally contains no rows.',
    links: [],
    publications: [{ publicationId: ack.publicationId }],
  });
  const ready = await h.ready();
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const value = checked(
    await h.execution.submitNativeFixedResult(
      h.requests.chen,
      submission(h),
      h.opened.grant,
      ready.ref,
    ),
  );
  assert.equal(value.protocolVersion, 2);
  assert.equal(h.row('expert').artifactVersions[0].files[0].byteSize, 0);
  assert.match(h.row('expert').artifactVersions[0].text, /intentionally/);
});
