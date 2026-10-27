import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeRecordKey } from '@zhuma/agent-core';
import { openWorkflowContract, completeWorkflowTicket } from './execution-workflow-fixture.mjs';
import { checked, refused, caller } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { effectiveWorkflowToolKind } from '../dist/execution-workflow-tools.js';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';

// Original Service/queue and actual DSH JSON. Identity/config/completion producers
// are explicit contracts; no SDK Agent, model, Host factory, or GUI proof.
async function host(t, policy = 'accepted-input-reader') {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-workflow-tools-'));
  const h = await openWorkflowContract(root);
  h.defaults.tools = policy;
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...h, root };
}
async function joinTicket(h, view) {
  const tickets = checked(await h.claim(view)).tickets;
  const first = await completeWorkflowTicket(h, tickets[0], 'Fixed first input.');
  await completeWorkflowTicket(h, tickets[1], 'Fixed second input.');
  for (const actor of ['outside', 'chen'])
    checked(
      await h.service.ballot(caller(actor), {
        ...h.locate('first'),
        expectedVersion: h.row('first').command.version,
        idempotencyKey: `review-${actor}`,
        roundId: first.roundId,
        artifactVersionId: first.artifactVersionId,
        action: 'approve',
      }),
    );
  assert.equal(h.row('join').command.status, 'ready');
  assert.equal(h.row('join').handoff.inputRefs.length, 2);
  return checked(await h.claim(view)).tickets[0];
}

test('workflow tools: one reader policy starts empty roots as text-only, then starts the accepted join as a reader', async (t) => {
  const h = await host(t),
    view = await h.start(2);
  const ticket = await joinTicket(h, view);
  assert.equal(h.row('first').nativeExecution.runs[0].composition.payload.tools.kind, 'text-only');
  const body = h.beginBody(ticket);
  assert.equal(body.composition.payload.tools.kind, 'accepted-input-reader');
  assert.equal(body.composition.payload.inputs.length, 2);
  assert.equal(
    ticket.defaults.tools,
    'accepted-input-reader',
    'the workflow policy is not rewritten per node',
  );
  const begun = checked(await h.service.startRun(h.request, body, ticket));
  assert.equal(begun.run.composition.payload.tools.kind, 'accepted-input-reader');
  assert.deepEqual(h.row('join').handoff.inputRefs, body.composition.payload.handoff.inputRefs);
});

test('workflow tools: default text-only cannot upgrade to a reader for accepted downstream inputs', async (t) => {
  const h = await host(t, 'text-only'),
    view = await h.start(2);
  const ticket = await joinTicket(h, view);
  const body = h.beginBody(
    ticket,
    {},
    { tools: { kind: 'accepted-input-reader', definition: describeAcceptedInputTool() } },
  );
  const before = await businessHashes(h.root);
  h.resetCounts();
  refused(await h.service.startRun(h.request, body, ticket), 'workflow-defaults-mismatch');
  assert.equal(h.row('join').nativeExecution, undefined);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

test('workflow tools: root with wrong reader kind is refused with no Run or extra writes', async (t) => {
  const h = await host(t),
    view = await h.start();
  const ticket = checked(await h.claim(view)).tickets[0],
    body = structuredClone(h.beginBody(ticket));
  body.composition.payload.tools = {
    kind: 'accepted-input-reader',
    definition: describeAcceptedInputTool(),
  };
  assert.throws(() => h.service.workflows().assertBegin(body, 'chen', ticket), {
    code: 'workflow-defaults-mismatch',
  });
  const before = await businessHashes(h.root);
  h.resetCounts();
  refused(await h.service.startRun(h.request, body, ticket), 'validation');
  assert.equal(h.row('first').nativeExecution, undefined);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

test('workflow tools: caller cannot pretend pinned downstream inputs are empty to obtain text-only', async (t) => {
  const h = await host(t),
    view = await h.start(2),
    ticket = await joinTicket(h, view);
  const body = structuredClone(h.beginBody(ticket));
  body.composition.payload.handoff.inputRefs = [];
  body.composition.payload.inputs = [];
  body.composition.payload.tools = { kind: 'text-only' };
  assert.throws(() => h.service.workflows().assertBegin(body, 'chen', ticket), {
    code: 'workflow-defaults-mismatch',
  });
  const before = await businessHashes(h.root);
  h.resetCounts();
  refused(await h.service.startRun(h.request, body, ticket), 'validation');
  assert.equal(h.row('join').nativeExecution, undefined);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
});

for (const downstream of [false, true])
  test(`workflow tools: ${downstream ? 'accepted input changes' : 'root inputs change'} before the final put invalidates the original ticket`, async (t) => {
    const h = await host(t),
      view = await h.start(downstream ? 2 : 1);
    const ticket = downstream ? await joinTicket(h, view) : checked(await h.claim(view)).tickets[0];
    const nodeId = ticket.reservation.nodeId,
      body = h.beginBody(ticket);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.after(() => release.resolve());
    const commit = h.service.commitRunDecision.bind(h.service);
    h.service.commitRunDecision = async (decision, beforeWrite) => {
      entered.resolve();
      await release.promise;
      return commit(decision, beforeWrite);
    };
    const pending = h.service.startRun(h.request, body, ticket);
    await Promise.race([
      entered.promise,
      pending.then((value) => assert.fail(JSON.stringify(value))),
    ]);
    const row = h.row(nodeId);
    const refs = downstream
      ? row.handoff.inputRefs.map((ref, index) =>
          index ? ref : { ...ref, artifactVersionId: 'changed-fixed-version' },
        )
      : [{ sourceNodeId: 'other-source', artifactVersionId: 'other-fixed-version' }];
    // Controlled external fact change after preparation, before the original put gate.
    await h.domain
      .table('nodes')
      .put(nodeRecordKey(row), { ...row, handoff: { ...row.handoff, inputRefs: refs } });
    const before = await businessHashes(h.root);
    h.resetCounts();
    release.resolve();
    refused(await pending, 'workflow-start-ticket-invalid');
    assert.equal(h.row(nodeId).nativeExecution, undefined);
    assert.deepEqual(await businessHashes(h.root), before);
    assert.deepEqual(h.counters, { nodes: 0, plans: 0, global: 0 });
  });

test('workflow tools: policy derives from validated refs, never grants an upgrade or changes local policy', () => {
  const refs = [{ sourceNodeId: 'upstream', artifactVersionId: 'fixed-artifact' }];
  assert.equal(effectiveWorkflowToolKind('accepted-input-reader', []), 'text-only');
  assert.equal(effectiveWorkflowToolKind('accepted-input-reader', refs), 'accepted-input-reader');
  assert.equal(effectiveWorkflowToolKind('text-only', []), 'text-only');
  assert.throws(() => effectiveWorkflowToolKind('text-only', refs), {
    code: 'workflow-defaults-mismatch',
  });
  assert.equal(effectiveWorkflowToolKind('local-tools', []), 'local-tools');
  assert.equal(effectiveWorkflowToolKind('local-tools', refs), 'local-tools');
  for (const unknown of [
    undefined,
    null,
    {},
    [undefined],
    [{}],
    [{ sourceNodeId: 'upstream' }],
    [{ sourceNodeId: '', artifactVersionId: 'fixed' }],
    [{ ...refs[0], unknown: true }],
    [refs[0], refs[0]],
  ])
    assert.throws(() => effectiveWorkflowToolKind('accepted-input-reader', unknown), {
      code: 'workflow-defaults-mismatch',
    });
  assert.deepEqual(refs, [{ sourceNodeId: 'upstream', artifactVersionId: 'fixed-artifact' }]);
});
