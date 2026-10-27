import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError } from '@zhuma/agent-core';
import { decideProjectSpace } from '../dist/project-space.js';
import { PROJECT_SPACE_LIMIT } from '../dist/project-space.js';
import {
  SPACE_DIRECTORY_MEMBERSHIP_LIMIT,
  SPACE_DIRECTORY_SPACE_LIMIT,
  openSpaceDirectory,
} from '../dist/space-directory.js';

function memoryKv(media = new Map(), faults = {}) {
  return {
    media,
    async open(descriptor) {
      let medium = media.get(descriptor.name);
      if (medium === undefined) {
        medium = { tables: new Map(), global: null };
        media.set(descriptor.name, medium);
      }
      let closed = false;
      return {
        async loadAll() {
          if (closed) throw new Error('closed');
          const tables = {};
          for (const table of descriptor.tables) {
            tables[table] = Object.fromEntries(medium.tables.get(table) ?? []);
          }
          return { tables, global: medium.global };
        },
        async putRecord(table, key, value) {
          if (closed) throw new Error('closed');
          if (typeof faults.beforePut === 'function') await faults.beforePut(table, key);
          if (typeof faults.put === 'function') {
            const error = await faults.put(table, key);
            if (error !== undefined) throw error;
          }
          const records = medium.tables.get(table) ?? new Map();
          medium.tables.set(table, records);
          records.set(key, structuredClone(value));
        },
        async deleteRecord(table, key) {
          if (closed) throw new Error('closed');
          medium.tables.get(table)?.delete(key);
        },
        async setGlobal(value) {
          if (closed) throw new Error('closed');
          medium.global = structuredClone(value);
        },
        async close() {
          closed = true;
          if (typeof faults.close === 'function') await faults.close();
        },
      };
    },
  };
}

function mount(shared = {}) {
  const ctx = new Context();
  const kv = memoryKv(shared.media, shared.faults);
  ctx.provide('storage', {
    backend: {
      get(name) {
        if (name !== 'memory') throw new Error(`unknown backend ${name}`);
        return { kv, close: async () => {} };
      },
    },
  });
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory', routes: {} }));
  return { ctx, media: kv.media };
}

const FIXTURE = {
  spaces: [
    { id: 'personal-lin', kind: 'personal', name: '林的个人空间' },
    { id: 'personal-zhao', kind: 'personal', name: '赵的个人空间' },
    { id: 'team-north', kind: 'team', name: '北队' },
    { id: 'team-empty', kind: 'team', name: '空团队' },
  ],
  memberships: [
    { spaceId: 'personal-lin', accountId: 'lin' },
    { spaceId: 'personal-zhao', accountId: 'zhao' },
    { spaceId: 'team-north', accountId: 'lin' },
    { spaceId: 'team-north', accountId: 'zhao' },
    { spaceId: 'team-empty', accountId: 'lin' },
  ],
  projectSpaces: [{ projectId: 'portal', spaceId: 'team-north' }],
};

test('first configuration contract: the original opened directory has passive status and one resumable canonical import', async () => {
  const { ctx, media } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain);
  const before = structuredClone(media.get('zhuma_spaces'));
  assert.deepEqual(directory.initializationStatus(), { kind: 'unconfigured' });
  assert.deepEqual(media.get('zhuma_spaces'), before);
  const receipt = await directory.initializeImport(FIXTURE);
  assert.equal(receipt.kind, 'initialized');
  assert.deepEqual(directory.initializationStatus(), {
    kind: 'configured',
    fingerprint: receipt.fingerprint,
  });
  assert.deepEqual(await directory.initializeImport(FIXTURE), receipt);
  assert.equal(directory.isMember('team-north', 'lin'), true);
  await assert.rejects(directory.initializeImport({ ...FIXTURE, memberships: [] }), {
    code: 'conflict',
  });
  await directory.close();
});

