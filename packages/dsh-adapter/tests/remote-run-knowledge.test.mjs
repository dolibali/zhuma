/** Real original Service/JSON/domain barriers. Member leases and the caller's local
 * capability are contracts here, not proof of C's SDK or A's private HTTP/normal UI. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { join } from 'node:path';
import { canonicalPayload } from '@zhuma/agent-core';
import { fileHost, hash, ok, no } from './remote-run-files-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import {
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  executionRunCompositionRequest,
  assertExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import { describeMemberKnowledgeTool } from '../dist/member-knowledge-tool.js';
import { currentExecutionRun, readExecutionRunState } from '../dist/execution-run-state.js';
import {
  executionRunGlobalSchema,
  assertExecutionRunStoreCompatibility,
  prepareExecutionRunWriter,
  prepareExecutionReviewWriter,
} from '../dist/execution-run-protocol.js';

const version = 'zhuma-native-knowledge@1';
const capability = {
  resultIntent: 'zhuma-native-result-intent@1',
  localTools: [],
  knowledge: version,
};
const text = { workspace: { kind: 'text-only' }, capabilities: capability };
const bytes = (h) => canonicalPayload({ global: h.domain.global.get(), node: h.read() });

test('knowledge composition: freezes only the exact registered descriptor and keeps absent legacy bytes unchanged', () => {
  const facts = compositionFacts();
  const old = freezeExecutionRunComposition(facts),
    oldBytes = JSON.stringify(old);
  const descriptor = describeMemberKnowledgeTool();
  assert.equal(
    hash(descriptor),
    '005acfb58f64dba6f5aa422578ddb811cbbd32d3d7b7d475c63def1b7494cd51',
  );
  const input = { ...facts, knowledgeTool: descriptor };
  const frozen = freezeExecutionRunComposition(input);
  assert.equal(frozen.schemaVersion, 2);
  assert.deepEqual(frozen.payload.knowledgeTool, descriptor);
  assert.deepEqual(frozen.payload.toolAllowlist, ['knowledge']);
  assert(Object.isFrozen(frozen.payload.knowledgeTool.parameters));
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(frozen))), frozen);
  assert.notEqual(frozen.configurationId, old.configurationId);
  assert.equal(
    assertExecutionRunComposition(frozen, input, executionRunCompositionRequest(frozen)),
    undefined,
  );
  assert.throws(
    () => assertExecutionRunComposition(frozen, facts, executionRunCompositionRequest(frozen)),
    { code: 'composition-mismatch' },
  );
  assert.equal(JSON.stringify(readExecutionRunComposition(old)), oldBytes);
  assert.equal(JSON.stringify(freezeExecutionRunComposition(facts)), oldBytes);
  for (const privateField of ['allowDrafts', 'libraryId', 'cookie', 'invoke', 'assertCurrent'])
    assert.equal(Object.hasOwn(frozen.payload.knowledgeTool, privateField), false);
});

test('knowledge composition: changed or extra fields cannot be rehashed into a valid snapshot', () => {
  for (const change of [
    (tool) => (tool.name = 'knowledge-other'),
    (tool) => (tool.sourceVersion = 'zhuma-native-knowledge@2'),
    (tool) => (tool.description += ' changed'),
    (tool) => (tool.parameters.properties.extra = { type: 'string' }),
    (tool) => (tool.outputSchema = { type: 'object' }),
    (tool) => (tool.allowDrafts = true),
  ]) {
    const tool = structuredClone(describeMemberKnowledgeTool());
    change(tool);
    assert.throws(
      () => freezeExecutionRunComposition({ ...compositionFacts(), knowledgeTool: tool }),
      {
        code: 'composition-invalid',
      },
    );
  }
  for (const knowledgeTool of [null, false, {}, []])
    assert.throws(() => freezeExecutionRunComposition({ ...compositionFacts(), knowledgeTool }), {
      code: 'composition-invalid',
    });
  const frozen = freezeExecutionRunComposition({
    ...compositionFacts(),
    knowledgeTool: describeMemberKnowledgeTool(),
  });
  for (const change of [
    (payload) => delete payload.knowledgeTool,
    (payload) => payload.toolAllowlist.push('knowledge'),
    (payload) => (payload.knowledgeTool.description += ' changed'),
    (payload) => (payload.allowDrafts = true),
  ]) {
    const altered = structuredClone(frozen);
    change(altered.payload);
    altered.configurationId = `composition_${hash(altered.payload)}`;
    assert.throws(() => readExecutionRunComposition(altered), { code: 'composition-invalid' });
  }
});

test('remote knowledge: exact signed capability uses the original Run and does not create knowledge IO or a second authority', async (t) => {
  const h = await fileHost(t, { enabled: false });
  h.resetCounts();
  const body = h.accept(text),
    accepted = ok(await h.send(body));
  const run = currentExecutionRun(h.read());
  assert.equal(run.remote.knowledge, version);
  assert.deepEqual(run.composition.payload.knowledgeTool, describeMemberKnowledgeTool());
  assert.deepEqual(run.composition.payload.toolAllowlist, ['complete_work', 'knowledge']);
  assert.equal(h.domain.global.get().remoteExecutionKnowledgeWriter, 1);
  assert.equal(h.domain.global.get().remoteExecutionFileWriter, undefined);
  assert.equal(h.domain.global.get().remoteExecutionAcceptedFileWriter, undefined);
  assert.equal(h.read().nativeExecution.runs.length, 1);
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  assert.deepEqual(h.counts, { saved: 0, read: 0 });
  const before = bytes(h);
  const replay = ok(await h.send(body));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(replay.shared.composition, accepted.shared.composition);
  assert.equal(bytes(h), before);
  const changed = structuredClone(body);
  delete changed.payload.capabilities.knowledge;
  no(await h.send(changed), 'remote-idempotency-mismatch');
  assert.equal(bytes(h), before);
  assert.equal(h.read().artifactVersions.length, 0);
  assert.equal(h.read().rounds.length, 0);
});

test('remote knowledge: absent capability never upgrades an old Run, on reads, setup, replay or renewal', async (t) => {
  const h = await fileHost(t, { enabled: false });
  const plain = {
    ...text,
    capabilities: { resultIntent: capability.resultIntent, localTools: [] },
  };
  const body = h.accept(plain),
    accepted = ok(await h.send(body));
  const oldComposition = JSON.stringify(currentExecutionRun(h.read()).composition);
  h.resetCounts();
  await h.service.enableRemoteRuns();
  ok(await h.send(h.envelope('info', {})));
  ok(await h.send(body));
  const status = () => h.envelope('status', { scope: accepted.scope, permit: h.drive.public });
  ok(await h.send(status()));
  ok(await h.send(h.envelope('renew', { scope: accepted.scope, permit: h.drive.public })));
  const run = currentExecutionRun(h.read());
  assert.equal(h.domain.global.get().remoteExecutionKnowledgeWriter, undefined);
  assert.equal(Object.hasOwn(run.remote, 'knowledge'), false);
  assert.equal(Object.hasOwn(run.composition.payload, 'knowledgeTool'), false);
  assert.equal(JSON.stringify(run.composition), oldComposition);
  assert.equal(h.counters.global, 0);
});

test('remote knowledge: bad signature, wrong version, stale node and missing composed descriptor leave the barrier untouched', async (t) => {
  const h = await fileHost(t, { enabled: false });
  h.resetCounts();
  const invalid = h.signBody(h.accept(text));
  invalid.proof.signature = 'A'.repeat(86);
  no(await h.service.remoteRun(h.request, invalid, h.drive.raw), 'remote-proof-invalid');
  no(
    await h.send(h.accept({ ...text, capabilities: { ...capability, knowledge: 'unknown' } })),
    'remote-validation',
  );
  no(await h.send(h.accept({ ...text, expectedNodeVersion: 10000 })), 'remote-conflict');
  const source = h.service.remoteRunAuthorities.source,
    compose = source.compose;
  source.compose = (...args) => {
    const [actor, request, ...rest] = args;
    const absent = structuredClone(request);
    delete absent.payload.capabilities.knowledge;
    return compose(actor, absent, ...rest);
  };
  no(await h.send(h.accept(text)));
  source.compose = compose;
  assert.equal(h.domain.global.get().remoteExecutionKnowledgeWriter, undefined);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(currentExecutionRun(h.read()), undefined);
});

test('remote knowledge: first qualified admission requires observed durable barrier before any node put', async (t) => {
  const h = await fileHost(t, { enabled: false });
  const source = h.service.remoteRunAuthorities.source,
    writeGlobal = source.writeGlobal,
    writeNode = source.writeNode;
  let marked = false,
    puts = 0;
  source.writeNode = async (...args) => {
    puts++;
    assert.equal(marked, true);
    assert.equal(h.domain.global.get().remoteExecutionKnowledgeWriter, 1);
    return writeNode(...args);
  };
  h.resetCounts();
  h.faults.global = true;
  no(await h.send(h.accept(text)));
  assert.equal(puts, 0);
  assert.equal(h.domain.global.get().remoteExecutionKnowledgeWriter, undefined);
  h.faults.global = false;
  source.writeGlobal = async () => undefined;
  no(await h.send(h.accept(text)));
  assert.equal(puts, 0, 'a successful callback without observed persistence is not a barrier');
  source.writeGlobal = async (global) => {
    await writeGlobal(global);
    marked = h.domain.global.get().remoteExecutionKnowledgeWriter === 1;
  };
  const body = h.accept(text);
  h.faults.node = true;
  no(await h.send(body));
  assert.equal(puts, 1);
  assert.equal(currentExecutionRun(h.read()), undefined);
  assert.equal(h.service.remoteRunAuthorities.active.size, 0);
  assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
  h.faults.node = false;
  const result = ok(await h.send(body));
  assert.equal(result.authority, 'drive');
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  assert.deepEqual(prepareExecutionRunWriter(h.domain.global.get()), h.domain.global.get());
  assert.equal(
    prepareExecutionReviewWriter(h.domain.global.get()).remoteExecutionKnowledgeWriter,
    1,
  );
});

test('remote knowledge: original storage guard requires exact remote metadata and marker, even for proposed local writes', async (t) => {
  const h = await fileHost(t, { enabled: false });
  ok(await h.send(h.accept(text)));
  const node = h.read(),
    global = h.domain.global.get();
  assert.equal(assertExecutionRunStoreCompatibility(global, [node]), undefined);
  for (const marker of [undefined, 2]) {
    const altered = { ...global, remoteExecutionKnowledgeWriter: marker };
    assert.throws(() => assertExecutionRunStoreCompatibility(altered, [node]), {
      code: 'run-writer-incompatible',
    });
  }
  assert.equal(
    executionRunGlobalSchema.safeParse({ schemaVersion: 1, remoteExecutionKnowledgeWriter: 1 })
      .success,
    false,
  );
  for (const change of [
    (run) => delete run.remote.knowledge,
    (run) => (run.remote.knowledge = 'unknown'),
    (run) => delete run.remote,
  ]) {
    const altered = structuredClone(node);
    change(altered.nativeExecution.runs[0]);
    assert.throws(() => assertExecutionRunStoreCompatibility(global, [altered]), {
      code: 'run-writer-incompatible',
    });
  }
  const metadataOnly = structuredClone(node);
  delete metadataOnly.nativeExecution.runs[0].composition;
  assert.throws(() => readExecutionRunState(metadataOnly), { code: 'run-state-invalid' });
  assert.throws(() => assertExecutionRunStoreCompatibility(global, [metadataOnly]), {
    code: 'run-writer-incompatible',
  });
  const before = bytes(h);
  await assert.rejects(h.service.writeNode(metadataOnly, true));
  assert.equal(bytes(h), before);
});

test('remote knowledge: actual previous strict Domain rejects reopening, current cold reopens without restoring drive or knowledge IO', async (t) => {
  const h = await fileHost(t, { enabled: false });
  const accepted = ok(await h.send(h.accept(text)));
  const composition = JSON.stringify(currentExecutionRun(h.read()).composition);
  await h.close();
  const before = await businessHashes(h.root);
  const ctx = new Context(),
    fibers = [];
  try {
    for (const [plugin, options] of [
      [Storage],
      [JsonStorage, { root: join(h.root, 'service') }],
      [Domain, { backend: 'json' }],
    ]) {
      const fiber = ctx.plugin(plugin, options);
      fibers.push(fiber);
      await fiber;
    }
    const oldGlobal = z.strictObject(
      Object.fromEntries(
        Object.entries(executionRunGlobalSchema.shape).filter(
          ([key]) => key !== 'remoteExecutionKnowledgeWriter',
        ),
      ),
    );
    await assert.rejects(
      ctx.storageDomain.open({
        name: 'zhuma_execution',
        version: 1,
        global: { schema: oldGlobal, initial: { schemaVersion: 1 } },
        tables: {
          nodes: { valueSchema: z.unknown() },
          plans: { valueSchema: z.unknown() },
          workspace_approvals: { valueSchema: z.unknown() },
        },
      }),
    );
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
  assert.deepEqual(await businessHashes(h.root), before);
  const reopened = await fileHost(t, {
    root: h.root,
    seed: false,
    enabled: false,
    identity: h.identity,
  });
  reopened.resetCounts();
  const view = await reopened.recover(accepted.scope);
  assert.equal(view.authority, 'recovery-required');
  assert.equal(JSON.stringify(currentExecutionRun(reopened.read()).composition), composition);
  assert.equal(reopened.domain.global.get().remoteExecutionKnowledgeWriter, 1);
  assert.deepEqual(reopened.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(reopened.counts, { saved: 0, read: 0 });
  await reopened.close();
  assert.deepEqual(await businessHashes(h.root), before);
});
