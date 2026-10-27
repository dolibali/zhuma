import { test, expect } from '@playwright/test';
const input = (page) => page.getByLabel('产物正文', { exact: true });
const links = (page) => page.getByLabel('参考链接（选填，每行一个）', { exact: true });
const status = (page) => page.locator('.zm-draft-status');
const button = (page, name) =>
  page.locator('.zm-execution-detail button').filter({
    has: page.locator('.zm-button-label').filter({ hasText: new RegExp(`^${name}$`) }),
  });
const count = (page, kind) =>
  page.evaluate(
    (kind) => window.deliveryDraftProbe.calls.filter((c) => c.kind === kind).length,
    kind,
  );
async function open(page, flags = '') {
  await page.goto(`/?delivery-drafts&strict&${flags}`);
  if (!flags.includes('draft-direct')) await page.getByRole('article').getByRole('button').click();
  await expect(input(page)).toBeVisible();
  if (!flags.includes('draft-hold')) await expect(status(page)).toContainText('已保存');
}
async function finish(page, kind, outcome = 'success') {
  await page.evaluate(
    ({ kind, outcome }) => {
      const c = window.deliveryDraftProbe;
      c.complete(
        c.calls.findLastIndex((call) => call.kind === kind),
        outcome,
      );
    },
    { kind, outcome },
  );
}

for (const revise of [false, true])
  test(`draft normal ${revise ? 'revise' : 'submit'} entry loads all text/links without saving or executing`, async ({
    page,
  }) => {
    await open(page, revise ? 'draft-revise' : '');
    await expect(input(page)).toHaveValue('订单交付草稿');
    await expect(links(page)).toHaveValue(
      'https://example.test/orders\nhttps://example.test/errors',
    );
    await expect(status(page)).toHaveText('已保存 · 草稿版本 7');
    expect(await count(page, 'save')).toBe(0);
    expect(await count(page, 'submit')).toBe(0);
    const reads = await page.evaluate(() =>
      window.deliveryDraftProbe.calls.filter((c) => c.kind === 'read').map((c) => c.payload),
    );
    for (const read of reads)
      expect(Object.keys(read).sort()).toEqual(['nodeId', 'planId', 'revision', 'taskId']);
  });

test('draft delayed initial read never replaces edited text; untouched links are preserved and restoration is explicit', async ({
  page,
}) => {
  await open(page, 'draft-direct&draft-hold');
  await input(page).fill('我刚输入的内容');
  await expect(button(page, '保存草稿')).toBeDisabled();
  await expect(button(page, '提交产物')).toBeDisabled();
  await finish(page, 'read');
  await expect(input(page)).toHaveValue('我刚输入的内容');
  await expect(links(page)).toHaveValue('https://example.test/orders\nhttps://example.test/errors');
  await expect(page.getByRole('region', { name: '已存草稿对照' })).toBeVisible();
  await button(page, '取消恢复').click();
  await expect(input(page)).toHaveValue('我刚输入的内容');
  await expect(status(page)).toHaveText('有未保存的修改');
  expect(await count(page, 'save')).toBe(0);
});

for (const outcome of ['failure', 'malformed'])
  test(`draft initial ${outcome} stays unknown and cannot save using fabricated version zero`, async ({
    page,
  }) => {
    await open(page, 'draft-direct&draft-hold');
    await input(page).fill('读取失败也保留我输入的文字');
    await finish(page, 'read', outcome);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(button(page, '保存草稿')).toBeDisabled();
    await expect(status(page)).not.toContainText('已保存');
    await button(page, '重试读取草稿').click();
    await finish(page, 'read');
    await button(page, '保留当前输入').click();
    await expect(input(page)).toHaveValue('读取失败也保留我输入的文字');
    await expect(button(page, '保存草稿')).toBeEnabled();
    expect(await count(page, 'save')).toBe(0);
  });

