import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const lin = {
  id: 'lin',
  name: '林夏',
  kind: 'human',
  role: '复核',
  capabilities: [],
  instructions: '',
  available: true,
};

function memory() {
  const nodes = new Map();
  const plans = new Map();
  const storage = {
    readNode: (key) => nodes.get(key),
    writeNode: async (key, value) => {
      nodes.set(key, structuredClone(value));
    },
    listNodes: () => [...nodes.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      plans.set(key, structuredClone(value));
    },
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
  };
  return {
    storage,
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
  };
}

function confirm() {
  const { state, task } = fixture();
  state.participants.push(lin);
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...task.workflows[0].nodes[0],
              id: 'design',
              assigneeId: 'chen',
              reviewerIds: ['lin'],
              reviewRequired: true,
              dependsOn: [],
            },
          ],
        },
      ],
      status: 'ready',
    },
  });
  return { state: ready, applied: ready.appliedPlans.at(-1) };
}

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
}

function locate(applied, extra = {}) {
  return {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    ...extra,
  };
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
}

const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);

async function opened() {
  const { state, applied } = confirm();
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  assert.equal(store.node('design').command.status, 'ready');
  return { state, applied, store, service };
}

test('the assignee reads a saved draft back from the same node, including after a return', async () => {
  const { state, applied, store, service } = await opened();
  const saved = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '草稿正文-4e1' }),
  );
  assert.equal(saved.ok, true, saved.ok ? '' : saved.error.code);
  assert.deepEqual(saved.value, { version: 1, text: '草稿正文-4e1', links: [], files: [] });
  assert.equal(JSON.stringify(saved).includes('draft-1'), false);
  const reopened = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const again = await reopened.draft(session('chen'), locate(applied));
  assert.deepEqual(again.value, saved.value);
  const node = store.node('design');
  node.command = { ...node.command, status: 'needs-revision', entryStatus: 'needs-revision' };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const returned = await reopened.draft(session('chen'), locate(applied));
  assert.equal(returned.value.text, '草稿正文-4e1');
});

test('a reviewer, another participant, and a non-deliverable node do not write', async () => {
  const { applied, store, service } = await opened();
  await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '只有执行者能看-4e1' }),
  );
  const before = JSON.stringify(store.node('design'));
  const reviewer = await service.draft(session('lin'), locate(applied));
  assert.equal(reviewer.ok, false);
  assert.equal(reviewer.error.code, 'not-assignee');
  assert.equal(JSON.stringify(reviewer).includes('只有执行者能看-4e1'), false);
  const outsider = await service.draft(
    session('outside'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-outsider', text: '代写' }),
  );
  assert.equal(outsider.ok, false);
  assert.equal(outsider.error.code, 'not-participant');
  const node = store.node('design');
  node.command = { ...node.command, status: 'in-review' };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const blocked = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-2', text: '评审中还改' }),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'not-deliverable');
  assert.equal(blocked.error.message, '这项工作现在不能保存交付草稿。');
  assert.equal(store.node('design').deliveryDraft.text, '只有执行者能看-4e1');
  assert.equal(JSON.stringify(store.node('design')).includes('评审中还改'), false);
  assert.equal(before.includes('只有执行者能看-4e1'), true);
});

