import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { WorkbenchSchema } from '@zhuma/agent-core';
import { WorkbenchService } from '../dist/workbench-service.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function createService(options = {}) {
  let state = options.state ?? fixture().state;
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

test('planning quality contract: repair is constrained to the exact budgeted resource candidates', async () => {
  const { state, task } = fixture();
  state.assets.push({
    ...state.assets[0],
    id: 'outside-candidates',
    name: '咖啡烘焙',
    description: '咖啡',
    content: '',
  });
  const { service, audits } = createService({ state });
  const before = service.snapshot();
  const request = {
    requestId: randomUUID(),
    taskId: task.id,
    expectedRevision: 0,
    instruction: '',
  };
  let calls = 0;
  const proposal = await service.plan(
    request,
    {
      name: 'contract-candidates',
      generate: async (_system, input) => {
        calls++;
        const captured = JSON.parse(calls === 1 ? input : JSON.parse(input).original).context;
        assert.deepEqual(
          captured.assets.map((a) => a.id),
          ['api-skill'],
        );
        if (calls === 2) assert.match(JSON.parse(input).validationErrors, /未提供/);
        const output = {
          summary: '修复资源范围',
          questions: [],
          assumptions: [],
          workflows: structuredClone(task.workflows),
        };
        if (calls === 1) output.workflows[0].nodes[0].skillIds = ['outside-candidates'];
        return JSON.stringify(output);
      },
    },
    signal(),
  );
  assert.equal(calls, 2);
  assert.deepEqual(proposal.result.workflows[0].nodes[0].skillIds, ['api-skill']);
  assert.deepEqual(service.snapshot(), before);
  assert.equal(audits.get(request.requestId).attempts.length, 2);
  assert.deepEqual(
    await service.plan(
      request,
      { name: 'unused', generate: async () => assert.fail('idempotent retry called a model') },
      signal(),
    ),
    proposal,
  );
});

