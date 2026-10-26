import assert from 'node:assert/strict';
import test from 'node:test';
import { hostRunStream } from '../dist/host-run-stream.js';

// Transport backpressure/lifetime contracts, not real member or native authorization.
const options = (observe) => ({
  rpcId: 'rpc',
  signal: new AbortController().signal,
  observe,
  failure: () => ({ ok: false, error: { code: 'unavailable' } }),
});
test(
  'Host stream contract: body cancellation drains a blocked read',
  { timeout: 2000 },
  async () => {
    let released = false;
    const output = hostRunStream(
      options(async (_sink, signal) => {
        try {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        } finally {
          released = true;
        }
      }),
    );
    await output.response.body.cancel();
    await output.drained;
    assert.equal(released, true);
  },
);
test(
  'Host stream contract: backpressure holds one frame and revocation discards its unsent bytes',
  { timeout: 2000 },
  async () => {
    const authority = new AbortController(),
      entered = Promise.withResolvers();
    let completed = false;
    const output = hostRunStream(
      options(async (sink) => {
        entered.resolve();
        await sink({ type: 'status', status: 'running' }, authority.signal);
        completed = true;
      }),
    );
    await entered.promise;
    assert.equal(completed, false);
    authority.abort();
    await output.drained;
    await assert.rejects(output.response.body.getReader().read(), { name: 'AbortError' });
    assert.equal(completed, false);
  },
);
test(
  'Host stream contract: incremental envelopes retain RPC identity; private exception text is redacted',
  { timeout: 2000 },
  async () => {
    const output = hostRunStream(
      options(async (sink, signal) => {
        await sink({ type: 'status', status: 'idle' }, signal);
        throw new Error('PRIVATE_REASONING_OR_PATH');
      }),
    );
    const body = await output.response.text();
    await output.drained;
    const rows = body.trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].type, 'server-frame');
    assert.equal(rows[0].rpcId, 'rpc');
    assert.equal(rows[1].result.error.code, 'unavailable');
    assert.equal(body.includes('PRIVATE'), false);
  },
);
