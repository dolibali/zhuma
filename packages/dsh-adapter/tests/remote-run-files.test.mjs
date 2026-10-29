/** Actual original backend/official attachment bytes; synthetic member and native reports only. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileHost, ok, no, deferred, sha } from './remote-run-files-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import {
  assertExecutionRunStoreCompatibility,
  prepareExecutionRunWriter,
} from '../dist/execution-run-protocol.js';

for (const expert of [false, true])
  test(`remote files ${expert ? 'expert' : 'human'}: reserve → original SDK upload → full ledger → original v2 artifact/round`, async (t) => {
    const h = await fileHost(t, { expert });
    await h.begin();
    const bytes = Buffer.from('Actual attachment stream bytes.');
    const selected = h.selector();
    const before = JSON.stringify(h.read());
    const absent = ok(await h.send(h.scopeBody('publish-file', { ...selected, mode: 'lookup' })));
    assert.equal(absent.status, 'absent');
    assert.deepEqual(h.counts, { saved: 0, read: 0 });
    assert.equal(JSON.stringify(h.read()), before);
    const { value: reserved } = await h.reserve(bytes);
    assert.equal(reserved.status, 'reserved');
    assert.equal('uploadId' in reserved, false);
    assert.equal(h.counts.saved, 0);
    const completed = ok(await h.publish(reserved, bytes));
    assert.equal(completed.status, 'completed');
    assert.equal(completed.record.producer.source.callId, 'publish');
    assert.equal(completed.record.attachmentId, `sha256:${sha(bytes)}`);
    assert.equal(h.counts.saved, 1);
    const full = ok(
      await h.send(h.scopeBody('file-status', { idempotencyKey: selected.idempotencyKey })),
    );
    assert.deepEqual(full, completed);
    const value = h.result(completed, selected);
    await h.complete(value);
    const receipt = ok(await h.submit(value));
    assert.equal(receipt.disposition, 'committed');
    assert.equal(
      h.counts.read,
      1,
      'original fixed submission re-verifies actual official attachment bytes',
    );
    assert.equal(h.read().artifactVersions.length, 1);
    assert.equal(h.read().rounds.length, 1);
    assert.deepEqual(h.read().artifactVersions[0].files, [completed.file]);
    assert.equal(h.read().artifactVersions[0].submittedBy, expert ? 'qa' : 'chen');
    const artifactQuery = {
      ...h.locate(),
      spaceId: 'north',
      uploadId: completed.uploadId,
      purpose: 'artifact',
      artifactVersionId: h.read().artifactVersions[0].id,
    };
    const readArtifact = (
      mode,
      patch = {},
      memberId = 'chen',
      signal = new AbortController().signal,
    ) =>
      h.service.fileContent(
        { member: { ok: true, memberId, spaceIds: ['north'] } },
        { ...artifactQuery, mode, ...patch },
        async () => ({
          lease: {
            memberId,
            expiresAt: Date.now() + 60_000,
            signal,
            assertCurrent() {},
            release() {},
          },
          assertProjectSpace(projectId, spaceId) {
            assert.equal(projectId, 'project');
            assert.equal(spaceId, 'north');
          },
        }),
      );
    const beforeRead = await businessHashes(join(h.root, 'service'));
    for (const mode of ['metadata', 'preview', 'download']) {
      const file = ok(await readArtifact(mode));
      assert.equal(file.info.name, 'result.txt');
      assert.equal(file.info.sha256, sha(bytes));
      assert.deepEqual(file.info.reference, completed.file);
      if (mode !== 'metadata') assert.deepEqual(Buffer.from(file.bytes), bytes);
      file.check();
      file.release();
    }
    for (const patch of [
      { uploadId: randomUUID() },
      { artifactVersionId: randomUUID() },
      { planId: 'foreign-plan' },
      { revision: artifactQuery.revision + 1 },
      { nodeId: 'parallel' },
      { spaceId: 'foreign-space' },
    ])
      no(await readArtifact('metadata', patch), 'not-found');
    no(await readArtifact('metadata', {}, 'outside'), 'not-found');
    no(await readArtifact('metadata', {}, 'chen', AbortSignal.abort()), 'cancelled');
    if (expert) {
      const workbench = h.readWorkbench();
      h.setWorkbench((current) => ({
        ...current,
        tasks: current.tasks.map((task) => ({ ...task, ownerId: 'outside' })),
      }));
      no(
        await readArtifact('metadata'),
        'not-found',
        'stale node owner is not the current controller',
      );
      h.setWorkbench(() => workbench);
      const get = h.service.fileStore.get.bind(h.service.fileStore);
      try {
        for (const patch of [
          { actorId: 'outside' },
          { nodeId: 'parallel' },
          { runId: 'foreign-run' },
        ]) {
          h.service.fileStore.get = (id) => {
            const record = get(id);
            if (id !== completed.uploadId) return record;
            return {
              ...record,
              producer: {
                ...record.producer,
                source: {
                  ...record.producer.source,
                  scope: { ...record.producer.source.scope, ...patch },
                },
              },
            };
          };
          no(await readArtifact('metadata'), 'not-found');
        }
      } finally {
        h.service.fileStore.get = get;
      }
    }
    assert.deepEqual(
      await businessHashes(join(h.root, 'service')),
      beforeRead,
      'authorized reads never change task/Run/artifact facts',
    );
    const repeated = ok(await h.submit(value));
    assert.deepEqual(repeated.receipt, receipt.receipt);
    assert.equal(h.counts.read, 3, 'receipt retry does not reread bytes or repeat delivery');
  });

test('remote files: original 13 operations remain advertised until the Host explicitly enables the stream port', async (t) => {
  const h = await fileHost(t, { enabled: false });
  const info = ok(await h.send(h.envelope('info', {})));
  assert.equal(info.operations.length, 13);
  assert.equal(info.operations.includes('publish-file'), false);
  await assert.rejects(() => h.begin(), /remote-protocol-unsupported/);
  assert.equal(currentExecutionRun(h.read()), undefined);
});

test('remote files: a lost reserve response replays the same handle; publication retry uses the actual completed receipt without rereading input', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('Idempotent output.');
  const first = await h.reserve(bytes);
  const second = await h.reserve(bytes);
  assert.deepEqual(second.value, first.value);
  const completed = ok(await h.publish(first.value, bytes));
  const repeated = ok(
    await h.publish(second.value, bytes, {
      signal: new AbortController().signal,
      data: (async function* () {
        assert.fail('completed publication retry must not read FS/network input');
      })(),
    }),
  );
  assert.deepEqual(repeated, completed);
  assert.equal(h.counts.saved, 1);
  const released = ok(
    await h.send(h.scopeBody('abandon-file', { reservationId: first.value.reservationId })),
  );
  assert.equal(released.status, 'released');
  assert.equal(h.service.fileStore.get(completed.uploadId).state, 'completed');
  const status = ok(
    await h.send(
      h.scopeBody('file-status', {
        source: first.selected.source,
        publicationId: completed.uploadId,
      }),
    ),
  );
  assert.deepEqual(status, completed);
});

test('remote files: cached handles cannot return a completed receipt when the original ledger is unavailable', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('original ledger is authoritative');
  const { value } = await h.reserve(bytes);
  const completed = ok(await h.publish(value, bytes));
  const store = h.service.fileStore,
    read = store.get.bind(store);
  store.get = (id) => (id === completed.uploadId ? undefined : read(id));
  try {
    no(
      await h.send(h.scopeBody('file-status', { reservationId: value.reservationId })),
      'remote-not-found',
    );
    no(
      await h.publish(value, bytes, {
        signal: new AbortController().signal,
        data: (async function* () {
          assert.fail('receipt retry cannot inspect input');
        })(),
      }),
      'remote-not-found',
    );
    assert.equal(h.counts.saved, 1);
  } finally {
    store.get = read;
  }
});

test('remote files: completing a Run joins the actual backend SDK drain outside the writer queue', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('Drain gate output.');
  const { selected, value: reserved } = await h.reserve(bytes);
  const completed = ok(await h.publish(reserved, bytes));
  // A real original reservation is retained; only its already-created SDK drain
  // is deliberately gated to test queue ordering, not invented release success.
  const manager = h.service.remoteRunAuthorities;
  const entry = manager.files.entries.get(reserved.reservationId);
  const original = entry.reservation;
  h.controls.drain = deferred();
  entry.reservation = {
    ...original,
    drain: Promise.all([original.drain, h.controls.drain.promise]).then(() => undefined),
  };
  const pending = h.complete(h.result(completed, selected));
  let ended = false;
  void pending.then(() => {
    ended = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const status = ok(await h.send(h.scopeBody('status')));
  assert.equal(status.resources, 'held');
  assert.equal(status.runStatus, 'running');
  assert.equal(ended, false, 'a control/SDK wait cannot pre-complete the Run');
  h.controls.drain.resolve();
  await pending;
  assert.equal(currentExecutionRun(h.read()).resources, 'settled');
});

test('remote files: scope/source tampering is refused before starting SDK IO', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const selected = h.selector();
  selected.source.nativeAgentId = 'borrowed-agent';
  const { hash } = await import('./remote-run-files-fixture.mjs');
  selected.idempotencyKey = `native-output_${hash(selected.source)}`;
  no(
    await h.send(h.scopeBody('publish-file', { ...selected, mode: 'reserve', maximumBytes: 5 })),
    'remote-scope-mismatch',
  );
  assert.equal(h.counts.saved, 0);
  assert.equal(h.service.pendingUploads.size, 0);
  assert.throws(
    () =>
      h.service.remoteRunAuthorities.assertFileGrant(
        {
          scope: selected.source.scope,
          remoteScope: h.view.scope,
          signal: new AbortController().signal,
          check: () => undefined,
          cancel() {},
        },
        'send',
      ),
    (error) => error.code === 'remote-forbidden',
  );
});

test('remote files: fixed submission rejects a byte-provider mismatch without creating an artifact or receipt', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('Original verified file.');
  const { selected, value } = await h.reserve(bytes);
  const completed = ok(await h.publish(value, bytes));
  const fixed = h.result(completed, selected);
  await h.complete(fixed);
  const before = JSON.stringify(h.read());
  h.attachments.readFileStream = async function* () {
    yield Buffer.alloc(bytes.byteLength);
  };
  no(await h.submit(fixed));
  assert.equal(JSON.stringify(h.read()), before);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.equal(currentExecutionRun(h.read()).remote.receipt, undefined);
});

test('remote files: wrong bytes never complete the ledger, and release leaves the original shared quota empty', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('expected bytes');
  const { value } = await h.reserve(bytes);
  const response = await h.publish(value, bytes, {
    signal: new AbortController().signal,
    data: (async function* () {
      yield Buffer.from('tampered bytes');
    })(),
  });
  no(response);
  assert.equal(h.service.fileStore.findByIdempotencyKey(value.idempotencyKey), undefined);
  assert.equal(h.service.pendingUploads.size, 1, 'failure alone is not the C FS/SDK drain');
  ok(await h.send(h.scopeBody('abandon-file', { reservationId: value.reservationId })));
  assert.equal(h.service.pendingUploads.size, 0);
});

test('remote files: a request admitted before the proof window expires can finish while fresh authorization remains valid', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('slow network body');
  const { value } = await h.reserve(bytes);
  const entered = deferred();
  h.controls.input = deferred();
  const pending = h.publish(value, bytes, {
    signal: new AbortController().signal,
    data: (async function* () {
      entered.resolve();
      await h.controls.input.promise;
      yield bytes;
    })(),
  });
  await entered.promise;
  h.service.remoteRunAuthorities.source.now = () => Date.now() + 31000;
  h.controls.input.resolve();
  const completed = ok(await pending);
  assert.equal(completed.record.sha256, sha(bytes));
  delete h.service.remoteRunAuthorities.source.now;
  ok(await h.send(h.scopeBody('abandon-file', { reservationId: value.reservationId })));
});

test('remote files: Stop and revoked-member cleanup cannot settle before a late real SDK operation drains', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('delayed SDK save');
  const { value } = await h.reserve(bytes);
  const entered = deferred();
  h.controls.drain = deferred();
  const save = h.attachments.saveFileStream.bind(h.attachments);
  h.attachments.saveFileStream = async (input) => {
    entered.resolve();
    await h.controls.drain.promise;
    return save(input);
  };
  const publishing = h.publish(value, bytes);
  await entered.promise;
  const status = ok(await h.send(h.scopeBody('status')));
  const stopped = ok(
    await h.send(
      h.envelope('stop', {
        scope: h.view.scope,
        expectedNodeVersion: status.nodeVersion,
        expectedRunVersion: status.runVersion,
      }),
    ),
  );
  assert.equal(stopped.resources, 'held');
  h.member.abort();
  const cleanup = h.envelope('cleanup', {
    scope: h.view.scope,
    permit: h.cleanup.public,
    observation: {
      kind: 'drained',
      sequence: status.nextSequence,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'file-native',
        nativeAgentId: 'file-agent',
      },
    },
  });
  const wrong = structuredClone(cleanup);
  wrong.proof.nonce = crypto.randomUUID();
  wrong.payload.observation.evidence.nativeAgentId = 'borrowed-agent';
  no(
    await h.send(wrong, { secret: h.cleanup.raw, request: { headers: {} } }),
    'remote-scope-mismatch',
  );
  assert.equal(h.service.pendingUploads.size, 1);
  const pending = h.send(cleanup, { secret: h.cleanup.raw, request: { headers: {} } });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(currentExecutionRun(h.read()).resources, 'held');
  assert.equal(h.service.pendingUploads.size, 1);
  h.controls.drain.resolve();
  no(await publishing);
  const cleaned = ok(await pending);
  assert.equal(cleaned.resources, 'settled');
  assert.equal(cleaned.runStatus, 'cancelled');
  assert.equal(h.service.pendingUploads.size, 0);
  assert.equal(h.service.fileStore.findByIdempotencyKey(value.idempotencyKey), undefined);
});

test('remote files: raw transport abort calls the actual reader return even with a pending next', async (t) => {
  const h = await fileHost(t);
  await h.begin();
  const bytes = Buffer.from('cancelled HTTP body');
  const { value } = await h.reserve(bytes);
  const entered = deferred(),
    input = deferred(),
    returned = deferred();
  const controller = new AbortController();
  const data = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      entered.resolve();
      return input.promise;
    },
    return() {
      returned.resolve();
      input.resolve({ done: true });
      return Promise.resolve({ done: true });
    },
  };
  const publishing = h.publish(value, bytes, { signal: controller.signal, data });
  await entered.promise;
  controller.abort();
  await returned.promise;
  no(await publishing);
  ok(await h.send(h.scopeBody('abandon-file', { reservationId: value.reservationId })));
  assert.equal(h.service.pendingUploads.size, 0);
});

test('remote files: first qualified file admission installs the barrier before its node, with safe marker-only retry after node failure', async (t) => {
  const h = await fileHost(t);
  assert.equal(h.domain.global.get().remoteExecutionFileWriter, undefined);
  h.resetCounts();
  await h.service.enableRemoteRuns({ fileUploads: true });
  ok(await h.send(h.envelope('info', {})));
  assert.deepEqual(
    h.counters,
    { global: 0, nodes: 0, plans: 0 },
    'configuration and reads do not migrate a text store',
  );
  no(await h.send(h.accept({ expectedNodeVersion: 10000 })), 'remote-conflict');
  assert.equal(h.domain.global.get().remoteExecutionFileWriter, undefined);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  const body = h.accept();
  h.faults.node = true;
  no(await h.send(body));
  assert.equal(h.domain.global.get().remoteExecutionFileWriter, 1);
  assert.equal(currentExecutionRun(h.read()), undefined);
  assert.equal(h.service.remoteRunAuthorities.active.size, 0, 'failure never grants drive');
  assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
  h.faults.node = false;
  const accepted = ok(await h.send(body));
  assert.equal(accepted.authority, 'drive');
  assert.equal(h.read().nativeExecution.runs.length, 1);
  assert.equal(currentExecutionRun(h.read()).remote.files, 'zhuma-native-output-file@1');
  assert.deepEqual(prepareExecutionRunWriter(h.domain.global.get()), h.domain.global.get());
  const replay = ok(await h.send(body));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(h.read().nativeExecution.runs.length, 1);
  const badGlobal = structuredClone(h.domain.global.get());
  delete badGlobal.remoteExecutionFileWriter;
  assert.throws(
    () => assertExecutionRunStoreCompatibility(badGlobal, [h.read()]),
    /不能用于本地运行/,
  );
});

test('remote files: lost node ACK remains one original Run with no replay drive; a new instance reads the actual completed record and commits only its sealed result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-file-reopen-'));
  let h, reopened;
  try {
    h = await fileHost(t, { root });
    const body = h.accept();
    let once = true;
    h.faults.afterNodeWrite = () => {
      if (once) {
        once = false;
        throw Error('CONTRACT_LOST_DURABLE_ACK');
      }
    };
    no(await h.send(body));
    assert.equal(h.service.remoteRunAuthorities.active.size, 0);
    const retry = ok(await h.send(body));
    assert.equal(retry.authority, 'recovery-required');
    assert.equal(h.read().nativeExecution.runs.length, 1);
    no(
      await h.send(h.envelope('renew', { scope: retry.scope, permit: h.drive.public })),
      'remote-recovery-required',
    );
    const cleaned = ok(
      await h.send(
        h.envelope('cleanup', {
          scope: retry.scope,
          permit: h.cleanup.public,
          observation: {
            kind: 'drained',
            sequence: retry.nextSequence,
            evidence: { basis: 'absent-unadmitted' },
          },
        }),
        { secret: h.cleanup.raw, request: { headers: {} } },
      ),
    );
    assert.equal(cleaned.resources, 'settled');
    delete h.faults.afterNodeWrite;
    // Restart the original cancelled node explicitly; the old request is never silently reaccepted.
    await h.begin({ mode: 'restart' });
    const bytes = Buffer.from('Durable original v2 metadata.');
    const { value, selected } = await h.reserve(bytes);
    const completed = ok(await h.publish(value, bytes));
    const fixed = h.result(completed, selected);
    await h.complete(fixed);
    const scope = h.view.scope,
      identity = h.identity;
    await h.close();
    const before = await businessHashes(root);
    reopened = await fileHost(t, { root, seed: false, identity });
    assert.deepEqual(
      await businessHashes(root),
      before,
      'new reader does not rewrite old metadata on open',
    );
    const readOnly = await reopened.openScope(scope);
    assert.notEqual(readOnly.authority, 'drive');
    const actual = ok(
      await reopened.send(
        reopened.scopeBody('file-status', { idempotencyKey: selected.idempotencyKey }),
      ),
    );
    assert.deepEqual(
      actual,
      completed,
      'producer, attachment ID and timestamp come from the original ledger',
    );
    assert.deepEqual(await businessHashes(root), before, 'status/file-status stay read-only');
    const recovered = await reopened.recover(scope);
    assert.equal(recovered.authority, 'commit-only');
    ok(await reopened.submit(fixed));
    assert.equal(reopened.read().artifactVersions.length, 1);
    assert.equal(
      reopened.read().nativeExecution.runs.length,
      2,
      'one explicitly cancelled attempt, one completed; no cold new Run',
    );
    assert.equal(reopened.counts.saved, 0);
  } finally {
    await reopened?.close();
    await h?.close();
    await rm(root, { recursive: true, force: true });
  }
});
