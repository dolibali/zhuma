import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boot,
  grant,
  message,
  selection,
  ScriptedAdapter,
  allHistory,
  response,
} from './zhuma-native-work-bundle.ts';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-contract-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t, script = [], compose, runtimeOptions) {
  const root = await home(t);
  const host = await boot(root, new ScriptedAdapter(script), compose, runtimeOptions);
  t.onTestFinished(() => host.close());
  return { ...host, root };
}
function nativeAgent(host, current) {
  return host.ctx.agents.get(host.service.open(current).binding.nativeSessionId);
}
function deferred() {
  return Promise.withResolvers();
}

test(
  'real DSH: one stable native session, streamed multi-turn, durable history and duplicate start',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t, ['first native response', 'second native response']);
    const current = grant();
    const streams = [];
    const stopStream = host.ctx.on('agent/assistant-stream', ({ frame }) => streams.push(frame), {
      global: true,
    });
    t.onTestFinished(stopStream);
    assert.equal(host.service.open(current), undefined);
    assert.equal(host.ctx.agents.list().length, 0);
    const first = await host.service.send(current, message('request-1', 'first request'));
    const binding = host.service.open(current).binding;
    await nativeAgent(host, current).whenIdle();
    const repeated = await host.service.send(current, message('request-1', 'first request'));
    assert.equal(repeated.messageId, first.messageId);
    assert.equal(repeated.status, 'claimed');
    assert.equal(host.adapter.requests.length, 1);
    assert.equal(host.ctx.agents.list().length, 1);
    await host.service.send(current, message('request-2', 'second request'));
    await nativeAgent(host, current).whenIdle();
    assert.equal(host.service.open(current).binding.nativeSessionId, binding.nativeSessionId);
    assert.equal(host.adapter.requests.length, 2);
    assert.ok(streams.some((frame) => frame.type === 'chunk' && frame.chunk.type === 'text-delta'));
    assert.ok(streams.some((frame) => frame.type === 'end' && frame.outcome.kind === 'committed'));
    const events = await allHistory(host.service, current);
    assert.deepEqual(
      events
        .filter((event) => event.type === 'user/message' && event.data.source.kind === 'user')
        .map((event) => event.data.content[0].text),
      ['first request', 'second request'],
    );
    assert.equal(events.filter((event) => event.type === 'turn/end').length, 2);
    assert.ok(events.some((event) => event.type === 'assistant/message'));
    assert.equal(JSON.stringify(binding).includes('first request'), false);
    assert.equal(
      (host.adapter.requests[0].tools ?? []).length,
      0,
      'scoped tool policy denies defaults',
    );
    assert.ok(JSON.stringify(host.adapter.requests[0].messages).includes('accepted-v1'));
    assert.equal(JSON.stringify(host.adapter.requests[0]).includes('unrelated-file-body'), false);
    await assert.rejects(host.service.send(current, message('request-1', 'different request')), {
      code: 'idempotency-mismatch',
    });
  },
);

test(
  'real DSH: stopped first turn retains queued input while alive, idle queue does not wake',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred();
    const host = await setup(t, [
      async function* (options) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'partial' };
        entered.resolve();
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) return reject(Error('contract cancellation'));
          options.signal.addEventListener('abort', () => reject(Error('contract cancellation')), {
            once: true,
          });
        });
      },
    ]);
    const current = grant();
    await host.service.send(current, message('start', 'run until stopped'));
    await entered.promise;
    const queued = await host.service.send(current, message('queue', 'next turn only', 'queue'));
    const stopped = await host.service.stop(current);
    assert.equal(stopped.status, 'stopped');
    assert.equal(nativeAgent(host, current).status, 'idle');
    assert.equal(host.adapter.requests.length, 1);
    assert.ok(host.service.queue(current).items.some((item) => item.id === queued.messageId));
    await host.service.send(current, message('idle-queue', 'parked while idle', 'queue'));
    assert.equal(nativeAgent(host, current).status, 'idle');
    assert.equal(host.adapter.requests.length, 1);
    const history = await allHistory(host.service, current);
    assert.ok(
      history.some((event) => event.type === 'turn/end' && event.data.reason.kind === 'aborted'),
    );
    assert.equal(
      history.some((event) => event.type === 'user/message' && event.data.id === queued.messageId),
      false,
    );
  },
);

