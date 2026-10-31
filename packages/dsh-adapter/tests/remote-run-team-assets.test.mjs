/** Original Workbench/Run JSON, member lease, Ed25519/drive and local attachment
 * integration. Session/account/Host policy setup is a contract, not GUI/model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  remoteDeviceSigningInput,
  remoteTeamAssetFileReadRequestSchema,
  memberAssetFileSnapshotDigestInput,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { assetHost } from './member-asset-host-fixture.mjs';
import { fileHost, ok, no, deferred, hash } from './remote-run-files-fixture.mjs';
import { caller } from './execution-service-run-fixture.mjs';
import { openExecutionMemberLease } from '../dist/member-session.js';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { readExecutionRunComposition } from '../dist/execution-run-composition.js';
import { signal } from './member-workbench-fixture.mjs';

const capabilities = {
  resultIntent: 'zhuma-native-result-intent@1',
  localTools: [],
  teamAssets: 'zhuma-native-team-assets@1',
};
function workbench() {
  const f = JSON.parse(JSON.stringify(fixture()).replaceAll('"chen"', '"ann"'));
  return applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      status: 'ready',
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [
            { ...f.node, id: 'produce', skillIds: [], reviewRequired: false, reviewerIds: [] },
          ],
        },
      ],
    },
  });
}
async function setup(t, { enabled = true, wait, selected = true } = {}) {
  const grants = new Set();
  let k;
  t.after(async () => {
    await k?.files.close();
    for (const grant of grants) await grant.releaseAfter(Promise.resolve());
  });
  k = await assetHost(t);
  await k.domain.global.set(workbench());
  await k.directory.assignProjectSpace('project', 'north');
  const created = await k.create(),
    data = Buffer.from('Original team reference 汉😀');
  const upload = k.uploadInput(created.input.assetId, data),
    receipt = await k.upload(upload, data);
  await k.files.idle();
  const published = await k.publish(upload, receipt);
  if (selected) {
    // This Run fixture seeds the original confirmed fact. Normal member
    // create/inherit/confirm and recovery are covered by member-fixed-files.
    const state = k.workbench.snapshot();
    state.tasks[0].fileRefs = [published.reference];
    state.appliedPlans[0].task.fileRefs = [published.reference];
    await k.domain.global.set(state);
  }
  const controls = {};
  let snapshots = 0,
    qualifications = 0;
  const h = await fileHost(t, {
    workbench: k.workbench.snapshot(),
    seed: false,
    beforeRemoteEnable: async (base) => {
      Object.assign(base.request.headers, k.requests.ann.headers);
      base.service.workbench.readWorkbench = () => k.workbench.snapshot();
      base.service.runHost.memberLease = (request) => openExecutionMemberLease(k.ctx, request);
      if (enabled) {
        base.service.runHost.prepareTeamAssetFiles = async (request, query, active) => {
          snapshots++;
          controls.query = structuredClone(query);
          if (controls.snapshotFailure) throw Error('PRIVATE-SNAPSHOT-DETAIL');
          ok(
            await base.service.readRunCompositionInputs(request, {
              ...base.locate(),
              spaceId: 'north',
            }),
          );
          const value = await k.owner.fileSnapshot(request, query, active);
          return controls.snapshotReplace ? controls.snapshotReplace(value) : value;
        };
        base.service.runHost.qualifyTeamAssetFile = async (request, reference, active) => {
          qualifications++;
          await wait?.(controls);
          const value = await k.owner.reference(request, reference, active);
          return controls.replace ? controls.replace(value) : value;
        };
      }
      const { nodeId: _node, ...plan } = base.locate();
      ok(await base.service.startPlan(caller('ann'), { ...plan, idempotencyKey: 'start' }));
    },
  });
  const begin = () => h.begin({ capabilities, workspace: { kind: 'text-only' } });
  const body = (patch = {}) =>
    h.envelope('team-asset-file', {
      scope: h.view.scope,
      permit: h.identity.drive.public,
      mode: 'read',
      reference: published.reference,
      ...patch,
    });
  const signed = (value) => {
    value.proof.signature = sign(
      null,
      Buffer.from(canonicalPayload(remoteDeviceSigningInput(value))),
      h.identity.keys.privateKey,
    ).toString('base64url');
    return value;
  };
  const open = async (
    value = body(),
    request = h.request,
    permit = h.identity.drive.raw,
    active = signal(),
  ) => {
    const grant = await h.service.openRemoteTeamAssetFile(request, signed(value), permit, active);
    grants.add(grant);
    return grant;
  };
  return {
    ...h,
    k,
    data,
    created,
    upload,
    receipt,
    published,
    controls,
    beginTeam: begin,
    body,
    signed,
    open,
    get counts() {
      return { snapshots, qualifications };
    },
    get view() {
      return h.view;
    },
  };
}

test('team asset Run: new explicit metadata snapshot enters original signed composition without body/default input refs; real fixed bytes require both authorities', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  const run = currentExecutionRun(h.read()),
    saved = readExecutionRunComposition(run.composition);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.payload.teamAssets.files[0].reference, h.published.reference);
  assert(saved.payload.toolAllowlist.includes('team_asset'));
  assert(!saved.payload.context.includes('Original team reference'));
  assert.deepEqual(saved.payload.handoff.inputRefs, []);
  assert.equal(h.counts.snapshots, 1);
  const grant = await h.open();
  const operation = h.k.files.openReadTracked(
    grant.request,
    {
      spaceId: grant.reference.spaceId,
      assetId: grant.reference.assetId,
      versionId: grant.reference.versionId,
    },
    grant.signal,
  );
  const handle = await operation.result;
  handle.check();
  grant.check();
  assert.deepEqual(Buffer.from(handle.bytes), h.data);
  assert.deepEqual(handle.file, grant.file);
  handle.release();
  await grant.releaseAfter(operation.drain);
  assert.throws(() => grant.check());
});

test('team asset Run: ordinary membership, altered full scope/ref/drive/signature and absent snapshot never open a read grant', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  for (const changed of [
    { reference: { ...h.published.reference, sha256: 'f'.repeat(64) } },
    { scope: { ...h.view.scope, actorId: 'bob' } },
    { scope: { ...h.view.scope, generation: 99 } },
    { scope: { ...h.view.scope, segmentId: randomUUID() } },
    { reference: { ...h.published.reference, spaceId: 'south' } },
  ]) {
    await assert.rejects(h.open(h.body(changed)));
  }
  await assert.rejects(h.open(h.body(), h.k.requests.bob));
  await assert.rejects(h.open(h.body(), h.request, 'A'.repeat(43)));
  const invalid = h.signed(h.body());
  invalid.proof.signature = 'A'.repeat(86);
  await assert.rejects(
    h.service.openRemoteTeamAssetFile(h.request, invalid, h.identity.drive.raw, signal()),
  );
  assert.equal(h.counts.qualifications, 0);
});

test('team asset Run: check is metadata only, later publication is not substituted and cleanup joins actual drain exactly once', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  const old = currentExecutionRun(h.read()).composition;
  const later = Buffer.from('Later publication');
  const input = h.k.uploadInput(h.upload.assetId, later, {
    expectedVersion: h.published.asset.version,
  });
  const receipt = await h.k.upload(input, later);
  await h.k.files.idle();
  const newer = await h.k.publish(input, receipt);
  await assert.rejects(h.open(h.body({ reference: newer.reference })));
  const grant = await h.open(h.body({ mode: 'check' }));
  assert.deepEqual(grant.reference, h.published.reference);
  const pending = deferred();
  let done = false;
  const first = grant.releaseAfter(pending.promise).then(() => {
    done = true;
  });
  const second = grant.releaseAfter(Promise.resolve());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  pending.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(currentExecutionRun(h.read()).composition, old);
});

test('team asset Run: absent capability keeps the original composition and explicit missing producer refuses instead of an empty catalog', async (t) => {
  const h = await setup(t, { selected: false });
  await h.begin({
    capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
    workspace: { kind: 'text-only' },
  });
  const saved = currentExecutionRun(h.read()).composition;
  assert.equal(saved.payload.teamAssets, undefined);
  assert.equal(saved.payload.teamAssetTool, undefined);
  assert(!saved.payload.toolAllowlist.includes('team_asset'));
  assert.equal(h.counts.snapshots, 0);
  await assert.rejects(h.open(), { code: 'remote-protocol-unsupported' });
  const absent = await setup(t, { enabled: false });
  no(
    await absent.send(absent.accept({ capabilities, workspace: { kind: 'text-only' } })),
    'remote-protocol-unsupported',
  );
  assert.equal(absent.read().nativeExecution?.runs.length ?? 0, 0);
});

test('team asset Run: original accept replay never reads a fresh/latest snapshot or changes its signed configuration', async (t) => {
  const h = await setup(t),
    body = h.accept({ capabilities, workspace: { kind: 'text-only' } });
  const first = ok(await h.send(body)),
    saved = currentExecutionRun(h.read()).composition;
  h.controls.snapshotFailure = true;
  const replay = ok(await h.send(body));
  assert.equal(replay.disposition, 'replayed');
  assert.equal(first.scope.runId, replay.scope.runId);
  assert.equal(h.counts.snapshots, 1);
  assert.deepEqual(currentExecutionRun(h.read()).composition, saved);
});

test('team asset Run: a new Run consumes only the old version selected in its AppliedPlan even after a newer publication, including actual original bytes', async (t) => {
  const h = await setup(t);
  const data = Buffer.from('Newer before Run preparation');
  const input = h.k.uploadInput(h.upload.assetId, data, {
    expectedVersion: h.published.asset.version,
  });
  const receipt = await h.k.upload(input, data);
  await h.k.files.idle();
  const newer = await h.k.publish(input, receipt);
  await h.beginTeam();
  assert.deepEqual(h.controls.query, { spaceId: 'north', references: [h.published.reference] });
  const saved = currentExecutionRun(h.read()).composition;
  assert.deepEqual(
    saved.payload.teamAssets.files.map((item) => item.reference),
    [h.published.reference],
  );
  assert(!JSON.stringify(saved).includes(newer.reference.versionId));
  const grant = await h.open();
  const operation = h.k.files.openReadTracked(
    grant.request,
    {
      spaceId: 'north',
      assetId: grant.reference.assetId,
      versionId: grant.reference.versionId,
    },
    grant.signal,
  );
  const handle = await operation.result;
  grant.check();
  handle.check();
  assert.deepEqual(Buffer.from(handle.bytes), h.data);
  handle.release();
  await grant.releaseAfter(operation.drain);
});

test('team asset Run: selected files without executor capability fail explicitly before any persisted Run or file preparation', async (t) => {
  const h = await setup(t);
  const result = await h.send(
    h.accept({
      capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
      workspace: { kind: 'text-only' },
    }),
  );
  no(result, 'remote-protocol-unsupported');
  assert.equal(h.read().nativeExecution?.runs.length ?? 0, 0);
  assert.equal(h.counts.snapshots, 0);
});

test('team asset Run: Host substitution or extra files never override the AppliedPlan, and an empty selection never scans team latest', async (t) => {
  const h = await setup(t),
    extra = await h.k.create();
  const data = Buffer.from('Unselected file');
  const input = h.k.uploadInput(extra.input.assetId, data);
  const receipt = await h.k.upload(input, data);
  await h.k.files.idle();
  const extraPublished = await h.k.publish(input, receipt);
  const actualExtra = await h.k.owner.fileSnapshot(
    h.k.requests.ann,
    {
      spaceId: 'north',
      references: [extraPublished.reference],
    },
    signal(),
  );
  for (const replace of [
    () => actualExtra,
    (value) => {
      const snapshot = {
        ...value.snapshot,
        files: [...value.snapshot.files, ...actualExtra.snapshot.files],
      };
      snapshot.sha256 = hash(memberAssetFileSnapshotDigestInput(snapshot));
      return { ...value, snapshot };
    },
  ]) {
    h.controls.snapshotReplace = replace;
    no(await h.send(h.accept({ capabilities, workspace: { kind: 'text-only' } })));
    assert.equal(h.read().nativeExecution?.runs.length ?? 0, 0);
  }
  const empty = await setup(t, { selected: false });
  await empty.beginTeam();
  assert.deepEqual(empty.controls.query.references, []);
  assert.deepEqual(currentExecutionRun(empty.read()).composition.payload.teamAssets.files, []);
});

test('team asset Run: original revoke and stop fence held reads while close still waits for their actual drain', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  const grant = await h.open(),
    pending = deferred();
  await h.k.revoke('north', 'ann');
  assert(grant.signal.aborted);
  assert.throws(() => grant.check());
  const release = grant.releaseAfter(pending.promise);
  let closed = false;
  const closing = h.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  pending.resolve();
  await release;
  await closing;
});

test('team asset Run: stop receipt cancels the grant but original resources remain held until the actual read producer drains', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  const grant = await h.open(),
    pending = deferred();
  const stop = h.envelope('stop', {
    scope: h.view.scope,
    expectedNodeVersion: h.read().command.version,
    expectedRunVersion: h.read().nativeExecution.version,
  });
  ok(await h.send(stop));
  assert(grant.signal.aborted);
  assert.throws(() => grant.check());
  const release = grant.releaseAfter(pending.promise);
  let closed = false;
  const closing = h.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  pending.resolve();
  await release;
  await closing;
});

test('team asset Run: authorized producer metadata cannot substitute actor/ref/file, and no bytes or grants escape on failure', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  for (const replace of [
    (value) => ({ ...value, actorId: 'bob' }),
    (value) => ({ ...value, reference: { ...value.reference, sha256: 'e'.repeat(64) } }),
    (value) => ({ ...value, file: { ...value.file, name: 'changed.txt' } }),
  ]) {
    h.controls.replace = replace;
    await assert.rejects(h.open(), { code: 'remote-input-stale' });
  }
  h.controls.replace = undefined;
  const grant = await h.open();
  grant.check();
  await grant.releaseAfter(Promise.resolve());
});

test('team asset Run: original eight-read/device occupancy is retained to real drain and checked after full authority', async (t) => {
  const h = await setup(t);
  await h.beginTeam();
  const grants = await Promise.all(Array.from({ length: 8 }, () => h.open()));
  await assert.rejects(h.open(), { code: 'remote-quota' });
  await assert.rejects(h.open(h.body(), h.k.requests.bob), { code: 'remote-device-mismatch' });
  const pending = deferred(),
    release = grants[0].releaseAfter(pending.promise);
  await assert.rejects(h.open(), { code: 'remote-quota' });
  pending.resolve();
  await release;
  const extra = await h.open();
  await extra.releaseAfter(Promise.resolve());
  for (const grant of grants) await grant.releaseAfter(Promise.resolve());
});

test('team asset Run: metadata qualification runs outside the original queue and a stop during it refuses late grant admission', async (t) => {
  const entered = deferred(),
    pending = deferred();
  const h = await setup(t, {
    wait: async () => {
      entered.resolve();
      await pending.promise;
    },
  });
  await h.beginTeam();
  const opening = h.open();
  await entered.promise;
  ok(
    await h.send(
      h.envelope('stop', {
        scope: h.view.scope,
        expectedNodeVersion: h.read().command.version,
        expectedRunVersion: h.read().nativeExecution.version,
      }),
    ),
  );
  pending.resolve();
  await assert.rejects(opening, { code: 'remote-permit-revoked' });
});

test('team asset Run: preparing a failed snapshot cannot become empty or commit a Run/format marker', async (t) => {
  const h = await setup(t);
  h.controls.snapshotFailure = true;
  no(
    await h.send(h.accept({ capabilities, workspace: { kind: 'text-only' } })),
    'remote-unavailable',
  );
  assert.equal(h.read().nativeExecution?.runs.length ?? 0, 0);
  assert.equal(h.domain.global.get().remoteExecutionTeamAssetWriter, undefined);
});

test('team asset Run: repeated missing-producer refusal releases every authentication opening', async (t) => {
  const h = await setup(t, { enabled: false, selected: false });
  await h.begin({
    capabilities: { resultIntent: 'zhuma-native-result-intent@1', localTools: [] },
    workspace: { kind: 'text-only' },
  });
  for (let index = 0; index < 9; index++)
    await assert.rejects(h.open(), { code: 'remote-protocol-unsupported' });
  assert.equal(h.counts.qualifications, 0);
  assert.equal(h.counts.snapshots, 0);
});
