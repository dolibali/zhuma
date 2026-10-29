import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KnowledgeDraftValueSchema,
  KnowledgeWriteValueSchema,
  KnowledgeDraftsValueSchema,
} from '@zhuma/agent-core';
import { createHash } from 'node:crypto';
import { knowledgeHost, value } from './knowledge-fixture.mjs';

const save = (patch = {}) => ({
  spaceId: 'north',
  libraryId: 'north',
  pageId: 'guide',
  expectedVersion: 0,
  idempotencyKey: 'draft-one',
  content: { title: '操作指南', format: 'markdown', text: '真实正文😀。', sources: [] },
  ...patch,
});
const publish = (patch = {}) => ({
  spaceId: 'north',
  libraryId: 'north',
  pageId: 'guide',
  expectedVersion: 1,
  idempotencyKey: 'publish-one',
  ...patch,
});
const page = { spaceId: 'north', libraryId: 'north', pageId: 'guide' };
const library = { spaceId: 'north', libraryId: 'north' };

test('knowledge write: actual bytes remain private drafts until explicit author publication', async (t) => {
  const h = await knowledgeHost(t);
  const input = save({ content: { ...save().content, originalText: '\uFEFF原始😀资料' } });
  const saved = value(await h.service.saveDraft(h.requests.ann, input));
  KnowledgeWriteValueSchema.parse(saved);
  assert.equal(saved.pageRevision, 1);
  assert.equal(saved.disposition, 'saved');
  assert.equal(h.service.store.get('north', 'guide').versions.length, 0);
  const pending = value(await h.service.draft(h.requests.ann, page));
  KnowledgeDraftValueSchema.parse(pending);
  assert.equal(pending.draft.text, input.content.text);
  assert.equal(pending.draft.originalText, input.content.originalText);
  assert.equal(pending.published, null);
  assert.equal(value(await h.service.list(h.requests.bob, library)).pages.length, 0);
  assert.equal((await h.service.read(h.requests.bob, { ...page, version: 1 })).ok, false);
  const published = value(await h.service.publish(h.requests.ann, publish()));
  KnowledgeWriteValueSchema.parse(published);
  assert.equal(published.pageRevision, 2);
  assert.equal(published.reference.version, 1);
  assert.equal(published.disposition, 'published');
  assert.equal(value(await h.service.draft(h.requests.ann, page)).draft, null);
  const read = value(await h.service.read(h.requests.bob, published.reference));
  assert.equal(read.text, input.content.text);
  assert.equal(
    value(
      await h.service.read(h.requests.cy, {
        ...published.reference,
        part: 'original',
      }),
    ).text,
    input.content.originalText,
  );
  assert.equal((await h.service.read(h.requests.dana, published.reference)).ok, false);
});

test('knowledge write: team membership permits creation, never another author draft or publication', async (t) => {
  const h = await knowledgeHost(t);
  value(await h.service.saveDraft(h.requests.ann, save()));
  for (const operation of [
    () => h.service.draft(h.requests.bob, page),
    () => h.service.saveDraft(h.requests.bob, save({ expectedVersion: 1 })),
    () => h.service.proposeDraft(h.requests.bob, save({ expectedVersion: 1 })),
    () => h.service.publish(h.requests.bob, publish()),
  ]) {
    const result = await operation();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-found');
  }
  assert.equal(h.service.store.get('north', 'guide').version, 1);
  value(await h.service.saveDraft(h.requests.bob, save({ pageId: 'bob-guide' })));
  assert.equal(h.service.store.get('north', 'bob-guide').ownerActorId, 'bob');
  await h.directory.grantMembership('personal-ann', 'bob');
  for (const actor of ['ann', 'bob']) {
    const result = await h.service.saveDraft(
      h.requests[actor],
      save({
        spaceId: 'personal-ann',
        libraryId: 'personal-ann',
      }),
    );
    assert.equal(result.ok, actor === 'ann');
  }
});

