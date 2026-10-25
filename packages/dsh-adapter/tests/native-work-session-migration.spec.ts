/** Actual patched native lifecycle/history; D pair/member/phase authority remain contracts. */
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
  allHistory,
  migrationGrant,
  acceptedFixture,
  registerNativeAcceptedInputTool,
  acceptedInputRef,
  toolResponse,
} from './zhuma-native-work-bundle.ts';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-migration-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
function readGrant(scope) {
  const current = grant(scope);
  current.assertCurrent = (action) => {
    assert.ok(
      ['open', 'history', 'follow'].includes(action),
      'history grant cannot drive/stop/queue',
    );
  };
  return current;
}

test('actual native: migration retains old queue/history but only reserves the new segment until explicit send', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter(['new response']));
  t.onTestFinished(() => host.close());
  const queued = await host.service.send(
    old,
    message('old-queued', 'OLD-QUEUED-PRIVATE-INPUT', 'queue'),
  );
  const before = host.service.open(old).binding;
  const ticket = await host.service.reserveInputRead(old);
  await host.service.finishInputRead(old, ticket, 1000);
  assert.throws(() => host.service.migrationDrain(old.scope), { code: 'migration-not-ready' });
  const cap = migrationGrant(host.service, old.scope, before.selection);
  const moved = await host.service.migrate(cap);
  assert.equal(moved.status, 'migrated');
  assert.notEqual(moved.next.nativeSessionId, moved.previous.nativeSessionId);
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
  assert.equal(await host.ctx.sessionPersistence.stat(moved.next.nativeSessionId), undefined);
  const next = grant(cap.scope);
  assert.equal(host.service.open(next).status, 'detached');
  assert.deepEqual((await host.service.history(next)).events, []);
  const history = await allHistory(host.service, readGrant(old.scope));
  await assert.rejects(host.runtime.connect(before, readGrant(old.scope), false));
  assert.equal(host.ctx.agents.list().length, 0, 'historical permission cannot resume an Agent');
  assert.ok(
    history.some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some((item) => item.id === queued.messageId),
    ),
  );
  assert.equal(
    history.some(
      (event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled',
    ),
    false,
  );
  const archived = host.service.open(readGrant(old.scope)).binding;
  assert.deepEqual(archived.inputReadBudget, { attempts: 1, chargedBytes: 1000 });
  await assert.rejects(host.service.send(old, message('late-old', 'must reject old drive')), {
    code: 'scope-mismatch',
  });
  // The rejected old mutation invalidated readiness; explicit replay prepares
  // a fresh barrier and retains the already reserved ID, never another segment.
  const replay = await host.service.migrate(
    migrationGrant(host.service, old.scope, before.selection),
  );
  assert.equal(replay.next.nativeSessionId, moved.next.nativeSessionId);
  assert.equal(replay.status, 'replayed');
  await host.service.send(next, message('new-turn', 'NEW-SEGMENT-INPUT'));
  await host.ctx.agents.get(moved.next.nativeSessionId).whenIdle();
  assert.equal(host.adapter.requests.length, 1);
  assert.equal(
    JSON.stringify(host.adapter.requests[0]).includes('OLD-QUEUED-PRIVATE-INPUT'),
    false,
  );
  assert.equal(host.service.queue(next).items.length, 0);
  assert.deepEqual(host.service.open(readGrant(old.scope)).binding, archived);
  assert.ok(cap.phases.includes('prepare') && cap.phases.includes('migrate'));
});

