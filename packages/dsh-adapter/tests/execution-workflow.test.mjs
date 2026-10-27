import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fork } from 'node:child_process';
import { openWorkflowContract, completeWorkflowTicket } from './execution-workflow-fixture.mjs';
import { checked, refused, caller } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { localWorkspace, event, stable } from './execution-run-fixture.mjs';
import {
  executionPlanReceiptSchema,
  workflowExecutionIntentSchema,
} from '../dist/execution-workflow-contract.js';
import { EXECUTION_RESOURCE_SOURCE_VERSION } from '../dist/execution-run-resource-snapshot.js';

async function host(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-workflow-contract-'));
  const h = await openWorkflowContract(root, options);
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...h, root };
}

test('workflow contract: explicit start initializes the original plan; same-key replay/read never writes or starts a Run', async (t) => {
  const h = await host(t),
    body = h.startBody();
  const view = checked(await h.service.startWorkflowExecution(h.request, body));
  assert.equal(view.intent.generation, 1);
  assert.equal(view.state, 'running');
  assert.equal(view.requiresResume, false);
  assert.equal(h.row('first').command.status, 'ready');
  assert.equal(h.row('human').command.status, 'ready');
  assert.equal(h.row('first').nativeExecution, undefined);
  const before = await businessHashes(h.root);
  h.resetCounts();
  assert.equal(
    checked(await h.service.startWorkflowExecution(h.request, body)).disposition,
    'replayed',
  );
  checked(await h.service.readWorkflowExecution(h.request, h.location));
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

for (const closeFailure of [false, true])
  test(`workflow resource contract: Stop owns late preparation drain${closeFailure ? ' and retains failed cleanup' : ''}`, async (t) => {
    const h = await host(t, { resources: true });
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.after(() => release.resolve());
    let preparations = 0,
      released = 0;
    h.service.runHost.prepareResourceCatalog = async (request, input) => {
      preparations++;
      checked(
        await h.service.readRunCompositionInputs(request, {
          ...h.locate(input.nodeId),
          spaceId: 'north',
        }),
      );
      entered.resolve();
      await release.promise;
      const life = new AbortController();
      return {
        catalog: { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] },
        signal: life.signal,
        assertCurrent() {
          life.signal.throwIfAborted();
        },
        release() {
          released++;
          life.abort();
          if (closeFailure) throw Error('CONTRACT_QUALIFICATION_CLOSE_FAILED');
        },
      };
    };
    const view = await h.start(),
      ticket = checked(await h.claim(view)).tickets[0],
      body = h.beginBody(ticket);
    assert.ok(body.composition.payload.resources);
    refused(
      await h.service.startRun(h.request, body, { ...ticket }),
      'workflow-start-ticket-invalid',
    );
    assert.equal(preparations, 0, 'a clone cannot enter the private provider');
    const pending = h.service.startRun(h.request, body, ticket);
    await Promise.race([
      entered.promise,
      pending.then((value) => assert.fail(JSON.stringify(value))),
    ]);
    const stopped = checked(
      await h.service.stopWorkflowExecution(h.request, h.control(view, 'stop-preparing')),
    );
    assert.equal(ticket.signal.aborted, true);
    assert.equal(stopped.activeRunIds.length, 0);
    assert.equal(stopped.state, 'stopping', 'no durable Run is not physical drain proof');
    refused(
      await h.service.resumeWorkflowExecution(h.request, {
        ...h.control(stopped, 'resume-preparing'),
        expectedVersion: stopped.intent.version,
      }),
      'workflow-recovery-required',
    );
    release.resolve();
    refused(await pending, 'run-authority-unavailable');
    assert.equal(released, 1);
    const after = checked(await h.service.readWorkflowExecution(h.request, h.location));
    assert.equal(after.state, closeFailure ? 'stopping' : 'paused');
    assert.equal(h.row('first').nativeExecution, undefined);
    if (closeFailure) {
      refused(
        await h.service.resumeWorkflowExecution(h.request, {
          ...h.control(after, 'resume-failed-close'),
          expectedVersion: after.intent.version,
        }),
        'workflow-recovery-required',
      );
      await assert.rejects(h.service.closeRuns(), (error) => error.cleanupFailed === true);
      await h.disposeExecution();
    }
  });

test('workflow contract: actual two-slot admission mints fixed tickets for two ready experts, never the human or join', async (t) => {
  const h = await host(t),
    view = await h.start(2);
  const claim = checked(await h.claim(view));
  assert.deepEqual(
    claim.tickets.map((ticket) => ticket.reservation.nodeId),
    ['first', 'second'],
  );
  assert.equal(h.row('join').command.status, 'blocked');
  assert.equal(h.row('human').nativeExecution, undefined);
  for (const ticket of claim.tickets)
    checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  const next = checked(await h.claim(view));
  assert.equal(next.tickets.length, 0);
  assert.equal(next.view.activeRunIds.length, 2);
  assert.equal(next.view.intent.starts.length, 2);
  assert.equal(
    next.view.intent.generation,
    1,
    'allocator CAS writes do not change control generation',
  );
});

test('workflow contract: unchanged claim is zero-write and an empty-ready pass has no polling writes', async (t) => {
  const h = await host(t),
    view = await h.start();
  const first = checked(await h.claim(view));
  assert.equal(first.tickets.length, 1);
  const before = await businessHashes(h.root);
  h.resetCounts();
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(h.counters.plans, 0);
});

test('workflow contract: busy permit yields without changing its durable IDs or starving the second branch', async (t) => {
  const h = await host(t),
    view = await h.start();
  const first = checked(await h.claim(view)).tickets[0],
    reservation = first.reservation;
  first.deferBusy();
  assert.equal(first.signal.aborted, true);
  const second = checked(await h.claim(view)).tickets[0];
  assert.equal(second.reservation.nodeId, 'second');
  second.deferBusy();
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
  assert.deepEqual(
    checked(await h.service.readWorkflowExecution(h.request, h.location)).intent.starts[0],
    reservation,
  );
});

test('workflow contract: a cloned ticket and serialized reserved IDs cannot create a Run', async (t) => {
  const h = await host(t),
    view = await h.start(),
    ticket = checked(await h.claim(view)).tickets[0];
  const body = h.beginBody(ticket);
  refused(
    await h.service.startRun(h.request, body, { ...ticket }),
    'workflow-start-ticket-invalid',
  );
  refused(await h.service.startRun(h.request, body), 'workflow-start-ticket-required');
  assert.equal(h.row('first').nativeExecution, undefined);
});

test('workflow contract: trusted member snapshot does not replace the original retained Host request', async (t) => {
  const h = await host(t),
    view = await h.start(),
    other = Object.freeze({ headers: {} });
  h.members.set(other, 'chen');
  refused(
    await h.service.claimWorkflowExecution(other, {
      ...h.location,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    }),
    'workflow-authority-denied',
  );
  assert.equal(checked(await h.claim(view)).tickets.length, 1);
});

test('workflow contract: unavailable expert produces no ticket or allocation write', async (t) => {
  const h = await host(t),
    view = await h.start();
  h.setWorkbench((workbench) => ({
    ...workbench,
    participants: workbench.participants.map((p) =>
      p.id === 'qa' ? { ...p, available: false } : p,
    ),
  }));
  h.resetCounts();
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
  assert.equal(h.counters.plans, 0);
});

test('workflow contract: a parallel join waits for both fixed deliveries and every configured review', async (t) => {
  const h = await host(t),
    view = await h.start(2),
    tickets = checked(await h.claim(view)).tickets;
  const first = await completeWorkflowTicket(h, tickets[0], 'First fixed branch result.');
  const second = await completeWorkflowTicket(h, tickets[1], 'Second fixed branch result.');
  assert.equal(h.row('first').command.status, 'in-review');
  assert.equal(h.row('second').command.status, 'completed');
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
  const ballot = (actor, key) =>
    h.service.ballot(caller(actor), {
      ...h.locate('first'),
      expectedVersion: h.row('first').command.version,
      idempotencyKey: key,
      roundId: first.roundId,
      artifactVersionId: first.artifactVersionId,
      action: 'approve',
    });
  checked(await ballot('outside', 'review-one'));
  assert.equal(h.row('join').command.status, 'blocked');
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
  checked(await ballot('chen', 'review-two'));
  assert.equal(h.row('join').command.status, 'ready');
  assert.deepEqual(
    h
      .row('join')
      .handoff.inputRefs.map((ref) => ref.artifactVersionId)
      .sort(),
    [first.artifactVersionId, second.artifactVersionId].sort(),
  );
  const join = checked(await h.claim(view));
  assert.deepEqual(
    join.tickets.map((ticket) => ticket.reservation.nodeId),
    ['join'],
  );
  assert.equal(h.row('human').nativeExecution, undefined);
});

test('workflow contract: concurrency two does not bypass the original same-root writer exclusion', async (t) => {
  const h = await host(t);
  h.defaults.workspace = localWorkspace;
  const view = await h.start(2),
    tickets = checked(await h.claim(view)).tickets;
  checked(await h.service.startRun(h.request, h.beginBody(tickets[0]), tickets[0]));
  refused(
    await h.service.startRun(h.request, h.beginBody(tickets[1]), tickets[1]),
    'run-workspace-busy',
  );
  assert.equal(tickets[1].signal.aborted, true, 'busy releases its ephemeral permit');
  assert.equal(h.row('second').nativeExecution, undefined);
  assert.equal(checked(await h.claim(view)).tickets.length, 0);
});

test('workflow contract: Stop remains stopping until original Run cancellation and resource settlement', async (t) => {
  const h = await host(t);
  let physicallyDrained = false;
  h.service.runHost.migrationDrain = () =>
    physicallyDrained ? { signal: h.source.signal, assertCurrent() {} } : undefined;
  const view = await h.start(),
    ticket = checked(await h.claim(view)).tickets[0];
  const begun = checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  const opened = await h.authorities.open(
    h.request,
    { ...h.locate('first'), runId: begun.run.attempt.id },
    'drive',
  );
  t.after(() => opened.dispose());
  checked(
    await h.service.recordRunEvent(
      h.locate('first'),
      event(h.row('first'), 'accepted', {
        nativeSessionId: 'workflow-session',
        executorRunId: 'workflow-agent',
      }),
      { grant: opened.grant },
    ),
  );
  const stopping = checked(
    await h.service.stopWorkflowExecution(h.request, h.control(view, 'stop-running')),
  );
  assert.equal(stopping.state, 'stopping');
  assert.equal(stopping.activeRunIds.length, 1);
  const node = h.row('first'),
    run = node.nativeExecution.runs[0];
  checked(
    await h.service.stopRun(h.request, {
      ...h.locate('first'),
      spaceId: 'north',
      requestId: 'original-stop',
      runId: run.attempt.id,
      generation: run.attempt.generation,
      segmentId: run.segmentId,
      expectedNodeVersion: node.command.version,
      expectedRunVersion: node.nativeExecution.version,
    }),
  );
  assert.equal(
    checked(await h.service.readWorkflowExecution(h.request, h.location)).state,
    'stopping',
  );
  checked(
    await h.service.recordRunEvent(h.locate('first'), event(h.row('first'), 'stopped', stable), {
      grant: opened.grant,
    }),
  );
  assert.equal(
    checked(await h.service.readWorkflowExecution(h.request, h.location)).state,
    'stopping',
    'persisted settled alone is insufficient',
  );
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...h.control(stopping, 'resume-before-proof'),
      expectedVersion: stopping.intent.version,
    }),
    'workflow-recovery-required',
  );
  physicallyDrained = true;
  const paused = checked(await h.service.readWorkflowExecution(h.request, h.location));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.activeRunIds.length, 0);
  assert.notEqual(paused.state, 'completed');
  const resumed = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...h.control(paused, 'resume-after-proof'),
      expectedVersion: paused.intent.version,
    }),
  );
  const next = checked(await h.claim(resumed)).tickets[0];
  assert.equal(
    next.reservation.nodeId,
    'second',
    'automatic retry budget does not restart the cancelled first node',
  );
  physicallyDrained = false;
  assert.throws(() => next.check(), { code: 'workflow-recovery-required' });
  assert.equal(h.row('second').nativeExecution, undefined);
});

