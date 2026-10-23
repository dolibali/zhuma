import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkbenchError } from '@zhuma/agent-core';
import {
  PROJECT_SPACE_LIMIT,
  boundedProjectSpaces,
  decideProjectSpace,
} from '../dist/project-space.js';

test('a project can belong to a space with a different id', async () => {
  const record = { projectId: 'portal', spaceId: 'team-north' };
  const directory = boundedProjectSpaces([record]);
  record.spaceId = 'team-south';
  assert.deepEqual(await directory.spaceForProject('portal'), {
    ok: true,
    spaceId: 'team-north',
  });
  assert.equal(decideProjectSpace(await directory.spaceForProject('portal'), ['team-north']), 'ok');
  assert.equal(decideProjectSpace(await directory.spaceForProject('portal'), ['portal']), 'hidden');
  assert.equal(
    decideProjectSpace(await directory.spaceForProject('portal'), ['team-south']),
    'hidden',
  );
  assert.deepEqual(await directory.spaceForProject('missing'), { ok: false, reason: 'unknown' });
  assert.equal(decideProjectSpace({ ok: false, reason: 'unknown' }, ['team-north']), 'hidden');
  assert.equal(
    decideProjectSpace({ ok: false, reason: 'unavailable' }, ['team-north']),
    'unavailable',
  );
});

test('a catalog that is oversized, conflicting, or ill-formed is refused', () => {
  const records = Array.from({ length: PROJECT_SPACE_LIMIT + 1 }, (_, index) => ({
    projectId: `p${index}`,
    spaceId: 'team-north',
  }));
  assert.throws(
    () => boundedProjectSpaces(records),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
  assert.throws(
    () =>
      boundedProjectSpaces([
        { projectId: 'portal', spaceId: 'team-north' },
        { projectId: 'portal', spaceId: 'team-south' },
      ]),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
  assert.throws(
    () => boundedProjectSpaces([{ projectId: 'portal', spaceId: '' }]),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
  const repeated = boundedProjectSpaces([
    { projectId: 'portal', spaceId: 'team-north' },
    { projectId: 'portal', spaceId: 'team-north' },
  ]);
  return repeated.spaceForProject('portal').then((answer) => {
    assert.deepEqual(answer, { ok: true, spaceId: 'team-north' });
  });
});

test('a space id is not accepted from a shared prefix or a different case', () => {
  const lookup = { ok: true, spaceId: 'team-north' };
  assert.equal(decideProjectSpace(lookup, ['team']), 'hidden');
  assert.equal(decideProjectSpace(lookup, ['team-north-extra']), 'hidden');
  assert.equal(decideProjectSpace(lookup, ['Team-North']), 'hidden');
  assert.equal(decideProjectSpace(lookup, ['team-north']), 'ok');
});

test('a catalog of exactly 100 records is accepted and 101 is refused', async () => {
  const accepted = Array.from({ length: PROJECT_SPACE_LIMIT }, (_, index) => ({
    projectId: `p${index}`,
    spaceId: 'team-north',
  }));
  const directory = boundedProjectSpaces(accepted);
  assert.deepEqual(await directory.spaceForProject('p0'), { ok: true, spaceId: 'team-north' });
  assert.deepEqual(await directory.spaceForProject(`p${PROJECT_SPACE_LIMIT - 1}`), {
    ok: true,
    spaceId: 'team-north',
  });
  assert.throws(
    () => boundedProjectSpaces([...accepted, { projectId: 'overflow', spaceId: 'team-north' }]),
    (error) => error instanceof WorkbenchError && error.code === 'validation',
  );
});
