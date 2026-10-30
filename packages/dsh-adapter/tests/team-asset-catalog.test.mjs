/** Original knowledge service/member leases/JSON, explicit asset authority port.
 * No real asset CAS, renderer, Agent or model qualification is inferred. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { knowledgeHost } from './knowledge-fixture.mjs';
import { resolveMember } from '../dist/member-session.js';
import { TeamAssetCatalogService } from '../dist/team-asset-catalog.js';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;
async function setup(t, options = {}) {
  const host = await knowledgeHost(t),
    calls = [];
  let current,
    changed = false,
    writes = 0,
    bodies = 0;
  const originalPut = host.service.store.put.bind(host.service.store);
  host.service.store.put = (...args) => {
    writes++;
    return originalPut(...args);
  };
  host.service.read = () => {
    bodies++;
    throw Error('Body read not permitted for catalog');
  };
  const member = async (request, spaceId) => {
    const actor = await resolveMember(host.ctx, request);
    if (!actor.ok || !actor.spaceIds.includes(spaceId))
      throw Object.assign(Error('not-found'), { code: 'asset-not-found' });
    return actor.memberId;
  };
  const versionId = randomUUID();
  const asset = {
    spaceId: 'north',
    assetId: 'file',
    kind: 'file',
    name: 'Original file',
    description: 'Published metadata',
    ownerId: 'ann',
    maintainerIds: ['ann'],
    version: 2,
    canMaintain: true,
    canPublish: false,
    hasDraft: false,
    versions: [
      {
        reference: {
          spaceId: 'north',
          assetId: 'file',
          kind: 'file',
          versionId,
          sha256: 'a'.repeat(64),
        },
        number: 1,
        publishedBy: 'ann',
        publishedAt: '2026-10-30T00:00:00Z',
      },
    ],
  };
  const assets = {
    async list(request, query, active) {
      calls.push({ op: 'assets', request, query });
      const actorId = await member(request, query.spaceId);
      await options.list?.(calls.length, active);
      return {
        actorId,
        spaceId: query.spaceId,
        items: query.spaceId === 'north' ? [{ ...asset, version: changed ? 3 : 2 }] : [],
      };
    },
    async sources(request, query, active) {
      calls.push({ op: 'sources', request, query });
      const actorId = await member(request, query.spaceId);
      await options.sources?.(active);
      return { actorId, spaceId: query.spaceId, items: [] };
    },
  };
  current = { assets, knowledge: host.service };
  const catalog = new TeamAssetCatalogService(() => current);
  t.after(() => catalog.close());
  return {
    ...host,
    catalog,
    calls,
    stats: () => ({ writes, bodies }),
    resetWrites: () => {
      writes = 0;
    },
    replace: () => {
      current = { ...current, knowledge: {} };
    },
    change: () => {
      changed = true;
    },
    sources: current,
  };
}

test('team catalog: original knowledge pagination and asset metadata combine without bodies, writes or duplicate version counts', async (t) => {
  const h = await setup(t);
  for (let i = 0; i < 51; i++)
    await h.seed({ pageId: 'p-' + i, title: 'Guide ' + String(i).padStart(2, '0') });
  h.resetWrites();
  const request = h.requests.ann;
  const value = await h.catalog.list(request, { spaceId: 'north', limit: 100 }, signal());
  assert.deepEqual(value.counts, { all: 52, material: 52, template: 0, expert: 0, skill: 0 });
  assert.equal(value.items.filter((row) => row.source === 'knowledge').length, 51);
  assert.equal(value.items.find((row) => row.source === 'asset').asset.versions.length, 1);
  assert.equal(value.nextOffset, null);
  assert.deepEqual(h.stats(), { writes: 0, bodies: 0 });
  assert.deepEqual(
    h.calls.map((call) => call.op),
    ['assets', 'sources', 'assets'],
  );
  assert.ok(h.calls.every((call) => call.request === request && call.query.spaceId === 'north'));
  const found = await h.catalog.list(request, { spaceId: 'north', search: 'Guide 00' }, signal());
  assert.equal(found.total, 1);
  assert.equal(found.items[0].page.reference.pageId, 'p-0');
});

test('team catalog: empty authorized knowledge is a real empty source, while invalid caller/scope is refused first', async (t) => {
  const h = await setup(t);
  const south = await h.catalog.list(h.requests.dana, { spaceId: 'south' }, signal());
  assert.equal(south.total, 0);
  await assert.rejects(h.catalog.list(h.requests.dana, { spaceId: 'north' }, signal()), {
    code: 'asset-not-found',
  });
  await assert.rejects(
    h.catalog.list(h.requests.ann, { spaceId: 'north', actorId: 'dana' }, signal()),
    { code: 'asset-invalid' },
  );
  assert.deepEqual(h.stats(), { writes: 0, bodies: 0 });
});

test('team catalog: a failed original knowledge source never becomes zero-success counts', async (t) => {
  const h = await setup(t);
  h.sources.knowledge = {
    libraries: async () => ({
      ok: false,
      error: { code: 'unavailable', message: 'PRIVATE_DETAIL' },
    }),
    list: async () => {
      throw Error('must not list');
    },
  };
  await assert.rejects(
    h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()),
    (error) => error.code === 'asset-unavailable' && !error.message.includes('PRIVATE_'),
  );
});

test('team catalog: mixed source actor and repeated cursors are refused rather than following another catalog', async (t) => {
  const h = await setup(t);
  const libraries = () => ({
    ok: true,
    value: {
      actorId: 'ann',
      spaceId: 'north',
      libraries: [{ id: 'north', spaceId: 'north', kind: 'team', name: 'north', canCreate: true }],
    },
  });
  let calls = 0;
  h.sources.knowledge = {
    libraries: async () => libraries(),
    list: async () => ({
      ok: true,
      value: {
        actorId: ++calls === 1 ? 'dana' : 'ann',
        spaceId: 'north',
        libraryId: 'north',
        pages: [],
        nextCursor: 'repeat',
      },
    }),
  };
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
  calls = 0;
  h.sources.knowledge = {
    libraries: async () => libraries(),
    list: async () => {
      calls++;
      return {
        ok: true,
        value: {
          actorId: 'ann',
          spaceId: 'north',
          libraryId: 'north',
          pages: [],
          nextCursor: 'repeat',
        },
      };
    },
  };
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
  assert.equal(calls, 2);
});

test('team catalog: asset mutation during the original metadata calls cannot be returned as an unchanged projection', async (t) => {
  let h;
  h = await setup(t, { sources: async () => h.change() });
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
});

test('team catalog: Host replacement drops late results and close waits a genuinely pending source call', async (t) => {
  const entered = deferred(),
    pending = deferred();
  const h = await setup(t, {
    sources: async () => {
      entered.resolve();
      await pending.promise;
    },
  });
  const reading = h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal());
  await entered.promise;
  h.replace();
  let closed = false;
  const closing = h.catalog.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  pending.resolve();
  await assert.rejects(reading, { code: 'asset-unavailable' });
  await closing;
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
  assert.deepEqual(h.stats(), { writes: 0, bodies: 0 });
});

test('team catalog: replacing a service on a reused Host cohort object still drops the late prior owner', async (t) => {
  let h;
  h = await setup(t, {
    sources: async () => {
      h.sources.knowledge = {};
    },
  });
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
});

test('team catalog: original membership revocation during metadata collection refuses the remaining reads', async (t) => {
  let h;
  h = await setup(t, {
    sources: async () => {
      await h.revoke('north', 'ann');
    },
  });
  await assert.rejects(h.catalog.list(h.requests.ann, { spaceId: 'north' }, signal()), {
    code: 'asset-unavailable',
  });
  assert.deepEqual(h.stats(), { writes: 0, bodies: 0 });
});
