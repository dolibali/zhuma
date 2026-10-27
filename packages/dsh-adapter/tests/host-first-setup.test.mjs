/** Exact emitted Host, real SDK/HTTP/JSON and two-process first setup; no bootstrap or model generation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

const settings = { deploymentMode: 'multi-member', localSetup: true };
const input = () => ({
  requestId: randomUUID(),
  accountId: 'setup-member',
  password: 'synthetic-first-setup-password',
  teamName: '交互研发团队',
  packIds: ['zhuma-work-planning', 'zhuma-interaction-review'],
});
const status = async (host) => {
  const response = await fetch(host.baseURL + '/api/zhuma-local-setup/status', {
    headers: { cookie: host.ownerCookie, origin: host.baseURL },
  });
  const raw = await response.text();
  assert.ok(raw, `Setup status returned no JSON (HTTP ${response.status})`);
  return { status: response.status, json: JSON.parse(raw) };
};
const initialize = (host, value, headers) =>
  host.post('/api/zhuma-local-setup/initialize', value, host.ownerCookie, headers);
const okay = (reply) => {
  assert.equal(reply.status, 200);
  assert.equal(reply.json.ok, true, JSON.stringify(reply.json));
  return reply.json.value;
};
const facts = async (home) =>
  Promise.all(
    ['zhuma_identity.json', 'zhuma_spaces.json', 'zhuma_workbench.json'].map((name) =>
      readFile(join(home, 'storages', name)).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    ),
  );
const completed = [];
async function proof(host, name) {
  completed.push({
    name,
    passed: true,
    sourceHead: host.boundModule.sourceSha,
    hostSha256: host.boundModule.contentDigest,
  });
  if (process.env.S1A_FIRST_SETUP_PROOF_FILE)
    await writeFile(
      process.env.S1A_FIRST_SETUP_PROOF_FILE,
      JSON.stringify(
        {
          cases: completed,
          scope:
            'Exact emitted Host and real SDK owner/member HTTP/JSON; synthetic plaintext entered through normal first-setup HTTP, no bootstrap, no seeded plan, no GUI/native model execution.',
        },
        null,
        2,
      ) + '\n',
    );
}

test(
  'first setup emitted Host: owner creates account, actual spaces and selected experts; ordinary project creation survives a new process without Config grants',
  { skip: !process.env.S1A_HOST_MODULE, timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-first-setup-normal-'));
    let host;
    const value = input();
    try {
      host = await startAcceptanceHost(home, settings);
      assert.equal(host.seeded, false);
      const initial = okay(await status(host));
      assert.equal(initial.kind, 'unconfigured');
      assert.equal(initial.packs.length, 4);
      const before = await facts(home);
      assert.equal(
        (await initialize(host, value, { origin: 'https://outside.example' })).status,
        403,
      );
      assert.equal((await initialize(host, { ...value, ready: true })).status, 400);
      assert.deepEqual(
        await facts(home),
        before,
        'Rejected inputs must not initialize business facts',
      );
      const created = okay(await initialize(host, value));
      assert.equal(created.kind, 'configured');
      assert.equal(JSON.stringify(created).includes('setupContext'), false);
      assert.equal(JSON.stringify(created).includes(value.password), false);
      let cookie = await host.login(value.accountId, value.password);
      const rpc = async (endpoint, payload) => {
        const reply = await host.post(
          '/api/zhuma-member/' + endpoint,
          {
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'zhuma-member/' + endpoint,
            payload,
          },
          `${host.ownerCookie}; ${cookie}`,
        );
        assert.equal(reply.status, 200);
        assert.equal(reply.json.result.ok, true, JSON.stringify(reply.json));
        return reply.json.result.value;
      };
      const spaceId = `team-${value.requestId}`;
      let snapshot = await rpc('snapshot', { spaceId });
      assert.deepEqual(snapshot.state.appliedPlans, []);
      assert.deepEqual(snapshot.state.tasks, []);
      assert.deepEqual(
        snapshot.state.participants
          .filter((item) => item.kind === 'expert')
          .map((item) => item.id)
          .sort(),
        [...value.packIds].sort(),
      );
      snapshot = await rpc('command', {
        spaceId,
        requestId: randomUUID(),
        expectedRevision: snapshot.state.revision,
        command: {
          type: 'create-project',
          project: { id: 'normal-created-project', name: '实际创建的项目', description: '' },
        },
      });
      assert.equal(snapshot.state.projects.length, 1);
      const stored = await facts(home),
        oldPid = host.child.pid;
      await host.close();
      host = undefined;
      host = await startAcceptanceHost(home, settings);
      assert.notEqual(host.child.pid, oldPid);
      assert.equal(okay(await status(host)).kind, 'configured');
      assert.deepEqual(
        await facts(home),
        stored,
        'Passive cold open/status must not rewrite facts',
      );
      cookie = await host.login(value.accountId, value.password);
      const reopened = await rpc('snapshot', { spaceId });
      assert.deepEqual(reopened.state.projects, snapshot.state.projects);
      assert.deepEqual(reopened.state.participants, snapshot.state.participants);
      assert.deepEqual(
        (await facts(home)).slice(1),
        stored.slice(1),
        'Normal projectSpaces growth must not invalidate the original setup pin or rewrite facts',
      );
      assert.equal((await host.act('inspect')).modelCalls, 0);
      await proof(host, 'normal-first-setup-and-project-cold-open');
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test(
  'first setup emitted Host: catalog write crash keeps pending; new process cannot log in or replay, exact explicit retry completes once',
  { skip: !process.env.S1A_HOST_MODULE, timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-first-setup-pending-'));
    let host;
    const value = input();
    try {
      host = await startAcceptanceHost(home, settings);
      await host.act('holdWorkbenchWrite');
      const pending = initialize(host, value).catch(() => undefined);
      await Promise.race([
        host.wait('workbench-write-pending'),
        pending.then((reply) => {
          throw Error(
            `Setup did not reach catalog write (HTTP ${reply?.status ?? 'disconnected'})`,
          );
        }),
      ]);
      const oldPid = host.child.pid;
      const exited = once(host.child, 'exit');
      host.child.kill('SIGKILL');
      await exited;
      await pending;
      host = undefined;
      const prefix = await facts(home);
      host = await startAcceptanceHost(home, settings);
      assert.notEqual(host.child.pid, oldPid);
      assert.equal(okay(await status(host)).kind, 'pending');
      assert.equal(okay(await status(host)).requestId, value.requestId);
      const denied = await host.post('/zhuma-id/login', {
        accountId: value.accountId,
        password: value.password,
      });
      assert.notEqual(denied.status, 200);
      assert.deepEqual(
        await facts(home),
        prefix,
        'Passive startup, status and denied login must not resume writes',
      );
      assert.equal((await initialize(host, { ...value, teamName: '改变后的团队' })).status, 409);
      assert.deepEqual(await facts(home), prefix, 'Changed initialization cannot write');
      assert.equal(okay(await initialize(host, value)).kind, 'configured');
      const completedFacts = await facts(home);
      assert.equal(okay(await initialize(host, value)).kind, 'configured');
      assert.deepEqual(
        await facts(home),
        completedFacts,
        'Same request retry cannot add another account/import/revision',
      );
      assert.ok(await host.login(value.accountId, value.password));
      assert.equal((await host.act('inspect')).modelCalls, 0);
      await proof(host, 'catalog-prefix-crash-and-explicit-same-context-recovery');
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
