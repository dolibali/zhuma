/** Pure Client projection tests. No Host, model, filesystem or browser authority.
 * Set ZHUMA_NATIVE_PANEL_DOM_MODULE to an installed happy-dom ESM module for
 * the additional real React DOM interaction contracts; it is never downloaded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
let window;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  window = new Window({ url: 'http://localhost/' });
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'SVGElement',
    'Document',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
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
}
const { createElement, act } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { NativeRunPanel } = await import('../dist/run/NativeRunPanel.js');
const { NativeReviewLauncher, NativeReviewHistory } =
  await import('../dist/run/NativeReviewWorkspace.js');

function reviewOutcome(query, status = 'open') {
  return {
    target: { ...query, artifactFingerprint: 'a'.repeat(64) },
    controllerMemberId: 'member',
    nodeStatus: status === 'approved' ? 'completed' : 'needs-revision',
    artifact: {
      id: query.artifactVersionId,
      version: 2,
      text: '固定第二版正文',
      links: [],
      files: [],
    },
    round: {
      id: query.roundId,
      artifactVersionId: query.artifactVersionId,
      status,
      reviewerIds: ['one'],
      ballots:
        status === 'open'
          ? []
          : [
              {
                reviewerId: 'one',
                reviewerName: '独立评审专家',
                roundId: query.roundId,
                artifactVersionId: query.artifactVersionId,
                action: status === 'approved' ? 'approve' : 'request-changes',
                comment: '已核对固定版本的具体意见 <literal>',
              },
            ],
    },
    comments: [],
  };
}

test(
  'DOM contract: a settled first expert can yield to the next eligible reviewer without restarting itself',
  { skip: !domModule },
  async () => {
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let reads = 0,
      starts = 0;
    const api = {
      outcome: async (query) => reviewOutcome(query),
      options: async () => {
        reads++;
        return {
          currentRunId: 'old',
          models: { kind: 'ready', items: [] },
          facts: {
            expectedReviewVersion: 2,
            reviewers: [
              { name: 'QA One', reviewerRef: { id: 'one' }, canStart: false },
              { name: 'QA Two', reviewerRef: { id: 'two' }, canStart: true },
            ],
          },
        };
      },
      read: async () => ({
        runId: 'old',
        reviewerId: 'one',
        resources: 'settled',
        status: 'completed',
        receipt: { action: 'approve' },
      }),
      start: async () => {
        starts++;
        throw Error('User did not start');
      },
    };
    const query = {
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      roundId: 'round',
      artifactVersionId: 'artifact',
    };
    const click = async (text) =>
      act(async () => {
        const button = [...document.querySelectorAll('button')].find(
          (button) => button.querySelector('.zm-button-label')?.textContent.trim() === text,
        );
        assert.ok(button, text);
        button.click();
        await new Promise(setImmediate);
      });
    try {
      await act(async () =>
        root.render(createElement(NativeReviewLauncher, { api, target: query })),
      );
      await click('查看评审');
      assert.equal(
        [...document.querySelectorAll('button')].some(
          (button) => button.querySelector('.zm-button-label')?.textContent.trim() === '开始评审',
        ),
        false,
      );
      await click('选择下一位评审');
      assert.ok(
        [...document.querySelectorAll('button')].some(
          (button) => button.querySelector('.zm-button-label')?.textContent.trim() === '开始评审',
        ),
      );
      assert.ok(document.body.textContent.includes('QA One · 已通过'));
      assert.equal(reads, 2);
      assert.equal(starts, 0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);
test(
  'DOM contract: cold Stop is explicit and retries the same intent after an unknown response',
  { skip: !domModule },
  async () => {
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      keys = [];
    const api = {
      outcome: async (query) => reviewOutcome(query),
      session: async () => ({
        nextAfter: -1,
        messages: [],
        run: {
          runId: 'old',
          resources: 'held',
          phase: 'recovery-required',
          attemptVersion: 2,
          stopRequested: false,
        },
      }),
      stopSession: async (_target, _sid, run, key) => {
        keys.push([key, run.attemptVersion]);
        throw Error('Unknown original stop ACK');
      },
      recover: () => assert.fail('No automatic recovery'),
      start: () => assert.fail('No drive'),
    };
    const query = {
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      roundId: 'round',
      artifactVersionId: 'artifact',
    };
    try {
      await act(async () => {
        root.render(
          createElement(NativeReviewHistory, {
            api,
            target: query,
            sessionId: 'original-session',
            close() {},
          }),
        );
        await new Promise(setImmediate);
      });
      assert.equal(keys.length, 0);
      for (let i = 0; i < 2; i++)
        await act(async () => {
          const button = [...host.querySelectorAll('button')].find(
            (button) => button.querySelector('.zm-button-label')?.textContent.trim() === '停止评审',
          );
          assert.ok(button);
          button.click();
          await new Promise(setImmediate);
        });
      assert.equal(keys.length, 2);
      assert.deepEqual(keys[0], keys[1]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);

test(
  'DOM contract: closed decisions reopen from task and native history with specific fixed feedback and no writes',
  { skip: !domModule },
  async () => {
    const { createRoot } = await import('react-dom/client');
    const query = {
      spaceId: 'space',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      nodeId: 'node',
      roundId: 'old-round',
      artifactVersionId: 'old-artifact',
    };
    for (const status of ['approved', 'changes-requested']) {
      const seen = [];
      const api = {
        outcome: async (target) => {
          seen.push(structuredClone(target));
          return reviewOutcome(target, status);
        },
        options: () => assert.fail('Closed feedback must not query open-round options'),
        start: () => assert.fail('No start from read-only feedback'),
        recover: () => assert.fail('No automatic recovery'),
        session: async () => ({
          run: { resources: 'settled', receipt: { action: 'approve' } },
          messages: [],
          nextAfter: -1,
        }),
      };
      for (const history of [false, true]) {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        try {
          await act(async () => {
            root.render(
              history
                ? createElement(NativeReviewHistory, {
                    api,
                    target: query,
                    sessionId: 'original-review',
                    close() {},
                  })
                : createElement(NativeReviewLauncher, { api, target: query }),
            );
            await new Promise(setImmediate);
          });
          if (!history)
            await act(async () => {
              [...host.querySelectorAll('button')]
                .find((button) => button.textContent.includes('查看评审'))
                .click();
              await new Promise(setImmediate);
            });
          if (!history) {
            const scroller = document.querySelector('dialog > .zm-form-body');
            assert.ok(scroller, 'Long fixed content uses the existing dialog scroll body');
            assert.equal(scroller.tabIndex, 0, 'The scroll body is keyboard reachable');
            assert.equal(document.querySelectorAll('dialog > header h2').length, 1);
          }
          const text = document.body.textContent;
          assert.ok(text.includes('独立评审专家'));
          assert.ok(text.includes('已核对固定版本的具体意见 <literal>'));
          assert.ok(text.includes('固定第二版正文'));
          assert.ok(text.includes('第 2 版'));
          assert.ok(text.includes(status === 'approved' ? '评审已通过' : '已退回修改'));
          assert.equal(
            [...document.querySelectorAll('button')].some((button) =>
              button.textContent.includes('开始评审'),
            ),
            false,
          );
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      }
      assert.equal(seen.length, 2, 'Each cold view reads the actual persisted outcome');
      for (const target of seen)
        assert.deepEqual(target, query, 'Old round remains exact; never replace with latest');
    }
  },
);

const available = { kind: 'available' };
const unavailable = { kind: 'unavailable', message: '当前能力不可用' };
const model = { provider: 'contract', model: 'configured-model', maxTokens: 1000 };
const selection = { model, executor: { kind: 'builtin' } };
const target = {
  spaceId: 'space',
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  title: '实现任务状态筛选',
};

test('native turn outcome is a safe reason, never an artifact receipt or a later turn status', () => {
  const ended = { type: 'turn-end', seq: 7, time: 1, turn: 1, reason: { kind: 'max-tokens' } };
  const current = view({ run, turnEnd: ended });
  const html = renderToStaticMarkup(createElement(NativeRunPanel, props({ view: current })));
  assert.match(html, /达到输出上限/);
  assert.match(html, /尚未提交产物/);
  assert.match(html, /需要处理/);
  const next = renderToStaticMarkup(
    createElement(
      NativeRunPanel,
      props({
        view: {
          ...current,
          messages: [{ id: 'later', role: 'user', sequence: 8, text: 'continue' }],
        },
      }),
    ),
  );
  assert.doesNotMatch(next, /达到输出上限/);
});
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
  acknowledged: false,
  stopPhase: 'none',
  native: { sessionId: 'native', agentId: 'native', status: 'idle' },
};
function view(partial = {}) {
  return {
    kind: 'ready',
    run: null,
    messages: [],
    hasEarlier: false,
    selection,
    models: { kind: 'ready', items: [{ id: 'model', label: '已配置模型', value: model }] },
    experts: {
      kind: 'ready',
      items: [{ id: 'builtin', label: '内置 Agent', description: '', value: selection.executor }],
    },
    resources: [],
    actions: {
      start: available,
      stop: unavailable,
      send: { followup: unavailable, steer: unavailable, queue: unavailable },
    },
    ...partial,
  };
}
function props(partial = {}) {
  return {
    target,
    view: view(),
    onSelectionChange() {},
    onStart: async () => {},
    onSend: async () => {},
    onStop: async () => {},
    onRefresh: async () => {},
    onLoadEarlier: async () => {},
    ...partial,
  };
}

const render = (partial = {}) =>
  renderToStaticMarkup(createElement(NativeRunPanel, props(partial)));
const running = (partial = {}) =>
  view({
    run,
    actions: {
      start: unavailable,
      stop: available,
      send: { followup: available, steer: unavailable, queue: unavailable },
    },
    ...partial,
  });

test('SSR: rendering and target changes never start, send, refresh or choose defaults', () => {
  const calls = () => assert.fail('passive render called a handler');
  for (const current of [target, { ...target, spaceId: 'other-space', nodeId: 'other-node' }]) {
    const html = render({
      target: current,
      onStart: calls,
      onSend: calls,
      onSelectionChange: calls,
      onRefresh: calls,
    });
    assert.ok(html.includes('开始执行'));
    assert.ok(!html.includes('<textarea'));
    assert.ok(html.includes('aria-label="选择模型"'));
  }
});

test('SSR: first-run configuration is expanded and ready selection has one explicit start action', () => {
  const ready = render();
  assert.match(ready, /<details class="zm-native-run__config" open=""/);
  assert.ok(ready.includes('准备就绪'));
  assert.equal((ready.match(/开始执行/g) ?? []).length, 1);
  for (const duplicate of [
    '配置完成后开始',
    '准备好后，开始执行此节点',
    '选择模型和执行者，然后开始',
  ])
    assert.ok(!ready.includes(duplicate));
  const empty = render({ view: view({ selection: null }) });
  assert.ok(empty.includes('配置此次执行'));
  assert.ok(empty.includes('未选模型'));
  assert.ok(empty.includes('未选执行者'));
  assert.ok(!empty.includes('准备就绪'));
});

test('SSR: long node goals remain complete in a collapsed work description without executing', () => {
  const description = `完整工作说明 <literal>\n${'保留全部正文与换行。'.repeat(600)}\n最终要求`;
  const passive = () => assert.fail('reading the work description must not execute');
  const html = render({
    target: { ...target, description },
    onStart: passive,
    onSend: passive,
    onSelectionChange: passive,
    onRefresh: passive,
  });
  assert.match(html, /<details class="zm-native-run__context">/);
  assert.ok(html.includes('完整工作说明 &lt;literal&gt;\n'));
  assert.ok(html.includes(`${'保留全部正文与换行。'.repeat(600)}\n最终要求`));
  assert.ok(!render({ target: { ...target, description: target.title } }).includes('工作说明'));
});

test('SSR: only a long initial automatic task prompt is folded, preserving exact text', () => {
  const text = `执行当前节点：${'完整目标与字面内容 <literal>。'.repeat(120)}\n预期产物：正文\n节点输入说明：参考\n按固定输入清单处理，返回产物草稿与必要说明。\n末尾交付要求`;
  const first = { id: 'first', sequence: 1, role: 'user', text };
  const html = render({ view: view({ messages: [first] }) });
  assert.match(html, /<details class="zm-native-run__instructions zm-native-run__disclosure">/);
  assert.ok(html.includes('初始任务说明'));
  assert.ok(html.includes(text.replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  for (const messages of [
    [{ ...first, text: '短任务说明' }],
    [{ ...first, text: '普通长消息。'.repeat(400) }],
    [{ ...first, role: 'assistant' }],
    [
      { ...first, text: '此前的用户消息' },
      { ...first, id: 'later', sequence: 2 },
    ],
  ])
    assert.ok(!render({ view: view({ messages }) }).includes('初始任务说明'));
});

test('SSR workspace: only supplied workspace names appear and an unavailable saved selection cannot start', () => {
  const workspace = { id: 'unavailable', label: 'Project files', access: 'write', publish: true };
  const html = render({
    view: view({
      workspaces: [workspace],
      selection: { ...selection, workspace: { kind: 'unavailable' } },
    }),
  });
  assert.match(html, /执行范围/);
  assert.match(html, /工作区授权已失效/);
  assert.match(html, /开始执行/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /type="file"/);
  assert.doesNotMatch(html, /filesystem|grantId|deviceId/);
});

test('SSR review: a delivered completed run shows the authoritative waiting reason without a disabled restart action', () => {
  const html = render({
    view: view({
      run: {
        ...run,
        status: 'completed',
        resources: 'settled',
        resultDelivery: {
          kind: 'delivered',
          artifactVersionId: 'artifact',
          artifactVersion: 1,
          roundId: 'round',
          receipt: { idempotencyKey: 'saved', version: 1 },
        },
      },
      actions: {
        start: { kind: 'unavailable', message: '产物已提交，正在等待评审。' },
        stop: unavailable,
        send: { followup: unavailable, steer: unavailable, queue: unavailable },
      },
    }),
  });
  assert.match(html, /正在等待评审/);
  assert.doesNotMatch(html, /role="combobox"/);
  assert.doesNotMatch(html, /开始新一轮/);
  assert.doesNotMatch(html, /当前运行暂不支持此操作/);
});

test('SSR: active or held runs freeze both choices, including terminal runs awaiting resource cleanup', () => {
  for (const status of [
    'requested',
    'running',
    'waiting-for-input',
    'completed',
    'failed',
    'cancelled',
  ]) {
    const html = render({ view: running({ run: { ...run, status } }) });
    assert.ok(html.includes('本轮配置已固定'));
    assert.ok(!html.includes('aria-label="选择模型"'));
    assert.ok(!html.includes('aria-label="选择执行者"'));
    assert.ok(!html.includes('开始新一轮'));
  }
  assert.ok(
    render({ view: running({ run: { ...run, status: 'completed' } }) }).includes('资源仍占用'),
  );
});

test('SSR: held execution keeps directory revocation reachable while model, executor and execution range stay fixed', () => {
  for (const status of ['running', 'waiting-for-input', 'cancelled']) {
    const html = render({
      view: running({ run: { ...run, status, resources: 'held' } }),
      onManageWorkspaces() {
        assert.fail('render must not manage permissions');
      },
    });
    const management = html.match(
      /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?管理目录授权(?:(?!<\/button>)[\s\S])*?<\/button>/u,
    )?.[0];
    assert.ok(management);
    assert.doesNotMatch(management, /\bdisabled(?:=|\s|>)/u);
    assert.match(html, /本轮配置已固定/);
    assert.doesNotMatch(
      html,
      /aria-label="选择模型"|aria-label="选择执行者"|aria-label="执行范围"/u,
    );
  }
});

test('SSR: idle and received do not advertise adoption, task completion or a stopped receipt', () => {
  const html = render({ view: running() });
  assert.ok(html.includes('运行端已收到'));
  for (const invented of ['已采用', '任务已完成', '已确认停止'])
    assert.ok(!html.includes(invented));
  const uncertain = render({
    view: running({ run: { ...run, dispatch: 'unknown', stopPhase: 'receipt-rejected' } }),
  });
  assert.ok(uncertain.includes('接收结果待核实'));
  assert.ok(uncertain.includes('停止回执未确认'));
});

test('SSR: fixed results distinguish pending physical drain, submitted review and task completion', () => {
  const pending = render({
    view: running({
      run: {
        ...run,
        resultDelivery: { kind: 'pending', phase: 'draining' },
      },
    }),
  });
  assert.ok(pending.includes('正在结束运行并固定产物'));
  assert.ok(pending.includes('停止'));
  const delivered = render({
    view: running({
      run: {
        ...run,
        status: 'completed',
        resources: 'settled',
        native: { sessionId: 'native', agentId: 'native', status: 'detached' },
        resultDelivery: {
          kind: 'delivered',
          artifactVersionId: 'artifact',
          artifactVersion: 1,
          roundId: 'round',
          receipt: { idempotencyKey: 'key', version: 4 },
        },
      },
    }),
  });
  assert.ok(delivered.includes('已提交评审'));
  assert.ok(!delivered.includes('会话连接已断开'));
  assert.ok(!delivered.includes('任务已完成'));
});

test('SSR: queue-only capability is explicit and unavailable modes are not offered', () => {
  const html = render({
    view: running({
      actions: {
        start: unavailable,
        stop: available,
        send: {
          followup: unavailable,
          steer: { kind: 'unknown', message: '尚未核实实时补充能力' },
          queue: available,
        },
      },
    }),
  });
  assert.ok(html.includes('排入下一轮'));
  assert.ok(html.includes('不影响当前运行'));
  assert.ok(!html.includes('aria-label="发送方式"'));
  assert.ok(!html.includes('补充当前运行'));
});

test('SSR: a settled non-sendable Run has a compact explicit restart instead of an empty disabled composer', () => {
  const html = render({
    view: view({
      run: { ...run, status: 'cancelled', resources: 'settled', stopPhase: 'confirmed' },
      messages: [{ id: 'result', sequence: 1, role: 'assistant', text: '已保存当前结论。' }],
    }),
  });
  assert.ok(html.includes('已停止'));
  assert.ok(html.includes('开始新一轮'));
  assert.ok(html.includes('已保存当前结论。'));
  assert.ok(!html.includes('<textarea'));
  assert.ok(!html.includes('<footer'));
  assert.ok(html.includes('aria-label="Agent"'));
  assert.ok(!html.includes('当前能力不可用'));
  const rejected = render({
    view: view({
      run: { ...run, status: 'cancelled', resources: 'settled', stopPhase: 'confirmed' },
      actions: {
        start: { kind: 'unavailable', message: '当前账号不能重新开始' },
        stop: unavailable,
        send: { followup: unavailable, steer: unavailable, queue: unavailable },
      },
    }),
  });
  assert.ok(rejected.includes('当前账号不能重新开始'), 'a real restart refusal stays visible');
});

test('SSR: loading, unavailable and mismatched Run projections expose no stale history or actions', () => {
  for (const value of [
    { kind: 'loading' },
    { kind: 'unavailable', message: '当前身份无权读取' },
    running({
      run: { ...run, nodeId: 'other' },
      messages: [{ id: 'stale', sequence: 1, role: 'assistant', text: 'foreign body' }],
    }),
  ]) {
    const html = render({ view: value });
    for (const hidden of ['foreign body', '<textarea', '开始执行', '停止运行'])
      assert.ok(!html.includes(hidden));
  }
});

test('SSR: tool and message bodies stay escaped text; resources cannot be enabled or uploaded', () => {
  const html = render({
    view: running({
      messages: [
        { id: 'user', sequence: 1, role: 'user', text: '<img src=x onerror=alert(1)>' },
        {
          id: 'tool',
          sequence: 2,
          role: 'tool',
          label: '读取输入',
          text: '<script>unsafe()</script>',
        },
      ],
      resources: [
        { id: 'skill', kind: 'skill', name: '实现方法', status: 'fixed' },
        { id: 'mcp', kind: 'mcp', name: '外部资料', status: 'unknown' },
      ],
    }),
  });
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('已固定'));
  assert.ok(html.includes('待核实'));
  assert.ok(!html.includes('type="file"'));
  assert.ok(!html.includes('type="checkbox"'));
});

test('SSR: absent selection or unavailable choices cannot start; errors and parallel labels remain explicit', () => {
  for (const value of [
    view({ selection: null }),
    view({ models: { kind: 'unavailable', message: '模型未配置' } }),
    view({ experts: { kind: 'loading', message: '正在读取执行者' } }),
  ]) {
    const html = render({ view: value });
    assert.match(html, /<button[^>]*class="[^"]*primary[^"]*"[^>]*disabled=""/);
  }
  const error = render({ error: '需要重新登录' });
  assert.ok(error.includes('role="alert"'));
  const html = renderToStaticMarkup(
    createElement(
      'div',
      {},
      createElement(NativeRunPanel, props()),
      createElement(NativeRunPanel, props()),
    ),
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

if (domModule) {
  const { createRoot } = await import('react-dom/client');
  const pending = () => Promise.withResolvers();
  async function mount(initial) {
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    let current = props(initial);
    const update = async (partial) => {
      current = { ...current, ...partial };
      await act(async () => root.render(createElement(NativeRunPanel, current)));
    };
    await update({});
    const button = (label) =>
      [...node.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === label ||
          item.querySelector('.zm-button-label')?.textContent === label,
      );
    return {
      node,
      button,
      update,
      async close() {
        await act(async () => root.unmount());
        node.remove();
      },
    };
  }
  async function type(h, text) {
    const input = h.node.querySelector('textarea');
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
        input,
        text,
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(input.value, text);
  }
  async function submit(h) {
    await act(async () =>
      h.node
        .querySelector('form')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
  }

  async function choose(h, label) {
    const config = h.node.querySelector('.zm-native-run__config');
    if (config && !config.open)
      await act(async () => {
        config.open = true;
      });
    const trigger = h.button(label);
    await act(async () => trigger.click());
    // A closing menu may still be mounted for its exit transition. Select only
    // the new trigger's own popup, rather than a previous field's option.
    const popup = document.getElementById(trigger.getAttribute('aria-controls'));
    const option = popup?.querySelector('[role="option"]');
    assert.ok(option, `missing option for ${label}`);
    await act(async () => option.click());
  }

  test('DOM: users explicitly fill a partial selection, and only the echoed complete selection enables start', async () => {
    const choices = [];
    const h = await mount({
      view: view({ selection: null }),
      onSelectionChange: (value) => choices.push(value),
    });
    try {
      assert.equal(h.button('开始执行').disabled, true);
      await choose(h, '选择模型');
      assert.equal(choices.length, 0, 'one field is not a complete selection');
      await choose(h, '选择执行者');
      assert.deepEqual(choices, [selection]);
      assert.equal(h.button('开始执行').disabled, true, 'the local form never grants start');
      await h.update({ view: view({ selection: choices[0] }) });
      assert.equal(h.button('开始执行').disabled, false);
      const next = { ...target, nodeId: 'new-node' };
      await h.update({ target: next, view: view({ selection: null }) });
      await choose(h, '选择执行者');
      assert.equal(choices.length, 1, 'the old target model must not fill the new target');
    } finally {
      await h.close();
    }
  });

  test('DOM: held runs open permission management while stop is pending without exposing execution choices', async () => {
    const stop = pending();
    let managed = 0;
    const h = await mount({
      view: running(),
      onStop: () => stop.promise,
      onManageWorkspaces: () => managed++,
      onSelectionChange: () => assert.fail('held configuration remains frozen'),
    });
    try {
      await act(async () => h.button('停止运行').click());
      assert.equal(h.button('管理目录授权').disabled, false);
      await act(async () => h.button('管理目录授权').click());
      assert.equal(managed, 1);
      assert.equal(h.node.querySelectorAll('[role="combobox"]').length, 0);
    } finally {
      stop.resolve();
      await act(async () => {});
      await h.close();
    }
  });

  test('DOM: a replacement Run within the same node fences the old send result', async () => {
    const release = pending();
    const h = await mount({ view: running(), onSend: async () => release.promise });
    try {
      await type(h, '旧运行内容');
      await submit(h);
      await h.update({
        view: running({
          run: { ...run, runId: 'new-run', generation: 2, segmentId: 'new-segment' },
        }),
      });
      await type(h, '新运行内容');
      await act(async () => release.resolve());
      assert.equal(h.node.querySelector('textarea').value, '新运行内容');
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: explicit start coalesces double clicks and refresh/target changes never execute', async () => {
    const release = pending();
    let starts = 0,
      refreshes = 0;
    const h = await mount({
      onStart: async () => {
        starts++;
        await release.promise;
      },
      onRefresh: async () => {
        refreshes++;
      },
    });
    try {
      assert.equal(starts, 0);
      await act(async () => h.button('刷新工作会话').click());
      assert.equal(refreshes, 1);
      assert.equal(starts, 0);
      await act(async () => {
        h.button('开始执行').click();
        h.button('开始执行').click();
      });
      assert.equal(starts, 1);
      await h.update({ target: { ...target, nodeId: 'new-node' } });
      await act(async () => release.resolve());
      assert.equal(starts, 1);
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: failed sends retain draft and hide raw errors; edits during successful sends are not cleared', async () => {
    const h = await mount({
      view: running(),
      onSend: async () => {
        throw Error('raw-private-provider-error');
      },
    });
    const release = pending();
    let sent;
    try {
      await type(h, '第一次补充');
      await submit(h);
      assert.equal(h.node.querySelector('textarea').value, '第一次补充');
      assert.ok(h.node.textContent.includes('内容已保留'));
      assert.ok(!h.node.textContent.includes('raw-private-provider-error'));
      await h.update({
        onSend: async (text, mode) => {
          sent = { text, mode };
          await release.promise;
        },
      });
      await submit(h);
      await type(h, '等待时新写的内容');
      await act(async () => release.resolve());
      assert.deepEqual(sent, { text: '第一次补充', mode: 'followup' });
      assert.equal(h.node.querySelector('textarea').value, '等待时新写的内容');
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: an old target receipt cannot clear the new target draft', async () => {
    const release = pending();
    const h = await mount({ view: running(), onSend: async () => release.promise });
    try {
      await type(h, '旧节点内容');
      await submit(h);
      const next = { ...target, spaceId: 'new-space', nodeId: 'new-node' };
      await h.update({
        target: next,
        view: running({ run: { ...run, ...next, runId: 'new-run' } }),
      });
      await type(h, '新节点内容');
      await act(async () => release.resolve());
      assert.equal(h.node.querySelector('textarea').value, '新节点内容');
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: queue-only sends use queue and pending sends never block the independent stop action', async () => {
    const release = pending();
    let sent,
      stopped = 0;
    const h = await mount({
      view: running({
        actions: {
          start: unavailable,
          stop: available,
          send: { followup: unavailable, steer: unavailable, queue: available },
        },
      }),
      onSend: async (text, mode) => {
        sent = { text, mode };
        await release.promise;
      },
      onStop: async () => {
        stopped++;
      },
    });
    try {
      await type(h, '下一轮再处理');
      await submit(h);
      assert.deepEqual(sent, { text: '下一轮再处理', mode: 'queue' });
      assert.equal(h.button('停止运行').disabled, false);
      await act(async () => h.button('停止运行').click());
      assert.equal(stopped, 1);
      await act(async () => release.resolve());
      assert.equal(h.node.querySelector('textarea').value, '');
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: requesting stop blocks new start/send handlers while preserving an editable draft', async () => {
    const release = pending();
    let starts = 0,
      sends = 0,
      stops = 0;
    const current = running({
      run: { ...run, status: 'completed', resources: 'settled' },
      actions: {
        start: available,
        stop: available,
        send: { followup: available, steer: unavailable, queue: unavailable },
      },
    });
    const h = await mount({
      view: current,
      onStart: async () => {
        starts++;
      },
      onSend: async () => {
        sends++;
      },
      onStop: async () => {
        stops++;
        await release.promise;
      },
    });
    try {
      await type(h, '停止前的内容');
      // Invoke both paths in the same React batch; then submit the form
      // directly again, bypassing the disabled submit button entirely.
      await act(async () => {
        h.button('停止运行').click();
        h.button('开始新一轮').click();
        h.node
          .querySelector('form')
          .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      await submit(h);
      assert.equal(stops, 1);
      assert.equal(starts, 0);
      assert.equal(sends, 0);
      assert.equal(h.button('发送').disabled, true);
      assert.equal(h.button('开始新一轮').disabled, true);
      await type(h, '等待停止时补写的草稿');
      await h.update({ view: { ...current, run: { ...current.run, stopPhase: 'requested' } } });
      await act(async () => release.resolve());
      await submit(h);
      assert.equal(sends, 0, 'an accepted stop request still fences sending');
      assert.equal(h.node.querySelector('textarea').value, '等待停止时补写的草稿');
      await h.update({ view: { ...current, run: { ...current.run, stopPhase: 'confirmed' } } });
      await submit(h);
      assert.equal(
        sends,
        1,
        'only a current available action after stop confirmation re-enables sending',
      );
    } finally {
      release.resolve();
      await h.close();
    }
  });

  test('DOM: loss of mode capability retains editable text and prevents even explicit form submission', async () => {
    let sends = 0;
    const h = await mount({
      view: running(),
      onSend: async () => {
        sends++;
      },
    });
    try {
      await type(h, '先保留要求');
      await h.update({
        view: running({
          actions: {
            start: unavailable,
            stop: unavailable,
            send: {
              followup: { kind: 'unknown', message: '发送能力待核实' },
              steer: unavailable,
              queue: unavailable,
            },
          },
        }),
      });
      await submit(h);
      assert.equal(sends, 0);
      assert.equal(h.node.querySelector('textarea').value, '先保留要求');
      assert.equal(h.button('发送').disabled, true);
    } finally {
      await h.close();
    }
  });
}

test('SSR per-Run publication: ranges stay explicit, and incomplete relative paths disable start before a Host call', () => {
  const workspace = {
    id: 'files',
    label: 'Project files',
    access: 'write',
    publish: false,
    publication: 'per-run',
  };
  const html = render({
    view: view({
      workspaces: [workspace],
      selection: {
        ...selection,
        workspace: {
          kind: 'local',
          id: workspace.id,
          publish: [{ kind: 'file', path: '../private' }],
        },
      },
    }),
  });
  assert.match(html, /文件交付范围/);
  assert.match(html, /请填写工作区内的相对路径/);
  const start = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
    .map((match) => match[0])
    .find((button) => button.includes('>开始执行</span>'));
  assert(start);
  assert.match(start, /disabled=""/);
  const untouched = render({
    view: view({
      workspaces: [workspace],
      selection: { ...selection, workspace: { kind: 'local', id: workspace.id } },
    }),
  });
  assert.match(untouched, /未授权/);
  assert.match(untouched, /添加相对路径后/);
});
