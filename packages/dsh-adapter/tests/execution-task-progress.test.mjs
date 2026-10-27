import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  applyWorkbenchCommand,
  nodeRecordKey,
  startAppliedPlan,
  canonicalPayload,
} from '@zhuma/agent-core';
import { checked, caller, refused } from './execution-service-run-fixture.mjs';
import { domainBytes, projectWorkbench } from './execution-project-artifacts-fixture.mjs';
import { workbench as reviewWorkbench } from './execution-review-service-fixture.mjs';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { stopCommand } from './execution-run-fixture.mjs';
import { progressHost } from './execution-task-progress-fixture.mjs';
import { selectTaskProgress, taskProgressProjection } from '../dist/execution-task-progress.js';
import {
  taskProgressQuerySchema,
  TASK_PROGRESS_LIMITS,
} from '../dist/execution-task-progress-contract.js';

const row = async (h) => checked(await h.progress()).items[0];
const latch = () => Promise.withResolvers();
function reconfirm(state) {
  const task = state.tasks.find((task) => task.id === 'task');
  const draft = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...task, status: 'draft' },
  });
  return applyWorkbenchCommand(draft, {
    type: 'save-task',
    task: { ...draft.tasks.find((t) => t.id === 'task'), status: 'ready' },
  });
}
function reference(plan) {
  return { taskId: plan.taskId, planId: plan.id, revision: plan.revision };
}

test('task progress Service: current manual acceptance is visible, detached and zero-write without a repairing read or body scan', async (t) => {
  const h = await progressHost(t, { workbench: projectWorkbench({ count: 1 }) });
  await h.submit();
  await h.submit('work-0', 'private-child', 'PRIVATE_CHILD_BODY');
  const before = await domainBytes(h.root),
    workbench = JSON.stringify(h.readWorkbench());
  h.resetCounts();
  const original = h.service.storage.readNode;
  let reads = 0,
    bodies = 0;
  h.service.storage.readNode = (key) => {
    assert.equal(key, nodeRecordKey({ ...h.target(), nodeId: 'work-0' }));
    reads++;
    const node = original(key);
    return {
      ...node,
      artifactVersions: node.artifactVersions.map((artifact) => ({
        ...artifact,
        get text() {
          bodies++;
          throw Error('metadata must not encode an accepted body');
        },
      })),
    };
  };
  const tripwires = ['report', 'inbox', 'repairTaskUnlocks', 'reconcile'];
  for (const name of tripwires) h.service[name] = () => assert.fail(`not a pure read: ${name}`);
  h.service.storage.listNodes = () => assert.fail('no global node scan');
  h.service.storage.listPlans = () => assert.fail('no global plan scan');
  const result = checked(await h.progress());
  assert.equal(result.actorId, 'chen');
  assert.equal(result.spaceId, 'north');
  assert.equal(result.coverage, 'current-confirmed-plans');
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.deepEqual(item.target, h.target());
  assert.equal(item.facts, 'present');
  assert.equal(item.delivery, 'all-accepted');
  assert.equal(item.expectedNodes, 1);
  assert.equal(item.acceptedNodes, 1);
  assert.equal(item.byStatus.completed, 1);
  assert.deepEqual(item.assigneeCounts, { human: 1, expert: 0 });
  assert.deepEqual(item.resources, { authorHeld: 0, reviewHeld: 0, stopRequested: 0 });
  assert.equal(Object.hasOwn(item, 'nodes'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|正文|example.com/);
  assert.equal(reads, 1);
  assert.equal(bodies, 0);
  item.byStatus.completed = 99;
  item.target.planId = 'forged-copy';
  assert.equal((await row(h)).byStatus.completed, 1);
  assert.equal(JSON.stringify(h.readWorkbench()), workbench);
  assert.deepEqual(await domainBytes(h.root), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.calls.release, 2);
  h.service.storage.readNode = original;
});

test('task progress Service: absent start is distinct from missing receipt or partial nodes; unknown never yields a ratio', async (t) => {
  const h = await progressHost(t, { start: false });
  const unstarted = await row(h);
  assert.equal(unstarted.facts, 'not-started');
  assert.equal(unstarted.delivery, 'pending');
  assert.equal(unstarted.expectedNodes, 2);
  assert.equal(unstarted.acceptedNodes, 0);
  assert.equal(
    Object.values(unstarted.byStatus).reduce((a, b) => a + b, 0),
    0,
  );
  checked(await h.service.startPlan(caller(), { ...h.target(), idempotencyKey: randomUUID() }));
  await h.domain.table('nodes').delete(nodeRecordKey({ ...h.target(), nodeId: 'work-1' }));
  for (const receipt of [true, false]) {
    if (!receipt)
      await h.domain
        .table('plans')
        .delete(`${h.target().taskId}:${h.target().planId}:${h.target().revision}`);
    const item = await row(h);
    assert.equal(item.facts, 'unknown');
    assert.equal(item.reason, 'incomplete-plan');
    assert.equal(item.acceptedNodes, null);
    assert.equal(item.byStatus, null);
    assert.equal(item.resources, null);
  }
});

test('task progress Service: parallel execution and review remain separate, then real review return is counted', async (t) => {
  const state = reviewWorkbench({ reviewerIds: ['outside'], parallelExpert: true });
  const h = await progressHost(t, { workbench: state });
  await h.submit('produce');
  await h.transition('parallel', { type: 'execution-acknowledged' });
  let item = await row(h);
  assert.equal(item.byStatus.running, 1);
  assert.equal(item.byStatus['in-review'], 1);
  assert.equal(item.byStatus.blocked, 1);
  assert.equal(item.delivery, 'pending');
  assert.deepEqual(item.assigneeCounts, { human: 2, expert: 1 });
  const node = h.service.readRunNode({ ...h.target(), nodeId: 'produce' }),
    round = node.rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.target(),
      nodeId: 'produce',
      expectedVersion: node.command.version,
      idempotencyKey: randomUUID(),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'request-changes',
      comment: '请补全边界处理。',
    }),
  );
  item = await row(h);
  assert.equal(item.byStatus['needs-revision'], 1);
  assert.equal(item.byStatus.running, 1);
  assert.equal(item.byStatus['in-review'], 0);
  assert.equal(item.acceptedNodes, 0);
});

