/** Original client codecs and bounded transport contracts; no Host or read authority proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectKnowledgeApi } from '../dist/knowledge/project-knowledge-api.js';

const target = { spaceId: 'north', projectId: 'project' };
const reference = {
  spaceId: 'north',
  libraryId: 'north',
  pageId: 'guide',
  version: 1,
  checksum: 'a'.repeat(64),
};
const links = [{ reference, required: true }];
const value = () => ({
  actorId: 'ann',
  ...target,
  relationshipVersion: 2,
  links: [{ ...links[0], title: '接口说明', format: 'markdown', bytes: 100, hasUpdate: true }],
  snapshot: {
    sourceVersion: 'zhuma-project-knowledge@1',
    ...target,
    relationshipVersion: 2,
    links: structuredClone(links),
    checksum: 'b'.repeat(64),
  },
});
const scope = { actorId: 'ann', spaceId: 'north', isCurrent: () => true, onUnauthenticated() {} };
const signal = () => new AbortController().signal;
const response = (init, result, patch = {}) =>
  Response.json({
    type: 'server-response',
    rpcId: JSON.parse(init.body).rpcId,
    result,
    ...patch,
  });

test('project knowledge API keeps fixed refs and sends the original write intent unchanged on explicit retry', async () => {
  const calls = [];
  const api = createProjectKnowledgeApi(scope, async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, request });
    if (url.endsWith('/project-links')) return response(init, { ok: true, value: value() });
    if (calls.length === 2) throw new TypeError('synthetic offline');
    return response(init, {
      ok: true,
      value: {
        actorId: 'ann',
        ...target,
        relationshipVersion: 3,
        disposition: 'replayed',
      },
    });
  });
  const found = await api.projectLinks(target, signal());
  assert.equal(found.links[0].reference.version, 1, 'Update availability never follows latest');
  const input = { ...target, expectedVersion: 2, idempotencyKey: 'same-intent', links };
  await assert.rejects(api.saveProjectLinks(input, signal()), { code: 'unavailable' });
  assert.equal(calls.length, 2, 'No automatic write retry');
  assert.equal((await api.saveProjectLinks(input, signal())).disposition, 'replayed');
  assert.deepEqual(calls[1].request.payload, input);
  assert.deepEqual(calls[2].request.payload, input);
  assert.equal(calls[1].url, '/api/zhuma-knowledge/save-project-links');
  assert.equal(calls[1].request.method, 'zhuma-knowledge/save-project-links');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.equal(calls[1].init.cache, 'no-store');
  assert.deepEqual(Object.keys(calls[1].init.headers), ['content-type']);
});

test('project knowledge API rejects wrong actor, project, version and fixed-reference snapshot without exposing replies', async () => {
  for (const patch of [
    (v) => {
      v.actorId = 'other';
    },
    (v) => {
      v.projectId = 'other';
    },
    (v) => {
      v.snapshot.relationshipVersion++;
    },
    (v) => {
      v.snapshot.links[0].required = false;
    },
    (v) => {
      v.snapshot.links[0].reference.version++;
    },
    (v) => {
      v.snapshot.spaceId = 'south';
    },
  ]) {
    const api = createProjectKnowledgeApi(scope, async (_url, init) => {
      const changed = value();
      patch(changed);
      return response(init, { ok: true, value: changed });
    });
    await assert.rejects(api.projectLinks(target, signal()), { code: 'invalid-response' });
  }
  let calls = 0;
  const api = createProjectKnowledgeApi(scope, async () => {
    calls++;
    assert.fail();
  });
  await assert.rejects(api.projectLinks({ ...target, spaceId: 'south' }, signal()), {
    code: 'forbidden',
  });
  await assert.rejects(api.projectLinks({ ...target, actorId: 'ann' }, signal()), {
    code: 'invalid',
  });
  assert.equal(calls, 0);
});

test('project knowledge API fences delayed responses and expired identity before publishing project content', async () => {
  const pending = Promise.withResolvers();
  let current = true,
    invalidations = 0,
    request;
  const api = createProjectKnowledgeApi(
    { ...scope, isCurrent: () => current },
    async (_url, init) => {
      request = init;
      return pending.promise;
    },
  );
  const read = api.projectLinks(target, signal());
  current = false;
  pending.resolve(response(request, { ok: true, value: value() }));
  await assert.rejects(read, { name: 'AbortError' });
  await assert.rejects(
    createProjectKnowledgeApi(
      {
        ...scope,
        onUnauthenticated() {
          invalidations++;
        },
      },
      async () => new Response(null, { status: 401 }),
    ).projectLinks(target, signal()),
    { code: 'unauthenticated' },
  );
  assert.equal(invalidations, 1);
});

test('project knowledge API keeps interrupted bodies retryable and malformed replies closed', async () => {
  for (const [fetcher, code] of [
    [
      async () => ({
        status: 200,
        ok: true,
        async json() {
          throw new TypeError('interrupted');
        },
      }),
      'unavailable',
    ],
    [async () => new Response('malformed'), 'invalid-response'],
    [
      async (_url, init) => response(init, { ok: true, value: value() }, { rpcId: 'other' }),
      'invalid-response',
    ],
    [
      async (_url, init) =>
        response(init, { ok: false, error: { code: 'conflict', message: 'private detail' } }),
      'conflict',
    ],
  ])
    await assert.rejects(
      createProjectKnowledgeApi(scope, fetcher).projectLinks(target, signal()),
      (error) => error.code === code && !error.message.includes('private detail'),
    );
});
