import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approvalHost,
  approvalCommand,
  approvalSource,
} from './execution-workspace-approval-fixture.mjs';
import { open, checked, refused, stable } from './execution-service-run-fixture.mjs';
import { localWorkspace } from './execution-run-fixture.mjs';
import { ExecutionWorkspaceApprovals } from '../dist/execution-workspace-approval.js';

const latch = () => Promise.withResolvers();
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Original Service/domain/queue. Identity, SDK qualification and drain are
// explicit contracts, never normal member/UI/model or filesystem proof.
test('workspace approval: passive reads write nothing; one actual approval and exact retry share a durable row/receipt', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand();
  assert.deepEqual(
    checked(await h.owner.list(h.request, { spaceId: 'north', projectId: 'project' })),
    [],
  );
  assert.equal(h.owner.snapshot().state, undefined);
  assert.equal(h.counters.global, 0);
  const first = checked(await h.owner.approve(h.request, command));
  assert.equal(first.current.generation, 1);
  assert.equal(first.current.actorId, 'chen');
  assert.equal(first.current.status, 'approved');
  assert.equal(h.counters.global, 1);
  assert.equal(h.counters.workspace_approvals, 1);
  assert.equal(h.calls.prepare, 1);
  const bytes = await readFile(join(h.root, 'zhuma_execution.json'));
  assert.equal(bytes.includes(Buffer.from('ISOLATED_CANONICAL_PATH_CONTRACT')), false);
  const replay = checked(await h.owner.approve(h.request, command));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.current, first.current);
  assert.equal(h.calls.prepare, 1);
  assert.equal(h.counters.workspace_approvals, 1);
  assert.deepEqual(await readFile(join(h.root, 'zhuma_execution.json')), bytes);
  refused(
    await h.owner.approve(h.request, { ...command, access: 'read' }),
    'workspace-approval-idempotency-mismatch',
  );
  refused(
    await h.owner.approve(h.request, { ...command, workspaceId: 'other-workspace' }),
    'workspace-approval-idempotency-mismatch',
  );
});

test('workspace approval: revoke works after the directory disappears; old retry returns the current tombstone and cannot restore approval', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand();
  const approved = checked(await h.owner.approve(h.request, command)).current;
  h.hooks.missing = true;
  const revoke = {
    requestId: randomUUID(),
    spaceId: 'north',
    projectId: 'project',
    approvalId: approved.id,
    expectedGeneration: 1,
  };
  let wakes = 0;
  h.owner.onChange(() => {
    wakes++;
    throw Error('CONTRACT_LISTENER_FAILURE');
  });
  const tombstone = checked(await h.owner.revoke(h.request, revoke)).current;
  assert.equal(tombstone.status, 'revoked');
  assert.equal(tombstone.generation, 2);
  assert.equal(tombstone.policy, undefined);
  const before = h.counters.workspace_approvals;
  const replay = checked(await h.owner.approve(h.request, command));
  assert.equal(replay.current.status, 'revoked');
  assert.equal(replay.current.generation, 2);
  assert.equal(
    replay.receipt.status,
    'approved',
    'historical receipt remains metadata, not new authority',
  );
  assert.equal(h.counters.workspace_approvals, before);
  assert.equal(wakes, 1);
  const copy = h.owner.snapshot();
  copy.state.approvals[0].status = 'approved';
  copy.state.approvals[0].receipts.length = 0;
  assert.equal(h.owner.snapshot().state.approvals[0].status, 'revoked');
  assert.equal(h.owner.snapshot().state.approvals[0].receipts.length, 2);
});