test('task progress Service: mixed and all-cancelled plans never count cancellation as acceptance', async (t) => {
  const h = await progressHost(t, {
    workbench: projectWorkbench({ count: 2, privateTask: false }),
  });
  await h.submit('work-0');
  await h.transition('work-1', { type: 'cancel-confirmed' });
  let item = await row(h);
  assert.equal(item.delivery, 'mixed-terminal');
  assert.equal(item.acceptedNodes, 1);
  assert.equal(item.expectedNodes, 2);
  assert.equal(item.byStatus.cancelled, 1);
  const other = await progressHost(t, {
    workbench: projectWorkbench({ count: 1, privateTask: false }),
  });
  await other.transition('work-0', { type: 'cancel-confirmed' });
  item = await row(other);
  assert.equal(item.delivery, 'cancelled');
  assert.equal(item.acceptedNodes, 0);
});

test('task progress Service: a draft preserves the current confirmed progress, a new confirmation conflicts with old refs without fallback', async (t) => {
  const h = await progressHost(t, { workbench: projectWorkbench({ count: 1 }) });
  await h.submit();
  const prior = h.query();
  h.setWorkbench((state) =>
    applyWorkbenchCommand(state, {
      type: 'save-task',
      task: { ...state.tasks.find((t) => t.id === 'task'), status: 'draft' },
    }),
  );
  assert.equal((await row(h)).delivery, 'all-accepted');
  h.setWorkbench(reconfirm);
  refused(await h.progress(prior), 'conflict');
  const next = await row(h);
  assert.equal(next.facts, 'not-started');
  assert.equal(next.acceptedNodes, 0);
});

