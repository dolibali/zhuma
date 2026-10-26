/** Actual fixed SDK, original Cookie/Run/C owner; only model output is scripted. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { bootNativeResults, toolResponse } from './zhuma-native-public-result-bundle.ts';

const text = '中'.repeat(100000);
const frameBytes = 262144;
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-public-result-'));
  const h = await bootNativeResults(root);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = await h.upload('Accepted upstream context.');
  await h.submit(input, 'public-input');
  await h.ballot('approve', 'public-input-accept');
  const opened = await h.begin();
  t.onTestFinished(() => opened.dispose());
  h.adapter.script.push('The earlier ordinary turn.');
  await h.native.service.send(opened.grant, h.firstMessage());
  await h.actor().whenIdle();
  const reservation = await h.native.service.reserveInputRead(opened.grant);
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      await h.native.service.finishInputRead(opened.grant, reservation, 0);
    }
  };
  t.onTestFinished(release);
  const complete = async (
    response = toolResponse({ text, links: [] }, 'public-completion', 'complete_work'),
  ) => {
    h.adapter.script.push(response);
    await h.native.service.send(opened.grant, {
      ...h.firstMessage(),
      requestId: 'public-completion-input',
      text: 'Complete this work.',
    });
    await h.actor().whenIdle();
  };
  const fixed = async () => {
    const snapshot = await h.native.service.readResultSnapshot(opened.grant, opened.grant.signal);
    const large = snapshot.events
      .filter((e) => Buffer.byteLength(JSON.stringify(e)) > frameBytes)
      .map((e) => ({ seq: e.seq, type: e.type, bytes: Buffer.byteLength(JSON.stringify(e)) }));
    assert.ok(
      large.length >= 1,
      'Actual original native events retain the complete result payload',
    );
    await release();
    const ready = await h.results.prepareFixedResult(opened.grant, opened.grant.signal);
    assert.equal(ready.status, 'ready');
    const lease = await h.results.readFixedResult(opened.grant, ready.ref, opened.grant.signal);
    assert.equal(lease.content.text, text);
    assert.equal(Buffer.byteLength(lease.content.text), 300000);
    lease.check();
    lease.release();
    return { snapshot, large };
  };
  return { ...h, opened, complete, fixed, release };
}

test('public history carries a bounded trace of an actual 100000-character completion without truncating its fixed result', async (t) => {
  const h = await setup(t);
  await h.complete();
  let history;
  let failure;
  try {
    history = await h.native.service.history(h.opened.grant);
  } catch (error) {
    failure = error.code;
  }
  const { large, snapshot } = await h.fixed();
  assert.equal(failure, undefined, JSON.stringify({ failure, large }));
  assert.ok(Buffer.byteLength(JSON.stringify(history.events)) <= frameBytes);
  const actualSeqs = history.events.map((e) => e.seq);
  assert.deepEqual(
    actualSeqs,
    [...new Set(actualSeqs)].sort((a, b) => a - b),
  );
  assert.ok(
    history.events.some((e) => e.type === 'tool/call' && e.data.callId === 'public-completion'),
  );
  assert.deepEqual(
    history.events.map(({ seq, time, type }) => ({ seq, time, type })),
    snapshot.events.map(({ seq, time, type }) => ({ seq, time, type })),
  );
  assert.deepEqual(
    history.events.filter((e) => e.type === 'tool/result'),
    snapshot.events.filter((e) => e.type === 'tool/result'),
    'The actual bounded declared ACK/state remain intact',
  );
  assert.equal(JSON.stringify(history.events).includes('中'.repeat(100)), false);
  const pages = [];
  for (;;) {
    const page = await h.native.service.history(h.opened.grant, pages.at(-1)?.seq ?? -1, 1);
    if (!page.events.length) break;
    assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= frameBytes);
    pages.push(...page.events);
  }
  assert.deepEqual(pages, history.events, 'Projection is stable across one-event page boundaries');
  const cancel = new AbortController();
  const replay = [];
  for await (const frame of h.native.service.follow(h.opened.grant, -1, cancel.signal)) {
    if (frame.type === 'event') replay.push(frame.event);
    if (replay.at(-1)?.seq === history.events.at(-1).seq) {
      cancel.abort();
      break;
    }
  }
  assert.deepEqual(replay, history.events, 'Disconnected reader replays the same original cursors');
  await assert.rejects(
    h.issuer.open(h.requests.outside, { ...h.locate('expert'), runId: 'file-run' }, 'read'),
  );
  await assert.rejects(
    h.native.service.history({
      ...h.opened.grant,
      scope: { ...h.opened.grant.scope, spaceId: 'south' },
    }),
  );
  await h.revoke();
  await assert.rejects(h.native.service.history(h.opened.grant));
});

test('live public follow does not overflow on actual complete_work argument chunks and durable tool events', async (t) => {
  const h = await setup(t);
  const previous = await h.native.service.history(h.opened.grant);
  const subscribed = Promise.withResolvers();
  const runtimeHistory = h.native.runtime.history.bind(h.native.runtime);
  h.native.runtime.history = (...args) => {
    subscribed.resolve();
    return runtimeHistory(...args);
  };
  const cancel = new AbortController();
  t.onTestFinished(() => cancel.abort());
  const frames = [];
  let failure;
  const following = (async () => {
    try {
      for await (const frame of h.native.service.follow(
        h.opened.grant,
        previous.events.at(-1).seq,
        cancel.signal,
      )) {
        frames.push(frame);
        if (frame.type === 'gap' || (frame.type === 'event' && frame.event.type === 'turn/end')) {
          cancel.abort();
          break;
        }
      }
    } catch (error) {
      if (!cancel.signal.aborted) failure = error.code;
    }
  })();
  await subscribed.promise;
  h.native.runtime.history = runtimeHistory;
  await h.complete();
  await following;
  const { large } = await h.fixed();
  assert.equal(failure, undefined);
  assert.equal(
    frames.some((f) => f.type === 'gap'),
    false,
    JSON.stringify({ large, types: frames.map((f) => f.type) }),
  );
  for (const frame of frames) assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= frameBytes);
  assert.ok(frames.some((f) => f.type === 'event' && f.event.type === 'tool/call'));
});

test('unidentified large argument chunks retain their original public capacity rejection even when a later chunk names complete_work', async (t) => {
  const h = await setup(t);
  const previous = await h.native.service.history(h.opened.grant);
  const subscribed = Promise.withResolvers();
  const runtimeHistory = h.native.runtime.history.bind(h.native.runtime);
  h.native.runtime.history = (...args) => {
    subscribed.resolve();
    return runtimeHistory(...args);
  };
  const cancel = new AbortController();
  t.onTestFinished(() => cancel.abort());
  const frames = [];
  const following = (async () => {
    for await (const frame of h.native.service.follow(
      h.opened.grant,
      previous.events.at(-1).seq,
      cancel.signal,
    )) {
      frames.push(frame);
      if (frame.type === 'gap') {
        cancel.abort();
        break;
      }
    }
  })();
  await subscribed.promise;
  h.native.runtime.history = runtimeHistory;
  await h.complete(function* () {
    const arguments_ = JSON.stringify({ text, links: [] });
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'public-completion',
      argumentsDelta: arguments_,
    };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'public-completion',
      name: 'complete_work',
      argumentsDelta: '',
    };
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'public-completion',
        name: 'complete_work',
        arguments: arguments_,
      },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  await following;
  await assert.rejects(h.native.service.history(h.opened.grant), { code: 'capacity' });
  assert.ok(frames.some((frame) => frame.type === 'gap'));
  await h.fixed();
});

test('Stop preserves a bounded interrupted completion attempt without manufacturing a fixed result', async (t) => {
  const h = await setup(t);
  const entered = Promise.withResolvers();
  const running = h.complete(async function* (options) {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'stopped-call',
      name: 'complete_work',
      argumentsDelta: JSON.stringify({ text, links: [] }),
    };
    entered.resolve();
    await new Promise((resolve) => {
      options.signal.addEventListener('abort', resolve, { once: true });
      if (options.signal.aborted) resolve();
    });
  });
  await entered.promise;
  await h.release();
  assert.equal((await h.native.service.stop(h.opened.grant)).status, 'stopped');
  await running;
  await h.release();
  const reading = await h.issuer.open(
    h.requests.chen,
    { ...h.locate('expert'), runId: 'file-run' },
    'read',
  );
  try {
    const history = await h.native.service.history(reading.grant);
    assert.ok(Buffer.byteLength(JSON.stringify(history.events)) <= frameBytes);
    assert.ok(history.events.some((e) => e.type === 'assistant/attempt'));
    assert.ok(
      history.events.some((e) => e.type === 'turn/end' && e.data.reason.kind !== 'completed'),
    );
    assert.deepEqual(await h.results.prepareFixedResult(h.opened.grant, h.opened.grant.signal), {
      status: 'pending',
      reason: 'not-declared',
    });
  } finally {
    reading.dispose();
  }
});

test('a mixed actual assistant message never hides an oversized ordinary tool merely because complete_work is also present', async (t) => {
  const h = await setup(t);
  await h.complete(function* () {
    for (const [index, call] of [
      { id: 'ordinary-call', name: 'ordinary_tool', arguments: JSON.stringify({ text }) },
      {
        id: 'public-completion',
        name: 'complete_work',
        arguments: JSON.stringify({ text, links: [] }),
      },
    ].entries()) {
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield { type: 'block-end', index, block: { type: 'tool-call', ...call } };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  await assert.rejects(h.native.service.history(h.opened.grant), { code: 'capacity' });
  const { snapshot } = await h.fixed();
  assert.ok(
    snapshot.events.some(
      (e) =>
        e.type === 'tool/call' &&
        e.data.callId === 'ordinary-call' &&
        e.data.arguments.includes(text),
    ),
  );
});
