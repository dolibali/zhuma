/** Original pure domain regression: no model, SDK or persistent data repair. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  applyNodeTransitionCommand,
  startAppliedPlan,
  submitDelivery,
  castBallot,
  settleReview,
  completionSource,
  unlockDownstream,
  unlockKey,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

function graph() {
  const f = fixture();
  const nodes = [
    {
      ...f.node,
      id: 'source0',
      skillIds: [],
      reviewerIds: [],
      reviewRequired: false,
      dependsOn: [],
    },
    {
      ...f.node,
      id: 'source1',
      skillIds: [],
      reviewerIds: [],
      reviewRequired: false,
      dependsOn: ['source0'],
    },
    {
      ...f.node,
      id: 'target',
      skillIds: [],
      reviewerIds: ['outside'],
      reviewRequired: true,
      dependsOn: ['source0', 'source1'],
    },
  ];
  const w = applyWorkbenchCommand(f.state, {
      type: 'save-task',
      task: {
        ...f.task,
        participantIds: ['chen', 'qa', 'outside'],
        status: 'ready',
        workflows: [{ ...f.task.workflows[0], nodes }],
      },
    }),
    plan = w.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: plan.taskId, planId: plan.id, revision: plan.revision },
    applied: plan,
    actorId: 'chen',
    existing: [],
  });
  assert(started.ok);
  let records = [...started.records];
  const get = (id) => records.find((record) => record.nodeId === id);
  const put = (record) => {
    records = records.map((r) => (r.nodeId === record.nodeId ? record : r));
  };
  const deliver = (id) => {
    const record = get(id),
      outcome = submitDelivery({
        record,
        actorId: 'chen',
        idempotencyKey: `deliver-${id}`,
        expectedVersion: record.command.version,
        draft: { text: `Fixed ${id}`, files: [], links: [] },
        artifactId: `artifact-${id}`,
        roundId: `round-${id}`,
      });
    assert(outcome.ok);
    put(outcome.record);
  };
  const unlock = (id, source) => {
    const record = get(id),
      outcome = unlockDownstream({
        record,
        dependencies: records,
        actorId: 'chen',
        idempotencyKey: unlockKey(completionSource(get(source)), id),
        expectedVersion: record.command.version,
      });
    assert(outcome.ok);
    put(outcome.record);
    return outcome;
  };
  deliver('source0');
  unlock('source1', 'source0');
  deliver('source1');
  const initial = unlock('target', 'source1');
  return { get, put, deliver, unlock, initial, records: () => records };
}
function completed(g) {
  g.deliver('target');
  let record = g.get('target'),
    round = record.rounds.at(-1);
  const ballot = castBallot({
    record,
    actorId: 'outside',
    idempotencyKey: 'approve-target',
    expectedVersion: record.command.version,
    ballot: {
      reviewerId: 'outside',
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'approve',
    },
  });
  assert(ballot.ok);
  record = ballot.record;
  const accepted = settleReview({
    record,
    actorId: 'outside',
    idempotencyKey: 'accept-target',
    expectedVersion: record.command.version,
    roundId: round.id,
    artifactVersionId: round.artifactVersionId,
  });
  assert(accepted.ok);
  g.put(accepted.record);
}
for (const status of ['ready', 'running', 'in-review', 'completed'])
  test(`unchanged accepted inputs: late second-predecessor repair is a no-op in ${status}, with no version/receipt/flag changes`, () => {
    const g = graph();
    assert.equal(g.initial.disposition, 'applied');
    if (status === 'running') {
      const record = g.get('target'),
        outcome = applyNodeTransitionCommand(record.command, {
          actorId: 'chen',
          objectId: record.nodeId,
          idempotencyKey: 'ack-target',
          expectedVersion: record.command.version,
          payload: { type: 'execution-acknowledged' },
        });
      assert.equal(outcome.decision.status, 'applied');
      g.put({ ...record, command: outcome.state });
    } else if (status === 'in-review') g.deliver('target');
    else if (status === 'completed') completed(g);
    const before = g.get('target'),
      bytes = JSON.stringify(before);
    assert.equal(before.command.status, status);
    assert.equal(before.command.upstreamAffected, false);
    assert.equal(before.handoff.inputRefs.length, 2);
    assert.equal(g.get('source0').artifactVersions.length, 1);
    assert.equal(g.get('source1').artifactVersions.length, 1);
    const result = g.unlock('target', 'source0');
    assert.equal(result.disposition, 'ignored');
    assert.equal(result.record, before);
    assert.equal(JSON.stringify(result.record), bytes);
    assert.equal(g.unlock('target', 'source0').disposition, 'ignored');
  });

test('unchanged accepted inputs: actor/key and stale-version checks still precede no-op classification', () => {
  const g = graph();
  g.deliver('target');
  const record = g.get('target');
  const command = {
    record,
    dependencies: g.records(),
    actorId: 'chen',
    idempotencyKey: unlockKey(completionSource(g.get('source0')), 'target'),
    expectedVersion: record.command.version,
  };
  const stale = unlockDownstream({ ...command, expectedVersion: record.command.version - 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  const originalKey = unlockKey(completionSource(g.get('source1')), 'target');
  const replay = unlockDownstream({ ...command, idempotencyKey: originalKey });
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, record);
  const wrongActor = unlockDownstream({
    ...command,
    idempotencyKey: originalKey,
    actorId: 'outside',
  });
  assert.equal(wrongActor.ok, false);
  assert.equal(wrongActor.code, 'idempotency-mismatch');
});

test('changed accepted inputs: actual new fixed version still marks upstream affected and remains marked on later identical repairs', () => {
  const g = graph();
  g.deliver('target');
  const before = g.get('target'),
    source = g.get('source0');
  g.put({
    ...source,
    acceptedArtifactVersionId: 'source0-v2',
    artifactVersions: [
      ...source.artifactVersions,
      {
        ...source.artifactVersions[0],
        id: 'source0-v2',
        version: 2,
        text: 'New accepted version.',
      },
    ],
  });
  const changed = g.unlock('target', 'source0');
  assert.equal(changed.disposition, 'applied');
  assert.equal(changed.record.command.upstreamAffected, true);
  assert.equal(changed.record.command.version, before.command.version + 1);
  assert.equal(changed.record.handoff.inputRefs[0].artifactVersionId, 'source0-v2');
  const marked = changed.record;
  const repeated = unlockDownstream({
    record: marked,
    dependencies: g.records(),
    actorId: 'chen',
    idempotencyKey: 'another-old-repair',
    expectedVersion: marked.command.version,
  });
  assert.equal(repeated.disposition, 'ignored');
  assert.equal(repeated.record, marked);
  assert.equal(
    repeated.record.command.upstreamAffected,
    true,
    'never clear an existing genuine/historical flag',
  );
});

test('changed dependency availability: missing acceptance is still a real change, and a reused key with changed payload is refused', () => {
  const g = graph();
  g.deliver('target');
  const record = g.get('target');
  const missing = g.records().filter((r) => r.nodeId !== 'source0');
  const changed = unlockDownstream({
    record,
    dependencies: missing,
    actorId: 'chen',
    idempotencyKey: 'lost-acceptance',
    expectedVersion: record.command.version,
  });
  assert.equal(changed.disposition, 'applied');
  assert.equal(changed.record.command.upstreamAffected, true);
  const mismatch = unlockDownstream({
    record,
    dependencies: missing,
    actorId: 'chen',
    idempotencyKey: unlockKey(completionSource(g.get('source1')), 'target'),
    expectedVersion: record.command.version,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'idempotency-mismatch');
});
