/** Real product service + Cordis/DSH JSON; Host permission/configuration producers are contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeRecordKey } from '@zhuma/agent-core';
import { open, checked, refused, stable } from './execution-service-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { reader } from './execution-run-composition-fixture.mjs';
import { beginExecutionRun } from '../dist/execution-run-state.js';
import { command, available } from './execution-run-fixture.mjs';

async function host(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-composition-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await open(root, options);
  t.after(() => result.close());
  result.resetCounts();
  return { ...result, root };
}

test('real JSON composition: first explicit start validates before marker and atomically saves the complete snapshot', async (t) => {
  const h = await host(t);
  const input = h.begin();
  checked(await h.service.startRun(h.request, input));
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  const saved = h.service.readRunComposition(h.runLocator());
  assert.deepEqual(saved, input.composition);
  assert.equal(
    h.read().nativeExecution.runs[0].composition.configurationId,
    input.selection.configurationId,
  );
  assert.equal(saved.payload.firstMessage.inputFingerprint, input.inputFingerprint);
  checked(await h.service.startRun(h.request, input));
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  assert(Object.isFrozen(saved.payload));
});

test('real JSON composition: a missing or invalid snapshot cannot enable the first marker', async (t) => {
  const h = await host(t);
  const input = h.begin();
  const { composition: _composition, ...missing } = input;
  refused(await h.service.startRun(h.request, missing), 'validation');
  const tampered = structuredClone(input);
  tampered.composition.payload.model.model = 'tampered';
  refused(await h.service.startRun(h.request, tampered), 'validation');
  refused(
    await h.service.startRun(h.request, { ...input, inputFingerprint: '0'.repeat(64) }),
    'composition-mismatch',
  );
  refused(
    await h.service.startRun(h.request, { ...input, expectedNodeVersion: 999 }),
    'run-conflict',
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(h.service.readRunGlobal(), { schemaVersion: 1 });
});

for (const phase of ['in-review', 'completed'])
  test(`real JSON composition: ${phase} entry cannot write the first compatibility barrier`, async (t) => {
    const h = await host(t);
    const caller = { member: { ok: true, memberId: 'chen', spaceIds: ['north'] } };
    const submitted = checked(
      await h.service.submit(caller, {
        ...h.human('produce', 'manual-before-run'),
        text: 'submitted by a person',
      }),
    );
    if (phase === 'completed') {
      const round = submitted.node.rounds.at(-1);
      checked(
        await h.service.ballot(
          { member: { ok: true, memberId: 'outside', spaceIds: ['north'] } },
          {
            ...h.human('produce', 'manual-review'),
            roundId: round.id,
            artifactVersionId: round.artifactVersionId,
            action: 'approve',
          },
        ),
      );
    }
    assert.equal(h.read().command.status, phase);
    h.resetCounts();
    const result = await h.service.startRun(h.request, h.begin());
    assert.equal(result.ok, false);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    assert.deepEqual(h.service.readRunGlobal(), { schemaVersion: 1 });
  });

for (const mode of ['retry', 'restart'])
  test(`real JSON composition: invalid initial ${mode} cannot write the first compatibility barrier`, async (t) => {
    const h = await host(t);
    refused(await h.service.startRun(h.request, h.begin({ mode })), 'run-recovery-unavailable');
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  });

for (const fact of ['configuration', 'workspace'])
  test(`real JSON composition: unavailable ${fact} refuses before marker write`, async (t) => {
    const h = await host(t);
    h.faults[fact] = true;
    refused(await h.service.startRun(h.request, h.begin()), 'run-authority-denied');
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  });

for (const change of ['member', 'publication', 'configuration', 'controller'])
  test(`real JSON composition: ${change} is freshly checked after marker durability`, async (t) => {
    const h = await host(t);
    const input = h.begin();
    h.faults.afterGlobalWrite = () => {
      if (change === 'member') h.member.abort();
      else if (change === 'publication') h.source.abort();
      else if (change === 'configuration') h.faults.configuration = true;
      else
        h.setWorkbench((workbench) => ({
          ...workbench,
          tasks: workbench.tasks.map((task) => ({
            ...task,
            ownerId: 'outside',
            participantIds: ['outside', 'qa'],
          })),
        }));
    };
    const result = await h.service.startRun(h.request, input);
    assert.equal(result.ok, false);
    assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
    assert.equal(h.read().nativeExecution, undefined);
  });

test('real JSON composition: failed atomic snapshot save returns no effect and same-key recovery commits once', async (t) => {
  const h = await host(t);
  const input = h.begin();
  h.faults.node = true;
  const failure = await h.service.startRun(h.request, input);
  refused(failure, 'unavailable');
  assert.equal('value' in failure, false);
  assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
  assert.equal(h.read().nativeExecution, undefined);
  h.faults.node = false;
  const result = checked(await h.service.startRun(h.request, input));
  assert.equal(result.effect.kind, 'dispatch');
  assert.deepEqual(h.service.readRunComposition(h.runLocator()), input.composition);
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
});

test('real JSON composition: a valid self-hashed foreign actor snapshot is data, not member authority', async (t) => {
  const h = await host(t);
  const input = h.begin();
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node: h.read(),
    scope: { ...input.composition.payload.scope, actorId: 'outside' },
    model: input.composition.payload.model,
    executor: { kind: 'builtin' },
    tools: { kind: 'text-only' },
    inputs: { ...h.locate(), actorId: 'outside', spaceId: 'north', items: [] },
  });
  const { firstMessage: _message, ...projected } = executionRunCompositionRequest(composition);
  refused(
    await h.service.startRun(h.request, { ...input, ...projected, composition }),
    'composition-mismatch',
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('real JSON composition: forged visible metadata cannot replace B missing dependency refs', async (t) => {
  const h = await host(t);
  const node = h.read('consume');
  node.handoff.inputRefs = [{ sourceNodeId: 'produce', artifactVersionId: 'not-accepted' }];
  const scope = {
    ...h.locate('consume'),
    actorId: 'chen',
    spaceId: 'north',
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
  };
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node,
    scope,
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    executor: { kind: 'builtin' },
    tools: reader,
    inputs: {
      ...h.locate('consume'),
      actorId: 'chen',
      spaceId: 'north',
      items: [
        {
          access: 'visible',
          blocking: false,
          sourceNodeId: 'produce',
          artifactVersionId: 'not-accepted',
          version: 1,
          name: 'claimed metadata',
        },
      ],
    },
  });
  const { firstMessage: _message, ...projected } = executionRunCompositionRequest(composition);
  refused(
    await h.service.startRun(h.request, {
      ...h.locate('consume'),
      spaceId: 'north',
      requestId: 'start',
      expectedNodeVersion: node.command.version,
      expectedRunVersion: 0,
      mode: 'begin',
      newRunId: scope.runId,
      newSegmentId: scope.segmentId,
      workspace: { kind: 'text-only' },
      ...projected,
      composition,
    }),
    'composition-input-unavailable',
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('real JSON composition: a valid different configuration with the same command key never overwrites the stored version', async (t) => {
  const h = await host(t);
  checked(await h.service.startRun(h.request, h.begin()));
  const saved = h.read();
  const changed = h.begin({
    selection: {
      provider: 'contract',
      model: 'contract-model',
      maxTokens: 1200,
      configurationId: 'ignored-by-builder',
    },
  });
  refused(await h.service.startRun(h.request, changed), 'run-idempotency-mismatch');
  assert.deepEqual(h.read(), saved);
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
});

test('real JSON composition: old human draft, submit, review and downstream writers preserve the frozen snapshot', async (t) => {
  const h = await host(t);
  checked(await h.service.startRun(h.request, h.begin()));
  const saved = h.service.readRunComposition(h.runLocator());
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  checked(
    await h.native(
      'accepted',
      { grant: opened.grant },
      { nativeSessionId: 'native', executorRunId: 'executor' },
    ),
  );
  checked(await h.native('completed', { grant: opened.grant }, stable));
  const caller = { member: { ok: true, memberId: 'chen', spaceIds: ['north'] } };
  checked(
    await h.service.draft(caller, {
      ...h.locate(),
      expectedVersion: 0,
      idempotencyKey: 'new-draft',
      text: 'draft',
    }),
  );
  const submitted = checked(
    await h.service.submit(caller, { ...h.human('produce', 'submit'), text: 'product' }),
  );
  const round = submitted.node.rounds.at(-1);
  checked(
    await h.service.ballot(
      { member: { ok: true, memberId: 'outside', spaceIds: ['north'] } },
      {
        ...h.human('produce', 'approve'),
        roundId: round.id,
        artifactVersionId: round.artifactVersionId,
        action: 'approve',
      },
    ),
  );
  assert.deepEqual(h.service.readRunComposition(h.runLocator()), saved);
  assert.equal(h.read('consume').command.status, 'ready');
  const corrupted = h.read();
  const original = structuredClone(corrupted);
  const savedLocator = h.runLocator();
  corrupted.nativeExecution.runs[0].composition.payload.model.model = 'silent-latest';
  // DSH put acknowledges bytes; schema validation happens on open. Simulate a
  // raw-medium corruption and prove the service's read-back independently refuses.
  await h.domain.table('nodes').put(nodeRecordKey(corrupted), corrupted);
  assert.throws(() => h.service.readRunComposition(savedLocator), { code: 'run-state-invalid' });
  await h.domain.table('nodes').put(nodeRecordKey(original), original);
  assert.deepEqual(h.service.readRunComposition(h.runLocator()), saved);
});

test('real JSON composition: old unconfigured Runs stay read-only legacy metadata, never regenerated from latest', async (t) => {
  const h = await host(t);
  checked(await h.service.enableRunWriter());
  const old = h.read();
  const legacy = beginExecutionRun(old, command(old), [old], available).record;
  await h.domain.table('nodes').put(nodeRecordKey(legacy), legacy);
  await h.close();
  const reopened = await open(h.root, { seed: false, mount: false });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read(), legacy);
  assert.throws(() => reopened.service.readRunComposition(reopened.runLocator()), {
    code: 'composition-invalid',
  });
  assert.deepEqual(reopened.counters, { global: 0, nodes: 0, plans: 0 });
});
