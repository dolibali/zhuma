import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { knowledgeHost, value } from './knowledge-fixture.mjs';

const read = (spaceId = 'north', pageId = 'api', version = 1, patch = {}) => ({
  spaceId,
  libraryId: spaceId,
  pageId,
  version,
  ...patch,
});
test('knowledge read: logical libraries only project actual spaces and reads do not create page facts', async (t) => {
  const h = await knowledgeHost(t);
  const before = h.service.store.pages('north');
  const libraries = value(await h.service.libraries(h.requests.ann, { spaceId: 'north' }));
  assert.equal(libraries.actorId, 'ann');
  assert.deepEqual(libraries.libraries, [
    { id: 'north', spaceId: 'north', kind: 'team', name: '北区', canCreate: true },
  ]);
  assert.equal(
    value(await h.service.list(h.requests.ann, { spaceId: 'north', libraryId: 'north' })).pages
      .length,
    0,
  );
  assert.deepEqual(h.service.store.pages('north'), before);
  assert.equal(h.watchers.size, 0, 'member leases release after the response');
});

test('knowledge read: four accounts cannot enumerate another team, personal owner or forged actor', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed();
  await h.seed({ spaceId: 'south', text: 'SOUTH_PRIVATE_CANARY' });
  await h.seed({ spaceId: 'personal-ann', text: 'PERSONAL_PRIVATE_CANARY' });
  assert.equal(value(await h.service.read(h.requests.bob, read())).actorId, 'bob');
  for (const [request, input] of [
    [h.requests.dana, read()],
    [h.requests.ann, read('south')],
    [h.requests.ann, { ...read(), actorId: 'dana' }],
    [{ headers: {} }, read()],
  ]) {
    const result = await h.service.read(request, input);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/u);
  }
  await h.directory.grantMembership('personal-ann', 'bob');
  assert.equal((await h.service.read(h.requests.bob, read('personal-ann'))).ok, false);
  assert.equal(
    (await h.service.list(h.requests.bob, { spaceId: 'personal-ann', libraryId: 'personal-ann' }))
      .ok,
    false,
  );
  assert.equal(
    value(
      await h.service.search(h.requests.cy, {
        spaceId: 'north',
        libraryIds: ['north'],
        query: '接口',
      }),
    ).hits.length,
    1,
  );
  assert.equal(
    (
      await h.service.search(h.requests.cy, {
        spaceId: 'north',
        libraryIds: ['south'],
        query: 'PRIVATE',
      })
    ).ok,
    false,
  );
});

test('knowledge read: keyword results contain bounded snippets and exact version references, never whole source bodies', async (t) => {
  const h = await knowledgeHost(t);
  const text = `接口说明。${'内容'.repeat(200)}鉴权令牌。${'正文'.repeat(400)}`;
  const page = await h.seed({ text, original: 'PRIVATE_ORIGINAL_NOT_AUTOMATICALLY_SEARCHED' });
  const result = value(
    await h.service.search(h.requests.ann, {
      spaceId: 'north',
      libraryIds: ['north'],
      query: '鉴权',
    }),
  );
  assert.equal(result.complete, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].reference.checksum, page.versions[0].body.checksum);
  assert.ok(Array.from(result.hits[0].snippet).length <= 240);
  assert.equal(Object.hasOwn(result.hits[0], 'text'), false);
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.equal(
    value(
      await h.service.search(h.requests.ann, {
        spaceId: 'north',
        libraryIds: ['north'],
        query: 'PRIVATE_ORIGINAL',
      }),
    ).hits.length,
    0,
  );
});

test('knowledge read: complete UTF-8 byte coordinates use server nextOffset and preserve the original part', async (t) => {
  const h = await knowledgeHost(t);
  const text = '你😀Z好界';
  const page = await h.seed({ text, original: '原始😀Markdown' });
  let offset = 0,
    joined = '';
  while (offset < Buffer.byteLength(text)) {
    const result = value(
      await h.service.read(h.requests.ann, read('north', 'api', 1, { offset, length: 4 })),
    );
    assert.equal(result.offset, offset);
    assert.equal(Buffer.byteLength(result.text), result.length);
    assert.equal(result.nextOffset, offset + result.length);
    assert.equal(result.totalBytes, Buffer.byteLength(text));
    joined += result.text;
    offset = result.nextOffset;
  }
  assert.equal(joined, text);
  assert.equal(
    (await h.service.read(h.requests.ann, read('north', 'api', 1, { offset: 1 }))).ok,
    false,
  );
  const original = value(
    await h.service.read(h.requests.ann, read('north', 'api', 1, { part: 'original' })),
  );
  assert.equal(original.text, '原始😀Markdown');
  assert.equal(original.reference.checksum, page.versions[0].body.checksum);
  assert.equal(original.partChecksum, page.versions[0].original.checksum);
});

