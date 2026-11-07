import { test, expect } from '@playwright/test';
import { applyWorkbenchCommand, NODE_STATUSES } from '@zhuma/agent-core';
import { fixture } from '../../../../tests/fixtures/workbench.mjs';

// Response replay only. Real member/JSON/Host composition is tested separately in s1a-host.test.mjs.
function progressRow(target, facts) {
  const byStatus = Object.fromEntries(NODE_STATUSES.map((status) => [status, 0]));
  if (facts === 'present') byStatus.ready = 1;
  return {
    target,
    facts,
    delivery: 'pending',
    expectedNodes: 1,
    acceptedNodes: 0,
    byStatus,
    assigneeCounts: { human: 1, expert: 0 },
    resources: { authorHeld: 0, reviewHeld: 0, stopRequested: 0 },
  };
}
async function replay(page, { empty = false, model = true, progress } = {}) {
  const initial = fixture().state;
  initial.assets = [];
  initial.participants = initial.participants.filter((p) => p.id === 'chen');
  initial.tasks[0].participantIds = ['chen'];
  Object.assign(initial.tasks[0].workflows[0].nodes[0], {
    skillIds: [],
    reviewerIds: [],
    reviewRequired: false,
  });
  if (empty) {
    initial.tasks = [];
    initial.projects = [];
  }
  const control = {
    state: initial,
    calls: [],
    legacy: [],
    execution: [],
    holdStart: null,
    failStart: false,
    startedPlan: null,
  };
  const space = { id: 'team-a', kind: 'team', name: '产品团队' };
  const snapshot = () => ({
    actorId: 'chen',
    spaceId: space.id,
    space,
    state: control.state,
    model: model ? 'fixture / rejecting' : null,
    capabilities: {
      createProject: true,
      createTask: control.state.projects.length > 0,
      planning: model,
      resources: 'not-connected',
      tasks: control.state.tasks.map((t) => ({
        taskId: t.id,
        edit: t.status === 'draft',
        confirm: t.status === 'draft',
        plan: model && t.status === 'draft',
      })),
    },
  });
  await page.route('**/zhuma-id/session', (route) =>
    route.fulfill({
      json: {
        ok: true,
        accountId: 'chen',
        principal: { kind: 'zhuma-member', memberId: 'chen' },
        peerId: 'replay',
        spaces: [space],
      },
    }),
  );
  await page.route('**/api/zhuma/**', (route) => {
    control.legacy.push(route.request().url());
    return route.fulfill({ status: 404 });
  });
  await page.route('**/api/zhuma-member/**', async (route) => {
    const request = route.request().postDataJSON();
    control.calls.push(request);
    expect(request.payload.spaceId).toBe(space.id);
    let result;
    if (request.method === 'zhuma-member/command') await control.commandGate;
    if (request.method === 'zhuma-member/plan') await control.planGate;
    if (request.method === 'zhuma-member/asset-list') {
      // Fixed-file choices read scoped metadata, not a workbench snapshot or file bytes.
      expect(request.payload).toEqual({ spaceId: space.id, kind: 'file', includeDrafts: false });
      result = { ok: true, value: { actorId: 'chen', spaceId: space.id, items: [] } };
    } else if (request.method === 'zhuma-member/plan')
      result = {
        ok: false,
        error: { code: 'model-unavailable', message: '规划模型暂不可用，请重试。' },
      };
    else {
      if (request.method === 'zhuma-member/command') {
        const command = request.payload.command;
        let mapped;
        if (command.type.endsWith('-project'))
          mapped = { type: 'save-project', project: command.project };
        else if (command.type === 'confirm-task')
          mapped = {
            type: 'save-task',
            task: { ...control.state.tasks.find((t) => t.id === command.taskId), status: 'ready' },
          };
        else
          mapped = {
            type: 'save-task',
            task: { ...command.task, status: 'draft', updatedAt: '2026-10-25T12:00:00.000Z' },
          };
        control.state = applyWorkbenchCommand(control.state, mapped);
      }
      result = { ok: true, value: snapshot() };
    }
    await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId, result } });
  });
  await page.route('**/api/zhuma-exec/**', async (route) => {
    const request = route.request().postDataJSON();
    control.execution.push(request);
    if (request.method === 'zhuma-exec/start-plan' && control.failStart) {
      return route.fulfill({
        json: {
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: { code: 'conflict', message: '这项计划已经开始。', details: {} },
          },
        },
      });
    }
    if (request.method === 'zhuma-exec/start-plan' && control.holdStart) await control.holdStart;
    const payload = request.payload ?? {};
    if (request.method === 'zhuma-exec/start-plan')
      control.startedPlan = {
        taskId: payload.taskId,
        planId: payload.planId,
        revision: payload.revision,
      };
    const started = control.startedPlan;
    const value =
      request.method === 'zhuma-exec/startable'
        ? {
            actorId: 'chen',
            spaceId: space.id,
            plans: control.state.appliedPlans
              .filter((p) => !started || p.id !== started.planId)
              .map((p) => ({
                taskId: p.taskId,
                planId: p.id,
                revision: p.revision,
                title: control.state.tasks.find((t) => t.id === p.taskId).title,
              })),
          }
        : progress && request.method === 'zhuma-exec/task-progress'
          ? {
              actorId: 'chen',
              spaceId: space.id,
              coverage: 'current-confirmed-plans',
              items: (payload.plans ?? []).map((target) => progressRow(target, progress)),
            }
          : request.method === 'zhuma-exec/start-plan'
            ? {
                disposition: 'started',
                reports: [
                  {
                    nodeId: 'node-1',
                    taskId: payload.taskId,
                    workflowVersionId: payload.planId,
                    revision: payload.revision,
                    status: 'ready',
                    upstreamAffected: false,
                  },
                ],
              }
            : request.method === 'zhuma-exec/inbox' && started
              ? {
                  actorId: 'chen',
                  spaceId: space.id,
                  items: [
                    {
                      id: 'inbox-1',
                      kind: 'deliver',
                      actorId: 'chen',
                      nodeId: 'node-1',
                      taskId: started.taskId,
                      reason: 'assignee-delivery',
                      action: 'submit',
                    },
                  ],
                  nodes: [
                    {
                      nodeId: 'node-1',
                      taskId: started.taskId,
                      planId: started.planId,
                      revision: started.revision,
                      version: 1,
                      status: 'ready',
                      goal: '设计登录接口',
                      expectedOutput: '接口定义',
                      assigneeId: 'chen',
                      reviewerIds: [],
                      artifacts: [],
                      rounds: [],
                      comments: [],
                    },
                  ],
                }
              : { actorId: 'chen', spaceId: space.id, nodes: [], items: [] };
    return route.fulfill({
      json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } },
    });
  });
  return control;
}
const button = (page, name) => page.getByRole('button', { name, exact: true });

