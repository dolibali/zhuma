import { randomUUID } from 'node:crypto';
import { StoredAssetPackageSchema } from '@zhuma/agent-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeHost } from './knowledge-fixture.mjs';
import { openExecutionMemberLease } from '../dist/member-session.js';
import { WorkbenchService } from '../dist/workbench-service.js';
import { workbenchDomainSpec } from '../dist/workbench-plugin.js';
import { MemberAssetService } from '../dist/member-asset-service.js';
import { TeamAssetFileBytes } from '../dist/team-asset-file.js';
import { TeamAssetFileService } from '../dist/team-asset-file-service.js';
import { digest, source } from './member-asset-fixture.mjs';
import { signal } from './member-workbench-fixture.mjs';

// Actual original session-lease issuer, SpaceDirectory, DSH JSON domain and
// LocalAttachmentStore. Session/account/admission setup remains a contract;
// this is not login, desktop, network, Run or model acceptance.
export async function assetHost(t, options = {}) {
  const hooks = [];
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'zhuma-member-assets-')));
  const k = await knowledgeHost({ after: (fn) => hooks.push(fn) }, { ...options, root });
  const domain = await k.ctx.storageDomain.open(workbenchDomainSpec);
  // Same original package domain identity/schema used by workbench-plugin.
  const packageDomain = await k.ctx.storageDomain.open({
    name: 'zhuma_asset_packages',
    version: 1,
    layout: 'per-record',
    tables: { versions: { valueSchema: StoredAssetPackageSchema } },
  });
  const workbench = new WorkbenchService(
    {
      read: () => domain.global.get(),
      write: async (next) => {
        await options.beforeWrite?.(next);
        await domain.global.set(next);
        await options.afterWrite?.(next);
      },
    },
    {
      get: (id) => domain.table('planning').get(id),
      put: (v) => domain.table('planning').put(v.id, v),
    },
    {
      get: (id) => packageDomain.table('versions').get(id),
      put: async (value) => {
        await options.beforePackageWrite?.(value);
        await packageDomain.table('versions').put(value.versionId, value);
      },
    },
  );
  const directory = {
    spaces: () => k.directory.spaces(),
    space: (id) => k.directory.space(id),
    isMember: (space, actor) => k.directory.isMember(space, actor),
    spacesForMember: (actor) => k.directory.spacesForMember(actor),
    spaceForProject: (id) => k.directory.spaceForProject(id),
    membersForSpace: (id) => k.directory.memberIdsForSpace(id).map((id) => ({ id })),
    administratorForSpace: (id) => k.personalOwners.get(id) ?? 'cy',
  };
  const lifetime = new AbortController();
  const owner = new MemberAssetService(workbench, {
    signal: lifetime.signal,
    memberLease: (request) => openExecutionMemberLease(k.ctx, request),
    directory: () => directory,
    catalog: async (spaceId) => owner.publishedDefinitions(spaceId),
  });
  const bytes = new TeamAssetFileBytes(
    options.attachments?.(k.ctx.attachments) ?? k.ctx.attachments,
  );
  const files = new TeamAssetFileService(bytes, owner);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await files.close();
    await owner.close();
    await domain.close();
    await packageDomain.close();
    for (const hook of hooks) await hook();
  };
  t.after(close);
  if (!options.root) t.after(() => rm(root, { recursive: true, force: true }));
  const command = (input, actor = 'ann') => owner.command(k.requests[actor], input, signal());
  const create = async (patch = {}) => {
    const input = {
      operation: 'create-draft',
      spaceId: 'north',
      assetId: randomUUID(),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      definition: { kind: 'file', name: '接口参考', description: '原始文件' },
      dependencies: [],
      ...patch,
    };
    return { input, result: await command(input) };
  };
  const uploadInput = (assetId, data, patch = {}) => ({
    spaceId: 'north',
    assetId,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    declare: {
      name: '接口参考.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: digest(data),
    },
    ...patch,
  });
  const upload = (input, data, actor = 'ann', active = signal()) =>
    files.upload(k.requests[actor], input, source(data), active);
  const publish = (input, receipt) =>
    command({
      operation: 'publish',
      spaceId: input.spaceId,
      assetId: input.assetId,
      expectedVersion: receipt.assetVersion,
      idempotencyKey: randomUUID(),
    });
  return {
    ...k,
    close,
    domain,
    packageDomain,
    workbench,
    owner,
    files,
    bytes,
    create,
    uploadInput,
    upload,
    publish,
    command,
  };
}
