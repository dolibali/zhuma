/** Actual fixed SDK, original Cookie/Run and real FS/attachments; fixture-issued path/publication grant and scripted model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  bootOutputFiles,
  describeNativeOutputFileTool,
  toolResponse,
} from './zhuma-native-output-file-bundle.ts';

test('actual old absent publisher configuration retains normal native work and refuses the new publication factory', async (t) => {
  const f = await setup(t, { publisher: false }),
    h = f.host;
  await assert.rejects(
    h.port.reserve(h.opened.grant, h.request('old-run'), new AbortController().signal),
    { code: 'not-found' },
  );
  assert.ok(
    h.adapter.requests.every((r) => r.tools.every((tool) => tool.name !== 'publish_output_file')),
  );
  assert.equal(h.ctx.fs.reads, 0);
});

test('actual output publication: synchronous permission revocation after SDK save but before ledger commit leaves no completed receipt', async (t) => {
  const f = await setup(t),
    h = f.host;
  const saved = Promise.withResolvers(),
    release = Promise.withResolvers();
  const save = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (...args) => {
    const value = await save(...args);
    saved.resolve();
    await release.promise;
    return value;
  };
  try {
    const publishing = h.invoke({ path: 'outputs/result.bin' }, 'revoked-at-commit');
    await saved.promise;
    h.denyPublication();
    release.resolve();
    const result = await publishing;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'publication-denied');
    const records = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()];
    assert.equal(records.filter(([, record]) => record.producer).length, 0);
  } finally {
    release.resolve();
    h.ctx.attachments.saveFileStream = save;
  }
});

test('actual output publication: Agent retirement waits for a cancelled real tool publication provider to physically settle', async (t) => {
  const f = await setup(t),
    h = f.host;
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const save = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (...args) => {
    entered.resolve();
    await release.promise;
    return save(...args);
  };
  let retiring;
  try {
    h.adapter.script.push(
      toolResponse({ path: 'outputs/result.bin' }, 'held-publication', 'publish_output_file'),
    );
    await h.native.service.send(h.opened.grant, {
      ...h.firstMessage(),
      requestId: 'held-publication-input',
      text: 'Publish the result.',
    });
    await entered.promise;
    h.issuer.assertGrant(h.opened.grant, 'send');
    let drained = false;
    retiring = h.native.runtime
      .retire(h.binding.nativeSessionId, new AbortController().signal)
      .then((proof) => {
        drained = true;
        return proof;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    assert.throws(() => h.native.runtime.migrationDrain(h.binding.nativeSessionId));
    release.resolve();
    const proof = await retiring;
    proof.assertCurrent();
    const records = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()];
    assert.equal(records.filter(([, record]) => record.producer).length, 0);
  } finally {
    release.resolve();
    await retiring;
    h.ctx.attachments.saveFileStream = save;
  }
});

test(
  'actual publication factory: twenty real publications reach the exact file count limit',
  // Twenty real SDK calls repeat current member/Run checks and durable writes.
  // This test deadline does not change any per-publication resource bound.
  { timeout: 90000 },
  async (t) => {
    const f = await setup(t),
      h = f.host;
    // Four original SDK model turns, five genuine tool calls per turn. This
    // exercises publication concurrency without paying for 21 unrelated user turns.
    const published = [];
    for (let batch = 0; batch < 4; batch++) {
      const results = await h.invokeBatch(
        Array.from({ length: 5 }, () => ({ args: { path: 'outputs/result.bin' } })),
      );
      for (const result of results) {
        assert.equal(result.ok, true, JSON.stringify(result));
        published.push(result.publicationId);
      }
    }
    assert.equal(new Set(published).size, 20);
    const before = h.ctx.fs.reads;
    const rejected = await h.invoke({ path: 'outputs/result.bin' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'quota-exceeded');
    assert.equal(h.ctx.fs.reads, before);
  },
);

test('actual publication factory: a hundred MiB of shared reservations reaches the exact node byte limit', async (t) => {
  const fresh = (await setup(t)).host,
    permits = [];
  try {
    for (let i = 0; i < 5; i++)
      permits.push(
        await fresh.port.reserve(
          fresh.opened.grant,
          { ...fresh.request(`node-budget-${i}`), maximumBytes: 20 * 1024 * 1024 },
          new AbortController().signal,
        ),
      );
    await assert.rejects(
      fresh.port.reserve(
        fresh.opened.grant,
        { ...fresh.request('over-node-budget'), maximumBytes: 1 },
        new AbortController().signal,
      ),
      { code: 'quota-exceeded' },
    );
  } finally {
    for (const p of permits) p.releaseAfter(Promise.resolve());
    await Promise.all(permits.map((p) => p.drain));
  }
});

test(
  'actual output publication: the exact twenty MiB binary boundary stays out of the model transcript',
  { timeout: 30000 },
  async (t) => {
    const f = await setup(t),
      h = f.host;
    const bytes = Buffer.alloc(20 * 1024 * 1024, 255);
    bytes.write('SYNTHETIC_OUTPUT_BODY_CANARY');
    await writeFile(join(h.workspaceRoot, 'outputs', 'result.bin'), bytes);
    const result = await h.invoke({ path: 'outputs/result.bin' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(
      JSON.stringify(h.adapter.requests).includes('SYNTHETIC_OUTPUT_BODY_CANARY'),
      false,
    );
  },
);

test('actual output publication: a corrupt SDK attachment receipt cannot complete the file ledger', async (t) => {
  const f = await setup(t),
    h = f.host;
  const save = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (...args) => {
    const result = await save(...args);
    return { ...result, bytes: result.bytes + 1 };
  };
  try {
    const result = await h.invoke({ path: 'outputs/result.bin' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'digest-mismatch');
    const records = [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()];
    assert.equal(records.filter(([, record]) => record.producer).length, 0);
  } finally {
    h.ctx.attachments.saveFileStream = save;
  }
});

test('actual publication authorization: clone grants, mismatched selectors and a real logout cannot recover another publication', async (t) => {
  const f = await setup(t),
    h = f.host;
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'permission-publication');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const ref = h.outputIssuer.publishedFile(h.opened.grant, ack.publicationId);
  const lease = h.outputIssuer.readPublishedFile(h.opened.grant, ref);
  await assert.rejects(
    h.port.reserve(
      { ...h.opened.grant },
      h.request('permission-publication', 'lookup'),
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    h.port.reserve(
      h.opened.grant,
      h.request('permission-publication', 'lookup', 'outputs/other.bin', 'other.bin'),
      new AbortController().signal,
    ),
    { code: 'idempotency-mismatch' },
  );
  await h.revoke();
  await assert.rejects(
    h.port.reserve(
      h.opened.grant,
      h.request('permission-publication', 'lookup'),
      new AbortController().signal,
    ),
  );
  assert.throws(() => lease.check());
});

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-output-sdk-'));
  let h = await bootOutputFiles(root, options);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get host() {
      return h;
    },
    async reopen() {
      await h.close();
      h = await bootOutputFiles(root, { first: false, activate: false });
      return h;
    },
  };
}

test('actual output publication: the official scoped tool publishes exact non-UTF8 bytes without submitting or advancing work', async (t) => {
  const f = await setup(t),
    h = f.host;
  const bytes = await readFile(join(h.workspaceRoot, 'outputs', 'result.bin'));
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'actual:publication:1');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.phase, 'published');
  assert.equal(ack.bytes, bytes.length);
  assert.equal(ack.sha256, createHash('sha256').update(bytes).digest('hex'));
  const ref = h.outputIssuer.publishedFile(h.opened.grant, ack.publicationId);
  const lease = h.outputIssuer.readPublishedFile(h.opened.grant, ref);
  lease.check();
  const chunks = [];
  for await (const chunk of h.ctx.attachments.readFileStream({
    attachmentId: lease.record.attachmentId,
    name: lease.record.name,
    bytes: lease.record.byteSize,
  }))
    chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(lease.record.uploadedBy, 'chen');
  assert.equal(lease.record.producer.source.expertVersionId, ack.source.expertVersionId);
  assert.throws(() => h.outputIssuer.readPublishedFile(h.opened.grant, {}), { code: 'not-found' });
  assert.equal(h.row('expert').artifactVersions.length, 0);
  assert.equal(h.row('expert').rounds.length, 0);
  const altered = h.outputIssuer.readPublishedFile(h.opened.grant, ref);
  altered.record.name = 'changed.bin';
  assert.throws(() => altered.check(), { code: 'publication-denied' });
  await h.native.runtime.retire(h.binding.nativeSessionId, new AbortController().signal);
  const afterRetirement = h.outputIssuer.readPublishedFile(h.opened.grant, ref);
  afterRetirement.check();
  assert.equal(afterRetirement.record.sha256, ack.sha256);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.ok(
    h.adapter.requests.some((r) =>
      r.tools.some((tool) => tool.name === describeNativeOutputFileTool().name),
    ),
  );
});

test('actual output publication: independent publish permission can deny a readable workspace file', async (t) => {
  const f = await setup(t),
    h = f.host;
  h.denyPublication();
  const before = h.ctx.fs.reads;
  const ack = await h.invoke({ path: 'outputs/result.bin' });
  assert.equal(ack.ok, false);
  assert.equal(ack.code, 'publication-denied');
  assert.equal(h.ctx.fs.reads, before);
  assert.equal(h.row('expert').artifactVersions.length, 0);
});

test('actual publication lookup: a cold owner returns the same immutable receipt after the source file is removed, with no FS reads or ledger writes', async (t) => {
  const f = await setup(t),
    h = f.host;
  const ack = await h.invoke({ path: 'outputs/result.bin' }, 'cold-publication');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const request = h.request('cold-publication', 'lookup');
  await unlink(join(h.workspaceRoot, 'outputs', 'result.bin'));
  const cold = await f.reopen();
  const restoredRequest = cold.request('cold-publication', 'lookup');
  assert.deepEqual(restoredRequest, request);
  const ledger = join(f.root, 'domains', 'zhuma_files.json'),
    before = await readFile(ledger);
  const counts = [cold.ctx.fs.stats, cold.ctx.fs.reads];
  const found = await cold.port.reserve(
    cold.opened.grant,
    restoredRequest,
    new AbortController().signal,
  );
  assert.equal(found.completed.uploadId, ack.publicationId);
  assert.equal(found.completed.sha256, ack.sha256);
  found.releaseAfter(Promise.resolve());
  await found.drain;
  assert.deepEqual([cold.ctx.fs.stats, cold.ctx.fs.reads], counts);
  assert.deepEqual(await readFile(ledger), before);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.equal(cold.adapter.requests.length, 0);
});

test('actual publication factory: missing explicit mode or reserve maximum cannot accidentally create a reservation', async (t) => {
  const f = await setup(t),
    h = f.host;
  const request = h.request('missing-mode');
  delete request.mode;
  await assert.rejects(h.port.reserve(h.opened.grant, request, new AbortController().signal), {
    code: 'invalid-request',
  });
  request.mode = 'reserve';
  delete request.maximumBytes;
  await assert.rejects(h.port.reserve(h.opened.grant, request, new AbortController().signal), {
    code: 'invalid-request',
  });
  await assert.rejects(
    h.port.reserve(
      h.opened.grant,
      h.request('not-published', 'lookup'),
      new AbortController().signal,
    ),
    { code: 'not-found' },
  );
});

test('actual publication quotas: native reservations and a cancelled but physically held human upload share the original eight slots', async (t) => {
  const f = await setup(t),
    h = f.host,
    permits = [];
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    physical = Promise.withResolvers();
  const save = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (...args) => {
    try {
      return await save(...args);
    } finally {
      physical.resolve();
    }
  };
  const cancel = new AbortController();
  let uploading;
  try {
    for (let i = 0; i < 7; i++)
      permits.push(
        await h.port.reserve(
          h.opened.grant,
          h.request(`reserved-${i}`),
          new AbortController().signal,
        ),
      );
    uploading = h.humanUpload('human bytes', {
      signal: cancel.signal,
      data: {
        async *[Symbol.asyncIterator]() {
          entered.resolve();
          await release.promise;
          yield Buffer.from('human bytes');
        },
      },
    });
    await entered.promise;
    await assert.rejects(
      h.port.reserve(h.opened.grant, h.request('ninth'), new AbortController().signal),
      { code: 'quota-exceeded' },
    );
    const deniedHuman = await h.humanUpload('another human');
    assert.equal(deniedHuman.ok, false);
    assert.equal(deniedHuman.error.code, 'quota-exceeded');
    cancel.abort();
    const cancelled = await uploading;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, 'cancelled');
    await assert.rejects(
      h.port.reserve(h.opened.grant, h.request('still-ninth'), new AbortController().signal),
      { code: 'quota-exceeded' },
    );
    release.resolve();
    await physical.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const freed = await h.port.reserve(
      h.opened.grant,
      h.request('after-physical-drain'),
      new AbortController().signal,
    );
    permits.push(freed);
  } finally {
    release.resolve();
    cancel.abort();
    await uploading;
    for (const permit of permits) permit.releaseAfter(Promise.resolve());
    await Promise.all(permits.map((permit) => permit.drain));
    h.ctx.attachments.saveFileStream = save;
  }
});