test(
  'real DSH: queue edit/reorder/remove uses native pending facts and rejects claimed items',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t);
    const current = grant();
    const a = await host.service.send(current, message('a', 'first queued', 'queue'));
    const b = await host.service.send(current, message('b', 'second queued', 'queue'));
    await host.service.updateQueue(current, {
      kind: 'edit',
      messageId: a.messageId,
      text: 'edited',
    });
    await host.service.updateQueue(current, {
      kind: 'reorder',
      messageIds: [b.messageId, a.messageId],
    });
    assert.deepEqual(
      host.service.queue(current).items.map((item) => item.text),
      ['second queued', 'edited'],
    );
    await host.service.updateQueue(current, { kind: 'remove', messageId: b.messageId });
    assert.deepEqual(
      host.service.queue(current).items.map((item) => item.text),
      ['edited'],
    );
    await assert.rejects(
      host.service.updateQueue(current, { kind: 'reorder', messageIds: ['not-pending'] }),
      { code: 'not-pending' },
    );
    await assert.rejects(
      host.service.updateQueue(current, { kind: 'remove', messageId: 'absent' }),
      { code: 'not-pending' },
    );
    assert.equal(host.adapter.requests.length, 0);
  },
);

test(
  'real DSH: native next-turn is consumed after current turn; Steer goes to the next step',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    const host = await setup(t, [
      async (options) => {
        entered.resolve();
        await release.promise;
        return response('initial');
      },
      'steered',
      'queued',
    ]);
    const current = grant();
    await host.service.send(current, message('start', 'start'));
    await entered.promise;
    const steer = await host.service.send(current, message('steer', 'new constraint', 'steer'));
    const queue = await host.service.send(current, message('queue', 'next turn', 'queue'));
    release.resolve();
    await nativeAgent(host, current).whenIdle();
    const events = await allHistory(host.service, current);
    const user = events.filter((event) => event.type === 'user/message');
    assert.ok(user.some((event) => event.data.id === steer.messageId));
    assert.ok(user.some((event) => event.data.id === queue.messageId));
    assert.equal(events.filter((event) => event.type === 'turn/start').length, 2);
    assert.equal(host.adapter.requests.length, 3);
  },
);

test(
  'real DSH: authority revocation cancels native activity and blocks history, sends and late stream',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred();
    const host = await setup(t, [
      async function* (options) {
        entered.resolve();
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) return reject(Error('contract cancellation'));
          options.signal.addEventListener('abort', () => reject(Error('contract cancellation')), {
            once: true,
          });
        });
      },
    ]);
    const current = grant();
    await host.service.send(current, message('start', 'run'));
    await entered.promise;
    const agent = nativeAgent(host, current);
    current.revoke();
    await agent.whenIdle();
    assert.equal(agent.status, 'idle');
    await assert.rejects(host.service.history(current), { code: 'cancelled' });
    assert.throws(() => host.service.open(current), { code: 'cancelled' });
    assert.throws(() => host.service.send(current, message('later', 'late')), {
      code: 'cancelled',
    });
  },
);

test(
  'real DSH: cold same-disk navigation reads native history without creating or waking an agent',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    const current = grant();
    const host = await boot(root, new ScriptedAdapter(['persisted']));
    let reopened;
    try {
      await host.service.send(current, message('one', 'durable request'));
      await nativeAgent(host, current).whenIdle();
      const nativeId = host.service.open(current).binding.nativeSessionId;
      await host.close();
      reopened = await boot(root, new ScriptedAdapter(['continued']));
      assert.equal(reopened.service.open(current).binding.nativeSessionId, nativeId);
      assert.equal(reopened.service.open(current).status, 'detached');
      const history = await allHistory(reopened.service, current);
      assert.ok(
        history.some(
          (event) =>
            event.type === 'user/message' && event.data.content[0].text === 'durable request',
        ),
      );
      assert.equal(reopened.ctx.agents.list().length, 0);
      assert.equal(reopened.adapter.requests.length, 0);
      await reopened.service.send(current, message('two', 'continue explicitly'));
      await nativeAgent(reopened, current).whenIdle();
      assert.equal(reopened.ctx.agents.list().length, 1);
      assert.equal(reopened.adapter.requests.length, 1);
      assert.equal(reopened.service.open(current).binding.nativeSessionId, nativeId);
    } finally {
      await reopened?.close();
      await host.close();
    }
  },
);

for (const field of ['runId', 'generation', 'segmentId'])
  test(`scope gate rejects changed ${field} before native work`, async (t) => {
    const host = await setup(t);
    const current = grant();
    await host.service.send(current, message('queue', 'parked', 'queue'));
    const changed = grant({ [field]: field === 'generation' ? 2 : 'other' });
    assert.throws(() => host.service.open(changed), { code: 'scope-mismatch' });
    await assert.rejects(host.service.send(changed, message('different', 'forbidden')), {
      code: 'scope-mismatch',
    });
    assert.equal(host.adapter.requests.length, 0);
  });