test('workflow contract: schemas bound receipts, duplicate IDs and total bytes without trimming history', async (t) => {
  const h = await host(t),
    view = await h.start();
  assert.equal(
    executionPlanReceiptSchema.safeParse({
      idempotencyKey: 'legacy',
      fingerprint: 'legacy',
      nodeIds: [],
    }).success,
    true,
  );
  for (const invalid of [
    {
      ...view.intent,
      commandReceipts: Array.from({ length: 129 }, (_, i) => ({
        ...view.intent.commandReceipts[0],
        requestId: `command-${i}`,
      })),
    },
    {
      ...view.intent,
      commandReceipts: [view.intent.commandReceipts[0], view.intent.commandReceipts[0]],
    },
    {
      ...view.intent,
      defaults: {
        ...view.intent.defaults,
        model: { ...view.intent.defaults.model, model: 'x'.repeat(70_000) },
      },
    },
  ])
    assert.equal(workflowExecutionIntentSchema.safeParse(invalid).success, false);
  const large = workflowExecutionIntentSchema.safeParse({
    ...view.intent,
    starts: Array.from({ length: 100 }, (_, i) => ({
      intentId: view.intent.intentId,
      generation: 1,
      nodeId: `node-${i}`,
      expectedNodeVersion: 0,
      expectedRunVersion: 0,
      requestId: `request-${i}-${'r'.repeat(180)}`,
      newRunId: `run-${i}-${'r'.repeat(180)}`,
      newSegmentId: `segment-${i}-${'r'.repeat(180)}`,
      expertId: 'e'.repeat(200),
      expertVersionId: 'v'.repeat(200),
      inputsFingerprint: 'a'.repeat(64),
    })),
  });
  assert.equal(large.success, false);
  assert.ok(
    large.error.issues.some((issue) => issue.message === 'Workflow metadata budget exceeded.'),
  );
});