test('actual native: multiple turns keep one session; new Run does not inherit the old full conversation', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(
    root,
    new ScriptedAdapter(['OLD-ANSWER', 'same Run answer', 'new Run answer']),
  );
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('first', 'OLD-FULL-CHAT-CONTENT'));
  const initial = host.service.open(old).binding;
  await host.ctx.agents.get(initial.nativeSessionId).whenIdle();
  await host.service.send(old, message('second', 'second turn'));
  await host.ctx.agents.get(initial.nativeSessionId).whenIdle();
  assert.equal(host.service.open(old).binding.nativeSessionId, initial.nativeSessionId);
  const cap = migrationGrant(host.service, old.scope, initial.selection);
  const result = await host.service.migrate(cap);
  const next = grant(cap.scope);
  const opened = host.service.open(next);
  assert.deepEqual(opened.binding.receipts, []);
  assert.equal(opened.binding.inputReadBudget, undefined);
  assert.equal(host.adapter.requests.length, 2);
  await host.service.send(next, message('new', 'new turn'));
  await host.ctx.agents.get(result.next.nativeSessionId).whenIdle();
  assert.equal(host.adapter.requests.length, 3);
  for (const body of ['OLD-FULL-CHAT-CONTENT', 'OLD-ANSWER', 'same Run answer'])
    assert.equal(JSON.stringify(host.adapter.requests[2]).includes(body), false);
  assert.ok(
    JSON.stringify(await allHistory(host.service, readGrant(old.scope))).includes(
      'OLD-FULL-CHAT-CONTENT',
    ),
  );
});

test('actual native cold reopen: history is read-only; migration replay requires a real write-open/flush/close barrier', async (t) => {
  const root = await home(t),
    old = grant();
  let host = await boot(root, new ScriptedAdapter([]));
  await host.service.send(old, message('old', 'parked', 'queue'));
  const previous = host.service.open(old).binding;
  const cap = migrationGrant(host.service, old.scope, previous.selection);
  const first = await host.service.migrate(cap);
  await host.close();
  host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  const accesses = [];
  const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
  host.ctx.sessionPersistence.open = (...args) => {
    accesses.push(args[1]);
    return open(...args);
  };
  assert.throws(() => host.service.migrationDrain(old.scope), { code: 'migration-not-ready' });
  await host.service.history(readGrant(old.scope));
  assert.deepEqual(accesses, ['read']);
  assert.equal(host.ctx.agents.list().length, 0);
  accesses.length = 0;
  const replay = await host.service.migrate(
    migrationGrant(host.service, old.scope, previous.selection),
  );
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.next.nativeSessionId, first.next.nativeSessionId);
  assert.deepEqual(accesses, ['write']);
  assert.equal(host.service.migrationDrain(old.scope).basis, 'flushed-and-closed');
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native: same migration key coalesces one pointer write and one native barrier', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('old', 'parked', 'queue'));
  const before = host.service.open(old).binding;
  const cap = migrationGrant(host.service, old.scope, before.selection);
  let puts = 0,
    opens = 0;
  const off = host.ctx.on(
    'domain/changed',
    (change) => {
      if (change.domain === 'zhuma_native_work_sessions') puts++;
    },
    { global: true },
  );
  t.onTestFinished(off);
  const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
  host.ctx.sessionPersistence.open = (...args) => {
    if (args[1] === 'write') opens++;
    return open(...args);
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => host.service.migrate(cap)));
  assert.equal(puts, 1);
  assert.equal(opens, 1);
  assert.ok(
    results.every((result) => result.next.nativeSessionId === results[0].next.nativeSessionId),
  );
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test(
  'actual native: held input source makes migration pending without pointer change or queued-settlement deadlock',
  { timeout: 25000 },
  async (t) => {
    const root = await home(t),
      input = await acceptedFixture(),
      old = grant(input.scope);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const ref = acceptedInputRef(old.scope, input.catalog.inputs[0].input);
    let host;
    const ports = {
      catalog: input.catalog,
      resolveCurrentCaller: async () => input.caller,
      reader: {
        upstreamContent: async (...args) => {
          const value = await input.service.upstreamContent(...args);
          entered.resolve();
          await release.promise;
          return value;
        },
      },
    };
    host = await boot(
      root,
      new ScriptedAdapter([
        toolResponse({ inputRef: ref, part: 'text', limit: 1 }),
        'timeout observed',
      ]),
      (ctx, binding, current) =>
        registerNativeAcceptedInputTool(ctx, binding, current, host.service, ports),
    );
    t.onTestFinished(() => host.close());
    t.onTestFinished(() => release.resolve());
    await host.service.send(old, message('old-read', 'read old source'));
    await entered.promise;
    const previous = host.service.open(old).binding;
    await host.ctx.agents.get(previous.nativeSessionId).whenIdle();
    const stable = structuredClone(host.service.open(old).binding);
    const cap = migrationGrant(host.service, old.scope, previous.selection);
    assert.deepEqual(await host.service.migrate(cap), { status: 'pending' });
    assert.deepEqual(host.service.open(readGrant(old.scope)).binding, stable);
    assert.throws(() => host.service.migrationDrain(old.scope), { code: 'migration-not-ready' });
    release.resolve();
    await host.service.whenInputReadsIdle(old.scope);
    const result = await host.service.migrate(cap);
    assert.equal(result.status, 'migrated');
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(await host.ctx.sessionPersistence.stat(result.next.nativeSessionId), undefined);
    assert.deepEqual(
      host.service.open(readGrant(old.scope)).binding.inputReadBudget,
      stable.inputReadBudget,
    );
    assert.equal(host.adapter.requests.length, 2);
  },
);

