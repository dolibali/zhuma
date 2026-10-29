/** Member/React contracts. An explicit in-memory DOM is not native GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  const window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Document',
    'HTMLInputElement',
    'HTMLButtonElement',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'ResizeObserver',
    'SVGElement',
    'HTMLDialogElement',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { emptyWorkbench } = await import('@zhuma/agent-core');
const { createNativeRunApi } = await import('../dist/run/api.js');
const { WorkflowControls } = await import('../dist/workflow/WorkflowControls.js');
const { createWorkflowApi } = await import('../dist/workflow/api.js');
const { ExecutionError } = await import('../dist/execution/ExecutionApi.js');
const { WorkspaceApprovalDialog } = await import('../dist/run/WorkspaceApprovalDialog.js');
const { SidebarAccountSettingsLauncher } =
  await import('../dist/identity/SidebarAccountSettingsLauncher.js');
const tick = () => new Promise(setImmediate);
const location = { spaceId: 'north', projectId: 'project' };
const target = { taskId: 'task', planId: 'plan', revision: 1 };
const view = {
  target: { ...target, spaceId: 'north' },
  title: 'Workflow',
  state: 'inactive',
  planStarted: false,
  requiresResume: false,
  activeRunCount: 0,
  expertNodeCount: 1,
  intent: null,
  selection: null,
};
const options = {
  ...view,
  models: { kind: 'ready', items: [] },
  workspaces: [{ id: 'workspace', label: 'Controlled directory', access: 'read' }],
};
const session = {
  ok: true,
  accountId: 'chen',
  principal: { kind: 'zhuma-member', memberId: 'chen' },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
};
test('workflow settings port: official launcher is explicit and obsolete page calls are refused', () => {
  let current = true,
    opened = 0,
    requested = 0;
  const api = createNativeRunApi(
    async () => {
      requested++;
      assert.fail();
    },
    'chen',
    { spaceId: 'north', isCurrent: () => current, onUnavailable() {} },
    () => {},
    undefined,
    () => opened++,
  );
  assert.equal(opened, 0);
  api.openModelSettings();
  assert.equal(opened, 1);
  current = false;
  assert.throws(() => api.openModelSettings(), { name: 'AbortError' });
  assert.equal(opened, 1);
  assert.equal(requested, 0);
});
test('workspace scope labels come from the original guarded member snapshot, not locator ids', async () => {
  const state = emptyWorkbench();
  state.projects.push({ id: 'project', name: '订单中心', description: '' });
  const calls = [];
  let current = true;
  const api = createNativeRunApi(
    async (url, init) => {
      calls.push(url);
      if (url === '/zhuma-id/session') return Response.json(session);
      assert.equal(url, '/api/zhuma-member/snapshot');
      const request = JSON.parse(init.body);
      assert.deepEqual(request.payload, { spaceId: 'north' });
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            actorId: 'chen',
            spaceId: 'north',
            space: session.spaces[0],
            state,
            model: null,
            capabilities: {
              createProject: false,
              createTask: false,
              planning: false,
              resources: 'not-connected',
              tasks: [],
            },
          },
        },
      });
    },
    'chen',
    { spaceId: 'north', isCurrent: () => current, onUnavailable() {} },
    () => {},
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await api.workspaceApprovals.context(location, new AbortController().signal), {
    accountName: 'chen',
    projectName: '订单中心',
  });
  await assert.rejects(
    api.workspaceApprovals.context(
      { ...location, projectId: 'missing' },
      new AbortController().signal,
    ),
    { code: 'not-found' },
  );
  current = false;
  const before = calls.length;
  await assert.rejects(api.workspaceApprovals.context(location, new AbortController().signal), {
    name: 'AbortError',
  });
  assert.equal(calls.length, before);
});
const dom = { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' };

async function fillPublication(h, value) {
  const input = h.container.querySelector('[aria-label="第 1 项相对路径"]');
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
}
const publicationChoices = [
  { id: 'root-a', label: '目录一', access: 'write', publish: false, publication: 'per-run' },
  { id: 'root-b', label: '目录二', access: 'write', publish: false, publication: 'per-run' },
];

test(
  'workflow publication DOM: Start requires explicit ranges, blocks invalid paths and clears ranges when changing directory',
  dom,
  async (t) => {
    const model = { provider: 'contract', model: 'configured', maxTokens: 4096 };
    let started;
    const current = { ...view, controlledNodeCount: 1 };
    const h = await mount(t, WorkflowControls, {
      target,
      api: {
        read: async () => current,
        options: async () => ({
          ...options,
          ...current,
          maxConcurrent: 1,
          workspaces: publicationChoices,
          models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: model }] },
        }),
        start: async (input) => {
          started = input;
          return {
            ...current,
            state: 'waiting',
            planStarted: true,
            intent: { intentId: 'intent', generation: 1, version: 1, concurrent: 1 },
            selection: { model, workspace: input.workspace },
          };
        },
      },
    });
    await click(button(h, '运行工作流'));
    await choose(h.container.querySelector('[aria-label="模型"]'), 'Model');
    await choose(h.container.querySelector('[aria-label="工作目录"]'), '目录一 · 读写');
    assert.equal(h.container.querySelectorAll('[aria-label="第 1 项相对路径"]').length, 0);
    await click(button(h, '添加范围'));
    await fillPublication(h, '../private');
    assert.equal(button(h, '确认运行').disabled, true);
    await fillPublication(h, 'outputs');
    assert.equal(button(h, '确认运行').disabled, false);
    await choose(h.container.querySelector('[aria-label="工作目录"]'), '目录二 · 读写');
    assert.equal(h.container.querySelectorAll('[aria-label="第 1 项相对路径"]').length, 0);
    await click(button(h, '添加范围'));
    await fillPublication(h, 'outputs');
    assert.equal(started, undefined);
    await click(button(h, '确认运行'));
    assert.deepEqual(started.workspace, {
      kind: 'local',
      id: 'root-b',
      publish: [{ kind: 'directory', path: 'outputs' }],
    });
  },
);

test(
  'workflow publication DOM: a stopped intent explicitly changes future file authorization through Resume and preserves the frozen budget',
  dom,
  async (t) => {
    const model = { provider: 'contract', model: 'configured', maxTokens: 4096 },
      resumed = [];
    let current = {
      ...view,
      controlledNodeCount: 1,
      state: 'paused',
      planStarted: true,
      intent: {
        intentId: 'original-intent',
        generation: 1,
        version: 1,
        concurrent: 1,
        automaticRevisions: 1,
      },
      selection: { model, workspace: { kind: 'local', id: 'root-a' } },
      revisions: [{ nodeId: 'node', used: 1, limit: 1 }],
    };
    const h = await mount(t, WorkflowControls, {
      target,
      api: {
        read: async () => current,
        options: async () => ({
          ...options,
          ...current,
          maxConcurrent: 1,
          workspaces: publicationChoices,
          models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: model }] },
        }),
        resume: async (input) => {
          resumed.push(structuredClone(input));
          current = {
            ...current,
            state: 'waiting',
            intent: {
              ...current.intent,
              generation: current.intent.generation + 1,
              version: current.intent.version + 1,
            },
            selection: { model, workspace: input.workspace ?? current.selection.workspace },
          };
          return current;
        },
        stop: async () =>
          (current = {
            ...current,
            state: 'paused',
            intent: { ...current.intent, version: current.intent.version + 1 },
          }),
      },
    });
    await click(button(h, '继续工作流'));
    await click(button({ container: h.container.querySelector('form') }, '继续工作流'));
    assert.equal('workspace' in resumed[0], false, 'Ordinary Continue must not add file authority');
    await click(button(h, '停止工作流'));
    await click(button(h, '继续工作流'));
    await click(button(h, '修改工作区与文件交付授权'));
    assert.match(h.container.querySelector('[aria-label="工作目录"]').textContent, /目录一/u);
    await click(button(h, '添加范围'));
    await fillPublication(h, 'outputs');
    assert.match(h.container.textContent, /1 轮（继续运行不重置）/u);
    assert.equal(resumed.length, 1);
    await click(button(h, '确认授权并继续'));
    assert.deepEqual(resumed[1].workspace, {
      kind: 'local',
      id: 'root-a',
      publish: [{ kind: 'directory', path: 'outputs' }],
    });
    assert.equal(resumed[1].intentId, 'original-intent');
    assert.equal(resumed[1].generation, 2);
    assert.equal(resumed[1].expectedVersion, 3);
    assert.equal('automaticRevisions' in resumed[1], false);
    assert.deepEqual(current.revisions, [{ nodeId: 'node', used: 1, limit: 1 }]);
    await click(button(h, '停止工作流'));
    await click(button(h, '继续工作流'));
    await click(button(h, '修改工作区与文件交付授权'));
    assert.equal(h.container.querySelector('[aria-label="第 1 项相对路径"]').value, 'outputs');
    await click(button({ container: h.container.querySelector('form') }, '继续工作流'));
    assert.equal(
      'workspace' in resumed[2],
      false,
      'Unchanged explicit editor still preserves the existing default',
    );
  },
);

test(
  'workflow budget DOM: explicit start sends the chosen limit and Resume shows its frozen value without resetting it',
  dom,
  async (t) => {
    let current = { ...view, automaticReview: true, controlledNodeCount: 1 },
      started,
      resumed;
    const model = { provider: 'contract', model: 'configured', maxTokens: 4096 };
    const h = await mount(t, WorkflowControls, {
      target,
      nodeLabels: { node: '生成客户方案' },
      api: {
        read: async () => current,
        options: async () => ({
          ...options,
          ...current,
          maxConcurrent: 1,
          models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: model }] },
        }),
        start: async (input) => {
          started = input;
          current = {
            ...current,
            planStarted: true,
            state: 'waiting',
            intent: {
              intentId: 'intent',
              generation: 1,
              version: 1,
              concurrent: 1,
              automaticRevisions: 2,
            },
            selection: { model, workspace: { kind: 'text-only' } },
            revisions: [{ nodeId: 'node', used: 1, limit: 2 }],
          };
          return current;
        },
        stop: async () =>
          (current = { ...current, state: 'paused', intent: { ...current.intent, version: 2 } }),
        resume: async (input) => {
          resumed = input;
          return { ...current, state: 'waiting' };
        },
      },
    });
    await click(button(h, '运行工作流'));
    assert.match(
      h.container.querySelector('[aria-label="评审退回后自动返工"]').textContent,
      /不自动返工/u,
    );
    await choose(h.container.querySelector('[aria-label="模型"]'), 'Model');
    await choose(h.container.querySelector('[aria-label="评审退回后自动返工"]'), '最多 2 轮');
    await click(button(h, '确认运行'));
    assert.equal(started.automaticRevisions, 2);
    assert.match(h.container.textContent, /已发起自动返工 1 次/u);
    assert.match(h.container.textContent, /生成客户方案：1 \/ 2 次/u);
    await click(button(h, '停止工作流'));
    await click(button(h, '继续工作流'));
    assert.match(h.container.textContent, /2 轮（继续运行不重置）/u);
    assert.equal(h.container.querySelector('[aria-label="评审退回后自动返工"]'), null);
    await click(button({ container: h.container.querySelector('form') }, '继续工作流'));
    assert.equal(resumed.expectedVersion, 2);
    assert.equal('automaticRevisions' in resumed, false);
    assert.match(h.container.textContent, /已发起自动返工 1 次/u);
  },
);

test(
  'workflow review-only DOM: an owner can configure automatic expert review when all author work is assigned to other people',
  dom,
  async (t) => {
    const review = {
      ...view,
      expertNodeCount: 0,
      controlledNodeCount: 0,
      controlledReviewNodeCount: 1,
      expertReviewRequired: true,
      automaticReview: true,
    };
    const h = await mount(t, WorkflowControls, {
      target,
      api: {
        read: async () => review,
        options: async () => ({ ...options, ...review }),
        start: () => assert.fail('Model and explicit confirmation are required'),
      },
    });
    await click(button(h, '运行工作流'));
    assert.equal(button(h, '确认运行').disabled, true);
    await h.update({
      target,
      api: {
        read: async () => ({ ...review, automaticReview: false }),
        options: () => assert.fail('Unavailable review must not start'),
      },
    });
    assert(
      ![...h.container.querySelectorAll('button')].some(
        (item) => item.textContent.trim() === '运行工作流',
      ),
    );
  },
);
async function mount(t, component, props) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const update = async (next) =>
    act(async () => {
      root.render(el(component, next));
      await tick();
    });
  await update(props);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, update };
}
function button(h, name) {
  const found = [...h.container.querySelectorAll('button')].find(
    (item) =>
      (item.querySelector('.zm-button-label')?.textContent ?? item.textContent).trim() === name,
  );
  assert.ok(found, 'missing action ' + name);
  return found;
}
async function click(item) {
  await act(async () => {
    item.click();
    await tick();
  });
}
async function choose(item, label) {
  assert.ok(item);
  await click(item);
  const popup = document.querySelector('.zm-select-popup[data-open]');
  assert.ok(popup, 'a real choice must open the menu');
  const option = [...popup.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent.trim() === label,
  );
  assert.ok(option, `missing visible option: ${label}`);
  assert.notEqual(option.getAttribute('aria-disabled'), 'true');
  await click(option);
}
test('workflow review entry wire: optional frozen expert review need is strict and preserves old assignment counts', async () => {
  let response = { ...view, expertNodeCount: 0, expertReviewRequired: true };
  const api = createWorkflowApi(async () => response, 'north');
  assert.equal((await api.read(target, new AbortController().signal)).expertReviewRequired, true);
  assert.equal((await api.read(target, new AbortController().signal)).expertNodeCount, 0);
  response = { ...view, expertNodeCount: 0 };
  assert.equal(
    (await api.read(target, new AbortController().signal)).expertReviewRequired ?? false,
    false,
  );
  response = { ...response, expertReviewRequired: 'true' };
  await assert.rejects(api.read(target, new AbortController().signal), { code: 'validation' });
});
test(
  'workflow review entry DOM: human author plus expert reviewer can explicitly configure a model; pure human work does not ask for one',
  dom,
  async (t) => {
    let optionsRead = 0;
    const reviewView = { ...view, expertNodeCount: 0, expertReviewRequired: true };
    const h = await mount(t, WorkflowControls, {
      target,
      api: {
        read: async () => reviewView,
        options: async () => {
          optionsRead++;
          return { ...options, ...reviewView };
        },
        start: () => assert.fail('Explicit confirmation is required'),
      },
    });
    assert.equal(optionsRead, 0);
    await click(button(h, '运行工作流'));
    assert.equal(optionsRead, 1);
    assert.equal(button(h, '确认运行').disabled, true);
    await h.update({
      target,
      api: {
        read: async () => ({ ...reviewView, expertReviewRequired: false }),
        options: () => assert.fail('Pure human work needs no model'),
      },
    });
    assert(
      ![...h.container.querySelectorAll('button')].some((item) =>
        item.textContent.includes('运行工作流'),
      ),
    );
    assert.equal(h.container.querySelectorAll('dialog').length, 0);
  },
);
test(
  'workflow settings DOM: empty model explains next action; settings opens only explicitly after closing the foreground dialog',
  dom,
  async (t) => {
    let opened = 0;
    const h = await mount(t, WorkflowControls, {
      target,
      api: { read: async () => view, options: async () => options, start: () => assert.fail() },
      openModelSettings() {
        assert.equal(h.container.querySelectorAll('dialog').length, 0);
        opened++;
      },
    });
    assert.equal(opened, 0);
    await click(button(h, '运行工作流'));
    assert.match(h.container.textContent, /暂无可用模型/);
    assert.match(h.container.textContent, /先在设置中配置模型/);
    assert.equal(button(h, '确认运行').disabled, true);
    await click(button(h, '打开设置'));
    assert.equal(opened, 1);
    assert.equal(h.container.querySelectorAll('dialog').length, 0);
  },
);
test(
  'workflow settings DOM: authorization replaces one foreground, displays real scope and returns with choices and focus retained',
  dom,
  async (t) => {
    const h = await mount(t, WorkflowControls, {
      target,
      api: { read: async () => view, options: async () => options, start: () => assert.fail() },
      workspaceApprovals: {
        location,
        api: {
          context: async () => ({ accountName: 'chen', projectName: '订单中心' }),
          options: async () => ({ available: true, directories: [], approvals: [] }),
        },
      },
    });
    await click(button(h, '运行工作流'));
    await choose(
      h.container.querySelector('[aria-label="工作目录"]'),
      'Controlled directory · 只读',
    );
    await choose(h.container.querySelector('[aria-label="同时运行的 Agent"]'), '2');
    await click(button(h, '管理授权'));
    assert.equal(h.container.querySelectorAll('dialog').length, 1);
    assert.equal(h.container.querySelector('h2').textContent, '工作目录授权');
    assert.match(h.container.textContent, /订单中心/);
    assert.match(h.container.textContent, /chen/);
    await click(button(h, '返回运行设置'));
    assert.equal(h.container.querySelectorAll('dialog').length, 1);
    assert.match(
      h.container.querySelector('[aria-label="工作目录"]').textContent,
      /Controlled directory/,
    );
    assert.equal(
      h.container.querySelector('[aria-label="同时运行的 Agent"]').textContent.trim(),
      '2',
    );
    assert.equal(document.activeElement, button(h, '管理授权'));
    await act(async () => {
      h.container.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }));
      await tick();
    });
    assert.equal(h.container.querySelectorAll('dialog').length, 0);
    assert.equal(document.activeElement, button(h, '运行工作流'));
  },
);
test(
  'workflow settings DOM: revoked selected directory remains explicitly invalid across reopen until a deliberate valid selection',
  dom,
  async (t) => {
    for (const recovery of ['second', '']) {
      let revoked = false;
      const starts = [];
      const model = { provider: 'contract', model: 'model', maxTokens: 4096 };
      const h = await mount(t, WorkflowControls, {
        target,
        api: {
          read: async () => view,
          options: async () => ({
            ...view,
            models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: model }] },
            workspaces: [
              ...(!revoked ? [{ id: 'workspace', label: 'Project files', access: 'read' }] : []),
              { id: 'second', label: 'Other files', access: 'read' },
            ],
          }),
          start: async (input) => {
            starts.push(input);
            return { ...view, state: 'running', planStarted: true };
          },
        },
        workspaceApprovals: {
          location,
          api: {
            context: async () => ({ accountName: 'chen', projectName: '订单中心' }),
            options: async () => ({
              available: true,
              directories: [],
              approvals: revoked
                ? []
                : [
                    {
                      id: 'approval',
                      workspaceId: 'workspace',
                      generation: 1,
                      status: 'approved',
                      access: 'read',
                      publish: [],
                    },
                  ],
            }),
            revoke: async () => {
              revoked = true;
            },
          },
        },
      });
      await click(button(h, '运行工作流'));
      await choose(h.container.querySelector('[aria-label="模型"]'), 'Model');
      await choose(h.container.querySelector('[aria-label="工作目录"]'), 'Project files · 只读');
      await choose(h.container.querySelector('[aria-label="同时运行的 Agent"]'), '2');
      assert.equal(button(h, '确认运行').disabled, false);
      await click(button(h, '管理授权'));
      await click(button(h, '撤销'));
      await click(button(h, '返回运行设置'));
      assert.equal(
        button(h, '确认运行').disabled,
        true,
        'a missing directory cannot look executable',
      );
      let directory = h.container.querySelector('[aria-label="工作目录"]');
      assert.match(directory.textContent, /失效|不可用/u);
      assert.equal(directory.getAttribute('aria-invalid'), 'true');
      assert.match(h.container.textContent, /重新选择/u);
      await act(async () => {
        h.container
          .querySelector('form')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
      });
      assert.deepEqual(starts, [], 'form submission cannot silently fall back to text-only');
      await act(async () => {
        h.container
          .querySelector('dialog')
          .dispatchEvent(new Event('cancel', { cancelable: true }));
        await tick();
      });
      await click(button(h, '运行工作流'));
      directory = h.container.querySelector('[aria-label="工作目录"]');
      assert.match(directory.textContent, /失效|不可用/u);
      assert.equal(button(h, '确认运行').disabled, true);
      assert.equal(h.container.querySelector('[aria-label="模型"]').textContent.trim(), 'Model');
      assert.equal(
        h.container.querySelector('[aria-label="同时运行的 Agent"]').textContent.trim(),
        '2',
      );
      await choose(directory, recovery ? 'Other files · 只读' : '仅处理任务资料');
      assert.equal(directory.getAttribute('aria-invalid'), null);
      assert.equal(button(h, '确认运行').disabled, false);
      await click(button(h, '确认运行'));
      assert.equal(starts.length, 1);
      assert.deepEqual(
        starts[0].workspace,
        recovery ? { kind: 'local', id: recovery } : { kind: 'text-only' },
      );
      assert.deepEqual(starts[0].model, model);
      assert.equal(starts[0].concurrent, 2);
    }
  },
);
test(
  'workspace authorization DOM: a replaced member API cannot display late old scope labels or enable a picker',
  dom,
  async (t) => {
    const old = Promise.withResolvers();
    const props = {
      location,
      api: {
        options: async () => ({ available: true, directories: [], approvals: [] }),
        context: () => old.promise,
        pickDirectory: () => assert.fail(),
      },
      close() {},
      changed() {},
    };
    const h = await mount(t, WorkspaceApprovalDialog, props);
    assert.equal(button(h, '添加本机工作区').disabled, true);
    await h.update({
      ...props,
      api: {
        ...props.api,
        context: async () => {
          throw new Error('unavailable');
        },
      },
    });
    await act(async () => {
      old.resolve({ accountName: 'old', projectName: 'private old project' });
      await tick();
    });
    assert.doesNotMatch(h.container.textContent, /private old project/);
    assert.equal(button(h, '添加本机工作区').disabled, true);
  },
);
test(
  'workflow settings DOM: running and draining workflows can open original revocation without opening execution settings or starting again',
  dom,
  async (t) => {
    for (const state of ['running', 'stopping']) {
      const active = {
        ...view,
        state,
        planStarted: true,
        activeRunCount: 1,
        intent: { intentId: 'intent', generation: 1, version: 1, concurrent: 2 },
        selection: {
          model: { provider: 'contract', model: 'model', maxTokens: 4096 },
          workspace: { kind: 'local', id: 'workspace' },
        },
      };
      let revoked = false,
        reads = 0;
      const h = await mount(t, WorkflowControls, {
        target,
        api: {
          read: async () => {
            reads++;
            return active;
          },
          options: () => assert.fail('management must not open execution configuration'),
          start: () => assert.fail(),
          resume: () => assert.fail(),
          stop: () => assert.fail(),
        },
        workspaceApprovals: {
          location,
          api: {
            context: async () => ({ accountName: 'chen', projectName: '订单中心' }),
            options: async () => ({
              available: true,
              directories: [],
              approvals: [
                {
                  id: 'approval',
                  workspaceId: 'workspace',
                  generation: revoked ? 2 : 1,
                  status: revoked ? 'revoked' : 'approved',
                  access: revoked ? null : 'read',
                  publish: [],
                },
              ],
            }),
            revoke: async (input, signal) => {
              assert.deepEqual(
                { ...input, requestId: 'same-command-key' },
                {
                  ...location,
                  approvalId: 'approval',
                  expectedGeneration: 1,
                  requestId: 'same-command-key',
                },
              );
              assert.equal(typeof input.requestId, 'string');
              assert.equal(signal.aborted, false);
              revoked = true;
            },
          },
        },
      });
      assert.equal(button(h, '管理目录授权').disabled, false);
      assert.equal(h.container.querySelectorAll('.zm-single-select').length, 0);
      await click(button(h, '管理目录授权'));
      assert.equal(h.container.querySelectorAll('dialog').length, 1);
      await click(button(h, '撤销'));
      assert.equal(revoked, true);
      assert.ok(reads >= 2, 'original workflow fact is refreshed after revocation');
      await click(button(h, '返回工作流'));
      assert.equal(document.activeElement, button(h, '管理目录授权'));
      assert.equal(h.container.querySelectorAll('.zm-single-select').length, 0);
    }
  },
);
for (const refusal of [false, true])
  test(
    `workflow stopping recovery DOM: explicit original resume ${refusal ? 'retains stopping after refusal' : 'alone accepts the new generation'}`,
    dom,
    async (t) => {
      const model = { provider: 'contract', model: 'model', maxTokens: 4096 };
      const current = {
        ...view,
        state: 'stopping',
        planStarted: true,
        intent: { intentId: 'original', generation: 1, version: 3, concurrent: 1 },
        selection: { model, workspace: { kind: 'text-only' } },
      };
      const pending = Promise.withResolvers();
      t.after(() => pending.resolve(current));
      const calls = [];
      const api = {
        read: async () => current,
        options: async () => ({
          ...options,
          ...current,
          models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: model }] },
        }),
        start: () => assert.fail('Recovery cannot start another intent'),
        stop: () => assert.fail('Recovery uses the original resume API'),
        resume: async (input) => {
          calls.push(input);
          return pending.promise;
        },
      };
      const h = await mount(t, WorkflowControls, { target, api });
      assert.equal(calls.length, 0);
      await click(button(h, '刷新状态'));
      assert.equal(calls.length, 0, 'passive reads never recover');
      await click(button(h, '恢复工作流'));
      assert.equal(calls.length, 0, 'opening settings is not recovery');
      const dialog = h.container.querySelector('dialog');
      assert.ok(dialog);
      const confirm = button({ container: dialog }, '恢复工作流');
      assert.equal(confirm.type, 'submit');
      assert.equal(confirm.disabled, false);
      await click(confirm);
      assert.equal(confirm.disabled, true);
      assert.equal(calls.length, 1);
      const { requestId, ...input } = calls[0];
      assert.equal(typeof requestId, 'string');
      assert.deepEqual(input, {
        ...target,
        intentId: 'original',
        generation: 1,
        expectedVersion: 3,
      });
      await act(async () => {
        if (refusal)
          pending.reject(
            new ExecutionError('workflow-recovery-required', '资源尚未释放，请重试。'),
          );
        else
          pending.resolve({
            ...current,
            state: 'running',
            intent: { ...current.intent, generation: 2, version: 4 },
          });
        await tick();
      });
      if (refusal) {
        assert.ok(h.container.querySelector('dialog'));
        assert.match(h.container.textContent, /正在停止/);
        assert.match(dialog.querySelector('[role="alert"]').textContent, /尚未释放/);
        assert.equal(confirm.disabled, false);
      } else {
        assert.equal(h.container.querySelector('dialog'), null);
        assert.match(h.container.textContent, /运行中/);
        assert.ok(button(h, '停止工作流'));
      }
      assert.equal(calls.length, 1);
      assert.equal(model.maxTokens, 4096);
    },
  );

test(
  'settings launcher DOM: binding uses the real owner callback and is released on unmount',
  dom,
  async (t) => {
    let bound,
      opened = 0,
      released = 0;
    const snapshot = { session: { status: 'anonymous' }, space: undefined };
    const props = {
      wide: true,
      shell: { subscribe: () => () => {}, getSnapshot: () => snapshot },
      openWork() {},
    };
    const h = await mount(t, SidebarAccountSettingsLauncher, {
      ...props,
      openSettings: () => opened++,
      bindSettingsLauncher(open) {
        bound = open;
        return () => {
          released++;
          bound = undefined;
        };
      },
    });
    assert.equal(opened, 0);
    bound();
    assert.equal(opened, 1);
    await h.update({ ...props, openSettings: () => (opened += 10) });
    assert.equal(released, 1);
    assert.equal(bound, undefined);
  },
);
