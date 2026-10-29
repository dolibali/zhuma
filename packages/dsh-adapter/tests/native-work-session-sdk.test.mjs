/** Unpatched published SDK controls/characterization, never product retention proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { requireNativeInboxRetention } from '../dist/native-session-lifecycle.js';
import { nativeWorkSessionKey } from '../dist/native-work-session-record.js';
import {
  boot,
  grant,
  message,
  ScriptedAdapter,
  selection,
} from './native-work-session-fixture.mjs';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-sdk-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('published SDK: product factory guard rejects unsupported retention without creating a native session', async (t) => {
  const host = await boot(await home(t), new ScriptedAdapter([]));
  t.after(() => host.close());
  const current = grant();
  assert.throws(() => requireNativeInboxRetention(host.ctx.agents), {
    code: 'native-inbox-retention-unsupported',
  });
  await assert.rejects(host.service.send(current, message('start', 'must not run')), {
    code: 'native-inbox-retention-unsupported',
  });
  const binding = host.service.open(current).binding;
  assert.equal(
    await host.ctx.sessionPersistence.stat(SessionId(binding.nativeSessionId)),
    undefined,
  );
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
});

test('published SDK: product cold open/history still read pre-existing native facts without a factory', async (t) => {
  const root = await home(t);
  const host = await boot(root, new ScriptedAdapter([]));
  t.after(() => host.close());
  const current = grant();
  // Seed pre-existing native history with public SDK APIs only. This is a fixture,
  // before it is designated a task session. Once bound, ordinary factory resume
  // is forbidden; history remains readable without creating/resuming an Agent.
  const binding = {
    schemaVersion: 1,
    scope: { ...current.scope },
    selection: { ...selection },
    receipts: [],
    nativeSessionId: 'pre-existing-native-history',
    nativeAgentId: 'pre-existing-native-history',
  };
  const raw = await host.ctx.agents.create({
    sessionId: SessionId(binding.nativeSessionId),
    agentOptions: { provider: selection.provider, model: selection.model },
  });
  raw.agent.send(
    createUserMessage({
      content: [{ type: 'text', text: 'existing native input' }],
      source: { kind: 'user' },
    }),
    'next-turn',
    false,
  );
  await raw.dispose();
  await host.service.storage.write(nativeWorkSessionKey(current.scope), binding);
  await assert.rejects(
    host.ctx.agents.resume({
      resumeSessionId: SessionId(binding.nativeSessionId),
      agentOptions: { provider: selection.provider, model: selection.model },
    }),
    { code: 'scope-mismatch' },
  );
  assert.equal(host.service.open(current).status, 'detached');
  const history = await host.service.history(current);
  assert.ok(history.events.some((event) => event.type === 'agent/inbox/spliced'));
  assert.equal(host.ctx.agents.list().length, 0);
  assert.equal(host.adapter.requests.length, 0);
  await assert.rejects(host.service.updateQueue(current, { kind: 'remove', messageId: 'absent' }), {
    code: 'native-inbox-retention-unsupported',
  });
});

test('published SDK characterization: stop keepInbox retains live input but normal close cancels it durably', async (t) => {
  const root = await home(t);
  const host = await boot(root, new ScriptedAdapter([]));
  let reopened;
  const id = SessionId('unpatched-native-characterization');
  try {
    const raw = await host.ctx.agents.create({
      sessionId: id,
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'pending native input' }],
      source: { kind: 'user' },
    });
    raw.agent.send(queued, 'next-turn', false);
    raw.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await raw.agent.whenIdle();
    assert.deepEqual(
      raw.agent.inbox.nextTurn.map((item) => item.id),
      [queued.id],
    );
    await host.close();
    reopened = await boot(root, new ScriptedAdapter([]));
    const reader = await reopened.ctx.sessionPersistence.open(id, 'read');
    const persisted = await reader.read();
    await reader.close();
    assert.ok(
      persisted.events.some(
        (event) => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled',
      ),
    );
    const resumed = await reopened.ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: selection.provider, model: selection.model },
    });
    assert.deepEqual(resumed.agent.inbox.nextTurn, []);
    assert.equal(resumed.agent.status, 'idle');
    assert.equal(reopened.adapter.requests.length, 0);
    await resumed.dispose();
  } finally {
    await reopened?.close();
    await host.close();
  }
});
