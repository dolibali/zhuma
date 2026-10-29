import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createHostRunOptions } from '../dist/host-run-options.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import { accepted, applyEvent, begin, stable } from './execution-run-fixture.mjs';

// Metadata/producer contracts. Stand-in authorization never proves a real member lease.
function setup({ expert = false, list, timeout = 1000, localSelection = false } = {}) {
  const ctx = new Context();
  const facts = compositionFacts({ expert });
  const signal = new AbortController();
  const request = { headers: {} };
  let authorized = true;
  let reads = 0,
    catalogs = 0;
  const execution = {
    async readRunCompositionInputs(original, query) {
      assert.equal(original, request);
      assert.equal(query.spaceId, facts.scope.spaceId);
      assert.equal(
        'runId' in query,
        false,
        'History selection must not widen the original input-authority query',
      );
      reads++;
      if (!authorized) return { ok: false, error: { code: 'denied' } };
      return { ok: true, value: facts.inputs };
    },
    readRunNode: () => facts.node,
    readRunComposition: () => ({ payload: { model: facts.model, executor: { kind: 'builtin' } } }),
  };
  ctx.provide('llm', {
    listProviders: () => {
      assert.equal(localSelection, false, 'Shared metadata must not discover backend providers');
      return [{ id: 'contract' }];
    },
    async listModels(provider) {
      catalogs++;
      return list ? list(provider) : [{ provider, id: 'actual-model', name: 'Configured model' }];
    },
    generate() {
      throw Error('Options must not invoke inference');
    },
  });
  const read = createHostRunOptions(ctx, {
    execution,
    readWorkbench: () => facts.workbench,
    signal: signal.signal,
    modelTimeoutMs: timeout,
    ...(localSelection
      ? {
          localSelection: true,
          workspaces: {
            choices() {
              assert.fail('Shared metadata must not read backend directories');
            },
          },
        }
      : {}),
  });
  const { taskId, planId, revision, nodeId, spaceId } = facts.scope;
  return {
    ctx,
    facts,
    signal,
    request,
    read,
    query: { taskId, planId, revision, nodeId, spaceId },
    deny() {
      authorized = false;
    },
    counts: () => ({ reads, catalogs }),
  };
}

test('options contract: shared member metadata keeps actual node facts but never discovers backend models/directories', async (t) => {
  const h = setup({ localSelection: true });
  t.after(() => h.ctx.fiber.dispose());
  const before = JSON.stringify(h.facts);
  const { value } = await h.read(h.request, h.query);
  assert.equal(value.models.kind, 'unavailable');
  assert.equal(Object.hasOwn(value, 'workspaces'), false);
  assert.equal(Object.hasOwn(value, 'workspaceApprovalScope'), false);
  assert.equal(value.currentRunId, null);
  assert.equal(value.currentRun, null);
  assert.equal(value.nodeVersion, h.facts.node.command.version);
  assert.equal(value.start.kind, 'available');
  assert.deepEqual(
    value.experts.map((expert) => expert.value.kind),
    ['builtin', 'plan-expert'],
  );
  assert.deepEqual(h.counts(), { reads: 2, catalogs: 0 });
  assert.equal(
    JSON.stringify(h.facts),
    before,
    'Metadata never creates a Run or changes its facts',
  );
  h.facts.node = begin(h.facts.node).record;
  const saved = h.facts.node.nativeExecution.runs[0];
  const next = (await h.read(h.request, h.query)).value.currentRun;
  assert.equal(next.runId, saved.attempt.id);
  assert.equal(next.generation, saved.attempt.generation);
  assert.equal(next.segmentId, saved.segmentId);
  assert.equal(next.dispatch, saved.dispatch);
  assert.equal(next.acknowledged, saved.attempt.acknowledged);
  assert.equal(next.resources, saved.resources);
  assert.equal(next.stopPhase, saved.attempt.stopPhase);
  assert.equal(next.native, null, 'A backend cannot certify member-local native readiness');
});

test('shared metadata: explicit historical Run projects its original facts without selecting the latest or mutating either', async (t) => {
  const h = setup({ localSelection: true });
  t.after(() => h.ctx.fiber.dispose());
  let row = accepted(begin(h.facts.node).record);
  row = applyEvent(row, 'failed', { resourcesSettled: true }).record;
  const prior = structuredClone(row.nativeExecution.runs[0]);
  row = begin(row, {
    mode: 'retry',
    requestId: 'retry-history',
    newRunId: 'run-history-2',
    newSegmentId: 'segment-history-2',
  }).record;
  h.facts.node = row;
  const before = JSON.stringify(row);
  const value = (await h.read(h.request, { ...h.query, runId: prior.attempt.id })).value;
  assert.equal(value.currentRunId, prior.attempt.id);
  assert.equal(value.currentRun.segmentId, prior.segmentId);
  assert.equal(value.currentRun.status, prior.attempt.status);
  assert.equal(value.start.kind, 'unavailable');
  assert.equal(JSON.stringify(h.facts.node), before);
  assert.equal((await h.read(h.request, h.query)).value.currentRunId, 'run-history-2');
  await assert.rejects(h.read(h.request, { ...h.query, runId: 'foreign' }), {
    code: 'run-scope-mismatch',
  });
});