test('knowledge read: immutable old version survives newer publication while stale or copied cursors refuse', async (t) => {
  const h = await knowledgeHost(t);
  const page = await h.seed({ pageId: 'a' });
  await h.seed({ pageId: 'b', title: '鉴权第二页' });
  const first = value(
    await h.service.list(h.requests.ann, { spaceId: 'north', libraryId: 'north', limit: 1 }),
  );
  assert.ok(first.nextCursor);
  assert.equal(
    (
      await h.service.list(h.requests.bob, {
        spaceId: 'north',
        libraryId: 'north',
        cursor: first.nextCursor,
        limit: 1,
      })
    ).ok,
    false,
  );
  assert.equal(
    value(
      await h.service.list(h.requests.ann, {
        spaceId: 'north',
        libraryId: 'north',
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).pages.length,
    1,
  );
  await h.seed({
    pageId: 'a',
    versions: [
      ...page.versions,
      { ...page.versions[0], version: 2, title: '新版', body: await h.blob('新的正文。') },
    ],
  });
  assert.equal(
    (
      await h.service.list(h.requests.ann, {
        spaceId: 'north',
        libraryId: 'north',
        cursor: first.nextCursor,
        limit: 1,
      })
    ).ok,
    false,
  );
  assert.equal(
    value(await h.service.read(h.requests.ann, read('north', 'a', 1))).text,
    '接口使用令牌验证。',
  );
  assert.equal(
    (await h.service.read(h.requests.ann, read('north', 'a', 1, { checksum: '0'.repeat(64) }))).ok,
    false,
  );
});

test('knowledge read: durable membership revocation during a real byte stream releases no partial text', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed({ text: 'REVOKED_TEXT_CANARY中文正文' });
  const attachments = h.ctx.attachments,
    original = attachments.readFileStream.bind(attachments);
  attachments.readFileStream = async function* (ref, signal) {
    for await (const chunk of original(ref, signal)) {
      yield chunk.subarray(0, 1);
      await h.revoke('north', 'ann');
      yield chunk.subarray(1);
    }
  };
  const result = await h.service.read(h.requests.ann, read());
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /REVOKED_TEXT_CANARY/u);
  assert.equal(
    (
      await h.service.search(h.requests.ann, {
        spaceId: 'north',
        libraryIds: ['north'],
        query: 'CANARY',
      })
    ).ok,
    false,
  );
});

test('knowledge read: invalid bytes, private source scope and provider exceptions fail without body/path disclosure', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed();
  const attachments = h.ctx.attachments,
    original = attachments.readFileStream;
  attachments.readFileStream = async function* () {
    yield Buffer.from('CORRUPTED_CANARY');
  };
  assert.equal((await h.service.read(h.requests.ann, read())).ok, false);
  attachments.readFileStream = () => {
    throw Error('/private/PROVIDER_PATH_CANARY');
  };
  const result = await h.service.read(h.requests.ann, read());
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /CANARY|private/u);
  attachments.readFileStream = original;
  const source = await h.seed({ spaceId: 'personal-ann' });
  await h.seed({
    pageId: 'derived',
    sources: [
      {
        spaceId: 'personal-ann',
        libraryId: 'personal-ann',
        pageId: 'api',
        version: 1,
        checksum: source.versions[0].body.checksum,
      },
    ],
  });
  assert.equal((await h.service.read(h.requests.ann, read('north', 'derived'))).ok, false);
});