test(
  'actual native cold cleanup: blocked flush is pending, consumes late completion, and requires explicit retry',
  { timeout: 20000 },
  async (t) => {
    const root = await home(t),
      old = grant();
    let host = await boot(root, new ScriptedAdapter([]));
    await host.service.send(old, message('old', 'parked', 'queue'));
    const before = host.service.open(old).binding;
    await host.close();
    host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      closed = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    let block = true;
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await open(...args);
      if (args[1] === 'write' && block) {
        const flush = handle.flush.bind(handle),
          close = handle.close.bind(handle);
        handle.flush = async (...rest) => {
          entered.resolve();
          await release.promise;
          return flush(...rest);
        };
        handle.close = async () => {
          await close();
          closed.resolve();
        };
      }
      return handle;
    };
    const cap = migrationGrant(host.service, old.scope, before.selection);
    const waiting = host.service.migrate(cap);
    await entered.promise;
    assert.deepEqual(await waiting, { status: 'pending' });
    assert.deepEqual(host.service.open(old).binding, before);
    assert.throws(() => host.service.migrationDrain(old.scope), { code: 'migration-not-ready' });
    block = false;
    release.resolve();
    await closed.promise;
    const result = await host.service.migrate(cap);
    assert.equal(result.status, 'migrated');
    assert.equal(host.service.migrationDrain(old.scope).basis, 'flushed-and-closed');
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
  },
);