test('workspace approval: forged body fields, wrong scope/project and another original member cannot write this approval', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand();
  refused(
    await h.owner.approve(h.request, { ...command, actorId: 'outside' }),
    'workspace-approval-validation',
  );
  refused(
    await h.owner.approve(h.request, { ...command, confirmed: true }),
    'workspace-approval-validation',
  );
  refused(
    await h.owner.approve(h.request, {
      ...command,
      publish: [{ kind: 'directory', path: '../outside' }],
    }),
    'workspace-approval-validation',
  );
  assert.equal((await h.owner.approve(h.request, { ...command, spaceId: 'foreign' })).ok, false);
  assert.equal((await h.owner.approve(h.request, { ...command, projectId: 'missing' })).ok, false);
  const first = checked(await h.owner.approve(h.request, command)).current;
  const other = Object.freeze({ headers: {} });
  h.members.set(other, 'outside');
  assert.deepEqual(
    checked(await h.owner.list(other, { spaceId: 'north', projectId: 'project' })),
    [],
  );
  refused(
    await h.owner.revoke(other, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: first.id,
      expectedGeneration: 1,
    }),
    'workspace-approval-not-found',
  );
  assert.equal(h.counters.workspace_approvals, 1);
});

test('workspace approval: directory identity cannot change in place and failed table persistence preserves the previous generation', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand();
  checked(await h.owner.approve(h.request, command));
  h.hooks.createdAt = '2026-10-02T00:00:00.000Z';
  refused(
    await h.owner.approve(h.request, {
      ...command,
      requestId: randomUUID(),
      expectedGeneration: 1,
    }),
    'workspace-approval-source-changed',
  );
  delete h.hooks.createdAt;
  h.faults.table = 'workspace_approvals';
  const next = { ...command, requestId: randomUUID(), expectedGeneration: 1, access: 'read' };
  refused(await h.owner.approve(h.request, next), 'workspace-approval-unavailable');
  assert.equal(h.owner.snapshot().state.approvals[0].generation, 1);
  delete h.faults.table;
  assert.equal(checked(await h.owner.approve(h.request, next)).current.generation, 2);
});

test('workspace approval: cold original JSON retains authority metadata without writes/model start and old request confirmation is passive', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand();
  const first = checked(await h.owner.approve(h.request, command));
  await h.close();
  const cold = await open(h.root, { seed: false, workbench: h.readWorkbench() });
  t.after(() => cold.close());
  const adopted = approvalSource(cold);
  assert.deepEqual(adopted.owner.snapshot().state.approvals[0], first.current);
  assert.equal(adopted.calls.prepare, 0);
  assert.equal(checked(await adopted.owner.approve(cold.request, command)).disposition, 'replayed');
  assert.equal(adopted.calls.prepare, 0);
  assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
});

for (const point of ['preparation', 'marker'])
  test(`workspace approval: member withdrawal at ${point} writes no approval, including a safe marker-only crash prefix`, async (t) => {
    const h = await approvalHost(t);
    if (point === 'preparation') h.hooks.prepare = () => h.member.abort();
    else h.faults.afterGlobalWrite = () => h.member.abort();
    refused(await h.owner.approve(h.request, approvalCommand()), 'workspace-approval-cancelled');
    assert.equal(h.owner.snapshot().state, undefined);
    assert.equal(h.counters.workspace_approvals, undefined);
    assert.equal(h.counters.global, point === 'marker' ? 1 : 0);
    assert.equal(h.calls.release, 1);
  });

test('workspace approval: accepted durable put survives cancellation and a lost reply, with passive exact retry', async (t) => {
  const h = await approvalHost(t),
    command = approvalCommand(),
    wait = new AbortController();
  h.faults.afterTableWrite = (name) => {
    if (name !== 'workspace_approvals') return;
    wait.abort();
    throw Error('PRIVATE_STORAGE_ACK_LOST');
  };
  const first = checked(await h.owner.approve(h.request, command, wait.signal));
  assert.equal(first.current.generation, 1);
  assert.equal(h.counters.workspace_approvals, 1);
  delete h.faults.afterTableWrite;
  assert.equal(checked(await h.owner.approve(h.request, command)).disposition, 'replayed');
  assert.equal(h.counters.workspace_approvals, 1);
  assert.equal(h.calls.prepare, 1);
});

