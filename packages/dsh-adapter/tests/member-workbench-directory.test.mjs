import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { memberWorkbenchDirectoryFor } from '../dist/member-workbench-directory.js';
import { identityDomainSpec, applyIdentity, identityInject } from '../dist/identity-session.js';
import { applySpaceDirectory, spaceDirectoryFor } from '../dist/space-directory.js';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { deferred, rejected } from './member-workbench-fixture.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-member-directory-'));
  const host = await startMemberWorkbenchHost(home);
  t.after(async () => {
    await host.close();
    await rm(home, { recursive: true, force: true });
  });
  return host;
}

test('member directory real components: only live account keys intersect current space membership; copies and revocation are immediate', async (t) => {
  const host = await fixture(t);
  const directory = memberWorkbenchDirectoryFor(host.ctx);
  await host.directory.grantMembership('north', 'unknown-account');
  const identity = host.ctx.storageDomain.get(identityDomainSpec.name);
  const table = identity.table.bind(identity);
  let keyReads = 0;
  identity.table = (name) =>
    name === 'accounts'
      ? {
          keys() {
            keyReads++;
            return table(name).keys();
          },
          get() {
            throw Error('account values must not be read');
          },
          entries() {
            throw Error('account values must not be enumerated');
          },
          put() {
            throw Error('no account writes');
          },
          delete() {
            throw Error('no account deletes');
          },
        }
      : table(name);
  t.after(() => {
    identity.table = table;
  });
  assert.deepEqual(directory.membersForSpace('north'), [
    { id: 'ann' },
    { id: 'bob' },
    { id: 'cy' },
  ]);
  assert.deepEqual(directory.membersForSpace('south'), [{ id: 'cy' }, { id: 'dana' }]);
  assert.deepEqual(directory.membersForSpace('personal-ann'), [{ id: 'ann' }]);
  assert.equal(
    directory.administratorForSpace('personal-ann'),
    host.directory.administratorForSpace('personal-ann'),
  );
  assert.equal(directory.administratorForSpace('unknown-space'), undefined);
  const copy = directory.membersForSpace('north');
  copy[0].id = 'mutated';
  await host.directory.revokeMembership('north', 'bob');
  assert.deepEqual(directory.membersForSpace('north'), [{ id: 'ann' }, { id: 'cy' }]);
  assert.ok(keyReads >= 5);
  assert.throws(() => directory.membersForSpace('unknown-space'), rejected('unavailable'));
});

test('member directory fail-closed contract: missing facts, failed get/keys and closed handles never become an authorized empty result', async (t) => {
  assert.throws(() => memberWorkbenchDirectoryFor(new Context()), rejected('unavailable'));
  const host = await fixture(t);
  const directory = memberWorkbenchDirectoryFor(host.ctx);
  const facility = host.ctx.storageDomain;
  const get = facility.get.bind(facility);
  facility.get = () => {
    throw Error('PRIVATE_GET_ERROR');
  };
  assert.throws(() => memberWorkbenchDirectoryFor(host.ctx), rejected('unavailable'));
  assert.throws(() => directory.membersForSpace('north'), rejected('unavailable'));
  facility.get = get;
  const identity = get(identityDomainSpec.name);
  const table = identity.table.bind(identity);
  identity.table = () => ({
    keys() {
      throw Error('PRIVATE_KEYS_ERROR');
    },
  });
  assert.throws(() => directory.membersForSpace('north'), rejected('unavailable'));
  identity.table = table;
  await host.identityFiber.dispose();
  assert.equal(memberWorkbenchDirectoryFor(host.ctx), undefined);
  assert.throws(() => directory.membersForSpace('north'), rejected('unavailable'));
});

