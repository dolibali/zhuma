import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalPayload } from '../dist/concurrency.js';
import {
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HASH_VECTORS,
  remotePermitHashInput,
  remoteRunViewSchema,
  remoteAcceptValueSchema,
  remoteRunResponseSchema,
  REMOTE_RUN_EVENT_KINDS,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_RESOURCE_SOURCE_VERSION,
  remoteRunRequestSchema,
  remoteRunEventSchema,
  remotePrivatePermitSchema,
  remoteDeviceSigningInput,
  remoteResultDigestInput,
  remoteInputDescriptorSchema,
} from '../dist/remote-run-contract.js';

const sha = 'a'.repeat(64);
const scope = () => ({
  backendId: randomUUID(),
  actorId: 'member',
  spaceId: 'team',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  runId: randomUUID(),
  generation: 1,
  segmentId: randomUUID(),
});
const declaration = () => ({ id: randomUUID(), sha256: sha });
const accept = () => ({
  protocolVersion: 1,
  operation: 'accept',
  requestId: randomUUID(),
  backendId: randomUUID(),
  deviceId: randomUUID(),
  proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
  payload: {
    target: { spaceId: 'team', taskId: 'task', planId: 'plan', revision: 1, nodeId: 'node' },
    expectedNodeVersion: 0,
    expectedRunVersion: 0,
    purpose: 'work',
    mode: 'begin',
    model: { provider: 'local-choice', model: 'local-model', maxTokens: 4096 },
    workspace: { kind: 'text-only' },
    executor: { kind: 'builtin' },
    capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
    credentials: { drive: declaration(), cleanup: declaration() },
  },
});

test('remote recovery contract: signed permit binds known scope or exact committed accept lookup; lookup carries no drive command', () => {
  const base = accept();
  const known = {
    ...base,
    operation: 'reconcile',
    payload: { scope: scope(), permit: declaration(), lastSequence: 0 },
  };
  remoteRunRequestSchema.parse(known);
  const missingPermit = structuredClone(known);
  delete missingPermit.payload.permit;
  assert.equal(remoteRunRequestSchema.safeParse(missingPermit).success, false);
  const lookup = {
    ...base,
    operation: 'reconcile',
    payload: {
      target: base.payload.target,
      acceptRequestId: base.requestId,
      permit: declaration(),
    },
  };
  remoteRunRequestSchema.parse(lookup);
  for (const extra of [
    { mode: 'begin' },
    { model: base.payload.model },
    { scope: scope() },
    { actorId: 'other' },
  ])
    assert.equal(
      remoteRunRequestSchema.safeParse({ ...lookup, payload: { ...lookup.payload, ...extra } })
        .success,
      false,
    );
});

test('remote protocol data contract: one exact operation inventory, including cleanup, is distinct from a capability', () => {
  assert.equal(REMOTE_RUN_OPERATIONS.length, 21);
  assert.equal(new Set(REMOTE_RUN_OPERATIONS).size, 21);
  assert.deepEqual(
    [...REMOTE_RUN_EVENT_KINDS].sort(),
    [
      'received',
      'accepted',
      'dispatch-unknown',
      'idle',
      'waiting',
      'resumed',
      'stop-received',
      'retiring',
      'stopped',
      'completed',
      'failed',
    ].sort(),
  );
  assert.equal(REMOTE_RUN_LIMITS.driveTtlMs, 60000);
  assert.equal(REMOTE_RUN_LIMITS.renewAfterMs, 20000);
  const parsed = remoteRunRequestSchema.parse(accept());
  assert.equal(Object.hasOwn(parsed, 'assertCurrent'), false);
  const input = accept();
  input.payload.capabilities.resources = REMOTE_RUN_RESOURCE_SOURCE_VERSION;
  remoteRunRequestSchema.parse(input);
  input.payload.capabilities.resources = 'unsupported-runtime';
  assert.equal(remoteRunRequestSchema.safeParse(input).success, false);
});

