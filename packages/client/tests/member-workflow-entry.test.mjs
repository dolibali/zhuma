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
  const { applyWorkbenchCommand } = await import('@zhuma/agent-core');
  const { fixture } = await import('../../../tests/fixtures/workbench.mjs');
  const { row } = await import('./task-progress-fixture.mjs');
  test('DOM formal member entry: confirmed work exposes workflow only through the local member transport after explicit action', async () => {
    const { MemberExecutionPage } = await import('../dist/execution/MemberExecutionPage.js');
    const { createMemberNativeClient } = await import('../dist/run/member-native.js');
    for (const nativeExecution of [true, false]) {
      const data = fixture();
      const state = applyWorkbenchCommand(data.state, {
        type: 'save-task',
        task: { ...data.task, status: 'ready' },
      });
      state.receipts = [];
      const plan = state.appliedPlans[0];
      const space = { id: 'north', kind: 'team', name: '研发团队' };
      const identity = {
        ok: true,
        accountId: 'chen',
        principal: { kind: 'zhuma-member', memberId: 'chen' },
        peerId: 'fixture-peer',
        spaces: [space],
      };
      const target = {
        spaceId: space.id,
        taskId: data.task.id,
        planId: plan.id,
        revision: plan.revision,
      };
      const model = { provider: 'contract', model: 'configured', maxTokens: 4096 };
      let current = {
        target,
        title: data.task.title,
        state: 'inactive',
        planStarted: true,
        requiresResume: false,
        activeRunCount: 0,
        expertNodeCount: 1,
        controlledNodeCount: 1,
        automaticReview: true,
        intent: null,
        selection: null,
      };
      const calls = [];
      const reply = (wire, value) =>
        Response.json({
          type: 'server-response',
          rpcId: wire.rpcId,
          result: { ok: true, value },
        });
      const fetcher = async (url, init) => {
        if (url === '/zhuma-id/session') return Response.json(identity);
        const wire = JSON.parse(init.body);
        if (url === '/api/zhuma-member/snapshot')
          return reply(wire, {
            actorId: 'chen',
            spaceId: space.id,
            space,
            state,
            model: null,
            capabilities: {
              createProject: true,
              createTask: true,
              planning: false,
              resources: 'authorized',
              tasks: [{ taskId: data.task.id, edit: true, confirm: true, plan: false }],
            },
          });
        if (url === '/api/zhuma-exec/task-progress')
          return reply(wire, {
            actorId: 'chen',
            spaceId: space.id,
            coverage: 'current-confirmed-plans',
            items: wire.payload.plans.map((target) => row({ target })),
          });
        assert.fail('Unexpected member business or owner route: ' + url);
      };
      const backend = {
        getSnapshot: () => ({
          phase: 'ready',
          selection: {
            origin: 'http://backend.invalid',
            connectionId: 'fixture-connection',
          },
        }),
        fetcher,
      };
      const memberNative = createMemberNativeClient(backend, async (url, init) => {
        const wire = JSON.parse(init.body);
        calls.push({ url, wire });
        assert.equal(wire.payload.actorId, 'chen');
        assert.equal(wire.payload.spaceId, space.id);
        assert.equal(wire.payload.connectionId, 'fixture-connection');
        const endpoint = url.split('/').at(-1);
        if (endpoint === 'workflow-read') return reply(wire, current);
        if (endpoint === 'workflow-options')
          return reply(wire, {
            ...current,
            maxConcurrent: 1,
            workspaces: [],
            models: {
              kind: 'ready',
              items: [{ id: 'model', label: 'Configured model', value: model }],
            },
          });
        if (endpoint === 'workflow-start') {
          assert.deepEqual(wire.payload.query.model, model);
          assert.equal(wire.payload.query.automaticRevisions, 2);
          current = {
            ...current,
            state: 'waiting',
            intent: {
              intentId: 'original-intent',
              generation: 1,
              version: 1,
              concurrent: 1,
              automaticRevisions: 2,
            },
            selection: { model, workspace: { kind: 'text-only' } },
          };
          return reply(wire, current);
        }
        assert.fail('Unexpected local native/owner route: ' + url);
      });
      const node = document.createElement('div');
      document.body.append(node);
      const root = createRoot(node);
      const click = async (label) => {
        const button = [...node.querySelectorAll('button')].find(
          (item) =>
            (item.querySelector('.zm-button-label')?.textContent ?? item.textContent).trim() ===
            label,
        );
        assert.ok(button, 'Missing actual member button: ' + label + '\n' + node.textContent);
        await act(async () => {
          button.click();
          await new Promise(setImmediate);
        });
      };
      try {
        await act(async () => {
          root.render(
            h(MemberExecutionPage, {
              fetcher,
              memberNative,
              nativeExecution,
              view: 'catalog',
              workbenchAppearance: {
                getSnapshot: () => 'light',
                subscribe: () => () => {},
                set() {},
              },
            }),
          );
          await new Promise(setImmediate);
        });
        const taskRow = node.querySelector('.zm-task-row');
        assert.ok(taskRow, node.textContent);
        await act(async () => {
          taskRow.click();
          await new Promise(setImmediate);
        });
        if (!nativeExecution) {
          assert.equal(node.querySelector('.zm-workflow-controls'), null);
          assert.equal(calls.length, 0, 'Member Web must not acquire a local workflow entry');
          continue;
        }
        assert.ok(calls.length > 0, 'The formal task entry must pass its original workflow API');
        assert.ok(calls.every(({ url }) => url === '/api/zhuma-member-native/workflow-read'));
        await click('运行工作流');
        assert.equal(calls.at(-1).url, '/api/zhuma-member-native/workflow-options');
        assert.ok(
          !node.textContent.includes('管理授权'),
          'Old owner workspace-approval routes stay hidden',
        );
        await act(async () => node.querySelector('[aria-label="模型"]').click());
        await act(async () =>
          [...node.querySelectorAll('[role="option"]')]
            .find((option) => option.textContent.trim() === 'Configured model')
            .click(),
        );
        await act(async () => node.querySelector('[aria-label="评审退回后自动返工"]').click());
        await act(async () =>
          [...node.querySelectorAll('[role="option"]')]
            .find((option) => option.textContent.trim() === '最多 2 轮')
            .click(),
        );
        assert.equal(calls.filter(({ url }) => url.endsWith('/workflow-start')).length, 0);
        await click('确认运行');
        assert.equal(calls.filter(({ url }) => url.endsWith('/workflow-start')).length, 1);
        assert.ok(node.textContent.includes('停止工作流'));
      } finally {
        await act(async () => root.unmount());
        node.remove();
        localStorage.clear();
      }
    }
  });
}