test('workflow contract: receipt capacity reserves a final Stop instead of evicting history', async (t) => {
  const h = await host(t),
    view = await h.start();
  const key = `${h.location.taskId}:${h.location.planId}:${h.location.revision}`;
  const receipt = h.service.storage.readPlan(key);
  const commandReceipts = Array.from({ length: 127 }, (_, i) => ({
    ...view.intent.commandReceipts[0],
    requestId: `prior-${i}`,
  }));
  await h.service.storage.writePlan(key, {
    ...receipt,
    workflowExecution: { ...view.intent, commandReceipts },
  });
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, h.control(view, 'last-stop')),
  );
  assert.equal(stopped.intent.commandReceipts.length, 128);
  assert.equal(stopped.intent.commandReceipts[0].requestId, 'prior-0');
  const before = await businessHashes(h.root);
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...h.control(stopped, 'over-capacity'),
      expectedVersion: stopped.intent.version,
    }),
    'workflow-capacity',
  );
  assert.deepEqual(await businessHashes(h.root), before);
});

test('workflow contract: a lost allocation put response never mints replacement IDs or guesses that a Run was unsent', async (t) => {
  const h = await host(t),
    view = await h.start();
  const write = h.service.storage.writePlan;
  let once = true;
  h.service.storage.writePlan = async (...args) => {
    await write(...args);
    if (once) {
      once = false;
      throw Error('CONTRACT_PLAN_ACK_LOST');
    }
  };
  assert.equal((await h.claim(view)).ok, false);
  h.service.storage.writePlan = write;
  const stored = checked(await h.service.readWorkflowExecution(h.request, h.location)).intent
    .starts[0];
  const ticket = checked(await h.claim(view)).tickets[0];
  assert.deepEqual(
    ticket.reservation,
    stored,
    'same live owner reconciles one persisted reservation',
  );
  h.resetCounts();
  checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  const replay = checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.effect.kind, 'reconcile');
  assert.equal(h.counters.nodes, 1);
});

