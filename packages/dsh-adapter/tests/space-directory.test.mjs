import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError } from '@zhuma/agent-core';
import { decideProjectSpace } from '../dist/project-space.js';
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

  const secondMount = mount({ media });
  const second = await openSpaceDirectory(secondMount.ctx.storageDomain);
  assert.deepEqual(
    second.spacesForMember('lin').map((space) => space.id),
    ['personal-lin', 'team-empty', 'team-north'],
  );
  assert.deepEqual(await second.spaceForProject('portal'), { ok: true, spaceId: 'team-north' });
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
