import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KnowledgeReadRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeListRequestSchema,
  KnowledgeReadValueSchema,
} from '../dist/knowledge-contract.js';

test('knowledge DTO: scoped fixed reads never accept an actor, implicit latest or a path', () => {
  const request = { spaceId: 'north', libraryId: 'api', pageId: 'auth', version: 1 };
  assert.equal(KnowledgeReadRequestSchema.parse(request).length, 8192);
  for (const patch of [
    { actorId: 'ann' },
    { version: 'latest' },
    { path: '/private/file' },
    { length: 8193 },
    { version: 0 },
  ])
    assert.equal(KnowledgeReadRequestSchema.safeParse({ ...request, ...patch }).success, false);
});

test('knowledge DTO: search scopes are explicit, unique and bounded; empty search is not a whole-library dump', () => {
  const request = { spaceId: 'north', libraryIds: ['api'], query: '接口' };
  assert.equal(KnowledgeSearchRequestSchema.parse(request).limit, 10);
  for (const patch of [
    { libraryIds: [] },
    { libraryIds: ['api', 'api'] },
    { query: '  ' },
    { limit: 21 },
  ])
    assert.equal(KnowledgeSearchRequestSchema.safeParse({ ...request, ...patch }).success, false);
  assert.equal(
    KnowledgeListRequestSchema.safeParse({ spaceId: 'north', libraryId: 'api', limit: 51 }).success,
    false,
  );
});

test('knowledge DTO: selected byte part and complete fixed version digest remain distinct', () => {
  const value = {
    actorId: 'ann',
    spaceId: 'north',
    reference: {
      spaceId: 'north',
      libraryId: 'api',
      pageId: 'auth',
      version: 2,
      checksum: 'a'.repeat(64),
    },
    part: 'original',
    partChecksum: 'b'.repeat(64),
    title: '接口',
    format: 'markdown',
    text: '接口',
    offset: 0,
    length: 6,
    nextOffset: 6,
    totalBytes: 9,
    sources: [],
  };
  assert.equal(KnowledgeReadValueSchema.parse(value).partChecksum, 'b'.repeat(64));
  assert.equal(KnowledgeReadValueSchema.safeParse({ ...value, actorId: undefined }).success, false);
});
