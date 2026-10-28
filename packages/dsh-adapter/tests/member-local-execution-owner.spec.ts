/** Original local SDK/factory/log/drain over actual HTTP; backend ACL is a contract. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  fixture,
  bootLocalOwner,
  toolResponse,
  response,
  SessionId,
  MemberLocalExecutionProtocol,
  MemberLocalExecutionSecrets,
  acceptedInputRef,
} from './zhuma-member-local-owner-bundle.ts';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-member-local-owner-')),
    remote = await fixture({ after: (fn) => t.onTestFinished(fn) }, options.remote ?? {}),
    protocol = await remote.open(),
    h = await bootLocalOwner(root, protocol, options),
    requestId = randomUUID(),
    prepared = await protocol.prepareAccept(requestId, remote.input),
    run = await prepared.send();
  t.onTestFinished(async () => {
    await h.close();
    await protocol.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...h, remote, protocol, run, root, requestId };
}
async function until(read, accept, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() >= deadline)
      throw Error('Actual owner did not reach the expected state: ' + value?.phase);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test('original local input owner: original tool reads remote accepted content only on demand before native fixed completion', async (t) => {
  let ref;
  const h = await setup(t, {
    remote: { upstream: true, text: 'UNIQUE_REMOTE_INPUT_😀汉', chunkBytes: 17 },
    script: [
      () => toolResponse({ inputRef: ref, part: 'text', limit: 20 })(),
      toolResponse(
        { text: 'Consumed fixed accepted input.', links: [] },
        'input-completion',
        'complete_work',
      ),
    ],
  });
  ref = acceptedInputRef(h.run.composition.payload.scope, h.run.composition.payload.inputs[0]);
  assert.equal(
    h.remote.seen.some((v) => v.request.operation === 'input-read'),
    false,
  );
  await h.owner.start(h.run);
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  assert.equal(h.adapter.requests.length, 2);
  assert(!JSON.stringify(h.adapter.requests[0]).includes('UNIQUE_REMOTE_INPUT_'));
  assert(JSON.stringify(h.adapter.requests[1]).includes('UNIQUE_REMOTE_INPUT_'));
  assert(h.remote.seen.filter((v) => v.request.operation === 'input-read').length > 1);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(
    h.remote.seen.find((v) => v.request.operation === 'submit-result').request.payload.draft.text,
    'Consumed fixed accepted input.',
  );
});
for (const modelInvocable of [true, false]) {
  test(`original member-local Skill owner: frozen modelInvocable=${modelInvocable} is enforced by the original scoped loader`, async (t) => {
    const invocation = { modelInvocable, userInvocable: !modelInvocable };
    const h = await setup(t, {
      remote: { skill: true, invocation },
      script: [
        toolResponse({ name: 'selected-skill' }, 'load-frozen-skill', 'skill'),
        toolResponse(
          { text: 'Fixed result after scoped Skill attempt.', links: [] },
          'skill-completion',
          'complete_work',
        ),
      ],
    });
    assert.equal(
      h.owner.constructor.resourceSource(h.ctx),
      h.run.composition.payload.resources.sourceVersion,
    );
    assert.deepEqual(h.run.composition.payload.resources.skills[0].invocation, invocation);
    assert(!h.run.composition.payload.context.includes('LOCAL_FROZEN_SKILL_BODY'));
    await h.owner.start(h.run);
    await until(
      () => h.owner.read(h.run),
      (v) => v.phase === 'submitted',
    );
    assert.equal(h.adapter.requests.length, 2);
    assert(!JSON.stringify(h.adapter.requests[0]).includes('LOCAL_FROZEN_SKILL_BODY'));
    assert.equal(
      JSON.stringify(h.adapter.requests[1]).includes('LOCAL_FROZEN_SKILL_BODY'),
      modelInvocable,
    );
    assert.equal(h.ctx.agents.list().length, 0);
  });
}
test('original local owner: actual native fixed result is drained before completed and submitted through HTTP', async (t) => {
  const h = await setup(t, {
    script: [
      toolResponse(
        { text: 'Actual local fixed output.', links: [] },
        'local-complete',
        'complete_work',
      ),
    ],
  });
  await h.owner.start(h.run);
  const delivered = await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  assert.equal(h.ctx.agents.list().length, 0, 'original Agent was actually disposed/closed');
  assert.equal(h.adapter.requests.length, 1);
  const events = h.remote.seen
    .filter(({ request }) => request.operation === 'event')
    .map(({ request }) => request.payload.event);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['received', 'accepted', 'completed'],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.equal(events[2].result.source.nativeSessionId, events[0].nativeSessionId);
  assert.equal(events[2].result.source.nativeAgentId, events[1].executorRunId);
  assert(events[2].result.source.cut.callSeq < events[2].result.source.cut.resultSeq);
  assert(events[2].result.source.cut.resultSeq < events[2].result.source.cut.turnEndSeq);
  const submission = h.remote.seen.find(
    ({ request }) => request.operation === 'submit-result',
  ).request;
  assert.deepEqual(submission.payload.result, events[2].result);
  assert.equal(submission.payload.draft.text, 'Actual local fixed output.');
  assert.deepEqual(submission.payload.draft.files, []);
  assert.equal(delivered.receipt.artifactVersionId, 'contract-artifact-version');
  await assert.rejects(
    h.owner.send(h.run, { requestId: randomUUID(), text: 'must not restart', mode: 'followup' }),
  );
  assert.equal(h.adapter.requests.length, 1);
});
test('original local owner: an ordinary reply remains work and close reports only actual drain', async (t) => {
  const h = await setup(t, { script: ['Ordinary reply is not a fixed result.'] });
  await h.owner.start(h.run);
  await until(
    () => h.adapter.requests.length,
    (n) => n === 1,
  );
  assert.equal(
    h.remote.seen.some(({ request }) => request.operation === 'submit-result'),
    false,
  );
  await h.owner.close();
  assert.equal(h.ctx.agents.list().length, 0);
  const cleanup = h.remote.seen.find(({ request }) => request.operation === 'cleanup').request;
  assert.equal(cleanup.payload.observation.kind, 'drained');
  assert.equal(cleanup.payload.observation.evidence.basis, 'flushed-and-closed');
  assert.equal(h.owner.read(h.run).phase, 'retired');
});
test('original local owner: unavailable model creates no Agent and uses original absent cleanup proof', async (t) => {
  const h = await setup(t, {
    assertModel() {
      throw Error('contract model unavailable');
    },
  });
  await assert.rejects(h.owner.start(h.run), /contract model unavailable/u);
  await h.owner.close();
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 0);
  const cleanup = h.remote.seen.find(({ request }) => request.operation === 'cleanup').request;
  assert.equal(cleanup.payload.observation.evidence.basis, 'absent-unadmitted');
  assert.equal(
    h.remote.seen.some(({ request }) => request.operation === 'event'),
    false,
  );
});
test('original local owner: Stop cannot report drain until the actual retained model call settles', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const h = await setup(t, {
    script: [
      async () => {
        await held;
        return response('Late response after explicit Stop.');
      },
    ],
  });
  t.onTestFinished(() => release());
  await h.owner.start(h.run);
  await until(
    () => h.adapter.requests.length,
    (n) => n === 1,
  );
  h.remote.stop();
  await h.owner.refresh(h.run);
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'retiring',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.remote.value().resources, 'held');
  assert.equal(
    h.remote.seen.some(({ request }) => request.operation === 'cleanup'),
    false,
  );
  await assert.rejects(
    h.owner.send(h.run, { requestId: randomUUID(), text: 'must not resume', mode: 'followup' }),
  );
  release();
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'retired',
  );
  assert.equal(h.remote.value().resources, 'settled');
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 1);
  const cleanup = h.remote.seen.find(({ request }) => request.operation === 'cleanup').request;
  assert.equal(cleanup.payload.observation.evidence.basis, 'flushed-and-closed');
});
test('original workspace: one real native session persists in the selected workspace and cold ordinary resume is gated', async (t) => {
  const h = await setup(t, { workspace: true, script: ['Selected workspace conversation.'] });
  await h.owner.start(h.run);
  const opened = h.owner.read(h.run),
    sid = opened.native.binding.nativeSessionId,
    wid = h.workspace.id;
  assert.deepEqual(h.workspace.sessionIds, [sid]);
  assert.equal(h.owner.lookupNativeSession(sid).binding.scope.runId, h.run.value.scope.runId);
  await h.owner.start(h.run);
  assert.deepEqual(h.workspace.sessionIds, [sid]);
  assert.equal(h.adapter.requests.length, 1);
  await h.close();
  const cold = await bootLocalOwner(h.root, h.protocol, { workspace: wid });
  t.onTestFinished(() => cold.close());
  assert.deepEqual(cold.workspace.sessionIds, [sid]);
  assert.equal(cold.owner.lookupNativeSession(sid).binding.nativeSessionId, sid);
  assert.equal(cold.ctx.agents.list().length, 0, 'navigation did not create/resume an Agent');
  await assert.rejects(
    cold.ctx.agents.resume({
      resumeSessionId: SessionId(sid),
      agentOptions: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    }),
    { code: 'scope-mismatch' },
  );
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.deepEqual(cold.workspace.sessionIds, [sid]);
});
test('original workspace: deletion during unpublished compose cannot attach a late session elsewhere', async (t) => {
  let release, entered;
  const pending = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      entered = resolve;
    });
  const h = await setup(t, {
    workspace: true,
    beforeCompose: async () => {
      entered();
      await pending;
    },
    script: ['must never execute'],
  });
  t.onTestFinished(() => release());
  const dispatch = h.owner.start(h.run);
  void dispatch.catch(() => undefined);
  await started;
  await h.ctx.workspaceRegistry.delete(h.workspace.id);
  const other = await h.ctx.workspaceRegistry.create(h.root, 'Other workspace');
  release();
  await assert.rejects(dispatch);
  assert.deepEqual(other.sessionIds, []);
  assert.equal(h.ctx.workspaceRegistry.get(h.workspace.id), undefined);
  assert.equal(h.adapter.requests.length, 0);
});
test('original cold result: same fixed cut is requalified with read-only authority and never restarts an Agent', async (t) => {
  const h = await setup(t, {
    remote: { submitFailures: 1 },
    script: [
      toolResponse(
        { text: 'Fixed before local restart.', links: [] },
        'fixed-before-restart',
        'complete_work',
      ),
    ],
  });
  await h.owner.start(h.run);
  await until(
    () => h.owner.read(h.run),
    (value) => value.phase === 'retired',
  );
  assert.equal(h.remote.value().runStatus, 'completed');
  assert.equal(h.remote.value().receipt, undefined);
  await h.close();
  const metadataPath = join(h.root, 'domains', 'zhuma_native_work_sessions.json'),
    before = await readFile(metadataPath, 'utf8'),
    protocol = await MemberLocalExecutionProtocol.open({
      ...h.remote.protocolOptions,
      secrets: new MemberLocalExecutionSecrets(h.remote.store),
    }),
    recovered = await protocol.recover({
      target: h.remote.input.target,
      acceptRequestId: h.requestId,
    }),
    cold = await bootLocalOwner(h.root, protocol, {
      assertModel() {
        assert.fail('cold result continuation must not resolve any model');
      },
    });
  t.onTestFinished(async () => {
    await cold.close();
    await protocol.close();
  });
  assert.equal(recovered.value.authority, 'commit-only');
  await assert.rejects(cold.owner.start(recovered), { code: 'remote-recovery-required' });
  await cold.owner.continueResult(recovered);
  const delivered = await until(
    () => cold.owner.read(recovered),
    (v) => v.phase === 'submitted',
  );
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(delivered.receipt.requestId, h.remote.value().result.requestId);
  assert.equal(
    h.remote.seen.filter(
      ({ request }) => request.operation === 'event' && request.payload.event.kind === 'completed',
    ).length,
    1,
  );
  assert.equal(h.remote.seen.filter(({ request }) => request.operation === 'accept').length, 1);
  assert.equal(
    await readFile(metadataPath, 'utf8'),
    before,
    'the original sealed native metadata is not rewritten',
  );
  await assert.rejects(
    cold.owner.send(recovered, { requestId: randomUUID(), text: 'must not run', mode: 'followup' }),
  );
  assert.equal(cold.adapter.requests.length, 0);
});
