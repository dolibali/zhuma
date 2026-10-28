import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startLocalServer, stopLocalServer } from './runtime.mjs';
import { createIdentityLifecycleApi } from '../../packages/client/dist/identity/lifecycle-api.js';
import { createIdentityApi } from '../../packages/client/dist/identity/api.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: { sdk: { type: 'string' }, plugin: { type: 'string' } },
});
if (!values.sdk) throw new Error('Pass --sdk with the built pinned SDK');
const directory = await mkdtemp(join(tmpdir(), 'zhuma-member-lifecycle-'));
let child, base;
const checks = [];
async function boot() {
  child = await startLocalServer({
    sdk: resolve(values.sdk),
    plugin: values.plugin,
    data: directory,
    port: 0,
  });
  const current = child;
  let diagnostics = '';
  base = await new Promise((done, fail) => {
    const timeout = setTimeout(
      () => fail(new Error('Official member server startup timed out')),
      45_000,
    );
    const inspect = (chunk) => {
      const text = chunk.toString();
      diagnostics = (diagnostics + text.replace(/token=[^\s&]+/gu, 'token=[redacted]')).slice(
        -1000,
      );
      const url = text.match(/dsh web: (https?:\/\/\S+\?token=\S+)/u)?.[1];
      if (url) {
        clearTimeout(timeout);
        done(new URL(url).origin);
      }
    };
    current.stdout.on('data', inspect);
    current.stderr.on('data', inspect);
    current.once('exit', () => {
      clearTimeout(timeout);
      fail(new Error('Official member server exited before readiness'));
    });
    current.once('error', (error) => {
      clearTimeout(timeout);
      fail(error);
    });
  });
  // No SDK owner token exchange, owner cookie, imported account or pre-populated directory.
}
function client() {
  let cookie = '';
  const fetcher = async (path, init = {}) => {
    const response = await fetch(new URL(path, base), {
      ...init,
      headers: { ...init.headers, origin: base, ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
    });
    for (const line of response.headers.getSetCookie()) {
      assert.ok(
        line.startsWith('zhuma-member='),
        'Product routes must never issue SDK owner cookies',
      );
      cookie = line.split(';')[0];
      if (cookie === 'zhuma-member=') cookie = '';
    }
    return response;
  };
  return {
    identity: createIdentityApi(fetcher),
    lifecycle: createIdentityLifecycleApi(fetcher),
    fetcher,
    cookie: () => cookie,
  };
}
const signal = () => AbortSignal.timeout(15_000);
const password = 'synthetic-lifecycle-password';
try {
  await boot();
  const ann = client(),
    bob = client();
  const foreign = await fetch(base + '/zhuma-id/register', {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), accountId: 'ann', password }),
  });
  assert.equal(foreign.status, 403);
  const registration = { requestId: randomUUID(), accountId: 'ann', password };
  const first = await ann.lifecycle.register(registration, signal());
  assert.equal(first.disposition, 'created');
  assert.equal(ann.cookie(), '');
  assert.equal((await ann.lifecycle.register(registration, signal())).disposition, 'replayed');
  await bob.lifecycle.register({ requestId: randomUUID(), accountId: 'bob', password }, signal());
  checks.push('fresh-anonymous-registration-personal-space-idempotency-no-owner');
  await ann.identity.login({ accountId: 'ann', password }, signal());
  await bob.identity.login({ accountId: 'bob', password }, signal());
  const initial = await ann.identity.session(signal());
  assert.deepEqual(
    initial.spaces.map((space) => space.id),
    [first.personalSpaceId],
  );
  assert.equal(initial.principal.kind, 'zhuma-member');
  const teamInput = { requestId: randomUUID(), name: '共享交付团队' };
  const created = await ann.lifecycle.createTeam(teamInput, signal());
  assert.equal((await ann.lifecycle.createTeam(teamInput, signal())).spaceId, created.spaceId);
  const teams = await ann.lifecycle.teams(signal());
  assert.deepEqual(teams.teams, [
    { id: created.spaceId, name: teamInput.name, role: 'administrator' },
  ]);
  assert.deepEqual((await ann.lifecycle.members(created.spaceId, signal())).accountIds, ['ann']);
  checks.push('normal-team-create-authoritative-admin-and-member-list');
  const add = {
    requestId: randomUUID(),
    spaceId: created.spaceId,
    accountId: 'bob',
    action: 'add',
  };
  await ann.lifecycle.setMember(add, signal());
  assert.equal((await bob.lifecycle.teams(signal())).teams[0].role, 'member');
  assert.ok(
    (await bob.identity.session(signal())).spaces.some((space) => space.id === created.spaceId),
  );
  await assert.rejects(
    () =>
      bob.lifecycle.setMember(
        { ...add, requestId: randomUUID(), accountId: 'ann', action: 'remove' },
        signal(),
      ),
    (error) => error.code === 'forbidden',
  );
  checks.push('administrator-add-existing-account-and-non-admin-denial');
  const rpc = async (who, endpoint, payload) => {
    const response = await who.fetcher('/api/zhuma-member/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'zhuma-member/' + endpoint,
        payload,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  let snapshot = await rpc(ann, 'snapshot', { spaceId: created.spaceId });
  assert.equal(snapshot.ok, true);
  const expertIds = [
    'zhuma-engineering-docs',
    'zhuma-interaction-review',
    'zhuma-work-planning',
    'zhuma-workflow-diagram',
  ];
  const experts = (value) => value.state.participants.filter((item) => item.kind === 'expert');
  assert.deepEqual(
    experts(snapshot.value)
      .map((expert) => expert.id)
      .sort(),
    expertIds,
  );
  const fixedExperts = experts(snapshot.value);
  assert(fixedExperts.every((expert) => expert.origin.filePaths.includes('LICENSE.txt')));
  assert.equal(
    (await rpc(ann, 'snapshot', { spaceId: created.spaceId })).value.state.revision,
    snapshot.value.state.revision,
    'Reading a newly created team never imports another package',
  );
  const personal = await rpc(ann, 'snapshot', { spaceId: first.personalSpaceId });
  assert.equal(personal.ok, true);
  assert.deepEqual(experts(personal.value), []);
  checks.push('normal-new-team-four-fixed-public-experts-personal-isolation-and-zero-read-import');
  snapshot = await rpc(ann, 'command', {
    spaceId: created.spaceId,
    requestId: randomUUID(),
    expectedRevision: snapshot.value.state.revision,
    command: {
      type: 'create-project',
      project: { id: 'registered-project', name: '注册后创建项目', description: '' },
    },
  });
  assert.equal(snapshot.ok, true);
  await ann.lifecycle.setMember(
    { requestId: randomUUID(), spaceId: created.spaceId, accountId: 'bob', action: 'remove' },
    signal(),
  );
  assert.ok(
    !(await bob.identity.session(signal())).spaces.some((space) => space.id === created.spaceId),
  );
  assert.equal((await rpc(bob, 'snapshot', { spaceId: created.spaceId })).error.code, 'not-found');
  checks.push('normal-project-command-and-removed-member-revocation');
  const oldCookie = ann.cookie();
  await ann.lifecycle.changePassword(
    { oldPassword: password, newPassword: 'synthetic-updated-password' },
    signal(),
  );
  assert.equal(
    ann.cookie(),
    oldCookie,
    'A delayed password response must not clear a replacement browser login',
  );
  assert.equal(
    (await fetch(base + '/zhuma-id/session', { headers: { origin: base, cookie: oldCookie } }))
      .status,
    401,
  );
  await assert.rejects(
    () => ann.identity.login({ accountId: 'ann', password }, signal()),
    (error) => error.code === 'invalid-login',
  );
  await ann.identity.login({ accountId: 'ann', password: 'synthetic-updated-password' }, signal());
  checks.push('password-change-invalidates-original-session-without-unconditional-cookie-clear');
  const beforeRestart = (await rpc(ann, 'snapshot', { spaceId: created.spaceId })).value.state
    .projects;
  await stopLocalServer(child);
  child = undefined;
  await boot();
  await ann.identity.login({ accountId: 'ann', password: 'synthetic-updated-password' }, signal());
  assert.deepEqual((await ann.lifecycle.teams(signal())).teams, teams.teams);
  assert.deepEqual(
    (await rpc(ann, 'snapshot', { spaceId: created.spaceId })).value.state.projects,
    beforeRestart,
  );
  assert.deepEqual(
    experts((await rpc(ann, 'snapshot', { spaceId: created.spaceId })).value),
    fixedExperts,
    'Cold startup retains the exact original public expert versions',
  );
  await bob.identity.login({ accountId: 'bob', password }, signal());
  assert.deepEqual((await bob.lifecycle.teams(signal())).teams, []);
  checks.push('official-cli-cold-restart-account-team-password-membership-and-project-persistence');
  const sha = (file) =>
    readFile(
      join(values.plugin ? resolve(values.plugin) : join(root, '.build/workbench'), file),
    ).then((data) => createHash('sha256').update(data).digest('hex'));
  const report = {
    scope: 'real-official-cli-member-http-public-client-no-owner-no-model',
    checks,
    artifacts: { host: await sha('index.js'), memberWeb: await sha('member-web.js') },
    limits: [
      'No browser/model/installation acceptance',
      'Does not exercise cross-device Agent execution',
    ],
  };
  await mkdir(join(root, '.artifacts/server'), { recursive: true });
  await writeFile(
    join(root, '.artifacts/server/member-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child) await stopLocalServer(child);
  await rm(directory, { recursive: true, force: true });
}
