import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assigneeUsesAgentRuntime,
  readNodeHandoff,
  readVersionedSnapshot,
} from '@zhuma/agent-core';

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

test('context input refs keep their whitelist fields and drop extras', () => {
  const rebuilt = readNodeHandoff(
    handoff(
      { id: 'human-1', kind: 'human' },
      {
        inputRefs: [
          {
            sourceNodeId: 'upstream',
            artifactVersionId: 'artifact-v2',
            contextPackId: 'context-1',
            token: 'secret',
            id: 'a',
            version: 't-v1',
          },
        ],
      },
    ),
  );
  assert.equal(rebuilt.ok, true);
  assert.deepEqual(rebuilt.handoff.inputRefs, [
    {
      sourceNodeId: 'upstream',
      artifactVersionId: 'artifact-v2',
      contextPackId: 'context-1',
    },
  ]);
  assert.equal(Object.hasOwn(rebuilt.handoff.inputRefs[0], 'token'), false);
  assert.equal(Object.hasOwn(rebuilt.handoff.inputRefs[0], 'id'), false);
  assert.equal(Object.hasOwn(rebuilt.handoff.inputRefs[0], 'version'), false);

  const partial = readNodeHandoff(
    handoff(
      { id: 'human-1', kind: 'human' },
      { inputRefs: [{ sourceNodeId: 'node-0', artifactVersionId: 'art-1' }] },
    ),
  );
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.handoff.inputRefs, [
    { sourceNodeId: 'node-0', artifactVersionId: 'art-1' },
  ]);
});

test('an input ref missing sourceNodeId or artifactVersionId is rejected', () => {
  for (const inputRefs of [
    [{ artifactVersionId: 'art-1' }],
    [{ sourceNodeId: 'node-0' }],
    [{ contextPackId: 'context-1' }],
    [{ artifactVersionId: 'art-1', contextPackId: 'context-1' }],
    [{ sourceNodeId: 'node-0', contextPackId: 'context-1', token: 'secret' }],
  ]) {
    const invalid = readNodeHandoff(handoff({ id: 'human-1', kind: 'human' }, { inputRefs }));
    assert.equal(invalid.ok, false, JSON.stringify(inputRefs));
    assert.equal(invalid.code, 'invalid-handoff');
  }
});

test('blank input ref fields are rejected', () => {
  for (const inputRefs of [
    [{ sourceNodeId: '', artifactVersionId: 'art-1' }],
    [{ sourceNodeId: '   ', artifactVersionId: 'art-1' }],
    [{ sourceNodeId: 'node-0', artifactVersionId: '' }],
    [{ sourceNodeId: 'node-0', artifactVersionId: '\t' }],
    [{ sourceNodeId: 'node-0', artifactVersionId: 'art-1', contextPackId: '' }],
    [{ sourceNodeId: 'node-0', artifactVersionId: 'art-1', contextPackId: ' \n ' }],
  ]) {
    const invalid = readNodeHandoff(handoff({ id: 'human-1', kind: 'human' }, { inputRefs }));
    assert.equal(invalid.ok, false, JSON.stringify(inputRefs));
    assert.equal(invalid.code, 'invalid-handoff');
  }
});

test('a non-string contextPackId is rejected', () => {
  for (const contextPackId of [null, 7, {}]) {
    const invalid = readNodeHandoff(
      handoff(
        { id: 'human-1', kind: 'human' },
        { inputRefs: [{ sourceNodeId: 'node-0', artifactVersionId: 'art-1', contextPackId }] },
      ),
    );
    assert.equal(invalid.ok, false, JSON.stringify(contextPackId));
    assert.equal(invalid.code, 'invalid-handoff');
  }
});

test('invalid context input refs are rejected without throwing', () => {
  for (const inputRefs of [
    null,
    [null],
    ['upstream'],
    [[]],
    [{}],
    [{ token: 'secret' }],
    [{ id: 'artifact-1', version: 'applied-plan-1' }],
    [{ sourceNodeId: 1, artifactVersionId: 'art-1' }],
    [{ sourceNodeId: 'node-0', artifactVersionId: null }],
  ]) {
    const invalid = readNodeHandoff(handoff({ id: 'human-1', kind: 'human' }, { inputRefs }));
    assert.equal(invalid.ok, false, JSON.stringify(inputRefs));
    assert.equal(invalid.code, 'invalid-handoff');
  }
});

test('null handoff and snapshot arguments are rejected without throwing', () => {
  assert.equal(readNodeHandoff(null).code, 'invalid-handoff');
  assert.equal(
    readNodeHandoff({ ...handoff({ id: 'human-1', kind: 'human' }), assignee: null }).code,
    'invalid-handoff',
  );
  assert.equal(readVersionedSnapshot(null, []), undefined);
  assert.equal(
    readVersionedSnapshot({ id: 'expert-1', version: 'applied-plan-1' }, null),
    undefined,
  );
});

test('an uncloneable snapshot reads as undefined', () => {
  const catalog = [
    {
      assetId: 'expert-1',
      id: 'applied-plan-1',
      work() {
        return 'no';
      },
    },
  ];
  assert.equal(
    readVersionedSnapshot({ id: 'expert-1', version: 'applied-plan-1' }, catalog),
    undefined,
  );
});