test('member UI replay: an empty space can create its first project and task without model planning', async ({
  page,
}) => {
  const control = await replay(page, { empty: true, model: false });
  await page.goto('/?member-workbench&strict');
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务目标', { exact: true }).fill('整理客户需求');
  await expect(page.getByRole('radio', { name: 'AI 规划', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '从空白开始' })).toBeChecked();
  await button(page, '先创建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('客户门户');
  await button(page, '保存').click();
  await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue('整理客户需求');
  await expect(page.getByText('参与者 · 1 位', { exact: true })).toBeVisible();
  await button(page, '创建工作流').click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('整理客户需求');
  expect(
    control.calls
      .filter((c) => c.method === 'zhuma-member/command')
      .map((c) => c.payload.command.type),
  ).toEqual(['create-project', 'create-task']);
  expect(control.state.tasks[0].ownerId).toBe('chen');
  expect(control.state.tasks[0].participantIds).toEqual(['chen']);
  expect(control.calls.some((c) => c.method === 'zhuma-member/plan')).toBe(false);
  expect(control.legacy).toEqual([]);
});

test('member UI replay: save before confirm, explicit planning failure preserves input, and confirmation only navigates to work', async ({
  page,
}) => {
  const control = await replay(page);
  await page.goto('/?member-workbench&strict');
  await page.locator('.zm-task-row').filter({ hasText: '账号登录' }).click();
  await page.getByText('需求详情', { exact: true }).click();
  await page.getByLabel('任务目标', { exact: true }).fill('保留手机号和邮箱两种登录方式');
  await expect(button(page, '确认工作流')).toBeDisabled();
  await button(page, '保存草稿').click();
  await expect(button(page, '确认工作流')).toBeEnabled();
  await button(page, '✧ AI 规划').click();
  await button(page, '生成工作流草案').click();
  await expect(page.getByRole('alert')).toContainText('规划模型暂不可用');
  expect(control.calls.some((c) => c.method === 'zhuma-member/asset-list')).toBe(true);
  await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue(
    '保留手机号和邮箱两种登录方式',
  );
  expect(control.state.tasks[0].workflows[0].nodes[0].title).toBe('设计登录接口');
  await button(page, '确认工作流').click();
  await button(page, '查看待办').click();
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  expect(control.execution.some((c) => c.method === 'zhuma-exec/start-plan')).toBe(false);
  expect(
    control.calls
      .filter((c) => c.method === 'zhuma-member/command')
      .map((c) => c.payload.command.type),
  ).toEqual(['update-task', 'confirm-task']);
  expect(control.legacy).toEqual([]);
});

test('member UI replay: compact editor leave modal cancels and escapes back to its trigger without losing input', async ({
  page,
}) => {
  const control = await replay(page);
  const native = [];
  page.on('dialog', async (dialog) => {
    native.push(dialog.type());
    await dialog.dismiss();
  });
  await page.goto('/?member-workbench&strict');
  await expect(button(page, '团队工作台')).toBeVisible();
  await expect(button(page, '我的工作')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '工作内容' })).toHaveCount(0);
  await page.locator('.zm-task-row').filter({ hasText: '账号登录' }).click();
  const title = page.getByLabel('任务标题', { exact: true });
  await title.fill('尚未保存的登录要求');
  const back = button(page, '任务清单');
  await back.click();
  const modal = page.getByRole('dialog', { name: '离开当前页面？', exact: true });
  await expect(modal).toBeVisible();
  expect((await modal.boundingBox()).width).toBeLessThanOrEqual(440);
  await button(modal, '继续编辑').click();
  await expect(back).toBeFocused();
  await expect(title).toHaveValue('尚未保存的登录要求');
  await back.click();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(back).toBeFocused();
  await expect(title).toHaveValue('尚未保存的登录要求');
  await back.click();
  await button(modal, '放弃并离开').click();
  await expect(title).toHaveCount(0);
  await expect(page.locator('.zm-task-row')).toContainText('账号登录');
  expect(control.state.tasks[0].title).toBe('账号登录');
  expect(native).toEqual([]);
});

