/** Private per-Run selection/consent contracts; service transport and SDK have separate evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { createHostMemberNativeKnowledge } from '../dist/host-member-native-knowledge.js';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { describeMemberKnowledgeTool } from '../dist/member-knowledge-tool.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
const scope = compositionFacts().scope;
const library = { id: 'north', spaceId: 'north', kind: 'team', name: '研发知识', canCreate: true };
function accepted({ reader = true, project, changedScope } = {}) {
  const facts = compositionFacts();
  return {
    composition: freezeExecutionRunComposition({
      ...facts,
      ...(reader ? { knowledgeTool: describeMemberKnowledgeTool() } : {}),
      ...(project ? { projectKnowledge: project } : {}),
    }),
    value: { scope: { ...scope, ...changedScope, backendId: randomUUID() } },
  };
}
function projectSnapshot({ required = true, libraryId = library.id } = {}) {
  const value = {
    sourceVersion: 'zhuma-project-knowledge@1',
    spaceId: scope.spaceId,
    projectId: compositionFacts().workbench.projects[0].id,
    relationshipVersion: 1,
    links: [
      {
        reference: {
          spaceId: scope.spaceId,
          libraryId,
          pageId: 'original-page',
          version: 1,
          checksum: 'a'.repeat(64),
        },
        required,
      },
    ],
  };
  return {
    ...value,
    checksum: createHash('sha256').update(canonicalPayload(value)).digest('hex'),
  };
}
function fixture(libraries = [library]) {
  let calls = 0;
  const owner = createHostMemberNativeKnowledge({
    backend: {
      request: async (input) => {
        calls++;
        assert.equal(input.operation, 'knowledge.libraries');
        return {
          body: {
            type: 'server-response',
            rpcId: input.rpcId,
            result: {
              ok: true,
              value: { actorId: scope.actorId, spaceId: 'north', libraries },
            },
          },
        };
      },
    },
    actorId: scope.actorId,
    connectionId: randomUUID(),
    lifetime: new AbortController().signal,
    current: async (signal) => signal.throwIfAborted(),
    admit: (signal) => signal.throwIfAborted(),
  });
  return { owner, calls: () => calls };
}
test('knowledge choice is from the original library list, default-off, and frozen only for the accepted Run', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  const choice = await h.owner.prepare('intent', 'north', { libraryId: 'north' }, signal);
  assert.equal(choice.allowDrafts, false);
  h.owner.bind('intent', accepted());
  const before = h.calls();
  const port = h.owner.create({ scope }, { scope });
  assert.equal(h.calls(), before, 'original factory construction performs no IO');
  assert.deepEqual(port.catalog.library, library);
  assert.equal(port.allowDrafts, false);
  assert.throws(() =>
    h.owner.create(
      { scope: { ...scope, runId: 'cold-run' } },
      { scope: { ...scope, runId: 'cold-run' } },
    ),
  );
  h.owner.fence();
  await assert.rejects(port.assertCurrent(signal));
});
test('explicit draft consent stays with one library/Run and a changed retry or foreign library cannot inherit it', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  await h.owner.prepare('intent', 'north', { libraryId: 'north', allowDrafts: true }, signal);
  h.owner.bind('intent', accepted());
  assert.equal(h.owner.create({ scope }, { scope }).allowDrafts, true);
  await assert.rejects(
    h.owner.prepare('intent', 'north', { libraryId: 'north', allowDrafts: false }, signal),
  );
  await assert.rejects(
    h.owner.prepare('new', 'north', { libraryId: 'foreign', allowDrafts: true }, signal),
  );
  assert.throws(() => h.owner.create({ scope }, { scope: { ...scope, runId: 'foreign' } }));
});

test('automatic knowledge choice uses the sole original library and cannot inherit a manual draft selection', async () => {
  const h = fixture(),
    signal = new AbortController().signal;
  await h.owner.prepare(
    'manual',
    scope.spaceId,
    { libraryId: library.id, allowDrafts: true },
    signal,
  );
  h.owner.bind('manual', accepted());
  assert.deepEqual(await h.owner.workflowChoice(scope.spaceId, signal), {
    libraryId: library.id,
    allowDrafts: false,
  });
  assert.equal(h.calls(), 2, 'both choices read metadata from the original library source');
  for (const libraries of [[], [{ ...library, id: 'other' }]])
    await assert.rejects(fixture(libraries).owner.workflowChoice(scope.spaceId, signal), {
      code: 'run-authority-unavailable',
    });
});

test('project knowledge binding uses the original fixed composition and grants no body read or draft consent', async () => {
  const h = fixture(),
    signal = new AbortController().signal,
    project = projectSnapshot();
  await h.owner.prepare('intent', scope.spaceId, { libraryId: library.id }, signal);
  const run = accepted({ project });
  const before = h.calls();
  h.owner.bind('intent', run);
  const port = h.owner.create({ scope }, { scope });
  assert.equal(h.calls(), before, 'binding never searches or reads a referenced page');
  assert.equal(port.allowDrafts, false);
  assert.equal(port.catalog.library.id, project.links[0].reference.libraryId);
  assert.deepEqual(run.composition.payload.projectKnowledge, project);
});

for (const kind of ['scope', 'library', 'reader', 'checksum'])
  test(`project knowledge binding refuses ${kind} mismatch before any original tool can be constructed`, async () => {
    const h = fixture(),
      signal = new AbortController().signal;
    await h.owner.prepare('intent', scope.spaceId, { libraryId: library.id }, signal);
    const run = accepted({
      reader: kind !== 'reader',
      project: projectSnapshot({
        required: kind !== 'reader',
        libraryId: kind === 'library' ? 'another-library' : library.id,
      }),
      ...(kind === 'scope' ? { changedScope: { taskId: 'another-task' } } : {}),
    });
    const value = structuredClone(run);
    if (kind === 'checksum') value.composition.payload.projectKnowledge.checksum = '0'.repeat(64);
    assert.throws(() => h.owner.bind('intent', value));
    assert.throws(() => h.owner.create({ scope }, { scope }));
  });

test('project knowledge binding preserves optional references without adding a reader, but required references need original prepared consent', () => {
  const h = fixture();
  h.owner.bind(
    'no-choice',
    accepted({ reader: false, project: projectSnapshot({ required: false }) }),
  );
  assert.equal(h.owner.selection(scope), undefined);
  assert.throws(() => h.owner.create({ scope }, { scope }));
  assert.throws(() => h.owner.bind('required', accepted({ project: projectSnapshot() })), {
    code: 'run-scope-mismatch',
  });
  h.owner.bind('legacy', accepted({ reader: false }));
  assert.equal(h.owner.selection(scope), undefined);
});
