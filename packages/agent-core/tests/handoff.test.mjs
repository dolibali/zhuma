import assert from 'node:assert/strict';
import test from 'node:test';
import { assigneeUsesAgentRuntime, readNodeHandoff } from '@zhuma/agent-core';

const handoff = (assignee, extra = {}) => ({
  nodeId: 'node-1',
  taskId: 'task-1',
  workflowVersionId: 'workflow-1',
  revision: 3,
  goal: 'ship the note',
  assignee,
  dependencyNodeIds: [],
  reviewRequired: false,
  reviewerIds: [],
  inputRefs: [],
  skillRefs: [],
  mcpRefs: [],
  inputNote: '',
  expectedOutput: '',
  ...extra,
});

test('expert and agent assignees use the agent runtime, humans do not', () => {
  assert.equal(assigneeUsesAgentRuntime('expert'), true);
  assert.equal(assigneeUsesAgentRuntime('agent'), true);
  assert.equal(assigneeUsesAgentRuntime('human'), false);
});

test('a human handoff may omit expertRef and an expert handoff may not', () => {
  const human = readNodeHandoff(handoff({ id: 'human-1', kind: 'human' }, { engine: 'dsh' }));
  assert.equal(human.ok, true);
  assert.equal(human.handoff.assignee.kind, 'human');
  assert.equal(human.handoff.expertRef, undefined);
  assert.equal('engine' in human.handoff, false);

  const expert = readNodeHandoff(
    handoff(
      { id: 'expert-1', kind: 'expert' },
      { expertRef: { id: 'expert-1', version: 'applied-plan-1' } },
    ),
  );
  assert.equal(expert.ok, true);
  assert.deepEqual(expert.handoff.expertRef, { id: 'expert-1', version: 'applied-plan-1' });

  const missing = readNodeHandoff(handoff({ id: 'expert-1', kind: 'expert' }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'expert-ref-required');

  const blank = readNodeHandoff(
    handoff(
      { id: 'expert-1', kind: 'expert' },
      { expertRef: { id: ' ', version: 'applied-plan-1' } },
    ),
  );
  assert.equal(blank.code, 'expert-ref-required');

  const agent = readNodeHandoff(handoff({ id: 'run-1', kind: 'agent' }));
  assert.equal(agent.ok, false);
  assert.equal(agent.code, 'agent-not-identity');

  for (const expertRef of [
    { id: 'expert-1' },
    { id: 'expert-1', version: null },
    { id: 'expert-1', version: 1 },
  ]) {
    const malformed = readNodeHandoff(handoff({ id: 'expert-1', kind: 'expert' }, { expertRef }));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.code, 'invalid-handoff');
  }

  const leaked = readNodeHandoff(
    handoff(
      { id: 'human-1', kind: 'human' },
      {
        skillRefs: [{ id: 'skill-1', version: 'applied-plan-1', token: 'secret' }],
        mcpRefs: [{ id: 'mcp-1', version: 'applied-plan-1', token: 'secret' }],
      },
    ),
  );
  assert.equal(leaked.ok, true);
  assert.deepEqual(leaked.handoff.skillRefs, [{ id: 'skill-1', version: 'applied-plan-1' }]);
  assert.deepEqual(leaked.handoff.mcpRefs, [{ id: 'mcp-1', version: 'applied-plan-1' }]);
  assert.equal(Object.hasOwn(leaked.handoff.skillRefs[0], 'token'), false);
  assert.equal(Object.hasOwn(leaked.handoff.mcpRefs[0], 'token'), false);
});