test('task progress Service: latest confirmation is selected by unique maximum revision, never array order', async (t) => {
  const h = await progressHost(t);
  const prior = h.query();
  h.setWorkbench(reconfirm);
  const current = h.query();
  h.setWorkbench((state) => ({ ...state, appliedPlans: [...state.appliedPlans].reverse() }));
  refused(await h.progress(prior), 'conflict');
  assert.equal(checked(await h.progress(current)).items[0].facts, 'not-started');
  h.setWorkbench((state) => ({
    ...state,
    appliedPlans: [
      ...state.appliedPlans,
      state.appliedPlans.find((plan) => plan.id === current.plans[0].planId),
    ],
  }));
  refused(await h.progress(current), 'conflict');
});

test('task progress Service: upstream impact does not count a previously accepted artifact as current delivery', async (t) => {
  const h = await progressHost(t, {
    workbench: projectWorkbench({ count: 1, privateTask: false }),
  });
  await h.submit();
  await h.transition('work-0', { type: 'dependencies-changed', dependenciesSatisfied: false });
  const item = await row(h);
  assert.equal(item.facts, 'present');
  assert.equal(item.byStatus.completed, 1);
  assert.equal(item.reason, 'upstream-affected');
  assert.equal(item.acceptedNodes, 0);
  assert.equal(item.delivery, 'pending');
});

test('task progress Service: whole-batch authorization precedes all node reads; owner is allowed without inheriting a private child', async (t) => {
  const h = await progressHost(t);
  let reads = 0;
  const original = h.service.storage.readNode;
  h.service.storage.readNode = (key) => {
    reads++;
    return original(key);
  };
  refused(await h.progress(h.query(['task', 'private-child'])), 'not-found');
  assert.equal(reads, 0);
  refused(await h.progress({ ...h.query(), spaceId: 'other' }), 'not-found');
  h.hooks.project = () => {
    throw Error('CONTRACT_PROJECT_SCOPE_REVOKED');
  };
  refused(
    await h.progress({ ...h.query(), plans: [{ ...h.target(), planId: 'stale-hidden-plan' }] }),
    'not-found',
  );
  delete h.hooks.project;
  refused(
    await h.service.taskProgress(caller('outside'), h.query(), h.source()),
    'unauthenticated',
  );
  assert.equal(reads, 0);
  h.setWorkbench((state) => ({
    ...state,
    tasks: state.tasks.map((task) =>
      task.id === 'task' ? { ...task, participantIds: ['outside'] } : task,
    ),
  }));
  assert.equal((await row(h)).facts, 'present');
  h.setWorkbench((state) => ({
    ...state,
    tasks: state.tasks.map((task) => (task.id === 'task' ? { ...task, ownerId: 'outside' } : task)),
  }));
  refused(await h.progress(), 'not-found');
});

test('task progress Service: source waits and queued reads cannot outlive member revocation, account change or a newer target', async (t) => {
  for (const kind of ['revoke', 'account', 'target'])
    await t.test(kind, async (t) => {
      const h = await progressHost(t),
        entered = latch(),
        proceed = latch(),
        query = h.query();
      h.hooks.source = async () => {
        entered.resolve();
        await proceed.promise;
      };
      const pending = h.progress(query);
      await entered.promise;
      if (kind === 'revoke') h.member.abort();
      else if (kind === 'account') h.members.set(h.request, 'outside');
      else h.setWorkbench(reconfirm);
      proceed.resolve();
      refused(
        await pending,
        kind === 'revoke' ? 'cancelled' : kind === 'account' ? 'unauthenticated' : 'conflict',
      );
      assert.equal(h.calls.release, 1);
    });
  const h = await progressHost(t),
    entered = latch(),
    proceed = latch();
  const held = h.service.enqueue(async () => {
    entered.resolve();
    await proceed.promise;
    return { ok: true, value: null };
  });
  await entered.promise;
  const query = h.query(),
    pending = h.progress(query);
  await new Promise(setImmediate);
  h.setWorkbench(reconfirm);
  proceed.resolve();
  await held;
  refused(await pending, 'conflict');
});

