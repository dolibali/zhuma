/** A composition with the real C consumer and controlled original protocol/model
 * metadata ports. No native Agent, paid model, Host or authority proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { createHostMemberNativeWorkflow } from '../dist/host-member-native-workflow.js';
import { memberNativeWorkspaceSchema } from '../dist/host-member-native-workspaces.js';

const target = { spaceId: 'north', taskId: 'task', planId: 'plan', revision: 1 };
const model = { provider: 'synthetic', model: 'not-called', maxTokens: 4096 };
const wait = () => new AbortController().signal;
function setup(
  t,
  {
    started = false,
    available = true,
    remote,
    review = false,
    owner = 'outside',
    assignee = 'ann',
    knowledge = false,
    failPendingOnce = false,
    workspaces,
    filePublishing = false,
  } = {},
) {
  const writes = [],
    calls = [];
  const { state, task, node } = fixture();
  state.participants[0].id = 'ann';
  state.participants.find((item) => item.id === 'qa').instructions = '独立核对固定提交。';
  task.ownerId = owner;
  task.participantIds = ['ann', 'outside', 'qa'];
  node.assigneeId = assignee;
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
    supportsFilePublishing: filePublishing,
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
    async pendingWorkflowAccept(input) {
      calls.push(['pending', structuredClone(input)]);
      if (failPendingOnce) {
        failPendingOnce = false;
        throw Error('Original recovery read temporarily unavailable');
      }
      return undefined;
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
      remote.requiresResume = false;
      remote.intent.version++;
      return structuredClone(remote);
    },
    async workflowResume(requestId, input) {
      calls.push(['resume', requestId, structuredClone(input)]);
      remote.intent.generation++;
      remote.intent.version++;
      if (input.defaults !== undefined) remote.intent.defaults = structuredClone(input.defaults);
      remote.state = 'waiting';
      remote.requiresResume = false;
      return structuredClone(remote);
    },
  };
  const native = {
    canSwitchBackend: () => true,
    ...(knowledge ? { knowledgeSource: 'zhuma-native-knowledge@1' } : {}),
    ...(filePublishing ? { outputFileSource: 'zhuma-native-output-file@1' } : {}),
  };
  const helper = createHostMemberNativeWorkflow(ctx, {
    protocol,
    connectionId: 'connection',
    actorId: 'ann',
    native,
    ...(review ? { review: { canSwitchBackend: () => true } } : {}),
    workspaces: workspaces ?? {
      workflowWorkspace: () => ({ workspace: { kind: 'text-only' }, localTools: [] }),
      workflowSelection: () => ({ kind: 'text-only' }),
      choices: () => [],
    },
    hooks: {
      prepareWork: () => assert.fail('A passive read or empty candidate cannot start work'),
      ...(review
        ? { prepareReview: () => assert.fail('An empty candidate cannot start review') }
        : {}),
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
  return { helper, calls, writes, native, remote: () => remote };
}

test('member workflow publication: new Start freezes ranges and explicit Resume changes only future workspace defaults on the same intent', async (t) => {
  const workspaces = {
    workflowWorkspace(raw) {
      const input = memberNativeWorkspaceSchema.parse(raw);
      return input.kind === 'text-only'
        ? { workspace: input, localTools: [] }
        : {
            workspace: {
              kind: 'local',
              rootId: 'original-root',
              access: 'write',
              ...(input.publish.length ? { publish: input.publish } : {}),
            },
            localTools: [],
          };
    },
    workflowSelection(workspace) {
      return workspace.kind === 'text-only'
        ? workspace
        : {
            kind: 'local',
            id: 'local-root',
            ...(workspace.publish === undefined
              ? {}
              : { publish: structuredClone(workspace.publish) }),
          };
    },
    choices: () => [
      {
        id: 'local-root',
        label: 'Original root',
        access: 'write',
        publish: false,
        publication: 'per-run',
      },
    ],
  };
  const h = setup(t, { workspaces, filePublishing: true, review: true });
  const start = await h.helper.handle(
    'workflow-start',
    {
      ...target,
      requestId: randomUUID(),
      model,
      workspace: {
        kind: 'local',
        id: 'local-root',
        publish: [{ kind: 'directory', path: 'outputs' }],
      },
      concurrent: 1,
      automaticRevisions: 1,
    },
    wait(),
  );
  assert.deepEqual(h.remote().intent.defaults.workspace.publish, [
    { kind: 'directory', path: 'outputs' },
  ]);
  assert.deepEqual(start.selection.workspace.publish, [{ kind: 'directory', path: 'outputs' }]);
  h.remote().revisions = [{ nodeId: 'node-1', used: 1, limit: 1 }];
  const pause = () =>
    h.helper.handle(
      'workflow-stop',
      {
        ...target,
        requestId: randomUUID(),
        intentId: h.remote().intent.intentId,
        generation: h.remote().intent.generation,
      },
      wait(),
    );
  await pause();
  h.native.knowledgeSource = 'zhuma-native-knowledge@1';
  const resume = {
    ...target,
    requestId: randomUUID(),
    intentId: h.remote().intent.intentId,
    generation: h.remote().intent.generation,
    expectedVersion: h.remote().intent.version,
  };
  const updated = await h.helper.handle(
    'workflow-resume',
    {
      ...resume,
      workspace: {
        kind: 'local',
        id: 'local-root',
        publish: [{ kind: 'file', path: 'outputs/report.txt' }],
      },
    },
    wait(),
  );
  const signed = h.calls.filter((row) => row[0] === 'resume').at(-1)[2];
  assert.deepEqual(signed.defaults.workspace.publish, [
    { kind: 'file', path: 'outputs/report.txt' },
  ]);
  assert.equal(
    'knowledge' in signed.defaults.capabilities,
    false,
    'Changing a file grant cannot add a newly available knowledge ceiling',
  );
  assert.equal('budget' in signed, false);
  assert.equal(updated.intent.intentId, start.intent.intentId);
  assert.equal(updated.intent.automaticRevisions, 1);
  assert.deepEqual(updated.revisions, [{ nodeId: 'node-1', used: 1, limit: 1 }]);
  await pause();
  await h.helper.handle(
    'workflow-resume',
    {
      ...resume,
      requestId: randomUUID(),
      generation: h.remote().intent.generation,
      expectedVersion: h.remote().intent.version,
    },
    wait(),
  );
  assert.equal('defaults' in h.calls.filter((row) => row[0] === 'resume').at(-1)[2], false);
  assert.deepEqual(h.remote().intent.defaults.workspace.publish, [
    { kind: 'file', path: 'outputs/report.txt' },
  ]);
  await assert.rejects(
    h.helper.handle(
      'workflow-resume',
      {
        ...resume,
        workspace: {
          kind: 'local',
          id: 'local-root',
          publish: [{ kind: 'directory', path: '../private' }],
        },
      },
      wait(),
    ),
  );
  h.remote().state = 'stopping';
  const writes = h.calls.filter((row) => row[0] === 'resume').length;
  await assert.rejects(
    h.helper.handle('workflow-resume', { ...resume, workspace: { kind: 'text-only' } }, wait()),
    { code: 'run-authority-unavailable' },
  );
  assert.equal(h.calls.filter((row) => row[0] === 'resume').length, writes);
});

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

test('member workflow Host composition: the original reader descriptor is only a ceiling and carries no draft or read assertions', async (t) => {
  const h = setup(t, { knowledge: true });
  await h.helper.handle(
    'workflow-start',
    { ...target, requestId: randomUUID(), model, workspace: { kind: 'text-only' }, concurrent: 1 },
    wait(),
  );
  const defaults = h.calls.find((call) => call[0] === 'start')[2].defaults;
  assert.equal(defaults.capabilities.knowledge, 'zhuma-native-knowledge@1');
  for (const key of ['allowDrafts', 'libraryId', 'projectKnowledge', 'reads'])
    assert.equal(Object.hasOwn(defaults, key), false);
});

test('member workflow Host composition: explicit rework budget survives Stop/Resume and actual review holds remain visible', async (t) => {
  const h = setup(t, { review: true });
  const initial = await h.helper.handle(
    'workflow-start',
    {
      ...target,
      requestId: randomUUID(),
      model,
      workspace: { kind: 'text-only' },
      concurrent: 1,
      automaticRevisions: 2,
    },
    wait(),
  );
  assert.equal(initial.automaticReview, true);
  assert.equal(initial.intent.automaticRevisions, 2);
  h.remote().revisions = [{ nodeId: 'node-1', used: 1, limit: 2 }];
  const held = { resources: 'held' };
  h.remote().activeReviews.push(held);
  const observed = await h.helper.handle('workflow-read', target, wait());
  assert.equal(observed.activeRunCount, 1);
  assert.deepEqual(observed.revisions, [{ nodeId: 'node-1', used: 1, limit: 2 }]);
  h.remote().attention.push({ nodeId: 'node', code: 'rework-budget-exhausted' });
  assert.match((await h.helper.handle('workflow-read', target, wait())).attention, /2 轮/u);
  held.resources = 'settled';
  const paused = await h.helper.handle(
    'workflow-stop',
    {
      ...target,
      requestId: randomUUID(),
      intentId: initial.intent.intentId,
      generation: initial.intent.generation,
    },
    wait(),
  );
  const resumed = await h.helper.handle(
    'workflow-resume',
    {
      ...target,
      requestId: randomUUID(),
      intentId: paused.intent.intentId,
      generation: paused.intent.generation,
      expectedVersion: paused.intent.version,
    },
    wait(),
  );
  assert.equal(resumed.intent.automaticRevisions, 2);
  assert.deepEqual(resumed.revisions, [{ nodeId: 'node-1', used: 1, limit: 2 }]);
  assert.equal(h.calls.filter((item) => item[0] === 'start').length, 1);
  assert.equal('budget' in h.calls.find((item) => item[0] === 'resume')[2], false);
});

test('member workflow Host composition: review-only owner keeps a separate control count without claiming authorship', async (t) => {
  const h = setup(t, { owner: 'ann', assignee: 'outside', review: true });
  const view = await h.helper.handle('workflow-options', target, wait());
  assert.equal(view.controlledNodeCount, 0);
  assert.equal(view.controlledReviewNodeCount, 1);
  assert.equal(view.automaticReview, true);
  assert.equal(h.writes.length, 0);
});

test('member workflow Host composition: cold reads never reconcile, and explicit Stop checks generation before the same consumer recovery and stop', async (t) => {
  const original = setup(t);
  const initial = await original.helper.handle(
    'workflow-start',
    {
      ...target,
      requestId: randomUUID(),
      model,
      workspace: { kind: 'text-only' },
      concurrent: 1,
    },
    wait(),
  );
  const cold = structuredClone(original.remote());
  cold.state = 'requires-resume';
  cold.requiresResume = true;
  const h = setup(t, { started: true, remote: cold });
  await h.helper.handle('workflow-read', target, wait());
  assert.equal(h.calls.filter((row) => row[0] === 'pending').length, 0);
  await assert.rejects(
    h.helper.handle(
      'workflow-stop',
      {
        ...target,
        requestId: randomUUID(),
        intentId: initial.intent.intentId,
        generation: 2,
      },
      wait(),
    ),
  );
  assert.equal(h.calls.filter((row) => row[0] === 'pending').length, 0);
  const stopped = await h.helper.handle(
    'workflow-stop',
    {
      ...target,
      requestId: randomUUID(),
      intentId: initial.intent.intentId,
      generation: 1,
    },
    wait(),
  );
  assert.equal(stopped.state, 'paused');
  assert.equal(h.calls.filter((row) => row[0] === 'pending').length, 2);
  assert.equal(h.calls.filter((row) => row[0] === 'stop').length, 1);
  assert.equal(h.calls.filter((row) => row[0] === 'start' || row[0] === 'resume').length, 0);
});

test('member workflow Host composition: a failed cold recovery stays retryable only through explicit Stop without arming or replacing its consumer', async (t) => {
  const original = setup(t);
  await original.helper.handle(
    'workflow-start',
    { ...target, requestId: randomUUID(), model, workspace: { kind: 'text-only' }, concurrent: 1 },
    wait(),
  );
  const cold = structuredClone(original.remote());
  cold.state = 'requires-resume';
  cold.requiresResume = true;
  const h = setup(t, { started: true, remote: cold, failPendingOnce: true }),
    command = {
      ...target,
      requestId: randomUUID(),
      intentId: cold.intent.intentId,
      generation: cold.intent.generation,
    };
  await assert.rejects(h.helper.handle('workflow-stop', command, wait()));
  assert.equal(h.calls.filter((row) => row[0] === 'stop').length, 0);
  const pendingBefore = h.calls.filter((row) => row[0] === 'pending').length;
  assert.equal((await h.helper.handle('workflow-stop', command, wait())).state, 'paused');
  assert(h.calls.filter((row) => row[0] === 'pending').length > pendingBefore + 1);
  assert.equal(h.calls.filter((row) => row[0] === 'stop').length, 1);
  assert.equal(h.calls.filter((row) => row[0] === 'start' || row[0] === 'resume').length, 0);
  assert.equal((await h.helper.handle('workflow-stop', command, wait())).state, 'paused');
  assert.equal(
    h.calls.filter((row) => row[0] === 'stop').length,
    2,
    'closing Stop replay still uses its original cleanup',
  );
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
