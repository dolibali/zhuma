import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  nodeRecordKey,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
import { apply, EXECUTION_BODY_BYTE_LIMIT, executionEndpoints } from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import {
  MEMBER_COOKIE_NAME,
  installMemberResolver,
  memberCredential,
} from '../dist/member-session.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function workflowNode(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function confirmed() {
  const { state, task } = fixture();
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'qa', 'outside'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            workflowNode({ id: 'design', title: '设计' }),
            workflowNode({
              id: 'publish',
              title: '发布',
              assigneeId: 'outside',
              dependsOn: ['design'],
            }),
          ],
        },
      ],
      status: 'ready',
    },
  });
  return { state: ready, applied: ready.appliedPlans.at(-1) };
}

function signedChen(ctx) {
  const secret = randomBytes(32);
  const expiresAt = Date.now() + 60_000;
  const sessionId = randomUUID();
  installMemberResolver(ctx, {
    secret,
    requestRejection: () => undefined,
    findSession: (id) => (id === sessionId ? { accountId: 'chen', expiresAt } : undefined),
    spaceIdsFor: () => ['project'],
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
  });
  return `${MEMBER_COOKIE_NAME}=${memberCredential(secret, sessionId, expiresAt)}`;
}

async function mount(options = {}) {
  const routes = [];
  const effects = [];
  const nodes = new Map(options.nodes ?? []);
  const plans = new Map(options.plans ?? []);
  let explode = '';
  let secret = false;
  const ctx = {
    effect(callback) {
      effects.push(callback());
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {};
        },
      },
    },
    storageDomain: {
      async open(spec) {
        assert.equal(spec.name, 'zhuma_execution');
        assert.equal(spec.version, 1);
        assert.deepEqual(Object.keys(spec.tables), ['nodes', 'plans']);
        spec.global.schema.parse(spec.global.initial);
        return {
          close() {},
          global: { get: () => spec.global.initial, set: async () => {} },
          table(name) {
            const table = name === 'nodes' ? nodes : plans;
            const schema = spec.tables[name].valueSchema;
            return {
              get: (key) => table.get(key),
              entries: () => {
                if (explode) throw new Error(explode);
                return table.entries();
              },
              async put(key, value) {
                schema.parse(value);
                table.set(key, structuredClone(value));
              },
            };
          },
        };
      },
    },
  };
  const cookie = signedChen(ctx);
  await apply(ctx, {
    readWorkbench() {
      if (secret) throw new Error('secret-provider-path');
      return options.workbench;
    },
    projectSpaces:
      options.projectSpaces ?? boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
  });
  return {
    routes,
    nodes,
    effects,
    cookie,
    arm(message) {
      explode = message;
    },
    leak() {
      secret = true;
    },
    async call(endpoint, payload, extra = {}) {
      const route = routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
      assert.ok(route);
      const headers = { 'content-type': extra.type ?? 'application/json' };
      if (extra.cookie !== undefined) headers.cookie = extra.cookie;
      const body =
        extra.raw ??
        JSON.stringify({
          type: 'client-request',
          rpcId: 'plugin',
          method: extra.method ?? `zhuma-exec/${endpoint}`,
          payload,
        });
      const response = await route.fetch(
        new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
          method: 'POST',
          headers,
          body,
        }),
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? undefined : JSON.parse(text),
      };
    },
  };
}

test('the execution channel is an exact fetch route and hides storage failures', async () => {
  const { state, applied } = confirmed();
  const host = await mount({ workbench: state });
  assert.deepEqual(
    host.routes.map((route) => route.path),
    executionEndpoints.map((endpoint) => `/api/zhuma-exec/${endpoint}`),
  );
  assert.equal(executionEndpoints.includes('bind-owner'), false);
  const anonymous = await host.call('inbox', {}, { cookie: undefined });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { ok: false, error: { code: 'unauthenticated' } });
  const malformed = await host.call('inbox', {}, { cookie: host.cookie, raw: '{' });
  assert.equal(malformed.status, 400);
  const wrongMethod = await host.call('inbox', {}, { cookie: host.cookie, method: 'zhuma/inbox' });
  assert.equal(wrongMethod.status, 400);
  const text = await host.call('inbox', {}, { cookie: host.cookie, type: 'text/plain', raw: '{}' });
  assert.equal(text.status, 415);

  const started = await host.call(
    'start-plan',
    {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-1',
    },
    { cookie: host.cookie },
  );
  assert.equal(started.body.result.ok, true, JSON.stringify(started.body));
  assert.equal(
    started.body.result.value.reports.find((item) => item.nodeId === 'publish').status,
    'blocked',
  );
  host.arm('secret-disk-path');
  const failed = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(failed.body.result.error.code, 'unavailable');
  assert.equal(JSON.stringify(failed).includes('secret-disk-path'), false);
  host.arm('');
  host.leak();
  const leaked = await host.call(
    'report',
    { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    { cookie: host.cookie },
  );
  assert.equal(leaked.body.result.error.code, 'unavailable');
  assert.equal(JSON.stringify(leaked).includes('secret-provider-path'), false);
  for (const dispose of host.effects) await dispose();
  const stopped = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(stopped.body.result.error.code, 'cancelled');
});

