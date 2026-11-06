/** Actual metadata transport + original member lease/SpaceDirectory/JSON facade.
 * Connection registration and account/session setup are explicit contracts;
 * this does not prove normal GUI, network deployment, model or Run adoption. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { openMemberAssetHttp } from '../dist/member-asset-http.js';
import { assetHost } from './member-asset-host-fixture.mjs';

async function setup(t, options = {}) {
  const f = await assetHost(t, options);
  const routes = new Map();
  f.ctx.provide('connection', {
    fetch: {
      register(route) {
        assert.ok(!routes.has(route.path));
        routes.set(route.path, route);
        return async () => {
          routes.delete(route.path);
        };
      },
    },
  });
  let source = {
    assets: f.owner,
    catalog: {
      list: async () => {
        throw Error('PRIVATE-CATALOG-FAILURE');
      },
    },
  };
  const http = openMemberAssetHttp(f.ctx, () => source);
  const request = (endpoint, payload, options = {}) => {
    const rpcId = randomUUID();
    const response = routes.get(`/api/zhuma-member/${endpoint}`).fetch(
      new Request('http://127.0.0.1:4000/api/zhuma-member/' + endpoint, {
        method: 'POST',
        headers: {
          ...f.requests[options.actor ?? 'ann'].headers,
          'content-type': 'application/json',
          ...options.headers,
        },
        body:
          options.body ??
          JSON.stringify({
            type: 'client-request',
            rpcId,
            method: options.method ?? `zhuma-member/${endpoint}`,
            payload,
          }),
        ...(options.body ? { duplex: 'half' } : {}),
      }),
    );
    return { rpcId, response };
  };
  t.after(() => http.close());
  return {
    ...f,
    routes,
    http,
    request,
    replace() {
      source = { ...source, catalog: { ...source.catalog } };
    },
  };
}
const create = () => ({
  operation: 'create-draft',
  spaceId: 'north',
  assetId: randomUUID(),
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  definition: { kind: 'file', name: 'Reference', description: 'Original metadata' },
  dependencies: [],
});
const tick = () => new Promise(setImmediate);

const folderInput = (patch = {}) => ({
  spaceId: 'north',
  folderId: randomUUID(),
  parentFolderId: null,
  name: '接口资料',
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  ...patch,
});
test('folder metadata HTTP contract: registered create/list and original file create/move enforce real member privacy and exact scope', async (t) => {
  const h = await setup(t),
    input = folderInput();
  const createReply = await h.request('asset-folder-create', input).response;
  assert.equal(createReply.status, 200);
  const createdFolder = (await createReply.json()).result.value.folder;
  assert.equal(createdFolder.folderId, input.folderId);
  assert.equal(createdFolder.createdBy, 'ann');
  assert.equal(createdFolder.fingerprint, undefined);
  const reply = await h.request('asset-folder-list', { spaceId: 'north', folderId: null }).response;
  assert.equal((await reply.json()).result.value.folders[0].folderId, input.folderId);
  const file = { ...create(), folderId: input.folderId };
  const fileReply = await h.request('asset-command', file).response;
  const asset = (await fileReply.json()).result.value.asset;
  const visible = await h.request('asset-folder-list', {
    spaceId: 'north',
    folderId: input.folderId,
    includeDrafts: true,
  }).response;
  assert.equal((await visible.json()).result.value.files.length, 1);
  const privateReply = await h.request(
    'asset-folder-list',
    { spaceId: 'north', folderId: input.folderId, includeDrafts: true },
    { actor: 'bob' },
  ).response;
  assert.deepEqual((await privateReply.json()).result.value.files, []);
  const move = {
    operation: 'move-file',
    spaceId: 'north',
    assetId: asset.assetId,
    expectedVersion: asset.version,
    idempotencyKey: randomUUID(),
    folderId: null,
  };
  assert.equal((await h.request('asset-command', move, { actor: 'bob' }).response).status, 403);
  assert.equal((await h.request('asset-command', move).response).status, 200);
  const wrongSpace = await h.request(
    'asset-folder-list',
    { spaceId: 'south', folderId: input.folderId },
    { actor: 'cy' },
  ).response;
  assert.equal(wrongSpace.status, 404);
  const forged = await h.request('asset-folder-create', { ...folderInput(), createdBy: 'bob' })
    .response;
  assert.equal(forged.status, 400);
});

test('folder metadata HTTP contract: identity gates body and owner replacement fences a late directory request', async (t) => {
  const h = await setup(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let pulls = 0;
  const deniedBody = new ReadableStream(
    {
      pull() {
        pulls++;
        throw Error('PRIVATE-BODY');
      },
    },
    { highWaterMark: 0 },
  );
  const denied = await h.request(
    'asset-folder-create',
    {},
    { body: deniedBody, headers: { cookie: '' } },
  ).response;
  assert.equal(denied.status, 401);
  assert.equal(pulls, 0);
  await deniedBody.cancel();
  const body = new ReadableStream(
    {
      async pull(controller) {
        entered.resolve();
        await release.promise;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'zhuma-member/asset-folder-create',
              payload: folderInput(),
            }),
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = h.request('asset-folder-create', {}, { body }).response;
  await entered.promise;
  h.replace();
  release.resolve();
  assert.equal((await pending).status, 503);
  assert.equal(h.workbench.snapshot().memberAssetFolders, undefined);
});

test('asset metadata HTTP contract: original authority persists one draft and replays the same command', async (t) => {
  const f = await setup(t),
    input = create();
  for (let i = 0; i < 2; i++) {
    const call = f.request('asset-command', input),
      response = await call.response;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rpcId, call.rpcId);
    assert.equal(body.result.ok, true);
    assert.equal(body.result.value.actorId, 'ann');
  }
  const list = await (
    await f.request('asset-list', { spaceId: 'north', includeDrafts: true }).response
  ).json();
  assert.equal(list.result.value.items.length, 1);
  assert.equal(list.result.value.items[0].assetId, input.assetId);
  const read = await (
    await f.request('asset-read', { spaceId: 'north', assetId: input.assetId, draft: true })
      .response
  ).json();
  assert.equal(read.result.value.definition.name, 'Reference');
  const bad = await f.request('asset-command', { ...create(), actorId: 'cy' }).response;
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).result.error.code, 'asset-invalid');
  assert.equal(f.workbench.memberAssetRecords().length, 1);
  const foreign = await f.request('asset-list', { spaceId: 'south' }).response;
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).result.error.code, 'asset-forbidden');
});

test('asset metadata HTTP contract: identity precedes body consumption, and only exact methods dispatch', async (t) => {
  const f = await setup(t);
  let pulls = 0;
  const body = new ReadableStream(
    {
      pull() {
        pulls++;
        throw Error('PRIVATE-BODY');
      },
    },
    { highWaterMark: 0 },
  );
  const denied = await f.request('asset-command', {}, { body, headers: { cookie: '' } }).response;
  assert.equal(denied.status, 401);
  assert.equal(pulls, 0);
  await body.cancel();
  const wrong = await f.request('asset-command', create(), { method: 'zhuma-member/command' })
    .response;
  assert.equal(wrong.status, 400);
  const unsupported = await f.request(
    'asset-list',
    { spaceId: 'north' },
    { headers: { 'content-type': 'text/plain' } },
  ).response;
  assert.equal(unsupported.status, 415);
  assert.equal(f.workbench.memberAssetRecords().length, 0);
  const unavailable = await f.request('asset-catalog', { spaceId: 'north' }).response;
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes('PRIVATE-'));
});

test('asset metadata HTTP contract: replacing an owner during body read prevents dispatch', async (t) => {
  const f = await setup(t),
    started = Promise.withResolvers(),
    data = Promise.withResolvers();
  const rpcId = randomUUID(),
    input = create();
  const stream = new ReadableStream(
    {
      async pull(controller) {
        started.resolve();
        controller.enqueue(new TextEncoder().encode(await data.promise));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = f.request('asset-command', input, { body: stream }).response;
  await started.promise;
  f.replace();
  data.resolve(
    JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'zhuma-member/asset-command',
      payload: input,
    }),
  );
  assert.equal((await pending).status, 503);
  assert.equal(f.workbench.memberAssetRecords().length, 0);
});

test('asset metadata HTTP contract: a late response cannot cross owners, while accepted facts keep the same receipt', async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let hold = true;
  const f = await setup(t, {
    beforeWrite: async () => {
      if (hold) {
        entered.resolve();
        await resume.promise;
      }
    },
  });
  const input = create(),
    pending = f.request('asset-command', input).response;
  await entered.promise;
  f.replace();
  hold = false;
  resume.resolve();
  const old = await pending;
  assert.equal(old.status, 503);
  assert.ok(!(await old.text()).includes(input.assetId));
  const fresh = await f.request('asset-command', input).response;
  assert.equal(fresh.status, 200);
  assert.equal(f.workbench.memberAssetRecords().length, 1);
});

test('asset metadata HTTP contract: close fences retained routes and waits for the actual admitted writer', async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await setup(t, {
    beforeWrite: async () => {
      entered.resolve();
      await resume.promise;
    },
  });
  const route = f.routes.get('/api/zhuma-member/asset-command');
  const pending = f.request('asset-command', create()).response;
  await entered.promise;
  let done = false;
  const closing = f.http.close().then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  assert.equal((await route.fetch(new Request('http://127.0.0.1:4000/'))).status, 503);
  resume.resolve();
  assert.equal((await pending).status, 408);
  await closing;
  assert.equal(done, true);
  assert.equal(f.routes.size, 0);
});

test('asset metadata HTTP contract: partial route registration fences callbacks and removes previous routes', async () => {
  const ctx = new Context(),
    routes = new Map(),
    retained = [];
  ctx.provide('connection', {
    fetch: {
      register(route) {
        if (routes.size === 2) throw Error('register failed');
        routes.set(route.path, route);
        retained.push(route);
        return async () => {
          routes.delete(route.path);
        };
      },
    },
  });
  assert.throws(() => openMemberAssetHttp(ctx, () => undefined), /register failed/);
  for (const route of retained)
    assert.equal((await route.fetch(new Request('http://localhost/'))).status, 503);
  await tick();
  assert.equal(routes.size, 0);
  await ctx.fiber.dispose();
});
