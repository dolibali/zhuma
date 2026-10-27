/** Real ExecutionService/Cordis/DSH JSON; identity, package policy and MCP sources are contracts.
 * No real cookie, private asset package, MCP connection, model or native driver is exercised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { open, checked, refused, caller } from './execution-service-run-fixture.mjs';
import { command } from './execution-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, { resource = 'skill', provider = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-resource-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await open(root, { seed: false, mount: false });
  t.after(() => h.close());
  const catalog = { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] };
  if (resource) {
    // Fixture preparation before startPlan, not a production edit of an applied plan.
    h.setWorkbench((workbench) => {
      const plan = workbench.appliedPlans.at(-1);
      const asset = {
        id: resource === 'mcp' ? 'docs' : 'method',
        name: 'Selected contract resource',
        kind: resource,
        description: 'Contract metadata',
        content: 'SELECTED_BODY',
        available: true,
      };
      plan.assets = [asset];
      const node = plan.task.workflows[0].nodes.find((item) => item.id === 'produce');
      node[resource === 'mcp' ? 'mcpIds' : 'skillIds'] = [asset.id];
      if (resource === 'mcp')
        catalog.mcp = [
          {
            ref: { id: asset.id, version: plan.id },
            definitionDigest: executionResourceDigest(asset),
            connectionRef: { id: 'contract-connection', version: '1' },
            serverName: 'docs',
            tools: [
              {
                name: 'mcp__docs__ping',
                description: 'Contract',
                parameters: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            ],
          },
        ];
      return workbench;
    });
  }
  const { nodeId: _nodeId, ...planLocator } = h.locate();
  checked(await h.service.startPlan(caller(), { ...planLocator, idempotencyKey: 'start' }));
  h.resetCounts();
  const counts = { prepared: 0, privateReads: 0, assertions: 0, released: 0 };
  const controls = {
    catalog,
    gate: undefined,
    entered: deferred(),
    releaseFailure: false,
    lives: [],
  };
  const host = {
    signal: h.source.signal,
    async memberLease(request) {
      const memberId = h.members.get(request);
      if (!memberId) throw Error('CONTRACT_MEMBER_DENIED');
      let released = false;
      return {
        memberId,
        expiresAt: Date.now() + 60_000,
        signal: h.member.signal,
        assertCurrent(spaceId) {
          if (released || h.member.signal.aborted || spaceId !== 'north')
            throw Error('CONTRACT_MEMBER_DENIED');
        },
        release() {
          released = true;
        },
      };
    },
    assertProjectSpace(projectId, spaceId) {
      if (h.source.signal.aborted || projectId !== 'project' || spaceId !== 'north')
        throw Error('CONTRACT_SPACE_DENIED');
    },
    assertConfiguration(_member, _space, _node, input) {
      if (
        h.faults.configuration ||
        input.selection.provider !== 'contract' ||
        input.selection.model !== 'contract-model'
      )
        throw Error('CONTRACT_CONFIGURATION_DENIED');
    },
    assertWorkspace(_member, _space, _workspace, _access, configurationId) {
      if (h.faults.workspace || h.source.signal.aborted || !configurationId)
        throw Error('CONTRACT_WORKSPACE_DENIED');
    },
    onChange() {
      return () => {};
    },
    ...(provider
      ? {
          async prepareResourceCatalog(originalRequest, input) {
            counts.prepared++;
            // This exact product read reenters the original queue. Private contract
            // lookup follows member/controller/scope validation, never precedes it.
            const current = checked(
              await h.service.readRunCompositionInputs(originalRequest, {
                spaceId: input.spaceId,
                taskId: input.taskId,
                planId: input.planId,
                revision: input.revision,
                nodeId: input.nodeId,
              }),
            );
            assert.equal(originalRequest, h.request);
            assert.deepEqual(current, {
              ...h.locate(),
              actorId: 'chen',
              spaceId: 'north',
              items: [],
            });
            counts.privateReads++;
            controls.entered.resolve();
            await controls.gate?.promise;
            const life = new AbortController();
            controls.lives.push(life);
            let released = false;
            return {
              catalog: controls.catalog,
              signal: life.signal,
              assertCurrent() {
                counts.assertions++;
                if (released || life.signal.aborted || h.member.signal.aborted)
                  throw Error('CONTRACT_METADATA_REVOKED');
              },
              release() {
                assert.equal(released, false);
                released = true;
                counts.released++;
                life.abort();
                if (controls.releaseFailure) throw Error('CONTRACT_METADATA_RELEASE_FAILED');
              },
            };
          },
        }
      : {}),
  };
  h.service.installRunHost(host);
  const begin = (compositionOptions = {}) => {
    const row = h.read();
    const { actorId, ...raw } = command(row);
    const prior = row.nativeExecution?.receipts.find((item) => item.requestId === raw.requestId);
    const run = prior && row.nativeExecution.runs.find((item) => item.attempt.id === prior.runId);
    const { configurationId: _configuration, ...model } = raw.selection;
    const composition = freezeExecutionRunComposition({
      workbench: h.readWorkbench(),
      node: row,
      scope: {
        ...h.locate(),
        actorId,
        spaceId: raw.spaceId,
        runId: raw.newRunId,
        generation: run ? run.attempt.generation : (row.nativeExecution?.runs.length ?? 0) + 1,
        segmentId: raw.newSegmentId,
      },
      model,
      executor: { kind: 'builtin' },
      tools: { kind: 'text-only' },
      inputs: { ...h.locate(), actorId, spaceId: raw.spaceId, items: [] },
      ...(resource ? { resourceCatalog: catalog } : {}),
      ...compositionOptions,
    });
    const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
    return { ...h.locate(), ...raw, ...projection, composition };
  };
  return { ...h, begin, counts, controls, host };
}

for (const resource of ['skill', 'mcp'])
  test(
    `resource service contract: ${resource} reenters the original read queue, freezes and replays once`,
    { timeout: 5000 },
    async (t) => {
      const h = await fixture(t, { resource });
      const input = h.begin();
      checked(await h.service.startRun(h.request, input));
      assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
      assert.deepEqual(h.service.readRunComposition(h.runLocator()), input.composition);
      checked(await h.service.startRun(h.request, input));
      assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
      assert.equal(h.counts.prepared, 2);
      assert.equal(h.counts.privateReads, 2);
      assert.equal(h.counts.released, 2);
      assert(h.counts.assertions >= 8);
      assert.equal(h.source.signal.aborted, false, 'operation release is not Host/Run shutdown');
    },
  );

test('resource service contract: beginRun uses the same preparation without enabling the writer', async (t) => {
  const h = await fixture(t);
  const input = h.begin();
  refused(await h.service.beginRun(h.request, input), 'run-writer-unavailable');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  checked(await h.service.enableRunWriter());
  h.resetCounts();
  checked(await h.service.beginRun(h.request, input));
  assert.deepEqual(h.counters, { global: 0, nodes: 1, plans: 0 });
  assert.equal(h.counts.released, 2);
});

for (const resource of ['skill', 'mcp'])
  test(`resource service contract: ${resource} without an installed provider refuses before writes`, async (t) => {
    const h = await fixture(t, { resource, provider: false });
    refused(await h.service.startRun(h.request, h.begin()), 'run-authority-unavailable');
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  });

test('resource service contract: validation precedes preparation; foreign request cannot read private metadata', async (t) => {
  const h = await fixture(t);
  const input = h.begin();
  refused(await h.service.startRun(h.request, { ...input, actorId: 'chen' }), 'actor-from-body');
  const { composition: _composition, ...missing } = input;
  refused(await h.service.startRun(h.request, missing), 'validation');
  assert.equal(h.counts.prepared, 0);
  refused(await h.service.startRun({ headers: {} }, input), 'run-authority-unavailable');
  refused(
    await h.service.startRun(h.request, { ...input, spaceId: 'foreign' }),
    'composition-mismatch',
  );
  assert.equal(h.counts.privateReads, 0);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('resource service contract: current MCP catalog mismatch cannot use saved resources as a fallback', async (t) => {
  const h = await fixture(t, { resource: 'mcp' });
  const input = h.begin();
  h.controls.catalog = structuredClone(h.controls.catalog);
  h.controls.catalog.mcp[0].connectionRef.version = '2';
  refused(await h.service.startRun(h.request, input), 'composition-mismatch');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.counts.released, 1);
});

for (const fault of ['configuration', 'workspace'])
  test(`resource service contract: original ${fault} gate still refuses before marker`, async (t) => {
    const h = await fixture(t);
    h.faults[fault] = true;
    refused(await h.service.startRun(h.request, h.begin()), 'run-authority-denied');
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    assert.equal(h.counts.released, 1);
  });

test('resource service contract: metadata revocation after durable marker prevents the node commit', async (t) => {
  const h = await fixture(t);
  h.faults.afterGlobalWrite = () => h.controls.lives.at(-1).abort();
  refused(await h.service.startRun(h.request, h.begin()), 'run-authority-unavailable');
  assert.deepEqual(h.counters, { global: 1, nodes: 0, plans: 0 });
  assert.equal(h.read().nativeExecution, undefined);
  assert.equal(h.counts.released, 1);
});

test(
  'resource service contract: close fences new preparation and waits for a late qualification release',
  { timeout: 5000 },
  async (t) => {
    const h = await fixture(t);
    h.controls.gate = deferred();
    const start = h.service.startRun(h.request, h.begin());
    await h.controls.entered.promise;
    let closed = false;
    const stop = h.service.closeRuns().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      assert.equal(closed, false);
      assert.equal(h.counts.released, 0);
      refused(await h.service.startRun(h.request, h.begin()), 'run-authority-unavailable');
      assert.equal(h.counts.prepared, 1);
    } finally {
      h.controls.gate.resolve();
      refused(await start, 'run-authority-unavailable');
      await stop;
    }
    assert.equal(closed, true);
    assert.equal(h.counts.released, 1);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  },
);

test('resource service contract: cleanup failure stays visible after the preparation promise settled', async (t) => {
  const h = await fixture(t);
  h.controls.releaseFailure = true;
  refused(await h.service.startRun(h.request, h.begin()), 'run-authority-unavailable');
  // A durable node may already exist: cleanup failure is not a rollback receipt.
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  assert.equal(h.counts.released, 1);
  await setImmediate();
  await assert.rejects(h.service.closeRuns(), (error) => error.cleanupFailed === true);
  await h.disposeExecution();
  assert.equal(h.closeState.closed, true);
  assert.equal(h.closeState.errors.at(-1).cleanupFailed, true);
});

test('resource service contract: the legacy no-resource route does not request any catalog', async (t) => {
  const h = await fixture(t, { resource: false });
  const input = h.begin();
  assert.equal(input.composition.schemaVersion, 1);
  checked(await h.service.startRun(h.request, input));
  assert.equal(h.counts.prepared, 0);
  assert.equal(h.counts.privateReads, 0);
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
});

for (const resource of [false, 'skill'])
  test(`result-intent service contract: original ${resource || 'no-resource'} admission preserves the explicit descriptor`, async (t) => {
    const h = await fixture(t, { resource });
    const resultIntentTool = JSON.parse(
      await readFile(
        new URL('./fixtures/result-intent-descriptor-v1.json', import.meta.url),
        'utf8',
      ),
    );
    const input = h.begin({ resultIntentTool });
    checked(await h.service.startRun(h.request, input));
    checked(await h.service.startRun(h.request, input));
    assert.deepEqual(h.service.readRunComposition(h.runLocator()), input.composition);
    assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
    assert.equal(h.counts.prepared, resource ? 2 : 0);
    assert.equal(h.counts.released, resource ? 2 : 0);
  });

test('result-intent service contract: a new Host capability cannot overwrite an old same-key Run', async (t) => {
  const h = await fixture(t, { resource: false });
  const prior = h.begin();
  checked(await h.service.startRun(h.request, prior));
  const resultIntentTool = JSON.parse(
    await readFile(new URL('./fixtures/result-intent-descriptor-v1.json', import.meta.url), 'utf8'),
  );
  const changed = h.begin({ resultIntentTool });
  refused(await h.service.startRun(h.request, changed), 'run-idempotency-mismatch');
  assert.deepEqual(h.service.readRunComposition(h.runLocator()), prior.composition);
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
});