test('planning quality contract: an oversized user baseline fails before model or audit writes', async () => {
  const { state, task, node } = fixture();
  task.workflows[0].nodes = Array.from({ length: 15 }, (_, index) => ({
    ...node,
    id: `large-${index}`,
    description: '完整人工说明'.repeat(1300),
  }));
  const { service, audits } = createService({ state });
  const before = service.snapshot();
  await assert.rejects(
    service.plan(
      { requestId: randomUUID(), taskId: task.id, expectedRevision: 0, instruction: '' },
      {
        name: 'never-called',
        generate: async () => assert.fail('budget rejection called a model'),
      },
      signal(),
    ),
    { code: 'context-limit' },
  );
  assert.deepEqual(service.snapshot(), before);
  assert.equal(audits.size, 0);
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

const planRequest = (overrides = {}) => ({
  requestId: randomUUID(),
  taskId: 'task',
  expectedRevision: 0,
  instruction: '',
  ...overrides,
});
const planningResult = (workflows = fixture().task.workflows) => ({
  summary: '按能力分配',
  questions: [],
  assumptions: ['沿用现有接口'],
  workflows,
});
const resultModel = (result) => ({
  name: 'contract-fixture',
  generate: async () => JSON.stringify(result),
});

test('planning adjustment contract: ten-node un-applied proposal is the full baseline, including nested work; only requested assignment changes', async () => {
  const { state, task, node } = fixture();
  task.participantIds.push('outside');
  task.workflows[0].nodes = [];
  const { service, audits } = createService({ state });
  const before = service.snapshot();
  const workflows = [
    {
      ...task.workflows[0],
      nodes: Array.from({ length: 10 }, (_, index) => ({
        ...structuredClone(node),
        id: `step-${index + 1}`,
        title: `第 ${index + 1} 步`,
        description: '保留完整工作说明。'.repeat(120),
        assigneeId: index === 2 ? 'qa' : 'chen',
        reviewerIds: ['outside'],
        dependsOn: index > 0 ? [`step-${index}`] : [],
        position: { x: index * 260, y: 80 },
      })),
    },
    {
      id: 'nested',
      name: '细化实施',
      parentNodeId: 'step-8',
      nodes: [{ ...node, id: 'nested-step' }],
    },
  ];
  const initial = await service.plan(
    planRequest(),
    resultModel(planningResult(workflows)),
    signal(),
  );
  // Resolve the reference from durable audits even in a new service instance, not a UI/session cache.
  const restarted = new WorkbenchService(
    { read: () => service.snapshot(), write: async () => assert.fail('planning wrote a workflow') },
    {
      get: (id) => audits.get(id),
      put: async (audit) => audits.set(audit.id, structuredClone(audit)),
    },
  );
  let calls = 0;
  const instruction = '第三步换陈宁，其余不变。';
  const model = {
    name: 'contract-adjustment',
    generate: async (_system, input) => {
      calls++;
      const { context } = JSON.parse(input);
      assert.equal(context.instruction, instruction);
      assert.deepEqual(context.currentWorkflows, workflows);
      assert.ok(JSON.stringify(context.currentWorkflows).length > 8000);
      assert.deepEqual(context.previousProposal, {
        id: initial.id,
        summary: initial.result.summary,
        questions: initial.result.questions,
        assumptions: initial.result.assumptions,
      });
      const adjusted = structuredClone(context.currentWorkflows);
      adjusted[0].nodes[2].assigneeId = 'chen';
      return JSON.stringify(planningResult(adjusted));
    },
  };
  const request = planRequest({ baseProposalId: initial.id, instruction });
  const adjusted = await restarted.plan(request, model, signal());
  const expected = structuredClone(workflows);
  expected[0].nodes[2].assigneeId = 'chen';
  assert.deepEqual(adjusted.result.workflows, expected);
  assert.deepEqual(service.snapshot(), before);
  assert.deepEqual(audits.get(initial.id).proposal, initial);
  assert.deepEqual(await restarted.plan(request, model, signal()), adjusted);
  assert.equal(calls, 1);
  await assert.rejects(
    restarted.plan({ ...request, baseProposalId: adjusted.id }, model, signal()),
    { code: 'request-reused' },
  );
});

test('planning adjustment contract: unknown, wrong-task and unfinished proposal references fail before model calls', async () => {
  const { state, task } = fixture();
  state.tasks.push({ ...structuredClone(task), id: 'another-task' });
  const { service, audits } = createService({ state });
  const initial = await service.plan(planRequest(), resultModel(planningResult()), signal());
  const unfinishedId = randomUUID();
  audits.set(unfinishedId, { ...audits.get(initial.id), id: unfinishedId, status: 'failed' });
  let calls = 0;
  const model = {
    name: 'must-not-run',
    generate: async () => {
      calls++;
      return '{}';
    },
  };
  for (const [reference, code] of [
    [{ baseProposalId: randomUUID() }, 'proposal-unavailable'],
    [{ baseProposalId: initial.id, taskId: 'another-task' }, 'proposal-mismatch'],
    [{ baseProposalId: unfinishedId }, 'proposal-unavailable'],
  ]) {
    await assert.rejects(service.plan(planRequest(reference), model, signal()), { code });
  }
  assert.equal(calls, 0);
  assert.equal(service.snapshot().revision, 0);
});

test('planning adjustment contract: a proposal becomes stale when the task or catalog revision changes', async () => {
  const { service } = createService();
  const initial = await service.plan(planRequest(), resultModel(planningResult()), signal());
  await service.command(
    { requestId: randomUUID(), expectedRevision: 0, command: command() },
    signal(),
  );
  const before = service.snapshot();
  await assert.rejects(
    service.plan(
      planRequest({ expectedRevision: 1, baseProposalId: initial.id }),
      { name: 'must-not-run', generate: async () => assert.fail('stale reference called model') },
      signal(),
    ),
    { code: 'conflict' },
  );
  assert.deepEqual(service.snapshot(), before);
});

test('planning adjustment contract: questions and assumptions travel separately from the full-length instruction', async () => {
  const { service } = createService();
  const result = { ...planningResult([]), questions: ['需要哪个成员确认范围？'] };
  const initial = await service.plan(planRequest(), resultModel(result), signal());
  const instruction = '请陈宁确认范围。'.padEnd(8000, '补');
  await service.plan(
    planRequest({ baseProposalId: initial.id, instruction }),
    {
      name: 'contract-answer',
      generate: async (_system, input) => {
        const { context } = JSON.parse(input);
        assert.equal(context.instruction, instruction);
        assert.deepEqual(context.currentWorkflows, []);
        assert.deepEqual(context.previousProposal.questions, result.questions);
        assert.deepEqual(context.previousProposal.assumptions, result.assumptions);
        return JSON.stringify(planningResult());
      },
    },
    signal(),
  );
  assert.equal(service.snapshot().revision, 0);
});

test('planning adjustment contract: failed or cancelled replacements retain the original proposal and persisted workflow', async () => {
  const { service, audits } = createService();
  const initial = await service.plan(planRequest(), resultModel(planningResult()), signal());
  const before = service.snapshot();
  const originalAudit = structuredClone(audits.get(initial.id));
  const failure = planRequest({ baseProposalId: initial.id });
  await assert.rejects(
    service.plan(
      failure,
      {
        name: 'failure',
        generate: async () => {
          throw Error('model unavailable');
        },
      },
      signal(),
    ),
    /model unavailable/,
  );
  const controller = new AbortController();
  const cancellation = planRequest({ baseProposalId: initial.id });
  await assert.rejects(
    service.plan(
      cancellation,
      {
        name: 'cancelled',
        generate: async () => {
          controller.abort();
          return JSON.stringify(planningResult());
        },
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(audits.get(failure.requestId).status, 'failed');
  assert.equal(audits.get(cancellation.requestId).status, 'failed');
  assert.deepEqual(audits.get(initial.id), originalAudit);
  assert.deepEqual(service.snapshot(), before);
  const retry = await service.plan(
    planRequest({ baseProposalId: initial.id }),
    resultModel(planningResult()),
    signal(),
  );
  assert.deepEqual(retry.result, initial.result);
});
