import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { observeHostNativeRun } from '../dist/host-run-observation.js';

// Correlation contracts over the actual event bus. Agent publication, member
// authority, native I/O and model admission are not certified by these fixtures.
function fixture() {
  const ctx = new Context();
  const revoked = new AbortController();
  const scope = {
    actorId: 'member',
    spaceId: 'team',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
  };
  const binding = {
    scope,
    nativeSessionId: 'native-session',
    nativeAgentId: 'native-agent',
  };
  const session = { id: binding.nativeSessionId };
  const agent = { id: binding.nativeAgentId, session };
  ctx.provide('agents', { get: (id) => (id === agent.id ? agent : undefined) });
  const observation = observeHostNativeRun(ctx, binding, {
    scope,
    signal: revoked.signal,
    assertCurrent() {},
  });
  const claimed = (id, seq) => {
    const data = { id };
    Object.defineProperty(data, 'content', {
      get() {
        throw Error('The correlation observer must not read message bodies');
      },
    });
    ctx.emit('session/event', session, { type: 'user/message', seq, data });
  };
  return { ctx, revoked, binding, session, agent, observation, claimed };
}

test('Host native observation contract: subscribe before publication, correlate only the actual published Agent and retain IDs without bodies', async () => {
  const f = fixture();
  try {
    f.claimed('before-publication', 1);
    assert.equal(f.observation.claimFor('before-publication'), undefined);
    await f.ctx.serial('agent/created', { agent: { ...f.agent }, source: 'create' });
    f.claimed('foreign-object', 2);
    assert.equal(f.observation.claimFor('foreign-object'), undefined);
    await f.ctx.serial('agent/created', { agent: f.agent, source: 'create' });
    const claims = [];
    const stop = f.observation.onClaim((value) => claims.push(value));
    f.claimed('reserved-message', 3);
    assert.deepEqual(f.observation.claimFor('reserved-message'), {
      nativeSessionId: 'native-session',
      nativeAgentId: 'native-agent',
      messageId: 'reserved-message',
      sequence: 3,
    });
    assert.equal(claims.length, 1);
    f.claimed('reserved-message', 3);
    assert.equal(claims.length, 1);
    stop();
    f.claimed('later-message', 4);
    assert.equal(claims.length, 1);
  } finally {
    await f.ctx.fiber.dispose();
  }
});

test('Host native observation contract: grant revocation or explicit release clears pending correlation and listeners', async () => {
  for (const reason of ['close', 'revoke']) {
    const f = fixture();
    try {
      await f.ctx.serial('agent/created', { agent: f.agent, source: 'create' });
      f.claimed('reserved-message', 1);
      assert.ok(f.observation.claimFor('reserved-message'));
      if (reason === 'close') f.observation.close();
      else f.revoked.abort();
      assert.equal(f.observation.signal.aborted, true);
      assert.equal(f.observation.claimFor('reserved-message'), undefined);
      f.claimed('late-message', 2);
      assert.equal(f.observation.claimFor('late-message'), undefined);
    } finally {
      await f.ctx.fiber.dispose();
    }
  }
});

test('Host native observation contract: fast actual disposal preserves the original claim until the late send receipt joins', async () => {
  const f = fixture();
  try {
    await f.ctx.serial('agent/created', { agent: f.agent, source: 'create' });
    f.claimed('reserved-message', 7);
    const original = f.observation.claimFor('reserved-message');
    f.ctx.emit('agent/disposed', { agent: f.agent });
    await f.ctx.fiber.dispose();
    assert.equal(f.observation.signal.aborted, false);
    assert.deepEqual(f.observation.claimFor('reserved-message'), original);
    f.claimed('late-message', 8);
    assert.equal(f.observation.claimFor('late-message'), undefined);
    f.revoked.abort();
    assert.equal(f.observation.signal.aborted, true);
    assert.equal(f.observation.claimFor('reserved-message'), undefined);
  } finally {
    f.observation.close();
    await f.ctx.fiber.dispose();
  }
});

test('Host native observation contract: only the actual published Agent error/disposal reports a fault, without inspecting its error', async () => {
  for (const kind of ['agent/error', 'agent/disposed']) {
    const f = fixture();
    try {
      let faults = 0;
      f.observation.onFault(() => faults++);
      await f.ctx.serial('agent/created', { agent: f.agent, source: 'create' });
      f.ctx.emit(kind, { agent: { ...f.agent } });
      assert.equal(faults, 0);
      const payload = { agent: f.agent };
      Object.defineProperty(payload, 'error', {
        get() {
          throw Error('Do not inspect the private native error');
        },
      });
      f.ctx.emit(kind, payload);
      assert.equal(faults, 1);
      f.ctx.emit(kind, payload);
      assert.equal(faults, 1);
    } finally {
      await f.ctx.fiber.dispose();
    }
  }
});