test('draft explicit save has an independent version and one operation lane shared with submit', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await input(page).fill('已补充边界说明');
  await page.evaluate(() => {
    window.deliveryDraftProbe.holdSave = true;
  });
  await button(page, '保存草稿').dblclick({ force: true });
  await expect(button(page, '提交产物')).toBeDisabled();
  await expect(input(page)).toBeDisabled();
  await expect(status(page)).toHaveText('正在保存草稿…');
  expect(await count(page, 'save')).toBe(1);
  expect(await count(page, 'submit')).toBe(0);
  const payload = await page.evaluate(
    () => window.deliveryDraftProbe.calls.find((c) => c.kind === 'save').payload,
  );
  expect(payload.expectedVersion).toBe(7); // node.version is 2
  await finish(page, 'save');
  await expect(status(page)).toHaveText('已保存 · 草稿版本 8');
  await expect(input(page)).toHaveValue('已补充边界说明');
  await expect(button(page, '保存草稿')).toBeDisabled();
});

test('draft lost response retries the same key; changed text rotates the key and keeps inputs on error', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await input(page).fill('第一次修改');
  await page.evaluate(() => {
    window.deliveryDraftProbe.holdSave = true;
  });
  await button(page, '保存草稿').click();
  await finish(page, 'save', 'lost');
  await expect(page.getByRole('alert')).toBeVisible();
  await button(page, '保存草稿').click();
  await finish(page, 'save', 'failure');
  await expect(page.getByRole('alert')).toBeVisible();
  await input(page).fill('另一份修改');
  await button(page, '保存草稿').click();
  const saves = await page.evaluate(() =>
    window.deliveryDraftProbe.calls.filter((c) => c.kind === 'save').map((c) => c.payload),
  );
  expect(saves[0].idempotencyKey).toBe(saves[1].idempotencyKey);
  expect(saves[2].idempotencyKey).not.toBe(saves[1].idempotencyKey);
  await finish(page, 'save', 'failure');
  await expect(input(page)).toHaveValue('另一份修改');
  await expect(status(page)).toHaveText('有未保存的修改');
});

test('draft conflict preserves input, cancel does not overwrite, and explicit keep uses the freshly read version', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await input(page).fill('保留本地输入');
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    c.holdSave = true;
    c.draft = { version: 10, text: '远端已存内容', links: [], files: [] };
  });
  await button(page, '保存草稿').click();
  await finish(page, 'save', 'conflict');
  await expect(page.getByRole('alert')).toContainText('草稿已变化');
  await expect(input(page)).toHaveValue('保留本地输入');
  await button(page, '查看已存草稿').click();
  await expect(page.getByRole('heading', { name: '已存草稿 · 版本 10' })).toBeVisible();
  await button(page, '取消恢复').click();
  await expect(button(page, '保存草稿')).toBeDisabled();
  await expect(input(page)).toHaveValue('保留本地输入');
  await button(page, '查看已存草稿').click();
  await button(page, '保留当前输入').click();
  await expect(input(page)).toHaveValue('保留本地输入');
  await expect(links(page)).toHaveValue('');
  await button(page, '保存草稿').click();
  expect(
    await page.evaluate(
      () =>
        window.deliveryDraftProbe.calls.findLast((c) => c.kind === 'save').payload.expectedVersion,
    ),
  ).toBe(10);
  await finish(page, 'save');
  await expect(status(page)).toHaveText('已保存 · 草稿版本 11');
});

test('draft file metadata is preserved on save, blocks submission, and can be explicitly removed without pretending to upload', async ({
  page,
}) => {
  await open(page, 'draft-direct&draft-files');
  const files = page.getByRole('list', { name: '附件', exact: true });
  await expect(files.getByRole('listitem')).toHaveCount(1);
  await expect(files).toContainText('42 B · text/markdown');
  await expect(files).toContainText('引用未完成');
  // An unverified reference ID is not a trusted display filename.
  await expect(files).not.toContainText('contract.md');
  await expect(files.locator('a, iframe, input[type=file]')).toHaveCount(0);
  await expect(button(page, '提交产物')).toBeDisabled();
  await input(page).fill('只修改文字，文件元信息不变');
  await button(page, '保存草稿').click();
  await expect(status(page)).toContainText('已保存');
  expect(
    await page.evaluate(
      () => window.deliveryDraftProbe.calls.find((c) => c.kind === 'save').payload.files[0],
    ),
  ).toEqual({
    id: 'contract.md',
    mediaType: 'text/markdown',
    byteSize: 42,
    checksum: 'fixture-checksum',
    accessPolicyId: 'fixture-policy',
    uploadComplete: false,
  });
  await files.getByRole('button', { name: '移除文件 文件', exact: true }).click();
  await expect(button(page, '提交产物')).toBeEnabled();
  await button(page, '保存草稿').click();
  await expect(status(page)).toHaveText('已保存 · 草稿版本 9');
  expect(
    await page.evaluate(
      () => window.deliveryDraftProbe.calls.findLast((c) => c.kind === 'save').payload.files,
    ),
  ).toEqual([]);
});

