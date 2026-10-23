import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  nodeRecordKey,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
import { apply, executionEndpoints } from '../dist/execution-plugin.js';
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
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.result.error.code, 'unauthenticated');
  const malformed = await host.call('inbox', {}, { raw: '{' });
  assert.equal(malformed.status, 400);
  const wrongMethod = await host.call('inbox', {}, { method: 'zhuma/inbox' });
  assert.equal(wrongMethod.status, 400);
  const text = await host.call('inbox', {}, { type: 'text/plain', raw: '{}' });
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
