import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionApi } from '../dist/execution/ExecutionApi.js';

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

test('inbox counts accept zero and reject a negative number', async () => {
  const zero = apiWith(() => ({
    ok: true,
    value: { deliver: 0, review: 0, confirm: 0 },
  }));
  assert.deepEqual(await zero.api.inboxCounts(), { deliver: 0, review: 0, confirm: 0 });
  assert.equal(zero.calls[0].endpoint, 'zhuma-exec/inbox-counts');
  const negative = apiWith(() => ({
    ok: true,
    value: { deliver: -1, review: 0, confirm: 0 },
  }));
  await assert.rejects(() => negative.api.inboxCounts(), /返回的待办计数不正确/);
});

test('transport failures become typed execution errors', async () => {
  const cases = [
    ['401', 'unauthenticated', '请先登录。'],
    ['403', 'untrusted-request', '这次请求不可信。'],
    ['413', 'body-too-large', '请求过大，请减少内容。'],
    ['408', 'body-timeout', '请求没有在时间内传完，请再试一次。'],
  ];
  for (const [status, code, message] of cases) {
    const { api, calls } = apiWith(() => {
      throw new Error(`transport failure for /api/zhuma-exec/inbox: HTTP ${status}`);
    });
    await assert.rejects(
      () => api.inbox(),
      (error) => error.code === code && error.message === message,
    );
    assert.equal(calls.length, 1);
  }
  const other = apiWith(() => {
    throw new Error('transport failure for /api/zhuma-exec/inbox: HTTP 500');
  });
  await assert.rejects(() => other.api.inbox(), /HTTP 500/);
});
