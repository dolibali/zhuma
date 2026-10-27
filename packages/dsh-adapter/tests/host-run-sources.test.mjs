import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createHostDirectoryLifecycle } from '../dist/host-directory-lifecycle.js';
import { createHostRunSources, createHostRunRetirements } from '../dist/host-run-sources.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';

// Host composition contracts only. These directories/configurations are not
// real member, workspace, SDK connection, or execution authorization evidence.
function fixture(retirementDrain) {
  const ctx = new Context();
  const lifetime = new AbortController();
  const raw = new AbortController();
  const rows = new Map([['project', 'team']]);
  const handle = {
    signal: raw.signal,
    spaceForProjectNow(project) {
      const spaceId = rows.get(project);
      return spaceId === undefined ? { ok: false, reason: 'unknown' } : { ok: true, spaceId };
    },
  };
  const directory = createHostDirectoryLifecycle(() => handle);
  directory.publish(handle);
  const configuration = {
    assertConfiguration: () => undefined,
    assertWorkspace: () => undefined,
  };
  const native = {
    migrationOrigin: () => {
      throw new NativeWorkError('not-started');
    },
    migrationDrain: () => {
      throw new NativeWorkError('migration-not-ready');
    },
  };
  const ports = createHostRunSources(ctx, {
    directory,
    configuration,
    native,
    signal: lifetime.signal,
    ...(retirementDrain ? { retirementDrain } : {}),
  });
  return { ctx, lifetime, raw, rows, handle, directory, configuration, native, ports };
}

test('Host Run source contract: synchronous project checks use the current row and reject missing or closed facts', () => {
  const f = fixture();
  assert.equal(f.ports.assertProjectSpace('project', 'team'), undefined);
  f.rows.set('project', 'other');
  assert.throws(() => f.ports.assertProjectSpace('project', 'team'), {
    code: 'run-authority-denied',
  });
  assert.equal(f.ports.assertProjectSpace('project', 'other'), undefined);
  f.rows.delete('project');
  assert.throws(() => f.ports.assertProjectSpace('project', 'other'), {
    code: 'run-authority-denied',
  });
  f.raw.abort();
  assert.throws(() => f.ports.assertProjectSpace('project', 'other'), {
    code: 'run-authority-unavailable',
  });
});

test('Host Run source contract: a synchronous same-handle republish cannot authorize a lookup from its prior generation', () => {
  const f = fixture();
  f.handle.spaceForProjectNow = () => {
    f.directory.publish(f.handle);
    return { ok: true, spaceId: 'team' };
  };
  assert.throws(() => f.ports.assertProjectSpace('project', 'team'), {
    code: 'run-authority-unavailable',
  });
});

test('Host Run source contract: current producer failures and revocation are never converted into an allowed assertion', () => {
  const f = fixture();
  const unavailable = { code: 'run-authority-unavailable' };
  f.configuration.assertWorkspace = () => {
    f.lifetime.abort();
    return undefined;
  };
  assert.throws(() => f.ports.assertWorkspace(), unavailable);
  assert.throws(() => f.ports.assertConfiguration(), unavailable);
  assert.throws(() => f.ports.memberLease({ headers: {} }), unavailable);
  assert.throws(() => f.ports.migrationOrigin({}), unavailable);
});

test('Host Run source contract: only C pending readiness becomes undefined; unknown origin or drain failures refuse', () => {
  const f = fixture();
  assert.equal(f.ports.migrationDrain({}), undefined);
  assert.throws(() => f.ports.migrationOrigin({}), { code: 'not-started' });
  f.native.migrationDrain = () => {
    throw new NativeWorkError('unavailable');
  };
  assert.throws(() => f.ports.migrationDrain({}), { code: 'unavailable' });
  const proof = { signal: new AbortController().signal, assertCurrent() {} };
  f.native.migrationDrain = () => proof;
  assert.equal(f.ports.migrationDrain({}), proof);
});