test('first configuration contract: failed import is visible only to explicit pending initialization and resumes in the same original domain', async () => {
  const media = new Map();
  let calls = 0;
  const { ctx } = mount({
    media,
    faults: { put: () => (++calls === 2 ? Error('isolated put failure') : undefined) },
  });
  const first = await openSpaceDirectory(ctx.storageDomain);
  await assert.rejects(first.initializeImport(FIXTURE));
  assert.equal(first.initializationStatus().kind, 'pending');
  for (const read of [
    () => first.spaces(),
    () => first.space('personal-lin'),
    () => first.isMember('personal-lin', 'lin'),
    () => first.spacesForMember('lin'),
  ])
    assert.throws(read, { code: 'unavailable' });
  assert.deepEqual(first.spaceForProjectNow('portal'), { ok: false, reason: 'unavailable' });
  for (const write of [
    () => first.createSpace({ id: 'other', kind: 'team', name: 'Other' }),
    () => first.grantMembership('personal-lin', 'lin'),
    () => first.revokeMembership('personal-lin', 'lin'),
    () => first.assignProjectSpace('other', 'personal-lin'),
  ])
    await assert.rejects(write(), { code: 'unavailable' });
  await first.close();
  await assert.rejects(openSpaceDirectory(mount({ media }).ctx.storageDomain));
  const second = await openSpaceDirectory(mount({ media }).ctx.storageDomain, undefined, {
    allowPendingInitialization: true,
  });
  assert.equal(second.initializationStatus().kind, 'pending');
  await second.initializeImport(FIXTURE);
  assert.equal(second.isMember('team-north', 'lin'), true);
  await second.close();
});

test('first configuration contract: import initialization refuses writer facts and never recreates a revoked completed membership', async () => {
  const { ctx } = mount();
  const writer = await openSpaceDirectory(ctx.storageDomain);
  await writer.createSpace({ id: 'existing', kind: 'team', name: 'Existing' });
  assert.equal(writer.initializationStatus().kind, 'recovery-required');
  await assert.rejects(writer.initializeImport(FIXTURE), { code: 'conflict' });
  assert.deepEqual(
    writer.spaces().map((item) => item.id),
    ['existing'],
  );
  await writer.close();
  const complete = await openSpaceDirectory(mount().ctx.storageDomain);
  await complete.initializeImport(FIXTURE);
  await complete.revokeMembership('team-north', 'lin');
  await assert.rejects(complete.initializeImport(FIXTURE), { code: 'conflict' });
  assert.equal(complete.isMember('team-north', 'lin'), false);
  await complete.close();
});

test('first configuration contract: unknown rows inside a marked partial cannot be accepted as part of the matching seed', async () => {
  const media = new Map();
  let count = 0;
  const first = await openSpaceDirectory(
    mount({ media, faults: { put: () => (++count === 2 ? Error('isolated failure') : undefined) } })
      .ctx.storageDomain,
  );
  await assert.rejects(first.initializeImport(FIXTURE));
  await first.close();
  media
    .get('zhuma_spaces')
    .tables.get('spaces')
    .set('unrelated', { id: 'unrelated', kind: 'team', name: 'Unknown' });
  const second = await openSpaceDirectory(mount({ media }).ctx.storageDomain, undefined, {
    allowPendingInitialization: true,
  });
  const before = structuredClone(media.get('zhuma_spaces'));
  await assert.rejects(second.initializeImport(FIXTURE), { code: 'conflict' });
  assert.deepEqual(media.get('zhuma_spaces'), before);
  assert.throws(() => second.spacesForMember('lin'), { code: 'unavailable' });
  await second.close();
});

test('an import seeds an empty directory and members can enumerate spaces, including empty ones', async () => {
  const { ctx } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);

  const linSpaces = directory.spacesForMember('lin');
  assert.deepEqual(
    linSpaces.map((space) => space.id),
    ['personal-lin', 'team-empty', 'team-north'],
  );
  assert.equal(linSpaces.find((space) => space.id === 'team-empty')?.kind, 'team');
  assert.deepEqual(
    directory.spacesForMember('zhao').map((space) => space.id),
    ['personal-zhao', 'team-north'],
  );
  assert.deepEqual(directory.spacesForMember('chen'), []);
  assert.equal(directory.isMember('team-north', 'zhao'), true);
  assert.equal(directory.isMember('team-north', 'chen'), false);
  assert.equal(directory.isMember('missing', 'lin'), false);

  await directory.close();
});

test('a project can belong to a space with a different id and the lookup feeds decisions', async () => {
  const { ctx } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);

  assert.deepEqual(await directory.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
  assert.equal(
    decideProjectSpace(
      await directory.spaceForProject('portal'),
      directory.spacesForMember('lin').map((s) => s.id),
    ),
    'ok',
  );
  assert.equal(
    decideProjectSpace(await directory.spaceForProject('portal'), ['team-south']),
    'hidden',
  );
  assert.deepEqual(await directory.spaceForProject('missing'), { ok: false, reason: 'unknown' });
  // A project id is never tried as a space id, even when the two collide in shape.
  assert.deepEqual(await directory.spaceForProject('team-north'), {
    ok: false,
    reason: 'unknown',
  });

  await directory.close();
});

