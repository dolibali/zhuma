import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, startAppliedPlan } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function node(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function confirm(nodes, extra = []) {
  const { state, task } = fixture();
  for (const person of extra) state.participants.push(person);
  const participantIds = new Set(task.participantIds);
  for (const person of extra) participantIds.add(person.id);
  for (const item of nodes) {
    if (item.assigneeId) participantIds.add(item.assigneeId);
    for (const reviewerId of item.reviewerIds) participantIds.add(reviewerId);
  }
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: [...participantIds],
      workflows: [{ ...task.workflows[0], nodes }],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  assert.ok(applied);
  return { state: ready, applied };
}

function start(applied, existing = [], actorId = 'chen') {
  return startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId,
    existing,
  });
}

function at(records, nodeId) {
  const found = records.find((record) => record.nodeId === nodeId);
  assert.ok(found, nodeId);
  return found;
}

test('starts the exact revision and records entry status without using the actor as owner', () => {
  const { applied } = confirm([
    node({ id: 'design', title: '设计' }),
    node({ id: 'publish', title: '发布', assigneeId: 'outside', dependsOn: ['design'] }),
  ]);
  const wrong = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision + 1 },
    applied,
    actorId: 'outside',
    existing: [],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'plan-not-found');
  assert.equal(wrong.records.length, 0);
  assert.equal(
    startAppliedPlan({
      requested: { taskId: applied.taskId, planId: applied.id, revision: 0 },
      applied,
      actorId: 'chen',
      existing: [],
    }).code,
    'plan-reference-required',
  );

  const started = start(applied, [], 'outside');
  assert.equal(started.ok, true);
  assert.equal(started.disposition, 'applied');
  const design = at(started.records, 'design');
  const publish = at(started.records, 'publish');
  assert.equal(design.command.status, 'ready');
  assert.equal(publish.command.status, 'blocked');
  assert.equal(design.command.entryStatus, 'ready');
  assert.equal(publish.command.entryStatus, 'ready');
  assert.equal(design.ownerId, 'chen');
  assert.equal(publish.ownerId, 'chen');
  assert.notEqual(design.ownerId, 'outside');
  assert.equal(design.handoff.inputRefs.length, 0);
  assert.equal(publish.handoff.inputRefs.length, 0);

  const frozen = structuredClone(started.records);
  const again = start(applied, started.records, 'outside');
  assert.equal(again.disposition, 'replayed');
  assert.deepEqual(started.records, frozen);
  assert.equal(at(again.records, 'design').command.version, 1);
});

test('a wrong revision does not fall back to a newer applied plan', () => {
  const { state, applied } = confirm([node({ id: 'design', title: '设计' })]);
  const drafted = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...state.tasks[0], status: 'draft' },
  });
  const revised = applyWorkbenchCommand(drafted, {
    type: 'save-task',
    task: { ...drafted.tasks[0], status: 'ready' },
  });
  const v1 = revised.appliedPlans.find((plan) => plan.revision === 1);
  const v2 = revised.appliedPlans.find((plan) => plan.revision === 2);
  assert.ok(v1);
  assert.ok(v2);
  assert.equal(applied.revision, 1);
  const fallback = startAppliedPlan({
    requested: { taskId: v1.taskId, planId: v1.id, revision: 1 },
    applied: v2,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.code, 'plan-not-found');
  const exact = startAppliedPlan({
    requested: { taskId: v1.taskId, planId: v1.id, revision: 1 },
    applied: v1,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.records[0].revision, 1);
  assert.equal(exact.records[0].planId, v1.id);
});