test('workspace approval: same-key concurrent requests CAS once and caller edits cannot change the prepared command', async (t) => {
  const h = await approvalHost(t),
    entered = latch(),
    release = latch(),
    command = approvalCommand();
  h.hooks.prepare = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = h.owner.approve(h.request, command);
  await entered.promise;
  const second = h.owner.approve(h.request, structuredClone(command));
  command.access = 'read';
  command.publish[0].path = 'other';
  release.resolve();
  const results = (await Promise.all([first, second])).map(checked);
  assert.equal(results.filter((result) => result.disposition === 'applied').length, 1);
  assert.equal(results.filter((result) => result.disposition === 'replayed').length, 1);
  assert.equal(results[0].current.policy.access, 'write');
  assert.equal(results[0].current.policy.publish[0].path, 'deliverables');
  assert.equal(h.counters.workspace_approvals, 1);
});

test('workspace approval: actual original local Run occupancy blocks approval; a settled label alone cannot authorize migration', async (t) => {
  const h = await approvalHost(t, { seed: true });
  checked(await h.service.enableRunWriter());
  checked(await h.service.beginRun(h.request, h.begin({ workspace: localWorkspace })));
  const observed = h.owner.snapshot().runs;
  assert.equal(observed.length, 1);
  assert.equal(observed[0].resources, 'held');
  h.hooks.conflicts = [observed[0].scope];
  const command = approvalCommand();
  refused(await h.owner.approve(h.request, command), 'workspace-approval-busy');
  assert.equal(h.owner.snapshot().state, undefined);
  const cleanup = h.authorities.cleanupAfterCommit(h.runLocator()),
    row = h.read(),
    run = row.nativeExecution.runs[0];
  checked(
    await h.service.stopRun(h.request, {
      ...h.locate(),
      spaceId: 'north',
      requestId: 'approval-contract-stop',
      runId: run.attempt.id,
      generation: run.attempt.generation,
      segmentId: run.segmentId,
      expectedNodeVersion: row.command.version,
      expectedRunVersion: row.nativeExecution.version,
    }),
  );
  checked(await h.native('stopped', { cleanup }, stable));
  assert.equal(h.owner.snapshot().runs[0].resources, 'settled');
  assert.equal((await h.owner.approve(h.request, command)).ok, false);
  assert.equal(h.owner.snapshot().state, undefined);
  h.faults.drained = true; // Explicit C drain contract, never actual SDK proof.
  assert.equal(checked(await h.owner.approve(h.request, command)).current.generation, 1);
});

test('workspace approval: a new original Run during preparation invalidates the observed overlap set', async (t) => {
  const h = await approvalHost(t, { seed: true }),
    entered = latch(),
    release = latch();
  checked(await h.service.enableRunWriter());
  h.hooks.prepare = async () => {
    entered.resolve();
    await release.promise;
  };
  const approval = h.owner.approve(h.request, approvalCommand());
  await entered.promise;
  checked(await h.service.beginRun(h.request, h.begin({ workspace: localWorkspace })));
  release.resolve();
  refused(await approval, 'workspace-approval-conflict');
  assert.equal(h.owner.snapshot().state, undefined);
});

test('workspace approval: revoke immediately invalidates held local work without waiting for a new drain or directory lookup', async (t) => {
  const h = await approvalHost(t, { seed: true }),
    approved = checked(await h.owner.approve(h.request, approvalCommand())).current;
  checked(await h.service.beginRun(h.request, h.begin({ workspace: localWorkspace })));
  h.hooks.conflicts = [h.owner.snapshot().runs[0].scope];
  h.hooks.missing = true;
  let observed;
  h.owner.onChange(() => {
    observed = h.owner.snapshot().state.approvals[0];
  });
  checked(
    await h.owner.revoke(h.request, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: approved.id,
      expectedGeneration: 1,
    }),
  );
  assert.equal(observed.status, 'revoked');
  assert.equal(observed.generation, 2);
  assert.equal(h.owner.snapshot().runs[0].resources, 'held');
});

