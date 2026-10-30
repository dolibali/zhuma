/** React + optional installed Happy DOM contracts; no browser, Host or model authority. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (!domModule) {
  test(
    'Run workspace DOM contracts require the explicit installed qualification DOM module',
    { skip: true },
    () => {},
  );
} else {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  const window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'window',
    'localStorage',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'SVGElement',
    'Document',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLDialogElement',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'ResizeObserver',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? window : window[name],
    });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const { createElement: h, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { NativeRunLauncher } = await import('../dist/run/NativeRunWorkspace.js');
  const { ExecutionWorkspace } = await import('../dist/execution/ExecutionWorkspace.js');
  const { UnsavedChangesBoundary } = await import('../dist/workbench/UnsavedChanges.js');
  const { TaskEditor } = await import('../dist/workbench/TaskEditor.js');
  const { WorkbenchPage } = await import('../dist/workbench/WorkbenchPage.js');
  const { createTaskFilterStore } = await import('../dist/workbench/task-filters.js');
  const { row } = await import('./task-progress-fixture.mjs');
  const { applyWorkbenchCommand } = await import('@zhuma/agent-core');
  const { fixture } = await import('../../../tests/fixtures/workbench.mjs');
  const target = {
    spaceId: 'north',
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'node',
    title: 'Review current work',
  };
  const selection = {
    model: { provider: 'contract', model: 'model', maxTokens: 4096 },
    executor: { kind: 'builtin' },
  };
  const available = { kind: 'available' };
  const run = {
    ...target,
    runId: 'run',
    generation: 1,
    segmentId: 'segment',
    nodeVersion: 2,
    runVersion: 1,
    status: 'running',
    dispatch: 'received',
    resources: 'held',
    acknowledged: true,
    stopPhase: 'none',
    native: { sessionId: 'native', agentId: 'native', status: 'idle' },
    sendCapabilities: { followup: available, steer: available, queue: available },
  };
  function api(overrides = {}) {
    return {
      options: async () => ({
        target,
        nodeVersion: 2,
        runVersion: 1,
        currentRunId: 'run',
        selection,
        models: { kind: 'ready', items: [{ id: 'model', label: 'Model', value: selection.model }] },
        experts: [
          {
            id: 'builtin',
            label: 'Builtin',
            description: 'Current node',
            value: selection.executor,
          },
        ],
        resources: [],
        start: { kind: 'unavailable', message: 'Held' },
        tools: 'text-only',
      }),
      read: async () => run,
      history: async () => ({ messages: [], nextAfter: -1 }),
      begin: async () => {
        throw Error('Must not begin on mount');
      },
      send: async () => {},
      stop: async () => {
        throw Error('Closing must not stop a Run');
      },
      ...overrides,
    };
  }
  async function mount(current = api()) {
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node),
      dirty = new Set();
    const register = (token, value) => {
      if (value) dirty.add(token);
      return () => dirty.delete(token);
    };
    const render = async (next) => {
      current = next;
      await act(async () => {
        root.render(
          h(UnsavedChangesBoundary, { register }, h(NativeRunLauncher, { api: current, target })),
        );
      });
    };
    const button = (label) =>
      [...node.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === label ||
          item.querySelector('.zm-button-label')?.textContent === label,
      );
    const click = async (label) => {
      const item = button(label);
      assert.ok(item, label);
      await act(async () => item.click());
    };
    await render(current);
    await click('使用 Agent');
    const input = () => {
      const item = node.querySelector('textarea');
      assert.ok(item, 'message input');
      return item;
    };
    const type = async (text) => {
      const item = input();
      item.focus();
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
          item,
          text,
        );
        item.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    };
    return {
      node,
      dirty,
      click,
      render,
      input,
      type,
      cancelDialog: async (dialog) => {
        await act(async () =>
          dialog.dispatchEvent(new window.Event('cancel', { bubbles: true, cancelable: true })),
        );
      },
      submit: async () => {
        await act(async () =>
          node
            .querySelector('form')
            .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
        );
      },
      close: async () => {
        await act(async () => root.unmount());
        node.remove();
      },
    };
  }
  test('DOM task filters: persisted stage still loads every candidate plan and list/board share results without leaking scope', async () => {
    const data = fixture();
    let state = applyWorkbenchCommand(data.state, {
      type: 'save-task',
      task: { ...data.task, status: 'ready' },
    });
    state = applyWorkbenchCommand(state, {
      type: 'save-task',
      task: { ...data.task, id: 'second', title: '另一个任务', status: 'ready' },
    });
    const store = createTaskFilterStore();
    store.save(
      { accountId: 'chen', spaceId: 'north' },
      { projectId: '', participantId: '', stage: 'review', search: '', view: 'list' },
    );
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node),
      reads = [];
    const makeApi = (actorId) => ({
      member: { actorId, capabilities: () => ({ createTask: true, createProject: true }) },
      snapshot: async () => ({ state, model: 'unconfigured' }),
    });
    const api = makeApi('chen');
    const progressApi = {
      read: async (query) => {
        reads.push(structuredClone(query));
        return {
          items: query.plans.map((target) =>
            row({ target, delivery: target.taskId === 'second' ? 'all-accepted' : 'pending' }),
          ),
        };
      },
    };
    const render = async (api, spaceId) =>
      act(async () => {
        root.render(
          h(
            UnsavedChangesBoundary,
            { register: () => () => {} },
            h(WorkbenchPage, {
              api,
              initialSection: 'tasks',
              projectExecution: { spaceId, api: { taskProgress: progressApi } },
              appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
            }),
          ),
        );
        await new Promise(setImmediate);
      });
    const click = async (label) =>
      act(async () => {
        const button = [...node.querySelectorAll('button')].find(
          (item) => item.querySelector('.zm-button-label')?.textContent === label,
        );
        assert.ok(button, label);
        button.click();
        await new Promise(setImmediate);
      });
    try {
      await render(api, 'north');
      assert.equal(
        reads[0].plans.length,
        2,
        'Persisted stage cannot starve its own progress request',
      );
      assert.equal(node.querySelectorAll('.zm-task-row').length, 1);
      const title = node.querySelector('.zm-task-row strong').textContent;
      await click('看板');
      assert.equal(node.querySelectorAll('.zm-board-card').length, 1);
      assert.equal(node.querySelector('.zm-board-card strong').textContent, title);
      assert.ok(node.querySelector('.zm-task-filter-summary').textContent.includes('1 / 2'));
      await click('清除筛选');
      assert.equal(node.querySelectorAll('.zm-board-card').length, 2);
      await render(makeApi('bob'), 'south');
      assert.equal(node.querySelectorAll('.zm-board-card').length, 0);
      assert.equal(node.querySelectorAll('.zm-task-row').length, 2);
    } finally {
      await act(async () => root.unmount());
      node.remove();
      localStorage.clear();
    }
  });
  test('DOM planning readiness: checking service facts and a failed planning request preserve the live editor input', async () => {
    const data = fixture();
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    let ready = false,
      reads = 0,
      plans = 0;
    const workbench = {
      member: {
        actorId: 'chen',
        capabilities: () => ({
          planning: ready,
          tasks: [{ taskId: data.task.id, edit: true, confirm: true, plan: ready }],
        }),
      },
      snapshot: async () => {
        if (++reads === 1) throw Error('offline');
        ready = true;
        return { state: data.state, model: 'service / configured' };
      },
      plan: async () => {
        plans++;
        throw Error('Provider unavailable');
      },
      save: () => assert.fail('Checking a model must not save or replace the draft'),
    };
    const click = async (text) => {
      const button = [...node.querySelectorAll('button')].find(
        (item) =>
          (item.querySelector('.zm-button-label')?.textContent ?? item.textContent).trim() === text,
      );
      assert.ok(button, text);
      await act(async () => {
        button.click();
        await new Promise(setImmediate);
      });
    };
    try {
      await act(async () =>
        root.render(
          h(
            UnsavedChangesBoundary,
            { register: () => () => {} },
            h(TaskEditor, {
              original: data.task,
              state: data.state,
              api: workbench,
              model: '未配置模型',
              saved() {},
              close() {},
              appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
            }),
          ),
        ),
      );
      await click('✧ AI 规划');
      const input = node.querySelector('.zm-planner-composer textarea');
      assert.ok(input);
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
          input,
          '保留这份补充要求',
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await click('检查模型');
      assert.ok(node.textContent.includes('暂时无法确认规划模型'));
      assert.ok(input.isConnected);
      assert.equal(input.value, '保留这份补充要求');
      await click('检查模型');
      assert.ok(node.textContent.includes('service / configured'));
      const generate = node.querySelector('.zm-planning-actions button');
      assert.ok(generate && !generate.disabled);
      await act(async () => {
        generate.click();
        await new Promise(setImmediate);
      });
      assert.equal(plans, 1);
      assert.ok(input.isConnected);
      assert.equal(input.value, '保留这份补充要求');
      assert.ok(node.textContent.includes('Provider unavailable'));
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
  test('DOM task entry: a human assignee reads full work instructions through the original node controller without starting a workflow', async () => {
    for (const { authorized, owner } of [
      { authorized: true, owner: false },
      { authorized: false, owner: false },
      { authorized: false, owner: true },
    ]) {
      const data = fixture();
      data.node.description = `${'完整主入口工作说明。'.repeat(100)}\n最终细节 <literal>`;
      data.task.ownerId = 'outside';
      data.task.participantIds.push('outside');
      const state = applyWorkbenchCommand(data.state, {
        type: 'save-task',
        task: { ...data.task, status: 'ready' },
      });
      const task = state.tasks[0],
        plan = state.appliedPlans[0];
      const expected = {
        spaceId: 'north',
        taskId: task.id,
        planId: plan.id,
        revision: plan.revision,
        nodeId: data.node.id,
        title: data.node.title,
        description: `${data.node.title}\n\n${data.node.description}`,
      };
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      let reads = 0;
      const forbidden = () =>
        assert.fail('A node entry cannot control or read owner-only workflow state');
      const native = api({
        workflow: {
          options: forbidden,
          read: async () => ({
            target: {
              spaceId: 'north',
              taskId: task.id,
              planId: plan.id,
              revision: plan.revision,
            },
            title: task.title,
            state: 'inactive',
            planStarted: false,
            requiresResume: false,
            activeRunCount: 0,
            expertNodeCount: 1,
            intent: null,
            selection: null,
          }),
          start: forbidden,
          resume: forbidden,
          stop: forbidden,
        },
        options: async (received) => {
          reads++;
          assert.deepEqual(received, expected);
          if (!authorized) throw Error('Original node authority denied');
          return {
            ...(await api().options()),
            target: expected,
            currentRunId: null,
            selection: null,
            start: available,
          };
        },
      });
      try {
        await act(async () =>
          root.render(
            h(TaskEditor, {
              original: task,
              state,
              api: {
                member: {
                  actorId: owner ? 'outside' : 'chen',
                  capabilities: () => ({ tasks: [] }),
                },
              },
              model: '',
              saved: forbidden,
              close() {},
              appearance: { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} },
              nativeRun: { api: native, spaceId: 'north' },
            }),
          ),
        );
        assert.equal(reads, 0, 'Rendering a task must not perform model discovery or commands');
        const launch = [...node.querySelectorAll('button')].find(
          (item) => item.querySelector('.zm-button-label')?.textContent === '使用 Agent',
        );
        assert.ok(launch);
        if (owner) {
          assert.equal(launch.disabled, true);
          assert.match(launch.title, /请先运行工作流/);
          assert.equal(reads, 0);
          continue;
        }
        assert.equal(
          launch.disabled,
          false,
          'The assignee does not need task-owner workflow state',
        );
        assert.ok(node.querySelector('[aria-label="工作流执行"]'));
        await act(async () => launch.click());
        assert.equal(reads, 1);
        const description = node.querySelector('.zm-native-run__context');
        assert.ok(description);
        assert.equal(description.open, false);
        assert.equal(description.querySelector('p').textContent, expected.description);
        assert.ok(
          node.textContent.includes(authorized ? '配置此次执行' : '暂时无法读取这个工作节点'),
        );
        if (!authorized) assert.equal(node.querySelector('[aria-label="选择模型"]'), null);
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  });
  test('DOM contract: close/ESC guards preserve unsent text and focus; only confirmed abandon clears this scope', async () => {
    const current = await mount();
    try {
      await current.type('Keep this unsent draft');
      const input = current.input();
      assert.equal(
        current.dirty.size,
        1,
        'existing navigation/space guard receives dirty presence',
      );
      await current.cancelDialog(current.node.querySelector('dialog'));
      assert.ok(current.node.querySelector('.zm-dialog-confirmation'));
      await current.cancelDialog(current.node.querySelector('.zm-dialog-confirmation'));
      assert.equal(current.input(), input);
      assert.equal(input.value, 'Keep this unsent draft');
      assert.equal(document.activeElement, input);
      await current.click('关闭');
      await current.click('继续编辑');
      assert.equal(input.value, 'Keep this unsent draft');
      await current.click('关闭');
      await current.click('放弃并离开');
      assert.equal(current.node.querySelector('textarea'), null);
      assert.equal(current.dirty.size, 0);
      await current.click('使用 Agent');
      assert.equal(current.input().value, '');
    } finally {
      await current.close();
    }
  });
  test('DOM contract: acknowledged send clears dirty presence; opening and closing never stop a Run', async () => {
    let sends = 0,
      stops = 0;
    const current = await mount(
      api({
        send: async () => {
          sends++;
        },
        stop: async () => {
          stops++;
        },
      }),
    );
    try {
      await current.type('Send explicitly');
      assert.equal(current.dirty.size, 1);
      await current.submit();
      assert.equal(sends, 1);
      assert.equal(current.input().value, '');
      assert.equal(current.dirty.size, 0);
      await current.click('关闭');
      assert.equal(current.node.querySelector('.zm-dialog-confirmation'), null);
      assert.equal(stops, 0);
    } finally {
      await current.close();
    }
  });
  test('DOM keyboard contract: Escape closes the selector first; workspace cancellation closes before refocusing its opener', async () => {
    const current = await mount(
      api({
        options: async () => ({
          ...(await api().options()),
          currentRunId: null,
          selection: null,
          start: available,
        }),
      }),
    );
    try {
      const dialog = current.node.querySelector('.zm-dialog-workspace');
      const selector = dialog.querySelector('[aria-label="选择模型"]');
      await act(async () => {
        selector.focus();
        selector.click();
      });
      assert.ok(document.querySelector('[role="listbox"]'));
      await act(async () =>
        document.activeElement.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      assert.equal(selector.getAttribute('aria-expanded'), 'false', 'first Escape closes the menu');
      assert.ok(dialog.isConnected && dialog.open);
      assert.ok(document.activeElement === selector, 'first Escape refocuses the selector');
      const opener = [...current.node.querySelectorAll('button')].find(
        (button) => button.querySelector('.zm-button-label')?.textContent === '使用 Agent',
      );
      const order = [],
        close = dialog.close.bind(dialog),
        focus = opener.focus.bind(opener);
      dialog.close = () => {
        order.push('close');
        close();
      };
      opener.focus = () => {
        order.push('focus');
        focus();
      };
      // Happy DOM does not implement the browser's Escape -> dialog cancel default.
      // Dispatch its native cancel event; root verifies the actual second key in GUI.
      await current.cancelDialog(dialog);
      assert.equal(current.node.querySelector('.zm-dialog-workspace'), null);
      assert.ok(order.indexOf('close') >= 0);
      assert.ok(order.indexOf('focus') > order.indexOf('close'));
      assert.ok(document.activeElement === opener, 'workspace close refocuses its opener');
    } finally {
      await current.close();
    }
  });
  test('DOM focus contract: replacing the member API cannot refocus a disconnected previous-scope opener', async () => {
    const current = await mount();
    try {
      const opener = [...current.node.querySelectorAll('button')].find(
        (button) => button.querySelector('.zm-button-label')?.textContent === '使用 Agent',
      );
      let focused = 0;
      opener.focus = () => focused++;
      await current.render(api());
      assert.equal(opener.isConnected, false);
      assert.equal(focused, 0);
      assert.equal(current.node.querySelector('.zm-dialog-workspace'), null);
    } finally {
      await current.close();
    }
  });
  test('DOM contract: real API/controller replacement immediately fences old draft and late send without transfer', async () => {
    const late = Promise.withResolvers();
    let nextSends = 0;
    const current = await mount(api({ send: async () => late.promise }));
    try {
      await current.type('Old account input');
      await current.submit();
      await current.render(
        api({
          send: async () => {
            nextSends++;
          },
        }),
      );
      assert.equal(current.node.querySelector('textarea'), null);
      assert.equal(current.node.querySelector('.zm-dialog-confirmation'), null);
      assert.equal(current.dirty.size, 0);
      await current.click('使用 Agent');
      assert.equal(current.input().value, '');
      await current.type('New account input');
      await act(async () => late.resolve());
      assert.equal(current.input().value, 'New account input');
      assert.equal(current.dirty.size, 1);
      assert.equal(nextSends, 0);
    } finally {
      late.resolve();
      await current.close();
    }
  });

  test('DOM contract: human submission and revision launch Agent from the delivery heading while preserving the form', async () => {
    for (const action of ['submit', 'revise']) {
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      let drafts = 0,
        options = 0;
      const execution = {
        nodeId: 'node',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        version: 1,
        status: action === 'submit' ? 'ready' : 'needs-revision',
        goal: 'Prepare the release notes',
        assigneeId: 'chen',
        reviewerIds: [],
        artifacts: [],
        rounds: [],
        comments: [],
      };
      const item = {
        id: 'item',
        kind: 'deliver',
        actorId: 'chen',
        nodeId: 'node',
        taskId: 'task',
        reason: action === 'submit' ? 'assignee-delivery' : 'revision-delivery',
        action,
      };
      const executionApi = {
        inbox: async () => ({ items: [item], nodes: [execution] }),
        readDeliveryDraft: async () => {
          drafts++;
          return { version: 0, text: '', links: [], files: [] };
        },
        revision: async () => ({ notes: [], reviewed: undefined }),
      };
      const nativeApi = api({
        options: async () => {
          options++;
          return api().options();
        },
      });
      try {
        await act(async () =>
          root.render(
            h(ExecutionWorkspace, {
              api: executionApi,
              nativeRun: { api: nativeApi, spaceId: 'north' },
            }),
          ),
        );
        const open = node.querySelector('.zm-directory-actions button');
        assert.ok(open);
        await act(async () => open.click());
        const form = node.querySelector('textarea')?.closest('.zm-execution-detail');
        assert.ok(form);
        assert.equal(drafts, 1);
        assert.equal(options, 0, 'opening a human delivery does not discover models');
        assert.equal(
          node.querySelector('.zm-run-node-entry'),
          null,
          'no intermediate duplicate title',
        );
        const heading = form.querySelector('.zm-page-heading');
        assert.equal(heading.querySelector('h2').textContent, execution.goal);
        const launch = heading.querySelector('button');
        assert.equal(launch.querySelector('.zm-button-label').textContent, '使用 Agent');
        const input = form.querySelector('textarea');
        await act(async () => launch.click());
        assert.ok(node.querySelector('.zm-run-workspace-dialog'));
        assert.equal(options, 1);
        assert.ok(input.isConnected && form.contains(input), 'launching preserves the manual form');
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  });

  test('DOM contract: a service continuation item reopens the same persisted Run from My Work without beginning or submitting', async () => {
    const execution = {
      ...target,
      version: 2,
      status: 'running',
      goal: target.title,
      assigneeId: 'chen',
      reviewerIds: [],
      artifacts: [],
      rounds: [],
      comments: [],
    };
    const item = {
      id: 'continuation',
      kind: 'deliver',
      actorId: 'chen',
      nodeId: target.nodeId,
      taskId: target.taskId,
      reason: 'agent-assisted-delivery',
      action: 'continue-handling',
    };
    const describedTarget = { ...target, description: execution.goal };
    const reads = [],
      histories = [];
    let options = 0,
      begins = 0,
      submissions = 0;
    const executionApi = {
      inbox: async () => ({ items: [item], nodes: [execution] }),
      submit: async () => submissions++,
    };
    const nativeApi = api({
      options: async (current) => {
        assert.deepEqual(current, describedTarget);
        options++;
        return api().options();
      },
      read: async (current, runId) => {
        reads.push({ current, runId });
        return run;
      },
      history: async (current, runId) => {
        histories.push({ current, runId });
        return {
          messages: [{ id: 'saved', sequence: 1, role: 'assistant', text: 'Persisted result' }],
          nextAfter: 1,
        };
      },
      begin: async () => begins++,
    });
    // Two fresh React roots model leaving/re-entering the Client. Host cold-start
    // proof remains separate; neither render may replace or start the saved Run.
    for (let round = 0; round < 2; round++) {
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      try {
        await act(async () =>
          root.render(
            h(ExecutionWorkspace, {
              api: executionApi,
              nativeRun: { api: nativeApi, spaceId: target.spaceId },
            }),
          ),
        );
        assert.equal(options, round, 'inbox render performs no native discovery or command');
        const open = node.querySelector('.zm-directory-actions button');
        assert.equal(open.querySelector('.zm-button-label').textContent, '打开 Agent 会话');
        assert.equal(open.disabled, false);
        await act(async () => open.click());
        assert.equal(options, round + 1);
        assert.ok(node.querySelector('.zm-run-workspace-dialog'));
        assert.ok(node.textContent.includes('Persisted result'));
        assert.equal(node.querySelector('.zm-execution-detail'), null, 'no fake manual delivery');
        assert.deepEqual(reads.at(-1), { current: describedTarget, runId: run.runId });
        assert.deepEqual(histories.at(-1), { current: describedTarget, runId: run.runId });
        assert.equal(begins, 0);
        assert.equal(submissions, 0);
      } finally {
        await act(async () => root.unmount());
        node.remove();
      }
    }
  });

  test('DOM/style contract: conversation keeps one title and a full-width vertical composer without changing ordinary modal footers', async () => {
    const style = document.createElement('style');
    style.textContent = (
      await Promise.all([
        readFile(new URL('../src/workbench/workbench.css', import.meta.url), 'utf8'),
        readFile(new URL('../src/run/NativeRunPanel.css', import.meta.url), 'utf8'),
      ])
    ).join('\n');
    document.head.append(style);
    const current = await mount(
      api({
        history: async () => ({
          nextAfter: 2,
          messages: [
            { id: 'human', sequence: 1, role: 'user', text: '请先核对发布范围。' },
            {
              id: 'agent',
              sequence: 2,
              role: 'assistant',
              text: '已整理范围。\n我会继续检查兼容性、文档和回归结果。',
            },
          ],
        }),
      }),
    );
    const ordinary = document.createElement('dialog');
    ordinary.className = 'zm-dialog';
    ordinary.innerHTML = '<footer><button>保存</button></footer>';
    document.body.append(ordinary);
    try {
      const dialog = current.node.querySelector('dialog');
      assert.equal(dialog.getAttribute('aria-label'), target.title);
      assert.equal(dialog.querySelectorAll('h2').length, 1);
      assert.equal(dialog.querySelector('footer'), null);
      const footer = dialog.querySelector('.zm-native-run__footer');
      const composer = footer.querySelector('form');
      assert.equal(getComputedStyle(footer).flexDirection, 'column');
      assert.equal(getComputedStyle(composer).width, '100%');
      assert.equal(getComputedStyle(composer).flexDirection, 'column');
      const user = dialog.querySelector('[data-role="user"]');
      assert.equal(user.getAttribute('aria-label'), '用户');
      assert.equal(getComputedStyle(user).justifySelf, 'end');
      assert.equal(getComputedStyle(user).maxWidth, '85%');
      assert.equal(dialog.querySelector('.zm-native-run__config').open, false);
      assert.equal(getComputedStyle(ordinary.querySelector('footer')).justifyContent, 'flex-end');
    } finally {
      await current.close();
      ordinary.remove();
      style.remove();
    }
  });
}
