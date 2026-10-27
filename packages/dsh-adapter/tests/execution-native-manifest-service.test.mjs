/** Real original Service/Run queue and JSON. The completion issuer, member and
 * byte provider are contracts; these tests do not certify native completion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openManifestContract, deferred } from './execution-native-manifest-fixture.mjs';
import { checked, caller } from './execution-service-run-fixture.mjs';
import { readExecutionRunState } from '../dist/execution-run-state.js';
import { businessHashes } from './execution-native-result-service-fixture.mjs';

async function host(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-manifest-service-contract-'));
  const h = await openManifestContract(root, options);
  t.after(async () => {
    h.controls.readGate?.resolve();
    h.controls.afterLease?.resolve();
    h.controls.prepare?.resolve();
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...h, root };
}
const submit = (h, body = h.submission(), ref = h.ref) =>
  h.service.submitNativeFixedResult(h.request, body, h.opened.grant, ref);
const entered = (barrier, pending) =>
  Promise.race([
    barrier.promise,
    pending.then((result) => assert.fail(`ended before barrier: ${JSON.stringify(result)}`)),
  ]);
function noDelivery(h, before) {
  assert.equal(JSON.stringify(h.read()), before);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.equal(h.counters.nodes, 0);
}

test('manifest Service contract: files-only completion writes one original artifact, review round and fixed reference', async (t) => {
  const h = await host(t);
  const beforeFiles = JSON.stringify(h.service.fileStore.get(h.record.uploadId));
  const receipt = checked(await submit(h));
  assert.equal(receipt.protocolVersion, 2);
  assert.equal(receipt.disposition, 'applied');
  const node = h.read(),
    state = readExecutionRunState(node),
    run = state.runs[0];
  assert.equal(node.command.status, 'in-review');
  assert.equal(run.attempt.status, 'completed');
  assert.equal(run.resources, 'settled');
  assert.equal(node.artifactVersions.length, 1);
  assert.equal(node.rounds.length, 1);
  assert.equal(node.artifactVersions[0].submittedBy, 'qa');
  assert.equal(node.artifactVersions[0].producerRunId, run.attempt.id);
  assert.equal(node.artifactVersions[0].text, undefined);
  assert.equal(node.artifactVersions[0].files[0].id, h.record.uploadId);
  assert.equal(node.artifactVersions[0].files[0].checksum, h.record.sha256);
  assert.deepEqual(
    run.resultDelivery.publications,
    h.manifest.map((entry) => entry.evidence),
  );
  assert.equal(run.resultDelivery.manifestDigest, receipt.manifestDigest);
  assert.equal('record' in run.resultDelivery.publications[0], false);
  assert.equal(JSON.stringify(h.service.fileStore.get(h.record.uploadId)), beforeFiles);
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
  assert.deepEqual(h.counts, { v1Reads: 0, v2Reads: 1, releases: 1, bytes: 1 });
  assert.equal(h.opened.grant.signal.aborted, true);
  const before = await businessHashes(h.root);
  h.resetCounts();
  assert.equal(
    checked(await h.service.confirmNativeResultDelivery(h.request, h.confirmation(receipt)))
      .disposition,
    'confirmed',
  );
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.counts.bytes, 1, 'confirmation does not reread bytes or C');
  const {
    protocolVersion: _version,
    manifestDigest: _digest,
    ...v1Confirmation
  } = h.confirmation(receipt);
  assert.equal((await h.service.confirmNativeResultDelivery(h.request, v1Confirmation)).ok, false);
  assert.equal(
    (
      await h.service.confirmNativeResultDelivery(h.request, {
        ...h.confirmation(receipt),
        manifestDigest: '0'.repeat(64),
      })
    ).ok,
    false,
  );
});

test('manifest Service contract: the same installed owner preserves a v1 Run and never selects v2 from a lease', async (t) => {
  const h = await host(t, { protocolVersion: 1 });
  const value = checked(await submit(h));
  assert.equal(value.protocolVersion, undefined);
  assert.equal(value.manifestDigest, undefined);
  assert.equal(readExecutionRunState(h.read()).runs[0].resultDelivery.protocolVersion, 1);
  assert.deepEqual(h.counts, { v1Reads: 1, v2Reads: 0, releases: 1, bytes: 0 });
});

test('manifest Service contract: mixed owner views and a second installation are refused', async (t) => {
  const h = await host(t, { install: false });
  assert.throws(() =>
    h.service.installNativeResultIssuer(h.v1, { ...h.v2, v1Issuer: { ...h.v1 } }),
  );
  assert.throws(() => h.service.installNativeResultIssuer(h.v1, { ...h.v2, close() {} }));
  h.service.installNativeResultIssuer(h.v1, h.v2);
  assert.throws(() => h.service.installNativeResultIssuer(h.v1, h.v2));
  checked(await submit(h));
});

for (const [name, mutate] of [
  [
    'wrong protocol',
    (lease) => {
      lease.source.toolVersion = 'zhuma-native-result-intent@1';
    },
  ],
  [
    'wrong expert',
    (lease) => {
      lease.source.expertVersionId = 'foreign-expert';
    },
  ],
  [
    'wrong scope',
    (lease) => {
      lease.source.scope.nodeId = 'parallel';
    },
  ],
  [
    'wrong configuration',
    (lease) => {
      lease.source.configurationId = 'foreign-config';
    },
  ],
  [
    'wrong manifest digest',
    (lease) => {
      lease.manifestDigest = '0'.repeat(64);
    },
  ],
  [
    'extra manifest path',
    (lease) => {
      lease.manifest[0].path = '/private-path';
    },
  ],
  [
    'wrong publication bytes',
    (lease) => {
      lease.manifest[0].evidence.byteSize++;
    },
  ],
  [
    'publication after completion',
    (lease) => {
      lease.manifest[0].evidence.resultSeq = lease.source.cut.resultSeq;
    },
  ],
  [
    'wrong file reference',
    (lease) => {
      lease.content.files[0].id = 'foreign-upload';
    },
  ],
  [
    'duplicate publication',
    (lease) => {
      lease.manifest.push(structuredClone(lease.manifest[0]));
    },
  ],
]) {
  test(`manifest Service contract: ${name} cannot create a delivery`, async (t) => {
    const h = await host(t);
    const before = JSON.stringify(h.read());
    h.controls.mutate = mutate;
    assert.equal((await submit(h)).ok, false);
    noDelivery(h, before);
    assert.equal(h.counts.releases, 1);
  });
}

test('manifest Service contract: a cloned completion reference is not authority', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  assert.equal((await submit(h, h.submission(), structuredClone(h.ref))).ok, false);
  noDelivery(h, before);
  assert.equal(h.counts.v2Reads, 0);
});

test('manifest Service contract: a missing original publication row is rejected before byte I/O', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  h.service.fileStore.get = () => undefined;
  assert.equal((await submit(h)).ok, false);
  noDelivery(h, before);
  assert.equal(h.counts.bytes, 0);
});

test('manifest Service contract: an accepted review pins the same immutable file for the downstream node', async (t) => {
  const h = await host(t),
    receipt = checked(await submit(h));
  assert.equal(h.read('consume').command.status, 'blocked');
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'accept-manifest'),
      roundId: receipt.roundId,
      artifactVersionId: receipt.artifactVersionId,
      action: 'approve',
    }),
  );
  const downstream = h.read('consume');
  assert.equal(downstream.command.status, 'ready');
  assert.equal(downstream.handoff.inputRefs[0].artifactVersionId, receipt.artifactVersionId);
  const content = checked(
    await h.service.upstreamContent(caller(), {
      ...h.locate('consume'),
      spaceId: 'north',
      sourceNodeId: 'produce',
      artifactVersionId: receipt.artifactVersionId,
    }),
  );
  assert.equal(content.content.files[0].id, h.record.uploadId);
  assert.equal(content.content.files[0].checksum, h.record.sha256);
});

test('manifest Service contract: returned result remains a readonly historical receipt and cannot unlock downstream', async (t) => {
  const h = await host(t),
    receipt = checked(await submit(h));
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return-manifest'),
      roundId: receipt.roundId,
      artifactVersionId: receipt.artifactVersionId,
      action: 'request-changes',
      comment: 'Include the missing export column.',
    }),
  );
  assert.equal(h.read().command.status, 'needs-revision');
  assert.equal(h.read('consume').command.status, 'blocked');
  const before = await businessHashes(h.root);
  assert.equal(
    checked(await h.service.confirmNativeResultDelivery(h.request, h.confirmation(receipt)))
      .disposition,
    'confirmed',
  );
  assert.deepEqual(await businessHashes(h.root), before);
});

test('manifest Service contract: checksum mismatch retains the original active Run and creates no terminal metadata', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  h.controls.bytesOverride = new Uint8Array(h.bytes.length).fill(1);
  assert.equal((await submit(h)).ok, false);
  noDelivery(h, before);
  assert.equal(h.counts.bytes, 1);
  assert.equal(h.service.fileReadResources.size, 0);
});

test('manifest Service contract: the original business queue remains responsive while file I/O is held', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  h.controls.readGate = deferred();
  let settled = false;
  const pending = submit(h).finally(() => {
    settled = true;
  });
  await entered(h.controls.bytesYielded, pending);
  await h.service.enqueue(async () => ({ ok: true, value: 'queue-free' }));
  assert.equal(settled, false);
  noDelivery(h, before);
  assert.equal(h.service.fileReadResources.size, 1);
  h.controls.readGate.resolve();
  checked(await pending);
  await setImmediate();
  assert.equal(h.service.fileReadResources.size, 0);
});

test('manifest Service contract: revoked member during file I/O cannot commit after the stream finishes', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  h.controls.readGate = deferred();
  const pending = submit(h);
  await entered(h.controls.bytesYielded, pending);
  h.member.abort();
  h.controls.readGate.resolve();
  assert.equal((await pending).ok, false);
  noDelivery(h, before);
  assert.equal(h.service.fileReadResources.size, 0);
});

test('manifest Service contract: Stop during verification fences a late fixed result', async (t) => {
  const h = await host(t),
    body = h.submission();
  h.controls.readGate = deferred();
  const pending = submit(h, body);
  await entered(h.controls.bytesYielded, pending);
  const { configurationId: _configuration, idempotencyKey: _key, ...location } = body;
  checked(
    await h.service.stopRun(h.request, {
      ...location,
      spaceId: 'north',
      requestId: 'stop-manifest',
    }),
  );
  const stopped = JSON.stringify(h.read()),
    writes = h.counters.nodes;
  h.controls.readGate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(JSON.stringify(h.read()), stopped);
  assert.equal(h.counters.nodes, writes);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.equal(h.service.fileReadResources.size, 0);
});

test('manifest Service contract: changing the original ledger while bytes are in flight defeats the final write', async (t) => {
  const h = await host(t),
    before = JSON.stringify(h.read());
  h.controls.readGate = deferred();
  const pending = submit(h);
  await entered(h.controls.bytesYielded, pending);
  const get = h.service.fileStore.get.bind(h.service.fileStore);
  h.service.fileStore.get = (id) => {
    const row = get(id);
    return row && { ...row, name: 'changed-after-verification.txt' };
  };
  h.controls.readGate.resolve();
  assert.equal((await pending).ok, false);
  noDelivery(h, before);
});

test('manifest Service contract: a failed node write is retryable with the original reference and commits once', async (t) => {
  const h = await host(t),
    body = h.submission(),
    before = JSON.stringify(h.read());
  h.faults.node = true;
  assert.equal((await submit(h, body)).ok, false);
  noDelivery(h, before);
  h.faults.node = false;
  checked(await submit(h, body));
  assert.equal(h.read().artifactVersions.length, 1);
  assert.equal(h.counters.nodes, 1);
});

test('manifest Service contract: concurrent same-key results converge on one original durable receipt', async (t) => {
  const h = await host(t),
    body = h.submission();
  h.controls.afterLease = deferred();
  const first = submit(h, body),
    second = submit(h, body);
  await entered(h.controls.leaseEntered, first);
  await setImmediate();
  h.controls.afterLease.resolve();
  const values = (await Promise.all([first, second])).map(checked);
  assert.deepEqual(values.map((v) => v.disposition).sort(), ['applied', 'confirmed']);
  assert.equal(values[0].artifactVersionId, values[1].artifactVersionId);
  assert.equal(h.counters.nodes, 1);
  assert.equal(h.counts.releases, 2);
});

test('manifest Service contract: a new OS process confirms files using original JSON only, with no issuer or byte provider', async (t) => {
  const h = await host(t),
    value = checked(await submit(h)),
    body = h.confirmation(value);
  await h.close();
  const child = fork(
    new URL('./fixtures/native-manifest-confirm-child.mjs', import.meta.url),
    [h.root, JSON.stringify(body)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const message = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(Error(`child exited ${code}: ${stderr}`));
    });
  });
  checked(message.result);
  assert.equal(message.result.value.disposition, 'confirmed');
  assert.deepEqual(message.before, message.after);
  assert.deepEqual(message.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(message.artifacts, 1);
});