test('knowledge write: concurrent same-body replay, changed-body conflict and CAS serialize one durable outcome', async (t) => {
  const h = await knowledgeHost(t);
  const identical = await Promise.all([
    h.service.saveDraft(h.requests.ann, save()),
    h.service.saveDraft(h.requests.ann, save()),
  ]);
  assert.deepEqual(
    identical
      .map(value)
      .map((r) => r.disposition)
      .sort(),
    ['replayed', 'saved'],
  );
  assert.equal(h.service.store.get('north', 'guide').version, 1);
  assert.equal(h.service.store.get('north', 'guide').receipts.length, 1);
  const changed = await h.service.saveDraft(
    h.requests.ann,
    save({
      content: { ...save().content, text: '不能覆盖' },
    }),
  );
  assert.equal(changed.error.code, 'conflict');
  const contenders = await Promise.all(
    ['two', 'three'].map((key) =>
      h.service.saveDraft(h.requests.ann, save({ expectedVersion: 1, idempotencyKey: key })),
    ),
  );
  assert.equal(contenders.filter((r) => r.ok).length, 1);
  assert.equal(contenders.find((r) => !r.ok).error.code, 'conflict');
  assert.equal(h.service.store.get('north', 'guide').version, 2);
  assert.equal(h.service.store.get('north', 'guide').receipts.length, 2);
});

test('knowledge write: exact publication replays once, old fixed bytes survive later draft and publication', async (t) => {
  const h = await knowledgeHost(t);
  value(await h.service.saveDraft(h.requests.ann, save()));
  const votes = await Promise.all([
    h.service.publish(h.requests.ann, publish()),
    h.service.publish(h.requests.ann, publish()),
  ]);
  assert.deepEqual(
    votes
      .map(value)
      .map((r) => r.disposition)
      .sort(),
    ['published', 'replayed'],
  );
  const first = value(votes[0]).reference;
  assert.equal(h.service.store.get('north', 'guide').versions.length, 1);
  value(
    await h.service.saveDraft(
      h.requests.ann,
      save({
        expectedVersion: 2,
        idempotencyKey: 'draft-two',
        content: { ...save().content, text: '第二版正文' },
      }),
    ),
  );
  assert.equal(value(await h.service.read(h.requests.bob, first)).text, save().content.text);
  const next = value(
    await h.service.publish(
      h.requests.ann,
      publish({ expectedVersion: 3, idempotencyKey: 'publish-two' }),
    ),
  );
  assert.equal(next.reference.version, 2);
  assert.equal(value(await h.service.read(h.requests.bob, first)).text, save().content.text);
  assert.equal(value(await h.service.read(h.requests.bob, next.reference)).text, '第二版正文');
  const replayed = value(await h.service.publish(h.requests.ann, publish()));
  assert.equal(replayed.pageRevision, 2);
  assert.deepEqual(replayed.reference, first);
  assert.equal(h.service.store.get('north', 'guide').versions.length, 2);
});

test('knowledge write: Agent proposes drafts without publishing or impersonating a member save', async (t) => {
  const h = await knowledgeHost(t);
  value(await h.service.proposeDraft(h.requests.ann, save()));
  const stored = h.service.store.get('north', 'guide');
  assert.equal(stored.draft.authorship, 'agent');
  assert.equal(stored.versions.length, 0);
  assert.equal(value(await h.service.list(h.requests.bob, library)).pages.length, 0);
  assert.equal((await h.service.saveDraft(h.requests.ann, save())).error.code, 'conflict');
  value(await h.service.publish(h.requests.ann, publish()));
});

test('knowledge write: real same-disk reopening preserves draft, receipts and immutable publication', async (t) => {
  const first = await knowledgeHost(t);
  value(await first.service.saveDraft(first.requests.ann, save()));
  await first.close();
  const cold = await knowledgeHost(t, { root: first.root });
  assert.equal(
    value(await cold.service.draft(cold.requests.ann, page)).draft.text,
    save().content.text,
  );
  assert.equal(
    value(await cold.service.saveDraft(cold.requests.ann, save())).disposition,
    'replayed',
  );
  const ref = value(await cold.service.publish(cold.requests.ann, publish())).reference;
  await cold.close();
  const reopened = await knowledgeHost(t, { root: first.root });
  assert.deepEqual(
    value(await reopened.service.publish(reopened.requests.ann, publish())).reference,
    ref,
  );
  assert.equal(
    value(await reopened.service.read(reopened.requests.bob, ref)).text,
    save().content.text,
  );
  assert.equal(reopened.service.store.get('north', 'guide').versions.length, 1);
});

