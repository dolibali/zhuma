/** Wire/member contracts; no GUI or native runtime certification. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionError } from '../dist/execution/ExecutionApi.js';
import { focusNodes, progressIsExecuting } from '../dist/execution/progress-focus.js';
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
  assert.deepEqual(calls, [{ ...query, detail: 'nodes' }]);
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
  assert.deepEqual(JSON.parse(options.body).payload, { ...query, detail: 'nodes' });
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
const legacyKeys = [
  'target',
  'facts',
  'reason',
  'delivery',
  'expectedNodes',
  'acceptedNodes',
  'byStatus',
  'assigneeCounts',
  'resources',
];
function legacyRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ExecutionError('validation', '任务进度与当前计划不一致，请刷新后重试。');
  if (Object.keys(raw).some((key) => !legacyKeys.includes(key)))
    throw new ExecutionError('validation', '任务进度与当前计划不一致，请刷新后重试。');
}
function summaryItem(item) {
  const { nodeStatuses: _nodes, workflow: _workflow, ...rest } = item;
  return rest;
}
test('task progress codec: old summary and node detail work in both cross-version directions', async () => {
  const current = row();
  const legacyItem = summaryItem(current);
  legacyRow(legacyItem);
  assert.throws(() => legacyRow(current), { code: 'validation' });
  const calls = [];
  const oldServer = createTaskProgressApi(async (input) => {
    calls.push(structuredClone(input));
    if (Object.hasOwn(input, 'detail')) throw new ExecutionError('unknown-field', 'unrecognized');
    return value([legacyItem]);
  }, 'north');
  const read = await oldServer.read(query, signal());
  assert.deepEqual(
    calls.map((call) => call.detail ?? null),
    ['nodes', null],
  );
  assert.equal(read.items[0].nodeStatuses, null);
  assert.equal(read.items[0].workflow, null);
  assert.equal(read.items[0].byStatus.running, current.byStatus.running);
  assert.equal(read.items[0].resources.authorHeld, current.resources.authorHeld);
  assert.deepEqual(focusNodes(read.items[0]), []);
  assert.equal(progressIsExecuting(read.items[0]), true);
  const idle = summaryItem(
    row({
      byStatus: { ...current.byStatus, running: 0, ready: 2 },
      resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
    }),
  );
  const idleServer = createTaskProgressApi(async (input) => {
    if (Object.hasOwn(input, 'detail')) throw new ExecutionError('unknown-field', 'unrecognized');
    return value([idle]);
  }, 'north');
  const idleRead = await idleServer.read(query, signal());
  assert.equal(idleRead.items[0].nodeStatuses, null);
  assert.deepEqual(focusNodes(idleRead.items[0]), []);
  assert.equal(progressIsExecuting(idleRead.items[0]), false);
  let modernCalls = 0;
  const modern = createTaskProgressApi(async (input) => {
    modernCalls++;
    assert.equal(input.detail, 'nodes');
    return value([current]);
  }, 'north');
  const detailed = await modern.read(query, signal());
  assert.equal(modernCalls, 1);
  assert.equal(detailed.items[0].nodeStatuses.length, current.nodeStatuses.length);
  assert.equal(detailed.items[0].workflow, 'inactive');
  const half = { ...legacyItem, nodeStatuses: current.nodeStatuses };
  const partial = createTaskProgressApi(async () => value([half]), 'north');
  await assert.rejects(partial.read(query, signal()), { code: 'validation' });
  const extra = createTaskProgressApi(async () => value([row({ phase: 'guessed' })]), 'north');
  await assert.rejects(extra.read(query, signal()), { code: 'validation' });
  let failures = 0;
  const refused = createTaskProgressApi(async () => {
    failures++;
    throw new ExecutionError('validation', '任务进度与当前计划不一致，请刷新后重试。');
  }, 'north');
  await assert.rejects(refused.read(query, signal()), { code: 'validation' });
  assert.equal(failures, 1);
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
