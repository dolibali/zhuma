import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../dist/identity-session.js';
import { LEGACY_OWNER_ROUTES } from '../dist/member-session.js';
import { previewResourcePackage, parseWorkflowTemplate } from '@zhuma/agent-core';
import { fixture as workbenchFixture } from '../../../tests/fixtures/workbench.mjs';
import { packageFixture, importCommand } from '../../../tests/fixtures/asset-package.mjs';

const children = new Set();
const proof = {
  surface:
    'real published DSH services, separate Node processes, private JSON/credentials files; model generation disabled',
  cases: [],
};
const secretPassword = randomBytes(24).toString('base64url');
const imported = {
  accounts: [{ id: 'member-a', passwordHash: hashPassword(secretPassword) }],
  notes: [
    {
      id: 'private-note',
      spaceId: 'personal-a',
      ownerId: 'member-a',
      teamMemberIds: [],
      text: 'Synthetic private note',
    },
  ],
};

async function start(directory, config, { deferIdentity = false, skipRemoteAccess = false } = {}) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/s1a-host-process.mjs', import.meta.url)),
    [],
    {
      cwd: directory,
      env: { PATH: process.env.PATH },
      silent: true,
    },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  const phases = new Map(),
    waits = new Map(),
    actions = new Map();
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk.toString();
  });
  child.stdout.resume();
  child.on('message', (message) => {
    if (message.phase) {
      phases.set(message.phase, message);
      waits.get(message.phase)?.(message);
    } else if (message.reply) {
      actions.get(message.reply)?.(message);
    }
  });
  const wait = (phase) =>
    phases.has(phase)
      ? Promise.resolve(phases.get(phase))
      : new Promise((resolveWait, reject) => {
          const timer = setTimeout(
            () => reject(Error(`Host phase timed out: ${phase}; ${diagnostics.slice(-500)}`)),
            15000,
          );
          waits.set(phase, (message) => {
            clearTimeout(timer);
            resolveWait(message);
          });
        });
  const act = async (action) => {
    const id = randomUUID();
    const response = new Promise((resolveAction, reject) => {
      const timer = setTimeout(() => reject(Error(`Host action timed out: ${action}`)), 10000);
      actions.set(id, (message) => {
        clearTimeout(timer);
        actions.delete(id);
        message.error ? reject(Error(message.error)) : resolveAction(message.value);
      });
    });
    child.send({ id, action });
    return response;
  };
  const { identityImport, spaceDirectoryImport, ...publicConfig } = config;
  child.send({
    type: 'boot',
    options: {
      directory,
      config: {
        ...publicConfig,
        ...(identityImport === undefined
          ? {}
          : { identityBootstrapKey: 'zhuma-identity/bootstrap' }),
        ...(spaceDirectoryImport === undefined
          ? {}
          : { spaceDirectoryBootstrapKey: 'zhuma-spaces/bootstrap' }),
      },
      identityImport,
      deferIdentity,
      skipRemoteAccess,
      ...(spaceDirectoryImport === undefined ? {} : { spaceDirectoryImport }),
      ...(process.env.S1A_HOST_MODULE ? { modulePath: resolve(process.env.S1A_HOST_MODULE) } : {}),
    },
  });
  const listener = await wait('listening');
  const handshake = await fetch(listener.ownerURL, { redirect: 'manual' });
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'The real Connection must issue an owner transport cookie');
  return {
    ...listener,
    cookie,
    wait,
    act,
    child,
    async close() {
      try {
        await act('stop');
      } finally {
        if (child.exitCode === null)
          await new Promise((resolveExit) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolveExit();
            });
          });
      }
    },
  };
}