test('knowledge read: over-budget scanning reports limit rather than a false complete empty search', async (t) => {
  const h = await knowledgeHost(t);
  for (let i = 0; i < 201; i++) await h.seed({ pageId: `p${i}`, text: 'x' });
  const result = await h.service.search(h.requests.ann, {
    spaceId: 'north',
    libraryIds: ['north'],
    query: 'absent',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'limit');
  assert.equal(Object.hasOwn(result, 'hits'), false);
});

test('knowledge read: real DSH JSON and attachment bytes reopen; scope is reauthorized and old cursors do not survive', async (t) => {
  const first = await knowledgeHost(t);
  await first.seed();
  await first.seed({ pageId: 'b' });
  const cursor = value(
    await first.service.list(first.requests.ann, {
      spaceId: 'north',
      libraryId: 'north',
      limit: 1,
    }),
  ).nextCursor;
  await first.close();
  const cold = await knowledgeHost(t, { root: first.root });
  assert.equal(
    value(await cold.service.read(cold.requests.bob, read())).text,
    '接口使用令牌验证。',
  );
  assert.equal((await cold.service.read(cold.requests.dana, read())).ok, false);
  assert.equal(
    (await cold.service.list(cold.requests.ann, { spaceId: 'north', libraryId: 'north', cursor }))
      .ok,
    false,
  );
  await cold.service.close();
  assert.equal((await cold.service.libraries(cold.requests.ann, { spaceId: 'north' })).ok, false);
});

test('knowledge read: personal membership is not ownership; unknown owner and missing Host assertion fail closed', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed({ spaceId: 'personal-ann', text: 'PERSONAL_OWNER_CANARY' });
  await h.directory.grantMembership('personal-ann', 'bob');
  const operations = (who) => [
    () => h.service.libraries(h.requests[who], { spaceId: 'personal-ann' }),
    () => h.service.list(h.requests[who], { spaceId: 'personal-ann', libraryId: 'personal-ann' }),
    () =>
      h.service.search(h.requests[who], {
        spaceId: 'personal-ann',
        libraryIds: ['personal-ann'],
        query: 'OWNER',
      }),
    () => h.service.read(h.requests[who], read('personal-ann')),
  ];
  assert.equal(
    value(await h.service.read(h.requests.ann, read('personal-ann'))).text,
    'PERSONAL_OWNER_CANARY',
  );
  for (const operation of operations('bob')) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-found');
    assert.doesNotMatch(JSON.stringify(result), /CANARY|canCreate/u);
  }
  h.personalOwners.delete('personal-ann');
  for (const operation of operations('ann')) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'unavailable');
  }
  const unconfigured = await knowledgeHost(t, { omitPersonalOwner: true });
  const missing = await unconfigured.service.libraries(unconfigured.requests.ann, {
    spaceId: 'personal-ann',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'unavailable');
});

test('knowledge read: directory replacement during byte reads cannot carry old authorization or content', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed({ text: 'DIRECTORY_REPLACEMENT_CANARY' });
  const previous = h.directory;
  const original = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.readFileStream = async function* (ref, signal) {
    for await (const chunk of original(ref, signal)) {
      yield chunk.subarray(0, 1);
      assert.notEqual(await h.replaceDirectory(), previous);
      yield chunk.subarray(1);
    }
  };
  const result = await h.service.read(h.requests.ann, read());
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/u);
});

test('knowledge read: success and rejection leave real persistent metadata and attachment bytes unchanged', async (t) => {
  const h = await knowledgeHost(t);
  await h.seed();
  async function snapshot() {
    const files = {};
    async function visit(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const next = join(path, entry.name);
        if (entry.isDirectory()) await visit(next);
        else
          files[relative(h.root, next)] = createHash('sha256')
            .update(await readFile(next))
            .digest('hex');
      }
    }
    await visit(h.root);
    return files;
  }
  const before = await snapshot();
  value(await h.service.libraries(h.requests.ann, { spaceId: 'north' }));
  value(await h.service.list(h.requests.bob, { spaceId: 'north', libraryId: 'north' }));
  value(
    await h.service.search(h.requests.cy, {
      spaceId: 'north',
      libraryIds: ['north'],
      query: '接口',
    }),
  );
  value(await h.service.read(h.requests.bob, read()));
  assert.equal((await h.service.read(h.requests.dana, read())).ok, false);
  assert.equal((await h.service.read(h.requests.ann, { ...read(), version: 99 })).ok, false);
  assert.deepEqual(await snapshot(), before);
});
