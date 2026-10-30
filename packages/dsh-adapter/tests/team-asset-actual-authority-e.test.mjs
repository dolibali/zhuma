/** Frozen D/E service composition, original issuer/directory/JSON/attachments.
 * Synthetic accounts/admission and native Run/transport remain explicit contracts;
 * no normal network/GUI/AgentLoop/model execution is asserted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StoredAssetPackageSchema, canonicalPayload } from '@zhuma/agent-core';
import {
  MemberAssetService,
  TeamAssetCatalogService,
  TeamAssetFileBytes,
  TeamAssetFileService,
  openExecutionMemberLease,
  registerTeamAssetFileTool,
} from '@zhuma/dsh-adapter';
import { knowledgeHost } from './knowledge-fixture.mjs';
import { WorkbenchService } from '../dist/workbench-service.js';
import { MemberWorkbenchService } from '../dist/member-workbench-service.js';
import { resolveMember } from '../dist/member-session.js';
import { workbenchDomainSpec } from '../dist/workbench-plugin.js';
import { NativeWorkSessionService } from '../dist/native-work-session.js';
import { grant, message, scope } from './native-work-session-fixture.mjs';
const active = () => new AbortController().signal;
const hash = (data) => createHash('sha256').update(data).digest('hex');
const repo = new URL('../../../', import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-real-asset-composition-')),
    hooks = [];
  const k = await knowledgeHost({ after: (fn) => hooks.push(fn) }, { root });
  const domain = await k.ctx.storageDomain.open(workbenchDomainSpec);
  // Exact ORIGINAL package-domain name/layout/schema, opened once in this
  // isolated Host. This is not a parallel asset metadata or source library.
  const packs = await k.ctx.storageDomain.open({
    name: 'zhuma_asset_packages',
    version: 1,
    layout: 'per-record',
    tables: { versions: { valueSchema: StoredAssetPackageSchema } },
  });
  const wb = new WorkbenchService(
    { read: () => domain.global.get(), write: (value) => domain.global.set(value) },
    {
      get: (id) => domain.table('planning').get(id),
      put: (value) => domain.table('planning').put(value.id, value),
    },
    {
      get: (id) => packs.table('versions').get(id),
      put: (value) => packs.table('versions').put(value.versionId, value),
    },
  );
  const directory = {
    spaces: () => k.directory.spaces(),
    space: (id) => k.directory.space(id),
    isMember: (s, a) => k.directory.isMember(s, a),
    spacesForMember: (a) => k.directory.spacesForMember(a),
    spaceForProject: (id) => k.directory.spaceForProject(id),
    membersForSpace: (s) => k.directory.memberIdsForSpace(s).map((id) => ({ id })),
    administratorForSpace: (s) => k.personalOwners.get(s) ?? 'cy',
  };
  const manifest = JSON.parse(
    await readFile(new URL('resources/workflows/engineering-starter/catalog.json', repo), 'utf8'),
  );
  const base = await Promise.all(
    manifest.workflows.map(async (entry) => ({
      id: entry.id,
      kind: 'template',
      name: entry.name,
      description: entry.description,
      available: true,
      content: await readFile(
        new URL('resources/workflows/engineering-starter/' + entry.file, repo),
        'utf8',
      ),
    })),
  );
  let owner;
  const catalog = async (spaceId) => {
    const own = owner.publishedDefinitions(spaceId);
    return { experts: own.experts, assets: [...base, ...own.assets] };
  };
  owner = new MemberAssetService(wb, {
    signal: active(),
    memberLease: (req) => openExecutionMemberLease(k.ctx, req),
    directory: () => directory,
    catalog,
    sources: (req, query, signal) =>
      new MemberWorkbenchService(wb, {
        directory: () => directory,
        writer: () => k.directory,
        resolve: () => resolveMember(k.ctx, req),
        catalog,
      }).assetSources(query, signal),
  });
  const files = new TeamAssetFileService(new TeamAssetFileBytes(k.ctx.attachments), owner),
    view = new TeamAssetCatalogService(() => ({ assets: owner, knowledge: k.service }));
  t.after(async () => {
    await view.close();
    await files.close();
    await owner.close();
    await packs.close();
    await domain.close();
    for (const hook of hooks) await hook();
    await rm(root, { recursive: true, force: true });
  });
  const command = (input, actor = 'ann') => owner.command(k.requests[actor], input, active());
  const create = (definition, assetId = randomUUID()) =>
    command({
      operation: 'create-draft',
      spaceId: 'north',
      assetId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      definition,
      dependencies: [],
    });
  const publish = (created) =>
    command({
      operation: 'publish',
      spaceId: 'north',
      assetId: created.asset.assetId,
      expectedVersion: created.asset.version,
      idempotencyKey: randomUUID(),
    });
  const bytes = async () => {
    const snapshot = {};
    for (const name of await readdir(root, { recursive: true })) {
      const path = join(root, name);
      if ((await stat(path)).isFile()) snapshot[name] = hash(await readFile(path));
    }
    return snapshot;
  };
  return { ...k, root, wb, owner, files, view, base, command, create, publish, bytes };
}

test('actual D authority + E catalog: published aliases are not duplicate legacy rows, fixed references stay old, read-only composition preserves all original JSON/bytes', async (t) => {
  const h = await fixture(t);
  await h.seed({ pageId: 'online', title: 'Original online document' });
  const skill = await h.create(
    { kind: 'skill', name: 'Source method', description: 'Original', content: 'Old method' },
    'probe-skill-' + randomUUID(),
  );
  const first = await h.publish(skill);
  const changed = await h.command({
    operation: 'update-draft',
    spaceId: 'north',
    assetId: skill.asset.assetId,
    expectedVersion: first.asset.version,
    idempotencyKey: randomUUID(),
    definition: {
      kind: 'skill',
      name: 'Later method',
      description: 'Later',
      content: 'New method',
    },
    dependencies: [],
  });
  const second = await h.publish(changed);
  assert.notDeepEqual(first.reference, second.reference);
  const created = await h.create({ kind: 'file', name: 'Team source', description: 'Fixed bytes' }),
    data = Buffer.from('A汉😀BC');
  const input = {
    spaceId: 'north',
    assetId: created.asset.assetId,
    expectedVersion: created.asset.version,
    idempotencyKey: randomUUID(),
    declare: {
      name: 'original.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: hash(data),
    },
  };
  const receipt = await h.files.upload(
    h.requests.ann,
    input,
    (async function* () {
      yield data;
    })(),
    active(),
  );
  await h.files.idle();
  const file = await h.publish({
    asset: { assetId: created.asset.assetId, version: receipt.assetVersion },
  });
  const before = await h.bytes(),
    state = canonicalPayload(h.wb.snapshot());
  const result = await h.view.list(h.requests.bob, { spaceId: 'north', limit: 100 }, active());
  assert.deepEqual(result.counts, { all: 7, material: 2, template: 4, expert: 0, skill: 1 });
  assert.equal(result.items.filter((row) => row.source === 'builtin').length, 4);
  assert.equal(
    result.items.find((row) => row.source === 'asset' && row.asset.kind === 'skill').asset.versions
      .length,
    2,
  );
  assert.equal(
    (await h.owner.sources(h.requests.bob, { spaceId: 'north' }, active())).items.length,
    4,
  );
  assert.equal(
    (await h.owner.reference(h.requests.bob, first.reference, active())).definition.content,
    'Old method',
  );
  assert.equal(
    (await h.owner.reference(h.requests.bob, second.reference, active())).definition.content,
    'New method',
  );
  const read = await h.files.read(
    h.requests.bob,
    { spaceId: 'north', assetId: file.reference.assetId, versionId: file.reference.versionId },
    active(),
  );
  assert.deepEqual(Buffer.from(read.bytes), data);
  await h.files.idle();
  await assert.rejects(h.view.list(h.requests.dana, { spaceId: 'north' }, active()), {
    code: 'asset-forbidden',
  });
  assert.equal(canonicalPayload(h.wb.snapshot()), state);
  assert.deepEqual(await h.bytes(), before);
  console.log(
    'actual catalog/material/source references: 7 logical rows, old publication retained, readonly full fixture bytes unchanged',
  );
});

test('actual FileAuthority + E tool/Native budget: original full reference and checksum reach final output; membership revocation fences finalization', async (t) => {
  const h = await fixture(t),
    data = Buffer.from('A汉😀BC');
  const created = await h.create({
    kind: 'file',
    name: 'Team input',
    description: 'Original bytes',
  });
  const input = {
    spaceId: 'north',
    assetId: created.asset.assetId,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    declare: {
      name: 'input.txt',
      mediaType: 'text/plain',
      byteSize: data.length,
      sha256: hash(data),
    },
  };
  const receipt = await h.files.upload(
    h.requests.ann,
    input,
    (async function* () {
      yield data;
    })(),
    active(),
  );
  await h.files.idle();
  const published = await h.publish({
    asset: { assetId: created.asset.assetId, version: receipt.assetVersion },
  });
  const fixed = await h.owner.reference(h.requests.bob, published.reference, active());
  let record, definition, cleanup;
  const sessions = new NativeWorkSessionService(
    {
      read: () => record,
      write: async (_key, value) => {
        record = structuredClone(value);
      },
    },
    {
      connect: async () => {},
      isConnected: () => true,
      status: () => 'idle',
      send: () => {},
      flush: async () => {},
      stop: async () => 'stopped',
    },
  );
  const current = grant({ actorId: 'bob', spaceId: 'north' });
  await sessions.send(current, message('synthetic-native-binding', 'read only'));
  const binding = sessions.open(current).binding,
    agent = { id: binding.nativeAgentId };
  const member = await openExecutionMemberLease(h.ctx, h.requests.bob);
  const ports = {
    catalog: { scope: binding.scope, files: [{ reference: fixed.reference, file: fixed.file }] },
    signal: member.signal,
    assertCurrent: () => member.assertCurrent('north'),
    openFile(reference, signal) {
      let physical = Promise.resolve();
      const result = (async () => {
        await h.owner.reference(h.requests.bob, reference, signal);
        const op = h.files.openReadTracked(
          h.requests.bob,
          {
            spaceId: reference.spaceId,
            assetId: reference.assetId,
            versionId: reference.versionId,
          },
          signal,
        );
        physical = op.drain;
        return op.result;
      })();
      return {
        result,
        drain: result.then(
          () => physical,
          () => physical,
        ),
      };
    },
  };
  const ctx = {
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    tools: {
      register: (value) => {
        definition = value;
      },
    },
    effect: (factory) => {
      cleanup = factory();
    },
  };
  registerTeamAssetFileTool(ctx, binding, current, sessions, ports);
  t.after(async () => {
    await cleanup();
    member.release();
  });
  const exec = { agent, token: Symbol('actual-file-port'), signal: active() };
  const before = await h.bytes(),
    state = canonicalPayload(h.wb.snapshot());
  const value = await definition.execute(
    { request: { action: 'read', reference: fixed.reference, offset: 1, length: 4 } },
    exec,
  );
  assert.equal(value.ok, true);
  assert.equal(value.value.text, '汉');
  assert.equal(value.value.file.sha256, hash(data));
  assert.deepEqual(value.value.reference, published.reference);
  const final = JSON.parse(definition.finalizeContent(exec, { isError: false, value })[0].text);
  assert.deepEqual(final, value);
  await h.files.idle();
  assert.equal(canonicalPayload(h.wb.snapshot()), state);
  assert.deepEqual(await h.bytes(), before);
  const laterExec = { ...exec, token: Symbol('revoked') };
  const later = await definition.execute(
    { request: { action: 'read', reference: fixed.reference } },
    laterExec,
  );
  assert.equal(later.ok, true);
  await h.revoke('north', 'bob');
  const refused = JSON.parse(
    definition.finalizeContent(laterExec, { isError: false, value: later })[0].text,
  );
  assert.equal(refused.ok, false);
  await h.files.idle();
  console.log(
    'actual full file authority/bytes/tool: exact UTF8 final output, no readonly writes; revocation prevents candidate finalization; Run and native transport remain contracts',
  );
});
