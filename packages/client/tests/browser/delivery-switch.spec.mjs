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

test('同节点保存中继续输入', async ({ page, replay }) => {
  const gate = deferred();
  const saves = [];
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.idempotencyKey) {
      saves.push(payload);
      if (saves.length === 1) await gate.promise;
      return {
        ok: true,
        value: {
          version: payload.expectedVersion + 1,
          text: payload.text ?? '',
          links: payload.links ?? [],
          files: payload.files ?? [],
        },
      };
    }
    return { ok: true, value: { version: 1, text: '已保存的说明', links: [], files: [] } };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect(page.getByLabel('交付说明')).toHaveValue('已保存的说明');
  await page.getByLabel('交付说明').fill('sent synthetic draft');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].text).toBe('sent synthetic draft');
  await page.getByLabel('交付说明').fill('next unsaved synthetic draft');
  gate.resolve();
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(page.getByLabel('交付说明')).toHaveValue('next unsaved synthetic draft');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1].text).toBe('next unsaved synthetic draft');
  expect(saves[1].expectedVersion).toBe(2);
  await expect(page.getByLabel('交付说明')).toHaveValue('next unsaved synthetic draft');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('读取 version>0 时先编辑，再保存能真正成功', async ({ page, replay }) => {
  const gate = deferred();
  const saves = [];
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.idempotencyKey) {
      saves.push(payload);
      if (payload.expectedVersion !== 3) {
        return {
          ok: false,
          error: { code: 'conflict', message: '内容已变化，请刷新后再试。', details: {} },
        };
      }
      return {
        ok: true,
        value: {
          version: 4,
          text: payload.text ?? '',
          links: payload.links ?? [],
          files: payload.files ?? [],
        },
      };
    }
    if (payload.nodeId === 'design') await gate.promise;
    return { ok: true, value: { version: 3, text: '服务器草稿', links: [], files: [] } };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  const save = page.getByRole('button', { name: '保存草稿', exact: true });
  await expect
    .poll(() =>
      replay.requests.some(
        (item) =>
          item.endpoint === 'draft' &&
          item.nodeId === 'design' &&
          item.idempotencyKey === undefined,
      ),
    )
    .toBe(true);
  await page.getByLabel('交付说明').fill('用户先写');
  gate.resolve();
  await expect(save).toBeEnabled();
  await expect(page.getByLabel('交付说明')).toHaveValue('用户先写');
  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].expectedVersion).toBe(3);
  expect(saves[0].text).toBe('用户先写');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('交付说明')).toHaveValue('用户先写');
});

