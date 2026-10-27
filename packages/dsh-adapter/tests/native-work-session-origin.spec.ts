/** Real native metadata/lifecycle observations; member and Run grants remain contracts. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  boot,
  grant,
  message,
  ScriptedAdapter,
  response,
  migrationGrant,
} from './zhuma-native-work-bundle.ts';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-origin-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
function query(binding) {
  return {
    requestId: 'origin-migration-3',
    inputFingerprint: 'c'.repeat(64),
    scope: {
      ...binding.scope,
      runId: 'run-3',
      generation: binding.scope.generation + 2,
      segmentId: 'segment-3',
    },
    selection: binding.selection,
  };
}
function observeWithoutNativeIO(host, input) {
  const persistence = host.ctx.sessionPersistence;
  const open = persistence.open,
    stat = persistence.stat;
  const operations = ['connect', 'flush', 'retire', 'stop', 'disconnect'];
  const originals = operations.map((name) => host.runtime[name]);
  const unexpected = () => {
    throw Error('origin attempted native I/O or cleanup');
  };
  for (const name of operations) host.runtime[name] = unexpected;
  persistence.open = persistence.stat = () => {
    throw Error('origin attempted native I/O');
  };
  try {
    return host.service.migrationOrigin(input);
  } finally {
    persistence.open = open;
    persistence.stat = stat;
    operations.forEach((name, index) => {
      host.runtime[name] = originals[index];
    });
  }
}

test('actual native origin: skipped unbound Runs and cold committed replay use the original binding/receipt with zero native I/O', async (t) => {
  const root = await home(t),
    old = grant();
  let host = await boot(root, new ScriptedAdapter([]));
  await host.service.send(old, message('old', 'OLD-PRIVATE-QUEUE', 'queue'));
  const binding = host.service.open(old).binding,
    input = query(binding);
  input.selection = { ...binding.selection, model: 'new-model', configurationId: 'new-config' };
  const file = join(root, 'domains', 'zhuma_native_work_sessions.json');
  let bytes = await readFile(file);
  assert.deepEqual(observeWithoutNativeIO(host, input), {
    scope: binding.scope,
    selection: binding.selection,
  });
  assert.deepEqual(await readFile(file), bytes);
  const moved = await host.service.migrate(
    migrationGrant(host.service, binding.scope, binding.selection, input),
  );
  assert.equal(moved.status, 'migrated');
  assert.equal(moved.next.scope.generation, old.scope.generation + 2);
  assert.equal(await host.ctx.sessionPersistence.stat(moved.next.nativeSessionId), undefined);
  bytes = await readFile(file);
  assert.deepEqual(observeWithoutNativeIO(host, input), {
    scope: binding.scope,
    selection: binding.selection,
  });
  assert.deepEqual(await readFile(file), bytes);
  await host.close();
  host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  assert.deepEqual(observeWithoutNativeIO(host, input), {
    scope: binding.scope,
    selection: binding.selection,
  });
  assert.deepEqual(await readFile(file), bytes);
  assert.throws(
    () => observeWithoutNativeIO(host, { ...input, inputFingerprint: 'f'.repeat(64) }),
    { code: 'idempotency-mismatch' },
  );
  assert.throws(() => observeWithoutNativeIO(host, { ...input, requestId: 'different-key' }), {
    code: 'scope-mismatch',
  });
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native origin: running native work refuses without another model call or metadata write', async (t) => {
  const root = await home(t),
    old = grant();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const host = await boot(
    root,
    new ScriptedAdapter([
      async function* () {
        entered.resolve();
        await release.promise;
        yield* response('done');
      },
    ]),
  );
  t.onTestFinished(() => host.close());
  t.onTestFinished(() => release.resolve());
  await host.service.send(old, message('old', 'active native work'));
  await entered.promise;
  const binding = host.service.open(old).binding;
  const bytes = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
  assert.throws(() => observeWithoutNativeIO(host, query(binding)), { code: 'unavailable' });
  assert.deepEqual(await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')), bytes);
  assert.equal(host.adapter.requests.length, 1);
  release.resolve();
  await host.ctx.agents.get(binding.nativeSessionId).whenIdle();
});

test('actual native origin: a foreign runtime restore refuses instead of reporting a cold origin', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('old', 'parked', 'queue'));
  const binding = host.service.open(old).binding,
    input = query(binding);
  await host.service.migrate(migrationGrant(host.service, binding.scope, binding.selection, input));
  const other = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => other.close());
  await other.runtime.connect(binding, old, false);
  const bytes = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
  assert.throws(() => observeWithoutNativeIO(host, input), { code: 'unavailable' });
  assert.deepEqual(await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')), bytes);
  assert.equal(host.adapter.requests.length + other.adapter.requests.length, 0);
});

test('actual native origin: failed writer close refuses without retrying or opening another writer', async (t) => {
  const root = await home(t),
    old = grant();
  let host = await boot(root, new ScriptedAdapter([]));
  await host.service.send(old, message('old', 'parked', 'queue'));
  const binding = host.service.open(old).binding,
    input = query(binding);
  await host.close();
  host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
  let opens = 0,
    closes = 0;
  host.ctx.sessionPersistence.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'write') {
      opens++;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes++;
        if (closes === 1) throw Error('test close failure');
        return close();
      };
    }
    return handle;
  };
  await assert.rejects(
    host.service.migrate(migrationGrant(host.service, binding.scope, binding.selection, input)),
    { code: 'unavailable' },
  );
  const bytes = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
  assert.throws(() => observeWithoutNativeIO(host, input), { code: 'unavailable' });
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.deepEqual(await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')), bytes);
  assert.equal(host.adapter.requests.length, 0);
});

test(
  'actual native origin: a timed-out physical barrier refuses until its owned cleanup actually settles',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t),
      old = grant();
    let host = await boot(root, new ScriptedAdapter([]));
    await host.service.send(old, message('old', 'parked', 'queue'));
    const binding = host.service.open(old).binding,
      input = query(binding);
    await host.close();
    host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    const release = Promise.withResolvers(),
      entered = Promise.withResolvers(),
      closed = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    let opens = 0;
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'write') {
        opens++;
        const flush = handle.flush.bind(handle),
          close = handle.close.bind(handle);
        handle.flush = async () => {
          entered.resolve();
          await release.promise;
          return flush();
        };
        handle.close = async () => {
          await close();
          closed.resolve();
        };
      }
      return handle;
    };
    const waiting = host.service.migrate(
      migrationGrant(host.service, binding.scope, binding.selection, input),
    );
    await entered.promise;
    assert.deepEqual(await waiting, { status: 'pending' });
    const bytes = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
    assert.throws(() => observeWithoutNativeIO(host, input), { code: 'unavailable' });
    assert.equal(opens, 1);
    assert.deepEqual(
      await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')),
      bytes,
    );
    release.resolve();
    await closed.promise;
    await new Promise(setImmediate);
    assert.deepEqual(observeWithoutNativeIO(host, input), {
      scope: binding.scope,
      selection: binding.selection,
    });
    assert.equal(opens, 1, 'observing late settled origin must not start another barrier');
    assert.deepEqual(
      await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')),
      bytes,
    );
    assert.equal(host.adapter.requests.length, 0);
  },
);
