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
import { open, caller } from './execution-service-run-fixture.mjs';
import { readExecutionRunComposition } from '../dist/execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';
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
function dependencyWorkbench() {
  const { state, task, node } = workbenchFixture();
  return applyWorkbenchCommand(state, {
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
}
function skillWorkbench({ imported = false } = {}) {
  const { state, task, node } = workbenchFixture();
  if (imported)
    state.assets[0] = {
      ...state.assets[0],
      origin: {
        versionId: randomUUID(),
        format: 'agent-skill',
        entryPath: 'SKILL.md',
        filePaths: ['SKILL.md'],
        totalBytes: Buffer.byteLength(state.assets[0].content),
        missing: [],
      },
    };
  return applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      status: 'ready',
      participantIds: ['chen', 'outside', 'qa'],
      workflows: [
        { ...task.workflows[0], nodes: [{ ...node, id: 'produce', reviewerIds: ['outside'] }] },
      ],
    },
  });
}
function defer() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function metadata(catalog = { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] }) {
  const life = new AbortController(),
    counts = { checked: 0, released: 0 };
  return {
    life,
    counts,
    value: {
      actorId: 'chen',
      catalog,
      signal: life.signal,
      assertCurrent() {
        counts.checked++;
        return undefined;
      },
      release() {
        counts.released++;
        life.abort();
      },
    },
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
      capabilities: {
        resultIntent: 'zhuma-native-result-intent@1',
        localTools: [],
        ...(host.read(nodeId).handoff.skillRefs.length
          ? { resources: EXECUTION_RESOURCE_SOURCE_VERSION }
          : {}),
      },
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
        configurationId: currentExecutionRun(host.read(view.scope.nodeId)).selection
          .configurationId,
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
  const beforeLookup = f.host.read();
  f.host.resetCounts();
  const found = ok(await f.send(lookup()));
  assert.equal(found.authority, 'recovery-required');
  assert.equal(found.resources, 'held');
  assert.deepEqual(f.host.read(), beforeLookup);
  assert.deepEqual(f.host.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(ok(await f.send(f.scopeBody('status'))).authority, 'drive');
  assert.equal(ok(await f.send(f.scopeBody('renew'))).authority, 'drive');
  assert.equal(found.scope.runId, f.view.scope.runId);
  assert.deepEqual(found.shared, f.view.shared);
  assert.deepEqual(found.selection, f.view.selection);
  assert.equal(Object.hasOwn(found, 'disposition'), false);
  const missing = lookup();
  missing.payload.acceptRequestId = randomUUID();
  const count = f.host.read().nativeExecution.runs.length;
  no(await f.send(missing), 'remote-not-found');
  assert.equal(f.host.read().nativeExecution.runs.length, count);
  await f.reopen();
  const recovered = ok(await f.send(lookup()));
  assert.equal(recovered.authority, 'recovery-required');
  assert.deepEqual(recovered.shared, found.shared);
  const composition = readExecutionRunComposition(recovered.shared.composition);
  assert.equal(composition.configurationId, recovered.selection.configurationId);
  assert.equal(Object.hasOwn(ok(await f.send(f.scopeBody('status'))), 'shared'), false);
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
  assert.equal(
    readExecutionRunComposition(recovered.shared.composition).payload.scope.runId,
    recovered.scope.runId,
  );
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

test('remote original input: real accepted JSON is read on demand in verified byte ranges without new facts', async (t) => {
  const f = await fixture(t, { workbench: dependencyWorkbench() });
  await f.setup();
  const text = '中' + '🙂'.repeat(20000),
    links = ['https://example.test/spec'];
  ok(
    await f.host.service.submit(caller(), {
      ...f.host.locate(),
      idempotencyKey: 'manual-source',
      expectedVersion: f.host.read().command.version,
      text,
      links,
    }),
  );
  const artifactVersionId = f.host.read().acceptedArtifactVersionId;
  const expected = ok(
    await f.host.service.upstreamContent(caller(), {
      ...f.host.locate('consume'),
      spaceId: 'north',
      sourceNodeId: 'produce',
      artifactVersionId,
    }),
  );
  await f.begin(
    {
      capabilities: {
        resultIntent: 'zhuma-native-result-intent@1',
        acceptedInput: '1',
        localTools: [],
      },
    },
    'consume',
  );
  assert.equal(f.view.shared.composition.payload.tools.kind, 'accepted-input-reader');
  const frozen = f.view.shared.inputs;
  assert.equal(frozen.length, 1);
  f.host.resetCounts();
  assert.deepEqual(ok(await f.send(f.scopeBody('input-list'))).items, frozen);
  const slot = frozen[0],
    chunks = [];
  let offset = 0;
  while (offset < slot.byteSize) {
    const chunk = ok(
      await f.send(f.scopeBody('input-read', { slotId: slot.slotId, offset, maximumBytes: 32771 })),
    );
    const bytes = Buffer.from(chunk.base64, 'base64');
    assert.equal(bytes.byteLength, chunk.byteSize);
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.sha256, slot.sha256);
    assert.equal(chunk.totalBytes, slot.byteSize);
    offset += bytes.byteLength;
    chunks.push(bytes);
    assert.equal(chunk.eof, offset === slot.byteSize);
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), slot.sha256);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected);
  assert.equal(expected.content.text, text);
  no(
    await f.send(
      f.scopeBody('input-read', {
        slotId: slot.slotId,
        offset: slot.byteSize + 1,
        maximumBytes: 10,
      }),
    ),
    'remote-validation',
  );
  no(
    await f.send(
      f.scopeBody('input-read', { slotId: 'foreign-slot', offset: 0, maximumBytes: 10 }),
    ),
    'remote-input-stale',
  );
  assert.deepEqual(f.host.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(Object.hasOwn(ok(await f.send(f.scopeBody('renew'))), 'shared'), false);
});

test('remote original input: changed fixed source fails closed and commit-only cannot read new inputs', async (t) => {
  const f = await fixture(t, { workbench: dependencyWorkbench() });
  await f.setup();
  ok(
    await f.host.service.submit(caller(), {
      ...f.host.locate(),
      idempotencyKey: 'manual-source',
      expectedVersion: f.host.read().command.version,
      text: '固定输入',
    }),
  );
  await f.begin(
    {
      capabilities: {
        resultIntent: 'zhuma-native-result-intent@1',
        acceptedInput: '1',
        localTools: [],
      },
    },
    'consume',
  );
  const original = f.host.read(),
    slot = f.view.shared.inputs[0];
  const read = () =>
    f.scopeBody('input-read', { slotId: slot.slotId, offset: 0, maximumBytes: 100 });
  const replaced = structuredClone(original);
  replaced.acceptedArtifactVersionId = 'replaced-version';
  await f.host.domain.table('nodes').put(nodeRecordKey(original), replaced);
  f.host.resetCounts();
  no(await f.send(read()), 'remote-input-stale');
  no(await f.send(f.scopeBody('input-list')), 'remote-input-stale');
  assert.equal(f.host.counters.nodes, 0);
  await f.host.domain.table('nodes').put(nodeRecordKey(original), original);
  await f.accepted();
  await f.completed('结果');
  assert.equal(f.view.authority, 'commit-only');
  no(await f.send(read()), 'remote-permit-revoked');
  no(await f.send(f.scopeBody('input-list')), 'remote-permit-revoked');
});

test('remote resource contract: queue-external qualification reenters original read and freezes the selected Skill', async (t) => {
  const q = metadata();
  let f,
    prepared = 0;
  f = await fixture(t, {
    workbench: skillWorkbench(),
    async prepareInitialResourceCatalog(original, locator, wait) {
      prepared++;
      assert.equal(original, f.host.request);
      assert.equal(wait.aborted, false);
      ok(await f.host.service.readRunCompositionInputs(original, locator));
      return q.value;
    },
  });
  await f.setup();
  f.host.faults.configuration = true;
  const { body, view } = await f.begin();
  const skill = view.shared.composition.payload.resources.skills[0];
  assert.equal(skill.definition.id, 'api-skill');
  assert.equal(skill.definition.content, f.host.readWorkbench().appliedPlans[0].assets[0].content);
  assert.equal(view.authority, 'drive');
  assert.equal(q.life.signal.aborted, true);
  assert.equal(q.counts.released, 1);
  assert.ok(q.counts.checked > 2);
  assert.equal(ok(await f.send(body)).disposition, 'replayed');
  assert.equal(prepared, 1);
  assert.equal(ok(await f.send(f.scopeBody('status'))).authority, 'drive');
  ok(await f.event('received', { nativeSessionId: 'contract-native-session' }));
});

test('remote resource contract: imported policy keeps exact original version and invocation flags', async (t) => {
  const workbench = skillWorkbench({ imported: true });
  const plan = workbench.appliedPlans[0],
    asset = plan.assets[0];
  const q = metadata({
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: [],
    skills: [
      {
        ref: { id: asset.id, version: plan.id },
        definitionDigest: executionResourceDigest(asset),
        invocation: { modelInvocable: false, userInvocable: true },
        policySource: {
          kind: 'asset-package',
          versionId: asset.origin.versionId,
          digest: 'a'.repeat(64),
          entryPath: asset.origin.entryPath,
        },
      },
    ],
  });
  const f = await fixture(t, { workbench, prepareInitialResourceCatalog: async () => q.value });
  await f.setup();
  await f.begin();
  const skill = f.view.shared.composition.payload.resources.skills[0];
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true });
  assert.equal(skill.policySource.versionId, asset.origin.versionId);
  assert.equal(skill.definitionDigest, executionResourceDigest(asset));
  assert.equal(q.counts.released, 1);
});

