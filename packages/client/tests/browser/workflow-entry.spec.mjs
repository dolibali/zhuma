import { test, expect } from '@playwright/test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../../tests/fixtures/workbench.mjs';
import { row } from '../task-progress-fixture.mjs';

// Formal member page, production API adapters; fixture RPC, never real Host authority.
async function open(page, { actor = 'outside', remote = false, error } = {}) {
  const data = fixture();
  const space = { id: 'north', name: '产品团队', kind: 'team' };
  const task = {
    ...data.task,
    status: 'ready',
    participantIds: ['chen', 'qa', 'outside'],
    workflows: [
      {
        ...data.task.workflows[0],
        nodes: Array.from({ length: 6 }, (_, i) => ({
          ...data.node,
          id: `node-${i}`,
          title: `阶段 ${i + 1}`,
          assigneeId: i === 5 ? 'outside' : 'chen',
          dependsOn: i ? [`node-${i - 1}`] : [],
          position: { x: i * 360, y: 0 },
        })),
      },
    ],
  };
  const state = applyWorkbenchCommand(data.state, { type: 'save-task', task });
  state.receipts = [];
  const plan = state.appliedPlans[0];
  const target = { taskId: task.id, planId: plan.id, revision: plan.revision };
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const reply = (route, wire, value) =>
    route.fulfill({
      json: {
        type: 'server-response',
        rpcId: wire.rpcId,
        result: { ok: true, value },
      },
    });
  await page.route('**/zhuma-id/session', (route) =>
    route.fulfill({
      json: {
        ok: true,
        accountId: actor,
        principal: { kind: 'zhuma-member', memberId: actor },
        peerId: 'fixture',
        spaces: [space],
      },
    }),
  );
  await page.route('**/api/**', async (route) => {
    const wire = route.request().postDataJSON();
    calls.push(wire);
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/zhuma-member/asset-list')
      return reply(route, wire, { actorId: actor, spaceId: space.id, items: [] });
    if (path === '/api/zhuma-member/snapshot')
      return reply(route, wire, {
        actorId: actor,
        spaceId: space.id,
        space,
        state,
        model: null,
        capabilities: {
          createProject: false,
          createTask: false,
          planning: false,
          resources: 'authorized',
          tasks: [{ taskId: task.id, edit: false, confirm: false, plan: false }],
        },
      });
    if (path === '/api/zhuma-exec/task-progress')
      return reply(route, wire, {
        actorId: actor,
        spaceId: space.id,
        coverage: 'current-confirmed-plans',
        items: [
          row({
            target,
            expectedNodes: 6,
            acceptedNodes: 6,
            delivery: 'all-accepted',
            byStatus: { ...row().byStatus, running: 0, 'in-review': 0, completed: 6 },
            assigneeCounts: { human: 6, expert: 0 },
            resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
            nodeStatuses: task.workflows[0].nodes.map((n) => ({
              nodeId: n.id,
              status: 'completed',
              authorHeld: 0,
              assignee: 'human',
            })),
          }),
        ],
      });
    if (path === '/api/zhuma-workflow/read' || path === '/api/zhuma-member-native/workflow-read') {
      if (error === 'network') return route.abort('failed');
      if (error === 'authority' || (!remote && actor !== task.ownerId))
        return route.fulfill({
          json: {
            type: 'server-response',
            rpcId: wire.rpcId,
            result: { ok: false, error: { code: 'workflow-authority-denied' } },
          },
        });
      return reply(route, wire, {
        target: { ...target, spaceId: space.id },
        title: task.title,
        state: 'inactive',
        planStarted: true,
        requiresResume: false,
        activeRunCount: 0,
        expertNodeCount: 0,
        controlledNodeCount: 1,
        intent: null,
        selection: null,
      });
    }
    // An explicit node launch still reaches its own original controller and authority check.
    if (path === '/api/zhuma-run/options')
      return route.fulfill({
        json: {
          type: 'server-response',
          rpcId: wire.rpcId,
          result: { ok: false, error: { code: 'run-authority-unavailable' } },
        },
      });
    throw Error('Unexpected fixture route: ' + path);
  });
  await page.goto('/?member-workbench&workflow-native' + (remote ? '&remote-native' : ''));
  await expect(page.locator('.zm-task-row')).toHaveCount(1);
  await page.locator('.zm-task-row').filter({ hasText: task.title }).click();
  await expect(page.getByText('产物全部已接受 6/6', { exact: true })).toBeVisible();
  return { calls, errors };
}
const workflowReads = (calls) =>
  calls.filter((c) => /(?:workflow\/read|workflow-read)$/.test(c.method));

test('本机非负责人只读查看六阶段任务不读取owner控制状态，进度与本人Agent入口保留', async ({
  page,
}) => {
  const { calls, errors } = await open(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await page.locator('.react-flow__node[data-id="node-5"]').click();
  const launch = page
    .locator('.zm-workflow-tools')
    .getByRole('button', { name: '使用 Agent', exact: true });
  await expect(launch).toBeEnabled();
  await expect(page.locator('.zm-workflow-controls')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(workflowReads(calls)).toHaveLength(0);
  await launch.click();
  await expect.poll(() => calls.filter((c) => c.method === 'zhuma-run/options').length).toBe(1);
  expect(calls.find((c) => c.method === 'zhuma-run/options').payload.nodeId).toBe('node-5');
  expect(workflowReads(calls)).toHaveLength(0);
  expect(errors).toEqual([]);
});

for (const setup of [
  { actor: 'chen', remote: false },
  { actor: 'outside', remote: true },
]) {
  test(`${setup.remote ? '远端获分配成员' : '本机任务负责人'}保留工作流控制且查看不自动执行`, async ({
    page,
  }) => {
    const { calls, errors } = await open(page, setup);
    await expect(page.getByRole('button', { name: '运行工作流', exact: true })).toBeVisible();
    await expect.poll(() => workflowReads(calls).length).toBe(1);
    expect(calls.filter((c) => /start|resume|stop/.test(c.method))).toHaveLength(0);
    if (setup.remote) expect(workflowReads(calls)[0].payload.actorId).toBe('outside');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const setup of [
  { actor: 'chen', remote: false },
  { actor: 'outside', remote: true },
])
  for (const error of ['authority', 'network'])
    test(`${setup.remote ? '远端成员' : '本机负责人'}仍看到真实${error}错误`, async ({ page }) => {
      const { calls } = await open(page, { ...setup, error });
      await expect(page.locator('.zm-workflow-controls').getByRole('alert')).toBeVisible();
      expect(workflowReads(calls)).toHaveLength(1);
      await expect(page.getByText('产物全部已接受 6/6', { exact: true })).toBeVisible();
    });
