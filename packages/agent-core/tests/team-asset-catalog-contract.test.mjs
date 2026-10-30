import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  projectTeamAssetCatalog as project,
  TeamAssetCatalogValueSchema,
  teamAssetCatalogRowKey,
} from '../dist/team-asset-catalog-contract.js';

const spaceId = 'north',
  actorId = 'ann';
const reference = (id, kind, number = 1) => ({
  spaceId,
  assetId: id,
  kind,
  versionId: randomUUID(),
  sha256: String(number).repeat(64),
});
function asset(id, kind, name = id) {
  return {
    spaceId,
    assetId: id,
    kind,
    name,
    description: 'Team metadata',
    ownerId: actorId,
    maintainerIds: [actorId],
    version: 4,
    canMaintain: true,
    canPublish: true,
    hasDraft: true,
    versions: [1, 2].map((number) => ({
      reference: reference(id, kind, number),
      number,
      publishedBy: actorId,
      publishedAt: '2026-10-30T00:00:00Z',
    })),
  };
}
const page = (id) => ({
  reference: { spaceId, libraryId: spaceId, pageId: id, version: 2, checksum: 'a'.repeat(64) },
  title: 'Original online guide',
  format: 'markdown',
  ownerActorId: actorId,
  pageRevision: 5,
  bytes: 10,
  publishedAt: '2026-10-30T00:00:00Z',
});
const assets = (items) => ({ actorId, spaceId, items });
const knowledge = (pages = [], nextCursor = null) => ({
  actorId,
  spaceId,
  libraryId: spaceId,
  pages,
  nextCursor,
});

const legacy = (items = []) => ({ actorId, spaceId, items });
const projectTeamAssetCatalog = (query, assets, pages, sources = legacy()) =>
  project(query, assets, pages, sources);
const builtin = (id, kind = 'template') => ({
  source: {
    kind: 'builtin',
    spaceId,
    assetId: id,
    assetKind: kind,
    sourceCommit: '133276e2014bf1bcbd8410bab7bb339c929de46d',
    sha256: 'd'.repeat(64),
  },
  kind,
  name: id,
  description: 'Original fixed source',
  available: true,
  readOnly: true,
  canCopy: true,
});

test('catalog projection: four asset kinds plus original online page use explicit source identities and logical item counts', () => {
  const original = assets(
    ['file', 'template', 'expert', 'skill'].map((kind) => asset('same-' + kind, kind)),
  );
  const source = knowledge([page('same-file')]),
    before = JSON.stringify({ original, source });
  const value = projectTeamAssetCatalog({ spaceId }, original, [source]);
  assert.deepEqual(value.counts, { all: 5, material: 2, template: 1, expert: 1, skill: 1 });
  assert.equal(value.total, 5);
  assert.equal(value.countUnit, 'items');
  const doc = value.items.find((row) => row.source === 'knowledge');
  assert.deepEqual(doc.page.reference, source.pages[0].reference);
  assert.notEqual(
    teamAssetCatalogRowKey(doc),
    teamAssetCatalogRowKey(
      value.items.find((row) => row.source === 'asset' && row.asset.kind === 'file'),
    ),
  );
  assert.equal(
    JSON.stringify({ original, source }),
    before,
    'source versions and references remain untouched',
  );
  value.items[0].category = 'expert';
  assert.equal(JSON.stringify({ original, source }), before, 'returned rows are copies');
});

test('catalog projection: NFKC/case metadata search, category and pagination share one count basis', () => {
  const source = assets([
    asset('a', 'skill', 'ＦＯＯ guide'),
    asset('b', 'template', 'foo Guide'),
    asset('c', 'file', 'another'),
  ]);
  const value = projectTeamAssetCatalog(
    { spaceId, search: '  Foo　GUIDE  ', category: 'all', limit: 1 },
    source,
    [knowledge()],
  );
  assert.deepEqual(value.counts, { all: 2, material: 0, template: 1, expert: 0, skill: 1 });
  assert.equal(value.items.length, 1);
  assert.equal(value.nextOffset, 1);
  const next = projectTeamAssetCatalog(
    { spaceId, search: value.search, offset: value.nextOffset, limit: 1 },
    source,
    [knowledge()],
  );
  assert.equal(next.nextOffset, null);
  assert.notEqual(teamAssetCatalogRowKey(next.items[0]), teamAssetCatalogRowKey(value.items[0]));
  const category = projectTeamAssetCatalog(
    { spaceId, search: value.search, category: 'skill' },
    source,
    [knowledge()],
  );
  assert.deepEqual(category.counts, value.counts);
  assert.equal(category.total, 1);
  assert.equal(category.items[0].asset.kind, 'skill');
});