test('读取失败后解锁', async ({ page, replay }) => {
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async () => ({
    ok: false,
    error: { code: 'unavailable', message: '草稿没有读出来。', details: {} },
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect(page.getByRole('alert')).toHaveText('草稿没有读出来。');
  const form = page.locator('section.zm-config-form');
  await expect(form.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  await expect(form.getByRole('button', { name: '提交产物', exact: true })).toBeEnabled();
});

test('保存按钮受读取锁控制', async ({ page, replay }) => {
  const gate = deferred();
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.nodeId === 'design' && payload.idempotencyKey === undefined) await gate.promise;
    return { ok: true, value: { version: 1, text: '', links: [], files: [] } };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  const save = page.getByRole('button', { name: '保存草稿', exact: true });
  await expect
    .poll(() =>
      replay.requests.some(
        (item) =>
          item.endpoint === 'draft' &&
          item.nodeId === 'design' &&
          item.idempotencyKey === undefined,
      ),
    )
    .toBe(true);
  const form = page.locator('section.zm-config-form');
  await expect(save).toBeDisabled();
  await expect(form.getByRole('button', { name: '提交产物', exact: true })).toBeDisabled();
  gate.resolve();
  await expect(save).toBeEnabled();
  await expect(form.getByRole('button', { name: '提交产物', exact: true })).toBeEnabled();
});

test('读取期间编辑后失败仍提示', async ({ page, replay }) => {
  const gate = deferred();
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = async (payload) => {
    if (payload.nodeId === 'design') await gate.promise;
    return {
      ok: false,
      error: { code: 'unavailable', message: '草稿没有读出来。', details: {} },
    };
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  await expect.poll(() => replay.requests.some((item) => item.nodeId === 'design')).toBe(true);
  await page.getByLabel('交付说明').fill('用户先写');
  gate.resolve();
  await expect(page.getByLabel('交付说明')).toHaveValue('用户先写');
  await expect(page.getByRole('alert')).toHaveText('草稿没有读出来。');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
});

test('读取一直不返回时会解锁并提示', async ({ page, replay }) => {
  await page.clock.install();
  replay.handlers.inbox = async () => inbox();
  replay.handlers.draft = () => new Promise(() => {});
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?execution');
  await openNode(page, '设计登录');
  const save = page.getByRole('button', { name: '保存草稿', exact: true });
  await expect.poll(() => replay.requests.some((item) => item.nodeId === 'design')).toBe(true);
  await page.getByLabel('交付说明').fill('用户先写');
  await expect(save).toBeDisabled();
  await page.clock.fastForward(10_000);
  await expect(page.getByRole('alert')).toHaveText('草稿没有在时间内读出来。');
  await expect(page.getByLabel('交付说明')).toHaveValue('用户先写');
  await expect(save).toBeEnabled();
});

const fileMeta = [
  { label: '媒体类型', prop: 'mediaType', next: 'application/json' },
  { label: '字节数', prop: 'byteSize', next: '9' },
  { label: '校验', prop: 'checksum', next: 'def' },
  { label: '访问策略', prop: 'accessPolicyId', next: 'other-policy' },
];

for (const field of fileMeta) {
  test(`保存后只改${field.label}会换幂等键再保存成功`, async ({ page, replay }) => {
    const seen = new Map();
    const saves = [];
    replay.handlers.inbox = async () => inbox();
    replay.handlers.draft = async (payload) => {
      if (payload.idempotencyKey === undefined) {
        return { ok: true, value: { version: 0, text: '', links: [], files: [] } };
      }
      const fingerprint = JSON.stringify({
        text: payload.text ?? '',
        links: payload.links ?? [],
        files: payload.files ?? [],
      });
      const prior = seen.get(payload.idempotencyKey);
      if (prior !== undefined && prior !== fingerprint) {
        return {
          ok: false,
          error: {
            code: 'idempotency-mismatch',
            message: '这个请求标识已经用于另一项操作。',
            details: {},
          },
        };
      }
      seen.set(payload.idempotencyKey, fingerprint);
      saves.push(payload);
      return {
        ok: true,
        value: {
          version: payload.expectedVersion + 1,
          text: payload.text ?? '',
          links: payload.links ?? [],
          files: payload.files ?? [],
        },
      };
    };
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?execution');
    await openNode(page, '设计登录');
    const save = page.getByRole('button', { name: '保存草稿', exact: true });
    await expect
      .poll(() =>
        replay.requests.some(
          (item) =>
            item.endpoint === 'draft' &&
            item.nodeId === 'design' &&
            item.idempotencyKey === undefined,
        ),
      )
      .toBe(true);
    await expect(save).toBeEnabled();
    await page.getByLabel('文件标识').fill('design-file');
    await page.getByLabel('媒体类型').fill('text/plain');
    await page.getByLabel('字节数').fill('4');
    await page.getByLabel('校验').fill('abc');
    await page.getByLabel('访问策略').fill('policy');
    await save.click();
    await expect.poll(() => saves.length).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel(field.label).fill(field.next);
    await save.click();
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1].idempotencyKey).not.toBe(saves[0].idempotencyKey);
    expect(saves[1].expectedVersion).toBe(1);
    expect(saves[0].files).toEqual([
      {
        id: 'design-file',
        mediaType: 'text/plain',
        byteSize: 4,
        checksum: 'abc',
        accessPolicyId: 'policy',
        uploadComplete: false,
      },
    ]);
    expect(saves[1].files).toEqual([
      {
        id: 'design-file',
        mediaType: field.prop === 'mediaType' ? field.next : 'text/plain',
        byteSize: field.prop === 'byteSize' ? 9 : 4,
        checksum: field.prop === 'checksum' ? field.next : 'abc',
        accessPolicyId: field.prop === 'accessPolicyId' ? field.next : 'policy',
        uploadComplete: false,
      },
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel(field.label)).toHaveValue(field.next);
  });
}
