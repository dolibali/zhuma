import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNodeTransitionCommand,
  canReadFile,
  projectWorkTreeNode,
  readNodeHandoff,
  readVersionedSnapshot,
  requestNodeRun,
  transitionNode,
  unverifiedSignalChangesNode,
} from '@zhuma/agent-core';

const envelope = (payload, idempotencyKey, expectedVersion) => ({
  idempotencyKey,
  actorId: 'human-1',
  objectId: 'node-1',
  expectedVersion,
  payload,
});

test('repeated split does not create a second run', () => {
  assert.equal(
    requestNodeRun({ nodeId: 'node-1', nodeStatus: 'needs-revision', runs: [] }).ok,
    true,
  );
  const second = requestNodeRun({
    nodeId: 'node-1',
    nodeStatus: 'needs-revision',
    runs: [{ id: 'run-1', nodeId: 'node-1', status: 'running' }],
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'active-run-exists');
  assert.equal(second.runId, 'run-1');

  const started = applyNodeTransitionCommand(
    { status: 'needs-revision', version: 0, upstreamAffected: false, stored: [] },
    envelope({ type: 'child-workflow-started' }, 'split', 0),
  );
  assert.equal(started.decision.status, 'applied');
  assert.equal(started.state.status, 'child-workflow');
  const replay = applyNodeTransitionCommand(
    started.state,
    envelope({ type: 'child-workflow-started' }, 'split', started.state.version),
  );
  assert.equal(replay.decision.status, 'replayed');
  assert.equal(replay.state.status, 'child-workflow');
  assert.equal(replay.state.version, started.state.version);
  const again = applyNodeTransitionCommand(
    started.state,
    envelope({ type: 'child-workflow-started' }, 'split-again', started.state.version),
  );
  assert.equal(again.decision.status, 'rejected');
  assert.equal(again.state.status, 'child-workflow');
  assert.equal(again.state.version, started.state.version);
});

test('a child task cannot read ancestor materials', () => {
  const grants = [{ actorId: 'child-owner', taskId: 'child-task', access: 'read' }];
  assert.equal(
    canReadFile({
      actorId: 'child-owner',
      fileTaskId: 'ancestor-task',
      grants,
      referencedByUpstream: true,
    }),
    false,
  );
  assert.equal(
    canReadFile({
      actorId: 'child-owner',
      fileTaskId: 'child-task',
      grants,
      referencedByUpstream: false,
    }),
    true,
  );
  const hidden = projectWorkTreeNode({
    canAccess: false,
    node: {
      id: 'ancestor',
      title: 'ancestor title',
      fileNames: ['secret.md'],
      commentIds: ['comment-1'],
    },
  });
  assert.deepEqual(hidden, { access: 'redacted', id: 'ancestor' });
  assert.equal('title' in hidden, false);
  assert.equal('fileNames' in hidden, false);
});

test('a human node does not need an expert or an engine', () => {
  const human = readNodeHandoff({
    nodeId: 'node-1',
    taskId: 'task-1',
    workflowVersionId: 'workflow-1',
    revision: 1,
    goal: 'write it',
    assignee: { id: 'human-1', kind: 'human' },
    dependencyNodeIds: [],
    reviewRequired: false,
    reviewerIds: [],
    inputRefs: [],
    skillRefs: [],
    mcpRefs: [],
    inputNote: '',
    expectedOutput: '',
  });
  assert.equal(human.ok, true);
  assert.equal(human.handoff.assignee.kind, 'human');
  assert.equal(human.handoff.expertRef, undefined);
  assert.equal('engine' in human.handoff, false);
});

test('a child return does not skip the parent submit or review', () => {
  const returned = transitionNode('child-workflow', { type: 'child-workflow-returned' });
  assert.equal(returned.ok, true);
  assert.equal(returned.to, 'ready');
  assert.deepEqual(returned.effects, ['await-parent-submit']);
  assert.equal(returned.effects.includes('accept-handoff'), false);

  let state = {
    status: 'ready',
    version: 1,
    upstreamAffected: false,
    stored: [],
    entryStatus: 'ready',
  };
  state = applyNodeTransitionCommand(
    state,
    envelope({ type: 'child-workflow-started' }, 'parent-split', 1),
  ).state;
  const back = applyNodeTransitionCommand(
    state,
    envelope({ type: 'child-workflow-returned' }, 'parent-return', state.version),
  );
  assert.equal(back.decision.status, 'applied');
  assert.equal(back.state.status, 'ready');
  assert.equal(back.state.status === 'completed', false);
  assert.deepEqual(back.decision.result.effects, ['await-parent-submit']);
  assert.equal(back.decision.result.effects.includes('accept-handoff'), false);
});

test('an old snapshot stays after the catalog changes', () => {
  const source = {
    id: 'applied-plan-1',
    expertId: 'expert-1',
    goal: 'original goal',
    note: 'original note',
  };
  const published = Object.freeze({ ...source });
  const ref = { id: source.expertId, version: published.id };
  source.goal = 'edited in the directory';
  source.note = 'edited note';
  const catalog = [
    published,
    Object.freeze({
      id: 'applied-plan-2',
      expertId: 'expert-1',
      goal: 'replacement goal',
      note: 'replacement note',
    }),
  ];
  const read = readVersionedSnapshot(ref, catalog);
  assert.equal(read.id, 'applied-plan-1');
  assert.equal(read.goal, 'original goal');
  assert.equal(read.note, 'original note');
  assert.equal(
    readVersionedSnapshot({ id: 'expert-1', version: 'applied-plan-2' }, catalog).goal,
    'replacement goal',
  );
});

test('cancel is not shown as stopped before the receipt', () => {
  assert.equal(unverifiedSignalChangesNode('cancel-unconfirmed'), false);
  const before = {
    status: 'running',
    version: 1,
    upstreamAffected: false,
    stored: [],
    entryStatus: 'ready',
  };
  assert.equal(before.status, 'running');
  const confirmed = applyNodeTransitionCommand(
    before,
    envelope({ type: 'cancel-confirmed' }, 'cancel-receipt', 1),
  );
  assert.equal(confirmed.decision.status, 'applied');
  assert.equal(confirmed.state.status, 'cancelled');
  assert.deepEqual(confirmed.decision.result.effects, ['record-cancellation', 'block-downstream']);
});
