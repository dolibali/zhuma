// Original Service/DSH JSON contracts. Member/config/native ports are fixtures,
// not proof of SDK, provider-model, performance or installed Host behavior.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeRecordKey } from '@zhuma/agent-core';
import { executionReviewCompositionRequest } from '../dist/execution-review-composition.js';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';

test('review drive selection: both optional-model shapes preserve the frozen public projection and read-only behavior', async (t) => {
  for (const reasoningEffort of [undefined, 'high'])
    await t.test(reasoningEffort ?? 'default', async (t) => {
      const h = await nativeReviewHost(t, {
        model: {
          provider: 'contract',
          model: 'review-contract',
          maxTokens: 2048,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      });
      const expected = executionReviewCompositionRequest(h.composition).selection;
      assert.deepEqual(h.drive.grant.selection, expected);
      assert.equal(Object.isFrozen(h.drive.grant.selection), true);
      assert.throws(() => (h.drive.grant.selection.model = 'changed'), TypeError);
      const before = JSON.stringify(h.read());
      h.resetCounts();
      h.service.assertExpertReviewDriveGrant(h.drive.grant, 'send');
      assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
      assert.equal(JSON.stringify(h.read()), before);
    });
});

test('review drive selection: every use still rejects a tampered persisted composition before the Host configuration callback', async (t) => {
  for (const field of ['model', 'configurationId'])
    await t.test(field, async (t) => {
      let callbacks = 0;
      const h = await nativeReviewHost(t, {
        assertReviewConfiguration() {
          callbacks++;
        },
      });
      const record = structuredClone(h.read());
      const composition = record.nativeExecution.review.attempts[0].composition;
      if (field === 'model') composition.payload.model.model = 'unbound-model';
      else composition.configurationId = 'unbound-configuration';
      await h.domain.table('nodes').put(nodeRecordKey(record), record);
      const priorCallbacks = callbacks;
      h.resetCounts();
      assert.throws(() => h.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'), {
        code: 'review-authority-denied',
      });
      assert.equal(callbacks, priorCallbacks);
      assert.equal(h.drive.grant.signal.aborted, true);
      assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    });
});

test('review drive selection: reviewer revocation inside the action configuration callback is rechecked before returning', async (t) => {
  let armed = false,
    callbacks = 0,
    h;
  h = await nativeReviewHost(t, {
    assertReviewConfiguration() {
      if (!armed || ++callbacks !== 2) return;
      // Revoke in the action check, after the retained history check completed.
      armed = false;
      h.setWorkbench((workbench) => ({
        ...workbench,
        participants: workbench.participants.map((member) =>
          member.id === 'qa' ? { ...member, available: false } : member,
        ),
      }));
    },
  });
  h.resetCounts();
  armed = true;
  assert.throws(() => h.service.assertExpertReviewDriveGrant(h.drive.grant, 'send'), {
    code: 'review-target-changed',
  });
  assert.equal(callbacks, 2);
  assert.equal(h.drive.grant.signal.aborted, true);
  assert.equal(h.read().rounds[0].ballots.length, 0);
  assert.equal(h.read('consume').command.status, 'blocked');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});
