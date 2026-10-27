/** Bounded visible-prefix contracts; actual SDK late-join coverage is separate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeAssistantSnapshotCache } from '../dist/native-work-session-snapshot.js';
import { NativeConversationProjection } from '../dist/native-work-session-view.js';

const start = (revision = 1, attemptId = 'attempt') => ({
  type: 'start',
  attemptId,
  revision,
  turn: 1,
  step: 1,
});
const chunk = (index, revision, value, attemptId = 'attempt') => ({
  type: 'chunk',
  attemptId,
  revision,
  index,
  time: 1,
  chunk: value,
});
const end = (index, revision, kind = 'abandoned') => ({
  type: 'end',
  attemptId: 'attempt',
  revision,
  index,
  outcome: kind === 'abandoned' ? { kind } : { kind, eventType: 'assistant/message', seq: 9 },
});

test('snapshot contract: capture retains only visible text/tool names and original dense positions', () => {
  const cache = new NativeAssistantSnapshotCache('session');
  cache.push(start(), 4);
  const values = [
    { type: 'reasoning-delta', text: 'hidden-reasoning' },
    { type: 'text-delta', text: 'visible', providerMetadata: 'hidden-provider' },
    { type: 'tool-call-delta', name: 'read_file', argumentsDelta: 'hidden-arguments' },
    { type: 'tool-call-delta', name: 'read_file', argumentsDelta: 'hidden-again' },
    { type: 'finish', replayState: 'hidden-replay' },
  ];
  values.forEach((value, index) => cache.push(chunk(index, index + 2, value), 4));
  const snapshot = cache.snapshot();
  assert.deepEqual(snapshot, {
    type: 'snapshot',
    revision: 6,
    activeAttempt: {
      attemptId: 'attempt',
      startedAfterSeq: 4,
      nextIndex: 5,
      text: 'visible',
      toolNames: ['read_file'],
    },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden|reasoning|arguments|provider|replay/);
  snapshot.activeAttempt.toolNames.push('local-mutation');
  assert.deepEqual(cache.snapshot().activeAttempt.toolNames, ['read_file']);
});

test('snapshot contract: projection adopts exact prefix, suppresses old revisions and accepts the next native chunk', () => {
  const view = new NativeConversationProjection('session', 4);
  const opening = {
    type: 'snapshot',
    revision: 6,
    activeAttempt: {
      attemptId: 'attempt',
      startedAfterSeq: 4,
      nextIndex: 5,
      text: 'prefix',
      toolNames: ['read_file'],
      arguments: 'hidden-argument',
    },
    reasoning: 'hidden-reasoning',
  };
  const projected = view.push({ type: 'assistant-stream', frame: opening });
  assert.equal(projected.frame.activeAttempt.text, 'prefix');
  assert.doesNotMatch(JSON.stringify(projected), /hidden|arguments|reasoning/);
  assert.equal(
    view.push({
      type: 'assistant-stream',
      frame: chunk(4, 6, { type: 'text-delta', text: 'old' }),
    }),
    undefined,
  );
  assert.equal(
    view.push({
      type: 'assistant-stream',
      frame: chunk(5, 7, { type: 'text-delta', text: 'next' }),
    }).frame.text,
    'next',
  );
  const settled = view.push({ type: 'assistant-stream', frame: end(6, 8, 'committed') });
  assert.equal(settled.frame.outcome.messageKey, 'session:seq:9');
  assert.equal(view.push({ type: 'assistant-stream', frame: opening }), undefined);
});

test('snapshot contract: committed/abandoned/closed lifetimes explicitly clear only the ephemeral prefix', () => {
  for (const outcome of ['committed', 'abandoned']) {
    const cache = new NativeAssistantSnapshotCache('session');
    cache.push(start(), -1);
    cache.push(chunk(0, 2, { type: 'text-delta', text: 'prefix' }), -1);
    cache.push(end(1, 3, outcome), 9);
    assert.deepEqual(cache.snapshot(), { type: 'snapshot', revision: 3 });
    cache.close();
    cache.push(start(4, 'replacement'), 9);
    assert.deepEqual(cache.snapshot(), { type: 'snapshot', revision: 3 });
  }
});

test('snapshot contract: UTF8/frame/name overflow is explicit and a new actual attempt can recover', () => {
  for (const fault of ['text', 'escaped-frame', 'names']) {
    const cache = new NativeAssistantSnapshotCache('session');
    cache.push(start(), -1);
    let revision = 2,
      index = 0;
    if (fault === 'names') {
      for (; index < 129; index++, revision++)
        cache.push(chunk(index, revision, { type: 'tool-call-delta', name: `tool_${index}` }), -1);
    } else {
      const text = fault === 'text' ? '界'.repeat(50_000) : '\u0000'.repeat(30_000);
      cache.push(chunk(index++, revision++, { type: 'text-delta', text }), -1);
      cache.push(chunk(index++, revision++, { type: 'text-delta', text }), -1);
    }
    assert.throws(() => cache.snapshot(), { code: 'capacity' });
    for (let extra = 0; extra < 10; extra++, revision++, index++)
      cache.push(chunk(index, revision, { type: 'tool-call-delta', name: `ignored_${extra}` }), -1);
    assert.throws(() => cache.snapshot(), { code: 'capacity' });
    cache.push(start(revision, 'new-attempt'), 10);
    assert.equal(cache.snapshot().activeAttempt.attemptId, 'new-attempt');
    assert.equal(cache.snapshot().activeAttempt.text, '');
  }
});

test('snapshot contract: missing native frames fail explicitly and empty opening retires prior projection', () => {
  const cache = new NativeAssistantSnapshotCache('session');
  cache.push(start(), -1);
  cache.push(chunk(2, 4, { type: 'text-delta', text: 'incomplete' }), -1);
  assert.throws(() => cache.snapshot(), { code: 'unavailable' });
  const view = new NativeConversationProjection('session');
  view.push({ type: 'assistant-stream', frame: start() });
  assert.deepEqual(
    view.push({ type: 'assistant-stream', frame: { type: 'snapshot', revision: 4 } }),
    { type: 'assistant-stream', frame: { type: 'snapshot', revision: 4 } },
  );
  assert.deepEqual(
    view.push({
      type: 'assistant-stream',
      frame: chunk(0, 5, { type: 'text-delta', text: 'old' }),
    }),
    { type: 'gap', after: -1 },
  );
});

test('snapshot companion contract: Host keeps exact scope/known snapshot fields and releases each fresh read grant', async () => {
  const { createHostRunReader } = await import('../dist/host-run-reader.js');
  const { available, command, records } = await import('./execution-run-fixture.mjs');
  const { beginExecutionRun } = await import('../dist/execution-run-state.js');
  const first = records()[0],
    decision = beginExecutionRun(first, command(first), [first], available);
  const scope = decision.effect.scope;
  const locator = Object.fromEntries(
    ['taskId', 'planId', 'revision', 'nodeId', 'runId'].map((key) => [key, scope[key]]),
  );
  const request = {},
    signal = new AbortController().signal;
  let opened = 0,
    closed = 0;
  const native = {
    open: () => ({ binding: { nativeSessionId: 'session' } }),
    async *observe(grant) {
      for (const active of [true, false])
        yield {
          scope: grant.scope,
          nativeSessionId: 'session',
          type: 'assistant-stream',
          frame: {
            type: 'snapshot',
            revision: active ? 3 : 4,
            privateField: 'PRIVATE',
            ...(active
              ? {
                  activeAttempt: {
                    attemptId: 'attempt',
                    startedAfterSeq: 1,
                    nextIndex: 2,
                    text: 'visible',
                    toolNames: ['read_file'],
                    arguments: 'PRIVATE',
                    reasoning: 'PRIVATE',
                  },
                }
              : {}),
          },
        };
    },
  };
  const reader = createHostRunReader(
    { readRunNode: () => decision.record },
    {
      async open(original, target, purpose) {
        assert.equal(original, request);
        assert.equal(purpose, 'read');
        assert.deepEqual(target, locator);
        opened++;
        return {
          grant: { scope, signal, assertCurrent: () => signal.throwIfAborted() },
          dispose: () => closed++,
        };
      },
    },
    native,
  );
  for (let index = 0; index < 2; index++) {
    const frames = [];
    await reader.observe(request, locator, async (frame) => frames.push(frame));
    assert.deepEqual(frames[1].target.runId, scope.runId);
    assert.equal(frames[1].frame.activeAttempt.text, 'visible');
    assert.deepEqual(frames[1].frame.activeAttempt.toolNames, ['read_file']);
    assert.equal(frames[2].frame.activeAttempt, undefined);
    assert.doesNotMatch(JSON.stringify(frames), /PRIVATE|arguments|reasoning/);
  }
  assert.equal(opened, 2);
  assert.equal(closed, 2);
});
