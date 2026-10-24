import { expect, test } from './replay.mjs';

const node = {
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
};

test('填写了文件标识时不能把节点提交完成', async ({ page, replay }) => {
  let submitted = 0;
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
      nodes: [node],
    },
  });
  replay.handlers.draft = async () => ({
    ok: true,
    value: { version: 0, text: '', links: [], files: [] },
  });
  replay.handlers.submit = async () => {
    submitted += 1;
    return { ok: true, value: { disposition: 'applied', node } };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await page.getByRole('button', { name: '提交产物', exact: true }).click();
  await page.getByLabel('文件标识').fill('synthetic');
  await page.getByLabel('媒体类型').fill('text/plain');
  await page.getByLabel('字节数').fill('4');
  await page.getByLabel('校验').fill('abc');
  await page.getByLabel('访问策略').fill('task-read');
  await page
    .locator('.zm-config-form')
    .getByRole('button', { name: '提交产物', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    '文件还不能随这次提交完成。请只提交文字或链接。',
  );
  expect(submitted).toBe(0);
  await page.getByLabel('文件标识').fill('');
  await page.getByLabel('交付说明').fill('只有文字');
  await page
    .locator('.zm-config-form')
    .getByRole('button', { name: '提交产物', exact: true })
    .click();
  await expect.poll(() => submitted).toBe(1);
  expect(replay.requests.filter((item) => item.endpoint === 'submit')).toHaveLength(1);
  expect(replay.requests.find((item) => item.endpoint === 'submit').files).toEqual([]);
});
