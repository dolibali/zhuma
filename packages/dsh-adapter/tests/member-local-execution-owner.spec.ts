/** Original local SDK/factory/log/drain over actual HTTP; backend ACL is a contract. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
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
test('backend switch fence: original owner distinguishes held idle work, fixed settlement and retained cold reads without side effects', async (t) => {
  let authentication;
  const h = await setup(t, {
    remote: { beforeAuthentication: () => authentication?.promise },
    workspace: true,
    script: [
      'An idle turn still owns the unfinished work.',
      toolResponse({ text: 'Fixed result.', links: [] }, 'switch-complete', 'complete_work'),
    ],
  });
  assert.equal(h.owner.canSwitchBackend(), true);
  assert.equal(h.protocol.supportsIndependentReviews, false);
  await h.owner.start(h.run);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.owner.canSwitchBackend(), false, 'an idle native turn is still held work');
  await h.owner.send(h.run, {
    requestId: randomUUID(),
    text: 'Finish the work.',
    mode: 'followup',
  });
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  await until(() => h.owner.canSwitchBackend(), Boolean);
  const sid = h.owner.read(h.run).native.binding.nativeSessionId;
  await h.close();
  await h.protocol.close();
  const coldProtocol = await MemberLocalExecutionProtocol.open({
    ...h.remote.protocolOptions,
    secrets: new MemberLocalExecutionSecrets(h.remote.store),
  });
  t.onTestFinished(() => coldProtocol.close());
  const cold = await bootLocalOwner(h.root, coldProtocol, {
    workspace: h.workspace.id,
    assertModel: () => assert.fail('cold history cannot resolve a model'),
  });
  t.onTestFinished(() => cold.close());
  const opened = await cold.owner.openSession(sid),
    path = join(h.root, 'domains', 'zhuma_native_work_sessions.json'),
    before = await readFile(path, 'utf8'),
    rows = structuredClone([...h.remote.rows]),
    cut = h.remote.seen.length;
  assert.equal(cold.owner.canSwitchBackend(), true);
  authentication = Promise.withResolvers();
  const reading = cold.owner.history(opened.run);
  try {
    assert.equal(cold.owner.canSwitchBackend(), false, 'unfinished original read is retained');
    for (let index = 0; index < 20; index++) assert.equal(cold.owner.canSwitchBackend(), false);
    assert.equal(h.remote.seen.length, cut, 'pure checks issue no HTTP requests');
  } finally {
    authentication.resolve();
    authentication = undefined;
  }
  assert((await reading).events.length > 0);
  await until(() => cold.owner.canSwitchBackend(), Boolean);
  const afterRead = h.remote.seen.length;
  for (let index = 0; index < 20; index++) assert.equal(cold.owner.canSwitchBackend(), true);
  assert.equal(h.remote.seen.length, afterRead);
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.deepEqual([...h.remote.rows], rows);
  assert.equal(await readFile(path, 'utf8'), before);
});
test('shutdown fence: a late actual accepted handle is retired without starting an Agent even when fresh member authentication is unavailable', async (t) => {
  let loggedOut = false,
    cleanupMethod;
  const h = await setup(t, {
    remote: {
      beforeAuthentication: (_signal, context) => {
        if (loggedOut && context.method !== cleanupMethod)
          throw Error('FRESH_MEMBER_AUTH_UNAVAILABLE');
      },
    },
  });
  cleanupMethod = h.remote.protocolOptions.methods.cleanup;
  loggedOut = true;
  // A must hand every actual late accept to stop BEFORE closing the owner.
  // The failed business Stop wait does not revoke its independent cleanup.
  const stopping = h.owner
    .stop(h.run, {
      requestId: randomUUID(),
      expectedNodeVersion: h.run.value.nodeVersion,
      expectedRunVersion: h.run.value.runVersion,
    })
    .catch((error) => error);
  await h.owner.close();
  assert((await stopping) instanceof Error);
  const view = h.owner.read(h.run);
  assert.equal(view.phase, 'retired');
  assert.equal(view.remote.resources, 'settled');
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 0);
  const cleanup = h.remote.seen.find((v) => v.request.operation === 'cleanup').request;
  assert.equal(cleanup.payload.observation.evidence.basis, 'absent-unadmitted');
});

test('shutdown fence: stop then close retains a real native model source until its original cleanup finishes', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const h = await setup(t, {
    script: [
      async () => {
        entered.resolve();
        await release.promise;
        return response('Late original source.');
      },
    ],
  });
  t.onTestFinished(() => release.resolve());
  await h.owner.start(h.run);
  await entered.promise;
  const stopping = h.owner
    .stop(h.run, {
      requestId: randomUUID(),
      expectedNodeVersion: h.owner.read(h.run).remote.nodeVersion,
      expectedRunVersion: h.owner.read(h.run).remote.runVersion,
    })
    .catch((error) => error);
  let closed = false;
  const closing = h.owner.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false);
  assert.equal(h.owner.read(h.run).remote.resources, 'held');
  release.resolve();
  await stopping;
  await closing;
  assert.equal(h.owner.read(h.run).remote.resources, 'settled');
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(
    h.remote.seen.find((v) => v.request.operation === 'cleanup').request.payload.observation
      .evidence.basis,
    'flushed-and-closed',
  );
});

test('native turn boundary: actual max-token idle is visible and same Run followup still requires the real completion tool', async (t) => {
  const h = await setup(t, {
    script: [
      () =>
        response('Bounded first turn.').map((chunk) =>
          chunk.type === 'finish' ? { ...chunk, reason: { kind: 'max-tokens' } } : chunk,
        ),
      toolResponse(
        { text: 'Explicit same Run completion.', links: [] },
        'after-boundary-complete',
        'complete_work',
      ),
    ],
  });
  await h.owner.start(h.run);
  await until(
    () => h.owner.read(h.run),
    (v) => v.native?.status === 'idle',
  );
  const before = h.owner.read(h.run),
    sid = before.native.binding.nativeSessionId,
    abort = new AbortController(),
    stream = h.owner.observe(h.run, -1, abort.signal);
  let boundary;
  try {
    for (let n = 0; n < 50; n++) {
      const frame = await stream.next();
      if (frame.value?.type === 'turn-end') {
        boundary = frame.value;
        break;
      }
    }
  } finally {
    abort.abort();
    await stream.return();
  }
  assert.equal(boundary.reason.kind, 'max-tokens');
  assert.equal(before.phase, 'working');
  assert.equal(before.remote.runStatus, 'running');
  assert.equal(before.remote.resources, 'held');
  assert.equal(
    h.remote.seen.some((v) => v.request.operation === 'submit-result'),
    false,
  );
  await h.owner.send(h.run, {
    requestId: randomUUID(),
    text: 'Finish this same work.',
    mode: 'followup',
  });
  const done = await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  assert.equal(done.native.binding.nativeSessionId, sid);
  assert.equal(h.remote.acceptCalls(), 1);
  assert.equal(h.adapter.requests.length, 2);
});

test('member knowledge owner: actual original tool waits genuine admission, supplies only catalog metadata and keeps draft consent off', async (t) => {
  const body = 'FROZEN_KNOWLEDGE_BODY',
    checksum = createHash('sha256').update(body).digest('hex'),
    reference = { spaceId: 'north', libraryId: 'library-a', pageId: 'guide', version: 1, checksum },
    summary = {
      reference,
      title: 'Guide',
      format: 'markdown',
      ownerActorId: 'chen',
      pageRevision: 2,
      bytes: Buffer.byteLength(body),
      publishedAt: '2026-10-28T00:00:00.000Z',
    },
    calls = [];
  let h,
    factories = 0,
    gates = 0;
  const knowledge = {
    create(binding, grant) {
      factories++;
      assert.deepEqual(binding.scope, grant.scope);
      return {
        catalog: {
          scope: binding.scope,
          library: {
            id: 'library-a',
            spaceId: 'north',
            name: 'Selected knowledge metadata',
            kind: 'team',
            canCreate: true,
          },
        },
        allowDrafts: false,
        assertCurrent(signal) {
          gates++;
          assert.equal(signal.aborted, false);
          assert(
            h.remote.seen.some(
              (v) => v.request.operation === 'event' && v.request.payload.event.kind === 'accepted',
            ),
          );
        },
        async invoke(request) {
          calls.push(request.action);
          if (request.action === 'search')
            return {
              ok: true,
              value: {
                actorId: 'chen',
                spaceId: 'north',
                libraryIds: ['library-a'],
                query: request.payload.query,
                hits: [{ ...summary, snippet: 'fixed reference' }],
                complete: true,
              },
            };
          assert.equal(request.action, 'read');
          return {
            ok: true,
            value: {
              actorId: 'chen',
              spaceId: 'north',
              reference,
              part: 'body',
              title: 'Guide',
              format: 'markdown',
              text: body,
              offset: 0,
              length: Buffer.byteLength(body),
              nextOffset: Buffer.byteLength(body),
              totalBytes: Buffer.byteLength(body),
              partChecksum: checksum,
              sources: [],
            },
          };
        },
      };
    },
  };
  h = await setup(t, {
    remote: { knowledge: true },
    knowledge,
    script: [
      (request) => {
        assert.equal(factories, 1);
        assert.equal(gates, 0);
        assert.equal(calls.length, 0);
        assert(JSON.stringify(request).includes('Selected knowledge metadata'));
        assert(!JSON.stringify(request).includes(body));
        return toolResponse(
          { request: { action: 'search', query: 'guide' } },
          'knowledge-search',
          'knowledge',
        )();
      },
      () =>
        toolResponse(
          { request: { action: 'read', reference: { pageId: 'guide', version: 1, checksum } } },
          'knowledge-read',
          'knowledge',
        )(),
      (request) => {
        assert(JSON.stringify(request).includes(body));
        return toolResponse(
          {
            request: {
              action: 'propose-draft',
              pageId: 'guide',
              expectedVersion: 2,
              idempotencyKey: 'draft-off',
              content: { title: 'Guide', format: 'markdown', text: 'Draft', sources: [reference] },
            },
          },
          'knowledge-draft-off',
          'knowledge',
        )();
      },
      () =>
        toolResponse(
          { text: 'Read the exact knowledge version.', links: [] },
          'knowledge-complete',
          'complete_work',
        )(),
    ],
  });
  assert.equal(h.owner.knowledgeSource, 'zhuma-native-knowledge@1');
  await h.owner.start(h.run);
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  assert.deepEqual(calls, ['search', 'read']);
  assert(gates >= 4);
  assert.equal(h.adapter.requests.length, 4);
  assert.equal(h.ctx.agents.list().length, 0);
});

test('member knowledge owner: a frozen knowledge capability without the actual private factory refuses before any native model', async (t) => {
  const h = await setup(t, { remote: { knowledge: true } });
  assert.equal(h.owner.knowledgeSource, undefined);
  await assert.rejects(h.owner.start(h.run), { code: 'configuration-mismatch' });
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.ctx.agents.list().length, 0);
  await h.owner.stop(h.run, {
    requestId: randomUUID(),
    expectedNodeVersion: h.run.value.nodeVersion,
    expectedRunVersion: h.run.value.runVersion,
  });
});

test('original owner replay: two actually issued accept handles address the same live native work', async (t) => {
  const h = await setup(t, {
    script: ['First response.', 'Second explicit followup.', 'Same active session from workspace.'],
  });
  await h.owner.start(h.run);
  const replay = await (await h.protocol.prepareAccept(h.requestId, h.remote.input)).send();
  assert.notEqual(replay, h.run);
  await h.owner.start(replay);
  assert.equal(
    h.owner.read(replay).native.binding.nativeSessionId,
    h.owner.read(h.run).native.binding.nativeSessionId,
  );
  await h.owner.send(replay, {
    requestId: randomUUID(),
    text: 'Explicit followup',
    mode: 'followup',
  });
  await until(
    () => h.adapter.requests.length,
    (n) => n === 2,
  );
  assert.equal(h.ctx.agents.list().length, 1);
  const fromWorkspace = await h.owner.openSession(
    h.owner.read(replay).native.binding.nativeSessionId,
  );
  await h.owner.send(fromWorkspace.run, {
    requestId: randomUUID(),
    text: 'Explicit send from the same workspace conversation',
    mode: 'followup',
  });
  await until(
    () => h.adapter.requests.length,
    (n) => n === 3,
  );
  const abort = new AbortController(),
    stream = h.owner.observe(replay, -1, abort.signal);
  assert.equal((await stream.next()).done, false);
  abort.abort();
  await stream.return();
  const state = h.owner.handles.get(replay);
  state.deadline = performance.now() - 1;
  const readonly = await h.owner.open(replay);
  assert.equal(readonly.remote.resources, 'held');
  assert.equal(
    readonly.native.binding.nativeSessionId,
    h.owner.read(h.run).native.binding.nativeSessionId,
  );
  assert((await h.owner.history(replay)).events.length > 0);
});
test('owner cache guard contract: 128 settled history entries do not consume live authority quota', async (t) => {
  const h = await setup(t, { script: ['One actual native Agent, not 128 models.'] });
  for (let i = 0; i < 128; i++)
    h.owner.states.set(`contract-terminal-${i}`, {
      phase: 'retired',
      view: { resources: 'settled' },
      abort: new AbortController(),
      scope: { ...h.run.composition.payload.scope, runId: `contract-terminal-${i}` },
    });
  await h.owner.start(h.run);
  assert.equal(h.adapter.requests.length, 1);
  await h.owner.close();
  assert(h.owner.states.size <= 128);
});
test('original workspace inbox: explicit live-drive queue editing uses the same native inbox and session', async (t) => {
  const release = Promise.withResolvers();
  const h = await setup(t, {
    script: [
      async () => {
        await release.promise;
        return response('Original model settled.');
      },
    ],
  });
  t.onTestFinished(() => release.resolve());
  try {
    await h.owner.start(h.run);
    await until(
      () => h.adapter.requests.length,
      (n) => n === 1,
    );
    const sid = h.owner.read(h.run).native.binding.nativeSessionId,
      opened = await h.owner.openSession(sid);
    const receipt = await h.owner.send(opened.run, {
      requestId: randomUUID(),
      text: 'Queued request',
      mode: 'queue',
    });
    const before = await h.owner.readInbox(opened.run);
    assert(before.items.some((item) => item.id === receipt.messageId));
    await h.owner.updateQueue(opened.run, {
      kind: 'edit',
      messageId: receipt.messageId,
      text: 'Edited queued request',
    });
    await h.owner.updateQueue(opened.run, { kind: 'reorder', messageIds: [receipt.messageId] });
    assert(
      (await h.owner.readInbox(opened.run)).items.some(
        (item) => item.text === 'Edited queued request',
      ),
    );
    await h.owner.updateQueue(opened.run, { kind: 'remove', messageId: receipt.messageId });
    assert(
      !(await h.owner.readInbox(opened.run)).items.some((item) => item.id === receipt.messageId),
    );
    assert.equal(h.adapter.requests.length, 1);
    assert.equal((await h.owner.open(opened.run)).native.binding.nativeSessionId, sid);
  } finally {
    release.resolve();
    await h.owner.close();
  }
});
test('original completed history: stable SID and cold read/observe/inbox perform no Agent/model or metadata writes', async (t) => {
  const h = await setup(t, {
    workspace: true,
    script: [
      toolResponse(
        { text: 'Completed conversation result.', links: [] },
        'history-complete',
        'complete_work',
      ),
    ],
  });
  await h.owner.start(h.run);
  const done = await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  const sid = done.native.binding.nativeSessionId;
  assert.equal((await h.owner.open(h.run)).native.binding.nativeSessionId, sid);
  await h.close();
  await h.protocol.close();
  const path = join(h.root, 'domains', 'zhuma_native_work_sessions.json'),
    before = await readFile(path, 'utf8');
  const coldProtocol = await MemberLocalExecutionProtocol.open({
    ...h.remote.protocolOptions,
    secrets: new MemberLocalExecutionSecrets(h.remote.store),
  });
  t.onTestFinished(() => coldProtocol.close());
  const cold = await bootLocalOwner(h.root, coldProtocol, {
    workspace: h.workspace.id,
    assertModel: () => assert.fail('read cannot resolve a model'),
  });
  t.onTestFinished(() => cold.close());
  const rows = structuredClone([...h.remote.rows]),
    cut = h.remote.seen.length;
  const opened = await cold.owner.openSession(sid);
  assert.equal(opened.view.native.binding.nativeSessionId, sid);
  const history = await cold.owner.history(opened.run, -1, 100);
  assert(history.events.length > 0);
  const inbox = await cold.owner.readInbox(opened.run);
  assert(inbox.receipts.length > 0);
  const abort = new AbortController();
  const stream = cold.owner.observe(opened.run, -1, abort.signal);
  const frame = await stream.next();
  assert.equal(frame.done, false);
  assert(['message', 'status', 'assistant-stream', 'gap'].includes(frame.value.type));
  abort.abort();
  await stream.return();
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.deepEqual([...h.remote.rows], rows);
  assert(h.remote.seen.slice(cut).every((v) => v.request.operation === 'status'));
  assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(
    cold.owner.send(opened.run, {
      requestId: randomUUID(),
      text: 'read handle cannot send',
      mode: 'followup',
    }),
  );
  await cold.close();
  assert.equal(await readFile(path, 'utf8'), before);
});
test('original local stop: actual retained model call holds resources until original retirement really drains', async (t) => {
  const release = Promise.withResolvers();
  const h = await setup(t, {
    script: [
      async () => {
        await release.promise;
        return response('Late actual model response.');
      },
    ],
  });
  t.onTestFinished(() => release.resolve());
  await h.owner.start(h.run);
  await until(
    () => h.adapter.requests.length,
    (n) => n === 1,
  );
  const current = await h.protocol.status(h.run),
    input = {
      requestId: randomUUID(),
      expectedNodeVersion: current.nodeVersion,
      expectedRunVersion: current.runVersion,
    };
  const stopped = await h.owner.stop(h.run, input);
  assert.equal(stopped.remote.resources, 'held');
  assert.equal(
    h.remote.seen.some((v) => v.request.operation === 'cleanup'),
    false,
  );
  release.resolve();
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'retired',
  );
  assert.equal((await h.owner.stop(h.run, input)).remote.resources, 'settled');
  assert.equal(h.remote.seen.filter((v) => v.request.operation === 'cleanup').length, 1);
  assert.equal(h.adapter.requests.length, 1);
  assert.equal(h.ctx.agents.list().length, 0);
});
test('original local stop: lost HTTP ACK remains unknown while local retirement still requires actual drain', async (t) => {
  const release = Promise.withResolvers();
  const h = await setup(t, {
    remote: { loseStop: true },
    script: [
      async () => {
        await release.promise;
        return response('Late stopped response.');
      },
    ],
  });
  t.onTestFinished(() => release.resolve());
  await h.owner.start(h.run);
  await until(
    () => h.adapter.requests.length,
    (n) => n === 1,
  );
  const current = await h.protocol.status(h.run),
    input = {
      requestId: randomUUID(),
      expectedNodeVersion: current.nodeVersion,
      expectedRunVersion: current.runVersion,
    };
  await assert.rejects(h.owner.stop(h.run, input), { outcome: 'unknown' });
  assert.equal(h.remote.value().resources, 'held');
  release.resolve();
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'retired',
  );
  assert.equal((await h.owner.stop(h.run, input)).remote.resources, 'settled');
});
test('original local stop: revoked member history/control cannot prevent the independent actual local cleanup', async (t) => {
  let revoked = false;
  const release = Promise.withResolvers();
  const h = await setup(t, {
    remote: {
      stopError: 'remote-forbidden',
      statusError: () => (revoked ? 'remote-forbidden' : undefined),
    },
    script: [
      async () => {
        await release.promise;
        return response('Retained original source.');
      },
    ],
  });
  t.onTestFinished(() => release.resolve());
  await h.owner.start(h.run);
  await until(
    () => h.adapter.requests.length,
    (n) => n === 1,
  );
  const view = await h.protocol.status(h.run);
  revoked = true;
  await assert.rejects(
    h.owner.stop(h.run, {
      requestId: randomUUID(),
      expectedNodeVersion: view.nodeVersion,
      expectedRunVersion: view.runVersion,
    }),
    { code: 'remote-forbidden' },
  );
  assert.equal(h.remote.value().resources, 'held');
  release.resolve();
  await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'retired',
  );
  assert.equal(h.remote.value().resources, 'settled');
  assert.equal(h.ctx.agents.list().length, 0);
});
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

test('public member history: actual large native replay uses the bounded whitelist with zero cold Agent/model or binding writes', async (t) => {
  const text = '中'.repeat(18000);
  const h = await setup(t, {
    workspace: true,
    script: [
      text,
      text,
      text,
      toolResponse({ text: 'Fixed.', links: [] }, 'large-history-complete', 'complete_work'),
    ],
  });
  await h.owner.start(h.run);
  for (let i = 0; i < 3; i++) {
    await h.owner.send(h.run, { requestId: randomUUID(), text: 'Continue.', mode: 'followup' });
    const actor = h.ctx.agents.list()[0];
    if (actor) await actor.whenIdle();
  }
  const done = await until(
    () => h.owner.read(h.run),
    (v) => v.phase === 'submitted',
  );
  const sid = done.native.binding.nativeSessionId;
  const handle = await h.ctx.sessionPersistence.open(SessionId(sid), 'read');
  let raw;
  try {
    raw = (await handle.read(0, 100)).events;
  } finally {
    await handle.close();
  }
  assert(
    Buffer.byteLength(JSON.stringify(raw)) > 262144,
    'Actual native aggregate exceeds the original public budget',
  );
  assert(
    raw.every((e) => Buffer.byteLength(JSON.stringify(e)) < 262144),
    'Each original SDK record fits alone',
  );
  await h.close();
  await h.protocol.close();
  const coldProtocol = await MemberLocalExecutionProtocol.open({
    ...h.remote.protocolOptions,
    secrets: new MemberLocalExecutionSecrets(h.remote.store),
  });
  t.onTestFinished(() => coldProtocol.close());
  const cold = await bootLocalOwner(h.root, coldProtocol, {
    workspace: h.workspace.id,
    assertModel: () => assert.fail('history must not resolve models'),
  });
  t.onTestFinished(() => cold.close());
  const path = join(h.root, 'domains', 'zhuma_native_work_sessions.json'),
    before = await readFile(path, 'utf8');
  const rows = structuredClone([...h.remote.rows]),
    cut = h.remote.seen.length;
  const opened = await cold.owner.openSession(sid),
    events = [];
  for (let i = 0; i < 10; i++) {
    const page = await cold.owner.history(opened.run, events.at(-1)?.seq ?? -1, 100);
    assert(Buffer.byteLength(JSON.stringify(page.events)) <= 262144);
    if (!page.events.length) break;
    events.push(...page.events);
  }
  assert.deepEqual(
    events.map((e) => e.seq),
    raw.map((e) => e.seq),
  );
  assert.equal(
    events
      .filter((e) => e.type === 'assistant/message')
      .flatMap((e) => e.data.message.content)
      .filter((b) => b.text === text).length,
    3,
  );
  assert(events.some((e) => e.type === 'redacted'));
  assert(events.some((e) => e.type === 'turn/end'));
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(cold.ctx.agents.list().length, 0);
  assert.deepEqual([...h.remote.rows], rows);
  assert(h.remote.seen.slice(cut).every((v) => v.request.operation === 'status'));
  assert.equal(await readFile(path, 'utf8'), before);
  console.log(
    'PUBLIC_HISTORY_BYTE_PROOF',
    JSON.stringify({
      rawEvents: raw.length,
      rawBytes: Buffer.byteLength(JSON.stringify(raw)),
      largestRawEvent: Math.max(...raw.map((e) => Buffer.byteLength(JSON.stringify(e)))),
      publicBytes: Buffer.byteLength(JSON.stringify(events)),
      readModelCalls: cold.adapter.requests.length,
      readAgents: cold.ctx.agents.list().length,
    }),
  );
  h.remote.changeScope();
  await assert.rejects(cold.owner.history(opened.run), { code: 'local-mismatch' });
  assert.equal(cold.adapter.requests.length, 0);
  assert.equal(await readFile(path, 'utf8'), before);
  await cold.close();
  assert.equal(await readFile(path, 'utf8'), before);
});
