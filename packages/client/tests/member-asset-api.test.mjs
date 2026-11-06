/** Public Core codecs + real fetch streams; identity/server responses are contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createMemberAssetApi, describeMemberAssetFile } from '../dist/assets/api.js';
const spaceId = 'team-a',
  assetId = randomUUID(),
  versionId = randomUUID();
const reference = { spaceId, assetId, versionId, kind: 'file', sha256: 'a'.repeat(64) };
const summary = {
  spaceId,
  assetId,
  kind: 'file',
  name: '规范',
  description: '',
  ownerId: 'ann',
  maintainerIds: ['ann'],
  version: 3,
  canMaintain: true,
  canPublish: true,
  hasDraft: true,
  versions: [{ reference, number: 1, publishedBy: 'ann', publishedAt: '2026-10-30T00:00:00.000Z' }],
};
const identity = () => ({
  ok: true,
  accountId: 'ann',
  principal: { kind: 'zhuma-member', memberId: 'ann' },
  peerId: 'contract-peer',
  spaces: [{ id: spaceId, kind: 'team', name: '团队' }],
});
function harness(handler, session = identity) {
  const calls = [],
    events = { current: true, login: 0, unavailable: 0 };
  const scope = {
    actorId: 'ann',
    spaceId,
    isCurrent: () => events.current,
    onUnauthenticated: () => events.login++,
    onUnavailable: () => events.unavailable++,
  };
  const api = createMemberAssetApi(scope, async (url, init) => {
    calls.push({ url, init });
    if (url === '/zhuma-id/session') return Response.json(await session());
    const input =
      init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : undefined;
    const value = await handler(input, init);
    return value instanceof Response
      ? value
      : Response.json({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } });
  });
  return { api, calls, events };
}
const readValue = () => ({
  actorId: 'ann',
  asset: summary,
  selection: { kind: 'published', reference },
  definition: { kind: 'file', name: '规范', description: '' },
  dependencies: [],
  file: { name: '规范.txt', mediaType: 'text/plain', byteSize: 0, sha256: 'd'.repeat(64) },
});

test('member assets: fixed object/version/RPC/actor codecs refuse mismatches and preserve MCP requirements', async () => {
  let value = readValue();
  const h = harness(() => value);
  const query = { spaceId, assetId, versionId };
  assert.deepEqual(
    (await h.api.read(query, new AbortController().signal)).selection.reference,
    reference,
  );
  value = {
    ...readValue(),
    selection: { kind: 'published', reference: { ...reference, versionId: randomUUID() } },
  };
  await assert.rejects(h.api.read(query, new AbortController().signal), {
    code: 'invalid-response',
  });
  value = { ...readValue(), actorId: 'other' };
  await assert.rejects(h.api.read(query, new AbortController().signal), {
    code: 'unauthenticated',
  });
  assert.equal(h.events.login, 1);
  const source = {
    kind: 'builtin',
    spaceId,
    assetId: 'expert',
    assetKind: 'expert',
    sourceCommit: 'b'.repeat(40),
    sha256: 'c'.repeat(64),
  };
  value = {
    actorId: 'ann',
    spaceId,
    source,
    definition: {
      kind: 'expert',
      name: '接口专家',
      description: '',
      role: '',
      capabilities: [],
      instructions: '检查接口',
    },
    requirements: [
      { slotId: 'method', kind: 'skill' },
      { slotId: 'docs', kind: 'mcp' },
    ],
  };
  assert.deepEqual(
    (await h.api.source(source, new AbortController().signal)).requirements,
    value.requirements,
  );
  value = Response.json({
    type: 'server-response',
    rpcId: randomUUID(),
    result: { ok: true, value: readValue() },
  });
  await assert.rejects(h.api.read(query, new AbortController().signal), {
    code: 'invalid-response',
  });
});

test('member assets: fresh identity and view epoch prevent stale or foreign requests/results', async () => {
  const h = harness(
    () => readValue(),
    () => ({
      ...identity(),
      accountId: 'changed',
      principal: { kind: 'zhuma-member', memberId: 'changed' },
    }),
  );
  await assert.rejects(h.api.read({ spaceId, assetId, versionId }, new AbortController().signal), {
    code: 'unauthenticated',
  });
  assert.equal(h.calls.length, 1);
  const pending = Promise.withResolvers(),
    admitted = Promise.withResolvers();
  const late = harness(async () => {
    admitted.resolve();
    return pending.promise;
  });
  const request = late.api.read({ spaceId, assetId, versionId }, new AbortController().signal);
  await admitted.promise;
  late.events.current = false;
  pending.resolve(readValue());
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(late.events.login, 0);
  await assert.rejects(
    h.api.read({ spaceId: 'foreign', assetId, versionId }, new AbortController().signal),
    { code: 'forbidden' },
  );
});

test('member assets: lost write ACK remains unknown and retries keep the exact original intent', async () => {
  let attempts = 0;
  const bodies = [];
  const h = harness((input) => {
    bodies.push(input.payload);
    if (++attempts === 1) throw Error('network lost after admission');
    return { disposition: 'replayed', actorId: 'ann', resultVersion: 3, asset: summary, reference };
  });
  const input = {
    operation: 'publish',
    spaceId,
    assetId,
    expectedVersion: 2,
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(h.api.command(input, new AbortController().signal), { outcome: 'unknown' });
  assert.equal((await h.api.command(input, new AbortController().signal)).disposition, 'replayed');
  assert.deepEqual(bodies, [input, input]);
  assert.equal('actorId' in bodies[0], false);
});

test('member assets: raw file upload receipt must match complete declaration and original key', async () => {
  const file = new File(['字段说明'], 'spec.txt', { type: 'text/plain' }),
    signal = new AbortController().signal;
  const declare = await describeMemberAssetFile(file, signal),
    key = randomUUID();
  let forged = false;
  const h = harness(async (_input, init) => {
    assert.equal(init.body, file);
    assert.equal(init.headers['x-zhuma-file-name'], 'spec.txt');
    return Response.json({
      ok: true,
      value: {
        spaceId,
        assetId,
        idempotencyKey: forged ? randomUUID() : key,
        assetVersion: 4,
        file: declare,
      },
    });
  });
  const input = { spaceId, assetId, expectedVersion: 2, idempotencyKey: key, declare };
  assert.equal((await h.api.upload(input, file, signal)).assetVersion, 4);
  forged = true;
  await assert.rejects(h.api.upload(input, file, signal), { outcome: 'unknown' });
});

test('member assets: preview verifies exact bytes/context/digest and rejects partial, wrong version and unsafe MIME', async () => {
  const data = Buffer.from('完整文件内容'),
    digest = createHash('sha256').update(data).digest('hex');
  const file = { name: 'spec.txt', mediaType: 'text/plain', byteSize: data.length, sha256: digest };
  const query = { spaceId, assetId, versionId, mode: 'preview' };
  let body = data,
    context = query,
    type = 'text/plain; charset=utf-8';
  const h = harness(
    () =>
      new Response(body, {
        headers: {
          'content-type': type,
          'content-disposition': 'inline',
          'x-zhuma-file-sha256': digest,
          'x-zhuma-asset-file-context': encodeURIComponent(JSON.stringify(context)),
        },
      }),
  );
  assert.equal(
    await (await h.api.file(query, file, new AbortController().signal)).blob.text(),
    data.toString(),
  );
  for (const mode of ['partial', 'version', 'mime', 'digest']) {
    body =
      mode === 'partial'
        ? data.subarray(0, 3)
        : mode === 'digest'
          ? Buffer.alloc(data.length)
          : data;
    context = mode === 'version' ? { ...query, versionId: randomUUID() } : query;
    type = mode === 'mime' ? 'image/svg+xml' : 'text/plain; charset=utf-8';
    await assert.rejects(h.api.file(query, file, new AbortController().signal), {
      code: 'invalid-response',
    });
  }
});

test('member folders: exact folder projections and unknown create ACK retain the original intent', async () => {
  const folderId = randomUUID(),
    folder = {
      spaceId,
      folderId,
      parentFolderId: null,
      name: '研发资料',
      createdBy: 'ann',
      version: 1,
    },
    bodies = [];
  let lost = true,
    wrong = false;
  const h = harness((input) => {
    if (input.method.endsWith('asset-folder-list'))
      return {
        actorId: 'ann',
        spaceId,
        folderId: wrong ? randomUUID() : folderId,
        path: [folder],
        folders: [],
        files: [],
      };
    bodies.push(input.payload);
    if (lost) {
      lost = false;
      throw Error('lost after durable folder create');
    }
    return { actorId: 'ann', spaceId, disposition: 'replayed', resultVersion: 1, folder };
  });
  assert.equal(
    (
      await h.api.listFolder(
        { spaceId, folderId, includeDrafts: true },
        new AbortController().signal,
      )
    ).path[0].name,
    '研发资料',
  );
  wrong = true;
  await assert.rejects(h.api.listFolder({ spaceId, folderId }, new AbortController().signal), {
    code: 'invalid-response',
  });
  const input = {
    spaceId,
    folderId,
    parentFolderId: null,
    name: '研发资料',
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(h.api.createFolder(input, new AbortController().signal), {
    outcome: 'unknown',
  });
  assert.equal(
    (await h.api.createFolder(input, new AbortController().signal)).disposition,
    'replayed',
  );
  assert.deepEqual(bodies, [input, input]);
});