test('knowledge write: provider and metadata failure never publish a phantom receipt; same key retries safely', async (t) => {
  const h = await knowledgeHost(t);
  const provider = h.ctx.attachments.saveFileStream;
  h.ctx.attachments.saveFileStream = async () => ({
    attachmentId: `sha256:${'0'.repeat(64)}`,
    name: 'knowledge.md',
    bytes: 0,
  });
  assert.equal((await h.service.saveDraft(h.requests.ann, save())).ok, false);
  assert.equal(h.service.store.get('north', 'guide'), undefined);
  h.ctx.attachments.saveFileStream = async ({ data, name }) => {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of data) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    // A formally correct receipt without actual provider bytes is still refused.
    return { attachmentId: `sha256:${hash.digest('hex')}`, name, bytes };
  };
  assert.equal((await h.service.saveDraft(h.requests.ann, save())).ok, false);
  assert.equal(h.service.store.get('north', 'guide'), undefined);
  h.ctx.attachments.saveFileStream = provider;
  const put = h.service.store.put.bind(h.service.store);
  h.service.store.put = async () => {
    throw Error('SYNTHETIC_DURABILITY_FAILURE');
  };
  assert.equal((await h.service.saveDraft(h.requests.ann, save())).ok, false);
  assert.equal(h.service.store.get('north', 'guide'), undefined);
  h.service.store.put = put;
  assert.equal(value(await h.service.saveDraft(h.requests.ann, save())).pageRevision, 1);
  assert.equal(h.service.store.get('north', 'guide').receipts.length, 1);
});

test('knowledge write: queued calls reauthorize after waiting and cannot write after revocation', async (t) => {
  const h = await knowledgeHost(t);
  const begun = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const provider = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (input) => {
    begun.resolve();
    await gate.promise;
    return provider(input);
  };
  const first = h.service.saveDraft(h.requests.ann, save());
  await begun.promise;
  const queued = h.service.saveDraft(h.requests.ann, save({ pageId: 'queued' }));
  await h.revoke('north', 'ann');
  try {
    assert.equal((await first).ok, false);
    assert.equal((await queued).ok, false);
    assert.equal(h.service.store.get('north', 'guide'), undefined);
    assert.equal(h.service.store.get('north', 'queued'), undefined);
  } finally {
    gate.resolve();
  }
});

test('knowledge write: revoked writer or corrupted draft bytes cannot create accepted content', async (t) => {
  const h = await knowledgeHost(t);
  const saveFile = h.ctx.attachments.saveFileStream.bind(h.ctx.attachments);
  h.ctx.attachments.saveFileStream = async (input) => {
    await h.revoke('north', 'ann');
    return saveFile(input);
  };
  assert.equal((await h.service.saveDraft(h.requests.ann, save())).ok, false);
  assert.equal(h.service.store.get('north', 'guide'), undefined);
  const other = await knowledgeHost(t);
  value(await other.service.saveDraft(other.requests.ann, save()));
  other.ctx.attachments.readFileStream = async function* () {
    yield Buffer.from('CORRUPTED');
  };
  assert.equal((await other.service.publish(other.requests.ann, publish())).ok, false);
  const page = other.service.store.get('north', 'guide');
  assert.equal(page.version, 1);
  assert.equal(page.versions.length, 0);
  assert.equal(page.receipts.length, 1);
  assert.ok(page.draft);
});

test('knowledge write: only exact readable source refs are accepted and inputs never supply identity', async (t) => {
  const h = await knowledgeHost(t);
  const source = await h.seed();
  const ref = {
    spaceId: 'north',
    libraryId: 'north',
    pageId: 'api',
    version: 1,
    checksum: source.versions[0].body.checksum,
  };
  for (const content of [
    { ...save().content, sources: [ref, ref] },
    {
      ...save().content,
      sources: [{ ...ref, spaceId: 'personal-ann', libraryId: 'personal-ann' }],
    },
    { ...save().content, sources: [{ ...ref, checksum: '0'.repeat(64) }] },
    { ...save().content, text: '中'.repeat(22_000) },
    { ...save().content, text: '\ud800' },
  ]) {
    assert.equal((await h.service.saveDraft(h.requests.ann, save({ content }))).ok, false);
    assert.equal(h.service.store.get('north', 'guide'), undefined);
  }
  assert.equal((await h.service.saveDraft(h.requests.ann, save({ actorId: 'bob' }))).ok, false);
  assert.equal(
    (
      await h.service.saveDraft(
        h.requests.ann,
        save({
          content: { ...save().content, sources: [ref] },
        }),
      )
    ).ok,
    true,
  );
});

