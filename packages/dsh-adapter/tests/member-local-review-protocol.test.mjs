/** Real outgoing HTTP, original Service/JSON, Ed25519 and isolated original
 * CredentialsLocal. Member leases/resource qualifications/native cuts remain
 * explicit contracts; no actual native reviewer/model/GUI or A HTTP mount proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import {
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  remoteExecutionRequestSchema,
} from '@zhuma/agent-core';
import { MemberLocalReviewProtocol } from '../dist/member-local-review-protocol.js';
import { MemberLocalExecutionSecrets } from '../dist/member-local-execution-secrets.js';
import { createMemberLocalPrivateStore } from '../dist/host-member-local-credentials.js';
import { reviewHost } from './remote-review-fixture.mjs';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { businessHashes } from './execution-native-result-service-fixture.mjs';

async function fixture(t, options = {}) {
  const backend = await reviewHost(t);
  const local = await mkdtemp(join(tmpdir(), 'zhuma-local-review-'));
  const ctx = new Context(),
    life = new AbortController(),
    protocols = [],
    seen = [],
    faults = {};
  await ctx.plugin(Credentials, { path: join(local, 'credentials.yaml'), watch: false });
  const original = createMemberLocalPrivateStore(ctx, life.signal);
  const counts = { reads: 0, writes: 0, accepts: 0 };
  const store = {
    async read(key) {
      counts.reads++;
      return original.read(key);
    },
    async modify(key, update) {
      counts.writes++;
      if (key.startsWith('zhuma.member-local.run-pointer.') && faults.pointerGate) {
        faults.pointerEntered?.();
        await faults.pointerGate;
      }
      if (key.startsWith('zhuma.member-local.run-pointer.') && faults.pointer)
        throw Error('CONTRACT_POINTER_WRITE_FAILURE');
      return original.modify(key, update);
    },
  };
  const secrets = new MemberLocalExecutionSecrets(store);
  const methods = Object.fromEntries(
    REMOTE_RUN_OPERATIONS.map((op) => [op, `zhuma-review-proof/${op}`]),
  );
  const server = createServer(async (request, response) => {
    try {
      let text = '';
      for await (const chunk of request) text += chunk;
      const envelope = JSON.parse(text),
        body = remoteExecutionRequestSchema.parse(envelope.payload);
      assert.equal(request.url, `/api/${methods[body.operation]}`);
      assert.equal(request.headers.cookie, backend.request.headers.cookie);
      seen.push({
        body: structuredClone(body),
        privateHeader: typeof request.headers[REMOTE_RUN_PERMIT_HEADER] === 'string',
      });
      if (body.operation === 'accept') counts.accepts++;
      // The backend fixture's member issuer recognizes its original opaque
      // request object. HTTP cookie matching above is only a transport contract.
      let result = await backend.service.remoteRun(
        backend.request,
        body,
        request.headers[REMOTE_RUN_PERMIT_HEADER],
      );
      if (body.operation === 'accept' && faults.loseAccept) {
        faults.loseAccept = false;
        response.destroy();
        return;
      }
      result = structuredClone(result);
      options.mutate?.(body, result);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }));
    } catch (error) {
      faults.serverFailure = {
        name: error?.name,
        paths: error?.issues?.map((issue) => issue.path),
      };
      if (!response.destroyed) response.writeHead(503).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
    origin: `http://127.0.0.1:${server.address().port}`,
    methods,
    secrets,
    expectedActorId: 'chen',
    authentication: async () => ({ cookie: backend.request.headers.cookie }),
  };
  const open = async (patch = {}) => {
    let protocol;
    try {
      protocol = await MemberLocalReviewProtocol.open({ ...config, ...patch });
    } catch (error) {
      if (faults.serverFailure) throw Error(JSON.stringify(faults.serverFailure));
      throw error;
    }
    protocols.push(protocol);
    return protocol;
  };
  t.after(async () => {
    faults.release?.();
    for (const protocol of protocols) await protocol.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    life.abort();
    await ctx.fiber.dispose();
    await rm(local, { recursive: true, force: true });
  });
  const input = () => {
    const { credentials: _credentials, ...value } = backend.accept().payload;
    return value;
  };
  const start = async (protocol, requestId = randomUUID()) => {
    const args = input(),
      prepared = await protocol.prepareAccept(requestId, args),
      run = await prepared.send();
    let view = await protocol.command(run, {
      operation: 'event',
      payload: {
        event: {
          kind: 'received',
          sequence: run.value.nextSequence,
          nativeSessionId: 'local-review-native',
          nativeAgentId: 'local-review-native',
        },
      },
    });
    view = await protocol.command(run, {
      operation: 'event',
      payload: {
        event: {
          kind: 'accepted',
          sequence: view.nextSequence,
          nativeSessionId: 'local-review-native',
          nativeAgentId: 'local-review-native',
        },
      },
    });
    backend.setView(view);
    return { run, view, args, prepared };
  };
  const fixed = () => backend.fixed();
  const seal = (protocol, started, value) =>
    protocol.command(started.run, {
      operation: 'event',
      payload: {
        event: {
          kind: 'sealed',
          sequence: started.view.nextSequence,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result: value.result,
        },
      },
    });
  return {
    backend,
    local,
    ctx,
    store,
    secrets,
    counts,
    seen,
    faults,
    input,
    open,
    start,
    fixed,
    seal,
    config,
  };
}

test('local review carrier: original signed fixed target read, seal without vote, one original ballot then independent cleanup', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    started = await h.start(protocol),
    run = started.run;
  protocol.assertStartHandle(run);
  const resources = await protocol.command(run, { operation: 'input-list', payload: {} });
  const page = await protocol.command(run, {
    operation: 'input-read',
    payload: { resourceRef: resources.resources[0].resourceRef, offset: 0, length: 8192 },
  });
  assert.equal(
    Buffer.from(page.base64, 'base64').toString(),
    h.backend.read().artifactVersions[0].text,
  );
  assert.equal(page.source.context.review.principal.reviewerRef.id, 'qa');
  const fixed = h.fixed(),
    sealed = await h.seal(protocol, started, fixed);
  assert.equal(sealed.authority, 'commit-only');
  assert.equal(h.backend.read().rounds[0].ballots.length, 0);
  const committed = await protocol.command(run, {
    operation: 'submit-result',
    requestId: fixed.result.requestId,
    payload: { result: fixed.result, fixed: fixed.facts },
  });
  assert.equal(committed.status, 'committed');
  assert.equal(h.backend.read().rounds[0].ballots.length, 1);
  assert.equal(h.backend.read('consume').command.status, 'ready');
  const retired = await protocol.command(run, {
    operation: 'cleanup',
    payload: {
      observation: {
        kind: 'drained',
        sequence: sealed.nextSequence,
        evidence: {
          basis: 'flushed-and-closed',
          nativeSessionId: 'local-review-native',
          nativeAgentId: 'local-review-native',
        },
      },
    },
  });
  assert.equal(retired.resources, 'settled');
  assert.equal('receipt' in retired, false);
  assert.equal(h.backend.calls.backendModel, 0);
  assert.ok(
    h.seen
      .filter((x) => !['info', 'register-device'].includes(x.body.operation))
      .every((x) => x.body.purpose === 'review'),
  );
});

test('local review carrier: copied handles and foreign actor are refused before pointer or command IO', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    started = await h.start(protocol);
  const before = h.seen.length;
  await assert.rejects(
    protocol.command(structuredClone(started.run), { operation: 'status', payload: {} }),
    { code: 'local-mismatch' },
  );
  assert.equal(h.seen.length, before);
  await assert.rejects(h.open({ expectedActorId: 'other' }), { code: 'local-mismatch' });
  const binding = {
    scope: (({ backendId: _backend, review: _review, ...scope }) => scope)(started.run.value.scope),
    nativeSessionId: 'local-review-native',
    nativeAgentId: 'local-review-native',
    selection: started.run.value.selection,
  };
  protocol.assertReadBinding(started.run, binding);
  assert.throws(
    () => protocol.assertReadBinding(started.run, { ...binding, nativeSessionId: 'borrowed' }),
    { code: 'local-mismatch' },
  );
});

test('local review carrier: lost accept ACK reuses exact durable intent, one backend review lane, no automatic retry', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    args = h.input(),
    id = randomUUID();
  const prepared = await protocol.prepareAccept(id, args);
  h.faults.loseAccept = true;
  await assert.rejects(prepared.send());
  assert.equal(h.counts.accepts, 1);
  assert.equal(protocol.canSwitchBackend(), false);
  const again = await prepared.send();
  assert.equal(again.value.disposition, 'replayed');
  assert.equal(readExecutionReviewState(h.backend.read()).attempts.length, 1);
  const [one, two] = h.seen.filter((x) => x.body.operation === 'accept').map((x) => x.body);
  assert.equal(one.requestId, two.requestId);
  assert.deepEqual(one.payload, two.payload);
  assert.equal(h.counts.accepts, 2);
});

test('local review carrier: known accept with failed pointer write retries only the original private write', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    prepared = await protocol.prepareAccept(randomUUID(), h.input());
  h.faults.pointer = true;
  await assert.rejects(prepared.send());
  assert.equal(h.counts.accepts, 1);
  assert.equal(protocol.canSwitchBackend(), false);
  h.faults.pointer = false;
  const accepted = await prepared.send();
  assert.equal(accepted.value.disposition, 'accepted');
  assert.equal(h.counts.accepts, 1);
  assert.equal(readExecutionReviewState(h.backend.read()).attempts.length, 1);
});

test('local review carrier: cold exact scope does status-only navigation, cannot drive, and full review identities never alias work pointers', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    started = await h.start(protocol),
    scope = started.run.value.scope;
  await protocol.close();
  const cold = await h.open(),
    writes = h.counts.writes,
    seen = h.seen.length,
    before = await businessHashes(h.backend.root);
  const history = await cold.openScope(scope);
  assert.deepEqual(await businessHashes(h.backend.root), before);
  assert.equal(h.counts.writes, writes);
  assert.deepEqual(
    h.seen.slice(seen).map((x) => x.body.operation),
    ['status'],
  );
  assert.throws(() => cold.assertStartHandle(history), { code: 'remote-recovery-required' });
  await assert.rejects(cold.command(history, { operation: 'renew', payload: {} }), {
    code: 'remote-recovery-required',
  });
  for (const changed of [
    {
      ...scope,
      review: { ...scope.review, target: { ...scope.review.target, roundId: 'another-round' } },
    },
    {
      ...scope,
      review: {
        ...scope.review,
        principal: {
          ...scope.review.principal,
          reviewerRef: { ...scope.review.principal.reviewerRef, id: 'another-reviewer' },
        },
      },
    },
  ])
    await assert.rejects(cold.openScope(changed), { code: 'remote-recovery-required' });
  const device = await h.secrets.device(scope.backendId, scope.actorId);
  const { review: _review, ...work } = scope;
  assert.equal(await h.secrets.historyIntent(device, work), undefined);
  await assert.rejects(
    h.secrets.rememberRun(
      device,
      (await h.secrets.loadReviewRun(device, scope)).intent,
      scope,
      started.run.value.selection.configurationId,
      'a'.repeat(64),
    ),
  );
});

test('local review carrier: explicit cold reconcile may submit only its original sealed cut, never start or read again', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    started = await h.start(protocol),
    fixed = h.fixed();
  await h.seal(protocol, started, fixed);
  await protocol.close();
  const cold = await h.open();
  const recovered = await cold.recover({
    target: started.args.target,
    reviewerRef: started.args.reviewerRef,
    acceptRequestId: started.prepared.requestId,
  });
  assert.equal(recovered.value.authority, 'commit-only');
  assert.throws(() => cold.assertStartHandle(recovered), { code: 'remote-recovery-required' });
  await assert.rejects(cold.command(recovered, { operation: 'input-list', payload: {} }), {
    code: 'remote-recovery-required',
  });
  const receipt = await cold.command(recovered, {
    operation: 'submit-result',
    requestId: fixed.result.requestId,
    payload: { result: fixed.result, fixed: fixed.facts },
  });
  assert.equal(receipt.status, 'committed');
  assert.equal(h.backend.read().rounds[0].ballots.length, 1);
});

for (const mutate of ['selection', 'resources', 'reviewer', 'checksum'])
  test(`local review carrier: ${mutate} response contamination fails closed`, async (t) => {
    const h = await fixture(t, {
        mutate(body, result) {
          if (!result.ok) return;
          if (body.operation === 'accept') {
            if (mutate === 'selection') result.value.selection.model = 'changed';
            if (mutate === 'resources')
              result.value.shared.resources[0].resourceFingerprint = '0'.repeat(64);
            if (mutate === 'reviewer') result.value.scope.review.principal.reviewerRef.id = 'other';
          }
          if (body.operation === 'input-read' && mutate === 'checksum')
            result.value.sha256 = '0'.repeat(64);
        },
      }),
      protocol = await h.open();
    if (mutate !== 'checksum')
      await assert.rejects((await protocol.prepareAccept(randomUUID(), h.input())).send());
    else {
      const { run } = await h.start(protocol);
      await assert.rejects(
        protocol.command(run, {
          operation: 'input-read',
          payload: { resourceRef: 'review_text', offset: 0, length: 8192 },
        }),
        { code: 'local-mismatch' },
      );
    }
    assert.equal(h.backend.read().rounds[0].ballots.length, 0);
  });

test('local review carrier: pure switching probe retains unknown accept/pointer obligations even without a returned handle', async (t) => {
  const h = await fixture(t),
    protocol = await h.open();
  if (!('hasPendingWork' in protocol.transport)) {
    // 269437 predates C's public getter; missing capability must fail closed.
    assert.equal(protocol.canSwitchBackend(), false);
    // Interface contract only until integrated with C's original public getter.
    Object.defineProperty(protocol.transport, 'hasPendingWork', { get: () => false });
  }
  assert.equal(protocol.canSwitchBackend(), true);
  const p = await protocol.prepareAccept(randomUUID(), h.input());
  h.faults.pointer = true;
  await assert.rejects(p.send());
  assert.equal(protocol.canSwitchBackend(), false);
  h.faults.pointer = false;
  await p.send();
  assert.equal(protocol.canSwitchBackend(), true);
});

test('local review carrier: stop fences original handle locally, cleanup uses separate secret and close never acts as an idle probe', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    started = await h.start(protocol);
  const stopped = await protocol.stop(started.run, {
    requestId: randomUUID(),
    expectedAttemptVersion: started.view.attemptVersion,
  });
  const before = h.seen.length;
  await assert.rejects(protocol.command(started.run, { operation: 'input-list', payload: {} }), {
    code: 'remote-recovery-required',
  });
  assert.equal(h.seen.length, before);
  const cleanup = await protocol.command(started.run, {
    operation: 'cleanup',
    payload: {
      observation: {
        kind: 'drained',
        sequence: stopped.nextSequence,
        evidence: {
          basis: 'flushed-and-closed',
          nativeSessionId: 'local-review-native',
          nativeAgentId: 'local-review-native',
        },
      },
    },
  });
  assert.equal(cleanup.authority, 'cleanup-only');
  assert.equal(cleanup.resources, 'settled');
  const accept = h.seen.find((x) => x.body.operation === 'accept').body;
  const closing = h.seen.filter((x) => x.body.operation === 'cleanup').at(-1).body;
  assert.deepEqual(closing.payload.permit, accept.payload.credentials.cleanup);
  assert.notDeepEqual(closing.payload.permit, accept.payload.credentials.drive);
  await protocol.close();
  assert.equal(protocol.canSwitchBackend(), false);
});

test('local review carrier: actual private pointer IO remains owned through cancellation and close until its provider settles', async (t) => {
  const h = await fixture(t),
    protocol = await h.open(),
    prepared = await protocol.prepareAccept(randomUUID(), h.input());
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  h.faults.pointerGate = gate.promise;
  h.faults.pointerEntered = () => entered.resolve();
  h.faults.release = () => gate.resolve();
  const sending = prepared.send();
  const rejected = assert.rejects(sending);
  await entered.promise;
  assert.equal(protocol.canSwitchBackend(), false);
  let closed = false;
  const close = protocol.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  gate.resolve();
  await rejected;
  await close;
  assert.equal(closed, true);
  assert.equal(h.counts.accepts, 1);
  assert.equal(h.seen.filter((x) => x.body.operation === 'event').length, 0);
});