test('catalog projection: original complete knowledge pagination is required; unknown source is never zero success', () => {
  const first = knowledge([page('one')], 'cursor-1'),
    last = knowledge([page('two')]);
  assert.equal(projectTeamAssetCatalog({ spaceId }, assets([]), [first, last]).counts.material, 2);
  for (const pages of [[], [first], [last, last], [first, first, last]])
    assert.throws(() => projectTeamAssetCatalog({ spaceId }, assets([]), pages), {
      code: 'asset-unavailable',
    });
});

test('catalog projection: mixed actor/space/library and duplicate logical source rows refuse instead of filtering', () => {
  const original = assets([asset('one', 'skill')]);
  for (const bad of [
    { ...knowledge(), actorId: 'bob' },
    { ...knowledge(), spaceId: 'south' },
    { ...knowledge(), libraryId: 'south' },
    knowledge([{ ...page('one'), reference: { ...page('one').reference, spaceId: 'south' } }]),
    knowledge([
      page('one'),
      { ...page('one'), reference: { ...page('one').reference, version: 3 } },
    ]),
  ])
    assert.throws(() => projectTeamAssetCatalog({ spaceId }, original, [bad]), {
      code: 'asset-unavailable',
    });
  assert.throws(
    () =>
      projectTeamAssetCatalog(
        { spaceId },
        assets([asset('dup', 'skill'), asset('dup', 'expert')]),
        [knowledge()],
      ),
    { code: 'asset-unavailable' },
  );
  assert.throws(
    () => projectTeamAssetCatalog({ spaceId }, { ...original, spaceId: 'south' }, [knowledge()]),
    { code: 'asset-unavailable' },
  );
});

test('catalog projection: portable reply rejects forged counts/categories or accidental body/private fields', () => {
  const value = projectTeamAssetCatalog({ spaceId }, assets([asset('one', 'file')]), [
    knowledge([page('guide')]),
  ]);
  for (const patch of [
    { counts: { ...value.counts, all: 99 } },
    { nextOffset: 1 },
    { items: value.items.map((row) => ({ ...row, category: 'skill' })) },
    { items: value.items.map((row) => ({ ...row, body: 'not a body transport' })) },
  ])
    assert.equal(TeamAssetCatalogValueSchema.safeParse({ ...value, ...patch }).success, false);
  assert.throws(
    () => projectTeamAssetCatalog({ spaceId, actorId: 'forged' }, assets([]), [knowledge()]),
    { code: 'asset-invalid' },
  );
});

test('catalog projection: original builtins/source pins are explicit, unknown never gains owner/version/copy rights', () => {
  const source = builtin('baseline-workflow');
  const unknown = {
    ...builtin('old-skill', 'skill'),
    canCopy: false,
    source: {
      kind: 'unknown',
      spaceId,
      assetId: 'old-skill',
      assetKind: 'skill',
      sha256: 'e'.repeat(64),
    },
  };
  const input = legacy([source, unknown]);
  const before = JSON.stringify(input);
  const value = project(
    { spaceId },
    assets([asset('baseline-workflow', 'template')]),
    [knowledge()],
    input,
  );
  assert.equal(value.counts.all, 3);
  assert.equal(value.counts.template, 2);
  const row = value.items.find((row) => row.source === 'builtin');
  assert.deepEqual(row.legacy.source, source.source);
  assert.equal('ownerId' in row.legacy, false);
  assert.equal('versionId' in row.legacy.source, false);
  assert.equal(value.items.find((row) => row.source === 'unknown').legacy.canCopy, false);
  assert.notEqual(
    teamAssetCatalogRowKey(row),
    teamAssetCatalogRowKey(value.items.find((row) => row.source === 'asset')),
  );
  row.legacy.source.sha256 = '0'.repeat(64);
  assert.equal(JSON.stringify(input), before);
});

test('catalog projection: missing/mixed/duplicate legacy source fails; public source discriminator must match its real pin', () => {
  const source = builtin('same');
  for (const bad of [
    undefined,
    { ...legacy(), actorId: 'bob' },
    { ...legacy(), spaceId: 'south' },
    legacy([source, { ...source, source: { ...source.source, sha256: 'f'.repeat(64) } }]),
    legacy([{ ...source, source: { ...source.source, spaceId: 'south' } }]),
  ])
    assert.throws(() => project({ spaceId }, assets([]), [knowledge()], bad), {
      code: 'asset-unavailable',
    });
  const value = project({ spaceId }, assets([]), [knowledge()], legacy([source]));
  assert.equal(
    TeamAssetCatalogValueSchema.safeParse({
      ...value,
      items: [{ ...value.items[0], source: 'unknown' }],
    }).success,
    false,
  );
});