test('an occupied directory is never overwritten by a later import', async () => {
  const shared = mount();
  const first = await openSpaceDirectory(shared.ctx.storageDomain, FIXTURE);
  await first.close();

  const second = await openSpaceDirectory(shared.ctx.storageDomain, {
    spaces: [{ id: 'intruder', kind: 'team', name: '外来空间' }],
    memberships: [{ spaceId: 'intruder', accountId: 'mallory' }],
    projectSpaces: [{ projectId: 'portal', spaceId: 'intruder' }],
  });
  assert.equal(second.space('intruder'), undefined);
  assert.deepEqual(await second.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
  assert.deepEqual(second.spacesForMember('mallory'), []);
  await second.close();
});

test('facts survive a reopen on the same medium', async () => {
  const media = new Map();
  const firstMount = mount({ media });
  const first = await openSpaceDirectory(firstMount.ctx.storageDomain, FIXTURE);
  await first.close();
  assert.deepEqual(first.spaceForProjectNow('portal'), { ok: false, reason: 'unavailable' });

  const secondMount = mount({ media });
  const second = await openSpaceDirectory(secondMount.ctx.storageDomain);
  assert.deepEqual(
    second.spacesForMember('lin').map((space) => space.id),
    ['personal-lin', 'team-empty', 'team-north'],
  );
  assert.deepEqual(await second.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
  assert.deepEqual(second.spaceForProjectNow('portal'), { ok: true, spaceId: 'team-north' });
  await second.close();
});

test('a revoked membership stops being visible and authorized at once', async () => {
  const { ctx } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);

  await directory.revokeMembership('team-north', 'zhao');
  assert.equal(directory.isMember('team-north', 'zhao'), false);
  assert.deepEqual(
    directory.spacesForMember('zhao').map((space) => space.id),
    ['personal-zhao'],
  );
  // The project stays assigned to the space; the ex-member's decision is now hidden.
  assert.equal(
    decideProjectSpace(
      await directory.spaceForProject('portal'),
      directory.spacesForMember('zhao').map((s) => s.id),
    ),
    'hidden',
  );
  // Revocation is idempotent.
  await directory.revokeMembership('team-north', 'zhao');
  await directory.close();
});

test('a revoked membership stays revoked across a reopen', async () => {
  const media = new Map();
  const firstMount = mount({ media });
  const first = await openSpaceDirectory(firstMount.ctx.storageDomain, FIXTURE);
  await first.revokeMembership('team-empty', 'lin');
  await first.close();

  const secondMount = mount({ media });
  const second = await openSpaceDirectory(secondMount.ctx.storageDomain);
  assert.deepEqual(
    second.spacesForMember('lin').map((space) => space.id),
    ['personal-lin', 'team-north'],
  );
  await second.close();
});

test('writer rules: conflicts, unknown references, and caps are refused', async () => {
  const { ctx } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);

  await assert.rejects(
    directory.createSpace({ id: 'team-north', kind: 'team', name: '重复' }),
    (error) => error instanceof WorkbenchError && error.code === 'conflict',
  );
  await assert.rejects(
    directory.grantMembership('missing', 'lin'),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
  await assert.rejects(
    directory.assignProjectSpace('portal', 'team-empty'),
    (error) => error instanceof WorkbenchError && error.code === 'conflict',
  );
  await assert.rejects(
    directory.assignProjectSpace('new-project', 'missing'),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
  await assert.rejects(
    directory.createSpace({ id: 'bad id', kind: 'team', name: '非法' }),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );

  // Granting twice is idempotent; the new facts are readable right away.
  await directory.createSpace({ id: 'team-south', kind: 'team', name: '南队' });
  await directory.grantMembership('team-south', 'chen');
  await directory.grantMembership('team-south', 'chen');
  await directory.assignProjectSpace('new-project', 'team-south');
  assert.equal(directory.isMember('team-south', 'chen'), true);
  assert.deepEqual(await directory.spaceForProject('new-project'), {
    ok: true,
    spaceId: 'team-south',
  });
  await directory.close();
});

test('import validation: oversize, duplicates, unknown references, and bad ids are refused', async () => {
  const tooManySpaces = {
    spaces: Array.from({ length: SPACE_DIRECTORY_SPACE_LIMIT + 1 }, (_, index) => ({
      id: `s${index}`,
      kind: 'team',
      name: `s${index}`,
    })),
  };
  {
    const { ctx } = mount();
    await assert.rejects(openSpaceDirectory(ctx.storageDomain, tooManySpaces), WorkbenchError);
  }
  {
    const { ctx } = mount();
    await assert.rejects(
      openSpaceDirectory(ctx.storageDomain, {
        spaces: [
          { id: 'dup', kind: 'team', name: 'a' },
          { id: 'dup', kind: 'team', name: 'b' },
        ],
      }),
      WorkbenchError,
    );
  }
  {
    const { ctx } = mount();
    await assert.rejects(
      openSpaceDirectory(ctx.storageDomain, {
        spaces: [{ id: 'team-north', kind: 'team', name: '北队' }],
        memberships: [{ spaceId: 'missing', accountId: 'lin' }],
      }),
      WorkbenchError,
    );
  }
  {
    const { ctx } = mount();
    await assert.rejects(
      openSpaceDirectory(ctx.storageDomain, {
        spaces: [{ id: 'team-north', kind: 'team', name: '北队' }],
        projectSpaces: [{ projectId: 'portal', spaceId: 'missing' }],
      }),
      WorkbenchError,
    );
  }
  {
    const { ctx } = mount();
    await assert.rejects(
      openSpaceDirectory(ctx.storageDomain, {
        spaces: [{ id: 'team-north', kind: 'team', name: '北队' }],
        memberships: [
          { spaceId: 'team-north', accountId: 'lin' },
          { spaceId: 'team-north', accountId: 'lin' },
        ],
      }),
      WorkbenchError,
    );
  }
  {
    // identical duplicate assignments collapse, conflicting ones reject
    const { ctx } = mount();
    const directory = await openSpaceDirectory(ctx.storageDomain, {
      spaces: [{ id: 'team-north', kind: 'team', name: '北队' }],
      projectSpaces: [
        { projectId: 'portal', spaceId: 'team-north' },
        { projectId: 'portal', spaceId: 'team-north' },
      ],
    });
    assert.deepEqual(await directory.spaceForProject('portal'), {
      ok: true,
      spaceId: 'team-north',
    });
    await directory.close();
  }
  {
    const { ctx } = mount();
    await assert.rejects(
      openSpaceDirectory(ctx.storageDomain, {
        spaces: [
          { id: 'team-north', kind: 'team', name: '北队' },
          { id: 'team-south', kind: 'team', name: '南队' },
        ],
        projectSpaces: [
          { projectId: 'portal', spaceId: 'team-north' },
          { projectId: 'portal', spaceId: 'team-south' },
        ],
      }),
      WorkbenchError,
    );
  }
});

test('a mid-import failure leaves the domain retryable from the same import', async () => {
  const media = new Map();
  let failNextSpacesWrite = true;
  const faults = {
    async put(table) {
      if (failNextSpacesWrite && table === 'spaces') {
        failNextSpacesWrite = false;
        return new Error('injected write failure');
      }
      return undefined;
    },
  };
  const firstMount = mount({ media, faults });
  await assert.rejects(openSpaceDirectory(firstMount.ctx.storageDomain, FIXTURE));

  const secondMount = mount({ media });
  const second = await openSpaceDirectory(secondMount.ctx.storageDomain, FIXTURE);
  assert.deepEqual(
    second.spacesForMember('lin').map((space) => space.id),
    ['personal-lin', 'team-empty', 'team-north'],
  );
  assert.deepEqual(await second.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
  await second.close();
});

test('a closed directory reports the project lookup as unavailable, never as hidden', async () => {
  const { ctx } = mount();
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);
  await directory.close();

  assert.deepEqual(await directory.spaceForProject('portal'), { ok: false, reason: 'unavailable' });
  assert.equal(
    decideProjectSpace(await directory.spaceForProject('portal'), ['team-north']),
    'unavailable',
  );
});

function workbenchCode(code) {
  return (error) => error instanceof WorkbenchError && error.code === code;
}

const pausePut = {
  async beforePut() {
    await new Promise((resolve) => setImmediate(resolve));
  },
};

test('concurrent first assignment keeps one space and conflicts the other', async () => {
  for (let trial = 0; trial < 5; trial += 1) {
    const { ctx } = mount({ faults: pausePut });
    const directory = await openSpaceDirectory(ctx.storageDomain, {
      spaces: [
        { id: 'north', kind: 'team', name: '北队' },
        { id: 'south', kind: 'team', name: '南队' },
      ],
    });
    const settled = await Promise.allSettled([
      directory.assignProjectSpace('portal', 'north'),
      directory.assignProjectSpace('portal', 'south'),
    ]);
    assert.equal(settled[0].status, 'fulfilled');
    assert.equal(settled[1].status, 'rejected');
    assert.equal(settled[1].reason.code, 'conflict');
    assert.deepEqual(await directory.spaceForProject('portal'), { ok: true, spaceId: 'north' });
    await directory.close();
  }
});

test('concurrent creates and grants cannot pass the directory caps', async () => {
  const { ctx } = mount({ faults: pausePut });
  const directory = await openSpaceDirectory(ctx.storageDomain);
  for (let index = 0; index < SPACE_DIRECTORY_SPACE_LIMIT - 1; index += 1) {
    await directory.createSpace({ id: `s${index}`, kind: 'team', name: `s${index}` });
  }
  const created = await Promise.allSettled([
    directory.createSpace({ id: 'extra-a', kind: 'team', name: '甲' }),
    directory.createSpace({ id: 'extra-b', kind: 'team', name: '乙' }),
  ]);
  assert.equal(created.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(created[0].status, 'fulfilled');
  assert.equal(created[1].status, 'rejected');
  assert.equal(created[1].reason.code, 'validation');
  assert.equal(directory.spaces().length, SPACE_DIRECTORY_SPACE_LIMIT);
  assert.equal(directory.space('extra-b'), undefined);

  for (let index = 0; index < SPACE_DIRECTORY_MEMBERSHIP_LIMIT - 1; index += 1) {
    await directory.grantMembership('extra-a', `m${index}`);
  }
  const granted = await Promise.allSettled([
    directory.grantMembership('extra-a', 'm-extra-a'),
    directory.grantMembership('extra-a', 'm-extra-b'),
  ]);
  assert.equal(granted.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(granted[0].status, 'fulfilled');
  assert.equal(granted[1].status, 'rejected');
  assert.equal(granted[1].reason.code, 'validation');
  assert.equal(directory.isMember('extra-a', 'm-extra-a'), true);
  assert.equal(directory.isMember('extra-a', 'm-extra-b'), false);

  for (let index = 0; index < PROJECT_SPACE_LIMIT - 1; index += 1) {
    await directory.assignProjectSpace(`p${index}`, 'extra-a');
  }
  const assigned = await Promise.allSettled([
    directory.assignProjectSpace('p-extra-a', 'extra-a'),
    directory.assignProjectSpace('p-extra-b', 'extra-a'),
  ]);
  assert.equal(assigned.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(assigned[0].status, 'fulfilled');
  assert.equal(assigned[1].status, 'rejected');
  assert.equal(assigned[1].reason.code, 'validation');
  assert.deepEqual(await directory.spaceForProject('p-extra-a'), { ok: true, spaceId: 'extra-a' });
  assert.deepEqual(await directory.spaceForProject('p-extra-b'), { ok: false, reason: 'unknown' });
  await directory.close();
});

test('concurrent grants of the same membership stay a single row', async () => {
  const { ctx } = mount({ faults: pausePut });
  const directory = await openSpaceDirectory(ctx.storageDomain);
  await directory.createSpace({ id: 'north', kind: 'team', name: '北队' });
  const settled = await Promise.allSettled([
    directory.grantMembership('north', 'lin'),
    directory.grantMembership('north', 'lin'),
  ]);
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(directory.isMember('north', 'lin'), true);
  await directory.close();
});

test('an empty directory can still take its first import after an open with no seed', async () => {
  const media = new Map();
  const first = await openSpaceDirectory(mount({ media }).ctx.storageDomain);
  await first.close();
  const second = await openSpaceDirectory(mount({ media }).ctx.storageDomain, FIXTURE);
  assert.deepEqual(await second.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
  await second.close();
});

test('a writer-occupied directory rejects a different import and keeps its assignment', async () => {
  const media = new Map();
  const writer = await openSpaceDirectory(mount({ media }).ctx.storageDomain);
  await writer.createSpace({ id: 'north', kind: 'team', name: '北队' });
  await writer.grantMembership('north', 'portal-user');
  await writer.assignProjectSpace('portal', 'north');
  await writer.close();

  await assert.rejects(
    openSpaceDirectory(mount({ media }).ctx.storageDomain, {
      spaces: [{ id: 'south', kind: 'team', name: '南队' }],
      memberships: [{ spaceId: 'south', accountId: 'other' }],
      projectSpaces: [{ projectId: 'portal', spaceId: 'south' }],
    }),
    workbenchCode('conflict'),
  );

  const again = await openSpaceDirectory(mount({ media }).ctx.storageDomain);
  assert.deepEqual(await again.spaceForProject('portal'), { ok: true, spaceId: 'north' });
  assert.equal(again.isMember('north', 'portal-user'), true);
  assert.equal(again.space('south'), undefined);
  assert.equal(again.space('north')?.name, '北队');
  await again.close();
});

test('an unfinished import stays closed until the same seed finishes it', async () => {
  const media = new Map();
  let failMembership = true;
  const faults = {
    async put(table) {
      if (failMembership && table === 'memberships') {
        failMembership = false;
        return new Error('injected membership write failure');
      }
      return undefined;
    },
  };
  const seed = {
    spaces: [
      { id: 'north', kind: 'team', name: '北队' },
      { id: 'south', kind: 'team', name: '南队' },
    ],
    memberships: [
      { spaceId: 'north', accountId: 'lin' },
      { spaceId: 'south', accountId: 'zhao' },
    ],
    projectSpaces: [{ projectId: 'portal', spaceId: 'north' }],
  };
  await assert.rejects(openSpaceDirectory(mount({ media, faults }).ctx.storageDomain, seed));
  await assert.rejects(
    openSpaceDirectory(mount({ media }).ctx.storageDomain),
    workbenchCode('validation'),
  );
  await assert.rejects(
    openSpaceDirectory(mount({ media }).ctx.storageDomain, {
      spaces: [{ id: 'other', kind: 'team', name: '别的' }],
    }),
    workbenchCode('validation'),
  );
  assert.equal(media.get('zhuma_spaces').tables.get('spaces')?.has('other'), false);
  assert.equal(media.get('zhuma_spaces').tables.get('spaces')?.has('north'), true);

  const directory = await openSpaceDirectory(mount({ media }).ctx.storageDomain, seed);
  assert.equal(directory.isMember('north', 'lin'), true);
  assert.equal(directory.isMember('south', 'zhao'), true);
  assert.deepEqual(await directory.spaceForProject('portal'), { ok: true, spaceId: 'north' });
  await directory.close();

  const ignored = await openSpaceDirectory(mount({ media }).ctx.storageDomain, {
    spaces: [{ id: 'other', kind: 'team', name: '别的' }],
    projectSpaces: [{ projectId: 'portal', spaceId: 'other' }],
  });
  assert.equal(ignored.space('other'), undefined);
  assert.deepEqual(await ignored.spaceForProject('portal'), { ok: true, spaceId: 'north' });
  await ignored.close();
});

test('an unfinished import with a row that no longer matches its seed fails closed', async () => {
  const media = new Map();
  let failMembership = true;
  const faults = {
    async put(table) {
      if (failMembership && table === 'memberships') {
        failMembership = false;
        return new Error('injected membership write failure');
      }
      return undefined;
    },
  };
  const seed = {
    spaces: [
      { id: 'north', kind: 'team', name: '北队' },
      { id: 'south', kind: 'team', name: '南队' },
    ],
    memberships: [{ spaceId: 'north', accountId: 'lin' }],
    projectSpaces: [{ projectId: 'portal', spaceId: 'north' }],
  };
  await assert.rejects(openSpaceDirectory(mount({ media, faults }).ctx.storageDomain, seed));
  media.get('zhuma_spaces').tables.get('spaces').get('north').name = '改过';
  await assert.rejects(
    openSpaceDirectory(mount({ media }).ctx.storageDomain, seed),
    (error) => error instanceof WorkbenchError && error.message === '导入与已有记录不一致。',
  );
  await assert.rejects(
    openSpaceDirectory(mount({ media }).ctx.storageDomain),
    workbenchCode('validation'),
  );
});

test('the membership cap is enforced on the import path', async () => {
  const media = new Map();
  const bigImport = {
    spaces: [{ id: 'team-north', kind: 'team', name: '北队' }],
    memberships: Array.from({ length: SPACE_DIRECTORY_MEMBERSHIP_LIMIT + 1 }, (_, index) => ({
      spaceId: 'team-north',
      accountId: `a${index}`,
    })),
  };
  const { ctx } = mount({ media });
  await assert.rejects(openSpaceDirectory(ctx.storageDomain, bigImport), WorkbenchError);
});

test('directory close invalidates synchronously before a held backend drain and shares one close', async () => {
  let finish;
  let entered;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { ctx } = mount({
    faults: {
      close: async () => {
        entered();
        await held;
      },
    },
  });
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);
  let aborted = 0;
  directory.signal.addEventListener('abort', () => {
    aborted++;
  });
  const closing = directory.close();
  assert.equal(directory.signal.aborted, true);
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(directory.spaceForProjectNow('missing'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await directory.spaceForProject('portal'), { ok: false, reason: 'unavailable' });
  assert.equal(aborted, 1);
  assert.equal(directory.close(), closing);
  await started;
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  await closing;
  assert.equal(aborted, 1);
  assert.equal(directory.close(), closing);
});

test('failed directory close remains invalidated and does not start a second teardown', async () => {
  let closes = 0;
  const { ctx } = mount({
    faults: {
      close: async () => {
        closes++;
        throw new Error('fixture close refused');
      },
    },
  });
  const directory = await openSpaceDirectory(ctx.storageDomain, FIXTURE);
  const closing = directory.close();
  assert.equal(directory.signal.aborted, true);
  await assert.rejects(closing, /fixture close refused/);
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: false, reason: 'unavailable' });
  assert.equal(directory.close(), closing);
  await assert.rejects(directory.close(), /fixture close refused/);
  assert.equal(closes, 1);
});

test('synchronous project lookup reads current domain facts only after durable assignment and follows row changes', async () => {
  const entered = Promise.withResolvers();
  const durable = Promise.withResolvers();
  let hold = false;
  const { ctx } = mount({
    faults: {
      async beforePut(table, key) {
        if (hold && table === 'project_spaces' && key === 'later') {
          entered.resolve();
          await durable.promise;
        }
      },
    },
  });
  let domain;
  const directory = await openSpaceDirectory(
    {
      async open(spec) {
        domain = await ctx.storageDomain.open(spec);
        return domain;
      },
    },
    FIXTURE,
  );
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: true, spaceId: 'team-north' });
  assert.deepEqual(directory.spaceForProjectNow('team-north'), { ok: false, reason: 'unknown' });
  assert.deepEqual(directory.spaceForProjectNow('later'), { ok: false, reason: 'unknown' });
  hold = true;
  const assignment = directory.assignProjectSpace('later', 'team-north');
  await entered.promise;
  assert.deepEqual(directory.spaceForProjectNow('later'), { ok: false, reason: 'unknown' });
  durable.resolve();
  await assignment;
  assert.deepEqual(directory.spaceForProjectNow('later'), { ok: true, spaceId: 'team-north' });
  // Test-owned authoritative domain mutations exercise live reads, not a new public move API.
  await domain
    .table('project_spaces')
    .update('portal', (record) => ({ ...record, spaceId: 'personal-lin' }));
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: true, spaceId: 'personal-lin' });
  assert.deepEqual(
    await directory.spaceForProject('portal'),
    directory.spaceForProjectNow('portal'),
  );
  await domain.table('project_spaces').delete('portal');
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: false, reason: 'unknown' });
  assert.deepEqual(await directory.spaceForProject('portal'), { ok: false, reason: 'unknown' });
  await directory.close();
});

test('synchronous project lookup refuses a failed domain even before the handle lifetime is aborted', async () => {
  const { ctx } = mount();
  let domain;
  const directory = await openSpaceDirectory(
    {
      async open(spec) {
        domain = await ctx.storageDomain.open(spec);
        return domain;
      },
    },
    FIXTURE,
  );
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: true, spaceId: 'team-north' });
  await domain.close();
  assert.equal(directory.signal.aborted, false);
  assert.deepEqual(directory.spaceForProjectNow('portal'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(directory.spaceForProjectNow('missing'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await directory.spaceForProject('portal'), { ok: false, reason: 'unavailable' });
  await directory.close();
});
