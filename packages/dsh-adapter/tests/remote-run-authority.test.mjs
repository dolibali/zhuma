/** Original Cordis/DSH JSON/service, with explicit contract member and SDK-event producers.
 * No real identity login, network/native driver, two-device or model acceptance is claimed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalPayload,
  nodeRecordKey,
  remoteDeviceSigningInput,
  remoteResultDigestInput,
  applyWorkbenchCommand,
} from '@zhuma/agent-core';
import { fixture as workbenchFixture } from '../../../tests/fixtures/workbench.mjs';
import { open } from './execution-service-run-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import {
  prepareExecutionRunWriter,
  assertExecutionRunStoreCompatibility,
} from '../dist/execution-run-protocol.js';

const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const ok = (value) => {
  assert.equal(value.ok, true, value.ok ? '' : value.error.code);
  return value.value;
};
const no = (value, code) => {
  assert.equal(value.ok, false);
  if (code) assert.equal(value.error.code, code);
};
function credential() {
  const bytes = randomBytes(32);
  return {
    raw: bytes.toString('base64url'),
    public: { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-remote-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let host = await open(root, options);
  const cookie = `zhuma-member=${randomUUID()}.${Date.now() + 1000000}.CONTRACT`;
  host.request.headers.cookie = cookie;
  t.after(() => host.close());
  const keys = generateKeyPairSync('ed25519');
  const deviceId = randomUUID(),
    drive = credential(),
    cleanup = credential();
  let backendId;
  const envelope = (operation, payload, requestId = randomUUID()) => ({
    protocolVersion: 1,
    operation,
    requestId,
    ...(operation === 'info' ? {} : { backendId }),
    ...(['info', 'stop'].includes(operation)
      ? {}
      : {
          deviceId,
          proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
        }),
    payload,
  });
  const signed = (body) => {
    if ('proof' in body)
      body.proof.signature = sign(
        null,
        Buffer.from(canonicalPayload(remoteDeviceSigningInput(body))),
        keys.privateKey,
      ).toString('base64url');
    return body;
  };
  const send = (body, secret = drive.raw, request = host.request) =>
    host.service.remoteRun(request, signed(body), secret);
  const setup = async () => {
    await host.service.enableRemoteRuns();
    backendId = ok(await send(envelope('info', {}))).backendId;
    ok(
      await send(
        envelope('register-device', {
          publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        }),
      ),
    );
  };
  const accept = (patch = {}, nodeId = 'produce') =>
    envelope('accept', {
      target: { spaceId: 'north', ...host.locate(nodeId) },
      expectedNodeVersion: host.read(nodeId).command.version,
      expectedRunVersion: host.read(nodeId).nativeExecution?.version ?? 0,
      purpose: 'work',
      mode: 'begin',
      model: { provider: 'member-local', model: 'contract-local', maxTokens: 1000 },
      workspace: { kind: 'text-only' },
      executor: { kind: 'builtin' },
      capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
      credentials: { drive: drive.public, cleanup: cleanup.public },
      ...patch,
    });
  let view;
  const begin = async (patch, nodeId) => {
    const body = accept(patch, nodeId);
    view = ok(await send(body));
    return { body, view };
  };
  const scopeBody = (operation, fields = {}) =>
    envelope(operation, { scope: structuredClone(view.scope), permit: drive.public, ...fields });
  const event = async (kind, fields = {}, body) => {
    const value = await send(
      body ?? scopeBody('event', { event: { kind, sequence: view.nextSequence, ...fields } }),
    );
    if (value.ok) view = value.value;
    return value;
  };
  const accepted = async () => {
    ok(await event('received', { nativeSessionId: 'contract-native-session' }));
    ok(
      await event('accepted', {
        nativeSessionId: 'contract-native-session',
        executorRunId: 'contract-native-agent',
      }),
    );
  };
  const completed = async (text = '实际正文的契约样本') => {
    const draft = { text, links: [], files: [] };
    const { backendId: _backend, ...scope } = view.scope;
    const result = {
      requestId: randomUUID(),
      digest: nativeResultDigest(draft),
      artifactDigest: hash(remoteResultDigestInput(draft)),
      source: {
        scope,
        nativeSessionId: 'contract-native-session',
        nativeAgentId: 'contract-native-agent',
        configurationId: currentExecutionRun(host.read()).selection.configurationId,
        intentId: 'intent',
        callId: 'call',
        toolVersion: 'zhuma-native-result-intent@1',
        cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
      },
    };
    ok(await event('completed', { idle: true, flushed: true, resourcesSettled: true, result }));
    return { draft, result };
  };
  return {
    get host() {
      return host;
    },
    root,
    setup,
    begin,
    accept,
    send,
    signed,
    envelope,
    scopeBody,
    event,
    accepted,
    completed,
    drive,
    cleanup,
    keys,
    deviceId,
    get view() {
      return view;
    },
    async reopen() {
      await host.close();
      host = await open(root, { seed: false, ...options });
      host.request.headers.cookie = cookie;
      await host.service.enableRemoteRuns();
    },
  };
}

test('remote original JSON: explicit durable writer, member-bound device and accept are idempotent; backend configuration is never used', async (t) => {
  const f = await fixture(t);
  const initial = structuredClone(f.host.counters);
  no(await f.send(f.envelope('info', {})), 'remote-unavailable');
  assert.deepEqual(f.host.counters, initial);
  await f.setup();
  f.host.faults.configuration = true;
  f.host.resetCounts();
  const { body, view } = await f.begin();
  assert.equal(view.authority, 'drive');
  assert.equal(view.resources, 'held');
  assert.equal(view.runStatus, 'requested');
  assert.equal(f.host.read().command.status, 'ready');
  assert.equal(view.shared.composition.configurationId, view.selection.configurationId);
  assert.equal(ok(await f.send(body)).disposition, 'replayed');
  assert.deepEqual(f.host.counters, { global: 0, nodes: 1, plans: 0 });
  no(
    await f.send({
      ...body,
      payload: { ...body.payload, model: { ...body.payload.model, model: 'changed' } },
    }),
    'remote-idempotency-mismatch',
  );
  const global = f.host.service.readRunGlobal();
  assert.deepEqual(prepareExecutionRunWriter(global), global);
  assert.throws(() =>
    assertExecutionRunStoreCompatibility({ schemaVersion: 1, nativeExecutionWriter: 1 }, [
      f.host.read(),
    ]),
  );
  const stored = canonicalPayload({ global, node: f.host.read() });
  assert.equal(stored.includes(f.drive.raw), false);
  assert.equal(stored.includes(f.cleanup.raw), false);
  await assert.rejects(f.host.authorities.open(f.host.request, f.host.runLocator(), 'drive'));
});

test('remote original JSON: wrong actor/device/scope/secret/signature and stale sequence refuse without writes', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  f.host.resetCounts();
  const badActor = { headers: { cookie: f.host.request.headers.cookie } };
  f.host.members.set(badActor, 'outside');
  no(await f.send(f.scopeBody('status'), f.drive.raw, badActor), 'remote-device-mismatch');
  no(await f.send({ ...f.scopeBody('status'), deviceId: randomUUID() }), 'remote-device-mismatch');
  const changed = f.scopeBody('status');
  changed.payload.scope.generation++;
  no(await f.send(changed), 'remote-scope-mismatch');
  no(await f.send(f.scopeBody('status'), f.cleanup.raw), 'remote-permit-revoked');
  const invalid = f.signed(f.scopeBody('status'));
  invalid.proof.signature = 'A'.repeat(86);
  no(await f.host.service.remoteRun(f.host.request, invalid, f.drive.raw), 'remote-proof-invalid');
  assert.deepEqual(f.host.counters, { global: 0, nodes: 0, plans: 0 });
  const gap = f.scopeBody('event', { event: { kind: 'idle', sequence: 2 } });
  no(await f.send(gap), 'remote-sequence-gap');
  const received = f.scopeBody('event', {
    event: { kind: 'received', sequence: 1, nativeSessionId: 'contract-native-session' },
  });
  ok(await f.event('received', {}, received));
  assert.equal(ok(await f.send(received)).disposition, 'replayed');
  no(
    await f.send(f.scopeBody('event', { event: { kind: 'idle', sequence: 1 } })),
    'remote-idempotency-mismatch',
  );
  assert.equal(f.host.counters.nodes, 1);
});

test('remote original JSON: original result commits one artifact/round; fixed declaration and both digests bind text', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  const { draft, result } = await f.completed();
  assert.equal(f.view.authority, 'commit-only');
  assert.equal(f.host.read().artifactVersions.length, 0);
  const submit = f.envelope(
    'submit-result',
    {
      scope: f.view.scope,
      permit: f.drive.public,
      expectedNodeVersion: f.view.nodeVersion,
      result,
      draft,
    },
    result.requestId,
  );
  const altered = structuredClone(submit);
  altered.payload.draft.text = '替换正文';
  no(await f.send(altered), 'remote-idempotency-mismatch');
  const receipt = ok(await f.send(submit));
  assert.equal(receipt.disposition, 'committed');
  const repeat = ok(await f.send(submit));
  no(await f.send(altered), 'remote-idempotency-mismatch');
  assert.deepEqual(repeat.receipt, receipt.receipt);
  assert.equal(repeat.disposition, 'replayed');
  const node = f.host.read();
  assert.equal(node.artifactVersions.length, 1);
  assert.equal(node.artifactVersions[0].text, draft.text);
  assert.equal(node.rounds.length, 1);
  assert.equal(node.events.filter((event) => event.type === 'delivery-submitted').length, 1);
  assert.equal(node.command.status, 'in-review');
  assert.equal(
    ok(await f.send(f.scopeBody('result-status', { resultRequestId: result.requestId }))).receipt
      .artifactVersionId,
    node.artifactVersions[0].id,
  );
});

test('remote original JSON: Stop receipt holds resources; cleanup can only drain exact old scope without member cookie', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  const stop = f.envelope('stop', {
    scope: f.view.scope,
    expectedNodeVersion: f.view.nodeVersion,
    expectedRunVersion: f.view.runVersion,
  });
  const stopped = ok(await f.send(stop));
  assert.equal(stopped.stopRequested, true);
  assert.equal(stopped.resources, 'held');
  const noCookie = { headers: {} };
  const control = (kind) =>
    f.envelope('cleanup', {
      scope: f.view.scope,
      permit: f.cleanup.public,
      observation: {
        kind,
        sequence: currentExecutionRun(f.host.read()).attempt.lastEventSequence + 1,
      },
    });
  const pending = ok(await f.send(control('stop-received'), f.cleanup.raw, noCookie));
  assert.equal(pending.cleanupPhase, 'stop-received');
  assert.equal(pending.resources, 'held');
  no(
    await f.send(f.scopeBody('event', { event: { kind: 'idle', sequence: pending.nextSequence } })),
    'remote-permit-revoked',
  );
  const drained = control('drained');
  drained.payload.observation.evidence = {
    basis: 'flushed-and-closed',
    nativeSessionId: 'contract-native-session',
    nativeAgentId: 'contract-native-agent',
  };
  const done = ok(await f.send(drained, f.cleanup.raw, noCookie));
  assert.equal(done.resources, 'settled');
  assert.equal(done.runStatus, 'cancelled');
  assert.equal(done.authority, 'cleanup-only');
  assert.equal(done.result, undefined);
  assert.equal(ok(await f.send(drained, f.cleanup.raw, noCookie)).disposition, 'replayed');
});

test('remote original JSON: lost accept response lookup never allocates and cold reopen never restores drive', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const { body } = await f.begin();
  const lookup = () =>
    f.envelope('reconcile', {
      target: body.payload.target,
      acceptRequestId: body.requestId,
      permit: f.drive.public,
    });
  const found = ok(await f.send(lookup()));
  assert.equal(found.scope.runId, f.view.scope.runId);
  const missing = lookup();
  missing.payload.acceptRequestId = randomUUID();
  const count = f.host.read().nativeExecution.runs.length;
  no(await f.send(missing), 'remote-not-found');
  assert.equal(f.host.read().nativeExecution.runs.length, count);
  await f.reopen();
  const recovered = ok(await f.send(lookup()));
  assert.equal(recovered.authority, 'recovery-required');
  assert.equal(ok(await f.send(body)).authority, 'recovery-required');
  no(await f.event('idle'), 'remote-permit-expired');
});

test('remote original JSON: cold completed result resumes commit-only; explicit Stop after completion fences later submission', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  const { draft, result } = await f.completed();
  await f.reopen();
  const recovered = ok(
    await f.send(
      f.scopeBody('reconcile', {
        lastSequence: f.view.nextSequence - 1,
        resultRequestId: result.requestId,
      }),
    ),
  );
  assert.equal(recovered.authority, 'commit-only');
  const stop = f.envelope('stop', {
    scope: recovered.scope,
    expectedNodeVersion: recovered.nodeVersion,
    expectedRunVersion: recovered.runVersion,
  });
  ok(await f.send(stop));
  no(
    await f.send(
      f.envelope(
        'submit-result',
        {
          scope: recovered.scope,
          permit: f.drive.public,
          expectedNodeVersion: recovered.nodeVersion,
          result,
          draft,
        },
        result.requestId,
      ),
    ),
    'remote-permit-revoked',
  );
  assert.equal(f.host.read().artifactVersions.length, 0);
});

test('remote original JSON: cold sealed original result commits without replaying native work', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  const { draft, result } = await f.completed('冷恢复的原正文');
  await f.reopen();
  const recovered = ok(
    await f.send(
      f.scopeBody('reconcile', {
        lastSequence: f.view.nextSequence - 1,
        resultRequestId: result.requestId,
      }),
    ),
  );
  const committed = ok(
    await f.send(
      f.envelope(
        'submit-result',
        {
          scope: recovered.scope,
          permit: f.drive.public,
          expectedNodeVersion: recovered.nodeVersion,
          result,
          draft,
        },
        result.requestId,
      ),
    ),
  );
  assert.equal(committed.disposition, 'committed');
  assert.equal(f.host.read().artifactVersions.at(-1).text, draft.text);
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
});

test('remote original JSON: failed-but-held cleanup progress never releases until exact drain', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  ok(await f.event('failed', { resourcesSettled: false }));
  const noCookie = { headers: {} };
  for (const kind of ['stop-received', 'retiring', 'unknown']) {
    const control = f.envelope('cleanup', {
      scope: f.view.scope,
      permit: f.cleanup.public,
      observation: {
        kind,
        sequence: currentExecutionRun(f.host.read()).attempt.lastEventSequence + 1,
      },
    });
    const pending = ok(await f.send(control, f.cleanup.raw, noCookie));
    assert.equal(pending.resources, 'held');
    assert.equal(pending.runStatus, 'failed');
  }
  no(await f.send(f.accept({ mode: 'retry' })), 'remote-resource-held');
  const cleanup = f.envelope('cleanup', {
    scope: f.view.scope,
    permit: f.cleanup.public,
    observation: {
      kind: 'drained',
      sequence: currentExecutionRun(f.host.read()).attempt.lastEventSequence + 1,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'contract-native-session',
        nativeAgentId: 'wrong',
      },
    },
  });
  no(await f.send(cleanup, f.cleanup.raw, noCookie), 'remote-scope-mismatch');
  cleanup.payload.observation.evidence.nativeAgentId = 'contract-native-agent';
  assert.equal(ok(await f.send(cleanup, f.cleanup.raw, noCookie)).resources, 'settled');
});

test('remote original JSON: revoked member cannot submit, but exact cleanup remains available', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  f.host.setWorkbench((state) => ({
    ...state,
    participants: state.participants.map((p) => (p.id === 'chen' ? { ...p, available: false } : p)),
  }));
  const before = f.host.counters.nodes;
  no(await f.send(f.scopeBody('status')));
  assert.equal(f.host.counters.nodes, before);
  const cleanup = f.envelope('cleanup', {
    scope: f.view.scope,
    permit: f.cleanup.public,
    observation: {
      kind: 'drained',
      sequence: f.view.nextSequence,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'contract-native-session',
        nativeAgentId: 'contract-native-agent',
      },
    },
  });
  assert.equal(ok(await f.send(cleanup, f.cleanup.raw, { headers: {} })).resources, 'settled');
});

test('remote original JSON: durable-write failure returns no acceptance and explicit retry creates one Run', async (t) => {
  const f = await fixture(t);
  await f.setup();
  const body = f.accept();
  f.host.faults.node = true;
  no(await f.send(body), 'remote-unavailable');
  assert.equal(f.host.read().nativeExecution, undefined);
  f.host.faults.node = false;
  ok(await f.send(body));
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
});

test('remote original JSON: current original expert produces a provenance-linked artifact and review round', async (t) => {
  const f = await fixture(t, { expertNode: 'produce' });
  await f.setup();
  await f.begin({
    executor: { kind: 'plan-expert', ref: { id: 'qa', version: f.host.locate().planId } },
  });
  await f.accepted();
  const { draft, result } = await f.completed('专家固定正文');
  ok(
    await f.send(
      f.envelope(
        'submit-result',
        {
          scope: f.view.scope,
          permit: f.drive.public,
          expectedNodeVersion: f.view.nodeVersion,
          result,
          draft,
        },
        result.requestId,
      ),
    ),
  );
  const artifact = f.host.read().artifactVersions.at(-1);
  assert.equal(artifact.producerRunId, f.view.scope.runId);
  assert.equal(artifact.submittedBy, 'qa');
  assert.equal(f.host.read().rounds.length, 1);
});

test('remote original JSON: a newer applied plan fences drive while exact old-scope cleanup remains available', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  await f.accepted();
  f.host.setWorkbench((state) => ({
    ...state,
    appliedPlans: [
      ...state.appliedPlans,
      { ...state.appliedPlans.at(-1), id: 'replacement-plan', revision: f.view.scope.revision + 1 },
    ],
  }));
  f.host.resetCounts();
  no(await f.send(f.scopeBody('status')), 'remote-stale-plan');
  no(await f.event('idle'), 'remote-stale-plan');
  assert.equal(f.host.counters.nodes, 0);
  const body = f.envelope('cleanup', {
    scope: f.view.scope,
    permit: f.cleanup.public,
    observation: {
      kind: 'drained',
      sequence: f.view.nextSequence,
      evidence: {
        basis: 'flushed-and-closed',
        nativeSessionId: 'contract-native-session',
        nativeAgentId: 'contract-native-agent',
      },
    },
  });
  assert.equal(ok(await f.send(body, f.cleanup.raw, { headers: {} })).resources, 'settled');
});

test('remote original JSON: expired permit or new member session cannot renew drive or unlock replacement work', async (t) => {
  const f = await fixture(t);
  await f.setup();
  await f.begin();
  const newSession = {
    headers: { cookie: `zhuma-member=${randomUUID()}.${Date.now() + 1000000}.CONTRACT` },
  };
  f.host.members.set(newSession, 'chen');
  assert.equal(
    ok(await f.send(f.scopeBody('status'), f.drive.raw, newSession)).authority,
    'recovery-required',
  );
  no(await f.send(f.scopeBody('renew'), f.drive.raw, newSession), 'remote-permit-revoked');
  const node = f.host.read();
  node.nativeExecution.runs[0].remote.drive.expiresAt = Date.now() - 1;
  await f.host.domain.table('nodes').put(nodeRecordKey(node), node);
  no(await f.send(f.scopeBody('renew')), 'remote-permit-expired');
  no(await f.send(f.accept()), 'remote-resource-held');
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
});

test('remote original JSON: original no-review delivery unlocks downstream with its fixed artifact version', async (t) => {
  const { state, task, node } = workbenchFixture();
  const workbench = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      status: 'ready',
      participantIds: ['chen', 'outside', 'qa'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            { ...node, id: 'produce', skillIds: [], reviewRequired: false, reviewerIds: [] },
            {
              ...node,
              id: 'consume',
              skillIds: [],
              reviewRequired: false,
              reviewerIds: [],
              dependsOn: ['produce'],
            },
          ],
        },
      ],
    },
  });
  const f = await fixture(t, { workbench });
  await f.setup();
  await f.begin();
  await f.accepted();
  assert.equal(f.host.read('consume').command.status, 'blocked');
  const { draft, result } = await f.completed();
  const submitted = ok(
    await f.send(
      f.envelope(
        'submit-result',
        {
          scope: f.view.scope,
          permit: f.drive.public,
          expectedNodeVersion: f.view.nodeVersion,
          result,
          draft,
        },
        result.requestId,
      ),
    ),
  );
  assert.equal(f.host.read().command.status, 'completed');
  const downstream = f.host.read('consume');
  assert.equal(downstream.command.status, 'ready');
  assert.equal(
    downstream.handoff.inputRefs[0].artifactVersionId,
    submitted.receipt.artifactVersionId,
  );
  assert.equal(
    f.host.read().events.filter((event) => event.type === 'delivery-submitted').length,
    1,
  );
});