function envelope(endpoint, payload) {
  return { type: 'client-request', rpcId: randomUUID(), method: `zhuma/${endpoint}`, payload };
}
async function post(host, path, payload, cookie = host.cookie) {
  return fetch(host.baseURL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
}
async function login(host) {
  const response = await post(
    host,
    '/zhuma-id/login',
    { accountId: 'member-a', password: secretPassword },
    '',
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}
async function earlyRequest(host, endpoint, { declared = false, cookie = host.cookie } = {}) {
  return new Promise((resolveResponse, reject) => {
    let gotResponse = false,
      sentBytes = 0;
    const timer = setTimeout(() => {
      request.destroy();
      reject(Error('Server waited for the request body instead of rejecting early'));
    }, 3000);
    const request = http.request(
      host.baseURL + `/api/zhuma/${endpoint}`,
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          ...(declared ? { 'content-length': String(40 * 1024 * 1024) } : {}),
        },
      },
      (response) => {
        gotResponse = true;
        response.resume();
        response.on('end', () => {
          clearTimeout(timer);
          const result = {
            status: response.statusCode,
            sentBytes,
            requestEnded: request.writableEnded,
            connectionClose: response.headers.connection === 'close',
          };
          request.destroy();
          resolveResponse(result);
        });
      },
    );
    request.on('error', () => {
      if (!gotResponse) {
        clearTimeout(timer);
        reject(Error('Host closed before its HTTP rejection was received'));
      }
    });
    const first = Buffer.from('{"incomplete":');
    sentBytes += first.length;
    request.write(first);
    // Deliberately never complete the body. The server must answer before EOF.
  });
}

