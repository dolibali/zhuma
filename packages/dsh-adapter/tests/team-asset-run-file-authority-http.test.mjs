/** Original ExecutionService/MemberAsset authority, member lease, Ed25519, JSON,
 * attachment bytes and SDK HTTP/gzip. Account and native Run reports remain
 * explicit fixtures; this is not normal two-Host GUI/model acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  remoteDeviceSigningInput,
  REMOTE_TEAM_ASSET_FILE_PATH,
  REMOTE_TEAM_ASSET_FILE_METHOD,
  REMOTE_RUN_PERMIT_HEADER,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { assetHost } from './member-asset-host-fixture.mjs';
import { fileHost, ok } from './remote-run-files-fixture.mjs';
import { caller } from './execution-service-run-fixture.mjs';
import { openExecutionMemberLease } from '../dist/member-session.js';
import { signal } from './member-workbench-fixture.mjs';
import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import { openTeamAssetRunFileHttp } from '../dist/team-asset-run-file-http.js';

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
async function setup(t) {
  const k = await assetHost(t);
  await k.domain.global.set(workbench());
  await k.directory.assignProjectSpace('project', 'north');
  const created = await k.create(),
    data = Buffer.alloc(315, 65);
  const upload = k.uploadInput(created.input.assetId, data),
    receipt = await k.upload(upload, data);
  await k.files.idle();
  const published = await k.publish(upload, receipt);
  {
    // This Run fixture seeds the original confirmed fact. Normal member
    // create/inherit/confirm and recovery are covered by member-fixed-files.
    const state = k.workbench.snapshot();
    state.tasks[0].fileRefs = [published.reference];
    state.appliedPlans[0].task.fileRefs = [published.reference];
    await k.domain.global.set(state);
  }
  const h = await fileHost(t, {
    workbench: k.workbench.snapshot(),
    seed: false,
    beforeRemoteEnable: async (base) => {
      Object.assign(base.request.headers, k.requests.ann.headers);
      base.service.workbench.readWorkbench = () => k.workbench.snapshot();
      base.service.runHost.memberLease = (request) => openExecutionMemberLease(k.ctx, request);
      base.service.runHost.prepareTeamAssetFiles = async (request, query, active) => {
        ok(
          await base.service.readRunCompositionInputs(request, {
            ...base.locate(),
            spaceId: 'north',
          }),
        );
        return k.owner.fileSnapshot(request, query, active);
      };
      base.service.runHost.qualifyTeamAssetFile = (request, reference, active) =>
        k.owner.reference(request, reference, active);
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
  return {
    ...h,
    k,
    data,
    upload,
    published,
    beginTeam: begin,
    body,
    signed,
    get view() {
      return h.view;
    },
  };
}

for (const compression of ['none', 'gzip'])
  test(`actual Run file authority + SDK ${compression}: binary read and metadata check retain response finish before releasing original grants`, async (t) => {
    const h = await setup(t);
    await h.beginTeam();
    const fibers = [];
    let lane;
    t.after(async () => {
      await lane?.close();
      for (const fiber of fibers.toReversed()) await fiber.dispose();
    });
    for (const [plugin, config] of [
      [Credentials, { path: join(h.k.root, 'transport-credentials.yaml'), watch: false }],
      [WebServer, { host: '127.0.0.1', port: 0, compression, compressionThresholdBytes: 0 }],
      [Connection],
    ]) {
      const fiber = h.k.ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber;
    }
    lane = openTeamAssetRunFileHttp(h.k.ctx, () => ({ execution: h.service, files: h.k.files }));
    const post = (mode, patch = {}) =>
      new Promise((resolve, reject) => {
        const raw = h.signed(h.body({ mode, ...patch }));
        const body = JSON.stringify({
          type: 'client-request',
          method: REMOTE_TEAM_ASSET_FILE_METHOD,
          rpcId: randomUUID(),
          payload: raw,
        });
        // Existing original member-session fixture admits this exact Host/Origin.
        // Transport is a real SDK listener; no Run grant, proof or file read is replaced.
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: h.k.ctx.webServer.port,
            path: REMOTE_TEAM_ASSET_FILE_PATH,
            method: 'POST',
            headers: {
              ...h.k.requests.ann.headers,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              'accept-encoding': mode === 'read' ? 'identity' : 'gzip',
              [REMOTE_RUN_PERMIT_HEADER]: h.identity.drive.raw,
            },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => {
              const data = Buffer.concat(chunks);
              resolve({
                status: response.statusCode,
                encoding: response.headers['content-encoding'],
                bytes: response.headers['content-encoding'] === 'gzip' ? gunzipSync(data) : data,
              });
            });
          },
        );
        request.once('error', reject);
        request.end(body);
      });
    const before = canonicalPayload({
      node: h.read(),
      global: h.domain.global.get(),
      workbench: h.k.workbench.snapshot(),
    });
    const read = await post('read');
    assert.equal(read.status, 200);
    assert.deepEqual(read.bytes, h.data);
    t.diagnostic('original signed Run grant returned all 315 fixed bytes before metadata check');
    const checked = await post('check');
    assert.equal(checked.status, 200);
    assert.equal(checked.encoding, compression === 'gzip' ? 'gzip' : undefined);
    assert.deepEqual(JSON.parse(checked.bytes).result, {
      ok: true,
      value: {
        scope: h.view.scope,
        reference: h.published.reference,
        file: h.upload.declare,
      },
    });
    const denied = await post('check', {
      reference: { ...h.published.reference, sha256: 'f'.repeat(64) },
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(JSON.parse(denied.bytes).result, {
      ok: false,
      error: { code: 'remote-input-stale' },
    });
    await lane.close();
    await h.k.files.idle();
    assert.equal(h.service.remoteRunAuthorities.inputReads.size, 0);
    assert.equal(
      canonicalPayload({
        node: h.read(),
        global: h.domain.global.get(),
        workbench: h.k.workbench.snapshot(),
      }),
      before,
      'read/check and denial preserve the original facts',
    );
  });
