/** Original knowledge Service/lease/directory/DSH JSON and attachments.
 * The original Workbench read injection is a contract; no GUI, Node/Run or model proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import {
  emptyWorkbench,
  canonicalPayload,
  KnowledgeSaveProjectLinksRequestSchema,
} from '@zhuma/agent-core';
import { knowledgeHost, value } from './knowledge-fixture.mjs';
import { knowledgeDomainSpec, knowledgePageKey } from '../dist/knowledge-storage.js';

const target = { spaceId: 'north', projectId: 'project' };
const ref = (page, version = 1) => ({
  spaceId: page.spaceId,
  libraryId: page.libraryId,
  pageId: page.pageId,
  version,
  checksum: page.versions[version - 1].body.checksum,
});
const input = (reference, patch = {}) => ({
  ...target,
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  links: [{ reference, required: true }],
  ...patch,
});
const no = (result, code) => {
  assert.equal(result.ok, false);
  if (code) assert.equal(result.error.code, code);
};
async function setup(t, options = {}) {
  let state = {
    ...emptyWorkbench(),
    projects: [{ id: 'project', name: 'Project', description: '' }],
  };
  const h = await knowledgeHost(t, { ...options, readWorkbench: () => state });
  // The trusted original directory owns mapping, independently from project content.
  const lookup = await h.directory.spaceForProject('project');
  if (!lookup.ok) await h.directory.assignProjectSpace('project', 'north');
  return {
    ...h,
    setWorkbench: (next) => {
      state = next(state);
    },
    domain: h.ctx.storageDomain.get('zhuma_knowledge'),
    disk: () => readFile(join(h.root, 'zhuma_knowledge.json'), 'utf8'),
    read: (request = h.requests.ann) => h.service.projectLinks(request, target),
    save: (body, request = h.requests.ann) => h.service.saveProjectLinks(request, body),
  };
}

test('project knowledge: old project defaults empty, reads/snapshot do not upgrade or read body bytes', async (t) => {
  const h = await setup(t);
  await h.seed();
  const before = await h.disk();
  h.service.bytes.read = () => assert.fail('Metadata cannot read bodies');
  const found = value(await h.read());
  assert.equal(found.actorId, 'ann');
  assert.equal(found.relationshipVersion, 0);
  assert.deepEqual(found.links, []);
  assert.deepEqual(value(await h.service.projectSnapshot(h.requests.ann, target)), found.snapshot);
  const { checksum, ...unsigned } = found.snapshot;
  assert.equal(checksum, createHash('sha256').update(canonicalPayload(unsigned)).digest('hex'));
  assert.equal(h.domain.global.get().schemaVersion, 1);
  assert.equal(await h.disk(), before);
});

test('project knowledge: fixed refs, required/optional, same-key replay and CAS are shared by actual team members', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    request = input(ref(page));
  assert.equal(value(await h.save(request)).relationshipVersion, 1);
  const before = await h.disk();
  assert.equal(value(await h.save(request)).disposition, 'replayed');
  assert.equal(await h.disk(), before);
  no(await h.save({ ...request, links: [{ reference: ref(page), required: false }] }), 'conflict');
  no(await h.save({ ...request, idempotencyKey: randomUUID() }), 'conflict');
  const result = value(await h.read(h.requests.bob));
  assert.equal(result.actorId, 'bob');
  assert.equal(result.links[0].required, true);
  assert.deepEqual(result.snapshot.links, request.links);
  result.links[0].reference.checksum = '0'.repeat(64);
  assert.deepEqual(value(await h.read()).snapshot.links, request.links);
  const next = value(
    await h.save(input(ref(page), { expectedVersion: 1, links: [] }), h.requests.bob),
  );
  assert.equal(next.relationshipVersion, 2);
  assert.deepEqual(value(await h.read()).links, []);
  assert.equal(
    value(await h.save(request)).relationshipVersion,
    1,
    'replay retains the old receipt, not a latest alias',
  );
});

test('project knowledge: published updates only advertise availability and never replace frozen sources', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    original = input(ref(page));
  value(await h.save(original));
  const frozen = value(await h.read()).snapshot;
  value(
    await h.service.saveDraft(h.requests.ann, {
      spaceId: 'north',
      libraryId: 'north',
      pageId: page.pageId,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
      content: { title: 'Updated', format: 'markdown', text: 'Version two', sources: [] },
    }),
  );
  const published = value(
    await h.service.publish(h.requests.ann, {
      spaceId: 'north',
      libraryId: 'north',
      pageId: page.pageId,
      expectedVersion: 2,
      idempotencyKey: randomUUID(),
    }),
  );
  const current = value(await h.read());
  assert(current.links[0].hasUpdate);
  assert.deepEqual(current.snapshot, frozen);
  assert.deepEqual(current.links[0].reference, original.links[0].reference);
  assert.equal(current.links[0].title, page.versions[0].title);
  value(await h.save(input(published.reference, { expectedVersion: 1 })));
  assert.equal(value(await h.read()).links[0].reference.version, 2);
  assert.notDeepEqual(value(await h.read()).snapshot, frozen);
});

test('project knowledge: foreign/unknown projects, cross-space private refs, bad versions, dependencies and duplicate pages never grant access', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    personal = await h.seed({ spaceId: 'personal-ann' });
  const before = await h.disk();
  no(
    await h.service.projectLinks(h.requests.ann, { ...target, projectId: 'missing' }),
    'not-found',
  );
  no(
    await h.service.projectLinks(h.requests.cy, { spaceId: 'south', projectId: 'project' }),
    'not-found',
  );
  no(await h.save(input(ref(personal))), 'not-found');
  no(await h.save(input({ ...ref(page), version: 99 })), 'not-found');
  no(await h.save(input({ ...ref(page), checksum: '0'.repeat(64) })), 'not-found');
  const duplicate = input(ref(page), {
    links: [input(ref(page)).links[0], { reference: ref(page), required: false }],
  });
  assert.equal(KnowledgeSaveProjectLinksRequestSchema.safeParse(duplicate).success, false);
  no(await h.save(duplicate), 'invalid');
  no(await h.save({ ...input(ref(page)), actorId: 'ann' }), 'invalid');
  no(await h.read(h.requests.dana));
  assert.equal(h.domain.global.get().schemaVersion, 1);
  assert.equal(await h.disk(), before);
});

test('project knowledge: concurrent CAS writes accept only one intent; same-key concurrency is one relation', async (t) => {
  const h = await setup(t),
    page = await h.seed();
  const request = input(ref(page));
  const results = await Promise.all([h.save(request), h.save(request)]);
  assert.deepEqual(results.map((r) => value(r).disposition).sort(), ['replayed', 'saved']);
  const raced = await Promise.all([
    h.save(input(ref(page), { expectedVersion: 1 })),
    h.save(input(ref(page), { expectedVersion: 1 })),
  ]);
  assert.equal(raced.filter((r) => r.ok).length, 1);
  assert.equal(raced.find((r) => !r.ok).error.code, 'conflict');
  assert.equal(value(await h.read()).relationshipVersion, 2);
  assert.equal([...h.domain.table('project_links').entries()].length, 1);
});

test('project knowledge: a failed format barrier or relation write is retryable with the unchanged original intent', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    request = input(ref(page));
  const before = await h.disk(),
    oldPages = JSON.stringify(JSON.parse(before).tables.pages);
  const set = h.domain.global.set.bind(h.domain.global);
  h.domain.global.set = async () => {
    throw Error('FORMAT_WRITE_FAILED');
  };
  no(await h.save(request), 'unavailable');
  assert.equal(await h.disk(), before);
  h.domain.global.set = set;
  const table = h.domain.table('project_links'),
    put = table.put.bind(table);
  table.put = async () => {
    throw Error('RELATION_WRITE_FAILED');
  };
  no(await h.save(request), 'unavailable');
  assert.equal(h.domain.global.get().schemaVersion, 2);
  assert.equal(table.size, 0);
  assert.equal(JSON.stringify(JSON.parse(await h.disk()).tables.pages), oldPages);
  table.put = put;
  assert.equal(value(await h.save(request)).relationshipVersion, 1);
  assert.equal(value(await h.save(request)).disposition, 'replayed');
  assert.equal(JSON.stringify(JSON.parse(await h.disk()).tables.pages), oldPages);
});

test('project knowledge: old writer is refused before any write after protected association; cold reopen preserves original refs/pages', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    request = input(ref(page));
  value(await h.save(request));
  const before = await h.disk(),
    snapshot = value(await h.read()).snapshot;
  await h.service.close();
  const old = defineDomain({
    ...knowledgeDomainSpec,
    global: {
      schema: z.strictObject({ schemaVersion: z.literal(1) }),
      initial: { schemaVersion: 1 },
    },
    tables: { pages: knowledgeDomainSpec.tables.pages },
  });
  await assert.rejects(h.ctx.storageDomain.open(old), (error) => error.code === 'invalid-record');
  assert.equal(await h.disk(), before);
  await h.close();
  const reopened = await setup(t, { root: h.root });
  assert.deepEqual(value(await reopened.read()).snapshot, snapshot);
  assert.equal(value(await reopened.save(request)).disposition, 'replayed');
  assert.equal(await reopened.disk(), before);
});

test('project knowledge: revocation/deletion while lookup yields prevents relation writes and returns no partial source facts', async (t) => {
  const h = await setup(t),
    page = await h.seed(),
    request = input(ref(page));
  const lookup = h.directory.spaceForProject.bind(h.directory);
  let calls = 0;
  h.directory.spaceForProject = async (id) => {
    if (++calls === 2) await h.revoke('north', 'ann');
    return lookup(id);
  };
  no(await h.save(request));
  assert.equal(h.domain.table('project_links').size, 0);
  assert.equal(
    h.domain.global.get().schemaVersion,
    2,
    'safe format upgrade may precede a revoked relation',
  );
  h.directory.spaceForProject = lookup;
  await h.directory.grantMembership('north', 'ann');
  value(await h.save(request));
  let scans = 0;
  h.directory.spaceForProject = async (id) => {
    if (++scans === 2) h.setWorkbench((state) => ({ ...state, projects: [] }));
    return lookup(id);
  };
  const before = await h.disk();
  no(await h.read(), 'not-found');
  assert.equal(await h.disk(), before);
});

test('project knowledge: unavailable Workbench/retired directory and removed sources never become an authorized empty', async (t) => {
  const absent = await knowledgeHost(t);
  no(await absent.service.projectLinks(absent.requests.ann, target), 'unavailable');
  const h = await setup(t),
    page = await h.seed();
  value(await h.save(input(ref(page))));
  await h.domain.table('pages').delete(knowledgePageKey('north', page.pageId));
  const before = await h.disk();
  no(await h.read(), 'not-found');
  assert.equal(await h.disk(), before);
  await h.replaceDirectory();
  no(await h.read());
});

test('project knowledge: missing transitive sources reject association and later reads without expanding the reference scope', async (t) => {
  const h = await setup(t),
    source = await h.seed({ pageId: 'source' });
  const page = await h.seed({ pageId: 'derived', sources: [ref(source)] });
  value(await h.save(input(ref(page))));
  await h.domain.table('pages').delete(knowledgePageKey('north', source.pageId));
  const before = await h.disk();
  no(await h.read(), 'not-found');
  no(await h.save(input(ref(page), { expectedVersion: 1 })), 'not-found');
  assert.equal(await h.disk(), before);
});