test('workflow contract: model changes after allocation cannot override the frozen defaults', async (t) => {
  const h = await host(t),
    view = await h.start(),
    ticket = checked(await h.claim(view)).tickets[0];
  const body = h.beginBody(ticket);
  body.selection = { ...body.selection, model: 'different-model' };
  refused(await h.service.startRun(h.request, body, ticket), 'workflow-defaults-mismatch');
  assert.equal(h.row('first').nativeExecution, undefined);
});

test('workflow contract: a lost original Run put response reconciles the same receipt without another node write or dispatch', async (t) => {
  const h = await host(t),
    view = await h.start(),
    ticket = checked(await h.claim(view)).tickets[0];
  const body = h.beginBody(ticket),
    write = h.service.storage.writeNode;
  let once = true;
  h.service.storage.writeNode = async (...args) => {
    await write(...args);
    if (once) {
      once = false;
      throw Error('CONTRACT_RUN_ACK_LOST');
    }
  };
  refused(await h.service.startRun(h.request, body, ticket), 'unavailable');
  assert.equal(h.row('first').nativeExecution.runs.length, 1);
  h.service.storage.writeNode = write;
  h.resetCounts();
  const replay = checked(await h.service.startRun(h.request, body, ticket));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.effect.kind, 'reconcile');
  assert.equal(replay.run.attempt.id, ticket.reservation.newRunId);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

for (const mode of ['no-reservation', 'unknown-reservation', 'held-run'])
  test(`workflow contract: new OS cold ${mode} is zero-write until explicit action and never replays a Run`, async (t) => {
    const h = await host(t),
      view = await h.start();
    if (mode !== 'no-reservation') {
      const ticket = checked(await h.claim(view)).tickets[0];
      if (mode === 'held-run')
        checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
    }
    const snapshot = h.readWorkbench();
    await h.close();
    const child = fork(
      new URL('./fixtures/workflow-cold-child.mjs', import.meta.url),
      [h.root, JSON.stringify(snapshot)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    t.after(() => child.kill());
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const message = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(Error(`cold child ${code}: ${stderr}`));
      });
    });
    assert.deepEqual(message.before, message.afterRead);
    assert.equal(checked(message.read).requiresResume, true);
    assert.equal(
      checked(message.replay).requiresResume,
      true,
      'start replay does not arm a new Host',
    );
    refused(message.claim, 'workflow-authority-denied');
    assert.equal(message.counters.nodes, 0);
    assert.equal(message.counters.global, 0);
    if (mode === 'no-reservation') assert.equal(checked(message.resume).intent.generation, 2);
    else {
      refused(message.resume, 'workflow-recovery-required');
      assert.equal(message.counters.plans, 0);
    }
  });