test('Host Run source contract: actual Cordis change subscriptions recheck relevant facts and release together', () => {
  const f = fixture();
  let checks = 0;
  const stop = f.ports.onChange(() => ++checks);
  f.ctx.emit('domain/changed', { domain: 'zhuma_workbench' });
  f.ctx.emit('domain/changed', { domain: 'zhuma_spaces' });
  f.ctx.emit('llm/adapters-updated');
  assert.equal(checks, 3);
  f.ctx.emit('domain/changed', { domain: 'unrelated' });
  assert.equal(checks, 3);
  stop();
  f.ctx.emit('domain/changed', { domain: 'zhuma_workbench' });
  f.ctx.emit('llm/adapters-updated');
  assert.equal(checks, 3);
});

const scope = {
  actorId: 'chen',
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
};
function retirement() {
  const controller = new AbortController();
  const drain = { signal: controller.signal, assertCurrent() {} };
  return { controller, drain, result: { status: 'retired', binding: undefined, drain } };
}
test('Host retirement contract: original proof identity is scoped to every field and one owner cache', () => {
  const owner = {},
    life = new AbortController(),
    cache = createHostRunRetirements(owner, life.signal),
    p = retirement();
  cache.remember(scope, p.result);
  assert.equal(cache.read(scope), p.drain);
  for (const key of Object.keys(scope))
    assert.equal(
      cache.read({
        ...scope,
        [key]: typeof scope[key] === 'number' ? scope[key] + 1 : scope[key] + '-other',
      }),
      undefined,
      key,
    );
  assert.equal(createHostRunRetirements({}, life.signal).read(scope), undefined);
  assert.equal(
    createHostRunRetirements(owner, life.signal).read(scope),
    undefined,
    'A new owner lifetime cannot restore a proof from labels',
  );
  cache.clear();
  assert.equal(cache.read(scope), undefined);
});
test('Host retirement contract: aborted, replaced or asynchronous certificates cannot be returned', () => {
  for (const invalidate of [
    (p) => p.controller.abort(),
    (p) => {
      p.drain.signal = new AbortController().signal;
    },
    (p) => {
      p.drain.assertCurrent = () => {};
    },
    (p) => {
      p.result.drain = { ...p.drain };
    },
  ]) {
    const cache = createHostRunRetirements({}, new AbortController().signal),
      p = retirement();
    cache.remember(scope, p.result);
    invalidate(p);
    assert.throws(() => cache.read(scope), { code: 'run-authority-unavailable' });
  }
  const cache = createHostRunRetirements({}, new AbortController().signal),
    p = retirement();
  p.drain.assertCurrent = () => Promise.resolve();
  assert.throws(() => cache.remember(scope, p.result), { code: 'run-authority-unavailable' });
  assert.equal(cache.read(scope), undefined);
  const foreign = retirement();
  foreign.result.binding = { scope: { ...scope, nodeId: 'foreign' } };
  assert.throws(() => cache.remember(scope, foreign.result), { code: 'run-scope-mismatch' });
  assert.equal(cache.read(scope), undefined);
});
test('Host retirement contract: pending or failed cleanup and a fenced owner never certify settlement', () => {
  const life = new AbortController(),
    cache = createHostRunRetirements({}, life.signal),
    p = retirement();
  cache.remember(scope, { status: 'pending' });
  assert.equal(cache.read(scope), undefined);
  p.drain.assertCurrent = () => {
    throw Error('Actual certificate no longer current');
  };
  assert.throws(() => cache.remember(scope, p.result));
  assert.equal(cache.read(scope), undefined);
  life.abort();
  assert.throws(() => cache.read(scope), { code: 'run-authority-unavailable' });
});
test('Host Run source contract: cleanup proof only supplements known C absence/pending and never masks a failure', () => {
  let calls = 0;
  const p = retirement(),
    f = fixture(() => {
      calls++;
      return p.drain;
    });
  assert.equal(f.ports.migrationDrain(scope), p.drain);
  f.native.migrationDrain = () => {
    throw new NativeWorkError('not-started');
  };
  assert.equal(f.ports.migrationDrain(scope), p.drain);
  const existing = retirement().drain;
  f.native.migrationDrain = () => existing;
  assert.equal(f.ports.migrationDrain(scope), existing);
  assert.equal(calls, 2);
  f.native.migrationDrain = () => {
    throw new NativeWorkError('unavailable');
  };
  assert.throws(() => f.ports.migrationDrain(scope), { code: 'unavailable' });
  assert.equal(calls, 2);
});
