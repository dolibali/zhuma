/** Real native/B components; member resolver, catalog and grants remain contracts. */
import assert from 'node:assert/strict';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { upstreamInputsFor } from '../dist/upstream-inputs.js';
export * from './native-work-session-fixture.mjs';
export {
  acceptedInputRef,
  registerNativeAcceptedInputTool,
  ACCEPTED_INPUT_TOOL,
} from '../dist/native-work-session-input-tool.js';

export function toolResponse(args, callId = 'input-read', name = 'read_accepted_input') {
  const json = JSON.stringify(args);
  return function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name,
      argumentsDelta: json,
    };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: json },
    };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}

export async function acceptedFixture() {
  const { state, task, node } = fixture();
  const nodes = ['source-1', 'source-2', 'source-3', 'downstream'].map((id, index) => ({
    ...node,
    id,
    title: id,
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    skillIds: [],
    dependsOn: index === 3 ? ['source-1', 'source-2', 'source-3'] : [],
  }));
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen'],
      workflows: [{ ...task.workflows[0], nodes }],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  const records = new Map(),
    plans = new Map();
  const storage = {
    readNode: (key) => records.get(key),
    writeNode: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    listNodes: () => [...records.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      plans.set(key, structuredClone(value));
    },
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
  };
  const service = new ExecutionService(
    storage,
    { readWorkbench: () => ready },
    boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
  );
  const caller = { member: { ok: true, memberId: 'chen', spaceIds: ['project'] } };
  const locate = { taskId: applied.taskId, planId: applied.id, revision: applied.revision };
  assert.equal((await service.startPlan(caller, { ...locate, idempotencyKey: 'start' })).ok, true);
  const row = (nodeId) => storage.readNode(nodeRecordKey({ ...locate, nodeId }));
  for (let i = 1; i <= 3; i++) {
    const nodeId = `source-${i}`;
    const result = await service.submit(caller, {
      ...locate,
      nodeId,
      expectedVersion: row(nodeId).command.version,
      idempotencyKey: `submit-${i}`,
      text: i === 1 ? '😀汉'.repeat(5000) : `Unselected source ${i}`,
      links: Array.from({ length: 7 }, (_, j) => `https://example.com/reference-${i}-${j}`),
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error.code);
    assert.equal(row(nodeId).command.status, 'completed');
  }
  const scope = {
    ...locate,
    nodeId: 'downstream',
    actorId: 'chen',
    spaceId: 'project',
    runId: 'contract-run',
    generation: 1,
    segmentId: 'contract-segment',
  };
  const inputs = upstreamInputsFor(row('downstream'), storage.listNodes()).map((input) => ({
    input,
    required: true,
  }));
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every((entry) => entry.input.access === 'visible'));
  const snapshot = () =>
    JSON.stringify({ nodes: [...records.entries()], plans: [...plans.entries()] });
  return { service, caller, scope, catalog: { scope, inputs }, snapshot };
}