test('options contract: passive catalog has no first/default selection or Run, exact plan experts only', async (t) => {
  const h = setup();
  t.after(() => h.ctx.fiber.dispose());
  const before = JSON.stringify(h.facts);
  const { value } = await h.read(h.request, h.query);
  assert.equal(value.currentRunId, null);
  assert.equal(value.runVersion, 0);
  assert.equal(value.selection, null);
  assert.equal(value.start.kind, 'available');
  assert.equal(value.models.items[0].value.model, 'actual-model');
  assert.deepEqual(
    value.experts.map((expert) => expert.value.kind),
    ['builtin', 'plan-expert'],
  );
  assert.equal(value.experts[1].value.ref.version, h.query.planId);
  assert.deepEqual(h.counts(), { reads: 2, catalogs: 1 });
  assert.equal(JSON.stringify(h.facts), before);
  assert.equal(JSON.stringify(value).includes('instructions'), false);
  assert.equal(JSON.stringify(value).includes('actorId'), false);
});

test('options contract: expert assignment never offers the human builtin or a different plan expert', async (t) => {
  const h = setup({ expert: true });
  t.after(() => h.ctx.fiber.dispose());
  const { value } = await h.read(h.request, h.query);
  assert.equal(value.experts.length, 1);
  assert.deepEqual(value.experts[0].value, {
    kind: 'plan-expert',
    ref: { id: 'qa', version: h.query.planId },
  });
});

test('options contract: only an explicit returned current round offers begin after a settled completed Run', async (t) => {
  const h = setup();
  t.after(() => h.ctx.fiber.dispose());
  const completed = applyEvent(accepted(begin(h.facts.node).record), 'completed', stable).record;
  const returned = {
    ...completed,
    command: { ...completed.command, status: 'needs-revision', entryStatus: 'needs-revision' },
    currentRoundId: 'returned-round',
    rounds: [
      {
        id: 'returned-round',
        artifactVersionId: 'returned-artifact',
        status: 'changes-requested',
        reviewerIds: ['chen'],
        ballots: [],
      },
    ],
    artifactVersions: [{ id: 'returned-artifact', producerRunId: 'run-1' }],
  };
  h.facts.node = returned;
  const before = JSON.stringify(returned);
  assert.deepEqual((await h.read(h.request, h.query)).value.start, {
    kind: 'available',
    mode: 'begin',
  });
  assert.equal(JSON.stringify(h.facts.node), before, 'metadata never creates a Run');
  for (const mutate of [
    (node) => {
      node.command.status = 'ready';
    },
    (node) => {
      node.command.status = 'completed';
    },
    (node) => {
      node.acceptedArtifactVersionId = 'returned-artifact';
    },
    (node) => {
      node.nativeExecution.runs[0].resources = 'held';
    },
    (node) => {
      node.rounds[0].artifactVersionId = 'other-artifact';
    },
    (node) => {
      node.artifactVersions[0].producerRunId = 'other-run';
    },
  ]) {
    h.facts.node = structuredClone(returned);
    mutate(h.facts.node);
    assert.equal((await h.read(h.request, h.query)).value.start.kind, 'unavailable');
  }
});

test('options contract: actor fields and denied controller fail before model metadata', async (t) => {
  const h = setup();
  t.after(() => h.ctx.fiber.dispose());
  await assert.rejects(h.read(h.request, { ...h.query, actorId: 'chen' }), {
    code: 'run-validation',
  });
  h.deny();
  await assert.rejects(h.read(h.request, h.query), { code: 'run-authority-denied' });
  assert.equal(h.counts().catalogs, 0);
});

test('options contract: a newly authorized controller never receives the old actor Run snapshot', async (t) => {
  const h = setup();
  t.after(() => h.ctx.fiber.dispose());
  h.facts.node = begin(h.facts.node).record;
  h.facts.inputs.actorId = 'replacement-controller';
  await assert.rejects(h.read(h.request, h.query), { code: 'run-scope-mismatch' });
});

test('options contract: directory/controller revocation during catalog await suppresses the entire response', async (t) => {
  const pending = Promise.withResolvers();
  const h = setup({ list: () => pending.promise });
  t.after(() => h.ctx.fiber.dispose());
  const read = h.read(h.request, h.query);
  await new Promise((resolve) => setImmediate(resolve));
  h.deny();
  pending.resolve([{ provider: 'contract', id: 'late', name: 'Late' }]);
  await assert.rejects(read, { code: 'run-authority-denied' });
  assert.equal(h.counts().reads, 2);
});

test('options contract: unabortable SDK catalog has a bounded wait; late completion cannot publish', async (t) => {
  let completed = false;
  const h = setup({
    timeout: 10,
    list: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          completed = true;
          resolve([{ provider: 'contract', id: 'late', name: 'Late' }]);
        }, 50),
      ),
  });
  t.after(() => h.ctx.fiber.dispose());
  const { value } = await h.read(h.request, h.query);
  assert.equal(completed, false);
  assert.equal(value.models.kind, 'unavailable');
  assert.equal(value.selection, null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(completed, true);
  assert.equal(value.models.kind, 'unavailable');
});

test('options contract: cancellation during metadata cannot reauthorize or disclose a late response', async (t) => {
  const pending = Promise.withResolvers();
  const h = setup({ list: () => pending.promise });
  t.after(() => h.ctx.fiber.dispose());
  const waiting = new AbortController();
  const read = h.read(h.request, h.query, waiting.signal);
  await new Promise((resolve) => setImmediate(resolve));
  waiting.abort();
  pending.reject(Error('Late private provider failure'));
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(h.counts().reads, 1);
});