test('remote resource contract: missing provider, wrong actor and invalid device cannot freeze unauthorized definitions', async (t) => {
  const missing = await fixture(t, { workbench: skillWorkbench() });
  await missing.setup();
  no(await missing.send(missing.accept()), 'remote-unavailable');
  assert.equal(missing.host.read().nativeExecution, undefined);
  const q = metadata();
  q.value.actorId = 'outside';
  let prepared = 0;
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => {
      prepared++;
      return q.value;
    },
  });
  await f.setup();
  const invalid = f.accept();
  invalid.deviceId = randomUUID();
  no(await f.send(invalid), 'remote-device-mismatch');
  assert.equal(prepared, 0);
  no(
    await f.send(
      f.accept({ capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] } }),
    ),
    'remote-protocol-unsupported',
  );
  assert.equal(prepared, 0);
  no(await f.send(f.accept()), 'remote-forbidden');
  assert.equal(q.counts.released, 1);
  assert.equal(f.host.read().nativeExecution, undefined);
});

test('remote resource contract: failed durable reservation releases metadata and can retry without a second Run', async (t) => {
  const lives = [];
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => {
      const q = metadata();
      lives.push(q);
      return q.value;
    },
  });
  await f.setup();
  const body = f.accept();
  f.host.faults.node = true;
  no(await f.send(body), 'remote-unavailable');
  assert.equal(lives[0].counts.released, 1);
  assert.equal(f.host.read().nativeExecution, undefined);
  f.host.faults.node = false;
  assert.equal(ok(await f.send(body)).authority, 'drive');
  assert.equal(lives[1].counts.released, 1);
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
});

