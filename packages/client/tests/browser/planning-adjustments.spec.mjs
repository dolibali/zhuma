import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { test, expect, deferred, failure, plannedWorkflows, proposal } from './replay.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const plans = (replay) => replay.requests.filter((r) => r.endpoint === 'plan');
const commands = (replay) => replay.requests.filter((r) => r.endpoint === 'command');
test('仅调整执行者发送明确字段范围，保留本节点的评审、资源和交付', async ({ page, replay }) => {
  const before = workflows();
  replay.state.tasks[0].workflows = structuredClone(before);
  const after = structuredClone(before);
  after[0].nodes[0].assigneeId = 'lin';
  replay.handlers.plan = (payload) => proposal(payload, after);
  await open(page);
  await scope(page, '仅当前节点执行者');
  await button(page, '调整执行者').click();
  await expect(page.getByRole('region', { name: '变更预览', exact: true })).toContainText('林可');
  expect(plans(replay)[0].adjustment).toEqual({
    nodeId: 'node-0',
    fields: ['assigneeId', 'rationale'],
  });
  expect(commands(replay)).toHaveLength(0);
  await button(page, '应用草案').click();
  await expect(button(page, '应用草案')).toHaveCount(0);
  expect(replay.state.tasks[0].workflows).toEqual(after);
});

function workflows() {
  const flows = plannedWorkflows();
  flows[0].nodes = flows[0].nodes.slice(0, 3);
  flows[0].nodes[1].output = '人工已确认的字段映射和交付清单';
  flows.push({
    id: 'nested',
    name: '字段核对子工作流',
    parentNodeId: 'node-1',
    nodes: [
      {
        ...structuredClone(flows[0].nodes[0]),
        id: 'nested-node',
        title: '核对特殊订单',
        dependsOn: [],
      },
    ],
  });
  return flows;
}
async function open(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await button(page, '✧ AI 规划').click();
}
async function scope(page, label) {
  await page.getByLabel('调整范围', { exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('局部规划显示重要前后值和定位；切换原稿不写入，明确应用且双击只保存一次', async ({
  page,
  replay,
}, info) => {
  const before = workflows();
  replay.state.tasks[0].workflows = structuredClone(before);
  const after = structuredClone(before);
  after[0].nodes[0].assigneeId = 'lin';
  after[0].nodes[0].output = '业务边界说明和接口交付清单';
  replay.handlers.plan = (payload) =>
    proposal(payload, after, '更新当前节点的分工和交付，保留其余人工配置。');
  const gate = deferred();
  replay.handlers.command = async (payload) => {
    await gate.promise;
    replay.state = applyWorkbenchCommand(replay.state, payload.command);
    return { ok: true, value: replay.state };
  };
  try {
    await open(page);
    await scope(page, '仅当前节点配置');
    await page.getByLabel('补充要求', { exact: true }).fill('这一步交给林可，补齐交付清单。');
    await button(page, '调整节点配置').click();
    const changes = page.getByRole('region', { name: '变更预览', exact: true });
    await expect(changes).toContainText('执行者');
    await expect(changes).toContainText('陈宁');
    await expect(changes).toContainText('林可');
    await expect(changes).toContainText('可复核的交付记录');
    await expect(changes).toContainText('业务边界说明和接口交付清单');
    expect(plans(replay)[0].adjustment.nodeId).toBe('node-0');
    expect(commands(replay)).toHaveLength(0);
    expect(replay.state.tasks[0].workflows).toEqual(before);
    await button(changes, '定位节点').click();
    await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'node-0');
    await button(page, '调整前').click();
    await expect(page.locator('.react-flow__node[data-id="node-0"]')).toContainText('陈宁');
    await expect(button(page, '应用草案')).toBeDisabled();
    await button(page, '规划结果').click();
    await expect(page.locator('.react-flow__node[data-id="node-0"]')).toContainText('林可');
    if (process.env.PLANQ_EVIDENCE_DIR) {
      await mkdir(process.env.PLANQ_EVIDENCE_DIR, { recursive: true });
      await changes.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(process.env.PLANQ_EVIDENCE_DIR, `after-${info.project.name}.png`),
      });
    }
    await button(page, '应用草案').dblclick();
    await expect.poll(() => commands(replay).length).toBe(1);
    gate.resolve();
    await expect(button(page, '应用草案')).toHaveCount(0);
    expect(replay.state.tasks[0].workflows).toEqual(after);
    await page.reload();
    await page.getByRole('button', { name: /^订单协作改进/ }).click();
    expect(commands(replay)).toHaveLength(1);
    await expect(button(page, '选择执行者')).toContainText('林可');
  } finally {
    gate.resolve();
  }
});

