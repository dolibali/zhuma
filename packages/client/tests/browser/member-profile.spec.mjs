import { test, expect } from '@playwright/test';
import { fixture } from '../../../../tests/fixtures/workbench.mjs';
import { reviewNode, inbox } from './execution-fixture.mjs';

// HTTP fixture contract using actual account, shell and workbench components.
// Durable identity, authorization and private-table boundaries have separate Host tests.
async function replay(page) {
  const control = {
    actor: 'chen',
    profiles: new Map(),
    writes: [],
    assets: [],
    unexpected: [],
    errors: [],
  };
  const space = { id: 'team-a', kind: 'team', name: '产品团队' };
  control.spaces = [space];
  page.on('pageerror', (error) => control.errors.push(error.message));
  await page.route('**/zhuma-id/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let value;
    if (path === '/zhuma-id/login') control.actor = req.postDataJSON().accountId;
    else if (path === '/zhuma-id/logout') control.actor = null;
    else if (path === '/zhuma-id/teams') value = { accountId: control.actor, teams: [] };
    else if (path === '/zhuma-id/team-members') {
      const members = ['chen', 'outside'].map((accountId) => ({
        accountId,
        displayName: control.profiles.get(accountId) || null,
      }));
      const gate = control.directoryGate;
      const failed = control.directoryFailure;
      const spaceId = new URL(req.url()).searchParams.get('spaceId');
      control.directoryReads = (control.directoryReads ?? 0) + 1;
      await gate;
      if (failed) return route.fulfill({ status: 503, json: { ok: false, error: 'unavailable' } });
      value = {
        spaceId,
        administratorId: null,
        accountIds: members.map((m) => m.accountId),
        members,
      };
    } else if (path === '/zhuma-id/profile') {
      const actor = control.actor;
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        expect(Object.keys(body)).toEqual(['displayName']);
        control.writes.push({ actor, body });
        await control.saveGate;
        control.profiles.set(actor, body.displayName.trim());
      }
      value = { accountId: actor, displayName: control.profiles.get(actor) || null };
    } else if (path !== '/zhuma-id/session') control.unexpected.push(path);
    if (value) return route.fulfill({ json: { ok: true, value } });
    return route.fulfill({
      status: control.actor ? 200 : 401,
      json: control.actor
        ? {
            ok: true,
            accountId: control.actor,
            principal: { kind: 'zhuma-member', memberId: control.actor },
            peerId: 'fixture',
            spaces: control.spaces,
            ...(control.profiles.get(control.actor)
              ? { displayName: control.profiles.get(control.actor) }
              : {}),
          }
        : { ok: false, error: 'unauthenticated' },
    });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request().postDataJSON();
    let result;
    if (request.method === 'zhuma-exec/startable')
      result = { actorId: control.actor, spaceId: request.payload.spaceId, plans: [] };
    else if (request.method === 'zhuma-exec/inbox') {
      const node = structuredClone(reviewNode);
      node.rounds[0].ballots = [
        { reviewerId: 'outside', action: 'comment', comment: '明确取消规则' },
        { reviewerId: 'departed-member', action: 'comment', comment: '保留历史意见' },
      ];
      result = { ...inbox([node]), actorId: control.actor, spaceId: request.payload.spaceId };
      result.items = result.items.map((item) => ({ ...item, actorId: control.actor }));
    } else if (request.method === 'zhuma-exec/ballot') {
      control.ballots = [...(control.ballots ?? []), request.payload];
      result = { node: reviewNode };
    } else if (request.method === 'zhuma-member/asset-list')
      result = {
        actorId: control.actor,
        spaceId: space.id,
        items: control.assets.filter(
          (a) => !request.payload.kind || a.kind === request.payload.kind,
        ),
      };
    else if (request.method === 'zhuma-member/asset-catalog') {
      const rows = control.assets.map((asset) => ({
        source: 'asset',
        category: asset.kind === 'file' ? 'material' : asset.kind,
        asset,
      }));
      const counts = { all: rows.length, material: 0, template: 0, expert: 0, skill: 0 };
      for (const row of rows) counts[row.category]++;
      const items = rows.filter(
        (row) => request.payload.category === 'all' || row.category === request.payload.category,
      );
      result = {
        ...request.payload,
        sourceVersion: 'zhuma-team-asset-catalog@1',
        actorId: control.actor,
        countUnit: 'items',
        total: items.length,
        counts,
        items,
        nextOffset: null,
      };
    } else if (request.method === 'zhuma-member/asset-read') {
      const asset = control.assets.find((a) => a.assetId === request.payload.assetId);
      result = {
        actorId: control.actor,
        asset,
        selection: request.payload.draft
          ? { kind: 'draft', expectedVersion: asset.version }
          : {
              kind: 'published',
              reference: asset.versions.find(
                (v) => v.reference.versionId === request.payload.versionId,
              ).reference,
            },
        definition: { kind: 'skill', name: asset.name, description: '', content: '接口评审方法' },
        dependencies: [],
      };
    } else if (request.method === 'zhuma-member/asset-folder-list')
      result = {
        actorId: control.actor,
        spaceId: space.id,
        folderId: null,
        path: [],
        folders: [],
        files: control.assets.filter((a) => a.kind === 'file'),
      };
    else if (request.method === 'zhuma-member/snapshot') {
      const state = fixture().state;
      state.receipts = [];
      state.assets = [];
      state.participants = state.participants.map((p) => ({
        ...p,
        name: p.kind === 'human' ? control.profiles.get(p.id) || p.id : p.name,
      }));
      state.tasks[0].participantIds = ['chen', 'outside', 'qa'];
      Object.assign(state.tasks[0].workflows[0].nodes[0], {
        skillIds: [],
        reviewerIds: ['outside', 'qa'],
      });
      result = {
        actorId: control.actor,
        spaceId: space.id,
        space,
        state,
        model: null,
        capabilities: {
          createProject: true,
          createTask: true,
          planning: false,
          resources: 'authorized',
          tasks: [
            {
              taskId: 'task',
              edit: control.actor === 'chen',
              confirm: control.actor === 'chen',
              plan: false,
            },
          ],
        },
      };
    } else {
      control.unexpected.push(request.method);
      return route.fulfill({ status: 404 });
    }
    return route.fulfill({
      json: { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: result } },
    });
  });
  return control;
}
const account = (page) => page.getByRole('button', { name: /^账号与空间：/ });
const management = (page) => page.getByRole('dialog', { name: '账号与团队', exact: true });
async function profile(page) {
  await account(page).click();
  await page.getByRole('button', { name: '账号与团队', exact: true }).click();
  await management(page).getByRole('button', { name: '个人资料', exact: true }).click();
  await expect(management(page).getByLabel('显示姓名', { exact: true })).toBeEnabled();
  return management(page);
}
async function save(page, name) {
  const dialog = await profile(page);
  await dialog.getByLabel('显示姓名', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存姓名', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('姓名已保存');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
}
async function loginAs(page, id) {
  await account(page).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByLabel('账号', { exact: true }).fill(id);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(account(page)).toHaveAttribute('data-account-id', id);
}

test('profile component contract: normal edits and refresh share names across account, owner, participants, work and reviewers', async ({
  page,
}) => {
  const control = await replay(page);
  await page.goto('/?member-profile&strict');
  await expect(account(page)).toHaveAttribute('data-account-id', 'chen');
  const epoch = await page.evaluate(() => window.memberProfileProbe.getSnapshot().session.epoch);
  await save(page, '陈嘉宁');
  await expect(account(page)).toContainText('陈嘉宁');
  expect(await page.evaluate(() => window.memberProfileProbe.getSnapshot().session.epoch)).toBe(
    epoch,
  );
  await loginAs(page, 'outside');
  await save(page, '林子涵');
  await loginAs(page, 'chen');
  await page.reload();
  await expect(account(page)).toContainText('陈嘉宁');
  await page.locator('.zm-task-row').filter({ hasText: '账号登录' }).click();
  await expect(page.getByRole('button', { name: '选择负责人', exact: true })).toContainText(
    '陈嘉宁',
  );
  await page.getByRole('button', { name: '参与者 3', exact: true }).click();
  const participants = page.getByRole('dialog', { name: '任务参与者', exact: true });
  for (const name of ['陈嘉宁', '林子涵', '质量专家'])
    await expect(
      participants.locator('.zm-member').filter({ hasText: name }).getByRole('checkbox'),
    ).toBeChecked();
  await participants.getByRole('textbox', { name: '搜索参与者' }).fill('outside');
  await expect(participants.locator('.zm-member')).toHaveCount(1);
  await expect(participants.locator('.zm-member')).toContainText('林子涵');
  await participants.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(
    page.getByRole('group', { name: '设计登录接口，登录工作流', exact: true }),
  ).toContainText('陈嘉宁');
  await page.getByRole('button', { name: '列表', exact: true }).click();
  await expect(page.locator('.zm-node-main').filter({ hasText: '设计登录接口' })).toContainText(
    '陈嘉宁',
  );
  await page.locator('.zm-node-main').filter({ hasText: '设计登录接口' }).click();
  await expect(page.getByRole('button', { name: '选择评审人', exact: true })).toContainText(
    '林子涵、质量专家',
  );
  expect(control.writes.map((w) => w.actor)).toEqual(['chen', 'outside']);
  expect(control.unexpected).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('profile component contract: a closed dialog and account change fence a delayed former-account save; empty clears to ID', async ({
  page,
}) => {
  const control = await replay(page);
  await page.goto('/?member-profile&strict');
  const dialog = await profile(page);
  const gate = Promise.withResolvers();
  control.saveGate = gate.promise;
  await dialog.getByLabel('显示姓名', { exact: true }).fill('旧账号姓名');
  await dialog.getByRole('button', { name: '保存姓名', exact: true }).click();
  await expect.poll(() => control.writes.length).toBe(1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await loginAs(page, 'outside');
  gate.resolve();
  await expect(account(page)).toContainText('outside');
  await save(page, '林子涵');
  await save(page, '');
  await expect(account(page)).toContainText('outside');
  expect(
    await page.evaluate(() => window.memberProfileProbe.getSnapshot().session.session),
  ).not.toHaveProperty('displayName');
  expect(control.errors).toEqual([]);
});

test('asset name/status projection uses current authorized names, preserves unknown IDs, and shows publication even with a retained draft', async ({
  page,
}) => {
  const control = await replay(page);
  control.profiles.set('chen', '陈嘉宁');
  const asset = (name, kind, hasDraft, published) => {
    const assetId = crypto.randomUUID();
    return {
      spaceId: 'team-a',
      assetId,
      kind,
      name,
      description: '',
      ownerId: 'chen',
      maintainerIds: ['chen'],
      version: 1,
      hasDraft,
      canMaintain: true,
      canPublish: true,
      versions: published
        ? ['chen', 'departed-member'].map((publishedBy, index) => ({
            number: index + 1,
            publishedBy,
            publishedAt: '2026-11-07T00:00:00.000Z',
            reference: {
              spaceId: 'team-a',
              assetId,
              kind,
              versionId: crypto.randomUUID(),
              sha256: 'a'.repeat(64),
            },
          }))
        : [],
    };
  };
  control.assets = [
    asset('接口评审方法', 'skill', true, true),
    asset('未发布方法', 'skill', true, false),
    asset('上线方法', 'skill', false, true),
    asset('接口参考.txt', 'file', true, true),
  ];
  const before = structuredClone(control.assets);
  await page.goto('/?member-profile&strict');
  await page.getByRole('button', { name: '资产', exact: true }).click();
  const row = (title) => page.locator('.zm-member-asset-row').filter({ hasText: title });
  await expect(row('接口评审方法')).toContainText('已发布 v2 · 有草稿');
  await expect(row('未发布方法')).toContainText('草稿');
  await expect(row('未发布方法')).not.toContainText('已发布');
  await expect(row('上线方法')).toContainText('已发布 v2');
  await expect(row('上线方法')).not.toContainText('草稿');
  await row('接口评审方法').click();
  await page.getByRole('combobox', { name: '资产版本', exact: true }).click();
  await expect(page.getByRole('option', { name: 'v1 · 陈嘉宁', exact: true })).toBeVisible();
  await expect(
    page.getByRole('option', { name: 'v2 · departed-member', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^资料 / }).click();
  await expect(page.getByRole('row').filter({ hasText: '接口参考.txt' })).toContainText(
    '已发布 v2 · 有草稿',
  );
  expect(control.assets).toEqual(before);
  expect(control.unexpected).toEqual([]);
  expect(control.errors).toEqual([]);
});

for (const unavailable of [false, true])
  test(`human review name projection: directory ${unavailable ? 'failure falls back without blocking a vote' : 'names replace only current authorized IDs'}`, async ({
    page,
  }) => {
    const control = await replay(page);
    control.profiles.set('outside', '林子涵');
    control.directoryFailure = unavailable;
    await page.goto('/?member-profile&profile-work&strict');
    await page
      .getByRole('article', { name: '确认订单状态接口', exact: true })
      .getByRole('button')
      .click();
    const opinions = page.getByLabel('本轮意见', { exact: true });
    await expect(opinions).toContainText(unavailable ? 'outside' : '林子涵');
    await expect(opinions).toContainText('departed-member');
    await page.getByRole('button', { name: '通过', exact: true }).click();
    await expect.poll(() => control.ballots?.length ?? 0).toBe(1);
    expect(control.ballots[0]).not.toHaveProperty('reviewerId');
    expect(control.errors).toEqual([]);
    expect(control.unexpected).toEqual([]);
  });

for (const scope of ['account', 'space'])
  test(`human review name projection fences a delayed previous-${scope} directory response`, async ({
    page,
  }) => {
    const control = await replay(page);
    control.profiles.set('outside', '前账号目录姓名');
    control.spaces.push({ id: 'team-b', kind: 'team', name: '另一团队' });
    const gate = Promise.withResolvers();
    control.directoryGate = gate.promise;
    await page.goto('/?member-profile&profile-work&strict');
    await expect.poll(() => control.directoryReads ?? 0).toBeGreaterThan(0);
    control.directoryFailure = true;
    control.directoryGate = undefined;
    if (scope === 'account') await loginAs(page, 'outside');
    else {
      await page.getByRole('combobox', { name: '当前空间', exact: true }).click();
      await page.getByRole('option', { name: '团队 · 另一团队', exact: true }).click();
      await expect(page.getByRole('combobox', { name: '当前空间', exact: true })).toContainText(
        '另一团队',
      );
    }
    gate.resolve();
    await page
      .getByRole('article', { name: '确认订单状态接口', exact: true })
      .getByRole('button')
      .click();
    const opinions = page.getByLabel('本轮意见', { exact: true });
    await expect(opinions).toContainText('outside');
    await expect(opinions).not.toContainText('前账号目录姓名');
    expect(control.errors).toEqual([]);
  });