test('task progress Service: expiry, dishonest async assertions and synchronous callback invalidation cannot return an earlier successful row', async (t) => {
  for (const kind of [
    'expired',
    'async-member',
    'false-project',
    'replace-method',
    'revoke-target',
  ])
    await t.test(kind, async (t) => {
      const h = await progressHost(t);
      if (kind === 'expired')
        h.hooks.issued = (authority) => {
          authority.lease.expiresAt = Date.now() - 1;
        };
      if (kind === 'async-member') h.hooks.member = async () => undefined;
      if (kind === 'false-project') h.hooks.project = () => false;
      if (kind === 'replace-method')
        h.hooks.project = (authority) => {
          authority.lease.assertCurrent = () => undefined;
        };
      if (kind === 'revoke-target')
        h.hooks.project = () => {
          if (h.calls.project === 2) h.setWorkbench(reconfirm);
        };
      refused(
        await h.progress(),
        kind === 'expired' || kind === 'replace-method'
          ? 'unauthenticated'
          : kind === 'revoke-target'
            ? 'conflict'
            : 'not-found',
      );
      assert.equal(h.calls.release, 1);
    });
});

test('task progress Service: strict request limits, missing source and duplicate tasks fail without reading records', async (t) => {
  const h = await progressHost(t),
    q = h.query();
  for (const input of [
    { ...q, actorId: 'outside' },
    { ...q, plans: [] },
    { ...q, plans: [...q.plans, ...q.plans] },
    { ...q, plans: Array.from({ length: 6 }, (_, i) => ({ ...q.plans[0], taskId: `task-${i}` })) },
    { ...q, plans: [{ taskId: 'task', revision: 1 }] },
    { ...q, plans: [{ ...q.plans[0], revision: 0 }] },
    { ...q, padding: 'x'.repeat(8193) },
  ])
    assert.equal((await h.progress(input)).ok, false);
  assert.equal(h.calls.source, 0);
  refused(await h.service.taskProgress(caller(), q), 'unauthenticated');
});

test('task progress Service: invalid state or accepted pointer yields no partial completion count', async (t) => {
  for (const kind of ['status', 'handoff', 'accepted', 'native', 'child', 'receipt'])
    await t.test(kind, async (t) => {
      const h = await progressHost(t, {
        workbench: projectWorkbench({ count: 1, privateTask: false }),
      });
      await h.submit();
      const record = structuredClone(h.service.readRunNode({ ...h.target(), nodeId: 'work-0' }));
      if (kind === 'status') record.command.status = 'future-state';
      if (kind === 'handoff') record.handoff.assignee = { kind: 'human', id: 'chen' };
      if (kind === 'accepted') record.acceptedArtifactVersionId = 'missing';
      if (kind === 'native') record.nativeExecution = { schemaVersion: 999 };
      if (kind === 'child') record.handoff.childTaskId = 'PRIVATE_CHILD';
      if (kind === 'receipt')
        await h.domain.table('plans').put(`${record.taskId}:${record.planId}:${record.revision}`, {
          idempotencyKey: 'bad',
          fingerprint: 'bad',
          nodeIds: ['other'],
        });
      else await h.domain.table('nodes').put(nodeRecordKey(record), record);
      const item = await row(h);
      assert.equal(item.facts, 'unknown');
      assert.equal(item.delivery, 'unknown');
      assert.equal(item.acceptedNodes, null);
      assert.equal(item.byStatus, null);
      if (kind === 'child') assert.equal(item.reason, 'unsupported-child-workflow');
    });
});

test('task progress pure projection: empty, nested and oversized plans do not become vacuous completion or flattened child work', () => {
  for (const kind of ['empty', 'nested', 'wide']) {
    const state = projectWorkbench({ count: 1, privateTask: false }),
      plan = state.appliedPlans.at(-1);
    if (kind === 'empty') plan.task.workflows[0].nodes = [];
    if (kind === 'nested')
      plan.task.workflows.push({ ...plan.task.workflows[0], id: 'child', parentNodeId: 'work-0' });
    if (kind === 'wide')
      plan.task.workflows[0].nodes = Array.from({ length: 81 }, (_, i) => ({
        ...plan.task.workflows[0].nodes[0],
        id: `work-${i}`,
      }));
    const target = reference(plan),
      selection = selectTaskProgress(state, 'chen', { spaceId: 'north', plans: [target] });
    const result = taskProgressProjection(selection, {
      global: { schemaVersion: 1 },
      readPlan() {
        assert.fail('unusable plan must not read runtime');
      },
      readNode() {
        assert.fail('no flatten or partial read');
      },
    });
    assert.equal(result.items[0].facts, 'unknown');
    assert.equal(result.items[0].acceptedNodes, null);
    assert.equal(
      result.items[0].reason,
      kind === 'empty'
        ? 'empty-plan'
        : kind === 'nested'
          ? 'unsupported-child-workflow'
          : 'node-limit',
    );
  }
});