test('knowledge drafts: author-only metadata is discoverable without body reads or cross-author cursor side channels', async (t) => {
  const h = await knowledgeHost(t);
  for (const pageId of ['a', 'b'])
    value(await h.service.saveDraft(h.requests.ann, save({ pageId })));
  value(
    await h.service.saveDraft(
      h.requests.bob,
      save({
        pageId: 'bob',
        content: { ...save().content, title: 'BOB_SECRET_TITLE', text: 'BOB_PRIVATE_BODY' },
      }),
    ),
  );
  const first = value(await h.service.drafts(h.requests.ann, { ...library, limit: 1 }));
  KnowledgeDraftsValueSchema.parse(first);
  assert.ok(first.nextCursor);
  assert.equal(first.pages[0].ownerActorId, 'ann');
  assert.doesNotMatch(JSON.stringify(first), /BOB|真实正文|reference|text/u);
  assert.equal(
    (await h.service.drafts(h.requests.bob, { ...library, limit: 1, cursor: first.nextCursor }))
      .error.code,
    'conflict',
  );
  value(await h.service.saveDraft(h.requests.bob, save({ pageId: 'bob-two' })));
  h.ctx.attachments.readFileStream = () => {
    throw Error('Draft directory must not read bytes');
  };
  const next = value(
    await h.service.drafts(h.requests.ann, { ...library, limit: 1, cursor: first.nextCursor }),
  );
  assert.equal(next.pages.length, 1);
  assert.notEqual(next.pages[0].pageId, first.pages[0].pageId);
  assert.equal((await h.service.drafts(h.requests.dana, library)).ok, false);
  assert.equal((await h.service.drafts(h.requests.ann, { ...library, actorId: 'bob' })).ok, false);
});

test('knowledge drafts: saved times are persistent facts or unknown; publication removes the pending directory entry', async (t) => {
  const h = await knowledgeHost(t);
  value(await h.service.saveDraft(h.requests.ann, save()));
  const stored = h.service.store.get('north', 'guide');
  const first = value(await h.service.drafts(h.requests.ann, library)).pages[0];
  assert.equal(first.savedAt, stored.draft.savedAt);
  assert.equal(first.hasPublished, false);
  const again = value(await h.service.drafts(h.requests.ann, library)).pages[0];
  assert.equal(again.savedAt, first.savedAt);
  delete stored.draft.savedAt;
  await h.service.store.put(stored);
  assert.equal(
    Object.hasOwn(value(await h.service.drafts(h.requests.ann, library)).pages[0], 'savedAt'),
    false,
  );
  value(await h.service.publish(h.requests.ann, publish()));
  assert.equal(value(await h.service.drafts(h.requests.ann, library)).pages.length, 0);
  value(
    await h.service.saveDraft(
      h.requests.ann,
      save({ expectedVersion: 2, idempotencyKey: 'next-draft' }),
    ),
  );
  assert.equal(value(await h.service.drafts(h.requests.ann, library)).pages[0].hasPublished, true);
});

test('knowledge drafts: original-presence metadata follows the exact published reference and never destroys older originals', async (t) => {
  const h = await knowledgeHost(t);
  value(
    await h.service.saveDraft(
      h.requests.ann,
      save({
        content: { ...save().content, originalText: '原始固定资料' },
      }),
    ),
  );
  assert.equal(value(await h.service.draft(h.requests.ann, page)).publishedHasOriginal, false);
  const first = value(await h.service.publish(h.requests.ann, publish())).reference;
  const after = value(await h.service.draft(h.requests.ann, page));
  assert.equal(after.publishedHasOriginal, true);
  assert.deepEqual(after.published, first);
  value(
    await h.service.saveDraft(
      h.requests.ann,
      save({ expectedVersion: 2, idempotencyKey: 'without-original' }),
    ),
  );
  assert.equal(value(await h.service.draft(h.requests.ann, page)).publishedHasOriginal, true);
  const second = value(
    await h.service.publish(
      h.requests.ann,
      publish({
        expectedVersion: 3,
        idempotencyKey: 'publish-two',
      }),
    ),
  ).reference;
  const final = value(await h.service.draft(h.requests.ann, page));
  assert.equal(final.publishedHasOriginal, false);
  assert.deepEqual(final.published, second);
  assert.equal(
    value(await h.service.read(h.requests.ann, { ...first, part: 'original' })).text,
    '原始固定资料',
  );
});
