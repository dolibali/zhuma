import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { WorkbenchSchema } from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function createService(options = {}) {
  let state = fixture().state;
  const audits = new Map();
  const service = new WorkbenchService(
    {
      read: () => state,
      write: async (next) => {
        if (options.failWrite) throw Error('disk full');
        state = next;
      },
    },
    {
      get: (id) => audits.get(id),
      put: async (value) => {
        audits.set(value.id, structuredClone(value));
      },
    },
  );
  return { service, audits };
}
const signal = () => new AbortController().signal;
const command = (name = '新项目') => ({
  type: 'save-project',
  project: { id: 'new-project', name, description: '' },
});

test('durable commands: concurrent stale writer is rejected; retries are idempotent', async () => {
  const { service } = createService();
  const request = { requestId: randomUUID(), expectedRevision: 0, command: command() };
  const [first, stale] = await Promise.allSettled([
    service.command(request, signal()),
    service.command({ ...request, requestId: randomUUID() }, signal()),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason.code, 'conflict');
  assert.equal((await service.command(request, signal())).revision, 1);
  await assert.rejects(
    service.command({ ...request, command: command('different') }, signal()),
    (e) => e.code === 'request-reused',
  );
});

test('durable commands: failed storage and cancelled requests preserve prior state', async () => {
  const { service } = createService({ failWrite: true });
  const request = { requestId: randomUUID(), expectedRevision: 0, command: command() };
  await assert.rejects(service.command(request, signal()), /disk full/);
  assert.equal(service.snapshot().revision, 0);
  await assert.rejects(service.command(request, AbortSignal.abort()));
  assert.equal(service.snapshot().projects.length, 1);
});

test('durable commands: legacy ownerless receipt survives schema defaults without a second write', async () => {
  const { state, task } = fixture();
  delete task.ownerId;
  const legacyCommand = { type: 'save-task', task };
  const requestId = randomUUID();
  state.revision = 1;
  state.receipts = [
    {
      id: requestId,
      revision: 1,
      fingerprint: createHash('sha256').update(JSON.stringify(legacyCommand)).digest('hex'),
    },
  ];
  const loaded = WorkbenchSchema.parse(state);
  let writes = 0;
  const service = new WorkbenchService(
    {
      read: () => loaded,
      write: async () => {
        writes++;
      },
    },
    { get: () => undefined, put: async () => {} },
  );
  const request = { requestId, expectedRevision: 0, command: legacyCommand };
  assert.equal((await service.command(request, signal())).revision, 1);
  assert.equal(
    (
      await service.command(
        { ...request, command: { ...legacyCommand, task: { ...task, ownerId: null } } },
        signal(),
      )
    ).tasks[0].ownerId,
    null,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    service.command(
      { ...request, command: { ...legacyCommand, task: { ...task, ownerId: 'chen' } } },
      signal(),
    ),
    { code: 'request-reused' },
  );
});

test('planning contract: bounded repair with saved inputs, result remains a proposal and repeat does not call model', async () => {
  const { service, audits } = createService();
  let calls = 0;
  const model = {
    name: 'contract-fixture',
    generate: async (_system, input) => {
      calls++;
      if (calls === 1) return '{broken';
      assert.match(input, /validationErrors/);
      return JSON.stringify({
        summary: '按能力分配',
        questions: [],
        assumptions: [],
        workflows: fixture().task.workflows,
      });
    },
  };
  const request = { requestId: randomUUID(), taskId: 'task', expectedRevision: 0, instruction: '' };
  const result = await service.plan(request, model, signal());
  assert.equal(calls, 2);
  assert.equal(result.baseRevision, 0);
  assert.equal(service.snapshot().revision, 0);
  assert.equal(service.snapshot().tasks[0].status, 'draft');
  assert.equal(audits.get(request.requestId).attempts.length, 2);
  assert.deepEqual(await service.plan(request, model, signal()), result);
  assert.equal(calls, 2);
});

test('planning contract: failed repair does not replace workflow and stops after two calls', async () => {
  const { service, audits } = createService();
  let calls = 0;
  const request = { requestId: randomUUID(), taskId: 'task', expectedRevision: 0, instruction: '' };
  await assert.rejects(
    service.plan(
      request,
      {
        name: 'fixture',
        generate: async () => {
          calls++;
          return '{}';
        },
      },
      signal(),
    ),
  );
  assert.equal(calls, 2);
  assert.equal(service.snapshot().revision, 0);
  assert.equal(audits.get(request.requestId).status, 'failed');
});

test('planning contract: cancellation and stale input never call the model or apply a plan', async () => {
  const { service } = createService();
  let calls = 0;
  const model = {
    name: 'fixture',
    generate: async () => {
      calls++;
      return '{}';
    },
  };
  const request = { requestId: randomUUID(), taskId: 'task', expectedRevision: 0, instruction: '' };
  await assert.rejects(service.plan(request, model, AbortSignal.abort()));
  await assert.rejects(
    service.plan({ ...request, requestId: randomUUID(), expectedRevision: 8 }, model, signal()),
    (e) => e.code === 'conflict',
  );
  assert.equal(calls, 0);
  assert.equal(service.snapshot().revision, 0);
});