test('missing task and another space return the same not-found bytes and do not write', async () => {
  const { applied, store, service } = await opened();
  const before = JSON.stringify(store.node('design'));
  const caller = session('chen', ['elsewhere']);
  const write = {
    expectedVersion: 0,
    idempotencyKey: 'draft-hidden',
    text: '不该写进去-4e1',
  };
  const hidden = await service.draft(caller, locate(applied, write));
  const missing = await service.draft(caller, { ...locate(applied, write), taskId: 'absent-task' });
  assert.equal(Buffer.compare(bytes(hidden), bytes(missing)), 0);
  assert.deepEqual(hidden, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  assert.equal(JSON.stringify(hidden).includes('absent-task'), false);
  assert.equal(JSON.stringify(hidden).includes('不该写进去-4e1'), false);
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('an illegal directory answer is the same unavailable bytes whether or not the task exists', async () => {
  const shapes = [{ ok: true, spaceId: '' }, { ok: true }, { ok: 'yes', spaceId: 5 }];
  for (const shape of shapes) {
    const { state, applied, store } = await opened();
    const node = store.node('design');
    node.handoff = null;
    await store.storage.writeNode(
      `${applied.taskId}:${applied.id}:${applied.revision}:design`,
      node,
    );
    const before = JSON.stringify(store.node('design'));
    const directory = {
      async spaceForProject() {
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const write = { expectedVersion: 0, idempotencyKey: 'draft-illegal', text: '不该写-4e1' };
    const present = await service.draft(session('chen', ['elsewhere']), locate(applied, write));
    const missing = await service.draft(session('chen', ['elsewhere']), {
      ...locate(applied, write),
      taskId: 'absent-task',
    });
    assert.equal(Buffer.compare(bytes(present), bytes(missing)), 0);
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: 'unavailable',
        message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
        details: {},
      },
    });
    assert.equal(JSON.stringify(missing).includes('absent-task'), false);
    assert.equal(JSON.stringify(missing).includes('不该写-4e1'), false);
    assert.equal(JSON.stringify(store.node('design')), before);
    assert.equal(store.node('design').deliveryDraft, undefined);
  }
});

test('a directory failure stays unavailable whether or not the node exists', async () => {
  const { state, applied, store } = await opened();
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const ask = (storage) =>
    new ExecutionService(storage, { readWorkbench: () => state }, down).draft(
      session('chen'),
      locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-down', text: '写不了' }),
    );
  const present = await ask(store.storage);
  const absent = await ask(memory().storage);
  assert.equal(Buffer.compare(bytes(present), bytes(absent)), 0);
  assert.deepEqual(present.error, {
    code: 'unavailable',
    message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
  assert.equal(store.node('design').deliveryDraft, undefined);
});

test('a disk write failure still says the record cannot be written', async () => {
  const { applied, store, service } = await opened();
  const before = JSON.stringify(store.node('design'));
  store.storage.writeNode = async () => {
    throw new Error('disk-full-4e1');
  };
  const failed = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-disk', text: '写不进去-4e1' }),
  );
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.error, {
    code: 'unavailable',
    message: '执行记录暂时写不进去，请用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(failed).includes('disk-full-4e1'), false);
  assert.equal(JSON.stringify(failed).includes('写不进去-4e1'), false);
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('a stale draft version conflicts, and the same key cannot change the text', async () => {
  const { applied, store, service } = await opened();
  const first = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '第一份' }),
  );
  assert.equal(first.value.version, 1);
  const before = JSON.stringify(store.node('design'));
  const stale = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-2', text: '被盖掉' }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'conflict');
  const mismatch = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-1', text: '另一份' }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'idempotency-mismatch');
  const replay = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '第一份' }),
  );
  assert.equal(replay.value.version, 1);
  assert.equal(replay.value.text, '第一份');
  assert.equal(JSON.stringify(store.node('design')), before);
  const next = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-2', text: '第二份' }),
  );
  assert.equal(next.value.version, 2);
  assert.equal(next.value.text, '第二份');
});

test('a successful submit clears the saved draft', async () => {
  const { applied, store, service } = await opened();
  await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '即将清掉-4e1' }),
  );
  assert.equal(store.node('design').deliveryDraft.text, '即将清掉-4e1');
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, { expectedVersion: 1, idempotencyKey: 'deliver-1' }),
    text: '正式交付',
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  assert.equal(store.node('design').deliveryDraft, undefined);
  assert.equal(JSON.stringify(store.node('design')).includes('即将清掉-4e1'), false);
});

test('an expert assignee cannot save a human delivery draft', async () => {
  const { applied, store, service } = await opened();
  const node = store.node('design');
  node.handoff = { ...node.handoff, assignee: { ...node.handoff.assignee, kind: 'expert' } };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const before = JSON.stringify(store.node('design'));
  const refused = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-expert', text: '专家草稿' }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'not-assignee');
  assert.equal(JSON.stringify(store.node('design')), before);
});
