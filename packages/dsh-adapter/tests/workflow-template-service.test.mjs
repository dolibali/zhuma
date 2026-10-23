import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { captureWorkflowTemplate, WorkbenchSchema } from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function setup() {
  const { state, task } = fixture();
  const definition = captureWorkflowTemplate(task, state);
  state.assets.push({
    id: 'template',
    kind: 'template',
    name: '接口流程',
    description: '',
    content: JSON.stringify(definition),
    available: true,
  });
  let saved = WorkbenchSchema.parse(state);
  let writes = 0;
  let fail = false;
  const storage = {
    read: () => saved,
    write: async (next) => {
      writes++;
      if (fail) throw Error('test write failure');
      saved = structuredClone(next);
    },
  };
  const audits = {
    get: () => undefined,
    put: async () => assert.fail('instantiation wrote planning audit'),
  };
  const service = new WorkbenchService(storage, audits);
  const request = {
    requestId: randomUUID(),
    expectedRevision: 0,
    command: {
      type: 'instantiate-template',
      input: {
        templateId: 'template',
        task: {
          id: randomUUID(),
          projectId: task.projectId,
          title: '新接口',
          goal: '复用接口流程',
          participantIds: task.participantIds,
          ownerId: 'chen',
          updatedAt: task.updatedAt,
        },
        roleBindings: Object.fromEntries(definition.roles.map((r, i) => [r.id, ['chen', 'qa'][i]])),
        resourceBindings: Object.fromEntries(definition.resources.map((r) => [r.id, 'api-skill'])),
      },
    },
  };
  return {
    service,
    request,
    storage,
    audits,
    writes: () => writes,
    fail: (value) => {
      fail = value;
    },
  };
}

test('template service: durable retry and restart return the same single task/graph receipt', async () => {
  const { service, request, storage, audits, writes } = setup();
  const [first, retry] = await Promise.all([
    service.command(request, AbortSignal.timeout(5000)),
    service.command(request, AbortSignal.timeout(5000)),
  ]);
  assert.deepEqual(retry, first);
  assert.equal(writes(), 1);
  const restarted = new WorkbenchService(storage, audits);
  assert.deepEqual(await restarted.command(request, AbortSignal.timeout(5000)), first);
  assert.equal(writes(), 1);
  const task = first.tasks.find((t) => t.id === request.command.input.task.id);
  assert.equal(task.status, 'draft');
  assert.equal(first.tasks.length, 2);
  await assert.rejects(
    restarted.command(
      { ...request, requestId: randomUUID(), expectedRevision: first.revision },
      AbortSignal.timeout(5000),
    ),
    { code: 'task-exists' },
  );
  assert.equal(writes(), 1);
});

test('template service: failed durability leaves no partial instance; same request can retry safely', async () => {
  const { service, request, fail, writes } = setup();
  const before = service.snapshot();
  fail(true);
  await assert.rejects(service.command(request, AbortSignal.timeout(5000)), /test write failure/);
  assert.deepEqual(service.snapshot(), before);
  fail(false);
  const after = await service.command(request, AbortSignal.timeout(5000));
  assert.equal(after.revision, 1);
  assert.equal(after.tasks.length, before.tasks.length + 1);
  assert.equal(writes(), 2);
  assert.deepEqual(after.assets, before.assets);
});
