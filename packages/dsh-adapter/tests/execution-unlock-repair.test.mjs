/** Actual original Service/JSON repair paths, manual fixed submissions only.
 * Member ports remain explicit contracts; no native/model/GUI or live-data repair. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { open, caller, checked } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';

test('unchanged unlock repair: multi-source late compensation on inbox/events/reconcile and cold JSON reopen never changes fixed in-review inputs or marks upstream affected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-unchanged-unlock-'));
  const f = fixture(),
    nodes = [
      {
        ...f.node,
        id: 'source0',
        skillIds: [],
        reviewerIds: [],
        reviewRequired: false,
        dependsOn: [],
      },
      {
        ...f.node,
        id: 'source1',
        skillIds: [],
        reviewerIds: [],
        reviewRequired: false,
        dependsOn: ['source0'],
      },
      {
        ...f.node,
        id: 'target',
        skillIds: [],
        reviewerIds: ['outside'],
        reviewRequired: true,
        dependsOn: ['source0', 'source1'],
      },
    ];
  const workbench = applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      participantIds: ['chen', 'outside', 'qa'],
      status: 'ready',
      workflows: [{ ...f.task.workflows[0], nodes }],
    },
  });
  let h = await open(root, { workbench });
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const id of ['source0', 'source1', 'target'])
    checked(
      await h.service.submit(caller(), { ...h.human(id, `submit-${id}`), text: `Fixed ${id}.` }),
    );
  const before = structuredClone(h.read('target'));
  assert.equal(before.command.status, 'in-review');
  assert.equal(before.command.upstreamAffected, false);
  assert.deepEqual(
    before.handoff.inputRefs,
    ['source0', 'source1'].map((id) => ({
      sourceNodeId: id,
      artifactVersionId: h.read(id).acceptedArtifactVersionId,
    })),
  );
  const disk = await businessHashes(root);
  h.resetCounts();
  for (let repeat = 0; repeat < 2; repeat++) {
    checked(await h.service.inbox(caller(), { spaceId: 'north' }));
    checked(await h.service.inboxCounts(caller(), { spaceId: 'north' }));
    checked(
      await h.service.events(caller(), { spaceId: 'north', ...h.locate('target'), after: 0 }),
    );
    checked(await h.service.reconcile());
  }
  assert.deepEqual(h.read('target'), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await businessHashes(root), disk);
  await h.close();
  h = await open(root, { seed: false, workbench });
  assert.deepEqual(h.read('target'), before);
  assert.deepEqual(
    h.counters,
    { global: 0, nodes: 0, plans: 0 },
    'startup reconciliation is also a no-op',
  );
  assert.deepEqual(await businessHashes(root), disk);
});
