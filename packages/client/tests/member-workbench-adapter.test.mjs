import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkbench } from '@zhuma/agent-core';
import { createMemberWorkbenchAdapter } from '../dist/index.js';

const task = () => ({
  id: 'task-a',
  projectId: 'project-a',
  title: '梳理接口',
  goal: '整理接口与数据字段',
  participantIds: ['chen'],
  ownerId: 'chen',
  status: 'draft',
  workflows: [{ id: 'root', name: '主工作流', parentNodeId: null, nodes: [] }],
  updatedAt: '2026-10-25T12:00:00.000Z',
});
function fixture() {
  const state = { ...emptyWorkbench(), tasks: [task()] };
  const snapshot = {
    actorId: 'chen',
    spaceId: 'space-a',
    space: { id: 'space-a', kind: 'team', name: '研发' },
    state,
    model: null,
    capabilities: {
      createProject: true,
      createTask: true,
      planning: false,
      resources: 'not-connected',
      tasks: [{ taskId: 'task-a', edit: true, confirm: true, plan: false }],
    },
  };
  const commands = [];
  let fail = false;
  const api = createMemberWorkbenchAdapter(
    {
      snapshot: async () => structuredClone(snapshot),
      command: async (input) => {
        commands.push(structuredClone(input));
        if (fail) throw Error('synthetic transport failure');
        return structuredClone(snapshot);
      },
      plan: async () => {
        throw Error('unexpected model call');
      },
    },
    'chen',
  );
  return {
    api,
    state,
    snapshot,
    commands,
    fail: () => {
      fail = true;
    },
  };
}

test('member adapter contract keeps explicit create intent and idempotency across a lost reply', async () => {
  const f = fixture();
  await f.api.snapshot();
  f.fail();
  const requestId = crypto.randomUUID();
  const command = { type: 'save-task', task: task() };
  for (let i = 0; i < 2; i++)
    await assert.rejects(f.api.save(0, command, requestId, 'create-task'));
  assert.deepEqual(f.commands[0], f.commands[1]);
  assert.equal(f.commands[0].command.type, 'create-task');
  assert.equal('status' in f.commands[0].command.task, false);
  assert.equal('updatedAt' in f.commands[0].command.task, false);
});

test('member template adapter captures only saved source IDs and strips local task timestamps', async () => {
  const f = fixture();
  const { workflows: _workflows, status: _status, ...seed } = task();
  const command = {
    type: 'instantiate-template',
    input: {
      templateId: 'template-a',
      task: { ...seed, id: crypto.randomUUID() },
      roleBindings: {},
      resourceBindings: {},
    },
  };
  await assert.rejects(f.api.save(0, command, crypto.randomUUID()), { code: 'unsupported' });
  await f.api.save(0, command, crypto.randomUUID(), 'create-task');
  assert.equal('updatedAt' in f.commands[0].command.input.task, false);
  const input = {
    templateId: crypto.randomUUID(),
    sourceTaskId: 'task-a',
    name: '流程',
    description: '',
  };
  await f.api.saveTemplate(1, input, crypto.randomUUID());
  assert.deepEqual(f.commands[1].command, { type: 'save-template', input });
});

test('member adapter contract confirms the saved draft by ID only and blocks unsaved changes', async () => {
  const f = fixture();
  await f.api.snapshot();
  await assert.rejects(
    f.api.save(
      0,
      { type: 'save-task', task: { ...task(), title: '未保存', status: 'ready' } },
      crypto.randomUUID(),
      'confirm-task',
    ),
    { code: 'draft-not-saved' },
  );
  assert.equal(f.commands.length, 0);
  await f.api.save(
    0,
    {
      type: 'save-task',
      task: { ...task(), status: 'ready', updatedAt: '2026-10-25T14:00:00.000Z' },
    },
    crypto.randomUUID(),
    'confirm-task',
  );
  assert.deepEqual(f.commands[0].command, { type: 'confirm-task', taskId: 'task-a' });
});

test('member adapter contract never falls back to owner operations or infers missing intent', async () => {
  const f = fixture();
  assert.equal(f.api.member.capabilities(), undefined);
  const result = await f.api.snapshot();
  assert.equal(result.model, '未配置模型');
  assert.equal(f.api.member.capabilities().planning, false);
  const unsupported = { code: 'unsupported' };
  await assert.rejects(
    f.api.save(0, { type: 'save-task', task: task() }, crypto.randomUUID()),
    unsupported,
  );
  await assert.rejects(
    f.api.save(
      0,
      { type: 'save-participant', participant: {} },
      crypto.randomUUID(),
      'update-task',
    ),
    unsupported,
  );
  await assert.rejects(f.api.previewImport({}, new AbortController().signal), unsupported);
  await assert.rejects(
    f.api.resourceFiles('expert', 'private', new AbortController().signal),
    unsupported,
  );
  assert.equal(f.commands.length, 0);
});
