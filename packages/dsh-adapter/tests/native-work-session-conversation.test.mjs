/** Real D issuer + C mapping/queue contracts; synthetic native I/O, no SDK/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { NativeReleasedConversationAuthorities } from '../dist/native-released-conversation-authority.js';
import {
  nativeWorkSessionKey,
  nativeWorkSessionRecordSchema,
} from '../dist/native-work-session-record.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import {
  executionRunScope,
  readExecutionRunState,
  requestExecutionRunStop,
} from '../dist/execution-run-state.js';
import { accepted, applyEvent, stable, stopCommand, locator } from './execution-run-fixture.mjs';
import { Context } from '@deepseek-ai/cordis';
import { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { createNativeFixedResultIssuer } from '../dist/native-work-session-result.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import { nativeResultAck, nativeResultDigest } from '../dist/native-work-session-result-source.js';

const digest = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(t, options = {}) {
  const running = accepted();
  const row = options.running
    ? running
    : applyEvent(requestExecutionRunStop(running, stopCommand(running)).record, 'stopped', stable)
        .record;
  const run = readExecutionRunState(row).runs[0],
    origin = executionRunScope(row, run);
  const binding = {
    schemaVersion: 1,
    scope: origin,
    nativeSessionId: run.attempt.sessionId,
    nativeAgentId: run.attempt.executorRunId,
    selection: run.selection,
    receipts: [],
  };
  const events = [
    {
      seq: 0,
      time: 1,
      type: 'user/message',
      data: {
        id: 'original',
        role: 'user',
        content: [{ type: 'text', text: 'original task' }],
        source: { kind: 'user' },
      },
    },
  ];
  const prefix = {
    asOfSeq: 0,
    eventCount: 1,
    inheritedEventCount: 0,
    headerDigest: 'a'.repeat(64),
    eventsDigest: digest(events),
  };
  const records = new Map([[nativeWorkSessionKey(origin), structuredClone(binding)]]);
  const writes = [],
    sends = [],
    changes = new Set();
  let current = true,
    actor = options.actor ?? 'chen',
    connected = false,
    retireCalls = 0,
    connects = 0;
  let backend = { id: 'contract-backend', identity: {} };
  const sourceIdentity = { persistence: Symbol('persistence'), registry: {}, projection: {} };
  const runtime = {
    conversationSourceIdentity: () => sourceIdentity,
    qualifyConversationRead: async (_binding, signal, check) => {
      signal.throwIfAborted();
      check();
    },
    readConversationPage: async (_binding, after, limit, signal, check) => {
      signal.throwIfAborted();
      check();
      return events.filter((e) => e.seq > after).slice(0, limit);
    },
    readConversationPrefix: async (_binding, _signal, check) => {
      check();
      return structuredClone(prefix);
    },
    readPrefixSnapshot: async (_binding, expected, _signal, check) => {
      check();
      assert.deepEqual(expected, prefix);
      return {
        asOfSeq: 0,
        inheritedEventCount: 0,
        hasPending: false,
        pendingMessageIds: [],
        events: structuredClone(events.slice(0, 1)),
        check,
      };
    },
    retire: async (_sid, signal) => {
      signal.throwIfAborted();
      retireCalls++;
      if (connected) await options.retireGate?.promise;
      connected = false;
      return {
        signal: new AbortController().signal,
        basis: 'flushed-and-closed',
        assertCurrent() {},
      };
    },
    readInbox: async () => ({ asOfSeq: events.at(-1).seq, items: [], claimedMessageIds: [] }),
    connectConversation: async (_binding, lease) => {
      lease.assertCurrent('send');
      connects++;
      connected = true;
      if (options.abortOnlyConnect) {
        options.connectEntered.resolve(lease);
        await new Promise((_resolve, reject) => {
          const abort = () => reject(new NativeWorkError('cancelled'));
          if (lease.signal.aborted) abort();
          else lease.signal.addEventListener('abort', abort, { once: true });
        });
      }
      await options.connectGate?.promise;
    },
    isConnected: () => connected,
    status: () => 'idle',
    messageStatus: async (_sid, id) => (sends.some((m) => m.id === id) ? 'claimed' : 'absent'),
    send: (_sid, message) => {
      sends.push(structuredClone(message));
      events.push({
        seq: events.length,
        time: 1,
        type: 'user/message',
        data: {
          ...message,
          role: 'user',
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'user', rpcId: message.rpcId },
        },
      });
    },
    flush: async () => {},
    history: async (_sid, after, limit) => events.filter((e) => e.seq > after).slice(0, limit),
    follow: async function* (_sid, after, signal) {
      for (const event of events.filter((e) => e.seq > after)) yield { type: 'event', event };
      if (!signal.aborted)
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const storage = {
    read: (key) => structuredClone(records.get(key)),
    write: async (key, record) => {
      const parsed = nativeWorkSessionRecordSchema.parse(record);
      writes.push(structuredClone(parsed));
      records.set(key, parsed);
      await options.afterWrite?.(parsed);
    },
  };
  const service = new NativeWorkSessionService(storage, runtime),
    conversation = service.conversation;
  const lifetime = new AbortController();
  const source = {
    signal: lifetime.signal,
    writerState: () => ({ schemaVersion: 1, nativeExecutionWriter: 1 }),
    memberLease: async () => ({
      memberId: actor,
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      assertCurrent() {
        if (!current) throw Error('revoked');
      },
      release() {},
    }),
    readNode: () => row,
    backend: () => backend,
    assertNodeAccess() {
      if (!current) throw Error('revoked');
    },
    assertController(who) {
      if (who !== actor) throw Error('not current owner');
    },
    assertWorkspace() {},
    onChange(fn) {
      changes.add(fn);
      return () => changes.delete(fn);
    },
    openEpoch: conversation.openEpoch.bind(conversation),
    assertEpoch: conversation.assertEpoch.bind(conversation),
    retireEpoch: conversation.retireEpoch.bind(conversation),
    whenEpochSettled: conversation.whenEpochSettled.bind(conversation),
    openReadEpoch: conversation.openReadEpoch.bind(conversation),
    assertReadEpoch: conversation.assertReadEpoch.bind(conversation),
  };
  const manager = new NativeReleasedConversationAuthorities(source);
  const assertGrant = manager.assertGrant.bind(manager),
    assertReadGrant = manager.assertReadGrant.bind(manager);
  conversation.configure({
    backend,
    assertGrant: options.asyncIssuer ? async (...args) => assertGrant(...args) : assertGrant,
    assertReadGrant: options.asyncIssuer
      ? async (...args) => assertReadGrant(...args)
      : assertReadGrant,
  });
  t.after(async () => {
    await manager.close();
    await conversation.close();
  });
  const workGrant = { scope: origin, signal: new AbortController().signal, assertCurrent() {} };
  return {
    service,
    conversation,
    manager,
    runtime,
    storage,
    records,
    writes,
    sends,
    events,
    prefix,
    binding,
    row,
    workGrant,
    read: () => manager.openRead({}, locator(row)),
    send: () => manager.open({}, locator(row)),
    get connects() {
      return connects;
    },
    get retireCalls() {
      return retireCalls;
    },
    revoke() {
      current = false;
      for (const fn of changes) fn();
    },
    replaceBackend() {
      backend = { ...backend, identity: {} };
      for (const fn of changes) fn();
    },
  };
}

test('contract: passive active-Work navigation is epoch zero and never opens a writer or retires', async (t) => {
  const h = setup(t, { running: true, actor: 'outside' });
  const read = await h.read();
  const opened = h.conversation.open(read.grant);
  assert.equal(opened.chatEpoch, 0);
  assert.equal(opened.binding.scope.actorId, 'chen');
  assert.equal(read.grant.actorId, 'outside');
  assert.equal((await h.conversation.conversationHistory(read.grant)).events.length, 1);
  read.dispose();
  assert.deepEqual([h.connects, h.retireCalls, h.writes.length, h.sends.length], [0, 0, 0, 0]);
});

test('contract: an accidentally asynchronous Host assertion cannot authorize a native read or send', async (t) => {
  const h = setup(t, { asyncIssuer: true }),
    read = await h.read();
  assert.throws(() => h.conversation.open(read.grant), { code: 'scope-mismatch' });
  const opened = await h.send();
  assert.throws(
    () => h.conversation.send(opened.grant, { requestId: 'async-port', text: 'must not admit' }),
    { code: 'scope-mismatch' },
  );
  assert.equal(h.connects, 0);
  assert.equal(h.sends.length, 0);
  await tick();
});

test('contract: genuine send takes the same SID, invalidates epoch-zero readers, and reconciles a duplicate without resending', async (t) => {
  const h = setup(t),
    read = await h.read(),
    opened = await h.send();
  assert.equal(opened.grant.chatEpoch, 1);
  assert.equal(opened.grant.origin.nativeSessionId, h.binding.nativeSessionId);
  assert.equal(read.grant.signal.aborted, true);
  const request = { requestId: 'same-request', text: 'continue this discussion' };
  const first = await h.conversation.send(opened.grant, request);
  const retry = await h.conversation.send(opened.grant, request);
  assert.equal(first.messageId, retry.messageId);
  assert.equal(retry.status, 'claimed');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].rpcId, request.requestId);
  assert.throws(() => h.conversation.send({ ...opened.grant }, request), {
    code: 'conversation-authority-denied',
  });
  await assert.rejects(h.conversation.send(opened.grant, { ...request, text: 'changed' }), {
    code: 'idempotency-mismatch',
  });
});

test('contract: stop physically settles and the next epoch retains the same original fence and receipt ledger', async (t) => {
  const h = setup(t),
    first = await h.send();
  const request = { requestId: 'first-turn', text: 'one' };
  await h.conversation.send(first.grant, request);
  assert.equal(await h.manager.stop(first.grant), 'stopped');
  await tick();
  const next = await h.send();
  assert.equal(next.grant.chatEpoch, 2);
  const connects = h.connects;
  await h.conversation.send(next.grant, request);
  assert.equal(h.sends.length, 1);
  assert.equal(h.connects, connects, 'reconciliation does not resume the native Agent');
  const read = await h.read();
  assert.equal(h.conversation.open(read.grant).chatEpoch, 2);
  assert.deepEqual(
    (await h.conversation.conversationHistory(read.grant)).events.map((event) => event.seq),
    [0, 1],
  );
  read.dispose();
  const slot = [...h.records.values()][0].conversation.sessions[0];
  assert.equal(slot.phase, 'active');
  assert.deepEqual(slot.prefix, h.prefix);
  assert.equal(slot.receipts.length, 1);
});

test('contract: old Work history and a newly opened old follow stop at the original physical prefix', async (t) => {
  const h = setup(t),
    stream = h.service.follow(h.workGrant);
  assert.equal((await stream.next()).value.event.seq, 0);
  const waiting = stream.next(),
    opened = await h.send();
  assert.equal((await waiting).done, true);
  await h.conversation.send(opened.grant, { requestId: 'tail', text: 'new chat tail' });
  const old = await h.service.history(h.workGrant);
  assert.deepEqual(
    old.events.map((e) => e.seq),
    [0],
  );
  const replay = [];
  for await (const frame of h.service.follow(h.workGrant)) replay.push(frame.event.seq);
  assert.deepEqual(replay, [0]);
  assert.equal(h.service.open(h.workGrant).status, 'detached');
});

test('contract: a passive reader release cannot stop a chat and source replacement revokes reads', async (t) => {
  const h = setup(t),
    opened = await h.send();
  await h.conversation.send(opened.grant, { requestId: 'tail', text: 'new tail' });
  const read = await h.read(),
    retireCalls = h.retireCalls;
  assert.equal((await h.conversation.conversationHistory(read.grant)).events.length, 2);
  read.dispose();
  assert.equal(h.retireCalls, retireCalls);
  const second = await h.read();
  h.replaceBackend();
  assert.throws(() => h.conversation.open(second.grant), { code: 'conversation-authority-denied' });
});

test('contract: backend/member revocation keeps physical cleanup owned while its close is delayed', async (t) => {
  const retireGate = Promise.withResolvers(),
    h = setup(t, { retireGate }),
    opened = await h.send();
  await h.conversation.send(opened.grant, { requestId: 'one', text: 'one' });
  h.revoke();
  await tick();
  let closed = false;
  const closing = h.manager.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal([...h.records.values()][0].conversation.sessions[0].phase, 'retiring');
  retireGate.resolve();
  await closing;
  assert.equal([...h.records.values()][0].conversation.sessions[0].phase, 'settled');
});

for (const mode of ['stop', 'revoke']) {
  test(`contract: ${mode} aborts a connect that only settles on its lease signal without releasing the physical drain early`, async (t) => {
    const connectEntered = Promise.withResolvers(),
      retireGate = Promise.withResolvers();
    const h = setup(t, { abortOnlyConnect: true, connectEntered, retireGate }),
      opened = await h.send();
    const sending = h.conversation.send(opened.grant, {
      requestId: `held-${mode}`,
      text: 'connect must be cancellable',
    });
    const rejectedSend = assert.rejects(sending, { code: 'cancelled' });
    const lease = await connectEntered.promise;
    let stopping;
    try {
      await assert.rejects(
        h.conversation.retireEpoch({ kind: 'chat-only', chatEpoch: opened.grant.chatEpoch }),
        { code: 'scope-mismatch' },
      );
      assert.equal(lease.signal.aborted, false, 'foreign tickets cannot abort this owner');
      if (mode === 'stop') stopping = h.manager.stop(opened.grant);
      else h.revoke();
      assert.equal(lease.signal.aborted, true, 'abort precedes admission to the mapping queue');
      await rejectedSend;
      await tick();
      assert.equal(h.sends.length, 0);
      assert.equal([...h.records.values()][0].conversation.sessions[0].phase, 'retiring');
      let closed = false;
      const closing = h.manager.close().then(() => {
        closed = true;
      });
      await tick();
      assert.equal(closed, false, 'actual close is still owned while native drain is held');
      if (stopping)
        assert.equal(
          await stopping,
          'pending',
          'the bounded wait does not claim physical settlement',
        );
      assert.equal(closed, false);
      retireGate.resolve();
      await closing;
      assert.equal(closed, true);
      assert.equal(
        [...h.records.values()][0].conversation.sessions[0].phase,
        'unknown',
        'reserved input without an official receipt is not fabricated as absent/complete',
      );
    } finally {
      // A regression must fail instead of trapping the test runner in its own teardown.
      retireGate.resolve();
      await h.conversation.close();
      await rejectedSend;
      await stopping;
    }
  });
}

test('contract: message limit and original Work drive rejection occur before native admission', async (t) => {
  const h = setup(t),
    opened = await h.send();
  assert.throws(
    () => h.conversation.send(opened.grant, { requestId: 'big', text: 'x'.repeat(16_385) }),
    { code: 'invalid-request' },
  );
  await assert.rejects(
    h.service.send(h.workGrant, {
      requestId: 'work',
      text: 'must not run',
      mode: 'followup',
      selection: h.binding.selection,
    }),
    { code: 'scope-mismatch' },
  );
  assert.equal(h.connects, 0);
  assert.equal(h.sends.length, 0);
  const cold = new NativeWorkSessionService(h.storage, h.runtime);
  await assert.rejects(
    cold.send(h.workGrant, {
      requestId: 'cold-work',
      text: 'must not resume Work after restart',
      mode: 'followup',
      selection: h.binding.selection,
    }),
    { code: 'scope-mismatch' },
  );
  assert.equal(h.connects, 0);
  assert.equal(h.sends.length, 0);
});

test('contract: a lost metadata acknowledgement never resends an already admitted native message across epochs', async (t) => {
  let failWrite = true;
  const h = setup(t, {
      afterWrite(record) {
        if (failWrite && record.conversation?.sessions[0].phase === 'active') {
          failWrite = false;
          throw Error('synthetic lost acknowledgement after committed put');
        }
      },
    }),
    opened = await h.send();
  const input = { requestId: 'unknown-ack', text: 'admit exactly once' };
  await assert.rejects(h.conversation.send(opened.grant, input));
  for (
    let i = 0;
    i < 20 && [...h.records.values()][0].conversation.sessions[0].phase !== 'settled';
    i++
  )
    await tick();
  await tick();
  const second = await h.send();
  assert.equal((await h.conversation.send(second.grant, input)).status, 'claimed');
  assert.equal(h.sends.length, 1);
});

test('contract: current controller may differ from original Run actor without changing mapping ownership', async (t) => {
  const h = setup(t, { actor: 'outside' }),
    opened = await h.send();
  assert.equal(opened.grant.actorId, 'outside');
  assert.equal(opened.grant.origin.scope.actorId, 'chen');
  await h.conversation.send(opened.grant, {
    requestId: 'outside-turn',
    text: 'continue as current owner',
  });
  assert.equal(h.sends.length, 1);
  assert.equal([...h.records.values()][0].scope.actorId, 'chen');
});

test('contract: actual fixed-result owner reads only the sealed original prefix while newer chat is running', async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const facts = compositionFacts();
  const composition = freezeExecutionRunComposition({
    ...facts,
    resultIntentTool: describeNativeResultTool(),
  });
  const content = { text: 'original fixed result', links: [] };
  const intent = {
    protocolVersion: 1,
    toolVersion: 'zhuma-native-result-intent@1',
    intentId: 'intent',
    callId: 'call',
    digest: nativeResultDigest(content),
    cut: { callSeq: 0, resultSeq: 1, turnEndSeq: 2, asOfSeq: 2 },
  };
  const binding = {
    schemaVersion: 1,
    scope: facts.scope,
    nativeSessionId: 'same-native',
    nativeAgentId: 'same-native',
    selection: { ...facts.model, configurationId: composition.configurationId },
    receipts: [],
    resultIntent: intent,
  };
  const events = [
    {
      seq: 0,
      time: 1,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call',
        name: 'complete_work',
        arguments: JSON.stringify(content),
      },
    },
    {
      seq: 1,
      time: 1,
      type: 'tool/result',
      sourceEventSeqs: [0],
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call',
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(nativeResultAck(binding, intent)) }],
        }),
      },
    },
    { seq: 2, time: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const prefix = {
    asOfSeq: 2,
    eventCount: 3,
    inheritedEventCount: 0,
    headerDigest: 'a'.repeat(64),
    eventsDigest: digest(events),
  };
  let record = {
    ...binding,
    conversation: {
      schemaVersion: 1,
      sessions: [
        {
          origin: {
            scope: binding.scope,
            nativeSessionId: binding.nativeSessionId,
            nativeAgentId: binding.nativeAgentId,
            selection: binding.selection,
          },
          prefix,
          chatEpoch: 1,
          actorId: 'chen',
          backendId: 'contract',
          phase: 'active',
          receipts: [],
        },
      ],
    },
  };
  let prefixReads = 0;
  const forbidden = () => {
    throw Error('new chat writer or latest tip must not be touched');
  };
  const runtime = {
    isConnected: () => true,
    status: () => 'running',
    retire: forbidden,
    flush: forbidden,
    readResultSnapshot: forbidden,
    async readPrefixSnapshot(_binding, actual, _signal, check) {
      assert.deepEqual(actual, prefix);
      prefixReads++;
      check();
      return {
        asOfSeq: 2,
        inheritedEventCount: 0,
        events,
        hasPending: false,
        pendingMessageIds: [],
        check,
      };
    },
  };
  const service = new NativeWorkSessionService(
    { read: () => structuredClone(record), write: forbidden },
    runtime,
  );
  const grant = {
    scope: facts.scope,
    signal: new AbortController().signal,
    assertCurrent(action) {
      if (!['open', 'history'].includes(action)) throw Error('not a Work drive grant');
    },
  };
  const owner = createNativeFixedResultIssuer(
    ctx,
    service,
    runtime,
    {
      assertGrant(g, action) {
        g.assertCurrent(action);
      },
    },
    { readRunComposition: () => composition },
  );
  const prepared = await owner.prepareFixedResult(grant, grant.signal);
  assert.equal(prepared.status, 'ready');
  const lease = await owner.readFixedResult(grant, prepared.ref, grant.signal);
  assert.deepEqual(lease.content, content);
  assert.deepEqual(lease.source.cut, intent.cut);
  assert.equal(lease.digest, intent.digest);
  assert.equal(prefixReads, 2);
  record.conversation.sessions[0].prefix.eventsDigest = 'b'.repeat(64);
  assert.throws(() => lease.check(), { code: 'result-rejected' });
  lease.release();
});
