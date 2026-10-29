/** Portable DTO/signing contracts only; no backend arm or native authority. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  remoteRunRequestSchema,
  remoteWorkflowIntentSchema,
  remoteWorkflowViewSchema,
  remoteDeviceSigningInput,
  remoteBackendInfoSchema,
  REMOTE_RUN_OPERATIONS,
} from '../dist/remote-run-contract.js';
import { canonicalPayload } from '../dist/concurrency.js';

const target = { spaceId: 'team', taskId: 'task', planId: 'plan', revision: 1 };
const defaults = () => ({
  model: { provider: 'contract', model: 'model', maxTokens: 1000 },
  workspace: { kind: 'text-only' },
  capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
});
const workflow = () => ({ intentId: randomUUID(), generation: 1 });
const request = (operation, payload) => ({
  protocolVersion: 1,
  backendId: randomUUID(),
  requestId: randomUUID(),
  deviceId: randomUUID(),
  proof: { issuedAt: Date.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
  operation,
  payload,
});
const intent = () => ({
  schemaVersion: 1,
  ...workflow(),
  actorId: 'member',
  spaceId: target.spaceId,
  deviceId: randomUUID(),
  keyEpoch: 1,
  version: 1,
  status: 'running',
  defaults: defaults(),
  budget: { concurrent: 1, automaticRevisions: 2 },
  nodeIds: ['node'],
  commandReceipts: [
    { requestId: randomUUID(), kind: 'start', fingerprint: 'a'.repeat(64), generation: 1 },
  ],
});
const view = () => {
  const value = intent();
  return {
    disposition: 'unchanged',
    scope: {
      ...target,
      actorId: value.actorId,
      deviceId: value.deviceId,
      intentId: value.intentId,
      generation: value.generation,
    },
    intent: value,
    state: 'requires-resume',
    requiresResume: true,
    serverTime: Date.now(),
    activeWork: [],
    activeReviews: [],
    candidates: [],
    attention: [],
  };
};

test('workflow DTO: five signed operations retain exact scope and reject caller actor/device substitution fields', () => {
  for (const operation of [
    'workflow-start',
    'workflow-status',
    'workflow-next',
    'workflow-resume',
    'workflow-stop',
  ]) {
    const payload =
      operation === 'workflow-start'
        ? { target, defaults: defaults() }
        : {
            target,
            workflow: workflow(),
            ...(operation === 'workflow-resume' ? { expectedVersion: 1 } : {}),
          };
    const raw = request(operation, payload),
      parsed = remoteRunRequestSchema.parse(raw);
    assert.equal(parsed.operation, operation);
    assert.equal(
      remoteRunRequestSchema.safeParse({ ...raw, payload: { ...payload, actorId: 'other' } })
        .success,
      false,
    );
    assert.equal(
      remoteRunRequestSchema.safeParse({ ...raw, payload: { ...payload, deviceId: raw.deviceId } })
        .success,
      false,
    );
    const { proof, ...unsigned } = raw;
    assert.equal(remoteRunRequestSchema.safeParse(unsigned).success, false);
    const signed = remoteDeviceSigningInput(parsed);
    assert.equal('signature' in signed.proof, false);
    assert.deepEqual(signed.payload.target, target);
  }
});
test('workflow DTO: status discovers without ref, while next/resume/stop require exact ref', () => {
  remoteRunRequestSchema.parse(request('workflow-status', { target }));
  for (const operation of ['workflow-next', 'workflow-resume', 'workflow-stop'])
    assert.equal(
      remoteRunRequestSchema.safeParse(request(operation, { target, expectedVersion: 1 })).success,
      false,
    );
  remoteWorkflowViewSchema.parse({
    disposition: 'unchanged',
    scope: { ...target, actorId: 'member', deviceId: randomUUID() },
    intent: null,
    state: 'inactive',
    requiresResume: false,
    serverTime: Date.now(),
    activeWork: [],
    activeReviews: [],
    candidates: [],
    attention: [],
  });
});
test('workflow DTO: explicit bounded defaults freeze a workspace selection, never one Runs ephemeral grant', () => {
  const raw = request('workflow-start', { target, defaults: defaults() });
  const parsed = remoteRunRequestSchema.parse(raw);
  assert.deepEqual(parsed.payload.budget, { concurrent: 1, automaticRevisions: 2 });
  raw.payload.defaults.workspace = { kind: 'local', rootId: 'chosen-root', access: 'write' };
  remoteRunRequestSchema.parse(raw);
  assert.equal(
    remoteRunRequestSchema.safeParse({
      ...raw,
      payload: {
        ...raw.payload,
        defaults: {
          ...raw.payload.defaults,
          workspace: { ...raw.payload.defaults.workspace, grantId: 'stale-grant', generation: 1 },
        },
      },
    }).success,
    false,
  );
  for (const budget of [
    { concurrent: 0, automaticRevisions: 2 },
    { concurrent: 5, automaticRevisions: 2 },
    { concurrent: 1, automaticRevisions: 3 },
  ])
    assert.equal(
      remoteRunRequestSchema.safeParse({ ...raw, payload: { ...raw.payload, budget } }).success,
      false,
    );
});
test('workflow DTO: publication ranges are explicit signed defaults and preserve legacy absent bytes', () => {
  const raw = request('workflow-start', {
    target,
    defaults: {
      ...defaults(),
      workspace: { kind: 'local', rootId: 'chosen-root', access: 'write' },
    },
    budget: { concurrent: 1, automaticRevisions: 2 },
  });
  const legacy = remoteRunRequestSchema.parse(raw);
  assert.deepEqual(legacy, raw);
  assert.equal(Object.hasOwn(legacy.payload.defaults.workspace, 'publish'), false);
  const signed = canonicalPayload(remoteDeviceSigningInput(legacy));
  const { signature: _signature, ...proof } = raw.proof;
  assert.equal(signed, canonicalPayload({ ...raw, proof }));
  for (const publish of [[], [{ kind: 'directory', path: 'deliverables' }]]) {
    const explicit = remoteRunRequestSchema.parse({
      ...raw,
      payload: {
        ...raw.payload,
        defaults: {
          ...raw.payload.defaults,
          workspace: { ...raw.payload.defaults.workspace, publish },
        },
      },
    });
    assert.deepEqual(explicit.payload.defaults.workspace.publish, publish);
    assert.notEqual(canonicalPayload(remoteDeviceSigningInput(explicit)), signed);
    const value = intent();
    value.defaults = explicit.payload.defaults;
    assert.deepEqual(remoteWorkflowIntentSchema.parse(value).defaults, explicit.payload.defaults);
  }
});
test('workflow DTO: publication paths match original per-run bounds and cannot grant a workspace root', () => {
  const valid = (publish) =>
    remoteRunRequestSchema.safeParse(
      request('workflow-start', {
        target,
        defaults: {
          ...defaults(),
          workspace: { kind: 'local', rootId: 'chosen-root', access: 'write', publish },
        },
      }),
    ).success;
  for (const path of ['deliverables/report.md', '交付/结果.txt', 'a'.repeat(512)])
    assert.equal(valid([{ kind: 'file', path }]), true, path);
  for (const path of [
    '',
    '/',
    '/tmp/report',
    '.',
    '..',
    './report',
    '../report',
    'out/../report',
    'out/./report',
    'out//report',
    'out/',
    'C:/report',
    'C:report',
    '\\server\\share',
    'out\\report',
    'https://example.test/report',
    'out\0report',
    'out\nreport',
    'out\u007freport',
    'a'.repeat(513),
  ])
    assert.equal(valid([{ kind: 'file', path }]), false, JSON.stringify(path));
  assert.equal(
    valid(Array.from({ length: 16 }, (_, index) => ({ kind: 'file', path: `out/${index}` }))),
    true,
  );
  assert.equal(
    valid(Array.from({ length: 17 }, (_, index) => ({ kind: 'file', path: `out/${index}` }))),
    false,
  );
  assert.equal(
    valid([
      { kind: 'file', path: 'report' },
      { kind: 'file', path: 'report' },
    ]),
    false,
  );
  assert.equal(
    valid(
      Array.from({ length: 16 }, (_, index) => ({
        kind: 'file',
        path: `${index}/${'a'.repeat(300)}`,
      })),
    ),
    false,
  );
  assert.equal(valid([{ kind: 'all', path: 'report' }]), false);
});
test('workflow DTO: original info stays valid and explicit workflow negotiation cannot introduce secrets or arbitrary features', () => {
  const header = { protocolVersion: 1, operation: 'info', requestId: randomUUID() };
  remoteRunRequestSchema.parse({ ...header, payload: {} });
  remoteRunRequestSchema.parse({ ...header, payload: { workflow: 'zhuma-remote-workflow@1' } });
  assert.equal(
    remoteRunRequestSchema.safeParse({
      ...header,
      payload: { workflow: 'latest', secret: 'not-a-permit' },
    }).success,
    false,
  );
  const oldOps = REMOTE_RUN_OPERATIONS.filter((operation) => !operation.startsWith('workflow-'));
  assert.equal(oldOps.length, 16);
  remoteBackendInfoSchema.parse({
    protocolVersion: 1,
    backendId: randomUUID(),
    actorId: 'member',
    serverTime: Date.now(),
    purposes: ['work'],
    operations: oldOps,
  });
});
test('workflow DTO: cold view binds actor/device/fixed plan/intent generation and cannot carry authority or a candidate', () => {
  const valid = view();
  remoteWorkflowViewSchema.parse(valid);
  for (const patch of [
    { actorId: 'other' },
    { deviceId: randomUUID() },
    { intentId: randomUUID() },
    { generation: 2 },
  ])
    assert.equal(
      remoteWorkflowViewSchema.safeParse({ ...valid, scope: { ...valid.scope, ...patch } }).success,
      false,
    );
  assert.equal(
    remoteWorkflowViewSchema.safeParse({ ...valid, permit: { raw: 'not-allowed' } }).success,
    false,
  );
  assert.equal(
    remoteWorkflowViewSchema.safeParse({ ...valid, requiresResume: false }).success,
    false,
  );
});
test('workflow DTO: duplicate receipts, foreign generation and duplicated node IDs cannot create another arm', () => {
  const valid = intent();
  remoteWorkflowIntentSchema.parse(valid);
  assert.equal(
    remoteWorkflowIntentSchema.safeParse({ ...valid, nodeIds: ['node', 'node'] }).success,
    false,
  );
  assert.equal(
    remoteWorkflowIntentSchema.safeParse({
      ...valid,
      commandReceipts: [...valid.commandReceipts, valid.commandReceipts[0]],
    }).success,
    false,
  );
  assert.equal(
    remoteWorkflowIntentSchema.safeParse({
      ...valid,
      commandReceipts: [{ ...valid.commandReceipts[0], generation: 2 }],
    }).success,
    false,
  );
});

test('portable workflow: original initiated-rework projection is optional for old views, bounded, unique and scoped to this intent', () => {
  const value = view();
  assert.equal(remoteWorkflowViewSchema.safeParse(value).success, true);
  value.revisions = [{ nodeId: 'node', used: 1, limit: 2 }];
  assert.equal(remoteWorkflowViewSchema.safeParse(value).success, true);
  for (const revisions of [
    [{ nodeId: 'outside', used: 1, limit: 2 }],
    [
      { nodeId: 'node', used: 1, limit: 2 },
      { nodeId: 'node', used: 1, limit: 2 },
    ],
    [{ nodeId: 'node', used: 3, limit: 2 }],
    [{ nodeId: 'node', used: 1, limit: 0 }],
    [{ nodeId: 'node', used: 0, limit: 1 }],
  ])
    assert.equal(remoteWorkflowViewSchema.safeParse({ ...value, revisions }).success, false);
});
