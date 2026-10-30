/** Host factory contracts with C's actual HTTP/signing protocol. Backend member
 * authority and native grant remain explicit fixtures, not GUI/model proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { fixture } from './member-local-execution-protocol-fixture.mjs';
import { createHostMemberNativeTeamAssets } from '../dist/host-member-native-team-assets.js';
import { readVerifiedTeamAssetText } from '../dist/team-asset-file-carrier.js';
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const bytes = Buffer.from('团队固定参考资料\nFirst published version\n');
const reference = {
  spaceId: 'north',
  assetId: 'reference-file',
  kind: 'file',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
};
const file = {
  name: 'reference.txt',
  mediaType: 'text/plain',
  byteSize: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const source = {
  sourceVersion: 'zhuma-native-team-assets@1',
  spaceId: 'north',
  files: [{ reference, file }],
};
const tick = () => new Promise(setImmediate);
function bindingFor(run) {
  const { backendId: _backend, ...scope } = run.value.scope;
  return {
    schemaVersion: 1,
    scope,
    nativeSessionId: randomUUID(),
    nativeAgentId: randomUUID(),
    selection: run.value.selection,
    receipts: [],
  };
}
async function setup(t) {
  let denied = false,
    local = true,
    currentCalls = 0;
  const h = await fixture(t, {
    teamAssets: { ...source, sha256: hash(source) },
    teamAssetFile({ res, request, rpcId, respond, value }) {
      if (denied) {
        res.setHeader('content-type', 'application/json');
        respond({ ok: false, error: { code: 'remote-permit-revoked' } });
      } else if (request.payload.mode === 'check') {
        res.setHeader('content-type', 'application/json');
        respond({ ok: true, value: { scope: value.scope, reference, file } });
      } else {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-zhuma-rpc-id': rpcId,
          'x-zhuma-run-scope-sha256': hash(value.scope),
          'x-zhuma-team-asset-reference': encodeURIComponent(JSON.stringify(reference)),
          'x-zhuma-team-asset-file': encodeURIComponent(JSON.stringify(file)),
        });
        res.end(bytes);
      }
    },
  });
  const protocol = await h.open();
  t.after(() => protocol.close());
  const run = await (await protocol.prepareAccept(randomUUID(), h.input)).send(),
    binding = bindingFor(run),
    grant = {
      scope: binding.scope,
      signal: new AbortController().signal,
      assertCurrent() {
        assert(local);
      },
    },
    factory = createHostMemberNativeTeamAssets({
      protocol,
      lifetime: new AbortController().signal,
      admit(signal) {
        signal.throwIfAborted();
        assert(local);
      },
      async current(signal) {
        signal.throwIfAborted();
        currentCalls++;
        assert(local);
      },
    });
  t.after(() => factory.close());
  const ports = factory.create(binding, grant, run);
  return {
    ...h,
    run,
    binding,
    grant,
    protocol,
    factory,
    ports,
    deny() {
      denied = true;
    },
    revokeLocal() {
      local = false;
    },
    currentCalls: () => currentCalls,
  };
}
test('native team file factory uses the issued fixed Run, performs no eager IO and rechecks cached bytes before reuse', async (t) => {
  const h = await setup(t),
    signal = new AbortController().signal;
  assert.equal(h.currentCalls(), 0);
  assert.equal(
    h.seen.some(({ request }) => request.operation === 'team-asset-file'),
    false,
  );
  assert.equal(h.ports.catalog.files, h.run.composition.payload.teamAssets.files);
  assert.throws(() => h.factory.create(h.binding, h.grant, structuredClone(h.run)), {
    code: 'local-mismatch',
  });
  await h.ports.assertCurrent(signal);
  const firstRead = h.ports.openFile(reference, signal),
    first = await firstRead.result;
  await firstRead.drain;
  assert.equal('bytes' in first, false);
  assert.equal(
    readVerifiedTeamAssetText(first.carrier, { offset: 0, length: 8192 }).text,
    bytes.toString(),
  );
  first.release();
  const secondRead = h.ports.openFile(reference, signal),
    second = await secondRead.result;
  await secondRead.drain;
  assert.equal(second.carrier, first.carrier);
  await h.ports.assertCurrent(signal, reference);
  assert.deepEqual(
    h.seen
      .filter(({ request }) => request.operation === 'team-asset-file')
      .map(({ request }) => request.payload.mode),
    ['read', 'check', 'check'],
  );
  h.deny();
  const denied = h.ports.openFile(reference, signal);
  await assert.rejects(denied.result, { code: 'remote-permit-revoked' });
  await denied.drain;
  await assert.rejects(h.ports.assertCurrent(signal, reference), { code: 'remote-permit-revoked' });
  second.release();
  assert.equal(
    h.seen.filter(
      ({ request }) => request.operation === 'team-asset-file' && request.payload.mode === 'read',
    ).length,
    1,
  );
});
test('native team file factory rejects altered references, history handles, changed local grants and synchronously fences old leases', async (t) => {
  const h = await setup(t),
    signal = new AbortController().signal;
  assert.throws(() => h.ports.openFile({ ...reference, versionId: randomUUID() }, signal), {
    code: 'local-mismatch',
  });
  const historical = await h.protocol.history(h.run.value.scope);
  assert.throws(() => h.factory.create(h.binding, h.grant, historical));
  const op = h.ports.openFile(reference, signal),
    handle = await op.result;
  await op.drain;
  h.revokeLocal();
  assert.throws(() => handle.check());
  assert.throws(() => h.ports.openFile(reference, signal));
  h.factory.fence();
  assert.equal(h.ports.signal.aborted, true);
  assert.throws(() => handle.check());
  handle.release();
  handle.release();
});

// Cache-size and physical settlement are isolated producer contracts. These
// structural fixtures grant no production protocol or member authority.
function producer(t, sizes, options = {}) {
  const controller = new AbortController(),
    scope = {
      actorId: 'ann',
      spaceId: 'north',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      runId: 'run',
      generation: 1,
      segmentId: 'segment',
    },
    rows = sizes.map((size, index) => {
      const data = Buffer.alloc(size, 65 + index);
      return {
        data,
        reference: { ...reference, assetId: String(index), versionId: randomUUID() },
        file: { ...file, byteSize: size, sha256: createHash('sha256').update(data).digest('hex') },
      };
    }),
    run = {
      value: {
        scope: { backendId: 'backend', ...scope },
        selection: { configurationId: 'configuration' },
      },
      composition: {
        schemaVersion: 2,
        payload: {
          scope,
          teamAssets: { files: rows.map(({ reference, file }) => ({ reference, file })) },
          teamAssetTool: {},
        },
      },
    },
    binding = bindingFor(run),
    grant = {
      scope,
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
      },
    };
  let reads = 0;
  const protocol = {
      assertReadBinding(actual) {
        assert.equal(actual, run);
      },
      assertTeamAssetFile(actual, ref) {
        assert.equal(actual, run);
        assert(rows.some((row) => canonicalPayload(row.reference) === canonicalPayload(ref)));
      },
      async status() {
        return { authority: 'drive', resources: 'held', stopRequested: false };
      },
      checkTeamAssetFile() {
        return { result: Promise.resolve(), drain: Promise.resolve() };
      },
      openTeamAssetFile(_run, ref, signal) {
        reads++;
        const row = rows.find((row) => row.reference.assetId === ref.assetId);
        return (
          options.open?.({ row, signal }) ?? {
            result: Promise.resolve({ file: row.file, bytes: row.data }),
            drain: Promise.resolve(),
          }
        );
      },
    },
    factory = createHostMemberNativeTeamAssets({
      protocol,
      lifetime: controller.signal,
      admit(signal) {
        signal.throwIfAborted();
      },
      current: async () => {},
    }),
    ports = factory.create(binding, grant, run);
  if (!options.manualClose) t.after(() => factory.close());
  return { ports, rows, factory, reads: () => reads };
}
test('native team file cache is bounded across pinned bytes and concurrent fresh checks; released entries may be evicted', async (t) => {
  const h = producer(t, [12 * 1024 * 1024, 12 * 1024 * 1024]),
    signal = new AbortController().signal;
  const firstOp = h.ports.openFile(h.rows[0].reference, signal),
    first = await firstOp.result;
  await firstOp.drain;
  const refused = h.ports.openFile(h.rows[1].reference, signal);
  await assert.rejects(refused.result, { code: 'run-capacity' });
  await refused.drain;
  assert.equal(h.reads(), 1);
  first.release();
  const secondOp = h.ports.openFile(h.rows[1].reference, signal),
    second = await secondOp.result;
  await secondOp.drain;
  second.release();
  const reloaded = h.ports.openFile(h.rows[0].reference, signal),
    again = await reloaded.result;
  await reloaded.drain;
  again.release();
  assert.equal(h.reads(), 3);
});
test('a cached carrier stays pinned while its fresh signed check is pending', async (t) => {
  const held = Promise.withResolvers(),
    h = producer(t, [12 * 1024 * 1024, 12 * 1024 * 1024], {
      check: () => ({ result: held.promise, drain: held.promise }),
    }),
    signal = new AbortController().signal;
  const first = h.ports.openFile(h.rows[0].reference, signal),
    handle = await first.result;
  await first.drain;
  handle.release();
  const cached = h.ports.openFile(h.rows[0].reference, signal);
  await tick();
  const competing = h.ports.openFile(h.rows[1].reference, signal);
  await assert.rejects(competing.result, { code: 'run-capacity' });
  await competing.drain;
  held.resolve();
  const same = await cached.result;
  await cached.drain;
  assert.equal(same.carrier, handle.carrier);
  same.release();
  assert.equal(h.reads(), 1);
});

test('native team file factory close waits for actual producer drain after cancellation and rejects failed physical settlement', async (t) => {
  const bytesReady = Promise.withResolvers(),
    actualDrain = Promise.withResolvers(),
    h = producer(t, [4], {
      manualClose: true,
      open: () => ({ result: bytesReady.promise, drain: actualDrain.promise }),
    }),
    signal = new AbortController().signal,
    operation = h.ports.openFile(h.rows[0].reference, signal);
  await tick();
  h.factory.fence();
  let closed = false;
  const closing = h.factory.close().then(() => {
    closed = true;
  });
  bytesReady.resolve({ file: h.rows[0].file, bytes: h.rows[0].data });
  await assert.rejects(operation.result);
  await tick();
  assert.equal(closed, false);
  actualDrain.resolve();
  await operation.drain;
  await closing;
  assert.equal(closed, true);
  const rejected = producer(t, [4], {
    manualClose: true,
    open: ({ row }) => ({
      result: Promise.resolve({ file: row.file, bytes: row.data }),
      drain: Promise.reject(Error('producer did not settle')),
    }),
  });
  const failing = rejected.ports.openFile(rejected.rows[0].reference, signal),
    handle = await failing.result;
  await assert.rejects(failing.drain, /producer did not settle/);
  handle.release();
  await assert.rejects(rejected.factory.close(), { code: 'run-authority-unavailable' });
});
