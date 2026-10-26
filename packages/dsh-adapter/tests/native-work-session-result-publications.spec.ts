/** Pinned actual SDK/member/Run/FS/JSON; scripted model and fixture path/publication policy. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootOutputFiles,
  bootPublicationResults,
  nativeResultPublicationsDigest,
  nativePublicationManifestDigest,
  createNativeFixedResultPublicationsIssuer,
} from './zhuma-native-result-publications-bundle.ts';

async function domainBytes(root) {
  const directory = join(root, 'domains');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => [name, (await readFile(join(directory, name))).toString('base64')]),
  );
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-result-publications-sdk-'));
  const boot = options.results ? bootPublicationResults : bootOutputFiles;
  let h = await boot(root, options);
  const opened = [];
  t.onTestFinished(async () => {
    for (const read of opened) read.dispose();
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get host() {
      return h;
    },
    async readGrant() {
      const read = await h.issuer.open(
        h.requests.chen,
        { ...h.locate('expert'), runId: h.binding.scope.runId },
        'read',
      );
      opened.push(read);
      return read.grant;
    },
    async reopen(overrides = {}) {
      await h.close();
      h = await boot(root, { ...options, ...overrides, first: false, activate: false });
      return h;
    },
  };
}

test('actual completed-publication read: retired writer and denied publication allow genuine history-only cold lookup without FS or ledger writes', async (t) => {
  const f = await setup(t),
    h = f.host;
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'read-only-publication');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const retired = await h.native.runtime.retire(
    h.binding.nativeSessionId,
    new AbortController().signal,
  );
  retired.assertCurrent();
  h.denyPublication();
  await unlink(join(h.workspaceRoot, 'outputs/result.bin'));
  const grant = await f.readGrant();
  assert.throws(() => h.issuer.assertGrant(grant, 'send'));
  h.issuer.assertGrant(grant, 'history');
  const ledger = join(f.root, 'domains', 'zhuma_files.json');
  const original = await readFile(ledger),
    counts = [h.ctx.fs.stats, h.ctx.fs.reads];
  const domains = await domainBytes(f.root);
  const request = { source: ack.source, publicationId: ack.publicationId };
  const lease = await h.outputIssuer.readCompletedPublication(
    grant,
    request,
    new AbortController().signal,
  );
  lease.check();
  assert.equal(lease.record.uploadId, ack.publicationId);
  assert.equal(lease.record.sha256, ack.sha256);
  assert.deepEqual(lease.record.producer.source, ack.source);
  assert.deepEqual([h.ctx.fs.stats, h.ctx.fs.reads], counts);
  assert.deepEqual(await readFile(ledger), original);
  assert.deepEqual(await domainBytes(f.root), domains);
  lease.record.name = 'mutated.bin';
  assert.throws(() => lease.check());
  const cold = await f.reopen();
  cold.denyPublication();
  const coldGrant = await f.readGrant(),
    coldCounts = [cold.ctx.fs.stats, cold.ctx.fs.reads];
  const coldDomains = await domainBytes(f.root);
  assert.throws(() => cold.issuer.assertGrant(coldGrant, 'send'));
  const restored = await cold.outputIssuer.readCompletedPublication(
    coldGrant,
    request,
    new AbortController().signal,
  );
  restored.check();
  assert.equal(restored.record.uploadId, ack.publicationId);
  assert.equal(restored.record.name, 'result.bin');
  assert.deepEqual(await readFile(ledger), original);
  assert.deepEqual([cold.ctx.fs.stats, cold.ctx.fs.reads], coldCounts);
  assert.deepEqual(await domainBytes(f.root), coldDomains);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.equal(cold.adapter.requests.length, 0);
});

test(
  'actual fixed result v2: a genuine publication ACK and completed turn produce a guarded fixed file manifest',
  { timeout: 30000 },
  async (t) => {
    const f = await setup(t, { results: true }),
      h = f.host;
    const ack = await h.invoke({ path: 'outputs/result.bin' }, 'v2-published-file');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const before = h.row('expert').command.status;
    const content = { links: [], publications: [{ publicationId: ack.publicationId }] };
    await h.declare(content, { callId: 'v2-complete-file' });
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const lease = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    lease.check();
    assert.equal(lease.source.toolVersion, 'zhuma-native-result-intent@2');
    assert.equal(lease.manifestDigest, nativePublicationManifestDigest(lease.manifest));
    assert.equal(lease.source.manifestDigest, lease.manifestDigest);
    assert.equal(lease.digest, nativeResultPublicationsDigest(content, lease.manifestDigest));
    assert.equal(lease.manifest.length, 1);
    const entry = lease.manifest[0];
    assert.equal(entry.record.uploadId, ack.publicationId);
    assert.deepEqual(entry.record.producer.source, ack.source);
    assert.equal(entry.record.producer.source.expertVersionId, lease.source.expertVersionId);
    assert.ok(entry.evidence.callSeq < entry.evidence.resultSeq);
    assert.ok(entry.evidence.resultSeq < lease.source.cut.callSeq);
    assert.deepEqual(lease.content.files, [
      {
        id: ack.publicationId,
        mediaType: ack.mediaType,
        byteSize: ack.bytes,
        checksum: ack.sha256,
        accessPolicyId: 'space:north',
        uploadComplete: true,
      },
    ]);
    assert.equal(h.row('expert').command.status, before);
    assert.equal(h.ctx.agents.list().length, 0);
    h.native.runtime.migrationDrain(h.binding.nativeSessionId).assertCurrent();
    assert.throws(() => {
      lease.manifest[0].record.name = 'forged.bin';
    });
    assert.throws(() => {
      lease.content = { files: [], links: [] };
    });
    assert.throws(() => {
      lease.check = () => {};
    });
    assert.throws(
      () =>
        createNativeFixedResultPublicationsIssuer(
          h.ctx,
          h.native.service,
          h.native.runtime,
          h.issuer,
          h.execution,
          { ...h.outputIssuer },
        ),
      { code: 'result-unavailable' },
    );
    await assert.rejects(
      h.results.readFixedResult(h.opened.grant, { ...prepared.ref }, new AbortController().signal),
    );
    await assert.rejects(
      h.results.readFixedResult({ ...h.opened.grant }, prepared.ref, new AbortController().signal),
    );
    lease.release();
    assert.throws(() => lease.check());
  },
);

test(
  'actual fixed result v1: the shared lifecycle retains the original text/link lease shape and digest',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true, version: 1 })).host;
    await h.declare(
      { text: 'An original text result.', links: [] },
      { callId: 'v1-still-original' },
    );
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const lease = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    lease.check();
    assert.equal(lease.source.toolVersion, 'zhuma-native-result-intent@1');
    assert.deepEqual(lease.content, { text: 'An original text result.', links: [] });
    assert.equal(lease.digest, '3b4b8cc0c88402905fe1dcf01ae51f7301e46e36f6c35d15e50e37549e7d82b6');
    assert.equal(Object.hasOwn(lease, 'manifest'), false);
    assert.equal(Object.hasOwn(lease, 'manifestDigest'), false);
    assert.deepEqual(Object.keys(lease.source), [
      'scope',
      'nativeSessionId',
      'nativeAgentId',
      'configurationId',
      'toolVersion',
      'intentId',
      'callId',
      'cut',
    ]);
    assert.deepEqual(Object.keys(lease), [
      'source',
      'content',
      'digest',
      'provenanceFingerprint',
      'signal',
      'check',
      'release',
    ]);
    lease.release();
  },
);

test('actual completed-publication read: original read grants still reject clones, foreign source facts and real logout', async (t) => {
  const f = await setup(t),
    h = f.host;
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'read-only-negatives');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const grant = await f.readGrant(),
    signal = new AbortController().signal;
  const request = { source: ack.source, publicationId: ack.publicationId };
  const lease = await h.outputIssuer.readCompletedPublication(grant, request, signal);
  const ledger = join(f.root, 'domains', 'zhuma_files.json'),
    original = await readFile(ledger);
  const counts = [h.ctx.fs.stats, h.ctx.fs.reads];
  const domains = await domainBytes(f.root);
  await assert.rejects(h.port.readCompleted({ ...grant }, request, signal));
  for (const field of [
    'nativeSessionId',
    'nativeAgentId',
    'configurationId',
    'expertVersionId',
    'callId',
  ])
    await assert.rejects(
      h.port.readCompleted(
        grant,
        { ...request, source: { ...ack.source, [field]: 'foreign' } },
        signal,
      ),
    );
  for (const field of Object.keys(ack.source.scope)) {
    const scope = {
      ...ack.source.scope,
      [field]: typeof ack.source.scope[field] === 'number' ? 2 : 'foreign',
    };
    await assert.rejects(
      h.port.readCompleted(grant, { ...request, source: { ...ack.source, scope } }, signal),
    );
  }
  await assert.rejects(
    h.port.readCompleted(grant, { ...request, publicationId: 'missing' }, signal),
  );
  const human = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].find(
    ([, record]) => !record.producer,
  );
  assert.ok(human);
  await assert.rejects(
    h.port.readCompleted(grant, { ...request, publicationId: human[0] }, signal),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(h.port.readCompleted(grant, request, cancelled.signal));
  assert.deepEqual([h.ctx.fs.stats, h.ctx.fs.reads], counts);
  assert.deepEqual(await readFile(ledger), original);
  assert.deepEqual(await domainBytes(f.root), domains);
  await h.revoke();
  assert.throws(() => lease.check());
  await assert.rejects(h.outputIssuer.readCompletedPublication(grant, request, signal));
  assert.deepEqual(await readFile(ledger), original);
});

test(
  'actual fixed result v2: cold reconstruction uses the original SDK cut and immutable ledger without a model or FS access',
  { timeout: 30000 },
  async (t) => {
    const f = await setup(t, { results: true }),
      h = f.host;
    const ack = await h.invoke({ path: 'outputs/result.bin' }, 'cold-v2-publish');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    await h.declare(
      {
        text: 'A fixed binary result.',
        links: [],
        publications: [{ publicationId: ack.publicationId }],
      },
      { callId: 'cold-v2-complete' },
    );
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const original = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    const expected = {
      source: original.source,
      content: original.content,
      manifest: original.manifest,
      manifestDigest: original.manifestDigest,
      digest: original.digest,
      provenanceFingerprint: original.provenanceFingerprint,
    };
    original.release();
    await unlink(join(h.workspaceRoot, 'outputs/result.bin'));
    const cold = await f.reopen();
    cold.denyPublication();
    const ledger = join(f.root, 'domains', 'zhuma_files.json'),
      before = await readFile(ledger);
    const counts = [cold.ctx.fs.stats, cold.ctx.fs.reads];
    await assert.rejects(
      cold.results.readFixedResult(cold.opened.grant, prepared.ref, new AbortController().signal),
    );
    const reconstructed = await cold.ready();
    assert.equal(reconstructed.status, 'ready', JSON.stringify(reconstructed));
    const lease = await cold.results.readFixedResult(
      cold.opened.grant,
      reconstructed.ref,
      new AbortController().signal,
    );
    lease.check();
    assert.deepEqual(
      {
        source: lease.source,
        content: lease.content,
        manifest: lease.manifest,
        manifestDigest: lease.manifestDigest,
        digest: lease.digest,
        provenanceFingerprint: lease.provenanceFingerprint,
      },
      expected,
    );
    assert.deepEqual(await readFile(ledger), before);
    assert.deepEqual([cold.ctx.fs.stats, cold.ctx.fs.reads], counts);
    assert.equal(cold.ctx.agents.list().length, 0);
    assert.equal(cold.adapter.requests.length, 0);
    lease.release();
  },
);

test(
  'actual fixed result v2: invented selectors and human-input receipts cannot declare completion',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true })).host;
    for (const publicationId of [
      'invented-publication',
      [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].find(
        ([, record]) => !record.producer,
      )[0],
    ]) {
      const result = await h.declare(
        { links: [], publications: [{ publicationId }] },
        { rejected: true },
      );
      assert.deepEqual(result, { status: 'pending', reason: 'not-declared' });
      assert.equal(h.native.service.open(h.opened.grant).binding.resultIntent, undefined);
    }
    assert.equal(h.row('expert').command.status, 'ready');
  },
);

test(
  'actual fixed result v2: changed ledger metadata cannot stand in for the original successful SDK acknowledgement',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true })).host;
    const ack = await h.invoke({ path: 'outputs/result.bin' }, 'v2-ledger-publish');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const files = h.execution.fileStore,
      get = files.get.bind(files);
    const content = { links: [], publications: [{ publicationId: ack.publicationId }] };
    try {
      // Explicit read-source fault injection; the real durable ledger is not rewritten.
      files.get = (id) => {
        const record = get(id);
        return id === ack.publicationId && record ? { ...record, name: 'changed.bin' } : record;
      };
      const rejected = await h.declare(content, { rejected: true });
      assert.deepEqual(rejected, { status: 'pending', reason: 'not-declared' });
      assert.equal(h.native.service.open(h.opened.grant).binding.resultIntent, undefined);
    } finally {
      files.get = get;
    }
    await h.declare(content, { callId: 'v2-valid-after-source-recovery' });
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const lease = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    try {
      files.get = (id) => {
        const record = get(id);
        return id === ack.publicationId && record
          ? { ...record, name: 'changed-after-cut.bin' }
          : record;
      };
      assert.throws(() => lease.check());
      await assert.rejects(
        h.results.readFixedResult(h.opened.grant, prepared.ref, new AbortController().signal),
      );
    } finally {
      files.get = get;
      lease.release();
    }
  },
);

for (const action of ['stop', 'logout'])
  test(
    `actual fixed result v2: a real ${action} rejects an already issued genuine result reference`,
    { timeout: 30000 },
    async (t) => {
      const h = (await setup(t, { results: true })).host;
      const ack = await h.invoke({ path: 'outputs/result.bin' }, `v2-before-${action}`);
      assert.equal(ack.ok, true, JSON.stringify(ack));
      await h.declare({ links: [], publications: [{ publicationId: ack.publicationId }] });
      const prepared = await h.ready();
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
      const lease = await h.results.readFixedResult(
        h.opened.grant,
        prepared.ref,
        new AbortController().signal,
      );
      if (action === 'stop') await h.stop();
      else await h.revoke();
      assert.throws(() => lease.check());
      await assert.rejects(
        h.results.readFixedResult(h.opened.grant, prepared.ref, new AbortController().signal),
      );
      await assert.rejects(
        h.results.prepareFixedResult(h.opened.grant, new AbortController().signal),
      );
      lease.release();
    },
  );

test(
  'actual fixed result v2: explicit text-only v2 fixes an empty manifest without workspace file reads',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true })).host;
    const counts = [h.ctx.fs.stats, h.ctx.fs.reads];
    const stats = [];
    h.ctx.fs.beforeStat = (target) => {
      stats.push(typeof target === 'string' ? target : h.ctx.fs.processPath(target));
    };
    await h.declare({ text: 'A version-two text result.', links: [], publications: [] });
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const lease = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    assert.deepEqual(lease.manifest, []);
    assert.equal(lease.manifestDigest, nativePublicationManifestDigest([]));
    assert.deepEqual(lease.content, { text: 'A version-two text result.', links: [], files: [] });
    assert.equal(h.ctx.fs.reads, counts[1]);
    // The original SDK may revalidate its working directory during retirement.
    // It must not inspect an output file for an empty publication selection.
    assert.ok(
      stats.every(
        (path) =>
          path.replace(/^\/private(?=\/var\/)/u, '') ===
          h.workspaceRoot.replace(/^\/private(?=\/var\/)/u, ''),
      ),
      JSON.stringify(stats),
    );
    h.ctx.fs.beforeStat = undefined;
    lease.release();
  },
);

test(
  'actual fixed result v2: an empty file publishes successfully but needs other valid delivery content',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true })).host;
    await writeFile(join(h.workspaceRoot, 'outputs/result.bin'), Buffer.alloc(0));
    const ack = await h.invoke({ path: 'outputs/result.bin' }, 'zero-byte-published');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.bytes, 0);
    const publications = [{ publicationId: ack.publicationId }];
    const rejected = await h.declare({ links: [], publications }, { rejected: true });
    assert.deepEqual(rejected, { status: 'pending', reason: 'not-declared' });
    assert.equal(h.native.service.open(h.opened.grant).binding.resultIntent, undefined);
    await h.declare({ text: 'An intentionally empty attachment.', links: [], publications });
    const prepared = await h.ready();
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const lease = await h.results.readFixedResult(
      h.opened.grant,
      prepared.ref,
      new AbortController().signal,
    );
    assert.equal(lease.content.files[0].byteSize, 0);
    assert.equal(lease.content.files[0].uploadComplete, true);
    assert.equal(lease.content.text, 'An intentionally empty attachment.');
    lease.release();
  },
);

test(
  'actual fixed result: one owner serves an existing v1 Run and a new v2 Run without duplicate lifecycle or cross-protocol reads',
  { timeout: 45000 },
  async (t) => {
    const f = await setup(t, { results: true, version: 1, ownerVersion: 2, extraExpertNode: true }),
      prior = f.host;
    await prior.admit();
    await prior.declare({ text: 'Old ongoing text result.', links: [] });
    const first = await prior.ready();
    assert.equal(first.status, 'ready', JSON.stringify(first));
    const h = await f.reopen({ ownerVersion: 2 });
    const owner = h.resultOwner,
      legacy = owner.v1Issuer;
    assert.equal(h.results, legacy);
    assert.equal(owner.registerNativeResultTool, legacy.registerNativeResultTool);
    assert.equal(owner.onReady, legacy.onReady);
    assert.equal(owner.close, legacy.close);
    await assert.rejects(
      legacy.readFixedResult(h.opened.grant, first.ref, new AbortController().signal),
    );
    const old = await h.ready();
    assert.equal(old.status, 'ready', JSON.stringify(old));
    const sibling = await h.startSibling();
    await sibling.admit();
    const siblingStatus = h.row('expert-other').command.status;
    const ack = await sibling.publish({ path: 'outputs/result.bin' }, 'same-owner-v2-publish');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    await sibling.declare({ links: [], publications: [{ publicationId: ack.publicationId }] });
    const newer = await sibling.ready();
    assert.equal(newer.status, 'ready', JSON.stringify(newer));
    const oldLease = await legacy.readFixedResult(
      h.opened.grant,
      old.ref,
      new AbortController().signal,
    );
    assert.deepEqual(oldLease.content, { text: 'Old ongoing text result.', links: [] });
    oldLease.release();
    const newerLease = await owner.readFixedResult(
      sibling.opened.grant,
      newer.ref,
      new AbortController().signal,
    );
    assert.equal(newerLease.content.files[0].id, ack.publicationId);
    newerLease.release();
    await assert.rejects(
      owner.readFixedResult(h.opened.grant, old.ref, new AbortController().signal),
    );
    await assert.rejects(
      legacy.readFixedResult(sibling.opened.grant, newer.ref, new AbortController().signal),
    );
    await assert.rejects(
      legacy.readFixedResult(h.opened.grant, newer.ref, new AbortController().signal),
    );
    h.execution.installNativeResultIssuer(legacy);
    const node = h.row('expert'),
      scope = h.opened.grant.scope;
    const submitted = await h.execution.submitNativeFixedResult(
      h.requests.chen,
      {
        ...h.locate('expert'),
        runId: scope.runId,
        generation: scope.generation,
        segmentId: scope.segmentId,
        configurationId: h.binding.selection.configurationId,
        expectedNodeVersion: node.command.version,
        expectedRunVersion: node.nativeExecution.version,
        idempotencyKey: 'same-owner-original-v1-submit',
      },
      h.opened.grant,
      old.ref,
      new AbortController().signal,
    );
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(h.row('expert').artifactVersions.at(-1).text, 'Old ongoing text result.');
    assert.equal(h.row('expert-other').command.status, siblingStatus);
    assert.equal(h.row('expert').command.status, 'completed');
    const stillCurrent = await owner.readFixedResult(
      sibling.opened.grant,
      newer.ref,
      new AbortController().signal,
    );
    stillCurrent.check();
    stillCurrent.release();
  },
);

test(
  'actual fixed result v2: logout while awaiting original writer retirement cannot issue a ready reference',
  { timeout: 30000 },
  async (t) => {
    const h = (await setup(t, { results: true })).host;
    const ack = await h.invoke({ path: 'outputs/result.bin' }, 'held-v2-publish');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const retire = h.native.runtime.retire.bind(h.native.runtime);
    let issued = 0;
    const off = h.results.onReady(() => {
      issued++;
    });
    h.native.runtime.retire = async (...args) => {
      entered.resolve();
      await release.promise;
      return retire(...args);
    };
    let declaring;
    try {
      declaring = h.declare({ links: [], publications: [{ publicationId: ack.publicationId }] });
      // Observe rejection immediately; the test later checks its exact negative outcome.
      void declaring.catch(() => undefined);
      await entered.promise;
      assert.throws(() => h.native.runtime.migrationDrain(h.binding.nativeSessionId));
      await h.revoke();
      release.resolve();
      await assert.rejects(declaring);
      assert.equal(issued, 0);
      await assert.rejects(
        h.results.prepareFixedResult(h.opened.grant, new AbortController().signal),
      );
    } finally {
      release.resolve();
      h.native.runtime.retire = retire;
      off();
      await declaring?.catch(() => undefined);
    }
  },
);