test('remote protocol data contract: secrets belong only in private credentials and the private HTTP header, never wire JSON', () => {
  const input = accept(),
    secret = Buffer.alloc(32, 98).toString('base64url');
  assert.deepEqual(remoteRunRequestSchema.parse(input), input);
  remotePrivatePermitSchema.parse({ id: input.payload.credentials.drive.id, secret });
  for (const body of [
    { ...input, secret },
    {
      ...input,
      payload: {
        ...input.payload,
        credentials: {
          ...input.payload.credentials,
          drive: { ...input.payload.credentials.drive, secret },
        },
      },
    },
    { ...input, payload: { ...input.payload, actorId: 'other-member' } },
    { ...input, payload: { ...input.payload, model: { ...input.payload.model, apiKey: secret } } },
    {
      ...input,
      payload: {
        ...input.payload,
        workspace: {
          kind: 'local',
          rootId: 'root',
          grantId: 'grant',
          generation: 1,
          access: 'write',
          path: '/private/workspace',
        },
      },
    },
  ])
    assert.equal(remoteRunRequestSchema.safeParse(body).success, false);
  const current = scope();
  const status = {
    ...input,
    operation: 'status',
    backendId: current.backendId,
    payload: { scope: current, permit: input.payload.credentials.drive },
  };
  remoteRunRequestSchema.parse(status);
  assert.equal(
    remoteRunRequestSchema.safeParse({
      ...status,
      payload: { ...status.payload, permit: { id: input.payload.credentials.drive.id, secret } },
    }).success,
    false,
  );
});

test('remote protocol signing data: ID/hash, operation, backend, target and exact body remain covered, signature alone is excluded', () => {
  const input = remoteRunRequestSchema.parse(accept());
  const signed = canonicalPayload(remoteDeviceSigningInput(input));
  assert.equal(signed.includes(input.proof.signature), false);
  for (const change of [
    (body) => {
      body.backendId = randomUUID();
    },
    (body) => {
      body.deviceId = randomUUID();
    },
    (body) => {
      body.payload.target.nodeId = 'another';
    },
    (body) => {
      body.payload.credentials.drive.sha256 = 'c'.repeat(64);
    },
    (body) => {
      body.requestId = randomUUID();
    },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.notEqual(canonicalPayload(remoteDeviceSigningInput(changed)), signed);
  }
  assert.equal(
    canonicalPayload(
      remoteDeviceSigningInput({ ...input, proof: { ...input.proof, signature: 'B'.repeat(86) } }),
    ),
    signed,
  );
});

test('remote protocol data: stop receipt/retiring are not a physical drain; completion must declare an immutable actual result', () => {
  for (const kind of ['stop-received', 'retiring']) {
    assert.equal(remoteRunEventSchema.safeParse({ kind, sequence: 1 }).success, true);
    assert.equal(
      remoteRunEventSchema.safeParse({ kind, sequence: 1, resourcesSettled: true }).success,
      false,
    );
  }
  const actualScope = scope();
  const { backendId: _backend, ...nativeScope } = actualScope;
  const completed = {
    kind: 'completed',
    sequence: 3,
    idle: true,
    flushed: true,
    resourcesSettled: true,
    result: {
      requestId: randomUUID(),
      digest: sha,
      artifactDigest: 'b'.repeat(64),
      source: {
        scope: nativeScope,
        nativeSessionId: 'native-session',
        nativeAgentId: 'native-agent',
        configurationId: 'configuration',
        toolVersion: 'zhuma-native-result-intent@1',
        intentId: 'intent',
        callId: 'call',
        cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 4 },
      },
    },
  };
  remoteRunEventSchema.parse(completed);
  const { result: _result, ...missing } = completed;
  assert.equal(remoteRunEventSchema.safeParse(missing).success, false);
  assert.equal(remoteRunEventSchema.safeParse({ ...completed, flushed: false }).success, false);
  assert.equal(
    remoteRunEventSchema.safeParse({ kind: 'failed', sequence: 1, resourcesSettled: true }).success,
    false,
  );
});

test('remote protocol fixed output: artifact digest includes real server refs and never reinterprets the original native digest', () => {
  const value = remoteResultDigestInput({
    text: '  fixed result  ',
    links: ['https://example.com/result'],
    files: [],
  });
  assert.equal(value.text, 'fixed result');
  const hash = (body) => createHash('sha256').update(canonicalPayload(body)).digest('hex');
  const nativeDigest = hash({ text: value.text, links: value.links });
  assert.notEqual(hash(value), nativeDigest);
  assert.throws(() => remoteResultDigestInput({ text: '', links: [], files: [] }));
  assert.throws(() =>
    remoteResultDigestInput({
      text: 'result',
      links: ['https://name:secret@example.com/result'],
      files: [],
    }),
  );
});

