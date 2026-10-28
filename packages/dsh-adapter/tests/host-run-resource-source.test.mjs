import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, startAppliedPlan } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { WorkbenchService } from '../dist/workbench-service.js';
import { createHostRunSkillPolicies } from '../dist/host-run-skill-policy.js';
import { createHostRunResourceSource } from '../dist/host-run-resource-source.js';
import { describeNativeAcceptedFileTool } from '../dist/native-work-session-files-tool.js';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';
import {
  executionRunCompositionRequest,
  freezeExecutionRunComposition,
} from '../dist/execution-run-composition.js';

// Real package import/core mapping/policy reader. Authorization is a contract
// double; these tests do not certify the D queue or an actual native Run.
async function setup({ empty = false, mcp = false, imported = false } = {}) {
  const f = fixture(),
    packages = new Map();
  const h = { state: f.state, authCalls: 0, packageReads: 0, packages, inputs: [] };
  const service = new WorkbenchService(
    {
      read: () => h.state,
      write: async (value) => {
        h.state = value;
      },
    },
    { get: () => undefined, put: async () => {} },
    {
      get: (id) => packages.get(id),
      put: async (value) => {
        packages.set(value.versionId, value);
      },
    },
  );
  if (mcp)
    h.state = applyWorkbenchCommand(h.state, {
      type: 'save-asset',
      asset: {
        id: 'docs-mcp',
        name: 'Documentation reference',
        kind: 'mcp',
        description: 'An unqualified definition, not a live connection',
        content: 'Read the selected documentation.',
        available: true,
      },
    });
  if (imported)
    await service.command(
      {
        requestId: 'import',
        expectedRevision: 0,
        command: {
          type: 'import-package',
          input: {
            versionId: '34ca834b-18f3-458e-8a37-5bb52e0ae57b',
            files: [
              {
                path: 'demo/SKILL.md',
                data: Buffer.from(
                  '---\nname: demo\ndescription: Demo\ndisable-model-invocation: true\n---\nDo the selected work.',
                ).toString('base64'),
              },
            ],
            choices: [
              {
                key: 'demo/SKILL.md',
                id: 'api-skill',
                replace: true,
                name: '接口规范',
                description: '设计 API',
                role: '',
                capabilities: [],
                available: true,
              },
            ],
          },
        },
      },
      new AbortController().signal,
    );
  const task = h.state.tasks[0];
  h.state = applyWorkbenchCommand(h.state, {
    type: 'save-task',
    task: {
      ...task,
      status: 'ready',
      workflows: task.workflows.map((workflow) => ({
        ...workflow,
        nodes: workflow.nodes.map((node) => ({
          ...node,
          skillIds: empty || mcp ? [] : node.skillIds,
          mcpIds: mcp ? ['docs-mcp'] : [],
        })),
      })),
    },
  });
  h.applied = h.state.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: task.id, planId: h.applied.id, revision: h.applied.revision },
    applied: h.applied,
    actorId: 'chen',
    existing: [],
  });
  assert.equal(started.ok, true);
  h.node = started.records[0];
  h.locator = {
    taskId: task.id,
    planId: h.applied.id,
    revision: h.applied.revision,
    nodeId: h.node.nodeId,
    spaceId: 'north',
  };
  h.request = { headers: {} };
  h.lifetime = new AbortController();
  h.authorize = async () => ({
    ok: true,
    value: { ...h.locator, actorId: 'chen', items: h.inputs },
  });
  h.execution = {
    readRunNode: () => h.node,
    readRunComposition: () => h.persisted,
    async readRunCompositionInputs(request, locator) {
      assert.equal(request, h.request);
      assert.deepEqual(
        locator,
        h.locator,
        'the original D strict read accepts only locator fields',
      );
      h.authCalls++;
      return h.authorize(h.authCalls);
    },
  };
  h.policies = createHostRunSkillPolicies({
    execution: h.execution,
    readWorkbench: () => h.state,
    readPackage: (id) => {
      h.packageReads++;
      return packages.get(id);
    },
    signal: h.lifetime.signal,
  });
  h.options = {
    execution: h.execution,
    policies: h.policies,
    readWorkbench: () => h.state,
    signal: h.lifetime.signal,
  };
  h.source = createHostRunResourceSource(h.options);
  h.command = (catalog, { fileReader = false } = {}) => {
    const scope = {
      actorId: 'chen',
      ...h.locator,
      runId: 'run',
      generation: 1,
      segmentId: 'segment',
    };
    const composition = freezeExecutionRunComposition({
      workbench: h.state,
      node: h.node,
      scope,
      model: { provider: 'contract', model: 'model', maxTokens: 1000 },
      executor: { kind: 'builtin' },
      tools: fileReader
        ? { kind: 'accepted-input-reader', definition: describeAcceptedInputTool() }
        : { kind: 'text-only' },
      inputs: { ...h.locator, actorId: 'chen', items: h.inputs },
      resourceCatalog: catalog,
      ...(fileReader ? { acceptedFileReader: describeNativeAcceptedFileTool() } : {}),
    });
    h.persisted = composition;
    const { firstMessage, ...projection } = executionRunCompositionRequest(composition);
    return {
      ...h.locator,
      requestId: 'begin',
      expectedNodeVersion: h.node.command.version,
      expectedRunVersion: 0,
      newRunId: 'run',
      newSegmentId: 'segment',
      mode: 'begin',
      workspace: { kind: 'text-only' },
      ...projection,
      composition,
    };
  };
  return h;
}
const denied = (promise) => assert.rejects(promise, { code: 'resources-unavailable' });

