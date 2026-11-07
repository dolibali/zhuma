import { test, expect, plannedWorkflows } from './replay.mjs';

const dependencies = [[], [0], [0, 1], [0, 1, 2], [0, 2, 3], [0, 1, 3, 4]];
async function openGraph(page, replay) {
  replay.state.tasks[0].workflows = [
    {
      ...plannedWorkflows()[0],
      nodes: plannedWorkflows()[0]
        .nodes.slice(0, 6)
        .map((node, i) => ({
          ...node,
          position: { x: i * 360, y: 0 },
          dependsOn: dependencies[i].map((id) => `node-${id}`),
        })),
    },
  ];
  await page.goto('/');
  await page.getByRole('button', { name: /^订单协作改进/ }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await expect(page.locator('.react-flow__edge')).toHaveCount(13);
}

// Read actual SVG curves in screen coordinates, not just the router's model points.
async function graphViolations(page) {
  return page.locator('.zm-canvas .react-flow').evaluate((surface) => {
    const view = surface.getBoundingClientRect();
    const errors = [];
    const cards = [...surface.querySelectorAll('.react-flow__node')].map((node) => ({
      id: node.dataset.id,
      rect: node.getBoundingClientRect(),
    }));
    const visible = (p) =>
      p.x >= view.left - 1 &&
      p.x <= view.right + 1 &&
      p.y >= view.top - 1 &&
      p.y <= view.bottom + 1;
    for (const card of cards) {
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

test('十三条真实依赖避开卡片，全图与侧栏及独立控件不遮挡', async ({ page, replay }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openGraph(page, replay);
  await expect.poll(() => graphViolations(page)).toEqual([]);
  const surface = await page.locator('.zm-canvas-surface').boundingBox();
  const dock = await page.getByRole('toolbar', { name: '工作流视图', exact: true }).boundingBox();
  expect(dock.y).toBeGreaterThanOrEqual(surface.y + surface.height - 1);
  await expect(page.getByText('13 条连线', { exact: true })).toBeVisible();
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
