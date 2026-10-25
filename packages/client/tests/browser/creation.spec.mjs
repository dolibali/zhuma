import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { test, expect, deferred, failure, proposal } from './replay.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const requests = (replay, endpoint) => replay.requests.filter((r) => r.endpoint === endpoint);
async function creation(page, goal, url = '/') {
  await page.goto(url);
  await button(page, '＋ 创建任务').click();
  await page.getByLabel('任务目标', { exact: true }).fill(goal);
}

test('从空项目创建任务：建项目前后保留目标和规划方式，取消可返回原草稿', async ({
  page,
  replay,
}) => {
  replay.state.projects = [];
  replay.state.tasks = [];
  let projectAttempts = 0;
  replay.handlers.command = async (payload) => {
    if (payload.command.type === 'save-project' && projectAttempts++ === 0)
      return failure('unavailable', '项目暂时无法保存，请重试。');
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    return { ok: true, value: replay.state };
  };
  await creation(page, '整理首个项目的交付说明');
  await expect(page.getByRole('dialog', { name: '创建任务' })).toBeVisible();
  await expect(button(page, '先创建项目')).toBeVisible();
  await page.getByRole('radio', { name: '从空白开始' }).check();
  await button(page, '先创建项目').click();
  await expect(page.getByRole('dialog', { name: '新建项目' })).toContainText(
    '保存项目后继续创建任务。',
  );
  await page.getByLabel('项目名称', { exact: true }).fill('首个项目');
  await button(page, '取消').click();
  await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue('整理首个项目的交付说明');
  await expect(page.getByRole('radio', { name: '从空白开始' })).toBeChecked();
  await button(page, '先创建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('首个项目');
  await button(page, '保存').click();
  await expect(page.getByRole('dialog', { name: '新建项目' }).getByRole('alert')).toContainText(
    '项目暂时无法保存',
  );
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('首个项目');
  await button(page, '保存').click();
  await expect(page.getByRole('dialog', { name: '创建任务' })).toBeVisible();
  await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue('整理首个项目的交付说明');
  await expect(page.getByRole('radio', { name: '从空白开始' })).toBeChecked();
  await expect(page.getByLabel('所属项目', { exact: true })).toContainText('首个项目');
  await button(page, '创建工作流').click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('整理首个项目的交付说明');
  expect(requests(replay, 'command').map((r) => r.command.type)).toEqual([
    'save-project',
    'save-project',
    'save-task',
  ]);
  expect(requests(replay, 'command')[0].requestId).toBe(requests(replay, 'command')[1].requestId);
  expect(requests(replay, 'plan')).toHaveLength(0);
  expect(replay.state.tasks[0].projectId).toBe(replay.state.projects[0].id);
});

test('人工清空参与者后新建项目，返回任务时仍为空', async ({ page, replay }) => {
  replay.state.projects[0].defaultParticipantIds = ['chen'];
  await creation(page, '人工核对首版交付');
  await button(page, '选择参与者').click();
  const taskPicker = page.getByRole('dialog', { name: '选择参与者', exact: true });
  await taskPicker
    .locator('.zm-member')
    .filter({ has: page.getByText('陈宁', { exact: true }) })
    .getByRole('checkbox')
    .uncheck();
  await button(taskPicker, '确认选择').click();
  await expect(page.getByText('参与者 · 0 位', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: '从空白开始' }).check();
  await button(page, '新建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('新交付项目');
  await button(page, '选择默认参与者').click();
  const projectPicker = page.getByRole('dialog', { name: '选择默认参与者', exact: true });
  await projectPicker
    .locator('.zm-member')
    .filter({ has: page.getByText('陈宁', { exact: true }) })
    .getByRole('checkbox')
    .check();
  await button(projectPicker, '确认选择').click();
  await button(page, '保存').click();
  await expect(page.getByText('参与者 · 0 位', { exact: true })).toBeVisible();
  await button(page, '创建工作流').click();
  expect(replay.state.tasks.at(-1).participantIds).toEqual([]);
  expect(replay.state.projects.at(-1).defaultParticipantIds).toEqual(['chen']);
  expect(requests(replay, 'plan')).toHaveLength(0);
});

test('未编辑参与者时，新项目默认参与者进入原任务草稿', async ({ page, replay }) => {
  replay.state.projects[0].defaultParticipantIds = ['chen'];
  await creation(page, '按新项目人员安排工作');
  await page.getByRole('radio', { name: '从空白开始' }).check();
  await button(page, '新建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('新协作项目');
  await button(page, '选择默认参与者').click();
  const picker = page.getByRole('dialog', { name: '选择默认参与者', exact: true });
  await picker
    .locator('.zm-member')
    .filter({ has: page.getByText('林可', { exact: true }) })
    .getByRole('checkbox')
    .check();
  await button(picker, '确认选择').click();
  await button(page, '保存').click();
  await expect(page.getByText('参与者 · 1 位', { exact: true })).toBeVisible();
  await expect(button(page, '选择参与者')).toContainText('林可');
  await button(page, '创建工作流').click();
  expect(replay.state.tasks.at(-1).participantIds).toEqual(['lin']);
  expect(requests(replay, 'plan')).toHaveLength(0);
});

test('普通新建项目仍进入项目详情，不打开任务草稿', async ({ page, replay }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '工作台导航' })
    .getByRole('button', { name: /^项目/ })
    .click();
  await button(page, '＋ 新建项目').click();
  await page.getByLabel('项目名称', { exact: true }).fill('独立建项');
  await button(page, '保存').click();
  await expect(page.getByRole('dialog', { name: '创建任务' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '独立建项' })).toBeVisible();
  expect(requests(replay, 'command').map((r) => r.command.type)).toEqual(['save-project']);
});

test('默认从目标创建一次并直达规划，结果可应用编辑；刷新和重开不调用模型', async ({
  page,
  replay,
}) => {
  replay.state.participants = replay.state.participants.slice(0, 4);
  const gate = deferred();
  replay.handlers.plan = async (payload) => {
    await gate.promise;
    return proposal(payload);
  };
  try {
    await creation(page, '新增订单状态筛选和 CSV 导出', '/?strict=1');
    await expect(page.getByRole('radio', { name: /^AI 规划/ })).toBeChecked();
    await button(page, '选择参与者').click();
    const picker = page.getByRole('dialog', { name: '选择参与者', exact: true });
    await expect(picker).not.toContainText('全部通过后交接');
    await picker
      .locator('.zm-member')
      .filter({ has: page.getByText('林可', { exact: true }) })
      .getByRole('checkbox')
      .uncheck();
    await button(picker, '确认选择').click();
    await button(page, '生成计划').click();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(
      '新增订单状态筛选和 CSV 导出',
    );
    await expect(page.getByText('正在分析目标与团队能力…', { exact: true })).toBeVisible();
    await expect.poll(() => requests(replay, 'plan').length).toBe(1);
    expect(requests(replay, 'command')).toHaveLength(1);
    const created = replay.state.tasks.at(-1);
    expect(created.goal).toBe('新增订单状态筛选和 CSV 导出');
    expect(created.participantIds).toEqual(['chen', 'qa', 'frontend']);
    expect(created.status).toBe('draft');
    expect(requests(replay, 'plan')[0]).toMatchObject({
      taskId: created.id,
      expectedRevision: replay.state.revision,
      instruction: '',
    });
    gate.resolve();
    await expect(button(page, '应用草案')).toBeEnabled();
    expect(replay.state.tasks.at(-1).workflows[0].nodes).toHaveLength(0);
    await button(page, '应用草案').click();
    await page.getByLabel('节点名称', { exact: true }).fill('核对业务边界与数据范围');
    await button(page, '保存草稿').click();
    await expect(button(page, '保存草稿')).toBeDisabled();
    await button(page, '任务清单').click();
    await page.getByRole('button', { name: /^新增订单状态筛选和 CSV 导出/ }).click();
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue(
      '核对业务边界与数据范围',
    );
    await page.reload();
    await page.getByRole('button', { name: /^新增订单状态筛选和 CSV 导出/ }).click();
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue(
      '核对业务边界与数据范围',
    );
    expect(requests(replay, 'plan')).toHaveLength(1);
    expect(replay.state.tasks.filter((t) => t.id === created.id)).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});

test('规划失败保留同一草稿和参与者，重试不新建；取消迟到结果可直接转手动', async ({
  page,
  replay,
}) => {
  const gate = deferred();
  let calls = 0;
  replay.handlers.plan = async (payload) => {
    if (++calls === 1) return failure('model-unavailable', '模型暂时不可用，请稍后重试。');
    await gate.promise;
    return proposal(payload);
  };
  try {
    await creation(page, '订单失败恢复验证');
    await button(page, '生成计划').click();
    await expect(page.getByRole('alert')).toContainText('模型暂时不可用');
    const task = structuredClone(replay.state.tasks.at(-1));
    await expect(button(page, '重试规划')).toBeEnabled();
    await button(page, '重试规划').click();
    await expect.poll(() => calls).toBe(2);
    expect(requests(replay, 'command')).toHaveLength(1);
    expect(requests(replay, 'plan').map((r) => r.taskId)).toEqual([task.id, task.id]);
    await button(page, '取消').click();
    await expect(button(page, '手动编排')).toBeEnabled();
    await button(page, '手动编排').click();
    await page.getByLabel('节点名称', { exact: true }).fill('手动确认订单范围');
    gate.resolve();
    await expect
      .poll(() => replay.completed.includes(requests(replay, 'plan')[1].requestId))
      .toBe(true);
    await expect(button(page, '应用草案')).toHaveCount(0);
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('手动确认订单范围');
    await button(page, '保存草稿').click();
    await expect(button(page, '保存草稿')).toBeDisabled();
    expect(replay.state.tasks.at(-1)).toMatchObject({
      id: task.id,
      goal: task.goal,
      participantIds: task.participantIds,
    });
    expect(replay.state.tasks.at(-1).workflows[0].nodes).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});

test('创建失败不启动规划；重试复用请求和任务；离开待规划任务取消订阅', async ({ page, replay }) => {
  let saved;
  let count = 0;
  const gate = deferred();
  replay.handlers.command = async (payload) => {
    if (++count === 1) {
      saved = applyWorkbenchCommand(replay.state, payload.command);
      return failure('unavailable', '保存响应中断，请重试。');
    }
    replay.state = saved;
    return { ok: true, value: saved };
  };
  replay.handlers.plan = async (payload) => {
    await gate.promise;
    return proposal(payload);
  };
  try {
    await creation(page, '创建重试不会重复任务');
    await button(page, '生成计划').click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('保存响应中断');
    await expect(page.getByLabel('任务目标', { exact: true })).toHaveValue('创建重试不会重复任务');
    expect(requests(replay, 'plan')).toHaveLength(0);
    await button(page, '生成计划').click();
    await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('创建重试不会重复任务');
    await expect.poll(() => requests(replay, 'plan').length).toBe(1);
    expect(requests(replay, 'command')[0].requestId).toBe(requests(replay, 'command')[1].requestId);
    expect(requests(replay, 'command')[0].command.task.id).toBe(
      requests(replay, 'command')[1].command.task.id,
    );
    await button(page, '任务清单').click();
    gate.resolve();
    await expect
      .poll(() => replay.completed.includes(requests(replay, 'plan')[0].requestId))
      .toBe(true);
    await page.getByRole('button', { name: /^创建重试不会重复任务/ }).click();
    await expect(button(page, '应用草案')).toHaveCount(0);
    expect(replay.state.tasks.at(-1).workflows[0].nodes).toHaveLength(0);
    expect(requests(replay, 'plan')).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});

test('没有可用参与者时先提示；自定义路径可以创建且不调用模型', async ({ page, replay }) => {
  replay.state.participants = [];
  await creation(page, '人工整理交付说明');
  await button(page, '生成计划').click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('至少选择一位');
  expect(requests(replay, 'command')).toHaveLength(0);
  expect(requests(replay, 'plan')).toHaveLength(0);
  await page.getByRole('radio', { name: '从空白开始' }).check();
  await button(page, '创建工作流').click();
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue('人工整理交付说明');
  await button(page, '＋ 节点').click();
  await page.getByLabel('节点名称', { exact: true }).fill('整理说明');
  expect(requests(replay, 'command')).toHaveLength(1);
  expect(requests(replay, 'plan')).toHaveLength(0);
});

test('任务信息栏负责人同行，小屏长姓名整组换行；空值、选择和只读保持可访问', async ({
  page,
  replay,
}) => {
  const longName = '陈宁 · 国际订单与跨境结算业务负责人（华东区域）';
  replay.state.participants[0].name = longName;
  replay.state.tasks[0].ownerId = null;
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  const owner = button(page, '选择负责人');
  await expect(owner).toContainText('选择负责人');
  await owner.click();
  const picker = page.getByRole('dialog', { name: '选择负责人', exact: true });
  await picker.getByLabel('搜索参与者', { exact: true }).fill('国际订单');
  await picker.getByRole('radio').check();
  await button(picker, '确认选择').click();
  await expect(owner).toContainText(longName);
  for (const width of [1440, 420]) {
    await page.setViewportSize({ width, height: 700 });
    const labelBox = await page.locator('.zm-task-meta .zm-field-label').boundingBox();
    const buttonBox = await owner.boundingBox();
    expect(
      Math.abs(labelBox.y + labelBox.height / 2 - buttonBox.y - buttonBox.height / 2),
    ).toBeLessThan(2);
    expect(buttonBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
    expect(buttonBox.height).toBeLessThan(40);
  }
  page.on('dialog', (dialog) => dialog.accept());
  replay.state.tasks[0].ownerId = 'chen';
  replay.state.tasks[0].status = 'ready';
  await page.reload();
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await expect(owner).toHaveCount(0);
  await expect(page.locator('.zm-task-owner-readonly')).toContainText(longName);
  await expect(page.locator('.zm-task-owner-readonly b')).toHaveAttribute('title', longName);
  const readOnlyBox = await page.locator('.zm-task-owner-readonly').boundingBox();
  expect(readOnlyBox.x + readOnlyBox.width).toBeLessThanOrEqual(420);
  expect(readOnlyBox.height).toBeLessThan(40);
  expect(requests(replay, 'command')).toHaveLength(0);
  expect(requests(replay, 'plan')).toHaveLength(0);
});

test('创建保存期间卸载并重挂载：迟到响应仅保留草稿，下一次明确创建才规划', async ({
  page,
  replay,
}) => {
  const gate = deferred();
  let count = 0;
  replay.handlers.command = async (payload) => {
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    const committed = structuredClone(replay.state);
    if (++count === 1) await gate.promise;
    return { ok: true, value: committed };
  };
  replay.handlers.plan = async (payload) => proposal(payload);
  try {
    await creation(page, '切出前保存的草稿', '/?strict=1&mount-probe=1');
    await button(page, '生成计划').click();
    await expect.poll(() => count).toBe(1);
    // Simulate the host replacing its active panel, outside the native modal's pointer scope.
    await button(page, '切出工作台').evaluate((element) => element.click());
    await expect(page.getByRole('heading', { name: '任务清单', exact: true })).toHaveCount(0);
    await button(page, '返回工作台').click();
    await expect(page.getByRole('button', { name: /^切出前保存的草稿/ })).toBeVisible();
    const response = page.waitForResponse((r) => r.url().endsWith('/api/zhuma/command'));
    gate.resolve();
    await (await response).finished();
    // Observe the absence of the stale continuation after the delayed response settles.
    await page.waitForTimeout(150);
    expect(requests(replay, 'plan')).toHaveLength(0);
    await expect(page.getByRole('heading', { name: '任务清单', exact: true })).toBeVisible();
    expect(replay.state.tasks.filter((t) => t.title === '切出前保存的草稿')).toHaveLength(1);
    await button(page, '＋ 创建任务').click();
    await page.getByLabel('任务目标', { exact: true }).fill('重新进入后的明确新任务');
    await button(page, '生成计划').click();
    await expect(button(page, '应用草案')).toBeEnabled();
    expect(requests(replay, 'plan')).toHaveLength(1);
    expect(requests(replay, 'plan')[0].taskId).toBe(replay.state.tasks.at(-1).id);
    expect(count).toBe(2);
  } finally {
    gate.resolve();
  }
});
