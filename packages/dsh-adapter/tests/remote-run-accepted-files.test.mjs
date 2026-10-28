/** Actual original Service/JSON/official AttachmentLocal IO. Member and native reports
 * are explicit contracts; this does not certify C's SDK tool or A's two-Host HTTP. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPayload, nodeRecordKey } from '@zhuma/agent-core';
import { fileHost, ok, no, sha, deferred } from './remote-run-files-fixture.mjs';
import { caller, open } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { describeNativeAcceptedFileTool } from '../dist/native-work-session-files-tool.js';
import {
  executionRunGlobalSchema,
  assertExecutionRunStoreCompatibility,
  prepareExecutionRunWriter,
} from '../dist/execution-run-protocol.js';

async function acceptedInput(
  t,
  { expert = false, enabled = true, binary = false, tailInvalid = false } = {},
) {
  const h = await fileHost(t, { expertNode: expert ? 'consume' : undefined, enabled });
  const authority = async () => ({
    lease: await h.service.runHost.memberLease(h.request),
    assertProjectSpace: h.service.runHost.assertProjectSpace,
  });
  const upload = async (bytes, key) =>
    ok(
      await h.service.uploadFile(
        caller(),
        {
          ...h.locate(),
          spaceId: 'north',
          idempotencyKey: key,
          declare: {
            name: binary ? 'fixed.bin' : 'fixed.txt',
            mediaType: binary ? 'application/octet-stream' : 'text/plain',
            byteSize: bytes.length,
            sha256: sha(bytes),
          },
          data: (async function* () {
            yield bytes;
          })(),
        },
        await authority(),
      ),
    );
  const submit = async (file, key) =>
    ok(
      await h.service.submit(
        caller(),
        {
          ...h.human('produce', key),
          files: [file.reference],
          text: 'Fixed source content.',
        },
        authority,
      ),
    );
  const ballot = async (action, key) =>
    ok(
      await h.service.ballot(caller('outside'), {
        ...h.human('produce', key),
        roundId: h.read().currentRoundId,
        artifactVersionId: h.read().artifactVersions.at(-1).id,
        action,
        ...(action === 'request-changes' ? { comment: 'Replace the file.' } : {}),
      }),
    );
  const first = await upload(Buffer.from('Rejected V1 bytes.'), 'file-v1');
  await submit(first, 'source-v1');
  await ballot('request-changes', 'return-v1');
  const bytes = tailInvalid
    ? Buffer.concat([Buffer.alloc(40001, 65), Buffer.from([0xff])])
    : Buffer.from('Actual fixed accepted V2 text. '.repeat(1500));
  const second = await upload(bytes, 'file-v2');
  await submit(second, 'source-v2');
  await ballot('approve', 'approve-v2');
  assert.equal(h.read('consume').command.status, 'ready');
  const capabilities = {
    resultIntent: 'zhuma-native-result-intent@1',
    acceptedInput: '1',
    acceptedFile: 'zhuma-accepted-files@2',
    localTools: [],
  };
  const begin = (withFiles = true) =>
    h.begin(
      {
        workspace: { kind: 'text-only' },
        capabilities: withFiles ? capabilities : { ...capabilities, acceptedFile: undefined },
      },
      'consume',
    );
  const read = (slot, offset = 0, maximumBytes = 8192) =>
    h.send(h.scopeBody('input-read', { slotId: slot.slotId, offset, maximumBytes }));
  return {
    ...h,
    bytes,
    first,
    second,
    begin,
    readPage: read,
    get currentView() {
      return h.view;
    },
    scopeBody: h.scopeBody,
    getSlot() {
      return currentExecutionRun(h.read('consume')).remote.inputs.find(
        (slot) => slot.kind === 'file',
      );
    },
  };
}
const facts = (h) =>
  canonicalPayload({
    nodes: [...h.domain.table('nodes').entries()],
    global: h.domain.global.get(),
    files: [h.first, h.second].map((file) => h.service.fileStore.get(file.uploadId)),
  });

for (const expert of [false, true])
  test(`remote accepted files ${expert ? 'expert' : 'human'}: original fixed V2 catalog and actual bounded byte pages`, async (t) => {
    const h = await acceptedInput(t, { expert });
    const view = await h.begin();
    const run = currentExecutionRun(h.read('consume'));
    assert.equal(h.read('consume').handoff.assignee.kind, expert ? 'expert' : 'human');
    assert.equal(run.actorId, 'chen');
    assert.deepEqual(run.composition.payload.acceptedFileReader, describeNativeAcceptedFileTool());
    assert.equal(h.domain.global.get().remoteExecutionAcceptedFileWriter, 1);
    assert.equal(
      h.domain.global.get().remoteExecutionFileWriter,
      undefined,
      'reading files does not enable output writer',
    );
    const before = facts(h),
      reads = h.counts.read;
    const slots = ok(await h.send(h.scopeBody('input-list'))).items;
    const slot = slots.find((item) => item.kind === 'file');
    assert.equal(slots.length, 2);
    assert.equal(slot.fileId, h.second.uploadId);
    assert.equal(slot.artifactVersionId, h.read().acceptedArtifactVersionId);
    assert.equal(slot.resourceRef.id, run.composition.payload.contextRefs[0]);
    assert.equal(slot.resourceRef.version, h.read().acceptedArtifactVersionId);
    assert.equal(h.counts.read, reads, 'metadata does not read object bytes');
    assert(!JSON.stringify(slots).includes(h.first.uploadId));
    const pages = [];
    let offset = 0;
    while (offset < slot.byteSize) {
      const page = ok(await h.readPage(slot, offset, 65536));
      const bytes = Buffer.from(page.base64, 'base64');
      assert.equal(bytes.length, page.byteSize);
      assert(bytes.length <= 16_384, 'original reader page bound remains in force');
      assert.equal(page.sha256, sha(h.bytes));
      assert.equal(page.totalBytes, h.bytes.length);
      assert.deepEqual(page.scope, view.scope);
      offset += bytes.length;
      assert.equal(page.eof, offset === h.bytes.length);
      pages.push(bytes);
    }
    assert.deepEqual(Buffer.concat(pages), h.bytes);
    assert.equal(h.service.fileReadResources.size, 0);
    assert.equal(h.service.remoteRunAuthorities.inputReads.size, 0);
    assert.equal(facts(h), before, 'catalog/read are fact-store read only');
  });

test('remote accepted files: capability remains opt-in; old text snapshot and human download authorization stay intact', async (t) => {
  const h = await acceptedInput(t, { expert: true });
  await h.begin(false);
  assert.equal(ok(await h.send(h.scopeBody('input-list'))).items.length, 1);
  assert.equal(h.domain.global.get().remoteExecutionAcceptedFileWriter, undefined);
  const before = h.counts.read;
  no(await h.readPage({ slotId: 'unissued-file-slot' }), 'remote-input-stale');
  assert.equal(h.counts.read, before);
  const human = await h.service.fileContent(
    caller(),
    {
      ...h.locate('consume'),
      spaceId: 'north',
      purpose: 'upstream',
      sourceNodeId: 'produce',
      artifactVersionId: h.read().acceptedArtifactVersionId,
      fileId: h.second.uploadId,
    },
    await (async () => ({
      lease: await h.service.runHost.memberLease(h.request),
      assertProjectSpace: h.service.runHost.assertProjectSpace,
    }))(),
  );
  assert.equal(human.ok, false, 'an expert-assigned node does not acquire human GET permission');
});

test('remote accepted files: disabled actual port rejects before format write or Run admission', async (t) => {
  const h = await acceptedInput(t, { enabled: false });
  const before = facts(h);
  await assert.rejects(h.begin(), /remote-protocol-unsupported/);
  assert.equal(facts(h), before);
  assert.equal(currentExecutionRun(h.read('consume')), undefined);
});

test('remote accepted files: full scope, device and private permit checked before SDK reads; structural grants rejected', async (t) => {
  const h = await acceptedInput(t, { expert: true });
  await h.begin();
  const slot = h.getSlot(),
    reads = h.counts.read,
    before = facts(h);
  const request = () =>
    h.scopeBody('input-read', { slotId: slot.slotId, offset: 0, maximumBytes: 10 });
  no(await h.send(request(), { secret: h.cleanup.raw }), 'remote-permit-revoked');
  const scope = structuredClone(request());
  scope.payload.scope.actorId = 'outside';
  no(await h.send(scope), 'remote-scope-mismatch');
  no(await h.send({ ...request(), deviceId: randomUUID() }), 'remote-device-mismatch');
  const issuer = h.service.remoteRunAuthorities;
  const forged = {
    scope: h.currentView.scope,
    signal: new AbortController().signal,
    check() {},
    cancel() {},
  };
  assert.throws(() => issuer.assertFileGrant(forged, 'send'));
  const port = issuer.source.acceptedFiles(issuer);
  await assert.rejects(
    port.read(
      forged,
      { inputRef: slot.resourceRef.id, fileId: slot.fileId, offset: 0, length: 4 },
      forged.signal,
    ),
  );
  assert.throws(() =>
    h.service.createRunAcceptedFiles(issuer, { signal: forged.signal, assertCurrent() {} }),
  );
  assert.equal(h.counts.read, reads);
  assert.equal(facts(h), before);
});

test('remote accepted files: replaced accepted version and missing fixed ledger entry reject without SDK IO', async (t) => {
  const h = await acceptedInput(t);
  await h.begin();
  const slot = h.getSlot(),
    original = h.read(),
    table = h.domain.table('nodes'),
    reads = h.counts.read;
  await table.put(nodeRecordKey(original), { ...original, acceptedArtifactVersionId: 'replaced' });
  no(await h.readPage(slot), 'remote-input-stale');
  await table.put(nodeRecordKey(original), original);
  const store = h.service.fileStore,
    get = store.get.bind(store);
  store.get = (id) => (id === slot.fileId ? undefined : get(id));
  no(await h.readPage(slot), 'remote-input-stale');
  store.get = get;
  assert.equal(h.counts.read, reads);
});

test('remote accepted files: actual corrupt SDK object cannot expose a prefix', async (t) => {
  const h = await acceptedInput(t);
  await h.begin();
  const slot = h.getSlot(),
    record = h.service.fileStore.get(slot.fileId);
  const path = join(
    h.root,
    'attachment-home',
    'attachments',
    'v1',
    'files',
    record.sha256.slice(0, 2),
    record.sha256,
    record.name,
  );
  await rm(path);
  await writeFile(path, Buffer.alloc(record.byteSize, 7));
  const before = facts(h);
  no(await h.readPage(slot, 0, 1));
  assert.equal(facts(h), before);
  assert.equal(h.service.fileReadResources.size, 0);
});

for (const action of ['stop', 'revoke'])
  test(`remote accepted files: ${action} aborts pending physical read; cleanup joins SDK drain outside writer queue`, async (t) => {
    const h = await acceptedInput(t);
    await h.begin();
    const slot = h.getSlot(),
      entered = deferred(),
      input = deferred(),
      drain = deferred();
    h.controls.input = input;
    h.controls.drain = drain;
    const original = h.attachments.readFileStream.bind(h.attachments);
    let returned = 0;
    h.attachments.readFileStream = () => ({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        entered.resolve();
        await input.promise;
        return { value: h.bytes, done: false };
      },
      async return() {
        returned++;
        await drain.promise;
        return { done: true };
      },
    });
    let readDone = false;
    const reading = h.readPage(slot).then((result) => {
      readDone = true;
      return result;
    });
    await entered.promise;
    const scope = h.currentView.scope;
    if (action === 'stop') {
      const current = ok(await h.send(h.scopeBody('status')));
      const stopped = ok(
        await h.send(
          h.envelope('stop', {
            scope,
            expectedNodeVersion: current.nodeVersion,
            expectedRunVersion: current.runVersion,
          }),
        ),
      );
      assert.equal(stopped.resources, 'held');
    } else h.member.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert(returned > 0, 'original SDK reader is asked to retire even with next pending');
    assert.equal(readDone, false);
    let cleanupDone = false;
    const cleanup = h
      .send(
        h.envelope('cleanup', {
          scope,
          permit: h.cleanup.public,
          observation: {
            kind: 'drained',
            sequence: currentExecutionRun(h.read('consume')).attempt.lastEventSequence + 1,
            evidence: {
              basis: 'flushed-and-closed',
              nativeSessionId: 'file-native',
              nativeAgentId: 'file-agent',
            },
          },
        }),
        { secret: h.cleanup.raw, request: { headers: {} } },
      )
      .then((result) => {
        cleanupDone = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupDone, false);
    assert.equal(currentExecutionRun(h.read('consume')).resources, 'held');
    // Actual original queue remains usable while its SDK resource is still held.
    assert.equal(
      h.service.remoteRunAuthorities.source.readGlobal().remoteExecutionAcceptedFileWriter,
      1,
    );
    await h.service.remoteRunAuthorities.source.enqueue(async () => undefined);
    input.resolve();
    drain.resolve();
    no(await reading);
    assert.equal(ok(await cleanup).resources, 'settled');
    assert.equal(h.service.fileReadResources.size, 0);
    h.attachments.readFileStream = original;
  });

test('remote accepted-file format: preserved marker and missing/unsupported barrier fail closed', async (t) => {
  const h = await acceptedInput(t);
  await h.begin();
  const global = h.domain.global.get();
  assert.equal(prepareExecutionRunWriter(global).remoteExecutionAcceptedFileWriter, 1);
  for (const change of [
    { remoteExecutionAcceptedFileWriter: undefined },
    { remoteExecutionAcceptedFileWriter: 2 },
  ])
    assert.throws(() =>
      assertExecutionRunStoreCompatibility({ ...global, ...change }, [h.read('consume')]),
    );
});

test('remote cleanup: real closed local scope before first ACK retires seq0 without fabricating native identity or artifacts', async (t) => {
  const h = await fileHost(t);
  const view = ok(await h.send(h.accept()));
  assert.equal(view.nextSequence, 1);
  const cleanup = () =>
    h.envelope('cleanup', {
      scope: view.scope,
      permit: h.cleanup.public,
      observation: {
        sequence: 1,
        kind: 'drained',
        evidence: {
          basis: 'flushed-and-closed',
          nativeSessionId: 'real-local-session-closed-before-ack',
          nativeAgentId: 'real-local-session-closed-before-ack',
        },
      },
    });
  const before = canonicalPayload(h.read());
  no(
    await h.send(cleanup(), { secret: h.drive.raw, request: { headers: {} } }),
    'remote-permit-revoked',
  );
  const wrong = structuredClone(cleanup());
  wrong.payload.scope.segmentId = 'another-segment';
  no(
    await h.send(wrong, { secret: h.cleanup.raw, request: { headers: {} } }),
    'remote-scope-mismatch',
  );
  assert.equal(canonicalPayload(h.read()), before);
  const body = cleanup();
  const retired = ok(await h.send(body, { secret: h.cleanup.raw, request: { headers: {} } }));
  assert.equal(retired.resources, 'settled');
  assert.equal(retired.authority, 'cleanup-only');
  const run = currentExecutionRun(h.read());
  assert.equal(run.attempt.status, 'cancelled');
  assert.equal(run.attempt.sessionId, undefined);
  assert.equal(run.attempt.executorRunId, undefined);
  assert.equal(run.attempt.acknowledged, false);
  assert.equal(h.read().nativeExecution.runs.length, 1);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.equal(h.read().rounds.length, 0);
  assert.equal(
    ok(await h.send(body, { secret: h.cleanup.raw, request: { headers: {} } })).disposition,
    'replayed',
  );
});

test('remote cleanup: received native identity continues to reject a foreign close report', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const body = h.envelope('cleanup', {
    scope: h.view.scope,
    permit: h.cleanup.public,
    observation: {
      kind: 'drained',
      sequence: h.view.nextSequence,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'foreign-session',
        nativeAgentId: 'foreign-agent',
      },
    },
  });
  const before = canonicalPayload(h.read());
  no(
    await h.send(body, { secret: h.cleanup.raw, request: { headers: {} } }),
    'remote-scope-mismatch',
  );
  assert.equal(canonicalPayload(h.read()), before);
  assert.equal(currentExecutionRun(h.read()).resources, 'held');
});

test('remote accepted files: actual pre-reader Domain decoder and disabled Host fail closed with zero business writes', async (t) => {
  const h = await acceptedInput(t);
  await h.begin();
  const scope = h.currentView.scope;
  await h.close();
  const before = await businessHashes(h.root);
  const ctx = new Context(),
    fibers = [];
  try {
    for (const [plugin, options] of [
      [Storage],
      [JsonStorage, { root: join(h.root, 'service') }],
      [Domain, { backend: 'json' }],
    ]) {
      const fiber = ctx.plugin(plugin, options);
      fibers.push(fiber);
      await fiber;
    }
    const oldGlobal = z.strictObject(
      Object.fromEntries(
        Object.entries(executionRunGlobalSchema.shape).filter(
          ([key]) => key !== 'remoteExecutionAcceptedFileWriter',
        ),
      ),
    );
    await assert.rejects(
      ctx.storageDomain.open({
        name: 'zhuma_execution',
        version: 1,
        global: { schema: oldGlobal, initial: { schemaVersion: 1 } },
        tables: {
          nodes: { valueSchema: z.unknown() },
          plans: { valueSchema: z.unknown() },
          workspace_approvals: { valueSchema: z.unknown() },
        },
      }),
    );
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
  assert.deepEqual(await businessHashes(h.root), before);
  const disabled = await open(join(h.root, 'service'), { seed: false });
  try {
    disabled.resetCounts();
    await assert.rejects(
      disabled.service.enableRemoteRuns(),
      (error) => error.code === 'remote-protocol-unsupported',
    );
    assert.deepEqual(disabled.counters, { global: 0, nodes: 0, plans: 0 });
  } finally {
    await disabled.close();
  }
  assert.deepEqual(await businessHashes(h.root), before);
  const resumed = await fileHost(t, { root: h.root, seed: false, identity: h.identity });
  const view = await resumed.recover(scope);
  assert.equal(view.authority, 'recovery-required');
  const slot = view.shared.inputs.find((item) => item.kind === 'file');
  assert.equal(slot.fileId, h.second.uploadId);
  no(
    await resumed.send(
      resumed.scopeBody('input-read', { slotId: slot.slotId, offset: 0, maximumBytes: 8192 }),
    ),
    'remote-permit-expired',
  );
  assert.equal(resumed.counts.read, 0, 'a durable file catalog is not reopened drive authority');
  await resumed.close();
});

for (const mode of ['binary', 'tailInvalid'])
  test(`remote accepted files: whole-object ${mode} cannot expose an apparently text prefix`, async (t) => {
    const h = await acceptedInput(t, { [mode]: true });
    await h.begin();
    const slot = h.getSlot(),
      before = facts(h);
    assert(slot, 'unsupported object remains visible as fixed file metadata');
    assert.equal(
      ok(await h.send(h.scopeBody('input-list'))).items.find((item) => item.kind === 'file').fileId,
      slot.fileId,
    );
    no(await h.readPage(slot, 0, 1), 'remote-protocol-unsupported');
    assert.equal(facts(h), before);
    assert.equal(h.service.fileReadResources.size, 0);
    assert.equal(h.service.remoteRunAuthorities.inputReads.size, 0);
  });

test('remote accepted files: five-second read deadline aborts SDK IO but waits for physical drain and never settles the Run', async (t) => {
  const h = await acceptedInput(t);
  await h.begin();
  const input = deferred(),
    drain = deferred(),
    entered = deferred(),
    returned = deferred();
  h.controls.input = input;
  h.controls.drain = drain;
  h.attachments.readFileStream = () => ({
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      entered.resolve();
      await input.promise;
      return { done: true };
    },
    async return() {
      returned.resolve();
      await drain.promise;
      return { done: true };
    },
  });
  let finished = false;
  const reading = h.readPage(h.getSlot()).then((value) => {
    finished = true;
    return value;
  });
  await entered.promise;
  await returned.promise;
  assert.equal(finished, false, 'the five-second timeout is not a physical-drain receipt');
  assert.equal(currentExecutionRun(h.read('consume')).resources, 'held');
  await h.service.remoteRunAuthorities.source.enqueue(async () => undefined);
  input.resolve();
  drain.resolve();
  no(await reading);
  assert.equal(h.service.fileReadResources.size, 0);
  assert.equal(h.service.remoteRunAuthorities.inputReads.size, 0);
  assert.equal(currentExecutionRun(h.read('consume')).resources, 'held');
});