test('task progress Service: genuine original review metadata stays held after acceptance until explicit cleanup, without a drain claim', async (t) => {
  const h = await nativeReviewHost(t);
  const { taskId, planId, revision } = h.locator;
  const query = { spaceId: 'north', plans: [{ taskId, planId, revision }] };
  const source = async () => ({
    lease: await h.service.runHost.memberLease(h.request),
    assertProjectSpace: h.service.runHost.assertProjectSpace,
  });
  const progress = async () =>
    checked(await h.service.taskProgress(caller(), query, source)).items[0];
  let item = await progress();
  assert.equal(item.byStatus['in-review'], 1);
  assert.equal(item.resources.reviewHeld, 1);
  assert.equal(item.resources.authorHeld, 0);
  h.hooks.retire = () => ({ status: 'pending' });
  const result = checked(
    await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.cleanup, 'pending');
  for (const nodeId of ['parallel', 'consume']) {
    const node = h.read(nodeId);
    checked(
      await h.service.submit(caller(node.handoff.assignee.id), {
        taskId,
        planId,
        revision,
        nodeId,
        expectedVersion: node.command.version,
        idempotencyKey: randomUUID(),
        text: '人工完成后续工作',
      }),
    );
  }
  const before = await domainBytes(h.root);
  h.resetCounts();
  item = await progress();
  assert.equal(item.delivery, 'all-accepted');
  assert.equal(item.acceptedNodes, 3);
  assert.equal(item.resources.reviewHeld, 1, 'acceptance never proves original resources drained');
  assert.equal(Object.hasOwn(item.resources, 'drained'), false);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
  delete h.hooks.retire;
});

test('task progress Service: recorded author and review resources and Stop requests are counted independently of node phases', async (t) => {
  const h = await nativeReviewHost(t);
  // The existing fixture's builtin composition is for a human using an Agent.
  checked(await h.service.beginRun(h.request, h.begin({}, 'parallel')));
  const target = reference(h.readWorkbench().appliedPlans.at(-1));
  const source = async () => ({
    lease: await h.service.runHost.memberLease(h.request),
    assertProjectSpace: h.service.runHost.assertProjectSpace,
  });
  const read = async () =>
    checked(await h.service.taskProgress(caller(), { spaceId: 'north', plans: [target] }, source))
      .items[0];
  let item = await read();
  assert.equal(item.resources.authorHeld, 1);
  assert.equal(item.resources.reviewHeld, 1);
  assert.equal(item.resources.stopRequested, 0);
  assert.equal(item.byStatus.running, 0, 'reserved metadata is not a native start receipt');
  const run = h.read('parallel');
  const { actorId: _actor, ...stop } = stopCommand(run);
  checked(
    await h.service.stopRun(h.request, {
      ...target,
      nodeId: 'parallel',
      spaceId: 'north',
      ...stop,
    }),
  );
  item = await read();
  assert.equal(item.resources.stopRequested, 1);
  assert.equal(item.resources.authorHeld, 1);
  assert.equal(item.resources.reviewHeld, 1);
});

