/** Wire/member contracts; no GUI or native runtime certification. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskProgressApi } from '../dist/execution/task-progress.js';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { latestTaskPlan } from '../dist/execution/useTaskProgress.js';
import { query, row, value, unknown, signal, target } from './task-progress-fixture.mjs';

test('task progress codec: exact current refs, metadata, concurrent execution/review and unknown without partial counts', async () => {
  let reply = value();
  const calls = [];
  const api = createTaskProgressApi(async (input) => {
    calls.push(input);
    return reply;
  }, 'north');
  assert.deepEqual(await api.read(query, signal()), reply);
  assert.deepEqual(calls, [query]);
  reply = value([unknown()]);
  assert.deepEqual(await api.read(query, signal()), reply);
  const counts = row().byStatus;
  for (const item of [
    row({
      delivery: 'all-accepted',
      acceptedNodes: 5,
      byStatus: { ...counts, running: 0, 'in-review': 0, completed: 5 },
    }),
    row({
      delivery: 'cancelled',
      acceptedNodes: 0,
      byStatus: { ...counts, running: 0, 'in-review': 0, completed: 0, cancelled: 5 },
    }),
    row({
      delivery: 'mixed-terminal',
      acceptedNodes: 2,
      byStatus: { ...counts, running: 0, 'in-review': 0, cancelled: 3 },
    }),
    row({
      facts: 'not-started',
      acceptedNodes: 0,
      byStatus: { ...counts, running: 0, 'in-review': 0, completed: 0 },
      resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
    }),
  ]) {
    reply = value([item]);
    assert.deepEqual(await api.read(query, signal()), reply);
  }
});

test('task progress codec: malformed/partial facts, wrong refs and out-of-scope requests fail closed', async () => {
  let reply = value();
  let calls = 0;
  const api = createTaskProgressApi(async () => {
    calls++;
    return reply;
  }, 'north');
  for (const input of [
    { ...query, spaceId: 'south' },
    { ...query, plans: [] },
    { ...query, plans: Array(6).fill(target) },
    { ...query, plans: [target, target] },
    { ...query, actorId: 'outside' },
    { ...query, plans: [{ ...target, revision: 0 }] },
  ])
    await assert.rejects(api.read(input, signal()), { code: 'validation' });
  assert.equal(calls, 0);
  for (const broken of [
    row({ target: { ...target, revision: 1 } }),
    row({ acceptedNodes: 6 }),
    row({ byStatus: { ...row().byStatus, running: 9 } }),
    row({ assigneeCounts: { human: 0, expert: 2 } }),
    row({ resources: { ...row().resources, authorHeld: -1 } }),
    row({ delivery: 'all-accepted' }),
    { ...unknown(), acceptedNodes: 0 },
    { ...unknown(), reason: 'unverified-new-reason' },
    row({ content: 'must not carry body' }),
  ]) {
    reply = value([broken]);
    await assert.rejects(api.read(query, signal()), { code: 'validation' });
  }
  for (const patch of [
    { actorId: '' },
    { coverage: 'old-plans' },
    { spaceId: 'south' },
    { items: [] },
  ]) {
    reply = value(undefined, patch);
    await assert.rejects(api.read(query, signal()), { code: 'validation' });
  }
});

const session = (accountId = 'chen', spaces = [{ id: 'north', kind: 'team', name: 'Team' }]) => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'peer',
  spaces,
});
function transport({ response = () => value(), after = () => session() } = {}) {
  let sessions = 0,
    lost = 0,
    unavailable = 0,
    current = true;
  const calls = [];
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') return Response.json(++sessions === 1 ? session() : after());
      calls.push({ url, options });
      const body = JSON.parse(options.body);
      const result = await response(body.payload);
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: result.ok === false ? result : { ok: true, value: result },
      });
    },
    () => lost++,
    'chen',
    { spaceId: 'north', isCurrent: () => current, onUnavailable: () => unavailable++ },
  );
  return {
    api,
    calls,
    expire() {
      current = false;
    },
    get counts() {
      return { sessions, lost, unavailable };
    },
  };
}
test('task progress member HTTP: same original guarded endpoint; late actor/space generation is discarded', async () => {
  const h = transport();
  assert.deepEqual(await h.api.taskProgress.read(query, signal()), value());
  assert.equal(h.calls.length, 1);
  const { url, options } = h.calls[0];
  assert.equal(url, '/api/zhuma-exec/task-progress');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body).payload, query);
  assert.equal(h.counts.sessions, 2);
  for (const scenario of [
    { after: () => session('lin'), code: 'unauthenticated' },
    { after: () => session('chen', []), code: 'space-unavailable' },
    { response: () => value(undefined, { actorId: 'lin' }), code: 'unauthenticated' },
  ]) {
    const changed = transport(scenario);
    await assert.rejects(changed.api.taskProgress.read(query, signal()), { code: scenario.code });
  }
  const pending = Promise.withResolvers();
  const late = transport({ response: () => pending.promise });
  const read = late.api.taskProgress.read(query, signal());
  await new Promise(setImmediate);
  late.expire();
  pending.resolve(value());
  await assert.rejects(read, { name: 'AbortError' });
});
test('task progress conflicts do not fall back to an old plan or disable unrelated member views', async () => {
  const h = transport({
    response: () => ({ ok: false, error: { code: 'conflict', message: 'refresh', details: {} } }),
  });
  await assert.rejects(h.api.taskProgress.read(query, signal()), { code: 'conflict' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.counts.unavailable, 0);
});
test('confirmed plan selection uses the unique greatest revision rather than array order or a new draft', () => {
  const plans = [
    { id: 'new', taskId: 'task', revision: 4 },
    { id: 'old', taskId: 'task', revision: 2 },
  ];
  assert.equal(latestTaskPlan(plans, 'task').id, 'new');
  assert.equal(latestTaskPlan([...plans, { ...plans[0], id: 'ambiguous' }], 'task'), undefined);
  assert.equal(latestTaskPlan(plans, 'missing'), undefined);
});