test('workspace approval: eight preparations are bounded and close joins all original producer cleanup', async (t) => {
  const h = await approvalHost(t),
    entered = latch(),
    release = latch();
  let pending = 0;
  h.hooks.prepare = async (_input, signal) => {
    if (++pending === 8) entered.resolve();
    await release.promise;
    assert.equal(signal.aborted, true);
  };
  const jobs = Array.from({ length: 8 }, (_, index) =>
    h.owner.approve(h.request, approvalCommand({ workspaceId: `workspace-${index}` })),
  );
  await entered.promise;
  refused(await h.owner.approve(h.request, approvalCommand()), 'workspace-approval-capacity');
  let closed = false;
  const close = h.service.closeRuns().then(() => {
    closed = true;
  });
  await turn();
  assert.equal(closed, false);
  release.resolve();
  for (const result of await Promise.all(jobs)) assert.equal(result.ok, false);
  await close;
  assert.equal(h.calls.release, 8);
  assert.equal(h.counters.workspace_approvals, undefined);
  assert.throws(() => h.owner.snapshot(), { code: 'workspace-approval-unavailable' });
});

test('workspace approval: asynchronous qualification is refused and its completion is owned by close', async (t) => {
  const h = await approvalHost(t),
    entered = latch(),
    finish = latch();
  h.hooks.assert = () => {
    entered.resolve();
    return finish.promise;
  };
  const approval = h.owner.approve(h.request, approvalCommand());
  await entered.promise;
  let closed = false;
  const close = h.service.closeRuns().then(
    () => assert.fail('malformed cleanup cannot report success'),
    (error) => {
      closed = true;
      assert.equal(error.code, 'workspace-approval-cleanup-failed');
    },
  );
  await turn();
  assert.equal(closed, false);
  finish.resolve();
  refused(await approval, 'workspace-approval-unavailable');
  await close;
  assert.equal(h.counters.workspace_approvals, undefined);
  assert.throws(() => h.owner.snapshot(), { code: 'workspace-approval-unavailable' });
});

test('workspace approval: tombstones count toward the 100-row limit, while a full table can still revoke', async (t) => {
  const h = await approvalHost(t);
  for (let index = 0; index < 100; index++)
    checked(
      await h.owner.approve(
        h.request,
        approvalCommand({ workspaceId: `workspace-${index}`, publish: [] }),
      ),
    );
  const rows = h.owner.snapshot().state.approvals,
    revoke = (row) => ({
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: row.id,
      expectedGeneration: row.generation,
    });
  checked(await h.owner.revoke(h.request, revoke(rows[0])));
  const writes = h.counters.workspace_approvals;
  refused(
    await h.owner.approve(h.request, approvalCommand({ workspaceId: 'over-limit' })),
    'workspace-approval-capacity',
  );
  assert.equal(h.counters.workspace_approvals, writes);
  assert.equal(h.owner.snapshot().state.approvals.length, 100);
  assert.equal(checked(await h.owner.revoke(h.request, revoke(rows[1]))).current.status, 'revoked');
});

test('workspace approval: bounded state reserves revocation capacity; malformed publication is refused before preparation', async (t) => {
  const h = await approvalHost(t);
  for (const publish of [
    [{ kind: 'file', path: '/absolute' }],
    [
      { kind: 'file', path: 'one' },
      { kind: 'file', path: 'one' },
    ],
    Array.from({ length: 17 }, (_, index) => ({ kind: 'file', path: `${index}` })),
    Array.from({ length: 9 }, (_, index) => ({ kind: 'file', path: `${index}${'x'.repeat(480)}` })),
  ])
    refused(
      await h.owner.approve(h.request, approvalCommand({ publish })),
      'workspace-approval-validation',
    );
  assert.equal(h.calls.prepare, 0);
  const publish = Array.from({ length: 8 }, (_, index) => ({
    kind: 'file',
    path: `${index}${'x'.repeat(460)}`,
  }));
  let capacity = false;
  for (let index = 0; index < 100; index++) {
    const result = await h.owner.approve(
      h.request,
      approvalCommand({ workspaceId: `bounded-${index}`, publish }),
    );
    if (!result.ok) {
      refused(result, 'workspace-approval-capacity');
      capacity = true;
      break;
    }
  }
  assert.equal(capacity, true);
  const state = h.owner.snapshot().state;
  assert.ok(state.approvals.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) + state.approvals.length * 512 <= 262144);
  const first = state.approvals[0];
  checked(
    await h.owner.revoke(h.request, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: first.id,
      expectedGeneration: first.generation,
    }),
  );
  assert.equal(h.owner.snapshot().state.approvals[0].status, 'revoked');
});

