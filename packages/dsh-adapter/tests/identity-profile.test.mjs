/** Original identity/lease, directory, HTTP and JSON persistence in a private fixture.
 * No real profile, SDK build, model or desktop qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { openIdentityMemberHttp } from '../dist/identity-member-http.js';
import { identityDomainSpec } from '../dist/identity-session.js';
import { openExecutionMemberLease } from '../dist/member-session.js';
import { memberWorkbenchDirectoryFor } from '../dist/member-workbench-directory.js';
import { request, projectCommand, taskInput } from './member-workbench-fixture.mjs';

async function mount(home) {
  let lifecycle;
  const host = await startMemberWorkbenchHost(home, {
    lifecycle: {
      publish(value) {
        lifecycle = value;
        return () => {
          lifecycle = undefined;
        };
      },
    },
  });
  const http = openIdentityMemberHttp(host.ctx, () => lifecycle);
  const origin = `http://127.0.0.1:${host.ctx.webServer.port}`;
  return {
    ...host,
    lifecycle: () => lifecycle,
    async get(path, cookie) {
      const response = await fetch(origin + path, {
        headers: { origin, cookie },
        redirect: 'error',
      });
      return { status: response.status, json: await response.json(), headers: response.headers };
    },
    async close() {
      await http.close();
      await host.close();
    },
  };
}

test('profile real JSON: legacy missing table opens, own name persists across restart without changing account/session/grants/history', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-profile-'));
  let h = await mount(home);
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  await h.close();
  const path = join(home, 'storages', 'zhuma_identity.json');
  const old = JSON.parse(await readFile(path, 'utf8'));
  delete old.tables.profiles;
  await writeFile(path, JSON.stringify(old));
  h = await mount(home);
  const cookie = await h.login('ann');
  const before = (await h.get('/zhuma-id/session', cookie)).json;
  assert.equal(Object.hasOwn(before, 'displayName'), false);
  assert.deepEqual((await h.get('/zhuma-id/profile', cookie)).json.value, {
    accountId: 'ann',
    displayName: null,
  });
  const origin = `http://127.0.0.1:${h.ctx.webServer.port}`;
  const lease = await openExecutionMemberLease(h.ctx, {
    headers: { cookie, origin, host: new URL(origin).host },
  });
  for (const command of [
    request(0, projectCommand()),
    request(1, { type: 'create-task', task: taskInput() }),
    request(2, { type: 'confirm-task', taskId: 'task-one' }),
  ]) {
    const response = await h.rpc('command', command, cookie);
    assert.equal(response.json.result.ok, true, JSON.stringify(response.json));
  }
  const identity = h.ctx.storageDomain.get(identityDomainSpec.name);
  const accounts = [...identity.table('accounts').entries()];
  const workbench = h.service.snapshot();
  assert.equal(workbench.appliedPlans.length, 1);
  const spaces = before.spaces;
  const saved = await h.post('/zhuma-id/profile', { displayName: '  张宁  ' }, cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('set-cookie'), null);
  assert.deepEqual(saved.json.value, { accountId: 'ann', displayName: '张宁' });
  assert.deepEqual([...identity.table('accounts').entries()], accounts);
  assert.deepEqual(h.service.snapshot(), workbench);
  lease.assertCurrent('north');
  assert.equal(lease.signal.aborted, false);
  lease.release();
  const session = (await h.get('/zhuma-id/session', cookie)).json;
  assert.equal(session.accountId, before.accountId);
  assert.deepEqual(session.principal, before.principal);
  assert.deepEqual(session.spaces, spaces);
  assert.equal(session.displayName, '张宁');
  const snapshot = await h.rpc('snapshot', { spaceId: 'north' }, cookie);
  assert.equal(
    snapshot.json.result.value.state.participants.find((p) => p.id === 'ann').name,
    '张宁',
  );
  await h.close();
  h = await mount(home);
  assert.deepEqual((await h.get('/zhuma-id/profile', cookie)).json.value, {
    accountId: 'ann',
    displayName: '张宁',
  });
  assert.equal((await h.get('/zhuma-id/session', cookie)).json.displayName, '张宁');
  assert.equal((await h.post('/zhuma-id/profile', { displayName: '' }, cookie)).status, 200);
  assert.equal(
    Object.hasOwn((await h.get('/zhuma-id/session', cookie)).json, 'displayName'),
    false,
  );
});

test('profile HTTP: only the live caller can write; forged subjects, foreign spaces and unsupported methods reveal no names', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-profile-authority-'));
  const h = await mount(home);
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const ann = await h.login('ann'),
    dana = await h.login('dana');
  await h.post('/zhuma-id/profile', { displayName: '同名成员' }, ann);
  await h.post('/zhuma-id/profile', { displayName: '同名成员' }, dana);
  for (const input of [
    { displayName: '伪造', accountId: 'dana' },
    { displayName: '伪造', actorId: 'dana' },
    { displayName: 'x'.repeat(81) },
    { displayName: 'line\nbreak' },
    { displayName: 'bad\u0000name' },
  ]) {
    const response = await h.post('/zhuma-id/profile', input, ann);
    assert.equal(response.status, 400);
  }
  assert.equal((await h.get('/zhuma-id/profile?accountId=dana', ann)).status, 400);
  const unauthenticated = await h.get('/zhuma-id/profile', '');
  assert.equal(unauthenticated.status, 401);
  assert.equal(JSON.stringify(unauthenticated.json).includes('同名成员'), false);
  const foreign = await h.rpc('snapshot', { spaceId: 'south' }, ann);
  assert.equal(JSON.stringify(foreign.json).includes('同名成员'), false);
  assert.equal((await h.get('/zhuma-id/profile', ann)).json.value.accountId, 'ann');
  assert.equal((await h.get('/zhuma-id/profile', dana)).json.value.accountId, 'dana');
  const loggedOut = await h.post('/zhuma-id/logout', {}, ann);
  assert.equal(loggedOut.status, 200);
  assert.equal((await h.post('/zhuma-id/profile', { displayName: '迟到' }, ann)).status, 401);
});

test('public directory reads names only after membership filtering, never credential values or other-space profiles', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-profile-directory-'));
  const h = await mount(home);
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const ann = await h.login('ann');
  await h.post('/zhuma-id/profile', { displayName: '张宁' }, ann);
  const identity = h.ctx.storageDomain.get(identityDomainSpec.name);
  await identity.table('profiles').put('dana', { displayName: 'PRIVATE_OTHER_SPACE' });
  const original = identity.table.bind(identity),
    reads = [];
  identity.table = (name) =>
    name === 'accounts'
      ? {
          keys: () => original(name).keys(),
          get: () => assert.fail('No credential values in public projections'),
          entries: () => assert.fail('No credential enumeration'),
        }
      : name === 'profiles'
        ? {
            get(id) {
              reads.push(id);
              return original(name).get(id);
            },
          }
        : original(name);
  try {
    const directory = memberWorkbenchDirectoryFor(h.ctx);
    assert.deepEqual(directory.membersForSpace('north'), [
      { id: 'ann', name: '张宁' },
      { id: 'bob' },
      { id: 'cy' },
    ]);
    assert.equal(reads.includes('dana'), false);
    await h.directory.revokeMembership('north', 'ann');
    assert.deepEqual(directory.membersForSpace('north'), [{ id: 'bob' }, { id: 'cy' }]);
  } finally {
    identity.table = original;
  }
});

test('self profile requires a live identity but no space grant, and a failed durable write never acknowledges a saved name', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-profile-failure-'));
  const h = await mount(home);
  t.after(async () => {
    await h.close();
    await rm(home, { recursive: true, force: true });
  });
  const ann = await h.login('ann');
  for (const space of h.directory.spacesForMember('ann'))
    await h.directory.revokeMembership(space.id, 'ann');
  assert.deepEqual(h.directory.spacesForMember('ann'), []);
  const saved = await h.post('/zhuma-id/profile', { displayName: '张宁' }, ann);
  assert.equal(saved.status, 200);
  const profiles = h.ctx.storageDomain.get(identityDomainSpec.name).table('profiles');
  const original = profiles.put;
  profiles.put = async () => {
    throw Error('synthetic persistence failure');
  };
  try {
    const failed = await h.post('/zhuma-id/profile', { displayName: '未保存的姓名' }, ann);
    assert.equal(failed.status, 503);
    assert.equal(JSON.stringify(failed.json).includes('synthetic persistence failure'), false);
    assert.equal((await h.get('/zhuma-id/profile', ann)).json.value.displayName, '张宁');
  } finally {
    profiles.put = original;
  }
  await h.post('/zhuma-id/logout', {}, ann);
  assert.equal((await h.get('/zhuma-id/profile', ann)).status, 401);
});
