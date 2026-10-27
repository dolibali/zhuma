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
    'HTMLSelectElement',
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
const { createElement: el, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { emptyWorkbench } = await import('@zhuma/agent-core');
const { createNativeRunApi } = await import('../dist/run/api.js');
const { WorkflowControls } = await import('../dist/workflow/WorkflowControls.js');
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
  workspaces: [{ id: 'workspace', title: 'Controlled directory', access: 'read' }],
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
async function choose(item, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(item, value);
    item.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
  });
}
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
    const selects = h.container.querySelectorAll('select');
    await choose(selects[1], 'workspace');
    await choose(selects[2], '2');
    await click(button(h, '管理授权'));
    assert.equal(h.container.querySelectorAll('dialog').length, 1);
    assert.equal(h.container.querySelector('h2').textContent, '工作目录授权');
    assert.match(h.container.textContent, /订单中心/);
    assert.match(h.container.textContent, /chen/);
    await click(button(h, '返回运行设置'));
    assert.equal(h.container.querySelectorAll('dialog').length, 1);
    assert.equal(h.container.querySelectorAll('select')[1].value, 'workspace');
    assert.equal(h.container.querySelectorAll('select')[2].value, '2');
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
      await choose(h.container.querySelector('[aria-label="模型"]'), 'model');
      await choose(h.container.querySelector('[aria-label="工作目录"]'), 'workspace');
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
      assert.equal(directory.value, 'workspace');
      assert.match(directory.selectedOptions[0].textContent, /失效|不可用/u);
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
      assert.equal(directory.value, 'workspace');
      assert.equal(button(h, '确认运行').disabled, true);
      assert.equal(h.container.querySelector('[aria-label="模型"]').value, 'model');
      assert.equal(h.container.querySelector('[aria-label="同时运行的 Agent"]').value, '2');
      await choose(directory, recovery);
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
    assert.equal(button(h, '选择本机目录').disabled, true);
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
    assert.equal(button(h, '选择本机目录').disabled, true);
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
      assert.equal(h.container.querySelectorAll('select').length, 0);
      await click(button(h, '管理目录授权'));
      assert.equal(h.container.querySelectorAll('dialog').length, 1);
      await click(button(h, '撤销'));
      assert.equal(revoked, true);
      assert.ok(reads >= 2, 'original workflow fact is refreshed after revocation');
      await click(button(h, '返回工作流'));
      assert.equal(document.activeElement, button(h, '管理目录授权'));
      assert.equal(h.container.querySelectorAll('select').length, 0);
    }
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