test('workflow contract: explicit Stop/Resume preserves command history and rejects an old generation Stop', async (t) => {
  const h = await host(t),
    view = await h.start(),
    ticket = checked(await h.claim(view)).tickets[0];
  const stopped = checked(
    await h.service.stopWorkflowExecution(h.request, h.control(view, 'stop-workflow')),
  );
  assert.equal(stopped.intent.status, 'stopping');
  assert.equal(stopped.state, 'paused');
  assert.equal(ticket.signal.aborted, true);
  const resumed = checked(
    await h.service.resumeWorkflowExecution(h.request, {
      ...h.control(stopped, 'resume-workflow'),
      expectedVersion: stopped.intent.version,
    }),
  );
  assert.equal(resumed.intent.generation, 2);
  const next = checked(await h.claim(resumed)).tickets[0];
  refused(
    await h.service.stopWorkflowExecution(h.request, h.control(view, 'late-old-stop')),
    'workflow-stale-generation',
  );
  assert.equal(next.signal.aborted, false);
  assert.deepEqual(
    resumed.intent.commandReceipts.map((r) => r.kind),
    ['start', 'stop', 'resume'],
  );
});

for (const conflictingKind of ['start', 'resume'])
  test(`workflow contract: a Stop conflicting with ${conflictingKind} keeps the original live claim and ticket`, async (t) => {
    const h = await host(t);
    let view = await h.start();
    if (conflictingKind === 'resume') {
      const stopped = checked(
        await h.service.stopWorkflowExecution(h.request, h.control(view, 'prepare-stop')),
      );
      view = checked(
        await h.service.resumeWorkflowExecution(h.request, {
          ...h.control(stopped, 'resume-workflow'),
          expectedVersion: stopped.intent.version,
        }),
      );
    }
    const claim = checked(await h.claim(view)),
      ticket = claim.tickets[0];
    const before = await businessHashes(h.root);
    h.resetCounts();
    refused(
      await h.service.stopWorkflowExecution(
        h.request,
        h.control(view, `${conflictingKind}-workflow`),
      ),
      'workflow-idempotency-mismatch',
    );
    assert.deepEqual(await businessHashes(h.root), before);
    assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
    assert.equal(claim.signal.aborted, false);
    assert.equal(ticket.signal.aborted, false);
    assert.equal(claim.check(), undefined);
    assert.equal(ticket.check(), undefined);
    assert.equal(
      checked(await h.service.readWorkflowExecution(h.request, h.location)).requiresResume,
      false,
    );
    checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  });