test('Host resource source contract: file-only saved schema2 keeps its empty Skill domain and exact configuration', async () => {
  const h = await setup({ empty: true });
  h.inputs = [
    {
      access: 'visible',
      blocking: false,
      sourceNodeId: 'accepted-source',
      artifactVersionId: 'accepted-v1',
      version: 1,
      name: 'Upstream brief',
    },
  ];
  h.node.handoff.inputRefs = [
    { sourceNodeId: 'accepted-source', artifactVersionId: 'accepted-v1' },
  ];
  const catalog = await h.source.catalog(h.request, h.locator);
  const command = h.command(catalog, { fileReader: true });
  assert.equal(command.composition.schemaVersion, 2);
  assert.equal(command.composition.payload.resources, undefined);
  const before = JSON.stringify(command.composition);
  const q = await h.source.prepareResourceCatalog(h.request, command);
  assert.equal(q.assertCurrent(), undefined);
  assert.deepEqual(q.catalog.skills, []);
  assert.equal(JSON.stringify(command.composition), before);
  q.release();
});

async function continuing() {
  const h = await setup({ imported: true });
  const catalog = await h.source.catalog(h.request, h.locator);
  h.input = h.command(catalog);
  h.binding = {
    schemaVersion: 1,
    scope: h.persisted.payload.scope,
    selection: executionRunCompositionRequest(h.persisted).selection,
    nativeSessionId: 'native-session',
    nativeAgentId: 'native-agent',
    receipts: [],
  };
  h.grantLifetime = new AbortController();
  h.grant = { scope: h.binding.scope, signal: h.grantLifetime.signal, assertCurrent() {} };
  // Explicit issuer contract double, never a real D grant or Host adoption proof.
  h.authorities = {
    assertGrant(candidate, action) {
      assert.equal(candidate, h.grant);
      assert.equal(action, 'send');
      assert.equal(h.revoked, undefined);
    },
  };
  h.producer = await h.source.producer(h.request, h.persisted, h.binding, h.grant, h.authorities);
  h.assertCurrent = () => h.producer.assertCurrent(h.persisted, h.binding, h.grant);
  return h;
}

test('Host continuing source contract: short metadata release never aborts the genuine-grant-bound source', async () => {
  const h = await continuing();
  const q = await h.source.prepareResourceCatalog(h.request, h.input);
  q.release();
  assert.equal(q.signal.aborted, true);
  assert.equal(h.producer.signal.aborted, false);
  assert.equal(h.assertCurrent(), undefined);
  h.node.command.version++;
  assert.equal(h.assertCurrent(), undefined);
  assert.throws(() => h.producer.assertCurrent(h.persisted, h.binding, { ...h.grant }), {
    code: 'resources-unavailable',
  });
});

test('Host continuing source contract: a copied grant is refused before reading any original package', async () => {
  const h = await continuing();
  h.packageReads = 0;
  await denied(h.source.producer(h.request, h.persisted, h.binding, { ...h.grant }, h.authorities));
  assert.equal(h.packageReads, 0);
});

test('Host continuing source contract: original source loss, saved composition replacement, revocation and parent/grant close reject continuing adoption', async () => {
  for (const change of [
    (h) => h.packages.clear(),
    (h) => {
      h.persisted = structuredClone(h.persisted);
      h.persisted.payload.firstMessage.text = 'replaced';
    },
    (h) => {
      h.revoked = true;
    },
    (h) => h.lifetime.abort(),
    (h) => h.grantLifetime.abort(),
  ]) {
    const h = await continuing();
    change(h);
    assert.throws(h.assertCurrent, { code: 'resources-unavailable' });
  }
});

test('Host resource source contract: empty selection still authorizes; short release never aborts the continuing source', async () => {
  const h = await setup({ empty: true });
  const catalog = await h.source.catalog(h.request, h.locator);
  assert.deepEqual(catalog.skills, []);
  assert.deepEqual(catalog.mcp, []);
  assert.ok(h.authCalls > 0);
  const command = h.command(catalog),
    q = await h.source.prepareResourceCatalog(h.request, command);
  assert.equal(q.assertCurrent(), undefined);
  assert.equal(q.release(), undefined);
  assert.equal(q.release(), undefined);
  assert.equal(q.signal.aborted, true);
  assert.equal(h.source.signal.aborted, false);
  assert.throws(q.assertCurrent, { name: 'AbortError' });
  assert.deepEqual((await h.source.catalog(h.request, h.locator)).skills, []);
});