test(
  'scoped unpublished setup rechecks revoked authority after awaits and rolls back native publication',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    const host = await setup(t, [], async () => {
      entered.resolve();
      await release.promise;
      return { context: 'task', toolAllowlist: [] };
    });
    const current = grant();
    const result = host.service.send(current, message('start', 'not published'));
    await entered.promise;
    current.revoke();
    release.resolve();
    await assert.rejects(result);
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
  },
);

test(
  'real DSH: live follow emits native frames; UI stream cancellation does not stop the Agent',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t, ['first', 'second']);
    const current = grant();
    await host.service.send(current, message('first', 'first'));
    await nativeAgent(host, current).whenIdle();
    const history = await allHistory(host.service, current);
    const subscribed = deferred();
    const nativeHistory = host.runtime.history.bind(host.runtime);
    host.runtime.history = async (...args) => {
      subscribed.resolve();
      return nativeHistory(...args);
    };
    const ui = new AbortController();
    const frames = [];
    const following = (async () => {
      for await (const frame of host.service.follow(current, history.at(-1).seq, ui.signal)) {
        frames.push(frame);
        if (frame.type === 'assistant-stream' && frame.frame.type === 'end') ui.abort();
      }
    })();
    await subscribed.promise;
    await host.service.send(current, message('second', 'second'));
    await nativeAgent(host, current).whenIdle();
    await following;
    assert.ok(
      frames.some((frame) => frame.type === 'assistant-stream' && frame.frame.type === 'chunk'),
    );
    assert.ok(frames.every((frame) => frame.scope.runId === current.scope.runId));
    assert.equal(current.signal.aborted, false);
    assert.equal(nativeAgent(host, current).status, 'idle');
    assert.equal(host.ctx.agents.list().length, 1);
  },
);

test(
  'real DSH: slow live follower is bounded and receives a recoverable durable cursor gap',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t, [
      async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (let index = 0; index < 200; index++) yield { type: 'text-delta', index: 0, text: 'x' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(200) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
      'explicit followup',
    ]);
    const current = grant();
    await host.service.send(current, message('parked', 'parked', 'queue'));
    const ui = new AbortController();
    const iterator = host.service.follow(current, -1, ui.signal);
    assert.equal((await iterator.next()).value.type, 'event');
    await host.service.send(current, message('start', 'start explicitly'));
    await nativeAgent(host, current).whenIdle();
    const frames = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      frames.push(next.value);
      if (next.value.type === 'gap') break;
    }
    ui.abort();
    await iterator.return();
    assert.ok(frames.some((frame) => frame.type === 'gap' && Number.isSafeInteger(frame.after)));
    assert.ok(
      (await allHistory(host.service, current)).some((event) => event.type === 'assistant/message'),
    );
  },
);

test(
  'real DSH: uncooperative native work returns pending, never a fabricated stop receipt',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    const host = await setup(t, [
      async function* () {
        entered.resolve();
        await release.promise;
        yield* response('late provider output');
      },
    ]);
    const current = grant();
    try {
      await host.service.send(current, message('one', 'run until cancelled'));
      await entered.promise;
      assert.deepEqual(await host.service.stop(current), { status: 'pending' });
      assert.equal(nativeAgent(host, current).status, 'running');
      assert.equal(host.adapter.requests.length, 1);
    } finally {
      release.resolve();
      await nativeAgent(host, current).whenIdle();
    }
    assert.equal((await host.service.stop(current)).status, 'stopped');
  },
);

test(
  'real DSH: cancelling a history read does not wait for a held native durability checkpoint',
  { timeout: 15000 },
  async (t) => {
    const host = await setup(t, ['persisted']);
    const current = grant();
    await host.service.send(current, message('one', 'create history'));
    await nativeAgent(host, current).whenIdle();
    const entered = deferred(),
      release = deferred();
    const remove = host.ctx.on(
      'session/flush',
      async () => {
        entered.resolve();
        await release.promise;
      },
      { global: true },
    );
    const ui = new AbortController();
    const reading = host.service.history(current, -1, 10, ui.signal);
    const finished = reading.then(
      () => 'resolved',
      () => 'rejected',
    );
    let timer;
    try {
      await entered.promise;
      ui.abort();
      const result = await Promise.race([
        finished,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('still-waiting'), 250);
        }),
      ]);
      assert.equal(result, 'rejected', 'read cancellation must not await the held checkpoint');
      assert.equal(current.signal.aborted, false, 'UI cancellation must not revoke the Run');
    } finally {
      clearTimeout(timer);
      release.resolve();
      remove();
      await finished;
    }
  },
);
