import { test, expect } from '@playwright/test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../../tests/fixtures/workbench.mjs';

// Response replay only. Real member/JSON/Host composition is tested separately in s1a-host.test.mjs.
async function replay(page, { empty = false, model = true } = {}) {
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
  const control = { state: initial, calls: [], legacy: [], execution: [] };
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
    if (request.method === 'zhuma-member/plan')
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
  await page.route('**/api/zhuma-exec/**', (route) => {
    const request = route.request().postDataJSON();
    control.execution.push(request);
    const value =
      request.method === 'zhuma-exec/startable'
        ? {
            actorId: 'chen',
            spaceId: space.id,
            plans: control.state.appliedPlans.map((p) => ({
              taskId: p.taskId,
              planId: p.id,
              revision: p.revision,
              title: control.state.tasks.find((t) => t.id === p.taskId).title,
            })),
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
