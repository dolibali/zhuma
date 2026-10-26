import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createHostDirectoryLifecycle } from '../dist/host-directory-lifecycle.js';
import { createHostRunSources } from '../dist/host-run-sources.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';

// Host composition contracts only. These directories/configurations are not
// real member, workspace, SDK connection, or execution authorization evidence.
function fixture() {
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
