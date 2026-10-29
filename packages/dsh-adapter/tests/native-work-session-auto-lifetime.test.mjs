/** Admission/drain contracts. Synthetic effects do not prove SDK or HTTP execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeWorkflowConsumerLifetime } from '../dist/native-work-session-auto-lifetime.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
test('automatic consumer lifetime: cold is inert and Stop fences a queued admission before its effect', async () => {
  const life = new NativeWorkflowConsumerLifetime();
  let calls = 0;
  assert.equal(life.canSwitchBackend(), true);
  await assert.rejects(
    life.run(async () => calls++),
    { code: 'cancelled' },
  );
  life.arm();
  assert.equal(life.canSwitchBackend(), false, 'an explicitly armed consumer is an obligation');
  const source = life.run(async () => calls++);
  life.fence();
  await assert.rejects(source, { code: 'cancelled' });
  assert.equal(calls, 0);
  assert.throws(() => life.arm(), { code: 'cancelled' });
  await life.close(async () => {});
  assert.equal(life.canSwitchBackend(), true);
});
test('automatic consumer lifetime: serial slot and close retain a late issued accept through its original cleanup', async () => {
  const life = new NativeWorkflowConsumerLifetime();
  const issued = Promise.withResolvers(),
    reply = Promise.withResolvers(),
    stopped = Promise.withResolvers();
  const events = [];
  let admission;
  life.arm();
  const source = life.run(async (scope) => {
    admission = scope;
    scope.assertCurrent();
    events.push('issued');
    issued.resolve();
    const handle = await reply.promise;
    assert.equal(scope.cleanupSignal.aborted, false);
    assert.equal(handle, reply);
    assert.throws(scope.assertCurrent, { code: 'cancelled' });
    events.push('original-stop');
    await stopped.promise;
    events.push('actually-drained');
  });
  await issued.promise;
  await assert.rejects(
    life.run(async () => assert.fail('second admission')),
    { code: 'capacity' },
  );
  const closing = life.close(async (signal) => {
    assert.equal(signal.aborted, false);
    events.push('owner-close');
  });
  assert.equal(admission.signal.aborted, true);
  assert.equal(admission.cleanupSignal.aborted, false);
  assert.equal(life.busy, true);
  assert.equal(life.canSwitchBackend(), false);
  reply.resolve(reply);
  await turn();
  assert.deepEqual(events, ['issued', 'original-stop']);
  assert.equal(life.busy, true, 'logical Stop did not release the source slot');
  stopped.resolve();
  await Promise.all([source, closing]);
  assert.deepEqual(events, ['issued', 'original-stop', 'actually-drained', 'owner-close']);
  assert.equal(admission.cleanupSignal.aborted, true);
  assert.equal(life.canSwitchBackend(), true);
});
test('automatic consumer lifetime: failed cleanup never becomes a successful close or cold re-arm', async () => {
  const life = new NativeWorkflowConsumerLifetime();
  life.arm();
  const closing = life.close(async () => {
    throw Error('CONTRACT_DRAIN_FAILED');
  });
  await assert.rejects(closing, /CONTRACT_DRAIN_FAILED/);
  assert.equal(
    life.close(async () => assert.fail('second owner')),
    closing,
  );
  assert.equal(life.canSwitchBackend(), false);
  assert.throws(() => life.arm(), { code: 'cancelled' });
});