test('Host resource source contract: selected imported policy comes from its original package and matches the exact frozen command', async () => {
  const h = await setup({ imported: true });
  const catalog = await h.source.catalog(h.request, h.locator);
  assert.equal(catalog.skills[0].invocation.modelInvocable, false);
  const command = h.command(catalog),
    q = await h.source.prepareResourceCatalog(h.request, command);
  assert.deepEqual(q.catalog, catalog);
  assert.equal(q.assertCurrent(), undefined);
  assert.ok(h.packageReads >= 2);
  assert.equal(Object.isFrozen(q.catalog.skills[0].policySource), true);
  command.newSegmentId = 'changed';
  assert.throws(q.assertCurrent, { code: 'resources-unavailable' });
  q.release();
});

test('Host resource source contract: denied empty, Skill and MCP-only requests never reach private package reads', async () => {
  for (const options of [{ empty: true }, { imported: true }, { mcp: true }]) {
    const h = await setup(options);
    h.authorize = async () => ({ ok: false, error: { code: 'not-found' } });
    await denied(h.source.catalog(h.request, h.locator));
    assert.equal(h.packageReads, 0);
  }
});

test('Host resource source contract: no qualified MCP metadata refuses after original-request authorization and never invents a connection', async () => {
  const h = await setup({ mcp: true });
  await denied(h.source.catalog(h.request, h.locator));
  assert.equal(h.authCalls, 1);
  assert.equal(h.packageReads, 0);
});

test('Host resource source contract: current global definitions do not replace a fixed plan; fixed-source mutations invalidate its qualification', async () => {
  const h = await setup({ imported: true });
  const catalog = await h.source.catalog(h.request, h.locator),
    q = await h.source.prepareResourceCatalog(h.request, h.command(catalog));
  h.state.assets[0].content = 'unrelated latest body';
  assert.equal(q.assertCurrent(), undefined);
  h.applied.assets[0].content = 'changed fixed source';
  assert.throws(q.assertCurrent, { code: 'resources-unavailable' });
  q.release();
});

test('Host resource source contract: source function replacement, node handoff mutation and parent close reject prepared metadata', async () => {
  for (const change of [
    (h) => {
      h.options.readWorkbench = () => h.state;
    },
    (h) => {
      h.policies.read = async () => [];
    },
    (h) => {
      h.node.handoff.goal = 'different';
    },
    (h) => h.lifetime.abort(),
  ]) {
    const h = await setup();
    const catalog = await h.source.catalog(h.request, h.locator),
      q = await h.source.prepareResourceCatalog(h.request, h.command(catalog));
    change(h);
    assert.throws(q.assertCurrent, { code: 'resources-unavailable' });
    q.release();
  }
});

test('Host resource source contract: close during an admitted metadata read rejects the late result', async () => {
  const h = await setup(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.authorize = async () => {
    entered.resolve();
    await release.promise;
    return { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
  };
  const reading = h.source.catalog(h.request, h.locator);
  await entered.promise;
  h.lifetime.abort();
  release.resolve();
  await denied(reading);
  assert.equal(h.packageReads, 0);
});

test('initial remote metadata uses real package qualifications before composition, retains actor and releases only the operation', async () => {
  const h = await setup({ imported: true });
  assert.equal(h.persisted, undefined);
  const q = await h.source.prepareInitialResourceCatalog(h.request, h.locator);
  assert.equal(q.actorId, 'chen');
  assert.equal(q.catalog.skills.length, 1);
  assert.equal(q.catalog.skills[0].policySource.kind, 'asset-package');
  assert.equal(q.assertCurrent(), undefined);
  assert.equal(h.persisted, undefined);
  assert.ok(h.packageReads > 0);
  q.release();
  assert.equal(q.signal.aborted, true);
  assert.throws(q.assertCurrent);
  assert.equal(h.lifetime.signal.aborted, false);
  const next = await h.source.prepareInitialResourceCatalog(h.request, h.locator);
  assert.equal(next.assertCurrent(), undefined);
  next.release();
});
test('initial remote metadata refuses changed source/locator and a late cancelled qualification without manufacturing a Run', async () => {
  for (const change of [
    (h) => {
      h.node.handoff.goal = 'changed';
    },
    (h) => {
      h.locator.nodeId = 'changed';
    },
    (h) => h.lifetime.abort(),
  ]) {
    const h = await setup();
    const q = await h.source.prepareInitialResourceCatalog(h.request, h.locator);
    change(h);
    assert.throws(q.assertCurrent);
    q.release();
    assert.equal(h.persisted, undefined);
  }
  const h = await setup(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    wait = new AbortController();
  h.authorize = async () => {
    entered.resolve();
    await release.promise;
    return { ok: true, value: { ...h.locator, actorId: 'chen', items: [] } };
  };
  const preparing = h.source.prepareInitialResourceCatalog(h.request, h.locator, wait.signal);
  await entered.promise;
  wait.abort();
  release.resolve();
  await denied(preparing);
  assert.equal(h.persisted, undefined);
});
