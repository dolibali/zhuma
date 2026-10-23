import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTOR_FIELD_DEPTH_LIMIT,
  containsActorField,
  resolveActor,
  scanActorField,
} from '../dist/execution-identity.js';

const humans = ['chen', 'lin', 'outside'];

test('actor fields are rejected at any depth, and only a directory member becomes an actor', () => {
  assert.equal(containsActorField({ note: { reviewerId: 'chen' } }), true);
  assert.equal(containsActorField({ files: [{ id: 'notes', memberId: 'chen' }] }), true);
  assert.equal(containsActorField({ directoryMemberId: 'chen', idempotencyKey: 'bind-1' }), false);
  assert.equal(resolveActor(undefined, humans).code, 'unauthenticated');
  assert.equal(
    resolveActor({ ok: false, status: 401, code: 'unauthenticated' }, humans).code,
    'unauthenticated',
  );
  assert.equal(
    resolveActor({ ok: false, status: 403, code: 'untrusted-request' }, humans).code,
    'untrusted-request',
  );
  assert.equal(
    resolveActor({ memberId: 'chen', spaceIds: ['project'] }, humans).code,
    'unauthenticated',
  );
  assert.equal(
    resolveActor({ ok: true, memberId: 'chen', spaceIds: ['project'] }, ['lin']).code,
    'not-in-directory',
  );
  assert.deepEqual(resolveActor({ ok: true, memberId: ' chen ', spaceIds: ['project'] }, humans), {
    ok: true,
    actorId: 'chen',
    spaceIds: ['project'],
  });
  const deep = [];
  let cursor = deep;
  for (let index = 0; index < ACTOR_FIELD_DEPTH_LIMIT + 5; index += 1) {
    const next = [];
    cursor.push(next);
    cursor = next;
  }
  assert.equal(scanActorField({ nested: deep }), 'too-deep');
  assert.equal(containsActorField({ nested: deep }), false);
});
