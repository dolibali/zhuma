/** Synthetic Host/source contracts only. No C physical-drain, persistence,
 * HTTP/member-issuer, SDK/Agent, model or product-UI qualification is implied.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalPayload, submitExpertDelivery } from '@zhuma/agent-core';
import { NativeReleasedConversationAuthorities } from '../dist/native-released-conversation-authority.js';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import {
  executionRunScope,
  readExecutionRunState,
  requestExecutionRunStop,
  beginExecutionRun,
} from '../dist/execution-run-state.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { nativeResultProvenance } from '../dist/execution-native-result-delivery.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';
import {
  accepted,
  applyEvent,
  begin,
  command,
  available,
  locator,
  stable,
  stopCommand,
} from './execution-run-fixture.mjs';

const request = Object.freeze({ headers: { cookie: 'synthetic-member' } });
const outside = Object.freeze({ headers: { cookie: 'synthetic-other-member' } });
const denied = { code: 'conversation-authority-denied', message: '会话操作未完成。' };
const pending = { code: 'conversation-authority-pending' };
const unavailable = { code: 'conversation-authority-unavailable' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function stopped() {
  const running = accepted();
  const stopping = requestExecutionRunStop(running, stopCommand(running)).record;
  return applyEvent(stopping, 'stopped', stable).record;
}
function delivered() {
  const facts = compositionFacts({ upstream: true, expert: true });
  const composition = freezeExecutionRunComposition({
    ...facts,
    resultIntentTool: describeNativeResultTool(),
  });
  const { firstMessage: _text, ...projection } = executionRunCompositionRequest(composition);
  let row = beginExecutionRun(
    facts.node,
    { ...command(facts.node), ...projection, composition },
    [facts.node],
    available,
  ).record;
  row = accepted(row);
  row = applyEvent(row, 'completed', stable).record;
  const run = readExecutionRunState(row).runs[0];
  const source = {
    scope: executionRunScope(row, run),
    nativeSessionId: run.attempt.sessionId,
    nativeAgentId: run.attempt.executorRunId,
    configurationId: composition.configurationId,
    toolVersion: 'zhuma-native-result-intent@1',
    intentId: 'contract-intent',
    callId: 'contract-call',
    cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
  };
  const content = { text: 'fixed contract artifact', links: [] };
  const digest = nativeResultDigest(content);
  const provenanceFingerprint = nativeResultProvenance(source, digest);
  const sent = submitExpertDelivery({
    record: row,
    expertId: 'qa',
    producerRunId: run.attempt.id,
    provenanceFingerprint,
    idempotencyKey: 'fixed-submit',
    expectedVersion: row.command.version,
    draft: { ...content, files: [] },
    artifactId: 'fixed-artifact',
    roundId: 'fixed-round',
  });
  assert.equal(sent.ok, true, sent.code);
  const state = readExecutionRunState(sent.record);
  return {
    ...sent.record,
    nativeExecution: {
      ...state,
      runs: state.runs.map((item) => ({
        ...item,
        resultDelivery: {
          protocolVersion: 1,
          source,
          digest,
          provenanceFingerprint,
          receiptKey: 'fixed-submit',
          artifactVersionId: 'fixed-artifact',
        },
      })),
    },
  };
}

function setup(options = {}) {
  let row = options.row ?? stopped();
  let current = true,
    controller = 'chen',
    member = true;
  let backendId = 'backend-contract',
    backendIdentity = {};
  let readiness,
    failRetire = false,
    failSettled = false;
  let leaseGate = options.leaseGate,
    epochGate = options.epochGate;
  let settleGate = options.settleGate,
    retireGate = options.retireGate;
  let expiresIn = options.expiresIn ?? 60_000;
  let stopStatus = options.stopStatus ?? 'stopped';
  let ignoreLateAuthority = false,
    returnCopy = false;
  let releases = 0,
    opens = 0,
    retireCalls = 0,
    epochSequence = 0;
  const sourceLifetime = new AbortController();
  const changes = new Set(),
    issued = new WeakSet(),
    active = new Map(),
    aborts = new WeakMap(),
    epochKeys = new WeakMap();
  const leases = [],
    epochs = [],
    requests = [];
  const authRequests = new Map([
    [request, 'chen'],
    [outside, 'outside'],
  ]);
  const source = {
    signal: sourceLifetime.signal,
    writerState: () => ({ schemaVersion: 1, nativeExecutionWriter: 1 }),
    async memberLease(req) {
      await leaseGate?.promise;
      const memberId = authRequests.get(req);
      if (!memberId) throw Error('PRIVATE request/cookie/source detail');
      const abort = new AbortController();
      const lease = {
        memberId,
        expiresAt: Date.now() + expiresIn,
        signal: abort.signal,
        assertCurrent(space) {
          if (!current || !member || space !== 'north') throw Error('PRIVATE member/directory');
        },
        release() {
          releases++;
          options.onRelease?.();
        },
      };
      leases.push({ lease, abort });
      return lease;
    },
    backend: () => ({ id: backendId, identity: backendIdentity }),
    readNode: () => row,
    assertNodeAccess(_actor, space, _row, action) {
      if (!current || !member || space !== 'north' || action !== 'history')
        throw Error('PRIVATE task source');
    },
    assertController(actor) {
      if (actor !== controller) throw Error('PRIVATE controller');
    },
    onChange(fn) {
      changes.add(fn);
      return () => changes.delete(fn);
    },
    async openEpoch(input) {
      input.assertCurrent();
      requests.push(input);
      await epochGate?.promise;
      if (!ignoreLateAuthority) input.assertCurrent();
      if (readiness) throw readiness;
      const run = readExecutionRunState(row).runs.find(
        (item) => item.attempt.id === input.origin.runId,
      );
      if (active.has(run.attempt.sessionId)) throw new NativeWorkError('migration-not-ready');
      const binding = {
        schemaVersion: 1,
        scope: input.origin,
        nativeSessionId: run.attempt.sessionId,
        nativeAgentId: run.attempt.executorRunId,
        selection: run.selection,
        receipts: [],
        ...(run.resultDelivery
          ? {
              resultIntent: {
                protocolVersion: 1,
                toolVersion: run.resultDelivery.source.toolVersion,
                intentId: run.resultDelivery.source.intentId,
                callId: run.resultDelivery.source.callId,
                digest: run.resultDelivery.digest,
                cut: run.resultDelivery.source.cut,
              },
            }
          : {}),
      };
      const abort = new AbortController();
      const epoch = {
        kind: 'chat-only',
        chatEpoch: ++epochSequence,
        actorId: input.actorId,
        backendId: input.backend.id,
        binding: structuredClone(binding),
        signal: abort.signal,
      };
      issued.add(epoch);
      active.set(binding.nativeSessionId, epoch);
      epochKeys.set(epoch, binding.nativeSessionId);
      aborts.set(epoch, abort);
      epochs.push(epoch);
      opens++;
      return returnCopy ? { ...epoch } : epoch;
    },
    assertEpoch(epoch) {
      if (
        !issued.has(epoch) ||
        active.get(epochKeys.get(epoch)) !== epoch ||
        epoch.signal.aborted ||
        readiness
      )
        throw Error('PRIVATE native owner/readiness');
    },
    async retireEpoch(epoch) {
      if (!issued.has(epoch)) throw Error('PRIVATE foreign epoch');
      retireCalls++;
      aborts.get(epoch).abort();
      await retireGate?.promise;
      if (failRetire === 'void') throw undefined;
      if (failRetire) throw Error('PRIVATE stop/source failure');
      return stopStatus;
    },
    async whenEpochSettled(epoch) {
      if (!issued.has(epoch)) throw Error('PRIVATE foreign close');
      await settleGate?.promise;
      if (failSettled === 'void') throw undefined;
      if (failSettled) throw Error('PRIVATE physical close failure');
      if (active.get(epochKeys.get(epoch)) === epoch) active.delete(epochKeys.get(epoch));
      issued.delete(epoch);
    },
  };
  const manager = new NativeReleasedConversationAuthorities(source);
  return {
    manager,
    source,
    sourceLifetime,
    leases,
    epochs,
    requests,
    changes,
    authorize(req, actor = 'chen') {
      authRequests.set(req, actor);
    },
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    get opens() {
      return opens;
    },
    get releases() {
      return releases;
    },
    get retireCalls() {
      return retireCalls;
    },
    get active() {
      return active.size;
    },
    set member(value) {
      member = value;
    },
    set controller(value) {
      controller = value;
    },
    set backendId(value) {
      backendId = value;
    },
    set backendIdentity(value) {
      backendIdentity = value;
    },
    set readiness(value) {
      readiness = value;
    },
    set ignoreLateAuthority(value) {
      ignoreLateAuthority = value;
    },
    set returnCopy(value) {
      returnCopy = value;
    },
    set failRetire(value) {
      failRetire = value;
    },
    set failSettled(value) {
      failSettled = value;
    },
    set stopStatus(value) {
      stopStatus = value;
    },
    invalidate() {
      current = false;
      for (const fn of changes) fn();
    },
    emit() {
      for (const fn of changes) fn();
    },
  };
}
async function open(h, req = request) {
  return h.manager.open(req, locator(h.row));
}

test('contract: required Host ports fail closed, and a claimed/cached MemberRequest is not an issuer', async () => {
  assert.throws(
    () => new NativeReleasedConversationAuthorities({ signal: new AbortController().signal }),
    unavailable,
  );
  const h = setup();
  await assert.rejects(open(h, { ...request }), denied);
  await assert.rejects(
    open(h, { member: { ok: true, memberId: 'chen', spaceIds: ['north'] } }),
    denied,
  );
  await assert.rejects(h.manager.open(request, { ...locator(h.row), actorId: 'chen' }), {
    code: 'conversation-authority-validation',
  });
  assert.equal(h.opens, 0);
  await h.manager.close();
});

for (const [name, row] of [
  ['cancelled', stopped],
  ['delivered', delivered],
])
  test(`contract: ${name} grants only fresh chat rights and never rewrites original facts`, async () => {
    const h = setup({ row: row() });
    const before = canonicalPayload(h.row);
    const owned = await open(h);
    for (const action of ['read', 'send', 'stop']) h.manager.assertGrant(owned.grant, action);
    assert.equal(Object.hasOwn(owned.grant, 'scope'), false);
    assert.equal(
      owned.grant.origin.nativeSessionId,
      readExecutionRunState(h.row).runs[0].attempt.sessionId,
    );
    assert.equal(owned.grant.actorId, 'chen');
    assert(Object.isFrozen(owned.grant.origin.scope));
    assert.throws(() => {
      owned.grant.origin.scope.actorId = 'outside';
    }, TypeError);
    assert.throws(() => h.manager.assertGrant({ ...owned.grant }, 'send'), denied);
    assert.throws(
      () => h.manager.assertGrant(JSON.parse(JSON.stringify(owned.grant)), 'send'),
      denied,
    );
    const other = setup();
    assert.throws(() => other.manager.assertGrant(owned.grant, 'send'), denied);
    await other.manager.close();
    assert.equal(canonicalPayload(h.row), before);
    assert.equal(await h.manager.stop(owned.grant), 'stopped');
    assert.equal(canonicalPayload(h.row), before);
    assert.equal(h.retireCalls, 1);
    assert.equal(h.releases, 1);
    await h.manager.close();
  });

test('contract: task read membership does not confer controller or chat rights', async () => {
  const h = setup();
  await assert.rejects(open(h, outside), denied);
  assert.equal(h.opens, 0);
  await h.manager.close();
});

for (const [name, change] of [
  ['requested/unadmitted', () => begin().record],
  ['running', () => accepted()],
  ['failed', () => applyEvent(accepted(), 'failed', { resourcesSettled: true }).record],
  [
    'completed without fixed durable delivery',
    () => applyEvent(accepted(), 'completed', stable).record,
  ],
  [
    'terminal but resources held',
    () => {
      const r = stopped();
      r.nativeExecution.runs[0].resources = 'held';
      return r;
    },
  ],
  [
    'cancelled without confirmed stop',
    () => {
      const r = stopped();
      r.nativeExecution.runs[0].attempt.stopPhase = 'none';
      return r;
    },
  ],
  ['missing original node', () => undefined],
  ['corrupt original state', () => ({ ...stopped(), nativeExecution: {} })],
])
  test(`contract: ${name} cannot acquire a chat epoch`, async () => {
    const h = setup();
    const target = locator(h.row);
    h.row = change();
    await assert.rejects(h.manager.open(request, target), denied);
    assert.equal(h.opens, 0);
    await h.manager.close();
  });

for (const [name, error, expected] of [
  ['physical old drain pending', new NativeWorkError('migration-not-ready'), pending],
  ['old inbox pending', new NativeWorkError('input-pending'), pending],
  ['original Session missing', new NativeWorkError('delivery-unknown'), denied],
  ['migration unknown', new NativeWorkError('migration-unknown'), denied],
  ['foreign writer', new NativeWorkError('unavailable'), denied],
])
  test(`contract: native ${name} is not manufactured into ready`, async () => {
    const h = setup();
    h.readiness = error;
    await assert.rejects(open(h), expected);
    assert.equal(h.opens, 0);
    await h.manager.close();
  });

for (const [name, revoke] of [
  [
    'member revoked',
    (h) => {
      h.member = false;
    },
  ],
  [
    'controller replaced',
    (h) => {
      h.controller = 'outside';
    },
  ],
  [
    'backend id replaced',
    (h) => {
      h.backendId = 'other';
    },
  ],
  [
    'backend binding replaced',
    (h) => {
      h.backendIdentity = {};
    },
  ],
  [
    'source callback replaced',
    (h) => {
      h.source.readNode = () => h.row;
    },
  ],
  [
    'source lifetime replaced',
    (h) => {
      h.source.signal = new AbortController().signal;
    },
  ],
  [
    'lease actor replaced',
    (h) => {
      h.leases[0].lease.memberId = 'outside';
    },
  ],
  [
    'lease expiry extended',
    (h) => {
      h.leases[0].lease.expiresAt += 1000;
    },
  ],
  [
    'lease assertion replaced',
    (h) => {
      h.leases[0].lease.assertCurrent = () => {};
    },
  ],
  [
    'epoch changed in place',
    (h) => {
      h.epochs[0].chatEpoch++;
    },
  ],
  [
    'binding changed in place',
    (h) => {
      h.epochs[0].binding.nativeSessionId = 'another';
    },
  ],
  [
    'source facts changed',
    (h) => {
      h.row.nativeExecution.runs[0].attempt.payloadHash = 'b'.repeat(64);
    },
  ],
])
  test(`contract: ${name} denies the next call without relying on a notification`, async () => {
    const h = setup();
    const owned = await open(h);
    revoke(h);
    assert.throws(() => h.manager.assertGrant(owned.grant, 'send'), denied);
    assert.equal(owned.grant.signal.aborted, true);
    await h.manager.close();
    assert.equal(h.releases, 1);
    assert.equal(h.retireCalls, 1);
  });

test('contract: live notifications and member expiry abort authority without another call', async () => {
  const h = setup();
  const owned = await open(h);
  h.member = false;
  h.emit();
  assert.equal(owned.grant.signal.aborted, true);
  await h.manager.close();
  const timed = setup({ expiresIn: 80 });
  const active = await open(timed);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('expiry not observed')), 1500);
    active.grant.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  assert.equal(active.grant.signal.aborted, true);
  await timed.manager.close();
});

test('contract: only chat actions are admitted; old Run authority rejects this grant', async () => {
  const h = setup();
  const owned = await open(h);
  const runs = new ExecutionRunAuthorities({
    ...h.source,
    assertWorkspace() {},
    assertNodeAccess() {},
  });
  const read = await runs.open(request, locator(h.row), 'read');
  assert.throws(() => h.manager.assertGrant(read.grant, 'send'), denied);
  read.dispose();
  assert.throws(() => runs.assertGrant(owned.grant, 'send'), { code: 'run-authority-denied' });
  assert.throws(() => h.manager.assertGrant(owned.grant, 'complete_work'), denied);
  assert.equal(owned.grant.signal.aborted, true);
  await Promise.all([h.manager.close(), runs.close()]);
});

test('contract: a cancelled view wait is not the admitted chat lifetime', async () => {
  const h = setup();
  const wait = new AbortController();
  const fromView = { ...request, signal: wait.signal };
  h.authorize(fromView);
  const owned = await open(h, fromView);
  wait.abort();
  h.manager.assertGrant(owned.grant, 'send');
  assert.equal(h.retireCalls, 0);
  owned.dispose();
  await h.manager.close();
});

test('contract: stop-pending retains the native owner and blocks another admission until actual drain', async () => {
  const settleGate = deferred();
  const h = setup({ stopStatus: 'pending', settleGate });
  const owned = await open(h);
  assert.equal(await h.manager.stop(owned.grant), 'pending');
  assert.equal(owned.grant.signal.aborted, true);
  await assert.rejects(open(h), pending);
  let closed = false;
  const closing = h.manager.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(h.active, 1);
  settleGate.resolve();
  await closing;
  assert.equal(h.active, 0);
  assert.equal(h.retireCalls, 1);
});

test('contract: stopped is not reported until the source confirms physical settlement', async () => {
  const settleGate = deferred();
  const h = setup({ settleGate });
  const owned = await open(h);
  let stopped = false;
  const stopping = h.manager.stop(owned.grant).then((result) => {
    stopped = true;
    return result;
  });
  await tick();
  assert.equal(stopped, false);
  settleGate.resolve();
  assert.equal(await stopping, 'stopped');
  await h.manager.close();
});

test('contract: dispose is idempotent, and a later epoch is separate from the immutable Run generation', async () => {
  const h = setup();
  const owned = await open(h);
  const generation = readExecutionRunState(h.row).runs[0].attempt.generation;
  assert.equal(await h.manager.stop(owned.grant), 'stopped');
  owned.dispose();
  const next = await open(h);
  assert.equal(next.grant.chatEpoch, owned.grant.chatEpoch + 1);
  assert.equal(next.grant.origin.nativeSessionId, owned.grant.origin.nativeSessionId);
  assert.equal(readExecutionRunState(h.row).runs[0].attempt.generation, generation);
  await h.manager.close();
});

test('contract: closing during a late member lookup consumes its lease without opening an epoch', async () => {
  const leaseGate = deferred();
  const h = setup({ leaseGate });
  const opening = assert.rejects(open(h), denied);
  await tick();
  let closed = false;
  const closing = h.manager.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  leaseGate.resolve();
  await Promise.all([opening, closing]);
  assert.equal(h.opens, 0);
  assert.equal(h.releases, 1);
  assert.equal(h.changes.size, 0);
});

test('contract: late native reservation after logout is never published and remains owned until drain', async () => {
  const epochGate = deferred(),
    settleGate = deferred();
  const h = setup({ epochGate, settleGate, stopStatus: 'pending' });
  h.ignoreLateAuthority = true;
  const opening = assert.rejects(open(h), denied);
  await tick();
  h.invalidate();
  let closed = false;
  const closing = h.manager.close().then(() => {
    closed = true;
  });
  epochGate.resolve();
  await opening;
  await tick();
  assert.equal(h.opens, 1);
  assert.equal(h.retireCalls, 1);
  assert.equal(closed, false);
  settleGate.resolve();
  await closing;
  assert.equal(h.releases, 1);
});

test('contract: stable source notifications during reservation do not turn read into a drive grant', async () => {
  const epochGate = deferred();
  const h = setup({ epochGate });
  const opening = open(h);
  await tick();
  h.emit();
  h.requests[0].assertCurrent();
  epochGate.resolve();
  const owned = await opening;
  h.manager.assertGrant(owned.grant, 'send');
  await h.manager.close();
});

for (const [name, patch] of [
  [
    'unknown original receipt',
    (epoch) => {
      epoch.binding.receipts.push({
        requestId: 'old',
        messageId: 'old-message',
        fingerprint: 'a'.repeat(64),
        mode: 'followup',
        status: 'unknown',
      });
    },
  ],
  [
    'unsealed original intent',
    (epoch) => {
      epoch.binding.resultIntent = {
        protocolVersion: 1,
        toolVersion: 'zhuma-native-result-intent@1',
        intentId: 'intent',
        callId: 'call',
        digest: 'a'.repeat(64),
      };
    },
  ],
  [
    'wrong binding generation',
    (epoch) => {
      epoch.binding.scope.generation++;
    },
  ],
  [
    'wrong epoch actor',
    (epoch) => {
      epoch.actorId = 'outside';
    },
  ],
  [
    'wrong epoch backend',
    (epoch) => {
      epoch.backendId = 'other';
    },
  ],
])
  test(`contract: ${name} in an acquired epoch is rejected and still cleaned`, async () => {
    const h = setup();
    const original = h.source.openEpoch;
    h.source.openEpoch = async (input) => {
      const epoch = await original(input);
      patch(epoch);
      return epoch;
    };
    // The source identity is frozen at construction; install a new manager for
    // this independently supplied source, rather than relaxing replacement checks.
    await h.manager.close();
    const manager = new NativeReleasedConversationAuthorities(h.source);
    await assert.rejects(manager.open(request, locator(h.row)), {
      code: /conversation-authority-(?:pending|denied)/,
    });
    await manager.close();
    assert.equal(h.retireCalls, 1);
  });

test('contract: a structurally copied C epoch is not an owned ticket and cannot be used or silently released', async () => {
  const h = setup();
  h.returnCopy = true;
  await assert.rejects(open(h), denied);
  await assert.rejects(h.manager.close(), unavailable);
  assert.equal(h.retireCalls, 0);
  assert.equal(h.active, 1);
});

for (const [kind, reason] of [
  ['retire', true],
  ['retire', 'void'],
  ['settlement', true],
  ['settlement', 'void'],
])
  test(`contract: ${kind} rejection (${reason}) cannot report stopped or erase unknown ownership`, async () => {
    const h = setup();
    const owned = await open(h);
    if (kind === 'retire') h.failRetire = reason;
    else h.failSettled = reason;
    await assert.rejects(h.manager.stop(owned.grant), {
      ...unavailable,
      message: '会话操作未完成。',
    });
    await assert.rejects(h.manager.close(), unavailable);
    assert.equal(h.active, 1);
    assert.equal(h.releases, 1);
  });

test('contract: thenable sync source assertions fail closed and private details never reach the grant error', async () => {
  const h = setup();
  await h.manager.close();
  h.source.assertController = () => Promise.reject(Error('PRIVATE key/path/header'));
  const manager = new NativeReleasedConversationAuthorities(h.source);
  await assert.rejects(manager.open(request, locator(h.row)), denied);
  assert.equal(h.opens, 0);
  await manager.close();
});

test('contract: a historical target stays bound to its original Session rather than the latest Run', async () => {
  const first = stopped();
  const oldTarget = locator(first);
  let row = begin(first, {
    mode: 'restart',
    requestId: 'restart-2',
    newRunId: 'run-2',
    newSegmentId: 'segment-2',
    expectedRunVersion: first.nativeExecution.version,
  }).record;
  row = accepted(row);
  row = requestExecutionRunStop(row, stopCommand(row, { requestId: 'stop-2' })).record;
  row = applyEvent(row, 'stopped', stable).record;
  const h = setup({ row });
  const before = canonicalPayload(row);
  const owned = await h.manager.open(request, oldTarget);
  assert.equal(owned.grant.origin.scope.runId, oldTarget.runId);
  assert.equal(owned.grant.origin.nativeSessionId, 'native-session-1');
  assert.equal(h.row.nativeExecution.currentRunId, 'run-2');
  assert.equal(canonicalPayload(h.row), before);
  await h.manager.close();
});

test('contract: backend replacement cannot admit the same physical Session while the old epoch drains', async () => {
  const settleGate = deferred();
  const h = setup({ settleGate, stopStatus: 'pending' });
  const owned = await open(h);
  h.backendId = 'new-backend';
  h.backendIdentity = {};
  h.emit();
  assert.equal(owned.grant.signal.aborted, true);
  await assert.rejects(open(h), pending);
  assert.equal(h.opens, 1);
  settleGate.resolve();
  await h.manager.close();
});

test('contract: source abort fences new grants while captured cleanup still settles the original epoch', async () => {
  const h = setup();
  const owned = await open(h);
  h.sourceLifetime.abort();
  assert.equal(owned.grant.signal.aborted, true);
  await assert.rejects(open(h), denied);
  await h.manager.close();
  assert.equal(h.active, 0);
  assert.equal(h.retireCalls, 1);
});

test('contract: synchronous member-release reentrancy sees the same closing promise', async () => {
  let h, reentrant;
  h = setup({
    onRelease() {
      reentrant = h.manager.close();
    },
  });
  await open(h);
  const closing = h.manager.close();
  assert.equal(closing, reentrant);
  await closing;
  assert.equal(h.active, 0);
});

test('contract: an immediately fenced queued open does not start a new member lookup', async () => {
  const h = setup();
  const opening = assert.rejects(open(h), denied);
  const closing = h.manager.close();
  await Promise.all([opening, closing]);
  assert.equal(h.leases.length, 0);
  assert.equal(h.opens, 0);
});

async function setupRead(options = {}) {
  const h = setup(options);
  await h.manager.close();
  const issued = new WeakSet(),
    live = new Set(),
    aborts = new WeakMap();
  let reads = 0,
    released = 0,
    error,
    epochOverride;
  let copy = false,
    ignoreLateAuthority = false;
  const currentEpoch = () => epochOverride ?? h.epochs.at(-1)?.chatEpoch ?? 0;
  h.source.openReadEpoch = async (input) => {
    input.assertCurrent();
    await options.readGate?.promise;
    if (!ignoreLateAuthority) input.assertCurrent();
    if (error) throw error;
    const run = readExecutionRunState(h.row)?.runs.find(
      (item) => item.attempt.id === input.origin.runId,
    );
    if (!run?.attempt.sessionId) throw new NativeWorkError('not-started');
    const abort = new AbortController();
    let done = false;
    const ticket = {
      kind: 'chat-history',
      chatEpoch: currentEpoch(),
      actorId: input.actorId,
      backendId: input.backend.id,
      signal: abort.signal,
      binding: {
        schemaVersion: 1,
        scope: input.origin,
        nativeSessionId: run.attempt.sessionId,
        nativeAgentId: run.attempt.executorRunId,
        selection: run.selection,
        receipts: [],
      },
      release() {
        if (done) return;
        done = true;
        released++;
        issued.delete(ticket);
        live.delete(ticket);
        abort.abort();
      },
    };
    issued.add(ticket);
    live.add(ticket);
    aborts.set(ticket, abort);
    reads++;
    return copy ? { ...ticket } : ticket;
  };
  h.source.assertReadEpoch = (ticket) => {
    if (!issued.has(ticket) || ticket.signal.aborted || ticket.chatEpoch !== currentEpoch())
      throw Error('PRIVATE read issuer/epoch/mapping');
  };
  h.manager = new NativeReleasedConversationAuthorities(h.source);
  return Object.assign(h, {
    getReadStats: () => ({ reads, released, live: live.size }),
    setReadError(value) {
      error = value;
    },
    copyReadTicket() {
      copy = true;
    },
    ignoreLateReadAuthority() {
      ignoreLateAuthority = true;
    },
    changeReadEpoch() {
      epochOverride = currentEpoch() + 1;
    },
    abortReader() {
      for (const ticket of live) aborts.get(ticket).abort();
    },
  });
}

test('passive contract: missing optional read ports are unavailable while the original send source remains usable', async () => {
  const h = setup();
  await assert.rejects(h.manager.openRead(request, locator(h.row)), unavailable);
  assert.equal(h.leases.length, 0);
  const send = await open(h);
  h.manager.assertGrant(send.grant, 'send');
  await h.manager.close();
});

test('passive contract: a currently visible non-controller reads an active Run without opening a writer', async () => {
  const h = await setupRead({ row: accepted() });
  const before = canonicalPayload(h.row);
  const read = await h.manager.openRead(outside, locator(h.row));
  h.manager.assertReadGrant(read.grant);
  assert.equal(read.grant.actorId, 'outside');
  assert.equal(read.grant.origin.scope.actorId, 'chen');
  assert.equal(read.grant.chatEpoch, 0);
  assert.equal(Object.hasOwn(read.grant, 'scope'), false);
  assert.equal(h.opens, 0);
  assert.equal(h.retireCalls, 0);
  assert.equal(canonicalPayload(h.row), before);
  read.dispose();
  read.dispose();
  assert.deepEqual(h.getReadStats(), { reads: 1, released: 1, live: 0 });
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});

test('passive contract: reader tickets cannot be promoted, copied, serialized or used across issuers', async () => {
  const h = await setupRead();
  const read = await h.manager.openRead(outside, locator(h.row));
  assert.throws(() => h.manager.assertGrant(read.grant, 'send'), denied);
  assert.throws(() => h.manager.stop(read.grant), denied);
  assert.throws(() => h.manager.assertReadGrant({ ...read.grant }), denied);
  assert.throws(() => h.manager.assertReadGrant(JSON.parse(JSON.stringify(read.grant))), denied);
  const other = await setupRead();
  assert.throws(() => other.manager.assertReadGrant(read.grant), denied);
  await other.manager.close();
  h.manager.assertReadGrant(read.grant);
  assert.equal(h.opens, 0);
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});

test('passive contract: a read grant does not reserve the chat or stop slot, and read disposal leaves chat running', async () => {
  const h = await setupRead();
  const firstRead = await h.manager.openRead(outside, locator(h.row));
  const send = await open(h);
  assert.throws(() => h.manager.assertReadGrant(firstRead.grant), denied);
  const currentRead = await h.manager.openRead(outside, locator(h.row));
  assert.equal(currentRead.grant.chatEpoch, send.grant.chatEpoch);
  currentRead.dispose();
  assert.equal(h.active, 1);
  assert.equal(h.retireCalls, 0);
  h.manager.assertGrant(send.grant, 'send');
  assert.throws(() => h.manager.assertReadGrant(send.grant), denied);
  await h.manager.close();
  assert.equal(h.retireCalls, 1);
});

test('passive contract: old epoch tickets reject without a hint and a new read observes the new epoch', async () => {
  const h = await setupRead();
  const read = await h.manager.openRead(outside, locator(h.row));
  h.changeReadEpoch();
  assert.throws(() => h.manager.assertReadGrant(read.grant), denied);
  const next = await h.manager.openRead(outside, locator(h.row));
  assert.equal(next.grant.chatEpoch, read.grant.chatEpoch + 1);
  h.manager.assertReadGrant(next.grant);
  assert.equal(h.opens, 0);
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});

test('passive contract: normal Run event progress does not change the reader identity', async () => {
  const h = await setupRead({ row: accepted() });
  const read = await h.manager.openRead(outside, locator(h.row));
  h.row = applyEvent(h.row, 'waiting').record;
  h.emit();
  h.manager.assertReadGrant(read.grant);
  h.row = applyEvent(h.row, 'resumed').record;
  h.manager.assertReadGrant(read.grant);
  assert.equal(h.opens, 0);
  await h.manager.close();
});

for (const [name, error] of [
  ['unknown mapping', new NativeWorkError('not-started')],
  ['preparing mapping', new NativeWorkError('migration-not-ready')],
  ['tombstone/foreign mapping', new NativeWorkError('scope-mismatch')],
])
  test(`passive contract: ${name} never creates or resumes a Session`, async () => {
    const h = await setupRead();
    h.setReadError(error);
    await assert.rejects(h.manager.openRead(outside, locator(h.row)), {
      code: /conversation-authority-(?:denied|pending)/,
    });
    assert.equal(h.getReadStats().reads, 0);
    assert.equal(h.opens, 0);
    assert.equal(h.retireCalls, 0);
    await h.manager.close();
  });

for (const [name, revoke] of [
  [
    'membership removed',
    (h) => {
      h.member = false;
    },
  ],
  [
    'backend replaced',
    (h) => {
      h.backendIdentity = {};
    },
  ],
  [
    'read source method replaced',
    (h) => {
      h.source.assertReadEpoch = () => {};
    },
  ],
  [
    'authenticated reader changed',
    (h) => {
      h.leases[0].lease.memberId = 'chen';
    },
  ],
  ['read source signal revoked', (h) => h.abortReader()],
])
  test(`passive contract: ${name} closes the read purpose without retiring chat`, async () => {
    const h = await setupRead();
    const read = await h.manager.openRead(outside, locator(h.row));
    revoke(h);
    assert.throws(() => h.manager.assertReadGrant(read.grant), denied);
    assert.equal(read.grant.signal.aborted, true);
    assert.equal(h.retireCalls, 0);
    assert.equal(h.getReadStats().released, 1);
    await h.manager.close();
  });

test('passive contract: controller changes do not revoke an otherwise visible current reader', async () => {
  const h = await setupRead();
  const read = await h.manager.openRead(outside, locator(h.row));
  h.controller = 'other-controller';
  h.emit();
  h.manager.assertReadGrant(read.grant);
  read.dispose();
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});

test('passive contract: read-only lease expiry releases read listeners without any chat retirement', async () => {
  const h = await setupRead({ expiresIn: 80 });
  const read = await h.manager.openRead(outside, locator(h.row));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('read expiry not observed')), 1500);
    read.grant.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  assert.equal(h.getReadStats().released, 1);
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});

test('passive contract: a late read ticket after revocation is released, never issued or retired as a writer', async () => {
  const readGate = deferred();
  const h = await setupRead({ readGate });
  h.ignoreLateReadAuthority();
  const reading = assert.rejects(h.manager.openRead(outside, locator(h.row)), denied);
  await tick();
  h.invalidate();
  let closed = false;
  const closing = h.manager.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  readGate.resolve();
  await Promise.all([reading, closing]);
  assert.deepEqual(h.getReadStats(), { reads: 1, released: 1, live: 0 });
  assert.equal(h.retireCalls, 0);
  assert.equal(h.opens, 0);
});

test('passive contract: a copied C read ticket has no issuer but can only release its own read listener', async () => {
  const h = await setupRead();
  const send = await open(h);
  h.copyReadTicket();
  await assert.rejects(h.manager.openRead(outside, locator(h.row)), denied);
  assert.equal(h.getReadStats().released, 1);
  assert.equal(h.retireCalls, 0);
  h.manager.assertGrant(send.grant, 'send');
  await h.manager.close();
});

test('passive contract: removal of an already-known native Session identity invalidates the reader', async () => {
  const h = await setupRead();
  const read = await h.manager.openRead(outside, locator(h.row));
  delete h.row.nativeExecution.runs[0].attempt.sessionId;
  assert.throws(() => h.manager.assertReadGrant(read.grant), denied);
  assert.equal(h.getReadStats().released, 1);
  assert.equal(h.retireCalls, 0);
  await h.manager.close();
});
