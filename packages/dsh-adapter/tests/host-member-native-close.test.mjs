/** Actual A wrapper and original schemas with explicit deferred protocol/native
 * ports. These are closing-interleaving contracts, not real Run/SDK/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { MemberLocalExecutionProtocol } from '../dist/member-local-execution-protocol.js';
import { MemberLocalExecutionOwner } from '../dist/member-local-execution-owner.js';
import { openHostMemberNativeOwner } from '../dist/host-member-native-owner.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import { freezeExecutionRunComposition } from '../dist/execution-run-composition.js';
import { MEMBER_LOCAL_REMOTE_METHODS } from '../dist/host-remote-run-http.js';
const deferred = () => Promise.withResolvers();
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t, mode, { tools = 'text-only', files = false } = {}) {
  const ctx = new Context(),
    facts = compositionFacts(),
    trace = [];
  const target = {
    spaceId: facts.scope.spaceId,
    taskId: facts.scope.taskId,
    planId: facts.scope.planId,
    revision: facts.scope.revision,
    nodeId: facts.scope.nodeId,
  };
  const preparations = [];
  const composition = freezeExecutionRunComposition(facts);
  const accepted = {
    composition,
    value: {
      scope: { ...facts.scope, backendId: 'backend' },
      deviceId: 'device',
      nodeVersion: 1,
      runVersion: 1,
      resources: 'held',
    },
  };
  const metadataEntered = deferred(),
    metadataRelease = deferred(),
    sendEntered = deferred(),
    sendRelease = deferred(),
    cleanup = deferred();
  let stopped = false,
    physicallyClosed = false,
    uncertain = false,
    options;
  const originalProtocol = MemberLocalExecutionProtocol.open,
    originalNative = MemberLocalExecutionOwner.open;
  const protocol = {
    backendId: 'backend',
    actorId: facts.scope.actorId,
    deviceId: 'device',
    supportsFilePublishing: files,
    canSwitchBackend: () => !uncertain,
    async prepareAccept(_requestId, input) {
      preparations.push(structuredClone(input));
      trace.push('prepare');
      return {
        async send(signal) {
          trace.push('send');
          sendEntered.resolve();
          await sendRelease.promise;
          assert.equal(signal.aborted, false, 'cleanup lifetime must survive close');
          if (mode === 'unknown') {
            uncertain = true;
            throw Error('unknown accept result');
          }
          trace.push('accepted');
          return accepted;
        },
      };
    },
    async close() {
      trace.push('protocol-close');
    },
  };
  const native = {
    ...(files ? { acceptedFileSource: 'zhuma-accepted-files@2' } : {}),
    canSwitchBackend: () => true,
    lookupNativeSession: () => null,
    read(run) {
      assert.equal(run, accepted);
      if (!stopped) throw Error('not admitted');
      return { remote: { ...run.value, resources: cleanup.done ? 'settled' : 'held' } };
    },
    async stop(run) {
      assert.equal(run, accepted);
      assert.equal(physicallyClosed, false);
      stopped = true;
      trace.push('cleanup-only');
      await cleanup.promise;
      trace.push('cleanup-drained');
      return this.read(run);
    },
    async start() {
      trace.push('start');
      assert.fail('late accepted work must never start');
    },
    async close() {
      trace.push('native-close');
      physicallyClosed = true;
      if (mode === 'facts') await cleanup.promise;
    },
  };
  MemberLocalExecutionProtocol.open = async (input) => {
    options = input;
    return protocol;
  };
  MemberLocalExecutionOwner.open = async () => native;
  const backend = {
    async nativeConnection() {
      return {
        origin: 'http://synthetic.invalid',
        connectionId: 'connection',
        backendId: 'backend',
        actorId: facts.scope.actorId,
        async authentication() {
          trace.push('member-auth');
          return { cookie: 'SYNTHETIC_COOKIE' };
        },
      };
    },
    async request(input) {
      metadataEntered.resolve();
      if (mode === 'facts') await metadataRelease.promise;
      return {
        body: {
          type: 'server-response',
          rpcId: input.rpcId,
          result: {
            ok: true,
            value: {
              target,
              nodeVersion: 1,
              runVersion: 0,
              currentRunId: null,
              currentRun: null,
              selection: null,
              experts: [],
              resources: [],
              start: { kind: 'available' },
              tools,
            },
          },
        },
      };
    },
  };
  const owner = await openHostMemberNativeOwner(ctx, backend);
  t.after(async () => {
    cleanup.done = true;
    cleanup.resolve();
    metadataRelease.resolve();
    sendRelease.resolve();
    MemberLocalExecutionProtocol.open = originalProtocol;
    MemberLocalExecutionOwner.open = originalNative;
    await ctx.fiber.dispose();
  });
  const input = {
    ...target,
    requestId: 'accept',
    expectedNodeVersion: 1,
    expectedRunVersion: 0,
    newRunId: 'client-run',
    newSegmentId: 'client-segment',
    mode: 'begin',
    model: facts.model,
    executor: facts.executor,
    tools: 'text-only',
    workspace: { kind: 'text-only' },
  };
  return {
    owner,
    input,
    trace,
    metadataEntered,
    metadataRelease,
    sendEntered,
    sendRelease,
    cleanup,
    options,
    preparations,
    releaseCleanup() {
      cleanup.done = true;
      cleanup.resolve();
    },
  };
}

for (const tools of ['text-only', 'accepted-input-reader'])
  test(`member native preparation: ${tools} facts control input capabilities instead of caller ceilings`, async (t) => {
    const h = await setup(t, 'accept', { tools, files: true });
    const beginning = h.owner.handle(
      'begin',
      { ...h.input, tools: 'accepted-input-reader' },
      new AbortController().signal,
    );
    const failed = assert.rejects(beginning);
    await h.sendEntered.promise;
    assert.equal(h.preparations.length, 1);
    const offered = h.preparations[0].capabilities;
    assert.equal(offered.acceptedInput, tools === 'text-only' ? undefined : '1');
    assert.equal(
      offered.acceptedFile,
      tools === 'text-only' ? undefined : 'zhuma-accepted-files@2',
    );
    assert.equal(offered.knowledge, undefined);
    assert.equal(offered.resources, undefined);
    assert.equal(Object.hasOwn(h.preparations[0], 'newRunId'), false);
    assert.equal(Object.hasOwn(h.preparations[0], 'newSegmentId'), false);
    const closing = h.owner.close();
    h.sendRelease.resolve();
    await tick();
    h.releaseCleanup();
    await failed;
    await closing;
    assert.equal(h.trace.includes('start'), false);
  });

test('member native close: facts returning after admission closes cannot prepare, accept or start', async (t) => {
  const h = await setup(t, 'facts');
  const beginning = h.owner.handle('begin', h.input, new AbortController().signal);
  const failed = assert.rejects(beginning);
  await h.metadataEntered.promise;
  let closed = false;
  const closing = h.owner.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  h.metadataRelease.resolve();
  await failed;
  assert.equal(h.trace.includes('prepare'), false);
  assert.equal(h.trace.includes('send'), false);
  assert.equal(h.trace.includes('start'), false);
  h.releaseCleanup();
  await closing;
  assert.equal(h.trace.at(-1), 'protocol-close');
});

test('member native close: in-flight accept retains its issued handle for cleanup before closing the native owner', async (t) => {
  const h = await setup(t, 'accept');
  const beginning = h.owner.handle('begin', h.input, new AbortController().signal);
  const failed = assert.rejects(beginning);
  await h.sendEntered.promise;
  let closed = false;
  const closing = h.owner.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(h.trace.includes('native-close'), false);
  h.sendRelease.resolve();
  await tick();
  assert(h.trace.includes('cleanup-only'));
  assert.equal(h.trace.includes('start'), false);
  assert.equal(h.trace.includes('native-close'), false);
  const headers = new Headers(
    await h.options.authentication(new AbortController().signal, {
      method: MEMBER_LOCAL_REMOTE_METHODS.cleanup,
    }),
  );
  assert.equal(headers.get('origin'), 'http://synthetic.invalid');
  assert.equal(headers.has('cookie'), false);
  await assert.rejects(
    h.options.authentication(new AbortController().signal, {
      method: MEMBER_LOCAL_REMOTE_METHODS.accept,
    }),
  );
  h.releaseCleanup();
  await failed;
  await closing;
  assert(h.trace.indexOf('native-close') > h.trace.indexOf('cleanup-drained'));
});

test('member native close: unknown accept is fail-closed and never seals its original recovery protocol as a successful close', async (t) => {
  const h = await setup(t, 'unknown');
  const beginning = h.owner.handle('begin', h.input, new AbortController().signal);
  const failed = assert.rejects(beginning, /unknown accept result/);
  await h.sendEntered.promise;
  const closing = h.owner.close();
  const rejected = assert.rejects(closing);
  h.sendRelease.resolve();
  await failed;
  await rejected;
  assert.equal(h.trace.includes('protocol-close'), false);
  assert.equal(h.trace.includes('start'), false);
});