test('task progress pure projection: five complete eighty-node plans take exactly four hundred point reads and bounded metadata', () => {
  const state = projectWorkbench({ count: 400, privateTask: false }),
    records = new Map(),
    receipts = new Map();
  const plans = state.appliedPlans.map(reference);
  for (const applied of state.appliedPlans) {
    const target = reference(applied),
      started = startAppliedPlan({ requested: target, applied, actorId: 'chen', existing: [] });
    assert.equal(started.ok, true);
    receipts.set(canonicalPayload(target), {
      idempotencyKey: 'start',
      fingerprint: canonicalPayload(target),
      nodeIds: started.records.map((r) => r.nodeId),
    });
    for (const record of started.records) records.set(nodeRecordKey(record), record);
  }
  const query = taskProgressQuerySchema.parse({ spaceId: 'north', plans });
  let points = 0;
  const result = taskProgressProjection(selectTaskProgress(state, 'chen', query), {
    global: { schemaVersion: 1 },
    readPlan(target) {
      return receipts.get(canonicalPayload(target));
    },
    readNode(target) {
      points++;
      return records.get(nodeRecordKey(target));
    },
  });
  assert.equal(points, TASK_PROGRESS_LIMITS.nodeReads);
  assert.equal(result.items.length, 5);
  for (const item of result.items) {
    assert.equal(item.expectedNodes, 80);
    assert.equal(item.byStatus.ready, 80);
    assert.equal(item.delivery, 'pending');
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= TASK_PROGRESS_LIMITS.responseBytes);
});

test('task progress Service: maximum legal submitted text stays out of metadata and is not a latency guarantee', async (t) => {
  const h = await progressHost(t, {
    workbench: projectWorkbench({ count: 1, privateTask: false }),
  });
  await h.submit('work-0', 'task', '长'.repeat(100000));
  const before = await domainBytes(h.root),
    item = await row(h);
  assert.equal(item.delivery, 'all-accepted');
  assert.ok(Buffer.byteLength(JSON.stringify(item)) < 2048);
  assert.deepEqual(await domainBytes(h.root), before);
});

for (const kind of ['numeric-id', 'missing-metadata'])
  test(`task progress Service: persisted accepted artifact ${kind} is unknown, not delivered`, async (t) => {
    const h = await progressHost(t, {
      workbench: projectWorkbench({ count: 1, privateTask: false }),
    });
    await h.submit();
    const record = structuredClone(h.service.readRunNode({ ...h.target(), nodeId: 'work-0' }));
    const artifact = record.artifactVersions[0];
    if (kind === 'numeric-id') {
      record.acceptedArtifactVersionId = 123;
      record.artifactVersions = [{ ...artifact, id: 123 }];
    } else {
      record.artifactVersions = [
        { id: artifact.id, nodeId: artifact.nodeId, version: artifact.version },
      ];
    }
    // Exercise the published JSON backend's original shallow non-native row
    // schema, not a fabricated projection callback or a failed write.
    await h.domain.table('nodes').put(nodeRecordKey(record), record);
    assert.deepEqual(h.domain.table('nodes').get(nodeRecordKey(record)), record);
    const before = await domainBytes(h.root);
    const persisted = before
      .map(([, bytes]) => JSON.parse(Buffer.from(bytes, 'base64')))
      .map((value) => value.tables?.nodes?.[nodeRecordKey(record)])
      .find((value) => value !== undefined);
    assert.deepEqual(persisted, record, 'the malformed row really reached the original JSON file');
    h.resetCounts();
    const item = await row(h);
    assert.equal(item.facts, 'unknown');
    assert.equal(item.reason, 'invalid-accepted');
    assert.equal(item.delivery, 'unknown');
    assert.equal(item.acceptedNodes, null);
    assert.equal(item.byStatus, null);
    assert.equal(item.resources, null);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    assert.deepEqual(await domainBytes(h.root), before);
  });

test('task progress Service: final project callback changing the original request identity is refused by a fresh issuer check', async (t) => {
  const h = await progressHost(t, {
    workbench: projectWorkbench({ count: 1, privateTask: false }),
  });
  await h.submit();
  // This independent member-source contract checks the original request map,
  // rather than deriving current identity from unchanged lease fields/signals.
  h.hooks.member = () => {
    assert.equal(
      h.members.get(h.request),
      'chen',
      'the original request no longer identifies chen',
    );
  };
  h.hooks.project = () => {
    if (h.calls.project === 2) h.members.set(h.request, 'outside');
  };
  const before = await domainBytes(h.root);
  h.resetCounts();
  refused(await h.progress(), 'not-found');
  assert.equal(h.calls.project, 2, 'the mapping changed in the final source callback');
  assert.equal(h.calls.release, 1);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
});