test('actual native: prepare revocation after real barrier produces no mapping write', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('old', 'parked', 'queue'));
  const binding = host.service.open(old).binding,
    cap = migrationGrant(host.service, old.scope, binding.selection);
  const before = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
  const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
  host.ctx.sessionPersistence.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'write') {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        cap.revoke();
      };
    }
    return handle;
  };
  await assert.rejects(host.service.migrate(cap));
  assert.deepEqual(
    await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')),
    before,
  );
  assert.deepEqual(host.service.open(readGrant(old.scope)).binding, binding);
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native: direct foreign runtime restore invalidates old readiness before any new migration', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('old', 'parked', 'queue'));
  const before = host.service.open(old).binding,
    cap = migrationGrant(host.service, old.scope, before.selection);
  await host.service.migrate(cap);
  const lease = host.service.migrationDrain(old.scope);
  const other = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => other.close());
  // Component-only direct connect with a contract grant, not formal old-Run drive permission.
  await other.runtime.connect(before, old, false);
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertCurrent(), { code: 'unavailable' });
  await assert.rejects(host.service.migrate(cap), { code: 'unavailable' });
  assert.equal(other.adapter.requests.length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native: an unmaterialized failed setup is separate absence evidence, never a fake flush', async (t) => {
  const root = await home(t),
    old = grant();
  let fail = true;
  const host = await boot(root, new ScriptedAdapter([]), () => {
    if (fail) throw Error('contract setup failure');
    return { context: 'new scope', toolAllowlist: [] };
  });
  t.onTestFinished(() => host.close());
  await assert.rejects(host.service.send(old, message('failed', 'not admitted')));
  const binding = host.service.open(old).binding;
  assert.deepEqual(binding.receipts, []);
  assert.equal(await host.ctx.sessionPersistence.stat(binding.nativeSessionId), undefined);
  fail = false;
  const result = await host.service.migrate(
    migrationGrant(host.service, old.scope, binding.selection),
  );
  assert.equal(result.status, 'migrated');
  assert.equal(host.service.migrationDrain(old.scope).basis, 'absent-unadmitted');
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native cold cleanup: missing admitted history refuses instead of inventing absence or a replacement log', async (t) => {
  const root = await home(t),
    old = grant();
  let host = await boot(root, new ScriptedAdapter([]));
  await host.service.send(old, message('old', 'admitted input', 'queue'));
  const binding = host.service.open(old).binding;
  await host.close();
  // Only this test-owned native-log directory is removed to inject lost media.
  await rm(join(root, 'sessions'), { recursive: true, force: true });
  host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  const bytes = await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json'));
  await assert.rejects(
    host.service.migrate(migrationGrant(host.service, old.scope, binding.selection)),
    { code: 'unavailable' },
  );
  await assert.rejects(host.service.history(readGrant(old.scope)));
  assert.throws(() => host.service.migrationDrain(old.scope), { code: 'unavailable' });
  assert.deepEqual(await readFile(join(root, 'domains', 'zhuma_native_work_sessions.json')), bytes);
  assert.equal(await host.ctx.sessionPersistence.stat(binding.nativeSessionId), undefined);
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('actual native component with identity fault: readiness keeps one signal and refuses a replaced persistence identity', async (t) => {
  const root = await home(t),
    old = grant();
  const host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  await host.service.send(old, message('old', 'parked', 'queue'));
  await host.service.migrate(
    migrationGrant(host.service, old.scope, host.service.open(old).binding.selection),
  );
  const lease = host.service.migrationDrain(old.scope);
  assert.equal(host.service.migrationDrain(old.scope).signal, lease.signal);
  const persistence = host.ctx.sessionPersistence;
  const descriptor = Object.getOwnPropertyDescriptor(persistence, 'identity');
  assert.ok(descriptor);
  try {
    // This is public-identity fault injection, not real DI-replacement proof.
    Object.defineProperty(persistence, 'identity', {
      ...descriptor,
      value: Symbol('test-replacement'),
    });
    assert.throws(() => lease.assertCurrent(), { code: 'unavailable' });
    assert.equal(lease.signal.aborted, true);
    assert.throws(() => host.service.migrationDrain(old.scope), { code: 'unavailable' });
  } finally {
    Object.defineProperty(persistence, 'identity', descriptor);
  }
  assert.throws(() => lease.assertCurrent(), { code: 'unavailable' });
});

test('actual native cleanup: failed writer close stays owned/fenced and is retried during Host close', async (t) => {
  const root = await home(t),
    old = grant();
  let host = await boot(root, new ScriptedAdapter([]));
  await host.service.send(old, message('old', 'parked', 'queue'));
  const binding = host.service.open(old).binding;
  await host.close();
  host = await boot(root, new ScriptedAdapter([]));
  t.onTestFinished(() => host.close());
  let closeCalls = 0,
    opens = 0;
  const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
  host.ctx.sessionPersistence.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'write') {
      opens++;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closeCalls++;
        if (closeCalls === 1) throw Error('private-close-fault');
        return close();
      };
    }
    return handle;
  };
  const cap = migrationGrant(host.service, old.scope, binding.selection);
  await assert.rejects(host.service.migrate(cap), { code: 'unavailable' });
  await assert.rejects(host.service.migrate(cap), { code: 'unavailable' });
  assert.equal(opens, 1, 'unknown owner must not reopen another writer');
  assert.throws(() => host.service.migrationDrain(old.scope), { code: 'unavailable' });
  assert.deepEqual(host.service.open(readGrant(old.scope)).binding, binding);
  await assert.rejects(open(binding.nativeSessionId, 'write'));
  // The explicit close remains conservative about its failed preparation,
  // while still retrying and actually closing the handle it owns.
  await assert.rejects(host.runtime.close(), { code: 'unavailable' });
  assert.equal(closeCalls, 2);
  const reader = await open(binding.nativeSessionId, 'read');
  await reader.close();
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});
