/** Host/request authorization are doubles. This proves orchestration, not real member or MCP authorization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';
import {
  withExecutionRunResourceQualification,
  ExecutionRunResourceQualificationCloseError,
} from '../dist/execution-run-resource-qualification.js';

function fixture({ empty = false, mcp = false } = {}) {
  const facts = compositionFacts(),
    plan = facts.workbench.appliedPlans[0];
  const node = plan.task.workflows[0].nodes.find((item) => item.id === facts.scope.nodeId);
  const catalog = { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] };
  if (!empty) {
    const asset = {
      id: mcp ? 'docs' : 'method',
      name: 'Selected',
      kind: mcp ? 'mcp' : 'skill',
      description: 'Contract',
      content: 'SELECTED_BODY',
      available: true,
    };
    plan.assets = [asset];
    const ref = { id: asset.id, version: plan.id };
    if (mcp) {
      node.mcpIds = [asset.id];
      facts.node.handoff.mcpRefs = [ref];
      catalog.mcp = [
        {
          ref,
          definitionDigest: executionResourceDigest(asset),
          connectionRef: { id: 'configured-docs', version: '1' },
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
    } else {
      node.skillIds = [asset.id];
      facts.node.handoff.skillRefs = [ref];
    }
    facts.resourceCatalog = catalog;
  }
  const composition = freezeExecutionRunComposition(facts);
  const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
  const command = {
    ...projection,
    composition,
    ...Object.fromEntries(
      ['taskId', 'planId', 'revision', 'nodeId', 'spaceId'].map((key) => [key, facts.scope[key]]),
    ),
    requestId: 'resource-start',
    newRunId: facts.scope.runId,
    newSegmentId: facts.scope.segmentId,
    mode: 'begin',
    expectedNodeVersion: facts.node.command.version,
    expectedRunVersion: 0,
    workspace: { kind: 'text-only' },
  };
  const hostLife = new AbortController(),
    ownerLife = new AbortController(),
    metadataLife = new AbortController(),
    runLife = new AbortController();
  const originalRequest = { headers: {} };
  let prepared = 0,
    released = 0,
    checked = 0;
  const qualification = {
    catalog,
    signal: metadataLife.signal,
    assertCurrent() {
      checked++;
      return undefined;
    },
    release() {
      released++;
      metadataLife.abort();
      return undefined;
    },
  };
  const host = {
    signal: hostLife.signal,
    async prepareResourceCatalog(request, received) {
      prepared++;
      assert.equal(request, originalRequest);
      assert.equal(received, command);
      return qualification;
    },
  };
  return {
    input: { host, ownerSignal: ownerLife.signal, originalRequest, command },
    host,
    command,
    qualification,
    catalog,
    ownerLife,
    metadataLife,
    hostLife,
    runLife,
    get prepared() {
      return prepared;
    },
    get released() {
      return released;
    },
    get checked() {
      return checked;
    },
  };
}
const denied = (error) =>
  error.code === 'run-authority-unavailable' && !error.message.includes('PRIVATE');

test('resource qualification contract: original request and exact catalog reach the queue; metadata lifetime never becomes Run lifetime', async () => {
  const f = fixture();
  const result = await withExecutionRunResourceQualification(f.input, async (source) => {
    assert.deepEqual(source.catalog, f.catalog);
    assert(Object.isFrozen(source.catalog.mcp));
    assert(!('signal' in source));
    assert(!('release' in source));
    assert.equal(source.assertCurrent(), undefined);
    return 'queued-result';
  });
  assert.equal(result, 'queued-result');
  assert.equal(f.prepared, 1);
  assert.equal(f.released, 1);
  assert(f.checked >= 3);
  assert.equal(f.metadataLife.signal.aborted, true);
  assert.equal(f.runLife.signal.aborted, false);
  assert.equal(f.ownerLife.signal.aborted, false);
});

test('resource qualification contract: no-resource legacy path never calls private preparation', async () => {
  const f = fixture({ empty: true });
  f.host.prepareResourceCatalog = () => {
    throw Error('must not read private source');
  };
  assert.equal(
    await withExecutionRunResourceQualification(f.input, async (source) => {
      assert.equal(source, undefined);
      return 'legacy';
    }),
    'legacy',
  );
});

test('resource qualification contract: MCP-only still requires the genuine Host provider', async () => {
  const f = fixture({ mcp: true });
  await withExecutionRunResourceQualification(f.input, async (source) => {
    source.assertCurrent();
    assert.equal(source.catalog.mcp[0].connectionRef.version, '1');
  });
  assert.equal(f.prepared, 1);
  const missing = fixture({ mcp: true });
  delete missing.host.prepareResourceCatalog;
  await assert.rejects(
    withExecutionRunResourceQualification(missing.input, async () => assert.fail('no producer')),
    denied,
  );
});

for (const [name, change] of [
  [
    'Host method',
    (f) => {
      f.host.prepareResourceCatalog = async () => f.qualification;
    },
  ],
  [
    'Host signal',
    (f) => {
      f.host.signal = new AbortController().signal;
    },
  ],
  [
    'qualification signal',
    (f) => {
      f.qualification.signal = new AbortController().signal;
    },
  ],
  [
    'assertion',
    (f) => {
      f.qualification.assertCurrent = () => undefined;
    },
  ],
  [
    'release method',
    (f) => {
      f.qualification.release = () => assert.fail('foreign release');
    },
  ],
  [
    'catalog pointer',
    (f) => {
      f.qualification.catalog = structuredClone(f.catalog);
    },
  ],
  [
    'catalog content',
    (f) => {
      f.catalog.skills = [];
    },
  ],
  [
    'command scope',
    (f) => {
      f.command.newSegmentId = 'other-segment';
    },
  ],
])
  test(`resource qualification contract: changed ${name} fences and uses original release once`, async () => {
    const f = fixture();
    await assert.rejects(
      withExecutionRunResourceQualification(f.input, async (source) => {
        change(f);
        source.assertCurrent();
        assert.fail('must not commit');
      }),
      denied,
    );
    assert.equal(f.released, 1);
  });

for (const [name, bad] of [
  ['non-undefined', () => true],
  ['asynchronous', () => Promise.reject(Error('PRIVATE_ASYNC_ASSERTION'))],
])
  test(`resource qualification contract: ${name} assertion never authorizes`, async () => {
    const f = fixture();
    f.qualification.assertCurrent = bad;
    await assert.rejects(
      withExecutionRunResourceQualification(f.input, async () => assert.fail('no authorization')),
      denied,
    );
    assert.equal(f.released, 1);
  });

test('resource qualification contract: raw saved Skill definitions cannot masquerade as policy metadata', async () => {
  const f = fixture();
  f.qualification.catalog = f.command.composition.payload.resources;
  await assert.rejects(
    withExecutionRunResourceQualification(f.input, async () =>
      assert.fail('raw payload is not a catalog'),
    ),
    denied,
  );
  assert.equal(f.released, 1);
});

for (const missing of [true, false])
  test(`resource qualification contract: ${missing ? 'missing' : 'throwing'} release remains an owner cleanup failure`, async () => {
    const f = fixture();
    if (missing) delete f.qualification.release;
    else
      f.qualification.release = () => {
        throw Error('PRIVATE_RELEASE_FAILURE');
      };
    await assert.rejects(
      withExecutionRunResourceQualification(f.input, async () => 'value'),
      (error) =>
        error instanceof ExecutionRunResourceQualificationCloseError &&
        error.cleanupFailed &&
        denied(error),
    );
  });

test('resource qualification contract: mismatched top-level scope stops before private preparation', async () => {
  const f = fixture();
  f.command.spaceId = 'different-space';
  await assert.rejects(
    withExecutionRunResourceQualification(f.input, async () => assert.fail('bad scope')),
  );
  assert.equal(f.prepared, 0);
});

test('resource qualification contract: revoke across an awaited verify prevents its subsequent commit', async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let committed = 0;
  const running = withExecutionRunResourceQualification(f.input, async (source) => {
    source.assertCurrent();
    entered.resolve();
    await gate.promise;
    source.assertCurrent();
    committed++;
  });
  await entered.promise;
  f.metadataLife.abort();
  gate.resolve();
  await assert.rejects(running, denied);
  assert.equal(committed, 0);
  assert.equal(f.released, 1);
});

test('resource qualification contract: owner close still owns late qualification and its release', async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const prepare = f.host.prepareResourceCatalog;
  f.host.prepareResourceCatalog = async (...args) => {
    entered.resolve();
    await gate.promise;
    return prepare.apply(f.host, args);
  };
  let settled = false;
  const running = withExecutionRunResourceQualification(f.input, async () =>
    assert.fail('closed owner'),
  );
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  f.ownerLife.abort();
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(f.released, 0);
  gate.resolve();
  await assert.rejects(running, denied);
  assert.equal(f.released, 1);
});

test('resource qualification contract: invalid async release is awaited and remains a cleanup failure', async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  f.qualification.release = () => {
    entered.resolve();
    return gate.promise;
  };
  let settled = false;
  const running = withExecutionRunResourceQualification(f.input, async () => 'durable-result');
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await setImmediate();
  assert.equal(settled, false);
  gate.resolve();
  await assert.rejects(
    running,
    (error) => error instanceof ExecutionRunResourceQualificationCloseError && error.cleanupFailed,
  );
});

test('resource qualification contract: preparation errors are neutral and callback failure still releases', async () => {
  const f = fixture();
  f.host.prepareResourceCatalog = async () => {
    throw Error('PRIVATE_CONFIGURATION');
  };
  await assert.rejects(
    withExecutionRunResourceQualification(f.input, async () => assert.fail()),
    denied,
  );
  const other = fixture();
  await assert.rejects(
    withExecutionRunResourceQualification(other.input, async () => {
      throw Error('PRIVATE_WORK_FAILURE');
    }),
    denied,
  );
  assert.equal(other.released, 1);
});
