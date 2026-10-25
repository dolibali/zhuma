/** Real DSH sessions/checkpoints plus explicitly injected native I/O delays/failures. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { boot, grant, message, ScriptedAdapter } from './zhuma-native-work-bundle.ts';

async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-read-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const host = await boot(root, new ScriptedAdapter(['native response']), undefined, options);
  t.onTestFinished(() => host.close());
  const current = grant();
  await host.service.send(current, message('one', 'synthetic native history'));
  const agent = host.ctx.agents.get(host.service.open(current).binding.nativeSessionId);
  await agent.whenIdle();
  return { ...host, current, agent };
}

async function promptCancellation(promise) {
  let timer;
  try {
    const outcome = await Promise.race([
      promise.then(
        () => 'resolved',
        (error) => error.code,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('still-waiting'), 250);
      }),
    ]);
    assert.equal(outcome, 'cancelled');
  } finally {
    clearTimeout(timer);
  }
}

test(
  'native read: initial follow cancellation releases all three listeners before a held flush completes',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const removeFlush = host.ctx.on(
      'session/flush',
      async () => {
        entered.resolve();
        await release.promise;
      },
      { global: true },
    );
    const originalOn = host.ctx.on.bind(host.ctx);
    const watched = new Set(['session/event', 'agent/assistant-stream', 'agent/status']);
    const active = new Set();
    host.ctx.on = (name, ...args) => {
      const remove = originalOn(name, ...args);
      if (!watched.has(name)) return remove;
      const token = {};
      active.add(token);
      return () => {
        active.delete(token);
        return remove();
      };
    };
    const ui = new AbortController();
    const iterator = host.service.follow(host.current, -1, ui.signal);
    const next = iterator.next();
    try {
      await entered.promise;
      assert.equal(active.size, 3);
      ui.abort();
      await promptCancellation(next);
      assert.equal(active.size, 0);
      assert.equal(host.current.signal.aborted, false);
      assert.equal(host.agent.status, 'idle');
    } finally {
      release.resolve();
      removeFlush();
      host.ctx.on = originalOn;
      await next.catch(() => undefined);
      await iterator.return();
    }
  },
);

test(
  'native read fault injection: a late open result is closed without reading or delivering its body',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      closed = Promise.withResolvers();
    const originalOpen = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    let lateHandle,
      reads = 0;
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] !== 'read') return handle;
      lateHandle = handle;
      const nativeClose = handle.close.bind(handle),
        nativeRead = handle.read.bind(handle);
      handle.read = (...readArgs) => {
        reads++;
        return nativeRead(...readArgs);
      };
      handle.close = async () => {
        await nativeClose();
        closed.resolve();
      };
      entered.resolve();
      await release.promise;
      return handle;
    };
    const ui = new AbortController();
    const reading = host.service.history(host.current, -1, 10, ui.signal);
    try {
      await entered.promise;
      ui.abort();
      await promptCancellation(reading);
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
    }
    await closed.promise;
    host.ctx.sessionPersistence.open = originalOpen;
    assert.equal(reads, 0);
    await assert.rejects(lateHandle.read(), { name: 'SessionHandleClosedError' });
    assert.equal(host.current.signal.aborted, false);
    assert.equal(host.adapter.requests.length, 1);
  },
);

test(
  'native read fault injection: late open rejection is consumed after caller cancellation',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      rejected = Promise.withResolvers();
    const originalOpen = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await originalOpen(...args);
      await handle.close();
      entered.resolve();
      await release.promise;
      rejected.resolve();
      throw Error('synthetic late read-open failure');
    };
    const ui = new AbortController();
    const reading = host.service.history(host.current, -1, 10, ui.signal);
    try {
      await entered.promise;
      ui.abort();
      await promptCancellation(reading);
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
    }
    await rejected.promise;
    await setImmediate();
    host.ctx.sessionPersistence.open = originalOpen;
    // Node's test runner also fails this test on an unhandled late rejection.
    assert.equal(host.agent.status, 'idle');
    assert.equal(host.current.signal.aborted, false);
  },
);

test(
  'native read fault injection: cancellation while close is held suppresses an already-read result',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      closed = Promise.withResolvers();
    const originalOpen = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await originalOpen(...args);
      const nativeClose = handle.close.bind(handle);
      handle.close = async () => {
        entered.resolve();
        await release.promise;
        await nativeClose();
        closed.resolve();
      };
      return handle;
    };
    const ui = new AbortController();
    const reading = host.service.history(host.current, -1, 10, ui.signal);
    try {
      await entered.promise;
      ui.abort();
      await promptCancellation(reading);
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
    }
    await closed.promise;
    host.ctx.sessionPersistence.open = originalOpen;
    assert.equal(host.agent.status, 'idle');
  },
);

test(
  'native read: a held checkpoint reaches its declared page deadline without fabricating a stop',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t, { readTimeoutMs: 50 });
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const remove = host.ctx.on(
      'session/flush',
      async () => {
        entered.resolve();
        await release.promise;
      },
      { global: true },
    );
    const reading = host.service.history(host.current);
    let timer;
    try {
      await entered.promise;
      const result = await Promise.race([
        reading.then(
          () => 'resolved',
          (error) => error.code,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('still-waiting'), 250);
        }),
      ]);
      assert.equal(result, 'read-timeout');
      assert.equal(host.current.signal.aborted, false);
      assert.equal(host.agent.status, 'idle');
      assert.equal(host.adapter.requests.length, 1);
    } finally {
      clearTimeout(timer);
      release.resolve();
      remove();
      await reading.catch(() => undefined);
    }
  },
);

test(
  'native read: cancellation before I/O starts no checkpoint; cancellation after success changes no Run fact',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    let checkpoints = 0;
    const remove = host.ctx.on(
      'session/flush',
      () => {
        checkpoints++;
      },
      { global: true },
    );
    try {
      const before = new AbortController();
      before.abort();
      await assert.rejects(host.service.history(host.current, -1, 10, before.signal), {
        code: 'cancelled',
      });
      assert.equal(checkpoints, 0);
      const after = new AbortController();
      const history = await host.service.history(host.current, -1, 10, after.signal);
      after.abort();
      assert.ok(history.events.length > 0);
      assert.equal(host.current.signal.aborted, false);
      assert.equal(host.agent.status, 'idle');
      assert.equal(host.adapter.requests.length, 1);
    } finally {
      remove();
    }
  },
);
