import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionApi, ExecutionError } from '../dist/execution/ExecutionApi.js';

const node = {
  nodeId: 'design',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  version: 2,
  status: 'in-review',
  goal: '设计登录接口',
  expectedOutput: '接口说明',
  assigneeId: 'chen',
  reviewerIds: ['lin'],
  currentRoundId: 'round-1',
  artifacts: [{ id: 'artifact-1', version: 1, text: '第一版接口说明' }],
  rounds: [
    {
      id: 'round-1',
      status: 'open',
      artifactVersionId: 'artifact-1',
      reviewerIds: ['lin'],
      ballots: [],
    },
  ],
  comments: [],
};

const item = {
  id: 'inbox-1',
  kind: 'deliver',
  actorId: 'chen',
  nodeId: 'design',
  taskId: 'task',
  reason: 'assignee-delivery',
  action: 'submit',
};

function apiWith(handler) {
  const calls = [];
  const api = createExecutionApi({
    async call(channel, endpoint, payload, signal) {
      calls.push({ channel, endpoint, payload, signal });
      return handler(endpoint, payload);
    },
  });
  return { api, calls };
}

test('execution RPC uses the peer channel and never sends an actor field', async () => {
  const controller = new AbortController();
  const { api, calls } = apiWith(() => ({
    ok: true,
    value: { disposition: 'applied', node },
  }));
  const draft = {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    expectedVersion: 2,
    idempotencyKey: 'deliver-1',
    text: '接口说明',
    files: [],
    links: [],
  };
  assert.equal((await api.submit(draft, controller.signal)).nodeId, 'design');
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'zhuma-exec/submit');
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(JSON.stringify(calls[0].payload).includes('actorId'), false);
  assert.equal(JSON.stringify(calls[0].payload).includes('reviewerId'), false);
  assert.equal(calls[0].payload.idempotencyKey, 'deliver-1');

  await assert.rejects(
    () =>
      api.submit({
        ...draft,
        files: [
          {
            id: 'notes',
            mediaType: 'text/plain',
            byteSize: 4,
            checksum: 'abc',
            accessPolicyId: 'task-read',
            uploadComplete: true,
            memberId: 'chen',
          },
        ],
      }),
    (error) => error.code === 'actor-from-body' && calls.length === 1,
  );
  const failed = apiWith(() => ({
    ok: false,
    error: { code: 'conflict', message: '内容已变化，请刷新后再试。', details: {} },
  }));
  await assert.rejects(
    () =>
      failed.api.ballot({
        ...draft,
        roundId: 'round-1',
        artifactVersionId: 'artifact-1',
        action: 'approve',
      }),
    (error) => error.code === 'conflict',
  );
  assert.equal(failed.calls[0].endpoint, 'zhuma-exec/ballot');
  assert.equal('reviewerId' in failed.calls[0].payload, false);
});

test('inbox parsing keeps the server actor and rejects a malformed node', async () => {
  const { api } = apiWith(() => ({
    ok: true,
    value: { actorId: 'chen', items: [item], nodes: [node] },
  }));
  const inbox = await api.inbox();
  assert.equal(inbox.actorId, 'chen');
  assert.equal(inbox.items[0].action, 'submit');
  assert.equal(inbox.nodes[0].version, 2);
  const broken = apiWith(() => ({ ok: true, value: { actorId: 'chen', items: [], nodes: [{}] } }));
  await assert.rejects(
    () => broken.api.inbox(),
    (error) => error.code === 'validation',
  );
});

test('a very deep file list is a validation error and is not sent', async () => {
  const { api, calls } = apiWith(() => ({ ok: true, value: { disposition: 'applied', node } }));
  const deep = [];
  let cursor = deep;
  for (let index = 0; index < 20000; index += 1) {
    const next = [];
    cursor.push(next);
    cursor = next;
  }
  await assert.rejects(
    () =>
      api.submit({
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        nodeId: 'design',
        expectedVersion: 2,
        idempotencyKey: 'deep',
        files: deep,
      }),
    (error) => error.code === 'validation',
  );
  assert.equal(calls.length, 0);
});

const start = { taskId: 'task', planId: 'plan', revision: 1, idempotencyKey: 'start-1' };
const report = {
  nodeId: 'design',
  taskId: 'task',
  workflowVersionId: 'plan',
  revision: 1,
  status: 'ready',
  upstreamAffected: false,
};
test('explicit start preserves exact plan reference, receipt and cancellation without impersonation', async () => {
  const { api, calls } = apiWith(() => ({
    ok: true,
    value: { disposition: 'started', reports: [report] },
  }));
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  assert.deepEqual(await api.startPlan({ ...start, actorId: 'spoof' }, controller.signal), {
    disposition: 'started',
    reports: [report],
  });
  assert.equal(calls[0].endpoint, 'zhuma-exec/start-plan');
  assert.deepEqual(calls[0].payload, start);
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(await api.startPlan(start), { disposition: 'started', reports: [report] });
  assert.equal(calls[1].payload.idempotencyKey, calls[0].payload.idempotencyKey);
});

