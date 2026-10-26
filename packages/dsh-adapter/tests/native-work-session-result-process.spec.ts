/** Two OS processes over original SDK logs and file facts; scripted model only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'vitest';
import { bootPublicationResults } from './zhuma-native-result-process-bundle.ts';

const phase = process.env.ZHUMA_RESULT_PROCESS_PHASE;
const root = process.env.ZHUMA_RESULT_PROCESS_ROOT!;
const evidence = process.env.ZHUMA_RESULT_PROCESS_EVIDENCE!;
const signal = () => new AbortController().signal;
const fixedFacts = (lease) => ({
  source: lease.source,
  content: lease.content,
  manifest: lease.manifest,
  manifestDigest: lease.manifestDigest,
  digest: lease.digest,
  provenanceFingerprint: lease.provenanceFingerprint,
});

async function diskFacts(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const facts = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(facts, await diskFacts(path, base));
    else {
      assert.equal(entry.isFile(), true);
      const metadata = await stat(path, { bigint: true });
      facts[relative(base, path)] = {
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
      };
    }
  }
  return facts;
}

test.skipIf(phase !== 'produce')(
  'actual OS producer persists native v2 cut before any business submission',
  { timeout: 90000 },
  async () => {
    const h = await bootPublicationResults(root);
    await h.admit();
    const ack = await h.publish({ path: 'outputs/result.bin' }, 'process-publish');
    assert.equal(ack.ok, true, JSON.stringify(ack));
    await h.declare(
      {
        text: 'Original native result before business submission.',
        links: ['https://example.invalid/native-result'],
        publications: [{ publicationId: ack.publicationId }],
      },
      { callId: 'process-complete' },
    );
    const ready = await h.ready();
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const lease = await h.results.readFixedResult(h.opened.grant, ready.ref, signal());
    lease.check();
    assert.deepEqual(
      h.native.service.open(h.opened.grant).binding.resultIntent.cut,
      lease.source.cut,
    );
    assert.equal(h.row('expert').artifactVersions.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    const expected = fixedFacts(lease);
    lease.release();
    await writeFile(
      join(evidence, 'producer-ready.json.pending'),
      JSON.stringify({
        pid: process.pid,
        expected,
        publication: ack,
        modelCalls: h.adapter.requests.length,
        node: h.row('expert'),
        disk: await diskFacts(root),
      }),
    );
    await rename(
      join(evidence, 'producer-ready.json.pending'),
      join(evidence, 'producer-ready.json'),
    );
    // The driver kills this process group after the durable marker. No shutdown
    // repair or business submit may run in the crash window under test.
    await new Promise(() => {});
  },
);

test.skipIf(phase !== 'recover')(
  'actual OS recovery reconstructs an unsubmitted v2 manifest and rejects a wrong actor without writes',
  { timeout: 90000 },
  async () => {
    const original = JSON.parse(await readFile(join(evidence, 'producer-ready.json'), 'utf8'));
    assert.notEqual(process.pid, original.pid);
    const beforeBoot = await diskFacts(root);
    const afterSourceDeletion = { ...original.disk };
    delete afterSourceDeletion['work/outputs/result.bin'];
    assert.deepEqual(beforeBoot, afterSourceDeletion);
    const h = await bootPublicationResults(root, { first: false, activate: false });
    try {
      h.denyPublication();
      const before = await diskFacts(root);
      assert.deepEqual(Object.keys(before), Object.keys(beforeBoot));
      const bootWrites = Object.keys(before).filter(
        (path) => JSON.stringify(before[path]) !== JSON.stringify(beforeBoot[path]),
      );
      // Fresh genuine member logins persist identity sessions; they do not
      // modify the original Run, native binding, publications or SDK events.
      assert.deepEqual(bootWrites, ['domains/zhuma_identity.json']);
      const read = await h.issuer.open(
        h.requests.chen,
        { ...h.locate('expert'), runId: h.binding.scope.runId },
        'read',
      );
      try {
        h.issuer.assertGrant(read.grant, 'history');
        assert.throws(() => h.issuer.assertGrant(read.grant, 'send'));
        const metadata = await h.outputIssuer.readCompletedPublication(
          read.grant,
          {
            source: original.publication.source,
            publicationId: original.publication.publicationId,
          },
          signal(),
        );
        metadata.check();
        const history = await h.native.service.history(read.grant, -1, 100);
        assert.ok(history.events.length > 0);
      } finally {
        read.dispose();
      }
      const prepared = await h.ready();
      assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
      const lease = await h.results.readFixedResult(h.opened.grant, prepared.ref, signal());
      lease.check();
      assert.deepEqual(fixedFacts(lease), original.expected);
      const restored = structuredClone(fixedFacts(lease));
      for (const { record } of lease.manifest) {
        const chunks = [];
        for await (const chunk of h.ctx.attachments.readFileStream(
          { attachmentId: record.attachmentId, name: record.name, bytes: record.byteSize },
          signal(),
        )) {
          lease.check();
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        assert.equal(bytes.length, record.byteSize);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
        assert.deepEqual(bytes, Buffer.from([0, 255, 254, 128, 1, 42, 0, 31]));
      }
      lease.release();
      assert.equal(h.row('expert').artifactVersions.length, 0);
      assert.equal(h.adapter.requests.length, 0);
      assert.equal(h.ctx.agents.list().length, 0);
      assert.deepEqual([h.ctx.fs.stats, h.ctx.fs.reads], [0, 0]);
      const after = await diskFacts(root);
      await writeFile(
        join(evidence, 'recovered-before-negative.json'),
        JSON.stringify({ pid: process.pid, beforeBoot, before, after, node: h.row('expert') }),
      );
      const negativeBefore = await diskFacts(root);
      await assert.rejects(
        h.issuer.open(
          h.requests.outside,
          { ...h.locate('expert'), runId: h.binding.scope.runId },
          'drive',
        ),
      );
      assert.deepEqual(await diskFacts(root), negativeBefore);
      assert.deepEqual(Object.keys(after), Object.keys(before));
      const operationalLockTouches = [];
      for (const path of Object.keys(before)) {
        assert.equal(after[path].sha256, before[path].sha256, path);
        assert.equal(after[path].size, before[path].size, path);
        if (after[path].mtimeNs !== before[path].mtimeNs) {
          // The unmodified SDK's actual exclusive retirement barrier opens
          // this existing empty lock. No JSON/JSONL/attachment write is allowed.
          assert.ok(path.endsWith(`/${h.binding.nativeSessionId}/session.lock`), path);
          assert.equal(after[path].size, '0');
          operationalLockTouches.push(path);
        }
      }
      assert.equal(operationalLockTouches.length, 1);
      await writeFile(
        join(evidence, 'recovery-completed.json'),
        JSON.stringify({
          pid: process.pid,
          producerPid: original.pid,
          modelCalls: h.adapter.requests.length,
          fsStats: h.ctx.fs.stats,
          fsReads: h.ctx.fs.reads,
          facts: restored,
          noBusinessArtifacts: h.row('expert').artifactVersions.length === 0,
          wrongActorRejected: true,
          unchangedFacts: true,
          operationalLockTouches,
          bootWrites,
        }),
      );
    } finally {
      await h.close();
    }
  },
);
