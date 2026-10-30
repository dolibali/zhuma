/** Exact emitted Host + normal member HTTP, original JSON/attachments and new
 * OS-process recovery. Synthetic account/file; no GUI, model or Run-tool proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const envelope = (endpoint, payload) => ({
  type: 'client-request',
  rpcId: randomUUID(),
  method: `zhuma-member/${endpoint}`,
  payload,
});

test(
  'normal asset Host: real member drafts/upload/publish/catalog and exact bytes survive a fresh process',
  { skip: !process.env.S1A_HOST_MODULE, timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-member-asset-host-'));
    const config = { deploymentMode: 'multi-member', localSetup: true };
    const setup = {
      requestId: randomUUID(),
      accountId: 'asset-member',
      password: 'synthetic-asset-member-password',
      teamName: '资料团队',
      packIds: ['zhuma-work-planning'],
    };
    const spaceId = `team-${setup.requestId}`,
      assetId = randomUUID();
    const data = Buffer.from('接口字段说明：status = ready\n保留真实字节与固定版本。');
    let host, member;
    const rpc = async (endpoint, payload) => {
      const reply = await host.post(
        '/api/zhuma-member/' + endpoint,
        envelope(endpoint, payload),
        `${host.ownerCookie}; ${member}`,
      );
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.equal(reply.json.result.ok, true, JSON.stringify(reply.json));
      return reply.json.result.value;
    };
    const read = async (reference) => {
      const target = { spaceId, assetId, versionId: reference.versionId, mode: 'preview' };
      const response = await fetch(host.baseURL + '/api/zhuma-member/asset-file-read', {
        method: 'POST',
        headers: {
          origin: host.baseURL,
          cookie: `${host.ownerCookie}; ${member}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope('asset-file-read', target)),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-zhuma-file-sha256'), sha(data));
      assert.deepEqual(
        JSON.parse(decodeURIComponent(response.headers.get('x-zhuma-asset-file-context'))),
        target,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(sha(bytes), sha(data));
      assert.deepEqual(Buffer.from(bytes), data);
    };
    try {
      host = await startAcceptanceHost(home, config);
      assert.equal(host.seeded, false);
      const initialized = await host.post(
        '/api/zhuma-local-setup/initialize',
        setup,
        host.ownerCookie,
      );
      assert.equal(initialized.status, 200, JSON.stringify(initialized.json));
      member = await host.login(setup.accountId, setup.password);
      const draft = await rpc('asset-command', {
        operation: 'create-draft',
        spaceId,
        assetId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        definition: { kind: 'file', name: '接口规范', description: '团队独立资料' },
        dependencies: [],
      });
      const upload = await fetch(host.baseURL + '/api/zhuma-member/asset-file-upload', {
        method: 'POST',
        headers: {
          origin: host.baseURL,
          cookie: `${host.ownerCookie}; ${member}`,
          'content-type': 'application/octet-stream',
          'x-zhuma-space-id': spaceId,
          'x-zhuma-asset-id': assetId,
          'x-zhuma-expected-version': String(draft.asset.version),
          'x-zhuma-idempotency-key': randomUUID(),
          'x-zhuma-file-name': encodeURIComponent('接口规范.txt'),
          'x-zhuma-file-type': 'text/plain',
          'x-zhuma-file-size': String(data.length),
          'x-zhuma-file-sha256': sha(data),
        },
        body: data,
      });
      assert.equal(upload.status, 200);
      const receipt = await upload.json();
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      const published = await rpc('asset-command', {
        operation: 'publish',
        spaceId,
        assetId,
        expectedVersion: receipt.value.assetVersion,
        idempotencyKey: randomUUID(),
      });
      assert.ok(published.reference);
      assert.notEqual(
        published.reference.sha256,
        sha(data),
        'Publication and byte digests have different meanings',
      );
      const list = await rpc('asset-list', { spaceId, includeDrafts: true });
      assert.equal(list.items.length, 1);
      const metadata = await rpc('asset-read', {
        spaceId,
        assetId,
        versionId: published.reference.versionId,
      });
      assert.equal(metadata.file.sha256, sha(data));
      assert.ok(!JSON.stringify(metadata).includes('attachmentId'));
      const catalog = await rpc('asset-catalog', { spaceId, category: 'material' });
      assert.equal(catalog.counts.material, 1);
      assert.equal(catalog.items[0].asset.assetId, assetId);
      assert.ok(!JSON.stringify(catalog).includes('attachmentId'));
      await read(published.reference);
      const text = await rpc('asset-file-text', {
        spaceId,
        assetId,
        versionId: published.reference.versionId,
        offset: 0,
        length: 8192,
      });
      assert.ok(JSON.stringify(text).includes('接口字段说明'));
      await host.close();
      host = undefined;
      host = await startAcceptanceHost(home, config);
      member = await host.login(setup.accountId, setup.password);
      const cold = await rpc('asset-read', {
        spaceId,
        assetId,
        versionId: published.reference.versionId,
      });
      assert.deepEqual(cold.selection.reference, published.reference);
      await read(published.reference);
      if (process.env.S1A_MEMBER_ASSET_PROOF_FILE)
        await writeFile(
          process.env.S1A_MEMBER_ASSET_PROOF_FILE,
          JSON.stringify(
            {
              sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              hostSha256: sha(await readFile(process.env.S1A_HOST_MODULE)),
              normalMemberHttp: true,
              seeded: false,
              processes: 2,
              fixedReference: published.reference,
              byteSha256: sha(data),
              catalogCount: catalog.counts.material,
              scope:
                'Exact emitted Host, normal member HTTP, original JSON/attachments; synthetic account/file, no GUI/model/Run adoption',
            },
            null,
            2,
          ) + '\n',
        );
    } finally {
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