test('one corrupt stored record does not stop the channel', async () => {
  const { state, applied } = confirmed();
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  const records = started.records.map((record) => [nodeRecordKey(record), structuredClone(record)]);
  const design = records.find((entry) => entry[1].nodeId === 'design')[1];
  design.command = { ...design.command, status: 'completed' };
  design.acceptedArtifactVersionId = 'artifact-1';
  records.find((entry) => entry[1].nodeId === 'publish')[1].handoff = {};
  const host = await mount({
    workbench: state,
    nodes: records,
    plans: [
      [
        `${applied.taskId}:${applied.id}:${applied.revision}`,
        { idempotencyKey: 'start-1', fingerprint: 'kept', nodeIds: ['design', 'publish'] },
      ],
    ],
  });
  const inbox = await host.call('inbox', {}, { cookie: host.cookie });
  assert.equal(inbox.body.result.ok, true);
  const report = await host.call(
    'report',
    { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    { cookie: host.cookie },
  );
  assert.equal(report.body.result.ok, true);
  assert.equal(
    report.body.result.value.reports.some((item) => item.nodeId === 'design'),
    true,
  );
});

test('opening the channel finishes an unlock that was settled before its write', async () => {
  const { state, applied } = confirmed();
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  const design = started.records.find((record) => record.nodeId === 'design');
  const submitted = submitDelivery({
    record: design,
    actorId: 'chen',
    idempotencyKey: 'deliver-1',
    expectedVersion: design.command.version,
    draft: { text: '接口说明', files: [], links: [] },
    artifactId: 'artifact:deliver-1',
    roundId: 'round:deliver-1',
  });
  assert.equal(submitted.record.command.status, 'completed');
  const records = started.records.map((record) =>
    record.nodeId === 'design' ? submitted.record : record,
  );
  const host = await mount({
    workbench: state,
    nodes: records.map((record) => [nodeRecordKey(record), record]),
  });
  const publish = [...host.nodes.values()].find((record) => record.nodeId === 'publish');
  assert.equal(publish.command.status, 'ready');
  assert.equal(publish.handoff.inputRefs[0].sourceNodeId, 'design');
});

function postStream(host, endpoint, { cookie, stream, headers = {}, signal } = {}) {
  const route = host.routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
  return route.fetch(
    new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      body: stream,
      duplex: 'half',
      ...(signal === undefined ? {} : { signal }),
    }),
  );
}

async function primedRequest(host, endpoint, { cookie, stream, headers = {}, signal } = {}) {
  const route = host.routes.find((item) => item.path === `/api/zhuma-exec/${endpoint}`);
  const request = new Request(`http://127.0.0.1:3080/api/zhuma-exec/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    body: stream,
    duplex: 'half',
    ...(signal === undefined ? {} : { signal }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { request, fetch: () => route.fetch(request) };
}

test('an invalid session does not read the execution body', async () => {
  const host = await mount({ workbench: confirmed().state });
  let pulls = 0;
  const stream = new ReadableStream({
    pull() {
      pulls += 1;
      if (pulls > 1) throw new Error('handler read the body');
    },
  });
  const opened = await primedRequest(host, 'inbox', {
    cookie: 'zhuma-member=forged',
    stream,
  });
  const primed = pulls;
  const response = await opened.fetch();
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'unauthenticated' } });
  assert.equal(pulls, primed);
  assert.ok(primed >= 1);
});

test('a declared execution body over the transport cap is refused before it is read', async () => {
  const host = await mount({ workbench: confirmed().state });
  let pulls = 0;
  const stream = new ReadableStream({
    pull() {
      pulls += 1;
      if (pulls > 1) throw new Error('handler read the body');
    },
  });
  const opened = await primedRequest(host, 'inbox', {
    cookie: host.cookie,
    stream,
    headers: { 'content-length': String(EXECUTION_BODY_BYTE_LIMIT + 1) },
  });
  const primed = pulls;
  const response = await opened.fetch();
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-too-large' } });
  assert.equal(pulls, primed);
});

test('an execution body that grows past the transport cap is refused without waiting for the rest', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 1) return new Promise(() => {});
      controller.enqueue(new Uint8Array(EXECUTION_BODY_BYTE_LIMIT + 1));
    },
  });
  const started = Date.now();
  const response = await postStream(host, 'inbox', { cookie: host.cookie, stream });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-too-large' } });
  assert.ok(Date.now() - started < 1000);
});

test(
  'an unfinished execution body stops at 5 seconds and does not run',
  { timeout: 15_000 },
  async () => {
    const host = await mount({ workbench: confirmed().state });
    host.arm('should-not-run');
    const stream = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    const response = await postStream(host, 'inbox', { cookie: host.cookie, stream });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 408);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'body-timeout' } });
    assert.ok(elapsed >= 4_500 && elapsed < 8_000, String(elapsed));
  },
);

test('a declared body exactly at the transport cap is not refused as too large', async () => {
  const host = await mount({ workbench: confirmed().state });
  const payload = JSON.stringify({
    type: 'client-request',
    rpcId: 'plugin',
    method: 'zhuma-exec/inbox',
    payload: {},
  });
  const response = await postStream(host, 'inbox', {
    cookie: host.cookie,
    headers: { 'content-length': String(EXECUTION_BODY_BYTE_LIMIT) },
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(payload));
        controller.close();
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.ok, true);
});

test('cancelling an execution body does not run the service', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const pending = postStream(host, 'inbox', {
    cookie: host.cookie,
    stream,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.error.code, 'cancelled');
});

test('cancelling an execution body clears the read timer', async () => {
  const host = await mount({ workbench: confirmed().state });
  host.arm('should-not-run');
  const timeouts = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timeouts();
  const controller = new AbortController();
  const stream = new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  });
  const pending = postStream(host, 'inbox', {
    cookie: host.cookie,
    stream,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.error.code, 'cancelled');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeouts(), before);
});