test('draft upstream blocking prevents submit but leaves explicit save available', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    c.updateNode({
      ...c.node,
      inputs: [
        { access: 'hidden', count: 1, blocking: true, message: '有 1 个上游来源你没有权限查看。' },
      ],
    });
  });
  await input(page).fill('仍要保存的草稿');
  await expect(button(page, '提交产物')).toBeDisabled();
  await expect(button(page, '保存草稿')).toBeEnabled();
  await button(page, '保存草稿').click();
  await expect(status(page)).toContainText('已保存');
  expect(await count(page, 'submit')).toBe(0);
});

for (const kind of ['read', 'save', 'submit'])
  test(`draft old ${kind} receipt cannot refill or clear a new round, including its pending state`, async ({
    page,
  }) => {
    await open(page, `draft-direct${kind === 'read' ? '&draft-hold' : ''}`);
    if (kind !== 'read') {
      await input(page).fill('旧轮输入');
      await page.evaluate((kind) => {
        window.deliveryDraftProbe[kind === 'save' ? 'holdSave' : 'holdSubmit'] = true;
      }, kind);
      await button(page, kind === 'save' ? '保存草稿' : '提交产物').click();
    }
    const old = await page.evaluate(
      (kind) => window.deliveryDraftProbe.calls.findLastIndex((c) => c.kind === kind),
      kind,
    );
    const before = await count(page, 'read');
    await page.evaluate(() => {
      const c = window.deliveryDraftProbe;
      c.holdRead = true;
      c.draft = { version: 12, text: '新轮草稿', links: [], files: [] };
      c.updateNode({ ...c.node, version: c.node.version + 2, currentRoundId: 'new-return-round' });
    });
    await expect.poll(() => count(page, 'read')).toBeGreaterThan(before);
    await page.evaluate((old) => window.deliveryDraftProbe.complete(old), old);
    await expect(status(page)).toHaveText('正在读取草稿…');
    expect(await page.evaluate(() => window.deliveryDraftProbe.events.length)).toBe(0);
    await finish(page, 'read');
    if (kind === 'read') await expect(input(page)).toHaveValue('新轮草稿');
    else {
      await expect(input(page)).toHaveValue('旧轮输入');
      await button(page, '保留当前输入').click();
    }
    await expect(status(page)).not.toContainText('草稿版本 8');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

test('draft submit is explicit and closes the local draft boundary until inbox/round updates', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await button(page, '提交产物').click();
  await expect(status(page)).toHaveText('已提交，等待待办更新。');
  await expect(input(page)).toHaveValue('');
  await expect(button(page, '保存草稿')).toBeDisabled();
  await expect(button(page, '重试读取草稿')).toBeDisabled();
  expect(await page.evaluate(() => window.deliveryDraftProbe.events.length)).toBe(1);
  expect(
    await page.evaluate(
      () =>
        window.deliveryDraftProbe.calls.find((c) => c.kind === 'submit').payload.expectedVersion,
    ),
  ).toBe(2);
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    c.draft = { version: 8, text: '', links: [], files: [] };
    c.updateNode({ ...c.node, version: c.node.version + 2, currentRoundId: 'returned-again' });
  });
  await expect(status(page)).toHaveText('草稿为空 · 草稿版本 8');
  await input(page).fill('新一轮内容');
  await button(page, '保存草稿').click();
  await expect(status(page)).toHaveText('已保存 · 草稿版本 9');
  expect(
    await page.evaluate(
      () =>
        window.deliveryDraftProbe.calls.findLast((c) => c.kind === 'save').payload.expectedVersion,
    ),
  ).toBe(8);
});

