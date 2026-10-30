import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalPayload, REMOTE_TEAM_ASSET_FILE_METHOD } from '@zhuma/agent-core';
import { fixture } from './member-local-execution-protocol-fixture.mjs';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import {
  createVerifiedTeamAssetFile,
  readVerifiedTeamAssetText,
} from '../dist/team-asset-file-carrier.js';

// Actual outbound HTTP, original Ed25519 canonical proof, fixed composition and
// E's immutable carrier. Authentication/backend membership remain contracts;
// this is not a real two-Host/native/model business acceptance.
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bytes = Buffer.from('固定的团队资料\nversion one\n');
const reference = {
  spaceId: 'north',
  assetId: 'team-document',
  kind: 'file',
  versionId: randomUUID(),
  sha256: 'a'.repeat(64),
};
const file = {
  name: 'design.txt',
  mediaType: 'text/plain',
  byteSize: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const snapshot = {
  sourceVersion: 'zhuma-native-team-assets@1',
  spaceId: 'north',
  files: [{ reference, file }],
};
const teamAssets = { ...snapshot, sha256: hash(snapshot) };
const metadata = (value) => ({ scope: value.scope, reference, file });
function headers(rpcId, value) {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(file.byteSize),
    'x-zhuma-rpc-id': rpcId,
    'x-zhuma-run-scope-sha256': hash(value.scope),
    'x-zhuma-team-asset-reference': encodeURIComponent(JSON.stringify(reference)),
    'x-zhuma-team-asset-file': encodeURIComponent(JSON.stringify(file)),
  };
}
async function host(t, options = {}) {
  const h = await fixture(t, {
    teamAssets,
    teamAssetFile: ({ res, request, rpcId, respond, value }) => {
      assert.deepEqual(request.payload.reference, reference);
      if (request.payload.mode === 'check') {
        res.setHeader('content-type', 'application/json');
        respond({ ok: true, value: metadata(value) });
      } else {
        res.writeHead(200, headers(rpcId, value));
        res.end(bytes);
      }
    },
    ...options,
  });
  const owner = await h.open();
  t.after(() => owner.close());
  const run = await (await owner.prepareAccept(randomUUID(), h.input)).send();
  return { ...h, owner, run };
}

test('team asset private protocol: full fixed proof and fresh signed check feed the original immutable carrier', async (t) => {
  const h = await host(t),
    signal = new AbortController().signal;
  assert.equal(h.owner.assertTeamAssetFile(h.run, reference), undefined);
  const reading = h.owner.openTeamAssetFile(h.run, reference, signal);
  assert(reading.result instanceof Promise);
  assert(reading.drain instanceof Promise);
  const result = await reading.result;
  await reading.drain;
  assert.deepEqual(result.bytes, bytes);
  assert.deepEqual(result.reference, reference);
  assert.notEqual(
    result.reference.sha256,
    result.file.sha256,
    'publication and byte digests stay distinct',
  );
  const carrier = createVerifiedTeamAssetFile(result.file, result.bytes);
  result.bytes.fill(0);
  assert.equal(
    readVerifiedTeamAssetText(carrier, { offset: 0, length: 8192 }).text,
    bytes.toString(),
  );
  for (let i = 0; i < 2; i++) {
    const checking = h.owner.checkTeamAssetFile(h.run, reference, signal);
    assert.deepEqual(await checking.result, metadata(h.value()));
    await checking.drain;
  }
  const commands = h.seen.filter((v) => v.request.operation === 'team-asset-file');
  assert.deepEqual(
    commands.map((v) => v.request.payload.mode),
    ['read', 'check', 'check'],
  );
  assert.equal(new Set(commands.map((v) => v.request.proof.nonce)).size, 3);
  assert.equal(new Set(commands.map((v) => v.request.requestId)).size, 3);
});

test('team asset private protocol: forged/wrong fixed refs, old Runs, history and cold recovery never read', async (t) => {
  const h = await host(t),
    signal = new AbortController().signal;
  for (const bad of [
    { ...reference, spaceId: 'other' },
    { ...reference, assetId: 'other' },
    { ...reference, versionId: randomUUID() },
    { ...reference, sha256: 'b'.repeat(64) },
    { ...reference, kind: 'skill' },
    { ...reference, latest: true },
  ])
    assert.throws(() => h.owner.openTeamAssetFile(h.run, bad, signal), { code: 'local-mismatch' });
  assert.throws(() => h.owner.openTeamAssetFile(structuredClone(h.run), reference, signal), {
    code: 'local-mismatch',
  });
  const historical = await h.owner.history(h.run.value.scope);
  assert.throws(() => h.owner.checkTeamAssetFile(historical, reference, signal), {
    code: 'remote-recovery-required',
  });
  const recovered = await h.owner.recover({
    target: h.input.target,
    acceptRequestId: [...h.rows.values()].find((v) => v.drive).requestId,
  });
  assert.throws(() => h.owner.openTeamAssetFile(recovered, reference, signal), {
    code: 'remote-recovery-required',
  });
  assert.equal(
    h.seen.some((v) => v.request.operation === 'team-asset-file'),
    false,
  );
  const old = await fixture(t),
    owner = await old.open();
  t.after(() => owner.close());
  const run = await (await owner.prepareAccept(randomUUID(), old.input)).send();
  assert.throws(() => owner.openTeamAssetFile(run, reference, signal), { code: 'local-mismatch' });
});