test('workspace approval: expired receipt cannot restore an old generation, retained retries return latest state', async (t) => {
  const h = await approvalHost(t),
    oldest = approvalCommand({ publish: [] });
  let current = checked(await h.owner.approve(h.request, oldest)).current,
    recent;
  for (let index = 0; index < 17; index++) {
    recent = {
      ...oldest,
      requestId: randomUUID(),
      expectedGeneration: current.generation,
      access: index % 2 ? 'read' : 'write',
    };
    current = checked(await h.owner.approve(h.request, recent)).current;
  }
  assert.equal(current.receipts.length, 16);
  checked(
    await h.owner.revoke(h.request, {
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: current.id,
      expectedGeneration: current.generation,
    }),
  );
  const before = h.counters.workspace_approvals;
  refused(await h.owner.approve(h.request, oldest), 'workspace-approval-conflict');
  assert.equal(checked(await h.owner.approve(h.request, recent)).current.status, 'revoked');
  assert.equal(h.counters.workspace_approvals, before);
});

test('workspace approval: source loss wakes existing consumers and refuses old metadata as live authority', async (t) => {
  const h = await approvalHost(t);
  checked(await h.owner.approve(h.request, approvalCommand()));
  let wakes = 0;
  h.owner.onChange(() => wakes++);
  h.life.abort();
  assert.equal(wakes, 1);
  assert.throws(() => h.owner.snapshot(), { code: 'workspace-approval-unavailable' });
  refused(
    await h.owner.list(h.request, { spaceId: 'north', projectId: 'project' }),
    'workspace-approval-unavailable',
  );
});

test('workspace approval: malformed producer result still releases its original resources', async (t) => {
  const h = await approvalHost(t);
  h.hooks.qualification = (lease) => ({ ...lease, assertCurrent: undefined });
  refused(await h.owner.approve(h.request, approvalCommand()), 'workspace-approval-unavailable');
  assert.equal(h.calls.release, 1);
  assert.equal(h.counters.workspace_approvals, undefined);
});

test('workspace approval contract: a bounded Run observation refusal cannot prevent durable revocation', async (t) => {
  const h = await approvalHost(t),
    approved = checked(await h.owner.approve(h.request, approvalCommand())).current;
  // Explicit pure source contract around a real prior row. Run observation is
  // not part of revocation authority; no SDK/physical-drain claim is made.
  let state = h.owner.snapshot().state,
    puts = 0;
  const source = {
    signal: h.source.signal,
    read: () => state,
    write: async (next) => {
      state = structuredClone(next);
      puts++;
    },
    assertCompatible() {},
    async enableWriter() {},
    enqueue: (work) => work(),
    member: async () => ({
      actorId: 'chen',
      signal: h.member.signal,
      assertCurrent() {},
      release() {},
    }),
    runs: () => assert.fail('revoke cannot depend on scanning all retained Runs'),
    assertDrained: () => assert.fail('revoke cannot require a new drain'),
    notify() {},
  };
  const service = new ExecutionWorkspaceApprovals(source, h.source);
  try {
    const result = checked(
      await service.owner.revoke(h.request, {
        requestId: randomUUID(),
        spaceId: 'north',
        projectId: 'project',
        approvalId: approved.id,
        expectedGeneration: 1,
      }),
    );
    assert.equal(result.current.status, 'revoked');
    assert.equal(puts, 1);
  } finally {
    await service.close();
  }
});
