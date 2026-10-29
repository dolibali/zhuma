/** Actual DSH member cookies, published account/space directory, execution HTTP
 * and isolated JSON. No model, native execution or final Host/GUI acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { projectCommand, request, taskInput } from './member-workbench-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { apply, inject } from '../dist/execution-plugin.js';
import { memberWorkbenchDirectoryFor } from '../dist/member-workbench-directory.js';
import { identityDomainSpec } from '../dist/identity-session.js';

const ok = (result) => {
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  return result.value;
};
const no = (result, code) => {
  assert.equal(result.ok, false);
  if (code) assert.equal(result.error.code, code);
};
async function fixture(t, { configured = true, home: existing } = {}) {
  const home = existing ?? (await mkdtemp(join(tmpdir(), 'zhuma-execution-member-directory-')));
  const h = await startMemberWorkbenchHost(home);
  const controls = {},
    counts = { nodes: 0, plans: 0, global: 0 };
  let service,
    closed = false;
  const execution = h.ctx.plugin(
    { inject: [...inject], apply },
    {
      readWorkbench: () => h.service.snapshot(),
      ...(configured
        ? {
            memberDirectory: () =>
              controls.directory ? controls.directory() : memberWorkbenchDirectoryFor(h.ctx),
          }
        : {}),
      projectSpaces: {
        async spaceForProject(id) {
          await controls.lookup?.(id);
          return h.directory.spaceForProject(id);
        },
      },
      publishRunService(value) {
        service = value;
      },
    },
  );
  await execution;
  const domain = h.ctx.storageDomain.get('zhuma_execution');
  const table = domain.table.bind(domain),
    set = domain.global.set.bind(domain.global);
  domain.global.set = async (value) => {
    counts.global++;
    return set(value);
  };
  domain.table = (name) => {
    const current = table(name);
    if (!['nodes', 'plans'].includes(name)) return current;
    return new Proxy(current, {
      get(target, key) {
        if (key === 'put')
          return async (...args) => {
            counts[name]++;
            return target.put(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await execution.dispose();
    await h.close();
  };
  t.after(async () => {
    await close();
    if (!existing) await rm(home, { recursive: true, force: true });
  });
  return {
    ...h,
    home,
    service,
    workbench: h.service,
    controls,
    counts,
    close,
    async rpc(endpoint, payload, cookie) {
      const response = await h.post(
        `/api/zhuma-exec/${endpoint}`,
        { type: 'client-request', rpcId: randomUUID(), method: `zhuma-exec/${endpoint}`, payload },
        cookie,
      );
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.result;
    },
    memberRpc: h.rpc,
  };
}
const member = (id, spaces) => ({ member: { ok: true, memberId: id, spaceIds: spaces } });
const zero = (h) => assert.deepEqual(h.counts, { nodes: 0, plans: 0, global: 0 });
async function createPlan(h, cookie) {
  ok((await h.memberRpc('command', request(0, projectCommand()), cookie)).json.result);
  ok(
    (await h.memberRpc('command', request(1, { type: 'create-task', task: taskInput() }), cookie))
      .json.result,
  );
  ok(
    (await h.memberRpc('command', request(2, { type: 'confirm-task', taskId: 'task-one' }), cookie))
      .json.result,
  );
}

test('execution member directory: fresh real account in empty personal reads inbox/counts/startable through original HTTP, including logout then another account', async (t) => {
  const h = await fixture(t),
    ann = await h.login('ann');
  assert.deepEqual(h.workbench.snapshot().participants, []);
  const before = await businessHashes(h.home),
    state = JSON.stringify(h.workbench.snapshot());
  const inbox = ok(await h.rpc('inbox', { spaceId: 'personal-ann' }, ann));
  assert.equal(inbox.actorId, 'ann');
  assert.deepEqual(inbox.items, []);
  assert.deepEqual(inbox.nodes, []);
  assert.equal('actor' in inbox, false);
  assert.equal(ok(await h.rpc('inbox-counts', { spaceId: 'personal-ann' }, ann)).actorId, 'ann');
  assert.deepEqual(ok(await h.rpc('startable', { spaceId: 'personal-ann' }, ann)).plans, []);
  assert.equal(JSON.stringify(h.workbench.snapshot()), state);
  zero(h);
  assert.deepEqual(await businessHashes(h.home), before);
  assert.equal((await h.post('/zhuma-id/logout', {}, ann)).status, 200);
  await h.directory.provisionMemberSpace(
    { id: 'personal-bob', kind: 'personal', name: 'Bob' },
    'bob',
    randomUUID(),
    () => undefined,
  );
  const bob = await h.login('bob'),
    second = await businessHashes(h.home);
  assert.equal(ok(await h.rpc('inbox', { spaceId: 'personal-bob' }, bob)).actorId, 'bob');
  assert.deepEqual(ok(await h.rpc('startable', { spaceId: 'personal-bob' }, bob)).plans, []);
  assert.equal(JSON.stringify(h.workbench.snapshot()), state);
  zero(h);
  assert.deepEqual(await businessHashes(h.home), second);
});

test('execution member directory: unknown accounts, ghost membership and browser identity fields never become members or write grants', async (t) => {
  const h = await fixture(t),
    ann = await h.login('ann');
  await h.directory.grantMembership('north', 'unknown-account');
  no(
    await h.service.inbox(member('unknown-account', ['north']), { spaceId: 'north' }),
    'not-in-directory',
  );
  no(
    await h.service.startable(member('unknown-account', ['north']), { spaceId: 'north' }),
    'not-in-directory',
  );
  no(await h.rpc('inbox', { spaceId: 'personal-ann', actorId: 'ann' }, ann), 'actor-from-body');
  no(
    await h.rpc('startable', { spaceId: 'personal-ann', memberId: 'ann' }, ann),
    'actor-from-body',
  );
  no(
    await h.service.startPlan(member('ann', ['personal-ann']), {
      taskId: 'fake',
      planId: 'fake',
      revision: 1,
      idempotencyKey: 'no-new-write',
    }),
    'not-in-directory',
  );
  const other = ok(await h.rpc('inbox', { spaceId: 'south' }, ann));
  assert.deepEqual(other.items, []);
  assert.deepEqual(other.nodes, []);
  await h.directory.revokeMembership('north', 'bob');
  const bob = await h.login('bob');
  no(await h.rpc('inbox', { spaceId: 'north' }, bob), 'not-in-directory');
  no(await h.rpc('startable', { spaceId: 'north' }, bob), 'not-in-directory');
  zero(h);
});

test('execution member directory: configured missing/broken account facts are unavailable, never an authorized empty or legacy fallback', async (t) => {
  const h = await fixture(t),
    ann = await h.login('ann');
  const before = await businessHashes(h.home);
  h.controls.directory = () => undefined;
  for (const endpoint of ['inbox', 'inbox-counts', 'startable'])
    no(await h.rpc(endpoint, { spaceId: 'personal-ann' }, ann), 'unavailable');
  delete h.controls.directory;
  const identity = h.ctx.storageDomain.get(identityDomainSpec.name),
    table = identity.table.bind(identity);
  identity.table = (name) =>
    name === 'accounts'
      ? new Proxy(table(name), {
          get(target, key) {
            if (key === 'keys')
              return () => {
                throw Error('PRIVATE_KEYS_FAILURE');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : table(name);
  try {
    for (const endpoint of ['inbox', 'startable'])
      no(await h.rpc(endpoint, { spaceId: 'personal-ann' }, ann), 'unavailable');
  } finally {
    identity.table = table;
  }
  zero(h);
  assert.deepEqual(await businessHashes(h.home), before);
});

test('execution member directory: original members/plans stay filtered by current spaces and task membership; caller space echoes do not expand access', async (t) => {
  const h = await fixture(t),
    ann = await h.login('ann');
  await createPlan(h, ann);
  const wb = JSON.stringify(h.workbench.snapshot());
  assert.equal(ok(await h.rpc('startable', { spaceId: 'north' }, ann)).plans.length, 1);
  const cy = await h.login('cy');
  assert.deepEqual(ok(await h.rpc('startable', { spaceId: 'north' }, cy)).plans, []);
  await h.directory.revokeMembership('north', 'ann');
  assert.deepEqual(
    ok(
      await h.service.startable(member('ann', ['north', 'south', 'personal-ann']), {
        spaceId: 'north',
      }),
    ).plans,
    [],
  );
  assert.deepEqual(ok(await h.rpc('inbox', { spaceId: 'north' }, ann)).items, []);
  assert.equal(JSON.stringify(h.workbench.snapshot()), wb);
  zero(h);
});

test('execution member directory: revocation during an original asynchronous project lookup refuses the accumulated read before returning plans', async (t) => {
  const h = await fixture(t),
    ann = await h.login('ann');
  await createPlan(h, ann);
  let revoked = false;
  h.controls.lookup = async () => {
    if (!revoked) {
      revoked = true;
      await h.directory.revokeMembership('north', 'ann');
    }
  };
  no(await h.rpc('startable', { spaceId: 'north' }, ann), 'unavailable');
  assert(revoked);
  zero(h);
});

test('execution member directory: cold same-disk empty personal reads remain empty without participant/project/Run/marker writes', async (t) => {
  const h = await fixture(t);
  const home = h.home;
  await h.close();
  const reopened = await fixture(t, { home }),
    cookie = await reopened.login('ann');
  const before = await businessHashes(home),
    wb = JSON.stringify(reopened.workbench.snapshot());
  assert.deepEqual(ok(await reopened.rpc('inbox', { spaceId: 'personal-ann' }, cookie)).items, []);
  assert.deepEqual(
    ok(await reopened.rpc('startable', { spaceId: 'personal-ann' }, cookie)).plans,
    [],
  );
  zero(reopened);
  assert.equal(JSON.stringify(reopened.workbench.snapshot()), wb);
  assert.deepEqual(await businessHashes(home), before);
  await reopened.close();
});

test('execution member directory: omitted getter preserves the original legacy directory refusal and no resolver is inferred', async (t) => {
  const h = await fixture(t, { configured: false }),
    ann = await h.login('ann');
  no(await h.rpc('inbox', { spaceId: 'personal-ann' }, ann), 'not-in-directory');
  no(await h.rpc('startable', { spaceId: 'personal-ann' }, ann), 'not-in-directory');
  zero(h);
});