test('连续局部调整对比上一份未应用草案；失败取消及迟到响应保留原草案', async ({ page, replay }) => {
  const before = workflows();
  replay.state.tasks[0].workflows[0].nodes = [];
  const after = structuredClone(before);
  after[0].nodes[0].assigneeId = 'lin';
  const gate = deferred();
  let calls = 0;
  replay.handlers.plan = async (payload) => {
    calls++;
    if (calls === 1) return proposal(payload, before);
    if (calls === 2) return proposal(payload, after, '只调整这一步的执行者。');
    if (calls === 3) return failure('invalid-plan', '结果仍超出指定节点的调整范围。');
    await gate.promise;
    return proposal(payload, before, '不应出现的迟到结果');
  };
  try {
    await open(page);
    await button(page, '生成工作流草案').click();
    await expect(button(page, '应用草案')).toBeEnabled();
    await scope(page, '仅当前节点配置');
    await button(page, '调整节点配置').click();
    const changes = page.getByRole('region', { name: '变更预览', exact: true });
    await expect(changes).toContainText('与上一份草案比较');
    await expect(changes).toContainText('陈宁');
    await expect(changes).toContainText('林可');
    expect(plans(replay)[1].baseProposalId).toBe(plans(replay)[0].requestId);
    await button(page, '调整前').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__node[data-id="node-0"]')).toContainText('陈宁');
    await expect(button(page, '调整节点配置')).toBeDisabled();
    await button(page, '规划结果').click();
    await button(page, '调整节点配置').click();
    await expect(page.getByRole('alert')).toContainText('超出指定节点');
    await expect(changes).toContainText('林可');
    await button(page, '调整节点配置').click();
    await expect.poll(() => calls).toBe(4);
    await button(page, '取消').click();
    gate.resolve();
    await expect.poll(() => replay.completed.includes(plans(replay)[3].requestId)).toBe(true);
    await expect(changes).toContainText('林可');
    await expect(page.getByText('不应出现的迟到结果', { exact: true })).toHaveCount(0);
    await expect(button(page, '应用草案')).toBeEnabled();
    expect(commands(replay)).toHaveLength(0);
    expect(
      plans(replay)
        .slice(2)
        .map((p) => p.baseProposalId),
    ).toEqual([plans(replay)[1].requestId, plans(replay)[1].requestId]);
  } finally {
    gate.resolve();
  }
});

test('整体规划明确展示删除与新节点；可定位删除前内容，没有变化时禁止重复应用', async ({
  page,
  replay,
}) => {
  const before = workflows();
  replay.state.tasks[0].workflows = structuredClone(before);
  const after = structuredClone(before);
  after[0].nodes[2].id = 'replacement';
  after[0].nodes[2].title = '补充回归检查';
  let calls = 0;
  replay.handlers.plan = (payload) => proposal(payload, ++calls === 1 ? after : before);
  await open(page);
  await button(page, '生成工作流草案').click();
  const changes = page.getByRole('region', { name: '变更预览', exact: true });
  await expect(changes).toContainText('删除 1');
  await expect(changes).toContainText('新增 1');
  await changes
    .locator('details')
    .filter({ hasText: '订单交付工作 3' })
    .getByRole('button', { name: '查看原节点' })
    .click();
  await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', 'node-2');
  await expect(button(page, '应用草案')).toBeDisabled();
  await button(page, '规划结果').click();
  await button(page, '重新规划').click();
  await expect(button(page, '应用草案')).toBeDisabled();
  expect(commands(replay)).toHaveLength(0);
});

test('小窗口长内容可滚动核对；保留未保存的人工修改作为局部规划基线', async ({ page, replay }) => {
  await page.setViewportSize({ width: 720, height: 600 });
  const before = workflows();
  replay.state.tasks[0].workflows = structuredClone(before);
  replay.handlers.plan = (payload) => {
    const result = structuredClone(replay.state.tasks[0].workflows);
    result[0].nodes[0].output = '新的接口交付说明。'.repeat(90);
    return proposal(payload, result);
  };
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await button(page, '配置').click();
  await page.getByLabel('交付内容', { exact: true }).fill('人工编辑的交付内容');
  await page.keyboard.press('Escape');
  await button(page, '✧ AI 规划').click();
  await scope(page, '仅当前节点配置');
  await button(page, '调整节点配置').click();
  const changes = page.getByRole('region', { name: '变更预览', exact: true });
  await expect(changes).toContainText('人工编辑的交付内容');
  await changes.scrollIntoViewIfNeeded();
  await expect(button(page, '应用草案')).toBeInViewport();
  expect(commands(replay)).toHaveLength(1);
  expect(replay.state.tasks[0].workflows[0].nodes[0].output).toBe('人工编辑的交付内容');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