test('team asset private protocol: server composition cannot silently add an unrequested asset capability', async (t) => {
  const h = await fixture(t, { teamAssets, omitTeamAssetCapability: true }),
    owner = await h.open();
  t.after(() => owner.close());
  await assert.rejects((await owner.prepareAccept(randomUUID(), h.input)).send(), {
    code: 'local-mismatch',
  });
});

test('team asset private protocol: private errors and check metadata mismatches fail closed without a download fallback', async (t) => {
  let error = 'remote-permit-revoked',
    wrong = false;
  const h = await host(t, {
    teamAssetFile: ({ res, respond, value }) => {
      res.setHeader('content-type', 'application/json');
      respond(
        error
          ? { ok: false, error: { code: error } }
          : {
              ok: true,
              value: {
                ...metadata(value),
                ...(wrong
                  ? { scope: { ...value.scope, generation: value.scope.generation + 1 } }
                  : {}),
              },
            },
      );
    },
  });
  for (const code of ['remote-permit-revoked', 'remote-device-unavailable', 'remote-forbidden']) {
    error = code;
    const operation = h.owner.checkTeamAssetFile(h.run, reference, new AbortController().signal);
    await assert.rejects(operation.result, { code });
    await operation.drain;
  }
  error = undefined;
  wrong = true;
  const mismatch = h.owner.checkTeamAssetFile(h.run, reference, new AbortController().signal);
  await assert.rejects(mismatch.result);
  await mismatch.drain;
  assert.equal(h.seen.filter((v) => v.request.operation === 'team-asset-file').length, 4);
});

test('team asset binary transport: each required identity header, file declaration and complete byte digest is verified', async (t) => {
  const mutations = [
    (h) => {
      delete h['x-zhuma-rpc-id'];
    },
    (h) => {
      h['x-zhuma-rpc-id'] = randomUUID();
    },
    (h) => {
      h['x-zhuma-run-scope-sha256'] = '0'.repeat(64);
    },
    (h) => {
      h['x-zhuma-team-asset-reference'] = encodeURIComponent(
        JSON.stringify({ ...reference, versionId: randomUUID() }),
      );
    },
    (h) => {
      h['x-zhuma-team-asset-file'] = encodeURIComponent(
        JSON.stringify({ ...file, name: 'other.txt' }),
      );
    },
    (h) => {
      h['content-length'] = String(file.byteSize + 1);
    },
    (h) => {
      h['content-type'] = 'application/json';
    },
    (h) => {
      h['content-encoding'] = 'gzip';
    },
    () => {},
  ];
  let mutation = mutations[0];
  const h = await host(t, {
    teamAssetFile: ({ res, rpcId, value }) => {
      const fields = headers(rpcId, value);
      mutation(fields);
      res.writeHead(200, fields);
      res.end(Buffer.alloc(bytes.length, 65));
    },
  });
  for (mutation of mutations) {
    const operation = h.owner.openTeamAssetFile(h.run, reference, new AbortController().signal);
    await assert.rejects(operation.result);
    await operation.drain;
  }
  assert.equal(
    h.seen.filter((v) => v.request.operation === 'team-asset-file').length,
    mutations.length,
  );
});

