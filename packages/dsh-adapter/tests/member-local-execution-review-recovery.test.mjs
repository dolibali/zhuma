/** Reserved-review cleanup contracts with synthetic protocol/native ports.
 * Actual original SDK and signed HTTP proof is recorded separately. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemberLocalExecutionReview } from '../dist/member-local-execution-review.js';

for (const nextSequence of [1, 2])
  test(`member review recovery contract: absent local binding permits only the original reserved sequence (${nextSequence})`, async () => {
    const scope = { actorId: 'member', taskId: 'task', runId: 'review-run' },
      calls = [],
      view = {
        scope,
        nextSequence,
        serverTime: 1000,
        cleanup: { expiresAt: 20000 },
        resources: 'held',
        authority: 'cleanup-only',
        stopRequested: true,
        runStatus: 'requested',
      },
      run = { value: view, composition: { payload: { scope } } },
      protocol = {
        assertReadHandle: (handle) => assert.equal(handle, run),
        status: async () => view,
        reconcile: async (handle, input) => {
          assert.equal(handle, run);
          assert.deepEqual(input, { lastSequence: 0 });
          calls.push('original-reconcile');
          return run;
        },
        command: async (handle, input) => {
          assert.equal(handle, run);
          assert.deepEqual(input, {
            operation: 'cleanup',
            payload: {
              observation: {
                kind: 'drained',
                sequence: 1,
                evidence: { basis: 'absent-unadmitted' },
              },
            },
          });
          calls.push('original-cleanup');
          return { ...view, resources: 'settled', runStatus: 'cancelled' };
        },
      },
      owner = new MemberLocalExecutionReview({
        protocol,
        assertModel: () => assert.fail('Recovery cannot invoke a model'),
      });
    owner.native = {
      service: {
        retireReviewForCleanup: async (marker) => {
          assert.deepEqual(owner.reviewPorts.authorizeCleanup(marker), scope);
          calls.push('original-native-drain');
          return {
            status: 'retired',
            drain: { basis: 'absent-unadmitted', assertCurrent() {} },
          };
        },
      },
    };
    if (nextSequence === 2) {
      await assert.rejects(owner.recover(run), { code: 'review-authority-denied' });
      assert.deepEqual(calls, []);
    } else {
      const result = await owner.recover(run);
      assert.equal(result.view.remote.resources, 'settled');
      assert.equal(result.view.native, undefined);
      assert.equal(owner.read(run).phase, 'retired');
      assert.deepEqual(calls, ['original-reconcile', 'original-native-drain', 'original-cleanup']);
    }
  });