for (const operation of ['command', 'plan'])
  test(`member UI replay: sidebar leave during slow ${operation} preserves cancel and fences a reply after confirmed navigation`, async ({
    page,
  }) => {
    const control = await replay(page);
    const gate = Promise.withResolvers();
    control[`${operation}Gate`] = gate.promise;
    const native = [];
    page.on('dialog', async (dialog) => {
      native.push(dialog.type());
      await dialog.dismiss();
    });
    try {
      await page.goto('/?member-workbench&strict');
      await page.locator('.zm-task-row').filter({ hasText: '账号登录' }).click();
      const title = page.getByLabel('任务标题', { exact: true });
      if (operation === 'command') {
        await title.fill('已经发送的保存');
        await button(page, '保存草稿').click();
      } else {
        await button(page, '✧ AI 规划').click();
        await button(page, '生成工作流草案').click();
      }
      await expect
        .poll(() => control.calls.some((request) => request.method === `zhuma-member/${operation}`))
        .toBe(true);
      const work = button(page, '我的工作');
      await work.click();
      const modal = page.getByRole('dialog', { name: '离开当前页面？', exact: true });
      await expect(modal).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(work).toBeFocused();
      await expect(title).toBeVisible();
      await work.click();
      await button(modal, '继续编辑').click();
      await expect(title).toHaveValue(operation === 'command' ? '已经发送的保存' : '账号登录');
      await work.click();
      await button(modal, '放弃并离开').click();
      await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
      gate.resolve();
      await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toHaveCount(0);
      expect(control.execution.some((request) => request.method === 'zhuma-exec/start-plan')).toBe(
        false,
      );
      expect(native).toEqual([]);
    } finally {
      gate.resolve();
    }
  });

async function confirmTask(page) {
  await page.goto('/?member-workbench&strict');
  await page.locator('.zm-task-row').filter({ hasText: '账号登录' }).click();
  await button(page, '确认工作流').click();
}
const startCalls = (control) =>
  control.execution.filter((request) => request.method === 'zhuma-exec/start-plan');

test('member UI replay: a confirmed plan that has not started is started from the task, then work opens', async ({
  page,
}) => {
  const control = await replay(page, { progress: 'not-started' });
  let release = () => {};
  control.holdStart = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await confirmTask(page);
    await expect(page.getByText('尚未开始', { exact: true })).toBeVisible();
    await expect(button(page, '开始执行')).toBeVisible();
    await expect(button(page, '查看待办')).toHaveCount(0);
    expect(startCalls(control)).toEqual([]);
    await button(page, '开始执行').dblclick();
    await expect.poll(() => startCalls(control).length).toBe(1);
    const plan = control.state.appliedPlans[0];
    const payload = startCalls(control)[0].payload;
    expect(payload).toMatchObject({
      taskId: plan.taskId,
      planId: plan.id,
      revision: plan.revision,
      spaceId: 'team-a',
    });
    expect(payload.idempotencyKey).toEqual(expect.any(String));
    expect(payload.idempotencyKey.length).toBeGreaterThan(10);
    expect(payload.actorId).toBeUndefined();
    await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '待我交付 1 个工作项', exact: true }),
    ).toBeVisible();
    await expect(button(page, '提交产物')).toBeEnabled();
    await expect(page.getByText('现在没有需要你处理的工作。')).toHaveCount(0);
    await expect(page.getByText('暂无待开始的计划', { exact: true })).toBeVisible();
    expect(startCalls(control)).toHaveLength(1);
  } finally {
    release();
  }
});

test('member UI replay: an already started plan keeps view-only navigation', async ({ page }) => {
  const control = await replay(page, { progress: 'present' });
  await confirmTask(page);
  await expect(page.getByText('待处理 1', { exact: true })).toBeVisible();
  await expect(button(page, '查看待办')).toBeVisible();
  await expect(button(page, '开始执行')).toHaveCount(0);
  await button(page, '查看待办').click();
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toBeVisible();
  expect(startCalls(control)).toEqual([]);
});

test('member UI replay: a refused start stays on the confirmed task', async ({ page }) => {
  const control = await replay(page, { progress: 'not-started' });
  control.failStart = true;
  await confirmTask(page);
  await button(page, '开始执行').click();
  await expect(page.getByRole('alert').filter({ hasText: '这项计划已经开始。' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '账号登录', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '我的工作', exact: true })).toHaveCount(0);
  await expect(button(page, '开始执行')).toBeEnabled();
  expect(startCalls(control)).toHaveLength(1);
});
