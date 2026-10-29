/** Private per-Run selection/consent contracts; service transport and SDK have separate evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHostMemberNativeKnowledge } from '../dist/host-member-native-knowledge.js';
const scope = {
  actorId: 'ann',
  spaceId: 'north',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: 'run',
  generation: 1,
  segmentId: 'segment',
};
const library = { id: 'north', spaceId: 'north', kind: 'team', name: '研发知识', canCreate: true };
function fixture() {
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
            result: { ok: true, value: { actorId: 'ann', spaceId: 'north', libraries: [library] } },
          },
        };
      },
    },
    actorId: 'ann',
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
  h.owner.bind('intent', { value: { scope: { ...scope, backendId: randomUUID() } } });
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
  h.owner.bind('intent', { value: { scope: { ...scope, backendId: randomUUID() } } });
  assert.equal(h.owner.create({ scope }, { scope }).allowDrafts, true);
  await assert.rejects(
    h.owner.prepare('intent', 'north', { libraryId: 'north', allowDrafts: false }, signal),
  );
  await assert.rejects(
    h.owner.prepare('new', 'north', { libraryId: 'foreign', allowDrafts: true }, signal),
  );
  assert.throws(() => h.owner.create({ scope }, { scope: { ...scope, runId: 'foreign' } }));
});
