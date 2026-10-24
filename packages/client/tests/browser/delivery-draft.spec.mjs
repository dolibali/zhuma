import { expect, test } from './replay.mjs';

const draftText = '草稿正文-4e1';

test('关闭后再打开，交付说明还是保存过的草稿', async ({ page, replay }) => {
  let saved = { version: 0, text: '', links: [], files: [] };
  replay.handlers.inbox = async () => ({
    ok: true,
    value: {
      actorId: 'chen',
      items: [
        {
          id: 'inbox-1',
          kind: 'deliver',
          actorId: 'chen',
          nodeId: 'publish',
          taskId: 'task',
          reason: 'assignee-delivery',
          action: 'submit',
        },
      ],
      nodes: [
        {
          nodeId: 'publish',
          taskId: 'task',
          planId: 'plan',
          revision: 1,
          version: 1,
          status: 'ready',
          goal: '发布登录说明',
          expectedOutput: '说明',
          assigneeId: 'chen',
          reviewerIds: [],
          artifacts: [],
          rounds: [],
          comments: [],
        },
      ],
    },
  });
  replay.handlers.draft = async (payload) => {
    if (payload.idempotencyKey) {
      saved = {
        version: saved.version + 1,
        text: payload.text ?? '',
        links: payload.links ?? [],
        files: payload.files ?? [],
      };
    }
    return { ok: true, value: saved };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await page.getByRole('button', { name: '提交产物', exact: true }).click();
  const explanation = page.getByLabel('交付说明');
  await expect.poll(() => replay.requests.some((item) => item.endpoint === 'draft')).toBe(true);
  await explanation.fill(draftText);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => saved.text).toBe(draftText);
  await page.goto('/?execution');
  await page.getByRole('button', { name: '提交产物', exact: true }).click();
  await expect(page.getByLabel('交付说明')).toHaveValue(draftText);
});
