/** Actual patched SDK/JSONL; model chunks and Run grants are explicit contracts. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { boot, grant, message, ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const mode = process.env.ZHUMA_NATIVE_STREAM_MODE;
async function setup(t, script = [], options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-stream-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const host = await boot(root, new ScriptedAdapter(script), undefined, options);
  t.onTestFinished(() => host.close());
  return { ...host, root, current: grant() };
}

if (mode !== undefined) {
  test('official inbox remains readable across two independent processes without native admission', async () => {
    const root = process.env.ZHUMA_NATIVE_STREAM_ROOT;
    if (!root || !['write', 'read'].includes(mode))
      throw Error('Explicit process test root required');
    const host = await boot(root, new ScriptedAdapter([]));
    const current = grant();
    try {
      if (mode === 'write') {
        const received = await host.service.send(
          current,
          message('persist', '待处理的原始消息', 'queue'),
        );
        assert.equal(received.status, 'received');
        assert.equal((await host.service.stop(current)).status, 'stopped');
        await writeFile(join(root, 'expected.json'), JSON.stringify(received));
      } else {
        const expected = JSON.parse(await readFile(join(root, 'expected.json'), 'utf8'));
        assert.equal(host.service.open(current).status, 'detached');
        const snapshot = await host.service.readInbox(current);
        assert.deepEqual(
          snapshot.items.map(({ id, text, status }) => ({ id, text, status })),
          [{ id: expected.messageId, text: '待处理的原始消息', status: 'received' }],
        );
        assert.ok(snapshot.asOfSeq >= 0);
        assert.equal(host.ctx.agents.list().length, 0);
      }
      assert.equal(host.adapter.requests.length, 0);
    } finally {
      await host.close();
    }
  });
} else {
  test('official inbox distinguishes pending received input from claimed history before and after Stop/reopen', async (t) => {
    const host = await setup(t, ['adopted response']);
    const queued = await host.service.send(
      host.current,
      message('pending', '尚未采用的输入', 'queue'),
    );
    let snapshot = await host.service.readInbox(host.current);
    assert.equal(snapshot.items[0].id, queued.messageId);
    assert.equal(snapshot.items[0].text, '尚未采用的输入');
    assert.equal(snapshot.items[0].status, 'received');
    assert.equal(
      snapshot.receipts.find((item) => item.messageId === queued.messageId).status,
      'received',
    );
    assert.equal((await host.service.stop(host.current)).status, 'stopped');
    assert.equal((await host.service.readInbox(host.current)).items[0].id, queued.messageId);
    await host.close();
    const reopened = await boot(
      host.root,
      new ScriptedAdapter(['queued response', 'followup response']),
    );
    t.onTestFinished(() => reopened.close());
    snapshot = await reopened.service.readInbox(host.current);
    assert.equal(snapshot.items[0].id, queued.messageId);
    assert.equal(reopened.ctx.agents.list().length, 0, 'A cold read must not resume an Agent');
    assert.equal(reopened.adapter.requests.length, 0);
    await reopened.service.send(host.current, message('resume-explicitly', '明确开始下一轮'));
    await reopened.ctx.agents.get(snapshot.binding.nativeSessionId).whenIdle();
    const claimed = await reopened.service.readInbox(host.current);
    assert.deepEqual(claimed.items, []);
    assert.equal(
      claimed.receipts.find((item) => item.messageId === queued.messageId).status,
      'claimed',
    );
    const history = await reopened.service.history(host.current);
    assert.ok(
      history.events.some(
        (event) => event.type === 'user/message' && event.data.id === queued.messageId,
      ),
    );
    const replay = await reopened.service.send(
      host.current,
      message('pending', '尚未采用的输入', 'queue'),
    );
    assert.equal(replay.status, 'claimed');
    assert.equal(
      reopened.adapter.requests.length,
      2,
      'Each queued next-turn input owns its real turn',
    );
  });

  test('actual SDK late observer restores the current visible prefix and cuts queued overlap without replaying native frames', async (t) => {
    const entered = Promise.withResolvers(),
      suffix = Promise.withResolvers(),
      suffixSent = Promise.withResolvers(),
      tail = Promise.withResolvers(),
      tailSent = Promise.withResolvers();
    let modelSignal;
    const host = await setup(t, [
      async function* (options) {
        modelSignal = options.signal;
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'private-late-reasoning' };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: 'private-late-reasoning' },
        };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: 'visible-prefix' };
        entered.resolve();
        await suffix.promise;
        yield { type: 'text-delta', index: 1, text: '-overlap' };
        suffixSent.resolve();
        await tail.promise;
        yield { type: 'text-delta', index: 1, text: '-live' };
        tailSent.resolve();
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) return reject(Error('script stopped'));
          options.signal.addEventListener('abort', () => reject(Error('script stopped')), {
            once: true,
          });
        });
      },
    ]);
    t.onTestFinished(() => {
      suffix.resolve();
      tail.resolve();
    });
    await host.service.send(host.current, message('late-observer', 'synthetic request'));
    await entered.promise;
    const readGrant = grant();
    const binding = host.service.open(readGrant).binding;
    const agent = host.ctx.agents.get(binding.nativeSessionId);
    const originalHistory = host.runtime.history.bind(host.runtime);
    async function attach(overlap = false) {
      const historyRead = Promise.withResolvers();
      host.runtime.history = async (...args) => {
        const rows = await originalHistory(...args);
        if (overlap) {
          suffix.resolve();
          await suffixSent.promise;
          await setImmediate();
        }
        historyRead.resolve();
        return rows;
      };
      const ui = new AbortController(),
        frames = [],
        live = Promise.withResolvers();
      t.onTestFinished(() => ui.abort());
      const observing = (async () => {
        for await (const frame of host.service.observe(readGrant, -1, ui.signal)) {
          frames.push(frame);
          if (
            frame.type === 'assistant-stream' &&
            frame.frame.type === 'chunk' &&
            frame.frame.text === '-live'
          )
            live.resolve();
        }
      })();
      await historyRead.promise;
      await setImmediate();
      await setImmediate();
      const opening = frames.find(
        (f) => f.type === 'assistant-stream' && f.frame.type === 'snapshot',
      );
      assert.ok(opening, 'late observer requires an explicit current-attempt opening snapshot');
      return { ui, frames, live, observing, opening: opening.frame };
    }
    const first = await attach();
    assert.equal(first.opening.activeAttempt.text, 'visible-prefix');
    assert.equal(agent.status, 'running');
    assert.equal(
      (await originalHistory(binding.nativeSessionId, -1, 100, host.current.signal)).some(
        (e) => e.type === 'assistant/message',
      ),
      false,
    );
    first.ui.abort();
    await first.observing;
    assert.equal(agent.status, 'running');
    assert.equal(modelSignal.aborted, false);
    const second = await attach(true);
    assert.equal(second.opening.activeAttempt.text, 'visible-prefix-overlap');
    assert.equal(
      second.frames.some((f) => f.type === 'assistant-stream' && f.frame.type === 'chunk'),
      false,
      'queued prefix already represented by snapshot cannot duplicate',
    );
    tail.resolve();
    await tailSent.promise;
    await second.live.promise;
    const live = second.frames.filter(
      (f) => f.type === 'assistant-stream' && f.frame.type === 'chunk',
    );
    assert.equal(live.length, 1);
    assert.equal(live[0].frame.text, '-live');
    assert.equal(live[0].frame.index, second.opening.activeAttempt.nextIndex);
    assert.ok(live[0].frame.revision > second.opening.revision);
    assert.equal((await host.service.stop(host.current)).status, 'stopped');
    await agent.whenIdle();
    await setImmediate();
    assert.equal(modelSignal.aborted, true);
    const final = second.frames.find((f) => f.type === 'message' && f.role === 'assistant');
    const end = second.frames.find((f) => f.type === 'assistant-stream' && f.frame.type === 'end');
    assert.equal(final.text, 'visible-prefix-overlap-live');
    assert.equal(final.interrupted, true);
    assert.equal(end.frame.outcome.messageKey, final.messageKey);
    assert.equal(end.frame.outcome.seq, final.seq);
    second.ui.abort();
    await second.observing;
    const settled = await attach();
    assert.equal(settled.opening.activeAttempt, undefined);
    settled.ui.abort();
    await settled.observing;
    assert.equal(
      JSON.stringify([first.frames, second.frames, settled.frames]).includes('private-late'),
      false,
    );
    assert.equal(host.adapter.requests.length, 1);
    readGrant.revoke();
    await assert.rejects(host.service.observe(readGrant).next(), { code: 'cancelled' });
  });

  test('actual SDK partial text is observable before completion and settles into one keyed durable message', async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const host = await setup(t, [
      'first',
      async function* () {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'private-reasoning-marker' };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: 'private-reasoning-marker' },
        };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: '公开前缀' };
        entered.resolve();
        await release.promise;
        yield { type: 'text-delta', index: 1, text: '和后续正文' };
        yield { type: 'block-end', index: 1, block: { type: 'text', text: '公开前缀和后续正文' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    ]);
    await host.service.send(host.current, message('first', 'first'));
    const binding = host.service.open(host.current).binding;
    const agent = host.ctx.agents.get(binding.nativeSessionId);
    await agent.whenIdle();
    const history = await host.service.history(host.current);
    const subscribed = Promise.withResolvers(),
      partial = Promise.withResolvers();
    const nativeHistory = host.runtime.history.bind(host.runtime);
    host.runtime.history = (...args) => {
      subscribed.resolve();
      return nativeHistory(...args);
    };
    const ui = new AbortController();
    t.onTestFinished(() => ui.abort());
    const frames = [];
    const observing = (async () => {
      for await (const frame of host.service.observe(
        host.current,
        history.events.at(-1).seq,
        ui.signal,
      )) {
        frames.push(frame);
        if (frame.type === 'assistant-stream' && frame.frame.text === '公开前缀') partial.resolve();
        if (frame.type === 'assistant-stream' && frame.frame.type === 'end') ui.abort();
      }
    })();
    await subscribed.promise;
    await host.service.send(host.current, message('second', 'second'));
    await entered.promise;
    await partial.promise;
    assert.equal(agent.status, 'running');
    assert.equal(
      frames.some((frame) => frame.type === 'message' && frame.role === 'assistant'),
      false,
    );
    assert.equal(JSON.stringify(frames).includes('private-reasoning-marker'), false);
    release.resolve();
    await agent.whenIdle();
    await observing;
    const end = frames.find(
      (frame) => frame.type === 'assistant-stream' && frame.frame.type === 'end',
    );
    assert.equal(end.frame.outcome.kind, 'committed');
    const final = frames.filter((frame) => frame.type === 'message' && frame.role === 'assistant');
    assert.equal(final.length, 1);
    assert.equal(final[0].text, '公开前缀和后续正文');
    assert.equal(final[0].messageKey, end.frame.outcome.messageKey);
    assert.equal(final[0].seq, end.frame.outcome.seq);
    assert.ok(
      frames.every(
        (frame) =>
          frame.scope.runId === host.current.scope.runId &&
          frame.nativeSessionId === binding.nativeSessionId,
      ),
    );
    assert.equal(JSON.stringify(frames).includes('private-reasoning-marker'), false);
    assert.equal(host.adapter.requests.length, 2);
  });

  test('readInbox rejects an old generation and a revoked grant without native create/resume', async (t) => {
    const host = await setup(t);
    await host.service.send(host.current, message('pending', 'private queued input', 'queue'));
    await host.runtime.disconnect(host.service.open(host.current).binding.nativeSessionId);
    const next = grant({ generation: host.current.scope.generation + 1 });
    await assert.rejects(host.service.readInbox(next), { code: 'scope-mismatch' });
    host.current.revoke();
    await assert.rejects(host.service.readInbox(host.current), { code: 'cancelled' });
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
  });

  test('missing official inbox projection is unavailable, never an empty success or a resumed Agent', async (t) => {
    const host = await setup(t);
    await host.service.send(host.current, message('pending', 'private queued input', 'queue'));
    const id = host.service.open(host.current).binding.nativeSessionId;
    await host.runtime.disconnect(id);
    const restore = host.ctx.sessionProjections.restore.bind(host.ctx.sessionProjections);
    host.ctx.sessionProjections.restore = (...args) => {
      const actual = restore(...args);
      return { ...actual, snapshot: { ...actual.snapshot, values: {} } };
    };
    await assert.rejects(host.service.readInbox(host.current), { code: 'unavailable' });
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
  });

  test('inbox cancellation refuses a late result while shutdown owns the real native reader close', async (t) => {
    const host = await setup(t);
    await host.service.send(host.current, message('pending', 'late private input', 'queue'));
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    let actualClosed = false;
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        actualClosed = true;
      };
      entered.resolve();
      await release.promise;
      return handle;
    };
    const ui = new AbortController();
    const reading = host.service.readInbox(host.current, ui.signal);
    await entered.promise;
    ui.abort();
    await assert.rejects(reading, { code: 'cancelled' });
    let closed = false;
    const closing = host.runtime.close().then(() => {
      closed = true;
    });
    await setImmediate();
    assert.equal(closed, false);
    assert.equal(actualClosed, false);
    release.resolve();
    await closing;
    assert.equal(actualClosed, true);
    assert.equal(host.adapter.requests.length, 0);
  });

  test('observer abort removes native listeners even while the consumer is paused on a yield', async (t) => {
    const host = await setup(t, ['body']);
    await host.service.send(host.current, message('one', 'user body'));
    await host.ctx.agents.get(host.service.open(host.current).binding.nativeSessionId).whenIdle();
    const originalOn = host.ctx.on.bind(host.ctx),
      active = new Set();
    const watched = new Set(['session/event', 'agent/assistant-stream', 'agent/status']);
    host.ctx.on = (name, ...args) => {
      const stop = originalOn(name, ...args);
      if (!watched.has(name)) return stop;
      const token = {};
      active.add(token);
      return () => {
        active.delete(token);
        stop();
      };
    };
    const ui = new AbortController(),
      iterator = host.service.observe(host.current, -1, ui.signal);
    try {
      assert.equal((await iterator.next()).value.type, 'message');
      assert.equal(active.size, 3);
      ui.abort();
      assert.equal(active.size, 0);
      assert.equal(host.current.signal.aborted, false);
    } finally {
      ui.abort();
      await iterator.return();
      host.ctx.on = originalOn;
    }
    assert.equal(host.adapter.requests.length, 1);
  });

  test('a different Agent object with the same session ID cannot inject public attempt frames', async (t) => {
    const host = await setup(t, ['first', 'second']);
    await host.service.send(host.current, message('first', 'first'));
    const binding = host.service.open(host.current).binding;
    const agent = host.ctx.agents.get(binding.nativeSessionId);
    await agent.whenIdle();
    const history = await host.service.history(host.current);
    const subscribed = Promise.withResolvers();
    const nativeHistory = host.runtime.history.bind(host.runtime);
    host.runtime.history = (...args) => {
      subscribed.resolve();
      return nativeHistory(...args);
    };
    const frames = [],
      ui = new AbortController();
    t.onTestFinished(() => ui.abort());
    const observing = (async () => {
      for await (const frame of host.service.observe(
        host.current,
        history.events.at(-1).seq,
        ui.signal,
      )) {
        frames.push(frame);
        if (
          frame.type === 'gap' ||
          (frame.type === 'assistant-stream' && frame.frame.type === 'end')
        )
          ui.abort();
      }
    })();
    await subscribed.promise;
    const wrong = { id: binding.nativeSessionId };
    host.ctx.emit('agent/assistant-stream', {
      agent: wrong,
      frame: {
        type: 'start',
        attemptId: 'foreign-attempt',
        revision: 9999,
        turn: 1,
        step: 1,
      },
    });
    host.ctx.emit('agent/assistant-stream', {
      agent: wrong,
      frame: {
        type: 'chunk',
        attemptId: 'foreign-attempt',
        revision: 10000,
        index: 0,
        time: Date.now(),
        chunk: { type: 'text-delta', index: 0, text: 'foreign-private-marker' },
      },
    });
    await host.service.send(host.current, message('second', 'second'));
    await agent.whenIdle();
    await observing;
    assert.equal(JSON.stringify(frames).includes('foreign-'), false);
    assert.equal(
      frames.some((frame) => frame.type === 'gap'),
      false,
    );
    assert.ok(frames.some((frame) => frame.type === 'message' && frame.text === 'second'));
  });

  test.each(['revoke', 'deadline'])(
    'cold inbox %s during an actual read cannot expose its late body',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'zhuma-native-inbox-fault-'));
      const host = await boot(root, new ScriptedAdapter([]), undefined, { readTimeoutMs: 50 });
      const current = grant();
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      try {
        await host.service.send(current, message('pending', 'late private body', 'queue'));
        await host.runtime.disconnect(host.service.open(current).binding.nativeSessionId);
        const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
        host.ctx.sessionPersistence.open = async (...args) => {
          const handle = await open(...args);
          const read = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            const result = await read(...readArgs);
            entered.resolve();
            await release.promise;
            return result;
          };
          return handle;
        };
        const reading = host.service.readInbox(current).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await entered.promise;
        if (mode === 'revoke') {
          current.deny();
          release.resolve();
        }
        const outcome = await reading;
        assert.equal(outcome.value, undefined);
        if (mode === 'deadline') assert.equal(outcome.error.code, 'read-timeout');
        else assert.match(String(outcome.error), /currentness-rejected/);
        assert.equal(host.ctx.agents.list().length, 0);
        assert.equal(host.adapter.requests.length, 0);
      } finally {
        release.resolve();
        await host.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('cancelled inbox waits retain all eight native reader slots until their real handles close', async (t) => {
    const host = await setup(t);
    await host.service.send(host.current, message('queued', 'pending body', 'queue'));
    await host.runtime.disconnect(host.service.open(host.current).binding.nativeSessionId);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      drained = Promise.withResolvers();
    t.onTestFinished(() => release.resolve());
    const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    let reads = 0,
      closes = 0;
    host.ctx.sessionPersistence.open = async (...args) => {
      const handle = await open(...args),
        read = handle.read.bind(handle),
        close = handle.close.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (++reads === 8) entered.resolve();
        await release.promise;
        return result;
      };
      handle.close = async () => {
        await close();
        if (++closes === 8) drained.resolve();
      };
      return handle;
    };
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      host.service.readInbox(host.current, controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    try {
      await entered.promise;
      await assert.rejects(host.service.readInbox(host.current), { code: 'capacity' });
      controllers.forEach((controller) => controller.abort());
      assert.ok(
        (await Promise.all(pending)).every((outcome) => outcome.error?.code === 'cancelled'),
      );
      await assert.rejects(host.service.readInbox(host.current), { code: 'capacity' });
      release.resolve();
      await drained.promise;
      await setImmediate();
      assert.equal((await host.service.readInbox(host.current)).items[0].text, 'pending body');
      assert.equal(host.ctx.agents.list().length, 0);
      assert.equal(host.adapter.requests.length, 0);
    } finally {
      controllers.forEach((controller) => controller.abort());
      release.resolve();
      await Promise.all(pending);
    }
  });

  test('sixteen paused observers are bounded and an abort releases a slot without resuming the consumer', async (t) => {
    const host = await setup(t, ['body']);
    await host.service.send(host.current, message('one', 'user body'));
    await host.ctx.agents.get(host.service.open(host.current).binding.nativeSessionId).whenIdle();
    const observers = [];
    const attach = async () => {
      const controller = new AbortController();
      const iterator = host.service.observe(host.current, -1, controller.signal);
      observers.push({ controller, iterator });
      assert.equal((await iterator.next()).value.type, 'message');
    };
    try {
      for (let index = 0; index < 16; index++) await attach();
      await assert.rejects(host.service.observe(host.current).next(), { code: 'capacity' });
      observers[0].controller.abort();
      await attach();
      assert.equal(host.adapter.requests.length, 1);
    } finally {
      observers.forEach(({ controller }) => controller.abort());
      await Promise.all(observers.map(({ iterator }) => iterator.return()));
    }
  });

  test('a fresh read grant can observe committed history after the original drive permission ends', async (t) => {
    const host = await setup(t, ['committed body']);
    await host.service.send(host.current, message('one', 'user body'));
    const binding = host.service.open(host.current).binding;
    await host.ctx.agents.get(binding.nativeSessionId).whenIdle();
    host.current.deny();
    const read = grant(),
      ui = new AbortController();
    const iterator = host.service.observe(read, -1, ui.signal);
    try {
      const first = await iterator.next();
      assert.equal(first.value.type, 'message');
      assert.equal(first.value.text, 'user body');
      assert.equal(first.value.scope.runId, read.scope.runId);
      assert.equal(host.adapter.requests.length, 1);
    } finally {
      ui.abort();
      await iterator.return();
    }
  });
}
