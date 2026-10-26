/** Pinned actual SDK/member/Run/FS/JSON; scripted model and fixture path/publication policy. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { bootOutputFiles } from './zhuma-native-result-publications-bundle.ts';

async function domainBytes(root) {
  const directory = join(root, 'domains');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => [name, (await readFile(join(directory, name))).toString('base64')]),
  );
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-result-publications-sdk-'));
  let h = await bootOutputFiles(root);
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
    async reopen() {
      await h.close();
      h = await bootOutputFiles(root, { first: false, activate: false });
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