test('member directory bridge contract: an opened diagnostic domain never impersonates installed/ready identity', async (t) => {
  const host = await fixture(t);
  const cookie = await host.login('ann');
  const identity = host.ctx.storageDomain.get(identityDomainSpec.name);
  const close = identity.close.bind(identity);
  const entered = deferred();
  const release = deferred();
  identity.close = async () => {
    entered.resolve();
    await release.promise;
    await close();
  };
  const disposing = host.identityFiber.dispose();
  await entered.promise;
  // The public diagnostic read can still see facts while B's close drains, but its resolver is already uninstalled.
  assert.equal(host.ctx.storageDomain.get(identityDomainSpec.name), identity);
  assert.equal((await host.rpc('snapshot', { spaceId: 'north' }, cookie)).status, 401);
  release.resolve();
  await disposing;
  const diagnosticOnly = await host.ctx.storageDomain.open(identityDomainSpec);
  assert.ok(memberWorkbenchDirectoryFor(host.ctx));
  assert.equal((await host.rpc('snapshot', { spaceId: 'north' }, cookie)).status, 401);
  await diagnosticOnly.close();
  assert.equal(host.service.snapshot().revision, 0);
});

for (const replacement of ['identity', 'directory']) {
  test(`member directory generation contract: replacing ${replacement} invalidates old synchronous and in-flight lookup handles`, async (t) => {
    const host = await fixture(t);
    const previous = memberWorkbenchDirectoryFor(host.ctx);
    const entered = deferred();
    const release = deferred();
    await host.directory.assignProjectSpace('project-one', 'north');
    const lookup = host.directory.spaceForProject.bind(host.directory);
    host.directory.spaceForProject = async (id) => {
      // Capture an authorized answer before teardown. Looking up a closed
      // domain after the await would not discriminate a missing lifetime fence.
      const result = await lookup(id);
      entered.resolve();
      await release.promise;
      return result;
    };
    const inFlight = previous.spaceForProject('project-one');
    await entered.promise;
    let fiber;
    if (replacement === 'identity') {
      await host.identityFiber.dispose();
      fiber = host.ctx.plugin({ inject: [...identityInject], apply: applyIdentity });
    } else {
      await host.directoryFiber.dispose();
      fiber = host.ctx.plugin({ inject: ['storageDomain'], apply: applySpaceDirectory });
    }
    await fiber;
    t.after(() => fiber.dispose());
    release.resolve();
    assert.deepEqual(await inFlight, { ok: false, reason: 'unavailable' });
    assert.throws(() => previous.membersForSpace('north'), rejected('unavailable'));
    assert.throws(() => previous.administratorForSpace('personal-ann'), rejected('unavailable'));
    assert.deepEqual(memberWorkbenchDirectoryFor(host.ctx).membersForSpace('north'), [
      { id: 'ann' },
      { id: 'bob' },
      { id: 'cy' },
    ]);
    assert.equal(spaceDirectoryFor(host.ctx).isMember('north', 'ann'), true);
  });
}

test('member directory live-authorization bridge: unmount after reading account facts suppresses both snapshot data and command writes', async () => {
  for (const endpoint of ['snapshot', 'command']) {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-member-directory-revoke-'));
    let host;
    try {
      host = await startMemberWorkbenchHost(home, {
        catalog: async () => {
          await host.identityFiber.dispose();
          return { experts: [], assets: [] };
        },
      });
      const cookie = await host.login('ann');
      const { request, projectCommand } = await import('./member-workbench-fixture.mjs');
      const reply = await host.rpc(
        endpoint,
        endpoint === 'snapshot' ? { spaceId: 'north' } : request(0, projectCommand()),
        cookie,
      );
      assert.equal(reply.json.result.ok, false);
      assert.equal(reply.json.result.error.code, 'unauthenticated');
      assert.equal(reply.json.result.value, undefined);
      assert.equal(host.service.snapshot().revision, 0);
      assert.deepEqual(host.service.snapshot().projects, []);
    } finally {
      if (host) await host.close();
      await rm(home, { recursive: true, force: true });
    }
  }
});