test('remote resource contract: close waits a late actual qualification/release and prevents post-fence admission', async (t) => {
  const entered = defer(),
    ready = defer(),
    q = metadata();
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => {
      entered.resolve();
      await ready.promise;
      return q.value;
    },
  });
  await f.setup();
  const request = f.send(f.accept());
  await entered.promise;
  let closed = false;
  const closing = f.host.service.closeRuns().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(q.counts.released, 0);
  ready.resolve();
  no(await request, 'remote-unavailable');
  await closing;
  assert.equal(q.counts.released, 1);
  assert.equal(f.host.read().nativeExecution, undefined);
});

test('remote resource contract: real release failure grants no drive and remains a close failure', async (t) => {
  const q = metadata();
  q.value.release = () => {
    q.counts.released++;
    throw Error('CONTRACT_RELEASE_FAILURE');
  };
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => q.value,
  });
  await f.setup();
  const body = f.accept();
  no(await f.send(body), 'remote-unavailable');
  assert.equal(q.counts.released, 1);
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
  const scope = {
    ...currentExecutionRun(f.host.read()).composition.payload.scope,
    backendId: f.host.service.readRunGlobal().remoteExecution.backendId,
  };
  assert.equal(
    ok(await f.send(f.envelope('status', { scope, permit: f.drive.public }))).authority,
    'recovery-required',
  );
  await assert.rejects(f.host.service.closeRuns(), (error) => error.cleanupFailed === true);
});

test('remote resource contract: an async assertion never admits a Run and its actual settlement is joined', async (t) => {
  const q = metadata(),
    assertion = defer(),
    entered = defer();
  q.value.assertCurrent = () => {
    entered.resolve();
    return assertion.promise;
  };
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => q.value,
  });
  await f.setup();
  const request = f.send(f.accept());
  await entered.promise;
  let settled = false;
  const done = request.then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(q.counts.released, 0);
  assertion.resolve();
  no(await done, 'remote-unavailable');
  assert.equal(q.counts.released, 1);
  assert.equal(f.host.read().nativeExecution, undefined);
});

test('remote resource contract: pending async release cannot be promoted by replay and remains an owned close failure', async (t) => {
  const q = metadata(),
    entered = defer(),
    released = defer();
  q.value.release = () => {
    q.counts.released++;
    entered.resolve();
    return released.promise;
  };
  const f = await fixture(t, {
    workbench: skillWorkbench(),
    prepareInitialResourceCatalog: async () => q.value,
  });
  await f.setup();
  const body = f.accept(),
    request = f.send(body);
  await entered.promise;
  const replay = ok(await f.send(body));
  assert.equal(replay.authority, 'recovery-required');
  assert.equal(f.host.read().nativeExecution.runs.length, 1);
  let closed = false;
  const closing = f.host.service.closeRuns().finally(() => {
    closed = true;
  });
  const failedClose = assert.rejects(closing, (error) => error.cleanupFailed === true);
  await Promise.resolve();
  assert.equal(closed, false);
  released.resolve();
  no(await request, 'remote-unavailable');
  await failedClose;
  assert.equal(q.counts.released, 1);
});
