/** Product service + actual Cordis/DSH JSON; member/directory/configuration facts are contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeRecordKey } from '@zhuma/agent-core';
import { open, checked, refused, caller } from './execution-service-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { reader } from './execution-run-composition-fixture.mjs';

async function host(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-composition-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await open(root, options);
  t.after(() => h.close());
  h.resetCounts();
  return { ...h, root };
}

async function bytes(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(directory, entry.name);
    if (entry.isDirectory())
      result.push(...(await bytes(file)).map(([name, body]) => [`${entry.name}/${name}`, body]));
    else result.push([entry.name, (await readFile(file)).toString('base64')]);
  }
  return result;
}

const locate = (h, nodeId = 'produce') => ({ ...h.locate(nodeId), spaceId: 'north' });
const read = (h, nodeId) => h.service.readRunCompositionInputs(h.request, locate(h, nodeId));
function zeroWrites(h) {
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(h.service.readRunGlobal(), { schemaVersion: 1 });
}
async function acceptSource(h) {
  const submitted = checked(
    await h.service.submit(caller(), {
      ...h.human('produce', 'source-submit'),
      text: 'PRIVATE_SOURCE_BODY_MUST_NOT_ENTER_COMPOSITION_INPUTS',
    }),
  );
  const round = submitted.node.rounds.at(-1);
  checked(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'source-review'),
      roundId: round.id,
      artifactVersionId: round.artifactVersionId,
      action: 'approve',
    }),
  );
  assert.equal(h.read('consume').command.status, 'ready');
  h.resetCounts();
}

test('real JSON composition inputs: human-ready is copied and repeated reads leave bytes and Run metadata untouched', async (t) => {
  const h = await host(t);
  const before = await bytes(h.root);
  const row = h.read();
  assert.equal(row.command.status, 'ready');
  assert.equal(row.handoff.assignee.kind, 'human');
  const first = checked(await read(h));
  assert.deepEqual(first, { ...locate(h), actorId: 'chen', items: [] });
  first.actorId = 'forged';
  first.items.push({ access: 'hidden', count: 999 });
  assert.deepEqual(checked(await read(h)), { ...locate(h), actorId: 'chen', items: [] });
  assert.deepEqual(h.read(), row);
  assert.equal(h.read().nativeExecution, undefined);
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);
});

test('real JSON composition inputs: expert-ready outside the human inbox can assemble a real authorized first start', async (t) => {
  const h = await host(t, { expertNode: 'parallel' });
  const inbox = checked(await h.service.inbox(caller(), { spaceId: 'north' }));
  assert(!inbox.nodes.some((node) => node.nodeId === 'parallel'));
  const node = h.read('parallel');
  assert.equal(node.command.status, 'ready');
  assert.equal(node.handoff.assignee.kind, 'expert');
  h.resetCounts();
  const before = await bytes(h.root);
  const inputs = checked(await read(h, 'parallel'));
  assert.deepEqual(inputs, { ...locate(h, 'parallel'), actorId: 'chen', items: [] });
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);

  const { items: _items, ...scope } = inputs;
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node,
    scope: { ...scope, runId: 'expert-run', generation: 1, segmentId: 's1' },
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    executor: { kind: 'plan-expert', ref: { id: 'qa', version: node.planId } },
    tools: { kind: 'text-only' },
    inputs,
  });
  const { firstMessage: _message, ...projected } = executionRunCompositionRequest(composition);
  checked(
    await h.service.startRun(h.request, {
      ...locate(h, 'parallel'),
      requestId: 'expert-first-start',
      expectedNodeVersion: node.command.version,
      expectedRunVersion: 0,
      mode: 'begin',
      newRunId: 'expert-run',
      newSegmentId: 's1',
      workspace: { kind: 'text-only' },
      ...projected,
      composition,
    }),
  );
  assert.deepEqual(h.counters, { global: 1, nodes: 1, plans: 0 });
  h.resetCounts();
  const running = await bytes(h.root);
  assert.deepEqual(checked(await read(h, 'parallel')), inputs);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await bytes(h.root), running);
});

test('real JSON composition inputs: fixed accepted metadata matches the normal projection without source bodies or writes', async (t) => {
  const h = await host(t);
  await acceptSource(h);
  const inbox = checked(await h.service.inbox(caller(), { spaceId: 'north' }));
  h.resetCounts();
  const before = await bytes(h.root);
  const value = checked(await read(h, 'consume'));
  assert.deepEqual(value.items, inbox.nodes.find((node) => node.nodeId === 'consume').inputs);
  assert.equal(value.items[0].access, 'visible');
  assert.equal(value.items[0].artifactVersionId, h.read().acceptedArtifactVersionId);
  assert(!JSON.stringify(value).includes('PRIVATE_SOURCE_BODY'));
  const saved = structuredClone(value);
  value.items[0].version = 999;
  assert.deepEqual(checked(await read(h, 'consume')), saved);
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);
});

for (const access of ['pending', 'hidden'])
  test(`real JSON composition inputs: ${access} sources retain their normal refusal projection instead of an empty catalog`, async (t) => {
    const h = await host(t);
    await acceptSource(h);
    if (access === 'pending') {
      const source = h.read();
      delete source.acceptedArtifactVersionId;
      await h.domain.table('nodes').put(nodeRecordKey(source), source);
    } else {
      const target = h.read('consume');
      target.handoff.inputRefs = [{ sourceNodeId: 'PRIVATE_HIDDEN_NODE', artifactVersionId: 'v1' }];
      await h.domain.table('nodes').put(nodeRecordKey(target), target);
    }
    const before = await bytes(h.root);
    const value = checked(await read(h, 'consume'));
    assert.equal(value.items.length, 1);
    assert.equal(value.items[0].access, access);
    if (access === 'hidden') assert(!JSON.stringify(value).includes('PRIVATE_HIDDEN_NODE'));
    zeroWrites(h);
    assert.deepEqual(await bytes(h.root), before);
  });

test('real JSON composition inputs: body identity, unknown fields, missing locator, wrong scope and non-controller refuse without writes', async (t) => {
  const h = await host(t);
  const before = await bytes(h.root);
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), actorId: 'chen' }),
    'actor-from-body',
  );
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), extra: true }),
    'unknown-field',
  );
  refused(await h.service.readRunCompositionInputs(h.request, { spaceId: 'north' }), 'validation');
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), revision: 0 }),
    'validation',
  );
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), nodeId: 'missing' }),
    'run-authority-denied',
  );
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), planId: 'missing' }),
    'run-authority-denied',
  );
  refused(
    await h.service.readRunCompositionInputs(h.request, { ...locate(h), spaceId: 'south' }),
    'run-authority-denied',
  );
  refused(
    await h.service.readRunCompositionInputs({ headers: {} }, locate(h)),
    'run-authority-denied',
  );
  const other = { headers: {} };
  h.members.set(other, 'outside');
  refused(await h.service.readRunCompositionInputs(other, locate(h)), 'run-not-controller');
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);
});

test('real JSON composition inputs: a missing recorded plan is refused even while its node row still exists', async (t) => {
  const h = await host(t);
  const node = h.read();
  assert.equal(
    await h.domain.table('plans').delete(`${node.taskId}:${node.planId}:${node.revision}`),
    true,
  );
  const before = await bytes(h.root);
  refused(await read(h), 'run-authority-denied');
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);
});

test('real JSON composition inputs: a successful preparation read never grants a later start access to a replaced source', async (t) => {
  const h = await host(t);
  await acceptSource(h);
  assert.equal(checked(await read(h, 'consume')).items[0].access, 'visible');
  const input = h.begin({}, 'consume', reader);
  const source = h.read();
  source.acceptedArtifactVersionId = 'replacement-version';
  await h.domain.table('nodes').put(nodeRecordKey(source), source);
  const before = await bytes(h.root);
  refused(await h.service.startRun(h.request, input), 'composition-input-unavailable');
  zeroWrites(h);
  assert.deepEqual(await bytes(h.root), before);
});

for (const fault of ['member', 'publication', 'task', 'participant', 'controller', 'directory'])
  test(`real JSON composition inputs: ${fault} changed during an awaited directory scan is checked again`, async (t) => {
    let update;
    const projectSpaces = {
      async spaceForProject() {
        update?.();
        update = undefined;
        return { ok: true, spaceId: 'north' };
      },
    };
    const h = await host(t, { expertNode: 'parallel', projectSpaces });
    const before = await bytes(h.root);
    update = () => {
      if (fault === 'member') h.member.abort();
      if (fault === 'publication') h.source.abort();
      if (fault === 'task') h.setWorkbench((w) => ({ ...w, tasks: [] }));
      if (fault === 'participant')
        h.setWorkbench((w) => ({
          ...w,
          participants: w.participants.map((p) =>
            p.id === 'chen' ? { ...p, available: false } : p,
          ),
        }));
      if (fault === 'controller')
        h.setWorkbench((w) => ({
          ...w,
          tasks: w.tasks.map((task) => ({ ...task, ownerId: 'outside' })),
        }));
      if (fault === 'directory')
        h.assertionResults.project = () => {
          throw Error('CONTRACT_DIRECTORY_REVOKED');
        };
    };
    const result = await read(h, 'parallel');
    refused(
      result,
      fault === 'publication'
        ? 'run-authority-unavailable'
        : fault === 'controller'
          ? 'run-not-controller'
          : 'run-authority-denied',
    );
    zeroWrites(h);
    assert.deepEqual(await bytes(h.root), before);
  });

test('real JSON composition inputs: a source replaced after it was scanned is re-read before returning metadata', async (t) => {
  let onLookup;
  let calls = 0;
  const h = await host(t, {
    projectSpaces: {
      async spaceForProject() {
        await onLookup?.(++calls);
        return { ok: true, spaceId: 'north' };
      },
    },
  });
  await acceptSource(h);
  calls = 0;
  onLookup = async (call) => {
    if (call !== 3) return;
    const source = h.read();
    source.acceptedArtifactVersionId = 'replacement-version';
    await h.domain.table('nodes').put(nodeRecordKey(source), source);
  };
  const value = checked(await read(h, 'consume'));
  assert(calls >= 3);
  assert.equal(value.items[0].access, 'pending');
  assert.equal(value.items[0].pending, 'replaced');
  zeroWrites(h);
});
