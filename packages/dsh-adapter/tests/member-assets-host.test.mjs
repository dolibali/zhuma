/** Exact emitted Host + normal member HTTP, original JSON/attachments and new
 * OS-process recovery. Synthetic account/file; no GUI, model or Run-tool proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';
import { packageFixture } from '../../../tests/fixtures/asset-package.mjs';
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
    const client = await build({
      stdin: {
        contents:
          "export { createMemberAssetApi, describeMemberAssetFile, createSharedBackendClient } from '@zhuma/client';",
        resolveDir: fileURLToPath(new URL('../../client', import.meta.url)),
        sourcefile: 'member-asset-client-proof.mjs',
      },
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.css': 'text' },
      metafile: true,
    });
    assert.equal(
      Object.keys(client.metafile.inputs).some((path) => /dsh-adapter\/(?:src|dist)\//u.test(path)),
      false,
    );
    const clientBytes = client.outputFiles[0].contents;
    const { createMemberAssetApi, describeMemberAssetFile, createSharedBackendClient } =
      await import(`data:text/javascript;base64,${Buffer.from(clientBytes).toString('base64')}`);
    const home = await mkdtemp(join(tmpdir(), 'zhuma-member-asset-host-'));
    const config = { deploymentMode: 'multi-member', localSetup: true, memberWeb: true };
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
    const api = createMemberAssetApi(
      {
        actorId: setup.accountId,
        spaceId,
        isCurrent: () => !!host,
        onUnauthenticated() {
          throw Error('Unexpected member change');
        },
        onUnavailable() {
          throw Error('Unexpected space change');
        },
      },
      (url, init) =>
        fetch(host.baseURL + url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin: host.baseURL,
            cookie: `${host.ownerCookie}; ${member}`,
          },
        }),
    );
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
      const fixed = await api.read(
        { spaceId, assetId, versionId: reference.versionId },
        new AbortController().signal,
      );
      const preview = await api.file(
        { spaceId, assetId, versionId: reference.versionId, mode: 'preview' },
        fixed.file,
        new AbortController().signal,
      );
      assert.equal(preview.inline, true);
      assert.deepEqual(Buffer.from(await preview.blob.arrayBuffer()), data);
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
      const draft = await api.command(
        {
          operation: 'create-draft',
          spaceId,
          assetId,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          definition: { kind: 'file', name: '接口规范', description: '团队独立资料' },
          dependencies: [],
        },
        new AbortController().signal,
      );
      const file = new File([data], '接口规范.txt', { type: 'text/plain' });
      const declare = await describeMemberAssetFile(file, new AbortController().signal);
      const receipt = await api.upload(
        {
          spaceId,
          assetId,
          expectedVersion: draft.asset.version,
          idempotencyKey: randomUUID(),
          declare,
        },
        file,
        new AbortController().signal,
      );
      const published = await api.command(
        {
          operation: 'publish',
          spaceId,
          assetId,
          expectedVersion: receipt.assetVersion,
          idempotencyKey: randomUUID(),
        },
        new AbortController().signal,
      );
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
      const catalog = await api.catalog(
        { spaceId, category: 'material' },
        new AbortController().signal,
      );
      assert.equal(catalog.counts.material, 1);
      assert.equal(catalog.items[0].asset.assetId, assetId);
      assert.ok(!JSON.stringify(catalog).includes('attachmentId'));
      const selection = {
        origin: host.baseURL,
        connectionId: randomUUID(),
        backendId: randomUUID(),
        actorId: setup.accountId,
      };
      const shared = createSharedBackendClient(
        {
          async call(_channel, method, input) {
            if (method === 'zhuma-backend/status') return { ok: true, value: selection };
            const identity = input.operation === 'identity.session';
            const endpoint = identity
              ? '/zhuma-id/session'
              : '/api/zhuma-member/' + input.operation.slice('member.'.length);
            const response = await fetch(host.baseURL + endpoint, {
              method: identity ? 'GET' : 'POST',
              headers: { origin: host.baseURL, cookie: member, 'content-type': 'application/json' },
              ...(identity
                ? {}
                : {
                    body: JSON.stringify({
                      type: 'client-request',
                      rpcId: input.rpcId,
                      method: endpoint.slice('/api/'.length),
                      payload: input.payload,
                    }),
                  }),
            });
            return {
              ok: true,
              value: {
                connectionId: selection.connectionId,
                status: response.status,
                body: await response.json(),
              },
            };
          },
        },
        () => {},
      );
      await shared.refresh();
      const sharedApi = createMemberAssetApi(
        {
          actorId: setup.accountId,
          spaceId,
          isCurrent: () => true,
          onUnauthenticated() {},
          onUnavailable() {},
        },
        shared.fetcher,
      );
      await sharedApi.catalog(
        { spaceId, category: 'all', search: '', offset: 0, limit: 30 },
        new AbortController().signal,
      );
      await sharedApi.list(
        { spaceId, kind: 'skill', includeDrafts: true },
        new AbortController().signal,
      );
      shared.close();
      await read(published.reference);
      const text = await rpc('asset-file-text', {
        spaceId,
        assetId,
        versionId: published.reference.versionId,
        offset: 0,
        length: 8192,
      });
      assert.ok(JSON.stringify(text).includes('接口字段说明'));
      const upload = { kind: 'files', files: packageFixture() };
      const importedPreview = await api.previewImport(
        { spaceId, upload },
        new AbortController().signal,
      );
      assert.equal(importedPreview.items.length, 2);
      const importIntent = {
        spaceId,
        upload,
        packageChecksum: importedPreview.packageChecksum,
        idempotencyKey: randomUUID(),
        choices: importedPreview.items.map((item) => ({
          key: item.key,
          id: randomUUID(),
          name: item.name,
          description: item.description,
          role: item.role,
          capabilities: item.capabilities,
          dependencies: [],
        })),
      };
      const imported = await api.importDrafts(importIntent, new AbortController().signal);
      assert.equal(imported.assets.length, 2);
      assert(imported.assets.every((item) => item.hasDraft && !item.versions.length));
      const importedSkill = imported.assets.find((item) => item.kind === 'skill'),
        importedExpert = imported.assets.find((item) => item.kind === 'expert');
      const expertDetail = await api.read(
        { spaceId, assetId: importedExpert.assetId, draft: true },
        new AbortController().signal,
      );
      assert.equal(expertDetail.requirements[0].suggestedAssetId, importedSkill.assetId);
      assert.equal(expertDetail.dependencies.length, 0);
      await assert.rejects(
        api.command(
          {
            operation: 'publish',
            spaceId,
            assetId: importedExpert.assetId,
            expectedVersion: importedExpert.version,
            idempotencyKey: randomUUID(),
          },
          new AbortController().signal,
        ),
        { code: 'asset-dependency-required' },
      );
      const skillVersion = await api.command(
        {
          operation: 'publish',
          spaceId,
          assetId: importedSkill.assetId,
          expectedVersion: importedSkill.version,
          idempotencyKey: randomUUID(),
        },
        new AbortController().signal,
      );
      const mapped = await api.command(
        {
          operation: 'update-draft',
          spaceId,
          assetId: importedExpert.assetId,
          expectedVersion: importedExpert.version,
          idempotencyKey: randomUUID(),
          definition: expertDetail.definition,
          dependencies: [
            { slotId: expertDetail.requirements[0].slotId, reference: skillVersion.reference },
          ],
        },
        new AbortController().signal,
      );
      const expertVersion = await api.command(
        {
          operation: 'publish',
          spaceId,
          assetId: importedExpert.assetId,
          expectedVersion: mapped.asset.version,
          idempotencyKey: randomUUID(),
        },
        new AbortController().signal,
      );
      await host.close();
      host = undefined;
      host = await startAcceptanceHost(home, config);
      member = await host.login(setup.accountId, setup.password);
      const importReplay = await api.importDrafts(importIntent, new AbortController().signal);
      assert.equal(importReplay.disposition, 'replayed');
      const coldExpert = await api.read(
        { spaceId, assetId: importedExpert.assetId, versionId: expertVersion.reference.versionId },
        new AbortController().signal,
      );
      assert.deepEqual(coldExpert.dependencies[0].reference, skillVersion.reference);
      assert.equal(coldExpert.definition.instructions, expertDetail.definition.instructions);
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
              publicClientApiSha256: sha(clientBytes),
              normalMemberHttp: true,
              seeded: false,
              processes: 2,
              fixedReference: published.reference,
              byteSha256: sha(data),
              catalogCount: catalog.counts.material,
              importDrafts: imported.assets.length,
              importedDependencyFixed: true,
              importColdReplay: importReplay.disposition,
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
