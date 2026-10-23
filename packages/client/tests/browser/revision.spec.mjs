import { expect, test } from './replay.mjs';

const reviewedText = '被评审的正文-4e1';

function node(id, goal) {
  return {
    nodeId: id,
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    version: 2,
    status: 'needs-revision',
    goal,
    expectedOutput: '说明',
    assigneeId: 'chen',
    reviewerIds: ['lin'],
    artifacts: [],
    rounds: [],
    comments: [],
  };
}

test.beforeEach(async ({ page, replay }) => {
  const items = Array.from({ length: 11 }, (_, index) => ({
    id: `inbox-${index}`,
    kind: 'deliver',
    actorId: 'chen',
    nodeId: `node-${index}`,
    taskId: 'task',
    reason: index === 10 ? 'revision-delivery' : 'assignee-delivery',
    action: index === 10 ? 'revise' : 'submit',
  }));
  replay.handlers.draft = async () => ({
    ok: true,
    value: { version: 0, text: '', links: [], files: [] },
  });
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'chen',
      items,
      nodes: items.map((item, index) => node(item.nodeId, `待办目标 ${index}`)),
    },
  });
  replay.handlers.revision = async () => ({
    ok: true,
    value: {
      view: {
        reviewed: { id: 'artifact-2', version: 2, text: reviewedText, links: [], files: [] },
        previous: { id: 'artifact-1', version: 1, text: '上一版正文-4e1', links: [], files: [] },
        notes: [
          {
            id: 'return-1',
            reviewerName: '林夏',
            body: '请补充错误码',
            artifactVersionId: 'artifact-2',
            citedCommentIds: [],
          },
        ],
      },
    },
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await page.getByRole('button', { name: '提交新版本', exact: true }).click();
});

test('待办多项时提交新版本会滚到被评审版本并聚焦', async ({ page }) => {
  const reviewed = page.locator('#revision-reviewed');
  await expect(reviewed).toBeVisible();
  await expect(reviewed).toBeInViewport();
  await expect(reviewed).toBeFocused();
  await expect(reviewed).toContainText(reviewedText);
});

test('执行区挂着退回面板', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '对照意见修改' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '林夏', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'lin', exact: true })).toHaveCount(0);
  await expect(page.getByText(reviewedText)).toBeVisible();
});

test('打开退回会请求 revision', async ({ replay }) => {
  await expect.poll(() => replay.requests.some((item) => item.endpoint === 'revision')).toBe(true);
});

test('查看上一版后定位到对应内容会回到被评审版本', async ({ page }) => {
  await page.getByRole('button', { name: '查看上一版', exact: true }).click();
  await expect(page.locator('#revision-reviewed')).toBeHidden();
  await page.getByRole('link', { name: '定位到对应内容', exact: true }).click();
  const reviewed = page.locator('#revision-reviewed');
  await expect(reviewed).toBeVisible();
  await expect(reviewed).toBeFocused();
});