test('workflow contract: capacity-rejected Resume preserves the existing live claim and ticket', async (t) => {
  const h = await host(t),
    view = await h.start();
  const key = `${h.location.taskId}:${h.location.planId}:${h.location.revision}`;
  const receipt = h.service.storage.readPlan(key);
  const commandReceipts = [
    view.intent.commandReceipts[0],
    ...Array.from({ length: 126 }, (_, i) => ({
      ...view.intent.commandReceipts[0],
      requestId: `prior-resume-${i}`,
    })),
  ];
  await h.service.storage.writePlan(key, {
    ...receipt,
    workflowExecution: { ...view.intent, commandReceipts },
  });
  const claim = checked(await h.claim(view)),
    ticket = claim.tickets[0];
  const before = await businessHashes(h.root);
  h.resetCounts();
  refused(
    await h.service.resumeWorkflowExecution(h.request, {
      ...h.control(claim.view, 'over-capacity-live-resume'),
      expectedVersion: claim.view.intent.version,
    }),
    'workflow-capacity',
  );
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
  assert.equal(claim.signal.aborted, false);
  assert.equal(ticket.signal.aborted, false);
  assert.equal(claim.check(), undefined);
  assert.equal(ticket.check(), undefined);
  assert.equal(
    checked(await h.service.readWorkflowExecution(h.request, h.location)).requiresResume,
    false,
  );
  checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
});

for (const action of ['stop', 'revoke'])
  test(`workflow contract: ${action} after prepare but before the original node put rejects the late genuine ticket`, async (t) => {
    const h = await host(t),
      view = await h.start(),
      ticket = checked(await h.claim(view)).tickets[0];
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.after(() => release.resolve());
    const original = h.service.commitRunDecision.bind(h.service);
    h.service.commitRunDecision = async (decision, beforeWrite) => {
      entered.resolve();
      await release.promise;
      return original(decision, beforeWrite);
    };
    h.resetCounts();
    const pending = h.service.startRun(h.request, h.beginBody(ticket), ticket);
    await Promise.race([
      entered.promise,
      pending.then((value) => assert.fail(JSON.stringify(value))),
    ]);
    let stopping;
    if (action === 'stop')
      stopping = h.service.stopWorkflowExecution(h.request, h.control(view, 'stop-before-put'));
    else h.member.abort();
    await setImmediate();
    assert.equal(ticket.signal.aborted, true);
    release.resolve();
    assert.equal((await pending).ok, false);
    if (stopping) checked(await stopping);
    assert.equal(h.row('first').nativeExecution, undefined);
    assert.equal(h.counters.nodes, 0);
  });
