/** A composition with the real C consumer and controlled original protocol/model
 * metadata ports. No native Agent, paid model, Host or authority proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { createHostMemberNativeWorkflow } from '../dist/host-member-native-workflow.js';

const target = { spaceId: 'north', taskId: 'task', planId: 'plan', revision: 1 };
const model = { provider: 'synthetic', model: 'not-called', maxTokens: 4096 };
const wait = () => new AbortController().signal;
function setup(t, { started = false, available = true, remote } = {}) {
  const writes = [],
    calls = [];
  const { state, task, node } = fixture();
  state.participants[0].id = 'ann';
  state.participants.find((item) => item.id === 'qa').instructions = '独立核对固定提交。';
  task.ownerId = 'outside';
  task.participantIds = ['ann', 'outside', 'qa'];
  node.assigneeId = 'ann';
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'ready' },
  });
  confirmed.appliedPlans.at(-1).id = target.planId;
  const llm = {
    listProviders: () => [{ id: model.provider }],
    listModels: async () => [
      { provider: model.provider, id: model.model, name: 'Contract metadata' },
    ],
  };
  const ctx = { llm, get: (name) => (name === 'llm' ? llm : undefined) };
  const protocol = {
    supportsFilePublishing: false,
    canSwitchBackend: () => true,
    async negotiateWorkflow() {
      return available;
    },
    async workflowStatus(query) {
      calls.push(['status', query]);
      return structuredClone(remote);
    },
    async workflowNext() {
      return structuredClone(remote);
    },
    async workflowStart(requestId, input) {
      calls.push(['start', requestId, structuredClone(input)]);
      if (!remote?.intent)
        remote = {
          scope: { ...target, actorId: 'ann', deviceId: randomUUID() },
          state: 'waiting',
          requiresResume: false,
          activeWork: [],
          activeReviews: [],
          candidates: [],
          attention: [],
          intent: {
            intentId: randomUUID(),
            generation: 1,
            version: 1,
            defaults: input.defaults,
            budget: input.budget,
          },
        };
      return structuredClone(remote);
    },
    async workflowStop(requestId, input) {
      calls.push(['stop', requestId, structuredClone(input)]);
      remote.state = 'paused';
      remote.intent.version++;
      return structuredClone(remote);
    },
    async workflowResume(requestId, input) {
      calls.push(['resume', requestId, structuredClone(input)]);
      remote.intent.generation++;
      remote.intent.version++;
      remote.state = 'waiting';
      remote.requiresResume = false;
      return structuredClone(remote);
    },
  };
  const helper = createHostMemberNativeWorkflow(ctx, {
    protocol,
    connectionId: 'connection',
    actorId: 'ann',
    native: { canSwitchBackend: () => true },
    workspaces: {
      workflowWorkspace: () => ({ workspace: { kind: 'text-only' }, localTools: [] }),
      workflowSelection: () => ({ kind: 'text-only' }),
      choices: () => [],
    },
    hooks: {
      prepareWork: () => assert.fail('A passive read or empty candidate cannot start work'),
    },
    signal: wait(),
    current: async (signal) => signal.throwIfAborted(),
    backend: {
      async request(input) {
        assert.equal(input.connectionId, 'connection');
        let value;
        if (input.operation === 'member.snapshot')
          value = { actorId: 'ann', spaceId: 'north', state: confirmed };
        else if (input.operation === 'execution.task-progress')
          value = {
            actorId: 'ann',
            spaceId: 'north',
            coverage: 'current-confirmed-plans',
            items: [
              {
                target: { taskId: target.taskId, planId: target.planId, revision: target.revision },
                facts: started ? 'present' : 'not-started',
              },
            ],
          };
        else {
          assert.equal(input.operation, 'execution.start-plan');
          writes.push(structuredClone(input.payload));
          started = true;
          value = { disposition: 'applied', reports: [] };
        }
        return {
          body: { type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } },
        };
      },
    },
  });
  t.after(async () => {
    helper.fence();
    await helper.whenAdmissionsIdle();
    await helper.close();
  });
  return { helper, calls, writes, remote: () => remote };
}

test('member workflow Host composition: passive discovery creates no plan or consumer drive and advertises only the implemented lane', async (t) => {
  const h = setup(t);
  const view = await h.helper.handle('workflow-options', target, wait());
  assert.equal(view.state, 'inactive');
  assert.equal(view.planStarted, false);
  assert.equal(
    view.controlledNodeCount,
    1,
    'Assigned human work is available even when this member is not task owner',
  );
  assert.equal(view.expertNodeCount, 0);
  assert.equal(view.maxConcurrent, 1);
  assert.equal(view.automaticReview, false);
  assert.equal(
    view.expertReviewRequired,
    true,
    'Plan facts stay visible even though automatic review is unavailable',
  );
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.helper.canSwitchBackend(), true);
});

test('member workflow Host composition: explicit start reuses original plan start, Stop validates generation and explicit resume creates a new consumer', async (t) => {
  const h = setup(t),
    requestId = randomUUID();
  const initial = await h.helper.handle(
    'workflow-start',
    { ...target, requestId, model, workspace: { kind: 'text-only' }, concurrent: 1 },
    wait(),
  );
  assert.deepEqual(h.writes, [{ ...target, idempotencyKey: `workflow:${requestId}` }]);
  assert.equal(initial.state, 'waiting');
  assert.equal(initial.planStarted, true);
  const start = h.calls.find((item) => item[0] === 'start');
  assert.deepEqual(start[2].target, target);
  assert.equal(
    start[2].defaults.capabilities.acceptedInput,
    '1',
    'Ceiling only; actual node preparation is separately checked',
  );
  assert.equal(Object.hasOwn(start[2], 'newRunId'), false);
  await assert.rejects(
    h.helper.handle(
      'workflow-stop',
      { ...target, requestId: randomUUID(), intentId: initial.intent.intentId, generation: 99 },
      wait(),
    ),
  );
  assert.equal(
    h.calls.some((item) => item[0] === 'stop'),
    false,
  );
  const stopped = await h.helper.handle(
    'workflow-stop',
    { ...target, requestId: randomUUID(), intentId: initial.intent.intentId, generation: 1 },
    wait(),
  );
  assert.equal(stopped.state, 'paused');
  await h.helper.whenAdmissionsIdle();
  await h.helper.close();
  const resumed = await h.helper.handle(
    'workflow-resume',
    {
      ...target,
      requestId: randomUUID(),
      intentId: stopped.intent.intentId,
      generation: 1,
      expectedVersion: stopped.intent.version,
    },
    wait(),
  );
  assert.equal(resumed.intent.generation, 2);
  assert.equal(h.writes.length, 1);
});

test('member workflow Host composition: old backend capability and unsupported concurrency cannot send automatic commands', async (t) => {
  const h = setup(t, { available: false });
  await assert.rejects(h.helper.handle('workflow-read', target, wait()));
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
  const current = setup(t);
  await assert.rejects(
    current.helper.handle(
      'workflow-start',
      {
        ...target,
        requestId: randomUUID(),
        model,
        workspace: { kind: 'text-only' },
        concurrent: 2,
      },
      wait(),
    ),
  );
  assert.equal(current.writes.length, 0);
  assert.equal(current.calls.length, 0);
});
