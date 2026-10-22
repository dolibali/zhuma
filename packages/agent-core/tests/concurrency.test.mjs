import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendDomainEvent,
  decideCommand,
  eventsAfter,
  recordCommandEvent,
} from '@zhuma/agent-core';

const event = (eventId, sequence) => ({
  eventId,
  sequence,
  occurredAt: '2026-10-22T01:02:03.000Z',
  actorId: 'human-1',
  object: { type: 'node', id: 'node-1' },
  type: 'node.changed',
  payload: { eventId },
});

test('a repeated idempotency key does not apply twice, even if the expected version changed', () => {
  let calls = 0;
  const first = decideCommand({
    envelope: {
      idempotencyKey: 'submit-1',
      actorId: 'human-1',
      objectId: 'node-1',
      expectedVersion: 0,
      payload: { b: 1, a: 'text' },
    },
    currentVersion: 0,
    stored: [],
    apply: (nextVersion) => {
      calls += 1;
      return { disposition: 'accept', result: { created: true, nextVersion } };
    },
  });
  assert.equal(first.decision.status, 'applied');
  assert.equal(first.version, 1);
  assert.equal(calls, 1);

  const replay = decideCommand({
    envelope: {
      idempotencyKey: 'submit-1',
      actorId: 'human-1',
      objectId: 'node-1',
      expectedVersion: 5,
      payload: { a: 'text', b: 1 },
    },
    currentVersion: first.version,
    stored: first.stored,
    apply: () => {
      calls += 1;
      return { disposition: 'accept', result: { created: false, nextVersion: 99 } };
    },
  });
  assert.equal(replay.decision.status, 'replayed');
  assert.deepEqual(replay.decision.result, { created: true, nextVersion: 1 });
  assert.equal(replay.version, 1);
  assert.equal(replay.stored.length, 1);
  assert.equal(calls, 1);
});

test('returns the current version on conflict and does not apply or emit', () => {
  let calls = 0;
  const conflict = decideCommand({
    envelope: {
      idempotencyKey: 'other',
      actorId: 'human-1',
      objectId: 'node-1',
      expectedVersion: 0,
      payload: { value: 1 },
    },
    currentVersion: 4,
    stored: [],
    apply: () => {
      calls += 1;
      return { disposition: 'accept', result: { ok: true } };
    },
  });
  assert.equal(conflict.decision.status, 'conflict');
  assert.equal(conflict.decision.reason, 'version-mismatch');
  assert.equal(conflict.decision.currentVersion, 4);
  assert.equal(conflict.decision.expectedVersion, 0);
  assert.equal(conflict.version, 4);
  assert.equal(conflict.stored.length, 0);
  assert.equal(calls, 0);

  const emitted = recordCommandEvent({
    decisionStatus: conflict.decision.status,
    log: [],
    event: event('evt-1', 1),
  });
  assert.equal(emitted.emitted, false);
  assert.equal(emitted.log.length, 0);
});

test('rejects a reused idempotency key whose payload differs', () => {
  const first = decideCommand({
    envelope: {
      idempotencyKey: 'same',
      actorId: 'human-1',
      objectId: 'node-1',
      expectedVersion: 0,
      payload: { text: '一版' },
    },
    currentVersion: 0,
    stored: [],
    apply: () => ({ disposition: 'accept', result: { versionId: 'art-1' } }),
  });
  let calls = 0;
  const mismatch = decideCommand({
    envelope: {
      idempotencyKey: 'same',
      actorId: 'human-1',
      objectId: 'node-1',
      expectedVersion: 1,
      payload: { text: '二版' },
    },
    currentVersion: 1,
    stored: first.stored,
    apply: () => {
      calls += 1;
      return { disposition: 'accept', result: { versionId: 'art-2' } };
    },
  });
  assert.equal(mismatch.decision.status, 'idempotency-mismatch');
  assert.equal(mismatch.version, 1);
  assert.equal(calls, 0);

  const otherActor = decideCommand({
    envelope: {
      idempotencyKey: 'same',
      actorId: 'human-2',
      objectId: 'node-1',
      expectedVersion: 1,
      payload: { text: '一版' },
    },
    currentVersion: 1,
    stored: first.stored,
    apply: () => {
      calls += 1;
      return { disposition: 'accept', result: { versionId: 'art-2' } };
    },
  });
  assert.equal(otherActor.decision.status, 'idempotency-mismatch');
  assert.equal(calls, 0);
});

test('appends an event only for an accepted command and supports incremental recovery', () => {
  const empty = [];
  const first = recordCommandEvent({
    decisionStatus: 'applied',
    log: empty,
    event: event('evt-1', 1),
  });
  assert.equal(first.emitted, true);
  const replay = recordCommandEvent({
    decisionStatus: 'replayed',
    log: first.log,
    event: event('evt-2', 2),
  });
  assert.equal(replay.emitted, false);
  assert.equal(replay.log.length, 1);

  const second = appendDomainEvent(first.log, event('evt-2', 3));
  assert.equal(second.ok, true);
  const duplicate = appendDomainEvent(second.log, event('evt-1', 4));
  assert.equal(duplicate.code, 'duplicate-event');
  const rewound = appendDomainEvent(second.log, event('evt-3', 2));
  assert.equal(rewound.code, 'non-monotonic-sequence');
  const invalid = appendDomainEvent(second.log, { ...event('evt-3', 4), occurredAt: 'tomorrow' });
  assert.equal(invalid.code, 'invalid-event');
  const impossible = appendDomainEvent(second.log, {
    ...event('evt-3', 4),
    occurredAt: '2026-99-99T99:99:99',
  });
  assert.equal(impossible.code, 'invalid-event');
  const missingDay = appendDomainEvent(second.log, {
    ...event('evt-3', 4),
    occurredAt: '2026-02-29T00:00:00Z',
  });
  assert.equal(missingDay.code, 'invalid-event');
  const zoned = appendDomainEvent(second.log, {
    ...event('evt-3', 4),
    occurredAt: '2024-02-29T23:59:59+08:00',
  });
  assert.equal(zoned.ok, true);

  const recovered = eventsAfter(second.log, { sequence: 1, seenEventIds: [] });
  assert.deepEqual(
    recovered.map((item) => item.eventId),
    ['evt-2'],
  );
  const seen = eventsAfter(second.log, { sequence: 0, seenEventIds: ['evt-2'] });
  assert.deepEqual(
    seen.map((item) => item.eventId),
    ['evt-1'],
  );
});
