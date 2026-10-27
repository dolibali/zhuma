/** Exact emitted Host, real SDK/HTTP/JSON and two-process first setup; no bootstrap or model generation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
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
async function publicClient() {
  const built = await build({
    stdin: {
      contents:
        "export {createLocalSetupApi,createIdentityApi,createMemberShell,enterTeamAfterLocalSetup} from '@zhuma/client';",
      resolveDir: fileURLToPath(new URL('../../client', import.meta.url)),
      sourcefile: 'first-setup-public-client-proof.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
  });
  assert.equal(
    Object.keys(built.metafile.inputs).some((path) => /dsh-adapter\/src\//u.test(path)),
    false,
  );
  const bytes = built.outputFiles[0].contents;
  return {
    api: await import(`data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function proof(host, name, publicClientSha256) {
  completed.push({
    name,
    passed: true,
    sourceHead: host.boundModule.sourceSha,
    hostSha256: host.boundModule.contentDigest,
    ...(publicClientSha256 ? { publicClientSha256 } : {}),
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
    let host, shell;
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
      assert.equal((await initialize(host, { ...value, accountId: value.packIds[0] })).status, 400);
      assert.deepEqual(
        await facts(home),
        before,
        'Rejected inputs must not initialize business facts',
      );
      const client = await publicClient();
      let clientCookie;
      // Test-only browser cookie carrier; identity and directory decisions stay
      // in the actual Host and public Client controllers, not this adapter.
      const fetcher = async (url, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set('origin', host.baseURL);
        headers.set('cookie', `${host.ownerCookie}${clientCookie ? '; ' + clientCookie : ''}`);
        const response = await fetch(host.baseURL + url, { ...options, headers });
        const issued = response.headers
          .getSetCookie()
          .find((line) => line.startsWith('zhuma-member='));
        if (issued) clientCookie = issued.split(';')[0];
        return response;
      };
      const selected = [];
      shell = client.api.createMemberShell(client.api.createIdentityApi(fetcher), {
        read: () => undefined,
        save: (_account, id) => selected.push(id),
        clearIfMatches: () => {},
      });
      shell.start();
      await shell.session.restore();
      assert.notEqual(shell.session.getSnapshot().status, 'authenticated');
      const created = await client.api
        .createLocalSetupApi(fetcher)
        .initialize(value, new AbortController().signal);
      assert.equal(created.kind, 'configured');
      assert.deepEqual(created.createdTeam, {
        id: `team-${value.requestId}`,
        kind: 'team',
        name: value.teamName,
      });
      assert.equal(JSON.stringify(created).includes('setupContext'), false);
      assert.equal(JSON.stringify(created).includes(value.password), false);
      await client.api.enterTeamAfterLocalSetup(
        shell,
        { accountId: value.accountId, password: value.password },
        created.createdTeam,
        new AbortController().signal,
      );
      assert.equal(shell.session.getSnapshot().status, 'authenticated');
      assert.equal(shell.space.getSnapshot().status, 'ready');
      assert.equal(shell.space.getSnapshot().space.id, created.createdTeam.id);
      assert.deepEqual(selected, [created.createdTeam.id]);
      let cookie = clientCookie;
      assert.ok(cookie);
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
      shell.stop();
      shell = undefined;
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
      await proof(host, 'normal-first-setup-and-project-cold-open', client.sha256);
    } finally {
      shell?.stop();
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
