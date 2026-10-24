import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionApi, readExecutionEvents } from '../dist/execution/ExecutionApi.js';

const first = {
  eventId: 'evt:design:1',
  sequence: 1,
  occurredAt: '2026-10-23T00:00:00.000Z',
  actorId: 'chen',
  type: 'node-started',
  nodeId: 'design',
  status: 'ready',
  version: 1,
  checksum: 'checksum-9f3e',
  path: '/var/secret/token',
};

test('a repeated pull drops the same eventId and does not keep checksums or paths', () => {
  const read = readExecutionEvents({
    events: [
      { ...first, sequence: 2 },
      first,
      {
        ...first,
        eventId: 'evt:design:2',
        sequence: 2,
        type: 'delivery-submitted',
        status: 'completed',
        version: 2,
      },
    ],
  });
  assert.deepEqual(
    read.events.map((event) => event.eventId),
    ['evt:design:1', 'evt:design:2'],
  );
  assert.equal(JSON.stringify(read).includes('checksum-9f3e'), false);
  assert.equal(JSON.stringify(read).includes('/var/secret/token'), false);
});

test('events sends the cursor and dedupes the returned page', async () => {
  const calls = [];
  const api = createExecutionApi({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      return { ok: true, value: { events: [first, first] } };
    },
  });
  const read = await api.events({
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    after: 1,
    seenEventIds: ['evt:design:1'],
  });
  assert.equal(calls[0].endpoint, 'zhuma-exec/events');
  assert.deepEqual(calls[0].payload, {
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    after: 1,
    seenEventIds: ['evt:design:1'],
  });
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].eventId, 'evt:design:1');
});
