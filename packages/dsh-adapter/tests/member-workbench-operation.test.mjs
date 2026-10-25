import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { emptyWorkbench } from '@zhuma/agent-core';
import {
  MemberWorkbenchOperations,
  memberWorkbenchOperationKey,
  MEMBER_WORKBENCH_OPERATION_LIMIT,
  MEMBER_WORKBENCH_COMPLETED_RETENTION,
} from '../dist/member-workbench-operation.js';
import {
  setup,
  request,
  signal,
  projectCommand,
  taskInput,
  rejected,
} from './member-workbench-fixture.mjs';

const intentFor = (input) => ({
  actorId: 'ann',
  spaceId: input.spaceId,
  requestId: input.requestId,
  objectId: input.command.project?.id ?? input.command.task?.id ?? input.command.taskId,
  commandType: input.command.type,
  expectedRevision: input.expectedRevision,
  fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  contextFingerprint: 'a'.repeat(64),
});

test('member intent contract: missing operation storage is read-only, denied/bad/over-budget requests persist no intent', async () => {
  const f = setup();
  const view = await f.service('ann', { operations: undefined }).snapshot({ spaceId: 'north' });
  assert.equal(view.capabilities.createProject, false);
  await assert.rejects(
    f.service('ann', { operations: undefined }).command(request(0, projectCommand()), signal()),
    rejected('unavailable'),
  );
  await assert.rejects(
    f.service('dana').command(request(0, projectCommand()), signal()),
    rejected('not-found'),
  );
  await assert.rejects(
    f.service().command(
      request(0, {
        type: 'create-project',
        project: { id: 'bad', name: 'bad', description: '', defaultParticipantIds: ['dana'] },
      }),
      signal(),
    ),
    rejected('resource-unavailable'),
  );
  assert.equal(f.intents.size, 0);
  assert.equal(f.links.size, 0);
  assert.equal(f.writes, 0);
  const state = emptyWorkbench();
  state.projects = Array.from({ length: 100 }, (_, i) => ({
    id: `full-${i}`,
    name: `Project ${i}`,
    description: '',
  }));
  const full = setup({ state });
  await assert.rejects(full.service().command(request(0, projectCommand()), signal()));
  assert.equal(full.intents.size, 0);
  assert.equal(full.links.size, 0);
});

test('member intent contract: durable intent binds the body before directory side effects, including interrupted first requests', async () => {
  const f = setup();
  const begin = f.operations.begin.bind(f.operations);
  f.operations.begin = async (intent) => {
    await begin(intent);
    throw Error('synthetic after-intent failure');
  };
  const input = request(0, projectCommand());
  await assert.rejects(f.service().command(input, signal()), /after-intent/);
  assert.equal(f.intents.size, 1);
  assert.equal([...f.intents.values()][0].state, 'pending');
  assert.equal(f.links.size, 0);
  f.operations.begin = begin;
  await assert.rejects(
    f.service('cy').command(request(0, projectCommand(), 'south'), signal()),
    rejected('not-found'),
  );
  assert.equal(f.intents.size, 1);
  const changed = {
    ...input,
    command: { ...input.command, project: { ...input.command.project, name: 'different' } },
  };
  await assert.rejects(f.service().command(changed, signal()), rejected('request-reused'));
  await f.service().command(input, signal());
  assert.equal(f.writes, 1);
  assert.equal([...f.intents.values()][0].state, 'completed');
  assert.equal([...f.intents.values()][0].resultRevision, 1);
  assert.doesNotMatch(
    JSON.stringify([...f.intents.values()]),
    /description|different|接口项目|workflows/,
  );
});

test('member intent contract: canonical receipt recovers a failed completion without another project/task/confirmed version', async () => {
  for (const type of ['create-project', 'create-task', 'confirm-task']) {
    const f = setup();
    if (type !== 'create-project')
      await f.service().command(request(0, projectCommand()), signal());
    if (type === 'confirm-task')
      await f.service().command(request(1, { type: 'create-task', task: taskInput() }), signal());
    const revision = f.workbench.snapshot().revision;
    const input = request(
      revision,
      type === 'create-project'
        ? projectCommand()
        : type === 'create-task'
          ? { type, task: taskInput() }
          : { type, taskId: 'task-one' },
    );
    const complete = f.operations.complete.bind(f.operations);
    f.operations.complete = async () => {
      throw Error('synthetic completion failure');
    };
    await assert.rejects(f.service().command(input, signal()), /completion failure/);
    assert.equal(f.workbench.snapshot().revision, revision + 1);
    assert.equal([...f.intents.values()].at(-1).state, 'pending');
    f.reopen();
    f.operations.complete = complete;
    await f.service().command(input, signal());
    await f.service().command(input, signal());
    assert.equal(f.workbench.snapshot().revision, revision + 1);
    assert.equal(f.workbench.snapshot().projects.length, 1);
    assert.equal(f.workbench.snapshot().tasks.length, type === 'create-project' ? 0 : 1);
    assert.equal(f.workbench.snapshot().appliedPlans.length, type === 'confirm-task' ? 1 : 0);
    assert.equal([...f.intents.values()].at(-1).state, 'completed');
  }
});

