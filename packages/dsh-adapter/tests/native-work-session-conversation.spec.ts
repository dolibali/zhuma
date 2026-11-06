/** Targeted patched official SDK qualification. Transport/model/Run facts are
 * explicit local fixtures; this is not a GUI, paid-model or real-member proof.
 * The private runner binds the actual current C/D bundle and SDK client helpers.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import { Context } from '@deepseek-ai/cordis';
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client';
import { ClientSessions } from 'zhuma-sdk/client-sessions';
import {
  boot,
  ScriptedAdapter,
  NativeReleasedConversationAuthorities,
  accepted,
  applyEvent,
  stable,
  stopCommand,
  locator,
  executionRunScope,
  readExecutionRunState,
  requestExecutionRunStop,
} from './zhuma-native-work-bundle.ts';

export async function nativeChat(t) {
  const qualification = process.env.ZHUMA_NATIVE_CHAT_QUALIFICATION_ROOT;
  if (!qualification) throw Error('An explicit isolated qualification root is required.');
  const root = await mkdtemp(join(qualification, 'native-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const running = accepted();
  let row = applyEvent(
    requestExecutionRunStop(running, stopCommand(running)).record,
    'stopped',
    stable,
  ).record;
  const run = readExecutionRunState(row).runs[0],
    scope = executionRunScope(row, run);
  const original = { scope, signal: new AbortController().signal, assertCurrent() {} };
  let compositionCalls = 0;
  const adapter = new ScriptedAdapter([
    'original work response',
    'first chat response',
    'second chat response',
  ]);
  const host = await boot(root, adapter, () => {
    compositionCalls++;
    return { context: 'SYNTHETIC_WORK_COMPOSITION_DO_NOT_REUSE', toolAllowlist: [] };
  });
  t.onTestFinished(() => host.close());
  await host.service.send(original, {
    requestId: 'original-work',
    text: 'original work request',
    mode: 'followup',
    selection: run.selection,
  });
  const binding = host.service.open(original).binding;
  await host.ctx.agents.get(binding.nativeSessionId).whenIdle();
  row = {
    ...row,
    nativeExecution: {
      ...row.nativeExecution,
      runs: row.nativeExecution.runs.map((item) => ({
        ...item,
        attempt: {
          ...item.attempt,
          sessionId: binding.nativeSessionId,
          executorRunId: binding.nativeAgentId,
        },
      })),
    },
  };
  const backend = { id: 'native-chat-contract', identity: {} },
    changes = new Set();
  const conversation = host.service.conversation;
  const source = {
    signal: new AbortController().signal,
    writerState: () => ({ schemaVersion: 1, nativeExecutionWriter: 1 }),
    memberLease: async () => ({
      memberId: 'chen',
      expiresAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      assertCurrent() {},
      release() {},
    }),
    readNode: () => row,
    backend: () => backend,
    assertNodeAccess() {},
    assertController() {},
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
  conversation.configure({
    backend,
    assertGrant: manager.assertGrant.bind(manager),
    assertReadGrant: manager.assertReadGrant.bind(manager),
  });
  t.onTestFinished(() => manager.close());
  const nativeEvents = async () => {
    // Official durable reader, not C's presentation whitelist or another DB.
    const handle = await host.ctx.sessionPersistence.open(
      SessionId(binding.nativeSessionId),
      'read',
    );
    try {
      return (await handle.read(0, 1000)).events;
    } finally {
      await handle.close();
    }
  };
  return {
    ...host,
    manager,
    conversation,
    original,
    binding,
    nativeEvents,
    get compositionCalls() {
      return compositionCalls;
    },
    open: () => manager.open({}, locator(row)),
    read: () => manager.openRead({}, locator(row)),
  };
}

it('official SDK: chat resumes the same SID with no Work composition/tools, repeated requests do not rerun, and the original physical prefix survives new tail', async (t) => {
  const h = await nativeChat(t),
    before = await h.service.history(h.original);
  const read = await h.read();
  assert.equal(h.conversation.open(read.grant).chatEpoch, 0);
  const originalCreate = h.ctx.agents.create.bind(h.ctx.agents),
    originalResume = h.ctx.agents.resume.bind(h.ctx.agents);
  let resumes = 0;
  h.ctx.agents.create = () => {
    throw Error('chat must never create a Session');
  };
  h.ctx.agents.resume = (options) => {
    resumes++;
    return originalResume(options);
  };
  t.onTestFinished(() => {
    h.ctx.agents.create = originalCreate;
    h.ctx.agents.resume = originalResume;
  });
  const opened = await h.open();
  assert.equal(read.grant.signal.aborted, true);
  const input = { requestId: 'chat-first', text: 'continue in this same conversation' };
  const receipt = await h.conversation.send(opened.grant, input);
  const agent = h.ctx.agents.get(h.binding.nativeSessionId);
  await agent.whenIdle();
  assert.equal(agent.session.id, h.binding.nativeSessionId);
  assert.equal(resumes, 1);
  assert.equal(h.compositionCalls, 1);
  assert.deepEqual(h.adapter.requests[1].tools ?? [], []);
  assert.equal(
    JSON.stringify(
      h.adapter.requests[1].messages.filter((message) => message.role === 'system'),
    ).includes('SYNTHETIC_WORK_COMPOSITION_DO_NOT_REUSE'),
    false,
  );
  assert.deepEqual(h.ctx.tools.schemas(agent), []);
  const retry = await h.conversation.send(opened.grant, input);
  assert.equal(retry.messageId, receipt.messageId);
  assert.equal(h.adapter.requests.length, 2);
  assert.deepEqual((await h.service.history(h.original)).events, before.events);
  const physical = await h.nativeEvents();
  const echo = physical.find(
    (event) => event.type === 'user/message' && event.data.id === receipt.messageId,
  );
  assert.equal(echo.data.source.rpcId, input.requestId);
  assert.ok(
    physical.some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data.inserted?.some(
          (m) => m.id === receipt.messageId && m.source.rpcId === input.requestId,
        ),
    ),
  );
  assert.equal(await h.manager.stop(opened.grant), 'stopped');
  const next = await h.open();
  assert.equal(next.grant.chatEpoch, 2);
  await h.conversation.send(next.grant, input);
  assert.equal(resumes, 1, 'a reconciled duplicate does not even resume an Agent');
  await h.conversation.send(next.grant, { requestId: 'chat-second', text: 'one more chat turn' });
  await h.ctx.agents.get(h.binding.nativeSessionId).whenIdle();
  assert.equal(resumes, 2);
  assert.equal(h.adapter.requests.length, 3);
  assert.deepEqual(
    (await h.service.readOriginalPrefix(h.original, h.original.signal)).events,
    before.events,
  );
}, 30_000);

it('official ClientSessions: the original composer retires its pending echo from C durable user/inbox events carrying the same requestId', async (t) => {
  const h = await nativeChat(t),
    opened = await h.open();
  const sid = SessionId(h.binding.nativeSessionId),
    baseline = await h.nativeEvents();
  const handle = await h.ctx.sessionPersistence.open(sid, 'read');
  const header = handle.header;
  await handle.close();
  const feed = [],
    yielded = [],
    wake = { current: undefined };
  const push = (event) => {
    feed.push({ type: 'event', event });
    wake.current?.();
    wake.current = undefined;
  };
  const remove = h.ctx.on(
    'session/event',
    (session, event) => {
      if (session.id === sid) push(event);
    },
    { global: true },
  );
  t.onTestFinished(remove);
  const unsupported = () => {
    throw Error('Unexpected ordinary SDK transport operation.');
  };
  const remote = {
    $stream(options) {
      // Original SDK stream owner. Only this local transport is a contract;
      // original ClientSessions, Session and actual durable events are reused.
      return new RemoteStream(
        {
          generation: {
            getSnapshot: () => ({ id: 1, host: { home: '/fixture' } }),
            subscribe: () => () => {},
          },
        },
        options,
      );
    },
    session: {
      list: async () => ({
        ok: true,
        value: {
          items: [
            { sessionId: sid, agentAvailable: true, running: false, blank: false, updatedAt: 1 },
          ],
        },
      }),
      page: async (query) => {
        const live = h.ctx.agents.get(sid);
        if (live) await h.ctx.sessions.flush(live.session);
        const events = (await h.nativeEvents()).filter(
          (event) =>
            event.seq <= query.throughSeq &&
            (query.beforeSeq === undefined || event.seq < query.beforeSeq),
        );
        return {
          ok: true,
          value: { records: events.map((event) => ({ type: 'event', event })), hasMore: false },
        };
      },
      follow(_query, provided) {
        const lifetime = new AbortController(),
          signal = provided ? AbortSignal.any([provided, lifetime.signal]) : lifetime.signal;
        const iterator = (async function* () {
          yield {
            type: 'snapshot',
            header,
            cursor: baseline.at(-1)?.seq ?? -1,
            records: baseline.map((event) => ({ type: 'event', event })),
            hasMore: false,
            projections: {
              asOfSeq: baseline.at(-1)?.seq ?? -1,
              values: { inbox: { 'next-turn': [], 'next-step': [] } },
            },
            assistantStream: { revision: 0 },
          };
          while (!signal.aborted) {
            if (!feed.length)
              await new Promise<void>((resolve) => {
                wake.current = resolve;
                signal.addEventListener('abort', resolve, { once: true });
              });
            while (feed.length && !signal.aborted) {
              const frame = feed.shift();
              yielded.push(frame.event.seq);
              yield frame;
            }
          }
        })();
        return {
          [Symbol.asyncIterator]: () => iterator,
          send: unsupported,
          end() {},
          dispose() {
            lifetime.abort();
          },
        };
      },
      prompt: async (query) => {
        await h.conversation.send(opened.grant, {
          requestId: query.requestId,
          text: query.content.map((part) => part.text ?? '').join('\n'),
        });
        return { ok: true, value: { accepted: true } };
      },
      cancel: async () => {
        await h.manager.stop(opened.grant);
        return { ok: true, value: { accepted: true } };
      },
    },
    commands: { execute: unsupported },
    subagents: { prompt: unsupported, interruptByParent: unsupported },
  };
  const ctx = new Context(),
    sessions = new ClientSessions(ctx, remote);
  t.onTestFinished(() => ctx.fiber.dispose());
  await sessions.refresh();
  const reference = sessions.retain(sid, { source: 'mainView' });
  t.onTestFinished(() => reference.release());
  await reference.ready;
  const ui = reference.binding.session,
    retirements = [];
  const submission = ui.beginSubmission({
    mode: 'queue',
    text: 'keep the original echo identity',
    attachments: [],
    onRetire: (value) => retirements.push(value),
  });
  assert.equal(ui.getSnapshot().pendingSubmissions[0].requestId, submission.requestId);
  assert.equal(
    (
      await ui.prompt(
        [{ type: 'text', text: 'keep the original echo identity' }],
        'queue',
        undefined,
        submission.requestId,
      )
    ).ok,
    true,
  );
  const agent = h.ctx.agents.get(sid);
  await agent.whenIdle();
  await h.ctx.sessions.flush(agent.session);
  const physical = await h.nativeEvents();
  const messages = physical.filter(
    (event) => event.type === 'user/message' && event.data.source.rpcId === submission.requestId,
  );
  assert.equal(messages.length, 1);
  const restored = h.ctx.sessionProjections.restore({}, physical, 0, header, 0);
  ui.projections.apply('inbox', restored.snapshot.values.inbox, restored.snapshot.asOfSeq);
  for (let i = 0; i < 100 && ui.getSnapshot().pendingSubmissions.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    ui.getSnapshot().pendingSubmissions,
    [],
    JSON.stringify({
      open: ui.getSnapshot().openState,
      error: ui.getSnapshot().openError?.message,
      queuedFrames: feed.length,
      yielded,
      events: physical.map((event) => ({
        seq: event.seq,
        type: event.type,
        echo: event.data?.source?.rpcId === submission.requestId,
      })),
    }),
  );
  assert.equal(retirements.length, 1);
  assert.equal(retirements[0].reason, 'observed');
  assert.equal(sessions.retainInfo(sid).getSnapshot().retainedBy.mainView, 1);
}, 30_000);
