import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createHostRunConfiguration } from '../dist/host-run-configuration.js';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';
import { describeNativeAcceptedFileTool } from '../dist/native-work-session-files-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

// Content-producer contracts. Identity, input directory and provider registration
// are explicit stand-ins; these fixtures do not prove actual Host authorization.
function setup({ upstream = false, acceptedFilesReady } = {}) {
  const ctx = new Context();
  const facts = compositionFacts({ upstream });
  if (upstream) facts.tools.definition = describeAcceptedInputTool();
  const lifetime = new AbortController();
  const request = { headers: {} };
  const providers = [{ id: 'contract' }];
  const reads = [];
  const execution = {
    async readRunCompositionInputs(original, locator) {
      assert.equal(original, request);
      reads.push(locator);
      return { ok: true, value: facts.inputs };
    },
    readRunNode: () => facts.node,
  };
  ctx.provide('llm', { listProviders: () => providers });
  const configuration = createHostRunConfiguration(ctx, {
    execution,
    readWorkbench: () => facts.workbench,
    signal: lifetime.signal,
    ...(acceptedFilesReady ? { acceptedFilesReady } : {}),
  });
  const input = {
    taskId: facts.scope.taskId,
    planId: facts.scope.planId,
    revision: facts.scope.revision,
    nodeId: facts.scope.nodeId,
    requestId: 'first',
    spaceId: facts.scope.spaceId,
    expectedNodeVersion: facts.node.command.version,
    expectedRunVersion: 0,
    mode: 'begin',
    newRunId: facts.scope.runId,
    newSegmentId: facts.scope.segmentId,
    model: facts.model,
    executor: facts.executor,
    tools: facts.tools.kind,
    workspace: { kind: 'text-only' },
  };
  return { ctx, facts, lifetime, request, providers, reads, execution, configuration, input };
}

test('Host configuration contract: assemble only from the normal same-owner projection and the actual input tool declaration', async () => {
  const h = setup({ upstream: true });
  try {
    const prepared = await h.configuration.prepare(h.request, h.input);
    assert.deepEqual(h.reads, [
      {
        taskId: h.input.taskId,
        planId: h.input.planId,
        revision: h.input.revision,
        nodeId: h.input.nodeId,
        spaceId: h.input.spaceId,
      },
    ]);
    assert.deepEqual(prepared.composition.payload.tools.definition, describeAcceptedInputTool());
    assert.equal(prepared.selection.configurationId, prepared.composition.configurationId);
    assert.equal(
      prepared.inputFingerprint,
      prepared.composition.payload.firstMessage.inputFingerprint,
    );
    assert.equal('actorId' in prepared, false);
    assert.equal('model' in prepared, false);
    assert.equal(JSON.stringify(prepared).includes('PRIVATE_SOURCE_BODY_NOT_IN_PROMPT'), false);
    assert.equal(
      h.configuration.assertConfiguration('chen', 'north', h.facts.node, prepared),
      undefined,
    );
  } finally {
    await h.ctx.fiber.dispose();
  }
});

test('Host configuration contract: only ready new fixed inputs receive the exact @2 file slot; saved legacy content is never upgraded', async () => {
  let ready = true;
  const h = setup({ upstream: true, acceptedFilesReady: () => ready });
  try {
    const savedLegacy = freezeExecutionRunComposition(h.facts);
    const original = JSON.stringify(savedLegacy);
    assert.equal(h.configuration.assertModel(savedLegacy), undefined);
    assert.equal(JSON.stringify(savedLegacy), original);
    assert.equal(savedLegacy.payload.acceptedFileReader, undefined);
    const prepared = await h.configuration.prepare(h.request, h.input);
    assert.equal(prepared.composition.schemaVersion, 2);
    assert.deepEqual(
      prepared.composition.payload.acceptedFileReader,
      describeNativeAcceptedFileTool(),
    );
    assert(prepared.composition.payload.toolAllowlist.includes('read_accepted_file'));
    ready = false;
    assert.throws(() => h.configuration.assertModel(prepared.composition), {
      code: 'run-authority-unavailable',
    });
    const withoutReader = await h.configuration.prepare(h.request, h.input);
    assert.equal(withoutReader.composition.payload.acceptedFileReader, undefined);
    assert(!withoutReader.composition.payload.toolAllowlist.includes('read_accepted_file'));
  } finally {
    await h.ctx.fiber.dispose();
  }
  const noInputs = setup({ acceptedFilesReady: () => true });
  try {
    const prepared = await noInputs.configuration.prepare(noInputs.request, noInputs.input);
    assert.equal(prepared.composition.payload.acceptedFileReader, undefined);
  } finally {
    await noInputs.ctx.fiber.dispose();
  }
});

test('Host configuration contract: forbidden caller facts and local paths fail before reading the projection', async () => {
  const h = setup();
  try {
    for (const patch of [
      { actorId: 'chen' },
      { composition: {} },
      { workspace: { kind: 'local', cwd: '/untrusted' } },
    ])
      await assert.rejects(h.configuration.prepare(h.request, { ...h.input, ...patch }), {
        code: 'run-validation',
      });
    assert.equal(h.reads.length, 0);
  } finally {
    await h.ctx.fiber.dispose();
  }
});

test('Host configuration contract: missing, hidden and wrong-scope input projections never become an empty permitted catalog', async () => {
  const h = setup({ upstream: true });
  try {
    for (const value of [
      { ...h.facts.inputs, items: undefined },
      { ...h.facts.inputs, spaceId: 'foreign' },
      {
        ...h.facts.inputs,
        items: [{ access: 'hidden', blocking: true, count: 1, message: 'hidden' }],
      },
    ]) {
      h.execution.readRunCompositionInputs = async () => ({ ok: true, value });
      await assert.rejects(h.configuration.prepare(h.request, h.input));
    }
  } finally {
    await h.ctx.fiber.dispose();
  }
});

test('Host configuration contract: model route withdrawal and owner lifetime changes reject even a previously valid snapshot', async () => {
  const h = setup();
  try {
    const snapshot = freezeExecutionRunComposition(h.facts);
    assert.equal(h.configuration.assertModel(snapshot), undefined);
    h.providers.length = 0;
    assert.throws(() => h.configuration.assertModel(snapshot), {
      code: 'run-authority-unavailable',
    });
    h.providers.push({ id: 'contract' });
    h.lifetime.abort();
    assert.throws(() => h.configuration.assertModel(snapshot), {
      code: 'run-authority-unavailable',
    });
  } finally {
    await h.ctx.fiber.dispose();
  }
});

test('real Cordis service identity: fresh LLM tracing proxies keep the same producer; removal still refuses', async () => {
  const ctx = new Context();
  const producer = ctx.plugin(LlmRuntime);
  try {
    await producer;
    ctx.llm.registerAdapter(['contract'], new (class extends LlmAdapter {})());
    assert.notEqual(
      ctx.llm,
      ctx.llm,
      'The actual SDK service does not have stable wrapper identity',
    );
    const facts = compositionFacts();
    const configuration = createHostRunConfiguration(ctx, {
      execution: {},
      readWorkbench: () => facts.workbench,
      signal: new AbortController().signal,
    });
    const snapshot = freezeExecutionRunComposition(facts);
    assert.equal(configuration.assertModel(snapshot), undefined);
    await producer.dispose();
    assert.throws(() => configuration.assertModel(snapshot), { code: 'run-authority-unavailable' });
  } finally {
    await ctx.fiber.dispose();
  }
});
