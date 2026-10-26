/** Actual pinned SDK/provider, original Cookie/Run grant; only model output is scripted. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import Loop from '@deepseek-ai/dsh-agent-loop';
import { bootRunFiles } from './zhuma-native-dispose-drain-bundle.ts';

async function setup(
  t,
  script = ['Ordinary result without completion intent.'],
  rejectDispose = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-dispose-drain-'));
  const host = await bootRunFiles(root);
  t.onTestFinished(async () => {
    try {
      await host.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const file = await host.upload('Original accepted upstream.');
  await host.submit(file, 'dispose-input');
  await host.ballot('approve', 'dispose-accept');
  const opened = await host.begin();
  t.onTestFinished(() => opened.dispose());
  const current = opened.grant;
  const native = await host.nativeSession();
  const trace = [];
  const create = host.ctx.agents.create.bind(host.ctx.agents);
  host.ctx.agents.create = async (...args) => {
    const handle = await create(...args);
    const dispose = handle.dispose.bind(handle);
    handle.dispose = async () => {
      trace.push('original-handle-dispose-enter');
      try {
        await dispose();
        if (rejectDispose) throw Error('injected-original-handle-dispose-rejection');
        trace.push('original-handle-dispose-closed');
      } catch (error) {
        trace.push('original-handle-dispose-rejected');
        throw error;
      }
    };
    return handle;
  };
  host.adapter.script.push(...script);
  await native.service.send(current, host.firstMessage());
  const binding = native.service.open(current).binding;
  const agent = host.ctx.agents.get(binding.nativeAgentId);
  const fibers = [...(host.ctx.registry.get(Loop)?.fibers ?? [])];
  assert.equal(fibers.length, 1);
  return { ...host, ...native, current, binding, agent, trace, provider: fibers[0] };
}

test('actual provider teardown: retirement joins the original disposed handle then verifies the durable writer barrier', async (t) => {
  const h = await setup(t);
  await h.agent.whenIdle();
  const id = h.binding.nativeSessionId;
  const history = await h.service.history(h.current);
  await h.provider.dispose();
  assert.equal(h.ctx.agents.get(id), undefined);
  h.issuer.assertGrant(h.current, 'send');
  assert.throws(() => h.runtime.status(id), { code: 'unavailable' });
  const trace = [];
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
  h.ctx.sessions.flush = async (...args) => {
    try {
      const value = await flush(...args);
      trace.push({ operation: 'session.flush', value });
      return value;
    } catch (error) {
      trace.push({ operation: 'session.flush', error: error.message });
      throw error;
    }
  };
  let drain;
  try {
    drain = await h.runtime.retire(id, new AbortController().signal);
  } catch (error) {
    assert.fail(JSON.stringify({ error: error.code, trace, originalAgentStatus: h.agent.status }));
  } finally {
    h.ctx.sessions.flush = flush;
  }
  assert.equal(drain.basis, 'flushed-and-closed');
  assert.deepEqual(h.trace, ['original-handle-dispose-enter', 'original-handle-dispose-closed']);
  drain.assertCurrent();
  const after = await h.service.history(h.current);
  assert.deepEqual(after.events.slice(0, history.events.length), history.events);
  assert.throws(() => h.runtime.send(id, { id: 'late', text: 'Never resurrect.' }, 'followup'), {
    code: 'unavailable',
  });
  assert.equal(h.ctx.agents.list().length, 0);
});

test('actual provider teardown: a held model read keeps the original handle and writer barrier pending', async (t) => {
  const entered = Promise.withResolvers(),
    aborted = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = await setup(t, [
    async function* (options) {
      options.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  ]);
  let retired = false,
    disposed = false;
  try {
    await entered.promise;
    const disposing = h.provider.dispose().then(() => {
      disposed = true;
    });
    await aborted.promise;
    const retiring = h.runtime
      .retire(h.binding.nativeSessionId, new AbortController().signal)
      .then((proof) => {
        retired = true;
        return proof;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(retired, false);
    assert.throws(() => h.runtime.migrationDrain(h.binding.nativeSessionId));
    release.resolve();
    await disposing;
    const proof = await retiring;
    proof.assertCurrent();
    assert.equal(retired, true);
  } finally {
    release.resolve();
  }
});

test('actual provider teardown: registry absence cannot certify a refused original persistence write barrier', async (t) => {
  const h = await setup(t);
  await h.agent.whenIdle();
  await h.provider.dispose();
  const open = h.ctx.sessionPersistence.open.bind(h.ctx.sessionPersistence);
  let barriers = 0;
  h.ctx.sessionPersistence.open = async (...args) => {
    if (args[0] === h.binding.nativeSessionId && args[1] === 'write') {
      barriers++;
      throw Error('synthetic-original-writer-barrier-failure');
    }
    return open(...args);
  };
  try {
    await assert.rejects(
      h.runtime.retire(h.binding.nativeSessionId, new AbortController().signal),
      { code: 'unavailable' },
    );
    assert.equal(barriers, 1);
    assert.equal(h.ctx.agents.get(h.binding.nativeAgentId), undefined);
    assert.throws(() => h.runtime.migrationDrain(h.binding.nativeSessionId), {
      code: 'unavailable',
    });
  } finally {
    h.ctx.sessionPersistence.open = open;
  }
});

test('actual provider teardown: an injected original handle disposal rejection stays fenced despite registry absence', async (t) => {
  const h = await setup(t, undefined, true);
  await h.agent.whenIdle();
  await h.provider.dispose();
  assert.equal(h.ctx.agents.get(h.binding.nativeAgentId), undefined);
  await assert.rejects(h.runtime.retire(h.binding.nativeSessionId, new AbortController().signal), {
    code: 'unavailable',
  });
  assert.deepEqual(h.trace, ['original-handle-dispose-enter', 'original-handle-dispose-rejected']);
  assert.throws(() => h.runtime.migrationDrain(h.binding.nativeSessionId), { code: 'unavailable' });
  await assert.rejects(h.runtime.retire(h.binding.nativeSessionId, new AbortController().signal), {
    code: 'unavailable',
  });
  assert.equal(
    h.trace.length,
    2,
    'The failed original closure stays owned; no replacement disposer is minted',
  );
  await assert.rejects(h.runtime.close(), { code: 'unavailable' });
});