test('service errors preserve code, message and structured conflict details', async () => {
  for (const code of [
    'conflict',
    'unavailable',
    'stale-round',
    'stale-version',
    'unauthenticated',
    'files-not-accepted',
  ]) {
    const details = { expectedVersion: 2, actualVersion: 3 };
    const { api } = apiWith(() => ({
      ok: false,
      error: { code, message: '请刷新后重试。', details },
    }));
    await assert.rejects(
      api.startPlan(start),
      (error) =>
        error instanceof ExecutionError &&
        error.code === code &&
        error.message === '请刷新后重试。' &&
        assert.deepEqual(error.details, details) === undefined,
    );
  }
});

test('malformed RPC envelopes and receipts from another plan are rejected', async () => {
  for (const response of [
    undefined,
    {},
    { ok: false, error: { code: 'x', message: 'x' } },
    { ok: true, value: { disposition: 'started', reports: [{}] } },
  ]) {
    const { api } = apiWith(() => response);
    await assert.rejects(api.startPlan(start), (error) => error.code === 'validation');
  }
  const { api } = apiWith(() => ({ ok: true, value: { node: { ...node, planId: 'other' } } }));
  await assert.rejects(
    api.submit({ ...start, nodeId: node.nodeId, expectedVersion: 2, text: '正文' }),
    (error) => error.code === 'validation',
  );
});

test('comment-only reviews use the real ballot action and link-only artifacts stay readable', async () => {
  const linkedNode = {
    ...node,
    artifacts: [{ ...node.artifacts[0], links: ['https://example.com/design'] }],
  };
  const { api, calls } = apiWith(() => ({ ok: true, value: { node: linkedNode } }));
  const value = await api.ballot({
    ...start,
    nodeId: 'design',
    expectedVersion: 2,
    roundId: 'round-1',
    artifactVersionId: 'artifact-1',
    action: 'comment',
    comment: '补充一个例子',
  });
  assert.equal(calls[0].payload.action, 'comment');
  assert.deepEqual(value.artifacts[0].links, ['https://example.com/design']);
});

test('the runnable preview uses valid service projections for delivery, review and revision', async () => {
  const { reviewNode, deliveryNode, reviseNode, inbox } =
    await import('./browser/execution-fixture.mjs');
  const fixture = inbox([reviewNode, deliveryNode, reviseNode]);
  const { api } = apiWith(() => ({ ok: true, value: fixture }));
  const value = await api.inbox();
  assert.deepEqual(
    value.items.map((item) => item.action),
    ['review', 'submit', 'revise'],
  );
  assert.ok(value.nodes[0].reviewerIds.includes(value.actorId));
  assert.equal(value.nodes[1].assigneeId, value.actorId);
  assert.equal(value.nodes[2].status, 'needs-revision');
});

const startablePlan = { taskId: 'task', planId: 'plan', revision: 1, title: '已确认接口计划' };
test('typed startable discovery reads exact references without starting or sending an actor', async () => {
  const { api, calls } = apiWith(() => ({
    ok: true,
    value: { actorId: 'chen', plans: [startablePlan] },
  }));
  const controller = new AbortController();
  assert.deepEqual(await api.startable(controller.signal), {
    actorId: 'chen',
    plans: [startablePlan],
  });
  assert.equal(calls[0].endpoint, 'zhuma-exec/startable');
  assert.equal(calls[0].channel, '/api');
  assert.deepEqual(calls[0].payload, {});
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls.length, 1);
});

test('catalog parsing rejects ambiguous or malformed references while retaining distinct task/plan/revision identities', async () => {
  for (const value of [
    {},
    { actorId: 'chen', plans: [startablePlan, startablePlan] },
    { actorId: 'chen', plans: [{ ...startablePlan, revision: 0 }] },
    { actorId: 'chen', plans: [{ ...startablePlan, planId: '' }] },
    { actorId: 'chen', plans: [{ ...startablePlan, title: '' }] },
  ]) {
    const { api } = apiWith(() => ({ ok: true, value }));
    await assert.rejects(api.startable(), (error) => error.code === 'validation');
  }
  const plans = [
    startablePlan,
    { ...startablePlan, taskId: 'other-task' },
    { ...startablePlan, planId: 'other-plan' },
    { ...startablePlan, revision: 2 },
  ];
  const { api } = apiWith(() => ({ ok: true, value: { actorId: 'chen', plans } }));
  assert.deepEqual((await api.startable()).plans, plans);
});