test('member intent contract: revoked access after pending intent prevents all later business writes', async () => {
  const f = setup();
  const input = request(0, projectCommand());
  f.failWrites(true);
  await assert.rejects(f.service().command(input, signal()));
  const before = JSON.stringify([...f.intents.values()]);
  f.grants.delete('north/ann');
  f.failWrites(false);
  await assert.rejects(f.service().command(input, signal()), rejected('not-found'));
  assert.equal(JSON.stringify([...f.intents.values()]), before);
  assert.equal(f.writes, 0);
});

test('member intent contract: a pending outcome with an evicted canonical receipt fails closed rather than applying twice', async () => {
  const f = setup();
  const input = request(0, projectCommand());
  const complete = f.operations.complete.bind(f.operations);
  f.operations.complete = async () => {
    throw Error('synthetic completion failure');
  };
  await assert.rejects(f.service().command(input, signal()));
  f.operations.complete = complete;
  for (let i = 0; i < 201; i++)
    await f.workbench.command(
      {
        requestId: randomUUID(),
        expectedRevision: i + 1,
        command: {
          type: 'save-project',
          project: { id: 'project-one', name: `edit ${i}`, description: '' },
        },
      },
      signal(),
    );
  assert.equal(
    f.workbench
      .snapshot()
      .receipts.some((r) => r.id === memberWorkbenchOperationKey(intentFor(input))),
    false,
  );
  const writes = f.writes;
  await assert.rejects(f.service().command(input, signal()), rejected('operation-unresolved'));
  assert.equal(f.writes, writes);
  assert.equal([...f.intents.values()][0].state, 'pending');
});

test('member intent contract: pending records cannot be evicted by completed retention; capacity explicitly refuses new writes', async () => {
  const rows = new Map();
  const journal = new MemberWorkbenchOperations({
    get: (key) => rows.get(key),
    values: () => [...rows.values()],
    put: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
    delete: async (key) => {
      rows.delete(key);
    },
  });
  const pending = intentFor(request(0, projectCommand('pending')));
  await journal.begin(pending);
  for (let i = 0; i <= MEMBER_WORKBENCH_COMPLETED_RETENTION; i++) {
    const intent = intentFor(request(i, projectCommand(`p-${i}`)));
    await journal.begin(intent);
    await journal.complete(intent, i + 1);
  }
  assert.equal(rows.size, MEMBER_WORKBENCH_COMPLETED_RETENTION + 1);
  assert.equal(journal.inspect(pending).state, 'pending');
  for (let i = rows.size; i < MEMBER_WORKBENCH_OPERATION_LIMIT; i++)
    await journal.begin(intentFor(request(0, projectCommand(`pending-${i}`))));
  await assert.rejects(
    journal.begin(intentFor(request(0, projectCommand('overflow')))),
    rejected('operation-limit'),
  );
  assert.equal(rows.size, MEMBER_WORKBENCH_OPERATION_LIMIT);
  assert.equal(journal.inspect(pending).state, 'pending');
});

test('member intent contract: a different create request cannot take over a reserved object, even in another space', async () => {
  const f = setup();
  const input = request(0, projectCommand());
  f.failWrites(true);
  await assert.rejects(f.service().command(input, signal()));
  f.failWrites(false);
  await assert.rejects(
    f.service().command(request(0, projectCommand()), signal()),
    rejected('conflict'),
  );
  await assert.rejects(
    f.service('cy').command(request(0, projectCommand(), 'south'), signal()),
    rejected('not-found'),
  );
  assert.equal(f.intents.size, 1);
  assert.equal(f.links.get('project-one'), 'north');
  assert.equal(f.writes, 0);
  await f.service().command(input, signal());
  assert.equal(f.writes, 1);
});

test('member intent compatibility contract: old unpinned records remain readable but cannot adopt current definitions on retry', async () => {
  for (const phase of ['pending', 'completed']) {
    const f = setup();
    const input = request(0, projectCommand());
    if (phase === 'pending') {
      f.failWrites(true);
      await assert.rejects(f.service().command(input, signal()));
      f.failWrites(false);
    } else await f.service().command(input, signal());
    const [key, original] = [...f.intents.entries()][0];
    const { contextFingerprint: _pin, ...legacy } = original;
    f.intents.set(key, legacy);
    f.reopen();
    assert.equal(
      (await f.service().snapshot({ spaceId: 'north' })).state.revision,
      phase === 'pending' ? 0 : 1,
    );
    const writes = f.writes;
    await assert.rejects(f.service().command(input, signal()), rejected('operation-unresolved'));
    assert.equal(f.writes, writes);
    assert.deepEqual(f.intents.get(key), legacy);
  }
});
