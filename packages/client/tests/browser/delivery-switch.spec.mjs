import { deferred, expect, test } from './replay.mjs';

function item(id, nodeId) {
  return {
    id,
    kind: 'deliver',
    actorId: 'chen',
    nodeId,
    taskId: 'task',
    reason: 'assignee-delivery',
    action: 'submit',
  };
}

function node(nodeId, goal) {
  return {
    nodeId,
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    version: 1,
    status: 'ready',
    goal,
    expectedOutput: '说明',
    assigneeId: 'chen',
    reviewerIds: [],
    artifacts: [],
    rounds: [],
    comments: [],
  };
}

const designFile = {
  id: 'design-file',
  mediaType: 'text/plain',
  byteSize: 4,
  checksum: 'abc',
  accessPolicyId: 'policy',
  uploadComplete: true,
};

function inbox() {
  return {
    ok: true,
    value: {
      actorId: 'chen',
      items: [item('design-item', 'design'), item('publish-item', 'publish')],
      nodes: [node('design', '设计登录'), node('publish', '发布说明')],
    },
  };
}

async function openNode(page, goal) {
  await page.getByRole('article', { name: goal }).getByRole('button').click();
}

test('空草稿不会留下上一个工作项的文件', async ({ page, replay }) => {
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => ({
    ok: true,
    value:
      payload.nodeId === 'design'
        ? {
            version: 1,
            text: '设计草稿',
            links: ['https://example.test/design'],
            files: [designFile],
          }
        : { version: 1, text: '', links: [], files: [] },
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect(page.getByLabel('文件标识')).toHaveValue('design-file');
  await expect(page.getByLabel('交付说明')).toHaveValue('设计草稿');
  await openNode(page, '发布说明');
  await expect(page.getByLabel('文件标识')).toHaveValue('');
  await expect(page.getByLabel('交付说明')).toHaveValue('');
  await expect(page.getByLabel('链接')).toHaveValue('');
});

test('读取失败或迟到的结果不会写进下一个工作项', async ({ page, replay }) => {
  const late = deferred();
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.nodeId === 'design' && payload.idempotencyKey === undefined) {
      await late.promise;
      return {
        ok: true,
        value: { version: 1, text: '迟到的设计草稿', links: [], files: [designFile] },
      };
    }
    return { ok: true, value: { version: 0, text: '', links: [], files: [] } };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect.poll(() => replay.requests.some((item) => item.nodeId === 'design')).toBe(true);
  await openNode(page, '发布说明');
  await expect(page.getByLabel('交付说明')).toHaveValue('');
  late.resolve();
  await page.waitForTimeout(50);
  await expect(page.getByLabel('文件标识')).toHaveValue('');
  await expect(page.getByLabel('交付说明')).toHaveValue('');

  replay.handlers.draft = async (payload) => {
    if (payload.nodeId === 'design') {
      return {
        ok: false,
        error: { code: 'unavailable', message: '草稿没有读出来。', details: {} },
      };
    }
    return { ok: true, value: { version: 0, text: '发布草稿', links: [], files: [] } };
  };
  await openNode(page, '设计登录');
  await expect(page.getByRole('alert')).toHaveText('草稿没有读出来。');
  await openNode(page, '发布说明');
  await expect(page.getByLabel('交付说明')).toHaveValue('发布草稿');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('读取还没回来时先改的内容不会被盖掉', async ({ page, replay }) => {
  const gate = deferred();
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.nodeId === 'design') await gate.promise;
    return {
      ok: true,
      value: { version: 3, text: '服务器草稿', links: [], files: [designFile] },
    };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect.poll(() => replay.requests.some((item) => item.nodeId === 'design')).toBe(true);
  await page.getByLabel('交付说明').fill('用户先写');
  await page.getByLabel('文件标识').fill('user-file');
  gate.resolve();
  await page.waitForTimeout(50);
  await expect(page.getByLabel('交付说明')).toHaveValue('用户先写');
  await expect(page.getByLabel('文件标识')).toHaveValue('user-file');
});

test('保存还在飞的时候换工作项，结果不会写到新工作项', async ({ page, replay }) => {
  const gate = deferred();
  const keys = [];
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.idempotencyKey) {
      keys.push({ nodeId: payload.nodeId, idempotencyKey: payload.idempotencyKey });
      if (payload.nodeId === 'design') await gate.promise;
      return {
        ok: true,
        value: {
          version: 2,
          text: payload.text ?? '',
          links: payload.links ?? [],
          files: payload.files ?? [],
        },
      };
    }
    return {
      ok: true,
      value:
        payload.nodeId === 'design'
          ? { version: 1, text: '设计草稿', links: [], files: [designFile] }
          : { version: 1, text: '', links: [], files: [] },
    };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect(page.getByLabel('交付说明')).toHaveValue('设计草稿');
  await page.getByLabel('交付说明').fill('正在保存的说明');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => keys.length).toBe(1);
  await openNode(page, '发布说明');
  await expect(page.getByLabel('交付说明')).toHaveValue('');
  await expect(page.getByLabel('文件标识')).toHaveValue('');
  gate.resolve();
  await page.waitForTimeout(50);
  await expect(page.getByLabel('交付说明')).toHaveValue('');
  await expect(page.getByLabel('文件标识')).toHaveValue('');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0].nodeId).toBe('design');
  expect(keys[1].nodeId).toBe('publish');
  expect(keys[0].idempotencyKey).not.toBe(keys[1].idempotencyKey);
});
