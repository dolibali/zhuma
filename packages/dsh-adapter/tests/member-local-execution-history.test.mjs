/** Read-source/SDK streams are contracts; outgoing status is actual HTTP/signing.
 * No model, Agent, persistence or backend identity proof is claimed here. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture } from './member-local-execution-protocol-fixture.mjs';
import { MemberLocalExecutionHistory } from '../dist/member-local-execution-history.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';

async function setup(t, options = {}) {
  const h = await fixture(t, options),
    protocol = await h.open();
  t.after(() => protocol.close());
  const run = await (await protocol.prepareAccept(randomUUID(), h.input)).send();
  const { backendId: _backendId, ...scope } = run.value.scope;
  const binding = {
    schemaVersion: 1,
    scope,
    nativeSessionId: 'contract-session',
    nativeAgentId: 'contract-agent',
    selection: run.value.selection,
    receipts: [],
  };
  let active = 0;
  const native = {
    service: {
      readBinding: () => structuredClone(binding),
      open: () =>
        options.detached
          ? (() => {
              throw new NativeWorkError('cancelled');
            })()
          : { binding, status: 'idle' },
      async *observe() {
        active++;
        try {
          yield { type: 'status', status: 'idle' };
          await options.late?.();
          yield { type: 'message', text: 'LATE_FRAME_MUST_NOT_ESCAPE' };
        } finally {
          active--;
        }
      },
    },
  };
  const reader = new MemberLocalExecutionHistory(native, protocol);
  t.after(() => reader.close());
  return { h, run, binding, reader, active: () => active };
}
test('history contract: fresh read metadata survives an expired old drive without asserting drain', async (t) => {
  const h = await setup(t, { detached: true });
  const opened = await h.reader.open(h.run);
  assert.equal(opened.native.binding.nativeSessionId, 'contract-session');
  assert.equal(opened.native.status, 'detached');
  assert.equal(opened.remote.resources, 'held');
});
test('history contract: original binding selection must match the private successful accept locator', async (t) => {
  const h = await setup(t);
  h.binding.selection = { ...h.binding.selection, model: 'wrong-model' };
  await assert.rejects(h.reader.open(h.run), { code: 'local-mismatch' });
});
test('history contract: at most eight sources and cancellation closes actual paused native iterators', async (t) => {
  const h = await setup(t),
    aborts = [],
    streams = [];
  for (let i = 0; i < 8; i++) {
    const abort = new AbortController(),
      stream = h.reader.observe(h.run, -1, abort.signal);
    aborts.push(abort);
    streams.push(stream);
    assert.equal((await stream.next()).done, false);
  }
  assert.equal(h.active(), 8);
  await assert.rejects(h.reader.observe(h.run).next(), { code: 'unavailable' });
  for (const abort of aborts) abort.abort();
  await h.reader.close();
  assert.equal(h.active(), 0);
  await Promise.allSettled(streams.map((stream) => stream.return()));
});
test('history contract: bounded fresh status revocation cancels and discards an uncooperative late frame', async (t) => {
  let revoked = false;
  const release = Promise.withResolvers();
  const h = await setup(t, {
    statusError: () => (revoked ? 'remote-forbidden' : undefined),
    late: () => release.promise,
  });
  t.after(() => release.resolve());
  const stream = h.reader.observe(h.run),
    first = await stream.next();
  assert.equal(first.done, false);
  revoked = true;
  const pending = stream.next();
  const deadline = Date.now() + 7000;
  while (h.h.seen.filter((v) => v.request.operation === 'status').length < 2) {
    assert(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  release.resolve();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(h.active(), 0);
});