test('team asset private protocol: abort/stop/close retain a late authentication job and prevent late HTTP', async (t) => {
  for (const action of ['abort', 'stop', 'close']) {
    const entered = deferred(),
      release = deferred();
    const h = await host(t, {
      beforeAuthentication: async (_signal, context) => {
        if (context.method === REMOTE_TEAM_ASSET_FILE_METHOD) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const aborter = new AbortController(),
      operation = h.owner.openTeamAssetFile(h.run, reference, aborter.signal);
    const rejected = assert.rejects(operation.result);
    let drained = false;
    void operation.drain.then(() => {
      drained = true;
    });
    await entered.promise;
    let closed;
    if (action === 'abort') aborter.abort();
    if (action === 'stop')
      await h.owner.stop(h.run, {
        requestId: randomUUID(),
        expectedNodeVersion: 1,
        expectedRunVersion: 1,
      });
    if (action === 'close') closed = h.owner.close();
    await rejected;
    await tick();
    assert.equal(drained, false);
    assert.equal(h.owner.canSwitchBackend(), false);
    release.resolve();
    await operation.drain;
    await closed;
    assert.equal(drained, true);
    assert.equal(
      h.seen.some((v) => v.request.operation === 'team-asset-file'),
      false,
    );
    if (action === 'stop')
      assert.throws(() => h.owner.assertTeamAssetFile(h.run, reference), {
        code: 'remote-recovery-required',
      });
  }
});

test('team asset private protocol: connection identities cannot exchange issued Run handles', async (t) => {
  const h = await host(t),
    other = await MemberLocalExecutionProtocol.open({
      ...h.protocolOptions,
      secrets: new MemberLocalExecutionSecrets(h.store),
    });
  t.after(() => other.close());
  assert.throws(() => other.openTeamAssetFile(h.run, reference, new AbortController().signal), {
    code: 'local-mismatch',
  });
});

test('team asset binary transport: full EOS, no excess bytes and the bounded declaration are required', async (t) => {
  const h = await host(t),
    original = globalThis.fetch;
  let content = bytes.subarray(0, bytes.length - 1);
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (!String(url).endsWith(`/${REMOTE_TEAM_ASSET_FILE_METHOD}`)) return original(url, request);
    const envelope = JSON.parse(request.body);
    return new Response(content, { status: 200, headers: headers(envelope.rpcId, h.value()) });
  });
  for (content of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from('!')])]) {
    const operation = h.owner.openTeamAssetFile(h.run, reference, new AbortController().signal);
    await assert.rejects(operation.result, {
      code: content.length > bytes.length ? 'limit' : 'protocol',
    });
    await operation.drain;
  }
});

test('team asset binary transport: early cancellation cannot release a pending producer or its asynchronous cancel', async (t) => {
  const h = await host(t),
    entered = deferred(),
    cancelled = deferred(),
    release = deferred(),
    original = globalThis.fetch;
  let controller;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (!String(url).endsWith(`/${REMOTE_TEAM_ASSET_FILE_METHOD}`)) return original(url, request);
    const envelope = JSON.parse(request.body);
    // Explicitly uncooperative contract producer, not Node's actual HTTP abort.
    const stream = new ReadableStream(
      {
        start(value) {
          controller = value;
          entered.resolve();
        },
        cancel() {
          cancelled.resolve();
          return release.promise;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { headers: headers(envelope.rpcId, h.value()) });
  });
  const aborter = new AbortController(),
    operation = h.owner.openTeamAssetFile(h.run, reference, aborter.signal);
  let drained = false,
    closed = false;
  void operation.drain.then(() => {
    drained = true;
  });
  await entered.promise;
  await tick();
  aborter.abort();
  await assert.rejects(operation.result, { code: 'cancelled' });
  const closing = h.owner.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(drained, false);
  assert.equal(closed, false);
  controller.enqueue(bytes);
  await cancelled.promise;
  await tick();
  assert.equal(drained, false);
  assert.equal(closed, false);
  release.resolve();
  await operation.drain;
  await closing;
  assert.equal(drained, true);
  assert.equal(closed, true);
});

test('team asset private protocol: dedicated reads share the original outstanding transport budget', async (t) => {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const h = await host(t, {
    beforeAuthentication: async (_signal, context) => {
      if (context.method === REMOTE_TEAM_ASSET_FILE_METHOD) {
        if (++calls === 16) entered.resolve();
        await release.promise;
      }
    },
  });
  const aborter = new AbortController(),
    operations = Array.from({ length: 16 }, () =>
      h.owner.openTeamAssetFile(h.run, reference, aborter.signal),
    );
  const observed = Promise.all(
    operations.map((op) => assert.rejects(op.result, { code: 'cancelled' })),
  );
  await entered.promise;
  assert.throws(() => h.owner.openTeamAssetFile(h.run, reference, aborter.signal), {
    code: 'limit',
  });
  aborter.abort();
  await observed;
  assert.equal(h.owner.canSwitchBackend(), false);
  release.resolve();
  await Promise.all(operations.map((op) => op.drain));
  assert.equal(h.owner.canSwitchBackend(), true);
  assert.equal(
    h.seen.some((v) => v.request.operation === 'team-asset-file'),
    false,
  );
});
