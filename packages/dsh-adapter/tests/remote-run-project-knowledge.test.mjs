/** Original knowledge/Execution Service, member cookies, DSH JSON and signed
 * admission. Host assembly and SDK/model are outside these contract tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyWorkbenchCommand, canonicalPayload } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { fileHost, ok, no, hash } from './remote-run-files-fixture.mjs';
import { knowledgeHost, value } from './knowledge-fixture.mjs';
import { caller } from './execution-service-run-fixture.mjs';
import { openExecutionMemberLease } from '../dist/member-session.js';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { readExecutionRunComposition } from '../dist/execution-run-composition.js';
const defaults = (knowledge = true) => ({
  model: { provider: 'contract', model: 'contract', maxTokens: 1000 },
  workspace: { kind: 'text-only' },
  capabilities: {
    resultIntent: 'zhuma-native-result-intent@1',
    localTools: [],
    ...(knowledge ? { knowledge: 'zhuma-native-knowledge@1' } : {}),
  },
});
const project = { spaceId: 'north', projectId: 'project' };
const ref = (page, version = 1) => ({
  spaceId: page.spaceId,
  libraryId: page.libraryId,
  pageId: page.pageId,
  version,
  checksum: page.versions[version - 1].body.checksum,
});
function workbench() {
  const f = JSON.parse(JSON.stringify(fixture()).replaceAll('"chen"', '"ann"'));
  return applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      status: 'ready',
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [
            { ...f.node, id: 'produce', skillIds: [], reviewRequired: false, reviewerIds: [] },
          ],
        },
      ],
    },
  });
}
async function setup(t, { required = true, provider = true, wait } = {}) {
  const state = workbench(),
    k = await knowledgeHost(t, { readWorkbench: () => state });
  await k.directory.assignProjectSpace('project', 'north');
  const page = await k.seed();
  value(
    await k.service.saveProjectLinks(k.requests.ann, {
      ...project,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      links: [{ reference: ref(page), required }],
    }),
  );
  let calls = 0;
  const controls = {};
  const h = await fileHost(t, {
    workbench: state,
    seed: false,
    beforeRemoteEnable: async (base) => {
      Object.assign(base.request.headers, k.requests.ann.headers);
      base.service.runHost.memberLease = (request) => openExecutionMemberLease(k.ctx, request);
      const { nodeId, ...plan } = base.locate();
      ok(await base.service.startPlan(caller('ann'), { ...plan, idempotencyKey: 'start' }));
      if (provider)
        base.service.runHost.prepareProjectKnowledge = async (request, query, signal) => {
          calls++;
          assert.equal(request, base.request);
          assert.deepEqual(query, project);
          // This intentionally reads through the original Service queue. Holding that
          // queue while awaiting E's project source would deadlock this normal path.
          ok(
            await base.service.readRunCompositionInputs(request, {
              ...base.locate(),
              spaceId: 'north',
            }),
          );
          const snapshot = value(await k.service.projectSnapshot(request, query, signal));
          await wait?.(snapshot, signal, controls);
          return controls.replace ? controls.replace(snapshot) : snapshot;
        };
    },
  });
  return {
    ...h,
    k,
    page,
    controls,
    get snapshotCalls() {
      return calls;
    },
  };
}
const accept = (h, knowledge = true) => h.accept({ ...defaults(knowledge) });
const snapshot = (h) =>
  canonicalPayload({
    global: h.domain.global.get(),
    nodes: [...h.domain.table('nodes').entries()],
  });

test('Run project knowledge: same original cookie/project source freezes exact refs/hash without holding the Run queue; old-key replay never upgrades to the latest association', async (t) => {
  const h = await setup(t),
    request = accept(h),
    admitted = ok(await h.send(request));
  assert.equal(admitted.scope.actorId, 'ann');
  assert.equal(h.snapshotCalls, 1);
  const run = currentExecutionRun(h.read()),
    saved = readExecutionRunComposition(run.composition),
    frozen = saved.payload.projectKnowledge;
  assert.equal(frozen.relationshipVersion, 1);
  assert.deepEqual(frozen.links, [{ reference: ref(h.page), required: true }]);
  assert.equal(
    frozen.checksum,
    hash(Object.fromEntries(Object.entries(frozen).filter(([key]) => key !== 'checksum'))),
  );
  assert.equal(saved.payload.toolAllowlist.includes('knowledge'), true);
  assert.equal(
    JSON.parse(saved.payload.context.split('\n').at(-1)).projectKnowledge.checksum,
    frozen.checksum,
  );
  const newer = await h.k.seed({ pageId: 'newer' });
  value(
    await h.k.service.saveProjectLinks(h.k.requests.ann, {
      ...project,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      links: [{ reference: ref(newer), required: false }],
    }),
  );
  const before = snapshot(h);
  const replay = ok(await h.send(request));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(h.snapshotCalls, 1);
  assert.equal(snapshot(h), before);
  assert.deepEqual(currentExecutionRun(h.read()).composition, saved);
});

for (const kind of ['required-reader', 'checksum', 'foreign-space', 'foreign-project'])
  test(`Run project knowledge: ${kind} refuses before any original Run reservation`, async (t) => {
    const h = await setup(t);
    if (kind !== 'required-reader')
      h.controls.replace = (original) => {
        const next = structuredClone(original);
        if (kind === 'checksum') next.checksum = '0'.repeat(64);
        else {
          next[kind === 'foreign-space' ? 'spaceId' : 'projectId'] = 'other';
          if (kind === 'foreign-space')
            next.links.forEach((link) => (link.reference.spaceId = 'other'));
          const { checksum, ...payload } = next;
          next.checksum = hash(payload);
        }
        return next;
      };
    const before = snapshot(h);
    no(await h.send(accept(h, kind !== 'required-reader')));
    assert.equal(snapshot(h), before);
    assert.equal(h.read().nativeExecution, undefined);
  });

test('Run project knowledge: optional refs preserve the selected tool ceiling and references are never represented as body reads', async (t) => {
  const h = await setup(t, { required: false });
  ok(await h.send(accept(h, false)));
  const saved = readExecutionRunComposition(currentExecutionRun(h.read()).composition);
  assert.equal(saved.payload.projectKnowledge.links[0].required, false);
  assert.equal(saved.payload.knowledgeTool, undefined);
  assert.equal(saved.payload.toolAllowlist.includes('knowledge'), false);
  assert.equal(saved.payload.context.includes('不代表已经读取正文'), true);
  assert.equal(saved.payload.context.includes('接口使用令牌验证'), false);
});

test('Run project knowledge: same-source permission failure never becomes an empty snapshot or a durable Run', async (t) => {
  const h = await setup(t);
  await h.k.revoke('north', 'ann');
  const before = snapshot(h);
  no(await h.send(accept(h)));
  assert.equal(snapshot(h), before);
  assert.equal(h.read().nativeExecution, undefined);
});

test('Run project knowledge: Stop fences a pending queue-external snapshot and no Run can appear after the late result', async (t) => {
  const entered = Promise.withResolvers(),
    proceed = Promise.withResolvers();
  let signal;
  const h = await setup(t, {
    wait: (_snapshot, wait) => {
      signal = wait;
      entered.resolve();
      return proceed.promise;
    },
  });
  t.after(() => proceed.resolve());
  const { nodeId, ...location } = h.locate(),
    target = { spaceId: 'north', ...location };
  const intent = ok(
    await h.send(
      h.envelope('workflow-start', {
        target,
        defaults: defaults(),
        budget: { concurrent: 1, automaticRevisions: 2 },
      }),
    ),
  );
  const workflow = { intentId: intent.intent.intentId, generation: 1 };
  const pending = h.send(h.accept({ ...defaults(), workflow }));
  await entered.promise;
  const stopped = ok(await h.send(h.envelope('workflow-stop', { target, workflow })));
  assert.equal(signal.aborted, true);
  assert.equal(stopped.state, 'stopping');
  assert.equal(h.read().nativeExecution, undefined);
  proceed.resolve();
  no(await pending);
  assert.equal(
    ok(await h.send(h.envelope('workflow-status', { target, workflow }))).state,
    'paused',
  );
  assert.equal(h.read().nativeExecution, undefined);
});

test('Run project knowledge: absent legacy Host source preserves the historical composition shape', async (t) => {
  const h = await setup(t, { provider: false });
  ok(await h.send(accept(h, false)));
  const saved = readExecutionRunComposition(currentExecutionRun(h.read()).composition);
  assert.equal(saved.payload.projectKnowledge, undefined);
  assert.equal(h.snapshotCalls, 0);
});

test('Run project knowledge: revocation while the snapshot is pending is rechecked by the original accept before persistence', async (t) => {
  const entered = Promise.withResolvers(),
    proceed = Promise.withResolvers();
  const h = await setup(t, {
    wait: () => {
      entered.resolve();
      return proceed.promise;
    },
  });
  t.after(() => proceed.resolve());
  const pending = h.send(accept(h));
  await entered.promise;
  await h.k.revoke('north', 'ann');
  const before = snapshot(h);
  proceed.resolve();
  no(await pending);
  assert.equal(snapshot(h), before);
  assert.equal(h.read().nativeExecution, undefined);
});
