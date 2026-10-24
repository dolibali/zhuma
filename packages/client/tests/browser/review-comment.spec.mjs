import assert from 'node:assert/strict';
import { expect, test } from './replay.mjs';

test('评审可以只评论，不把评论当成通过或退回', async ({ page, replay }) => {
  const node = {
    nodeId: 'design',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    version: 2,
    status: 'in-review',
    goal: '设计登录接口',
    expectedOutput: '说明',
    assigneeId: 'chen',
    reviewerIds: ['lin'],
    currentRoundId: 'round-1',
    artifacts: [{ id: 'artifact-1', version: 1, text: '初稿' }],
    rounds: [
      {
        id: 'round-1',
        status: 'open',
        artifactVersionId: 'artifact-1',
        reviewerIds: ['lin'],
        ballots: [],
      },
    ],
    comments: [],
  };
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'lin',
      items: [
        {
          id: 'inbox-1',
          kind: 'review',
          actorId: 'lin',
          nodeId: 'design',
          taskId: 'task',
          reason: 'review-required',
          action: 'review',
        },
      ],
      nodes: [node],
    },
  });
  replay.handlers.ballot = async (payload) => {
    assert.equal(payload.action, 'comment');
    return {
      ok: true,
      value: {
        disposition: 'applied',
        node: { ...node, status: 'in-review' },
      },
    };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await page.getByRole('button', { name: '提交评审', exact: true }).click();
  await page.getByLabel('评审意见').fill('先记一笔-4e1');
  await page.getByRole('button', { name: '仅评论', exact: true }).click();
  await expect.poll(() => replay.requests.some((item) => item.endpoint === 'ballot')).toBe(true);
  const ballot = replay.requests.find((item) => item.endpoint === 'ballot');
  expect(ballot.action).toBe('comment');
  expect(ballot.comment).toBe('先记一笔-4e1');
  await expect(page.getByRole('heading', { name: '评审交付' })).toHaveCount(0);
});
