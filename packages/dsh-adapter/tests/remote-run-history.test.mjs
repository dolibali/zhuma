/** Actual Service/JSON/Ed25519 history boundary. Member leases and native close/
 * completion reports are explicit contracts, not C's real SDK or GUI acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import {
  canonicalPayload,
  remoteDeviceSigningInput,
  remoteResultDigestInput,
} from '@zhuma/agent-core';
import { fileHost, ok, no, sha, hash } from './remote-run-files-fixture.mjs';
import { caller } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { currentExecutionRun } from '../dist/execution-run-state.js';

const text = {
  workspace: { kind: 'text-only' },
  capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
};
const permit = () => {
  const bytes = randomBytes(32);
  return { raw: bytes.toString('base64url'), public: { id: randomUUID(), sha256: sha(bytes) } };
};
const credentials = () => ({ drive: permit(), cleanup: permit() });
const publicCredentials = (pair) => ({ drive: pair.drive.public, cleanup: pair.cleanup.public });
const status = (h, scope, drive = h.drive) =>
  h.send(h.envelope('status', { scope, permit: drive.public }), { secret: drive.raw });
const facts = (h) => canonicalPayload({ global: h.domain.global.get(), node: h.read() });
const readOnly = (view) => {
  assert(!['drive', 'commit-only'].includes(view.authority));
  assert.equal(view.migration, undefined);
};

async function generations(t) {
  const h = await fileHost(t, { enabled: false });
  const firstBody = h.accept(text),
    accepted = ok(await h.send(firstBody));
  let first = accepted;
  for (const event of [
    { kind: 'received', sequence: 1, nativeSessionId: 'original-native-gen1' },
    {
      kind: 'accepted',
      sequence: 2,
      nativeSessionId: 'original-native-gen1',
      executorRunId: 'original-agent-gen1',
    },
  ])
    first = ok(
      await h.send(h.envelope('event', { scope: first.scope, permit: h.drive.public, event })),
    );
  const stopped = ok(
    await h.send(
      h.envelope('stop', {
        scope: first.scope,
        expectedNodeVersion: first.nodeVersion,
        expectedRunVersion: first.runVersion,
      }),
    ),
  );
  first = ok(
    await h.send(
      h.envelope('cleanup', {
        scope: first.scope,
        permit: h.cleanup.public,
        observation: {
          sequence: stopped.nextSequence,
          kind: 'drained',
          evidence: {
            basis: 'flushed-and-closed',
            nativeSessionId: 'original-native-gen1',
            nativeAgentId: 'original-agent-gen1',
          },
        },
      }),
      { secret: h.cleanup.raw, request: { headers: {} } },
    ),
  );
  const secondSecrets = credentials(),
    thirdSecrets = credentials();
  let second = ok(
    await h.send(
      h.accept({ ...text, mode: 'restart', credentials: publicCredentials(secondSecrets) }),
    ),
  );
  second = ok(
    await h.send(
      h.envelope('cleanup', {
        scope: second.scope,
        permit: secondSecrets.cleanup.public,
        observation: {
          sequence: second.nextSequence,
          kind: 'drained',
          evidence: { basis: 'absent-unadmitted' },
        },
      }),
      { secret: secondSecrets.cleanup.raw, request: { headers: {} } },
    ),
  );
  const third = ok(
    await h.send(
      h.accept({ ...text, mode: 'restart', credentials: publicCredentials(thirdSecrets) }),
    ),
  );
  return { ...h, first, firstBody, second, secondSecrets, third, thirdSecrets };
}

test('remote historical status: same-device gen1 and absent gen2 remain readable while gen3 keeps sole drive; no writes or native identity fabrication', async (t) => {
  const h = await generations(t);
  const before = facts(h),
    original = structuredClone(h.read().nativeExecution.runs[0]);
  h.resetCounts();
  const active = h.service.remoteRunAuthorities.active.size;
  const first = ok(await status(h, h.first.scope)),
    second = ok(await status(h, h.second.scope, h.secondSecrets.drive)),
    third = ok(await status(h, h.third.scope, h.thirdSecrets.drive));
  assert.deepEqual(first.scope, h.first.scope);
  assert.deepEqual(second.scope, h.second.scope);
  assert.equal(first.runStatus, 'cancelled');
  assert.equal(first.resources, 'settled');
  readOnly(first);
  readOnly(second);
  assert.equal(third.authority, 'drive');
  assert.equal(h.service.remoteRunAuthorities.active.size, active);
  assert.deepEqual(h.read().nativeExecution.runs[0], original);
  assert.equal(h.read().nativeExecution.runs[1].attempt.sessionId, undefined);
  assert.equal(h.read().nativeExecution.currentRunId, h.third.scope.runId);
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(h.counts, { saved: 0, read: 0 });
});

test('remote historical status: all original scope fields, private permit and signature remain exact; other generations cannot lend their permit', async (t) => {
  const h = await generations(t),
    before = facts(h);
  h.resetCounts();
  for (const [field, value] of [
    ['backendId', randomUUID()],
    ['actorId', 'outside'],
    ['spaceId', 'another-space'],
    ['taskId', 'another-task'],
    ['planId', 'another-plan'],
    ['revision', h.first.scope.revision + 1],
    ['nodeId', 'parallel'],
    ['runId', h.second.scope.runId],
    ['generation', 2],
    ['segmentId', h.second.scope.segmentId],
  ])
    no(await status(h, { ...h.first.scope, [field]: value }));
  no(await status(h, h.first.scope, h.thirdSecrets.drive), 'remote-permit-revoked');
  no(await status(h, h.first.scope, h.cleanup), 'remote-permit-revoked');
  const body = h.envelope('status', { scope: h.first.scope, permit: h.drive.public });
  h.signBody(body);
  body.proof.signature = 'A'.repeat(86);
  no(await h.service.remoteRun(h.request, body, h.drive.raw), 'remote-proof-invalid');
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote historical status: another genuinely enrolled same-member device with its own valid proof cannot read the original device scope', async (t) => {
  const h = await generations(t),
    keys = generateKeyPairSync('ed25519'),
    deviceId = randomUUID();
  const signed = (body) => {
    body.deviceId = deviceId;
    body.proof.signature = sign(
      null,
      Buffer.from(canonicalPayload(remoteDeviceSigningInput(body))),
      keys.privateKey,
    ).toString('base64url');
    return body;
  };
  ok(
    await h.service.remoteRun(
      h.request,
      signed(
        h.envelope('register-device', {
          publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
        }),
      ),
    ),
  );
  const before = facts(h);
  h.resetCounts();
  no(
    await h.service.remoteRun(
      h.request,
      signed(
        h.envelope('status', {
          scope: h.first.scope,
          permit: h.drive.public,
        }),
      ),
      h.drive.raw,
    ),
    'remote-device-mismatch',
  );
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote historical status: current authenticated member, project-space and task membership are checked again on every request', async (t) => {
  const h = await generations(t),
    before = facts(h);
  h.resetCounts();
  const another = { headers: { cookie: h.request.headers.cookie } };
  h.members.set(another, 'outside');
  no(
    await h.send(h.envelope('status', { scope: h.first.scope, permit: h.drive.public }), {
      request: another,
    }),
    'remote-device-mismatch',
  );
  const workbench = h.readWorkbench();
  h.setWorkbench((state) => ({
    ...state,
    participants: state.participants.map((p) => (p.id === 'chen' ? { ...p, available: false } : p)),
  }));
  no(await status(h, h.first.scope));
  h.setWorkbench(() => workbench);
  h.assertionResults.project = () => {
    throw Error('CURRENT_PROJECT_SPACE_REVOKED');
  };
  no(await status(h, h.first.scope));
  delete h.assertionResults.project;
  h.setWorkbench((state) => ({ ...state, tasks: [] }));
  no(await status(h, h.first.scope));
  h.setWorkbench(() => workbench);
  ok(await status(h, h.first.scope));
  h.member.abort();
  no(await status(h, h.first.scope));
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote historical status: former generation still cannot renew, emit, stop, reconcile, read inputs or replay admission', async (t) => {
  const h = await generations(t),
    before = facts(h);
  h.resetCounts();
  for (const [operation, fields] of [
    ['renew', {}],
    ['event', { event: { kind: 'idle', sequence: h.first.nextSequence } }],
    ['reconcile', { lastSequence: 0 }],
    ['input-list', {}],
    ['input-read', { slotId: 'not-a-grant', offset: 0, maximumBytes: 1024 }],
    ['result-status', { resultRequestId: randomUUID() }],
  ])
    no(
      await h.send(
        h.envelope(operation, { scope: h.first.scope, permit: h.drive.public, ...fields }),
      ),
      'remote-scope-mismatch',
    );
  no(
    await h.send(
      h.envelope('stop', {
        scope: h.first.scope,
        expectedNodeVersion: h.third.nodeVersion,
        expectedRunVersion: h.third.runVersion,
      }),
    ),
    'remote-scope-mismatch',
  );
  no(await h.send(h.firstBody), 'remote-scope-mismatch');
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(ok(await status(h, h.third.scope, h.thirdSecrets.drive)).authority, 'drive');
});

test('remote historical status: a completed submitted generation after real review return is read only, never commit-only or a late result replay', async (t) => {
  const h = await fileHost(t, { enabled: false });
  const accepted = await h.begin(text),
    draft = { text: 'Fixed first result.', links: [], files: [] };
  const { backendId: _backend, ...scope } = accepted.scope;
  const result = {
    requestId: randomUUID(),
    digest: nativeResultDigest(draft),
    artifactDigest: hash(remoteResultDigestInput(draft)),
    source: {
      scope,
      nativeSessionId: 'file-native',
      nativeAgentId: 'file-agent',
      configurationId: currentExecutionRun(h.read()).selection.configurationId,
      intentId: 'complete-intent',
      callId: 'complete-call',
      toolVersion: 'zhuma-native-result-intent@1',
      cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
    },
  };
  let first = ok(
    await h.send(
      h.envelope('event', {
        scope: accepted.scope,
        permit: h.drive.public,
        event: {
          kind: 'completed',
          sequence: accepted.nextSequence,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result,
        },
      }),
    ),
  );
  assert.equal(first.authority, 'commit-only');
  const submit = h.envelope(
    'submit-result',
    {
      scope: first.scope,
      permit: h.drive.public,
      expectedNodeVersion: first.nodeVersion,
      result,
      draft,
    },
    result.requestId,
  );
  ok(await h.send(submit));
  ok(
    await h.service.ballot(caller('outside'), {
      ...h.human('produce', 'return-first'),
      roundId: h.read().currentRoundId,
      artifactVersionId: h.read().artifactVersions.at(-1).id,
      action: 'request-changes',
      comment: 'Revise this fixed result.',
    }),
  );
  const newer = credentials();
  const second = ok(await h.send(h.accept({ ...text, credentials: publicCredentials(newer) })));
  const before = facts(h);
  h.resetCounts();
  first = ok(await status(h, first.scope));
  readOnly(first);
  assert.equal(first.runStatus, 'completed');
  assert.equal(first.receipt.artifactVersionId, h.read().artifactVersions[0].id);
  assert.deepEqual(first.result, result);
  no(await h.send(submit), 'remote-scope-mismatch');
  no(
    await h.send(
      h.envelope('reconcile', {
        scope: first.scope,
        permit: h.drive.public,
        lastSequence: first.nextSequence - 1,
      }),
    ),
    'remote-scope-mismatch',
  );
  assert.equal(ok(await status(h, second.scope, newer.drive)).authority, 'drive');
  assert.equal(facts(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote historical status: cold current Host serves the exact prior scope without reauthorizing any drive or rewriting durable rows', async (t) => {
  const h = await generations(t);
  const before = facts(h);
  await h.close();
  const beforeDisk = await businessHashes(h.root);
  const reopened = await fileHost(t, {
    root: h.root,
    seed: false,
    identity: h.identity,
    enabled: false,
  });
  reopened.resetCounts();
  const first = ok(await status(reopened, h.first.scope)),
    second = ok(await status(reopened, h.second.scope, h.secondSecrets.drive)),
    third = ok(await status(reopened, h.third.scope, h.thirdSecrets.drive));
  readOnly(first);
  readOnly(second);
  assert.equal(third.authority, 'recovery-required');
  assert.deepEqual(third.migration, h.third.migration);
  assert.deepEqual(first.scope, h.first.scope);
  assert.equal(reopened.service.remoteRunAuthorities.active.size, 0);
  assert.equal(facts(reopened), before);
  assert.deepEqual(reopened.counters, { global: 0, nodes: 0, plans: 0 });
  await reopened.close();
  assert.deepEqual(await businessHashes(h.root), beforeDisk);
});