test(
  'S1a actual Host: multi-member denies all five legacy routes before incomplete bodies; identity pending/unloaded/failed/remounted never becomes owner',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-multi-'));
    let host;
    try {
      host = await start(
        directory,
        { deploymentMode: 'multi-member', identityImport: imported },
        { deferIdentity: true },
      );
      await host.wait('identity-pending');
      for (const endpoint of LEGACY_OWNER_ROUTES) {
        const result = await earlyRequest(host, endpoint);
        assert.equal(result.status, 404);
        assert.equal(result.requestEnded, false);
        assert.equal(result.connectionClose, true);
      }
      await host.act('releaseIdentity');
      await host.wait('ready');
      for (const cookie of [
        '',
        host.cookie,
        'zhuma-member=invalid',
        `${host.cookie}; zhuma-member=invalid`,
      ])
        assert.equal(
          (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie } })).status,
          401,
        );
      const member = await login(host);
      const before = await host.act('inspect');
      assert.equal(before.credentialMode, 0o600);
      for (const cookie of [
        host.cookie,
        `${host.cookie}; zhuma-member=invalid`,
        `${host.cookie}; ${member}`,
      ]) {
        for (const endpoint of LEGACY_OWNER_ROUTES) {
          const result = await earlyRequest(host, endpoint, { cookie, declared: true });
          assert.equal(result.status, 404);
          assert.equal(result.requestEnded, false);
        }
      }
      const pack = packageFixture();
      const payloads = {
        snapshot: {},
        command: {
          requestId: randomUUID(),
          expectedRevision: 0,
          command: importCommand(previewResourcePackage(pack, parseWorkflowTemplate), pack),
        },
        plan: {},
        'preview-import': { kind: 'zip', data: 'bm90LXppcA==' },
        'resource-files': { kind: 'asset', id: 'not-authorized' },
      };
      for (const endpoint of LEGACY_OWNER_ROUTES) {
        assert.equal(
          (await post(host, `/api/zhuma/${endpoint}`, envelope(endpoint, payloads[endpoint])))
            .status,
          404,
        );
        assert.equal(
          (await post(host, `/api/zhuma/${endpoint}`, envelope(endpoint, {}), '')).status,
          401,
        );
        assert.equal(
          (await post(host, `/api/zhuma/${endpoint}`, envelope(endpoint, {}), member)).status,
          401,
        );
      }
      const after = await host.act('inspect');
      assert.deepEqual(after.files, before.files);
      assert.equal(after.modelCalls, 0);
      for (const lifecycle of ['unmountIdentity', 'failIdentity', 'remountIdentity']) {
        const result = await host.act(lifecycle);
        if (lifecycle === 'failIdentity') assert.equal(result.loaded, false);
        if (lifecycle === 'remountIdentity') assert.equal(result.loaded, true);
        for (const endpoint of LEGACY_OWNER_ROUTES)
          assert.equal((await earlyRequest(host, endpoint)).status, 404);
      }
      assert.equal(
        (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: member } })).status,
        200,
      );
      const final = await host.act('inspect');
      assert.equal(final.opened.filter((name) => name === 'zhuma_workbench').length, 1);
      assert.equal(final.opened.filter((name) => name === 'zhuma_asset_packages').length, 1);
      proof.cases.push({
        name: 'multi-member-early-and-lifecycle',
        passed: true,
        credentialMode: '0600',
        storageUnchangedByDeniedRequests: true,
        models: 0,
        domains: final.opened,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1a actual Host: member cookie survives a separate-process restart with the real credentials provider and JSON domain',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-restart-'));
    let host;
    try {
      host = await start(directory, { deploymentMode: 'multi-member', identityImport: imported });
      await host.wait('ready');
      const member = await login(host);
      const before = await host.act('inspect');
      const oldPid = host.child.pid;
      await host.close();
      host = null;
      host = await start(directory, { deploymentMode: 'multi-member' });
      await host.wait('ready');
      assert.notEqual(host.child.pid, oldPid);
      const session = await fetch(host.baseURL + '/zhuma-id/session', {
        headers: { cookie: member },
      });
      assert.equal(session.status, 200);
      assert.equal((await session.json()).accountId, 'member-a');
      assert.equal(
        (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: host.cookie } }))
          .status,
        401,
      );
      const after = await host.act('inspect');
      assert.deepEqual(after.files, before.files);
      assert.equal(after.credentialMode, 0o600);
      assert.equal((await earlyRequest(host, 'snapshot')).status, 404);
      proof.cases.push({
        name: 'separate-process-restart',
        passed: true,
        credentialMode: '0600',
        sameStoredSessionAndDomains: true,
        ownerDoesNotBecomeMember: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1a actual Host: explicit legacy mode preserves commands/imports; authorized streaming reads enforce declared, chunked and time budgets',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-legacy-'));
    let host;
    try {
      host = await start(directory, {
        deploymentMode: 'legacy-single-user',
        bodyBytes: 4096,
        bodyTimeoutMs: 300,
      });
      await host.wait('ready');
      assert.equal((await earlyRequest(host, 'snapshot', { declared: true })).status, 413);
      assert.equal((await earlyRequest(host, 'snapshot')).status, 408);
      const tooLarge = await fetch(host.baseURL + '/api/zhuma/snapshot', {
        method: 'POST',
        headers: { cookie: host.cookie, 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8192));
            controller.close();
          },
        }),
        duplex: 'half',
      });
      assert.equal(tooLarge.status, 413);
      const snapshot = await (
        await post(host, '/api/zhuma/snapshot', envelope('snapshot', {}))
      ).json();
      assert.equal(snapshot.result.ok, true);
      const command = {
        requestId: randomUUID(),
        expectedRevision: snapshot.result.value.state.revision,
        command: {
          type: 'save-project',
          project: {
            id: 'project-independent-from-space',
            name: 'Legacy project',
            description: '',
          },
        },
      };
      const saved = await (
        await post(host, '/api/zhuma/command', envelope('command', command))
      ).json();
      assert.equal(saved.result.ok, true);
      const replayed = await (
        await post(host, '/api/zhuma/command', envelope('command', command))
      ).json();
      assert.equal(replayed.result.value.receipts.length, 1);
      const files = packageFixture();
      const preview = await (
        await post(
          host,
          '/api/zhuma/preview-import',
          envelope('preview-import', { kind: 'files', files }),
        )
      ).json();
      assert.equal(preview.result.ok, true);
      const importRequest = {
        requestId: randomUUID(),
        expectedRevision: saved.result.value.revision,
        command: importCommand(preview.result.value, files),
      };
      const stored = await (
        await post(host, '/api/zhuma/command', envelope('command', importRequest))
      ).json();
      assert.equal(stored.result.ok, true);
      const expertId = stored.result.value.participants[0].id;
      const source = await (
        await post(
          host,
          '/api/zhuma/resource-files',
          envelope('resource-files', { kind: 'expert', id: expertId }),
        )
      ).json();
      assert.equal(source.result.ok, true);
      assert.ok(source.result.value.files.length > 0);
      assert.ok(
        !source.result.value.files.some((file) => /(?:USER|memory|\.env)/u.test(file.path)),
      );
      assert.equal((await host.act('inspect')).modelCalls, 0);
      proof.cases.push({
        name: 'explicit-legacy-stream-budget',
        passed: true,
        configuredTestBudgetBytes: 4096,
        configuredReadTimeoutMs: 300,
        declared413: true,
        chunked413: true,
        incomplete408: true,
        durableSingleReceipt: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1a actual Host: initial identity bootstrap failure retains the streaming fence; a corrected private record recovers on restart',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-failed-'));
    let host;
    try {
      host = await start(directory, {
        deploymentMode: 'multi-member',
        identityImport: { accounts: [] },
      });
      await host.wait('ready');
      assert.ok(
        (await host.act('inspect')).identityStates.includes(3),
        'Cordis must retain the failed identity child',
      );
      for (const endpoint of LEGACY_OWNER_ROUTES)
        assert.equal((await earlyRequest(host, endpoint)).status, 404);
      assert.equal(
        (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: host.cookie } }))
          .status,
        404,
      );
      await host.close();
      host = null;
      host = await start(directory, { deploymentMode: 'multi-member', identityImport: imported });
      await host.wait('ready');
      const member = await login(host);
      assert.equal(
        (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: member } })).status,
        200,
      );
      proof.cases.push({
        name: 'initial-identity-failure-and-recovery',
        passed: true,
        failedChildVisible: true,
        legacyFenceRetained: true,
        privateBootstrapReferenceOnly: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1a actual Host: an explicitly imported single legacy owner maps through the same identity module',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-owner-'));
    let host;
    try {
      host = await start(directory, {
        deploymentMode: 'legacy-single-user',
        identityImport: { ...imported, ownerAccountId: 'member-a' },
      });
      await host.wait('ready');
      const response = await fetch(host.baseURL + '/zhuma-id/session', {
        headers: { cookie: host.cookie },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).accountId, 'member-a');
      const snapshot = await (
        await post(host, '/api/zhuma/snapshot', envelope('snapshot', {}))
      ).json();
      assert.equal(snapshot.result.ok, true);
      proof.cases.push({
        name: 'explicit-single-owner-identity',
        passed: true,
        explicitOwnerAccount: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1a actual Host: required identity DI pending/revoked/reprovided keeps the independent legacy fence',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1a-di-'));
    let host;
    try {
      host = await start(
        directory,
        { deploymentMode: 'multi-member', identityImport: imported },
        { skipRemoteAccess: true },
      );
      await host.act('waitIdentityPending'); // Cordis PENDING: the real remoteAccess service is absent.
      for (const endpoint of LEGACY_OWNER_ROUTES)
        assert.equal((await earlyRequest(host, endpoint)).status, 404);
      await host.act('mountRemoteAccess');
      await host.wait('ready');
      await host.act('waitIdentityActive');
      const member = await login(host);
      await host.act('unmountRemoteAccess');
      await host.act('waitIdentityPending');
      for (const endpoint of LEGACY_OWNER_ROUTES)
        assert.equal((await earlyRequest(host, endpoint)).status, 404);
      await host.act('mountRemoteAccess');
      await host.act('waitIdentityActive');
      assert.equal(
        (await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: member } })).status,
        200,
      );
      const final = await host.act('inspect');
      assert.equal(final.opened.filter((name) => name === 'zhuma_workbench').length, 1);
      assert.equal(final.opened.filter((name) => name === 'zhuma_asset_packages').length, 1);
      proof.cases.push({
        name: 'actual-required-service-DI-lifecycle',
        passed: true,
        pendingAndRevokedFailClosed: true,
        reprovideRecoversPersistedSession: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'S1b actual Host: trusted directory seed, persistence, member execution and fail-closed lifecycle',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-s1b-composition-'));
    let host;
    try {
      // Seed legitimate persisted task definitions through the legacy owner entry,
      // then restart in member mode. This is test data, not a formal provider.
      host = await start(directory, { deploymentMode: 'legacy-single-user' });
      await host.wait('ready');
      const { state, task, node } = workbenchFixture();
      const member = { ...state.participants[0], id: 'member-a' };
      const ready = {
        ...task,
        participantIds: [member.id],
        ownerId: member.id,
        status: 'ready',
        workflows: [
          {
            ...task.workflows[0],
            nodes: [
              {
                ...node,
                assigneeId: member.id,
                skillIds: [],
                reviewerIds: [],
                reviewRequired: false,
              },
            ],
          },
        ],
      };
      let revision = 0;
      for (const command of [
        { type: 'save-project', project: state.projects[0] },
        { type: 'save-participant', participant: member },
        { type: 'save-task', task: ready },
      ]) {
        const response = await post(
          host,
          '/api/zhuma/command',
          envelope('command', { requestId: randomUUID(), expectedRevision: revision, command }),
        );
        assert.equal(response.status, 200);
        const saved = (await response.json()).result;
        assert.equal(saved.ok, true);
        revision = saved.value.revision;
      }
      const snapshot = await (
        await post(host, '/api/zhuma/snapshot', envelope('snapshot', {}))
      ).json();
      const plan = snapshot.result.value.state.appliedPlans.at(-1);
      const startPlan = {
        taskId: plan.taskId,
        planId: plan.id,
        revision: plan.revision,
        idempotencyKey: 'formal-host-start',
      };
      await host.close();
      host = null;
      host = await start(directory, { deploymentMode: 'multi-member', identityImport: imported });
      await host.wait('ready');
      const exec = (target, endpoint, payload, cookie) =>
        post(
          target,
          `/api/zhuma-exec/${endpoint}`,
          {
            type: 'client-request',
            rpcId: randomUUID(),
            method: `zhuma-exec/${endpoint}`,
            payload,
          },
          cookie,
        );
      assert.equal((await exec(host, 'inbox', {}, host.cookie)).status, 401);
      let memberCookie = `${host.cookie}; ${await login(host)}`;
      const denied = await (await exec(host, 'start-plan', startPlan, memberCookie)).json();
      assert.equal(denied.result.ok, false);
      assert.equal(denied.result.error.code, 'not-found');
      const counts = await host.act('inspect');
      for (const name of [
        'zhuma_workbench',
        'zhuma_asset_packages',
        'zhuma_execution',
        'zhuma_spaces',
      ])
        assert.equal(counts.opened.filter((entry) => entry === name).length, 1);
      await host.close();
      host = null;
      // A missing private record or invalid seed fails closed and leaves the
      // producer child visibly failed. Neither can borrow note memberships.
      for (const seedConfig of [
        { spaceDirectoryBootstrapKey: 'zhuma-spaces/missing' },
        { spaceDirectoryImport: { spaces: [{ id: 'invalid id', name: 'Invalid', kind: 'team' }] } },
      ]) {
        host = await start(directory, {
          deploymentMode: 'multi-member',
          identityImport: imported,
          ...seedConfig,
        });
        await host.wait('ready');
        memberCookie = `${host.cookie}; ${await login(host)}`;
        const session = await (
          await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: memberCookie } })
        ).json();
        assert.deepEqual(session.spaces, []);
        assert.ok((await host.act('inspect')).directoryStates.includes(3));
        const refused = await (await exec(host, 'start-plan', startPlan, memberCookie)).json();
        assert.equal(refused.result.ok, false);
        await host.close();
        host = null;
      }
      const spaceDirectoryImport = {
        spaces: [
          { id: 'personal-a', kind: 'personal', name: 'Notes space' },
          { id: 'personal-empty', kind: 'personal', name: 'Empty personal' },
          { id: 'team-empty', kind: 'team', name: 'Empty team' },
          { id: 'space-collaboration', kind: 'team', name: 'Project team' },
        ],
        memberships: ['personal-a', 'personal-empty', 'team-empty', 'space-collaboration'].map(
          (spaceId) => ({ spaceId, accountId: 'member-a' }),
        ),
        projectSpaces: [{ projectId: 'project', spaceId: 'space-collaboration' }],
      };
      host = await start(directory, {
        deploymentMode: 'multi-member',
        identityImport: imported,
        spaceDirectoryImport,
      });
      await host.wait('ready');
      memberCookie = `${host.cookie}; ${await login(host)}`;
      const authorized = await (
        await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: memberCookie } })
      ).json();
      assert.deepEqual(
        authorized.spaces.map((space) => space.id).sort(),
        spaceDirectoryImport.spaces.map((space) => space.id).sort(),
      );
      for (const spaceId of ['personal-empty', 'team-empty']) {
        const response = await fetch(`${host.baseURL}/zhuma-id/spaces/${spaceId}`, {
          headers: { cookie: memberCookie },
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).notes, []);
      }
      const started = await (await exec(host, 'start-plan', startPlan, memberCookie)).json();
      assert.equal(started.result.ok, true);
      const inbox = await (await exec(host, 'inbox', {}, memberCookie)).json();
      assert.equal(inbox.result.ok, true);
      assert.equal(inbox.result.value.items.length, 1);
      const current = inbox.result.value.nodes[0];
      const submitted = await (
        await exec(
          host,
          'submit',
          {
            ...startPlan,
            nodeId: current.nodeId,
            expectedVersion: current.version,
            idempotencyKey: 'formal-host-delivery',
            text: 'Contract-only text delivery',
          },
          memberCookie,
        )
      ).json();
      assert.equal(submitted.result.ok, true);
      assert.equal(submitted.result.value.node.status, 'completed');
      await host.act('revokeTestMemberships');
      for (const method of ['GET', 'PUT']) {
        const response = await fetch(host.baseURL + '/zhuma-id/notes/private-note', {
          method,
          headers: { cookie: memberCookie, 'content-type': 'application/json' },
          ...(method === 'PUT' ? { body: JSON.stringify({ text: 'must-not-persist' }) } : {}),
        });
        assert.equal(response.status, 404);
      }
      const revokedReport = await (
        await exec(
          host,
          'report',
          { taskId: plan.taskId, planId: plan.id, revision: plan.revision },
          memberCookie,
        )
      ).json();
      assert.equal(revokedReport.result.ok, false);
      await host.close();
      host = null;
      // No bootstrap source on reopen: consume the real persisted directory,
      // preserving the revocation and the empty personal/team spaces.
      host = await start(directory, { deploymentMode: 'multi-member', identityImport: imported });
      await host.wait('ready');
      memberCookie = `${host.cookie}; ${await login(host)}`;
      const restored = await (
        await fetch(host.baseURL + '/zhuma-id/session', { headers: { cookie: memberCookie } })
      ).json();
      assert.deepEqual(restored.spaces.map((space) => space.id).sort(), [
        'personal-empty',
        'team-empty',
      ]);
      assert.equal(
        (
          await fetch(host.baseURL + '/zhuma-id/notes/private-note', {
            headers: { cookie: memberCookie },
          })
        ).status,
        404,
      );
      await host.act('grantTestMemberships');
      const note = await (
        await fetch(host.baseURL + '/zhuma-id/notes/private-note', {
          headers: { cookie: memberCookie },
        })
      ).json();
      assert.equal(note.note.text, 'Synthetic private note');
      await host.act('holdProjectLookup');
      const pendingReport = exec(
        host,
        'report',
        { taskId: plan.taskId, planId: plan.id, revision: plan.revision },
        memberCookie,
      );
      await host.wait('lookup-pending');
      assert.deepEqual(await host.act('unmountDirectoryWithCloseFailure'), { registered: false });
      await host.act('releaseProjectLookup');
      const stale = await (await pendingReport).json();
      assert.equal(stale.result.ok, false);
      assert.equal(stale.result.error.code, 'unavailable');
      assert.equal(
        (
          await fetch(host.baseURL + '/zhuma-id/notes/private-note', {
            headers: { cookie: memberCookie },
          })
        ).status,
        404,
      );
      proof.cases.push({
        name: 'member-execution-composition',
        passed: true,
        singleWorkbenchDomain: true,
        ownerNeverMember: true,
        absentDirectoryClosed: true,
        trustedPersistentDirectoryConsumed: true,
        privateSeedValidated: true,
        emptySpacesAuthorized: true,
        projectAndSpaceDiffer: true,
        revocationSurvivesRestart: true,
        failedCloseAndStaleLookupClosed: true,
      });
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.after(async () => {
  for (const child of children) child.kill('SIGKILL');
  if (process.env.S1A_PROOF_FILE)
    await writeFile(process.env.S1A_PROOF_FILE, JSON.stringify(proof, null, 2) + '\n');
});