test('remote protocol fixed resources: relative metadata cannot become a local filesystem root', () => {
  const input = {
    slotId: 'slot',
    kind: 'resource',
    name: 'reference',
    resourceRef: { id: 'skill', version: 'plan' },
    byteSize: 1,
    sha256: sha,
  };
  remoteInputDescriptorSchema.parse({ ...input, relativePath: 'references/api.md' });
  for (const relativePath of [
    '/private/file',
    '../file',
    'a/../file',
    'C:/private/file',
    'a\\file',
    'a//file',
    'a\0file',
  ])
    assert.equal(remoteInputDescriptorSchema.safeParse({ ...input, relativePath }).success, false);
});

test('remote permit contract: both Hosts hash the same canonical decoded 32 bytes, never the token text', () => {
  for (const vector of REMOTE_RUN_PERMIT_HASH_VECTORS) {
    const decoded = remotePermitHashInput(vector.secret);
    assert.equal(decoded.length, 32);
    assert.equal(createHash('sha256').update(decoded).digest('hex'), vector.sha256);
    assert.notEqual(createHash('sha256').update(vector.secret).digest('hex'), vector.sha256);
    assert.deepEqual(Buffer.from(decoded), Buffer.from(vector.secret, 'base64url'));
  }
  for (const bad of ['A'.repeat(42), 'A'.repeat(44), 'b'.repeat(43), '/'.repeat(43)])
    assert.throws(() => remotePermitHashInput(bad));
});

test('remote HTTP response codecs: terminal state cannot regain drive; accept carries a bounded original composition instead of guessed fragments', () => {
  const current = scope(),
    epoch = randomUUID();
  const value = {
    scope: current,
    deviceId: randomUUID(),
    serverTime: Date.now(),
    authority: 'drive',
    permit: { id: randomUUID(), epoch, expiresAt: Date.now() + 60000 },
    cleanup: { id: randomUUID(), epoch, expiresAt: Date.now() + 100000 },
    nodeVersion: 1,
    runVersion: 1,
    nextSequence: 1,
    stopRequested: false,
    resources: 'held',
    runStatus: 'requested',
  };
  remoteRunResponseSchema('status').parse({ ok: true, value });
  for (const changed of [
    { ...value, stopRequested: true },
    { ...value, runStatus: 'completed' },
    { ...value, resources: 'settled' },
  ])
    assert.equal(remoteRunViewSchema.safeParse(changed).success, false);
  assert.equal(
    remoteRunViewSchema.safeParse({
      ...value,
      authority: 'commit-only',
      resources: 'settled',
      runStatus: 'completed',
    }).success,
    false,
  );
  const handoff = {
    nodeId: 'node',
    taskId: 'task',
    workflowVersionId: 'plan',
    revision: 1,
    goal: 'Work',
    dependencyNodeIds: [],
    reviewRequired: false,
    reviewerIds: [],
    inputRefs: [],
    skillRefs: [],
    mcpRefs: [],
    inputNote: '',
    expectedOutput: 'Result',
    assignee: { id: 'member', kind: 'human' },
  };
  // The core bounds the JSON carrier; C must additionally run the ORIGINAL
  // readExecutionRunComposition decoder. This is not a fake native snapshot proof.
  const accepted = {
    ...value,
    disposition: 'accepted',
    selection: { provider: 'local', model: 'local', maxTokens: 4096, configurationId: 'cfg' },
    shared: {
      configurationId: 'cfg',
      context: 'context',
      handoff,
      inputs: [],
      composition: { schemaVersion: 1, configurationId: 'cfg', payload: {} },
    },
  };
  remoteAcceptValueSchema.parse(accepted);
  const { disposition: _accepted, ...live } = accepted;
  const recovered = { ...live, authority: 'recovery-required' };
  remoteRunResponseSchema('reconcile').parse({ ok: true, value: recovered });
  assert.equal(
    remoteRunResponseSchema('reconcile').safeParse({ ok: true, value: live }).success,
    false,
  );
  assert.equal(remoteRunResponseSchema('reconcile').safeParse({ ok: true, value }).success, false);
  assert.equal(
    remoteRunResponseSchema('reconcile').safeParse({ ok: true, value: accepted }).success,
    false,
  );
  assert.equal(
    remoteRunResponseSchema('status').safeParse({ ok: true, value: recovered }).success,
    false,
  );
  assert.equal(
    remoteRunResponseSchema('renew').safeParse({ ok: true, value: recovered }).success,
    false,
  );
  const { composition: _composition, ...fragments } = accepted.shared;
  assert.equal(
    remoteAcceptValueSchema.safeParse({ ...accepted, shared: fragments }).success,
    false,
  );
  assert.equal(
    remoteAcceptValueSchema.safeParse({
      ...accepted,
      shared: { ...accepted.shared, composition: { oversized: '中'.repeat(65536 / 3) } },
    }).success,
    false,
  );
  assert.equal(
    remoteAcceptValueSchema.safeParse({ ...accepted, secret: 'A'.repeat(43) }).success,
    false,
  );
  remoteRunResponseSchema('status').parse({ ok: false, error: { code: 'remote-permit-revoked' } });
  assert.equal(
    remoteRunResponseSchema('status').safeParse({
      ok: false,
      error: { code: 'remote-permit-revoked', rawError: '/private/path' },
    }).success,
    false,
  );
});

