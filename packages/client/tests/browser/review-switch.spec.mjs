import { deferred, expect, test } from './replay.mjs';

function reviewNode(nodeId, goal, roundId) {
  return {
    nodeId,
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    version: 2,
    status: 'in-review',
    goal,
    expectedOutput: '说明',
    assigneeId: 'chen',
    reviewerIds: ['lin'],
    currentRoundId: roundId,
    artifacts: [{ id: `artifact-${roundId}`, version: 1, text: goal }],
    rounds: [
      {
        id: roundId,
        status: 'open',
        artifactVersionId: `artifact-${roundId}`,
        reviewerIds: ['lin'],
        ballots: [],
      },
    ],
    comments: [],
  };
}

const design = reviewNode('design', '设计登录', 'round-a');
const publish = reviewNode('publish', '发布说明', 'round-b');
const notes = {
  ...reviewNode('notes', '补充材料', 'round-notes'),
  status: 'ready',
  currentRoundId: undefined,
  rounds: [],
  artifacts: [],
};

function inboxItem(id, nodeId, action) {
  return {
    id,
    kind: action === 'review' ? 'review' : 'deliver',
    actorId: 'lin',
    nodeId,
    taskId: 'task',
    reason: action === 'review' ? 'review-required' : 'assignee-delivery',
    action,
  };
}

function applied(node) {
  return { ok: true, value: { disposition: 'applied', node } };
}

async function openGoal(page, goal) {
  await page.getByRole('article', { name: goal }).getByRole('button').click();
}

test('切到下一项后再通过，不会带上一项的意见', async ({ page, replay }) => {
  const ballots = [];
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'lin',
      items: [
        inboxItem('review-a', 'design', 'review'),
        inboxItem('review-b', 'publish', 'review'),
      ],
      nodes: [design, publish],
    },
  });
  replay.handlers.ballot = async (payload) => {
    ballots.push(payload);
    return applied(payload.nodeId === 'publish' ? publish : design);
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openGoal(page, '设计登录');
  await page.getByLabel('评审意见').fill('甲的意见');
  await openGoal(page, '发布说明');
  await expect(page.getByLabel('评审意见')).toHaveValue('');
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(1);
  expect(ballots[0].nodeId).toBe('publish');
  expect(ballots[0].roundId).toBe('round-b');
  expect(ballots[0].action).toBe('approve');
  expect(ballots[0].comment).toBeUndefined();
  await expect(page.getByRole('heading', { name: '评审交付' })).toHaveCount(0);
});

test('上一项的评论回执回来时，当前项的选择和意见还在', async ({ page, replay }) => {
  const first = deferred();
  const second = deferred();
  const ballots = [];
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'lin',
      items: [
        inboxItem('review-a', 'design', 'review'),
        inboxItem('review-b', 'publish', 'review'),
      ],
      nodes: [design, publish],
    },
  });
  replay.handlers.ballot = async (payload) => {
    ballots.push(payload);
    if (ballots.length === 1) await first.promise;
    else await second.promise;
    return applied(payload.nodeId === 'publish' ? publish : design);
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openGoal(page, '设计登录');
  await page.getByLabel('评审意见').fill('甲的意见');
  await page.getByRole('button', { name: '仅评论', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(1);
  await openGoal(page, '发布说明');
  await page.getByLabel('评审意见').fill('乙的意见');
  await page.getByRole('button', { name: '通过', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(2);
  first.resolve();
  const form = page.locator('section.zm-config-form');
  await expect(page.getByRole('heading', { name: '评审交付' })).toHaveCount(1);
  await expect(page.getByLabel('评审意见')).toHaveValue('乙的意见');
  await expect(form.locator('button[aria-busy="true"]')).toHaveCount(3);
  expect(ballots[1].nodeId).toBe('publish');
  expect(ballots[1].roundId).toBe('round-b');
  expect(ballots[1].comment).toBe('乙的意见');
  expect(ballots[1].idempotencyKey).not.toBe(ballots[0].idempotencyKey);
  second.resolve();
  await expect(page.getByRole('heading', { name: '评审交付' })).toHaveCount(0);
});

test('上一项失败回来时，不改当前项的意见、错误和提交中状态', async ({ page, replay }) => {
  const first = deferred();
  const second = deferred();
  const ballots = [];
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'lin',
      items: [
        inboxItem('review-a', 'design', 'review'),
        inboxItem('review-b', 'publish', 'review'),
      ],
      nodes: [design, publish],
    },
  });
  replay.handlers.ballot = async (payload) => {
    ballots.push(payload);
    if (ballots.length === 1) {
      await first.promise;
      return {
        ok: false,
        error: { code: 'conflict', message: '甲的评审没有提交。', details: {} },
      };
    }
    await second.promise;
    return {
      ok: false,
      error: { code: 'conflict', message: '乙的评审没有提交。', details: {} },
    };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openGoal(page, '设计登录');
  await page.getByLabel('评审意见').fill('甲的意见');
  await page.getByRole('button', { name: '仅评论', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(1);
  await openGoal(page, '发布说明');
  await page.getByLabel('评审意见').fill('乙的意见');
  await page.getByRole('button', { name: '仅评论', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(2);
  first.resolve();
  const form = page.locator('section.zm-config-form');
  await expect(page.getByLabel('评审意见')).toHaveValue('乙的意见');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(form.locator('button[aria-busy="true"]')).toHaveCount(3);
  second.resolve();
  await expect(page.getByRole('alert')).toHaveText('乙的评审没有提交。');
  await expect(page.getByLabel('评审意见')).toHaveValue('乙的意见');
  await expect(form.locator('button[aria-busy="true"]')).toHaveCount(0);
});

test('离开评审后，旧的成功回执不清掉当前页面', async ({ page, replay }) => {
  const late = deferred();
  const ballots = [];
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'lin',
      items: [
        inboxItem('review-a', 'design', 'review'),
        inboxItem('deliver-notes', 'notes', 'submit'),
      ],
      nodes: [design, notes],
    },
  });
  replay.handlers.draft = async () => ({
    ok: true,
    value: { version: 0, text: '', links: [], files: [] },
  });
  replay.handlers.ballot = async (payload) => {
    ballots.push(payload);
    await late.promise;
    return applied(design);
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openGoal(page, '设计登录');
  await page.getByLabel('评审意见').fill('甲的意见');
  await page.getByRole('button', { name: '仅评论', exact: true }).click();
  await expect.poll(() => ballots.length).toBe(1);
  await openGoal(page, '补充材料');
  await expect(page.getByRole('heading', { name: '提交交付' })).toHaveCount(1);
  late.resolve();
  await expect(page.getByRole('heading', { name: '提交交付' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '评审交付' })).toHaveCount(0);
  await expect(page.getByLabel('交付说明')).toHaveValue('');
});