test('draft old API response cannot enter a new session or restore old input', async ({ page }) => {
  await open(page, 'draft-direct&draft-hold');
  await input(page).fill('旧身份输入');
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    window.oldDraft = c;
    c.old = c.calls.length - 1;
    c.replaceSession();
  });
  await expect(input(page)).toHaveValue('');
  await expect.poll(() => count(page, 'read')).toBeGreaterThan(0);
  await finish(page, 'read');
  await expect(input(page)).toHaveValue('新会话的草稿');
  await page.evaluate(() => window.oldDraft.complete(window.oldDraft.old));
  await expect(input(page)).toHaveValue('新会话的草稿');
});

test('draft explicit restoration replaces the form only after choosing the stored version', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await input(page).fill('正在写的新内容');
  await button(page, '查看已存草稿').click();
  await expect(page.getByRole('region', { name: '已存草稿对照' })).toBeVisible();
  await expect(input(page)).toHaveValue('正在写的新内容');
  await button(page, '恢复到表单').click();
  await expect(input(page)).toHaveValue('订单交付草稿');
  await expect(status(page)).toHaveText('已保存 · 草稿版本 7');
});

test('draft cancel after discovering remote file references cannot silently submit without those files', async ({
  page,
}) => {
  await open(page, 'draft-direct');
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    c.draft = {
      ...c.draft,
      version: 8,
      files: [
        {
          id: 'remote-file.md',
          mediaType: 'text/markdown',
          byteSize: 20,
          checksum: 'remote-checksum',
          accessPolicyId: 'remote-policy',
          uploadComplete: false,
        },
      ],
    };
  });
  await button(page, '查看已存草稿').click();
  await expect(page.getByRole('heading', { name: '已存草稿 · 版本 8' })).toBeVisible();
  await button(page, '取消恢复').click();
  await expect(button(page, '提交产物')).toBeDisabled();
  await expect(input(page)).toHaveValue('订单交付草稿');
  await button(page, '查看已存草稿').click();
  await button(page, '保留当前输入').click();
  const files = page.getByRole('list', { name: '附件', exact: true });
  await expect(files.getByRole('listitem')).toHaveCount(1);
  await expect(files).toContainText('20 B · text/markdown');
  await expect(files).toContainText('引用未完成');
  await input(page).fill('订单交付草稿，保留远端文件引用');
  await button(page, '保存草稿').click();
  expect(
    await page.evaluate(
      () => window.deliveryDraftProbe.calls.findLast((c) => c.kind === 'save').payload.files,
    ),
  ).toEqual([
    {
      id: 'remote-file.md',
      mediaType: 'text/markdown',
      byteSize: 20,
      checksum: 'remote-checksum',
      accessPolicyId: 'remote-policy',
      uploadComplete: false,
    },
  ]);
  await expect(button(page, '提交产物')).toBeDisabled();
  expect(await count(page, 'submit')).toBe(0);
});

test('draft keeping local edits during conflict preserves newly returned file metadata and removes only explicitly removed references', async ({
  page,
}) => {
  await open(page, 'draft-direct&draft-files');
  await page.getByRole('button', { name: '移除文件 文件', exact: true }).click();
  await page.evaluate(() => {
    const c = window.deliveryDraftProbe;
    c.holdSave = true;
    c.draft = {
      ...c.draft,
      version: 10,
      files: [
        ...c.draft.files,
        { ...c.draft.files[0], id: 'new-reference.md', checksum: 'new-checksum', byteSize: 80 },
      ],
    };
  });
  await button(page, '保存草稿').click();
  await finish(page, 'save', 'conflict');
  await button(page, '查看已存草稿').click();
  await button(page, '保留当前输入').click();
  const files = page.getByRole('list', { name: '附件', exact: true });
  await expect(files.getByRole('listitem')).toHaveCount(1);
  await expect(files).toContainText('80 B · text/markdown');
  await expect(files).not.toContainText('42 B');
  await button(page, '保存草稿').click();
  const saved = await page.evaluate(
    () => window.deliveryDraftProbe.calls.findLast((c) => c.kind === 'save').payload,
  );
  expect(saved.expectedVersion).toBe(10);
  expect(saved.files).toHaveLength(1);
  expect(saved.files[0].id).toBe('new-reference.md');
  expect(saved.files[0].checksum).toBe('new-checksum');
  await finish(page, 'save');
  await expect(status(page)).toHaveText('已保存 · 草稿版本 11');
});