test('remote knowledge capability: exact optional implementation version is signed data, without library or draft authority', () => {
  const body = accept();
  const legacy = remoteRunRequestSchema.parse(body);
  assert.equal(Object.hasOwn(legacy.payload.capabilities, 'knowledge'), false);
  const before = canonicalPayload(remoteDeviceSigningInput(body));
  body.payload.capabilities.knowledge = 'zhuma-native-knowledge@1';
  assert.deepEqual(remoteRunRequestSchema.parse(body), body);
  assert.notEqual(canonicalPayload(remoteDeviceSigningInput(body)), before);
  for (const knowledge of [true, null, 'zhuma-native-knowledge@2', { allowDrafts: true }])
    assert.equal(
      remoteRunRequestSchema.safeParse({
        ...body,
        payload: { ...body.payload, capabilities: { ...body.payload.capabilities, knowledge } },
      }).success,
      false,
    );
  for (const field of ['allowDrafts', 'libraryId', 'cookie', 'assertCurrent'])
    assert.equal(
      remoteRunRequestSchema.safeParse({
        ...body,
        payload: {
          ...body.payload,
          capabilities: { ...body.payload.capabilities, [field]: 'not-authority' },
        },
      }).success,
      false,
    );
});

test('remote migration projection: bounded predecessor facts are optional data, with no workspace, proof or permission fields', () => {
  const current = scope(),
    previous = { ...current, generation: 1, runId: randomUUID(), segmentId: randomUUID() };
  current.generation = 3;
  const value = {
    scope: current,
    deviceId: randomUUID(),
    serverTime: Date.now(),
    authority: 'drive',
    permit: { id: randomUUID(), epoch: randomUUID(), expiresAt: Date.now() + 1000 },
    cleanup: { id: randomUUID(), epoch: randomUUID(), expiresAt: Date.now() + 2000 },
    nodeVersion: 1,
    runVersion: 1,
    nextSequence: 1,
    stopRequested: false,
    resources: 'held',
    runStatus: 'requested',
    migration: {
      requestId: randomUUID(),
      inputFingerprint: sha,
      predecessors: [
        {
          scope: previous,
          deviceId: randomUUID(),
          keyEpoch: 1,
          selection: {
            provider: 'contract',
            model: 'local',
            maxTokens: 1000,
            configurationId: 'fixed',
          },
          runStatus: 'cancelled',
          resources: 'settled',
          dispatch: 'reserved',
          acknowledged: false,
        },
      ],
    },
  };
  remoteRunViewSchema.parse(value);
  const held = structuredClone(value);
  held.migration.predecessors[0].resources = 'held';
  assert.equal(remoteRunViewSchema.safeParse(held).success, false);
  const extra = structuredClone(value);
  extra.migration.predecessors[0].workspace = { kind: 'local', path: '/not-a-wire-field' };
  assert.equal(remoteRunViewSchema.safeParse(extra).success, false);
});

test('remote info contract: ready independent review purpose is bounded, unique and explicitly advertised', () => {
  const value = {
    protocolVersion: 1,
    backendId: randomUUID(),
    serverTime: Date.now(),
    actorId: 'member',
    purposes: ['work', 'review'],
    operations: ['info', 'accept'],
  };
  remoteRunResponseSchema('info').parse({ ok: true, value });
  remoteRunResponseSchema('info').parse({ ok: true, value: { ...value, purposes: ['work'] } });
  assert.equal(
    remoteRunResponseSchema('info').safeParse({
      ok: true,
      value: { ...value, purposes: ['work', 'work'] },
    }).success,
    false,
  );
  assert.equal(
    remoteRunResponseSchema('info').safeParse({
      ok: true,
      value: { ...value, purposes: ['unknown'] },
    }).success,
    false,
  );
});
