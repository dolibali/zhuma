import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, plannedWorkflows, proposal } from './replay.mjs';

const dependencies = [[], [0], [0, 1], [0, 1, 2], [0, 2, 3], [0, 1, 3, 4]];
async function openGraph(page, replay, { spacing = 360, all = true } = {}) {
  replay.state.tasks[0].workflows = [
    {
      ...plannedWorkflows()[0],
      nodes: plannedWorkflows()[0]
        .nodes.slice(0, 6)
        .map((node, i) => ({
          ...node,
          position: { x: i * spacing, y: 0 },
          dependsOn: dependencies[i].map((id) => `node-${id}`),
        })),
    },
  ];
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await expect(page.getByRole('button', { name: '执行顺序 5' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  if (all) {
    await page.getByRole('button', { name: '全部依赖 13' }).click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(13);
  }
}

// Read actual SVG curves in screen coordinates, not just the router's model points.
async function graphViolations(page) {
  return page.locator('.zm-canvas .react-flow').evaluate((surface) => {
    const view = surface.getBoundingClientRect();
    const errors = [];
    const cards = [...surface.querySelectorAll('.react-flow__node')].map((node) => ({
      id: node.dataset.id,
      rect: node.getBoundingClientRect(),
      ports: [...node.querySelectorAll('.react-flow__handle')].map((port) => {
        const r = port.getBoundingClientRect();
        return {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          side: port.classList.contains('react-flow__handle-right') ? 'right' : 'left',
        };
      }),
    }));
    const visible = (p) =>
      p.x >= view.left - 1 &&
      p.x <= view.right + 1 &&
      p.y >= view.top - 1 &&
      p.y <= view.bottom + 1;
    for (const card of cards) {
      for (const other of cards.filter((c) => c !== card)) {
        const a = card.rect,
          b = other.rect;
        if (
          Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
          Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
        )
          errors.push(`overlap ${card.id}/${other.id}`);
        for (const port of card.ports)
          if (
            port.x > b.left + 1 &&
            port.x < b.right - 1 &&
            port.y > b.top + 1 &&
            port.y < b.bottom - 1
          )
            errors.push(`covered port ${card.id}/${other.id}`);
      }
      if (
        !visible({ x: card.rect.left, y: card.rect.top }) ||
        !visible({ x: card.rect.right, y: card.rect.bottom })
      )
        errors.push(`clipped ${card.id}`);
    }
    for (const path of surface.querySelectorAll('.react-flow__edge-path')) {
      const id = path.closest('.react-flow__edge').dataset.id;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!matrix || !length) {
        errors.push(`unmeasured ${id}`);
        continue;
      }
      for (const [distance, side] of [
        [0, 'right'],
        [length, 'left'],
      ]) {
        const point = path.getPointAtLength(distance).matrixTransform(matrix);
        if (
          !cards.some((card) =>
            card.ports.some(
              (port) => port.side === side && Math.hypot(port.x - point.x, port.y - point.y) < 3,
            ),
          )
        )
          errors.push(`detached ${side} port ${id}`);
      }
      for (let distance = 0; distance <= length; distance += Math.max(1, length / 600)) {
        const p = path.getPointAtLength(distance).matrixTransform(matrix);
        if (!visible(p)) {
          errors.push(`clipped edge ${id}`);
          break;
        }
        const hit = cards.find(
          ({ rect: r }) =>
            p.x > r.left + 1 && p.x < r.right - 1 && p.y > r.top + 1 && p.y < r.bottom - 1,
        );
        if (hit) {
          errors.push(`${id} crosses ${hit.id}`);
          break;
        }
      }
    }
    return errors;
  });
}

async function shot(page, info, name) {
  if (!process.env.ZHUMA_WORKFLOW_EVIDENCE_DIR) return;
  const dir = resolve(process.env.ZHUMA_WORKFLOW_EVIDENCE_DIR);
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}-${info.project.name}.png`) });
}
const positions = (page) =>
  page
    .locator('.react-flow__node')
    .evaluateAll((nodes) =>
      Object.fromEntries(nodes.map((node) => [node.dataset.id, node.style.transform])),
    );

for (const width of [1320, 1060])
  test(`真实AI相同的220px密集坐标在预览、应用、子流与工作树共用清楚的卡片和端口几何 ${width}px`, async ({
    page,
    replay,
  }, info) => {
    await page.setViewportSize({ width, height: 860 });
    const root = {
      ...plannedWorkflows()[0],
      nodes: plannedWorkflows()[0]
        .nodes.slice(0, 6)
        .map((node, i) => ({
          ...node,
          position: { x: i * 220, y: 0 },
          dependsOn: dependencies[i].map((id) => `node-${id}`),
        })),
    };
    const child = {
      id: 'child',
      name: '接口实现子工作流',
      parentNodeId: 'node-2',
      nodes: root.nodes.slice(0, 3).map((node, i) => ({
        ...node,
        id: `child-${i}`,
        title: `实现与验证 ${i + 1}`,
        position: { x: 0, y: 0 },
        dependsOn: i ? [`child-${i - 1}`] : [],
      })),
    };
    const workflows = [root, child];
    replay.handlers.plan = (payload) =>
      proposal(payload, workflows, '密集坐标响应夹具，不调用模型。');
    await page.goto('/');
    await page.getByRole('button', { name: /^订单协作改进/ }).click();
    await page.getByRole('button', { name: '✧ AI 规划', exact: true }).click();
    await page.getByRole('button', { name: '生成工作流草案', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(6);
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `ai-preview-dense-${width}`);
    await page.getByRole('button', { name: '整理布局', exact: true }).click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(0);
    await page.getByRole('button', { name: '应用草案', exact: true }).click();
    await expect(page.getByRole('button', { name: '应用草案', exact: true })).toHaveCount(0);
    expect(replay.state.tasks[0].workflows).toEqual(workflows);
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `ai-applied-dense-${width}`);
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `ai-applied-inspector-closed-${width}`);
    await page
      .locator('.zm-workflow-tools')
      .getByRole('button', { name: '配置', exact: true })
      .click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await page.locator('.react-flow__node[data-id="node-2"]').click();
    await page.getByRole('button', { name: '打开子工作流', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await page.getByRole('button', { name: '适应全图', exact: true }).click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `child-overlapping-input-${width}`);
    await page.getByRole('button', { name: '工作树定位', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(9);
    await expect(page.getByRole('button', { name: '执行顺序 8', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: '适应全图', exact: true }).click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `tree-real-geometry-${width}`);
    await page.getByRole('button', { name: '全部依赖 16', exact: true }).click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(16);
    await expect.poll(() => graphViolations(page)).toEqual([]);
    await shot(page, info, `tree-all-dependencies-${width}`);
    await page.getByRole('button', { name: '上一级', exact: false }).click();
    await page.getByRole('button', { name: '工作流', exact: true }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(6);
    await page.getByRole('button', { name: '适应全图', exact: true }).click();
    await expect.poll(() => graphViolations(page)).toEqual([]);
    expect(replay.state.tasks[0].workflows).toEqual(workflows);
    expect(replay.requests.filter((r) => r.endpoint === 'plan')).toHaveLength(1);
  });

test('密集初始布局不自动保存，拖拽碰撞只避让被拖卡片，明确整理可保存', async ({
  page,
  replay,
}, info) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await openGraph(page, replay, { spacing: 220, all: false });
  await expect.poll(() => graphViolations(page)).toEqual([]);
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(replay.state.tasks[0].workflows[0].nodes.map((n) => n.position.x)).toEqual([
    0, 220, 440, 660, 880, 1100,
  ]);
  const before = await positions(page);
  const a = await page.locator('.react-flow__node[data-id="node-0"]').boundingBox();
  const b = await page.locator('.react-flow__node[data-id="node-1"]').boundingBox();
  await page.mouse.move(b.x + 25, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(a.x + 25, a.y + 20, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  const after = await positions(page);
  for (const id of Object.keys(before).filter((id) => id !== 'node-1'))
    expect(after[id]).toBe(before[id]);
  await page.getByRole('button', { name: '适应全图', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  await page.getByRole('button', { name: '整理布局', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  await shot(page, info, 'explicit-arrange-draft');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(1);
  expect(replay.state.tasks[0].workflows[0].nodes.map((n) => n.dependsOn)).toEqual(
    dependencies.map((ds) => ds.map((i) => `node-${i}`)),
  );
});

test('健康人工坐标不随侧栏重排，已确认计划整理仅改变当前视图', async ({ page, replay }) => {
  await page.setViewportSize({ width: 1320, height: 860 });
  await openGraph(page, replay, { all: false });
  await expect.poll(() => graphViolations(page)).toEqual([]);
  const before = await positions(page);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  expect(await positions(page)).toEqual(before);
  await page
    .locator('.zm-workflow-tools')
    .getByRole('button', { name: '配置', exact: true })
    .click();
  expect(await positions(page)).toEqual(before);
  await page.getByRole('button', { name: '确认工作流', exact: true }).click();
  await expect.poll(() => replay.state.appliedPlans.length).toBe(1);
  const fixed = structuredClone(replay.state);
  await page.getByRole('button', { name: '整理布局', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  expect(await positions(page)).not.toEqual(before);
  expect(replay.state).toEqual(fixed);
  expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(1);
});

test('十三条真实依赖避开卡片，全图与侧栏及独立控件不遮挡', async ({ page, replay }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openGraph(page, replay);
  await expect.poll(() => graphViolations(page)).toEqual([]);
  const surface = await page.locator('.zm-canvas-surface').boundingBox();
  const dock = await page.getByRole('toolbar', { name: '工作流视图', exact: true }).boundingBox();
  expect(dock.y).toBeGreaterThanOrEqual(surface.y + surface.height - 1);
  await expect(page.getByRole('button', { name: '全部依赖 13' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const full = page.getByRole('button', { name: '全部依赖 13' });
  await page.getByRole('button', { name: '执行顺序 5' }).press('Enter');
  await expect(page.locator('.react-flow__edge-path[marker-end]')).toHaveCount(5);
  await full.press('Enter');
  // Selection emphasizes incident edges without dropping the other dependencies.
  await page.locator('.react-flow__node[data-id="node-2"]').click();
  await expect(page.locator('.react-flow__edge-path[style*="stroke-width: 2.5"]')).toHaveCount(4);
  await expect(page.locator('.react-flow__edge-path[marker-end]')).toHaveCount(13);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  await page
    .locator('.zm-workflow-tools')
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(0);
});

test('主动缩放、定位和拖动后保持视口，适应全图可恢复且依赖可删除重连', async ({ page, replay }) => {
  await openGraph(page, replay);
  await expect.poll(() => graphViolations(page)).toEqual([]);
  const viewport = page.locator('.react-flow__viewport');
  const initial = await viewport.getAttribute('style');
  await page.getByRole('button', { name: '放大画布', exact: true }).click();
  await expect(viewport).not.toHaveAttribute('style', initial);
  const zoomed = await viewport.getAttribute('style');
  const pane = await page.locator('.react-flow__pane').boundingBox();
  await page.mouse.move(pane.x + 20, pane.y + 20);
  await page.mouse.down();
  await page.mouse.move(pane.x + 65, pane.y + 40, { steps: 4 });
  await page.mouse.up();
  await expect(viewport).not.toHaveAttribute('style', zoomed);
  const manual = await viewport.getAttribute('style');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', manual);
  await page
    .locator('.zm-workflow-tools')
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect(viewport).toHaveAttribute('style', manual);
  await page.getByRole('button', { name: '定位当前', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: '工作流视图' })).toContainText('100%');
  const located = await viewport.getAttribute('style');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(viewport).toHaveAttribute('style', located);
  await page.getByRole('button', { name: '适应全图', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);

  const first = page.locator('.react-flow__node[data-id="node-0"]');
  const before = await first.boundingBox();
  await page.mouse.move(before.x + 30, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 30, before.y + 95, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '适应全图', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(13);
  const edgePoint = await page
    .locator('.react-flow__edge[data-id="node-0-node-1"] .react-flow__edge-path')
    .evaluate((path) => {
      for (let t = 0.15; t <= 0.85; t += 0.05) {
        const point = path
          .getPointAtLength(path.getTotalLength() * t)
          .matrixTransform(path.getScreenCTM());
        if (
          document.elementFromPoint(point.x, point.y)?.closest('.react-flow__edge')?.dataset.id ===
          'node-0-node-1'
        )
          return { x: point.x, y: point.y };
      }
      return null;
    });
  expect(edgePoint, 'the dependency must expose a pointer-accessible segment').not.toBeNull();
  await page.mouse.dblclick(edgePoint.x, edgePoint.y);
  await expect(page.locator('.react-flow__edge')).toHaveCount(12);
  await first
    .locator('.react-flow__handle-right')
    .dragTo(page.locator('.react-flow__node[data-id="node-1"] .react-flow__handle-left'));
  await expect(page.locator('.react-flow__edge')).toHaveCount(13);
  await page.getByRole('button', { name: '适应全图', exact: true }).click();
  await expect.poll(() => graphViolations(page)).toEqual([]);
  expect(replay.requests.filter((r) => r.endpoint === 'command')).toHaveLength(0);
});
