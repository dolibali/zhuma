/** Selection/preview contracts only; the optional in-memory DOM is not native Run or GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const domModule = process.env.ZHUMA_NATIVE_PANEL_DOM_MODULE;
if (domModule) {
  const { Window } = await import(pathToFileURL(resolve(domModule)).href);
  const window = new Window({ url: 'http://localhost/' });
  window.innerWidth = 1440;
  for (const name of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Document',
    'Node',
    'NodeFilter',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLDialogElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'ResizeObserver',
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
const { createElement: el, useState, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const {
  emptyWorkbench,
  applyWorkbenchCommand,
  WorkbenchError,
  canonicalPayload,
  validateLocalPlanningChange,
  LOCAL_PLANNING_FIELDS,
} = await import('@zhuma/agent-core');
const { expertResources, selectExpertResources, prepareExpertProposal } =
  await import('../dist/workbench/expert-resources.js');
const { NodeInspector } = await import('../dist/workbench/NodeInspector.js');
const { TaskEditor } = await import('../dist/workbench/TaskEditor.js');
const dom = { skip: !domModule && 'set ZHUMA_NATIVE_PANEL_DOM_MODULE for in-memory DOM contracts' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function fixture() {
  const state = emptyWorkbench();
  state.projects.push({ id: 'project', name: '订单中心', description: '' });
  const person = (id, name, kind, resourceBindings) => ({
    id,
    name,
    kind,
    role: '',
    capabilities: [],
    instructions: '',
    available: true,
    ...(resourceBindings ? { resourceBindings } : {}),
  });
  state.participants.push(
    person('chen', '陈宁', 'human'),
    person('zhuma-work-planning', '工作规划专家', 'expert', {
      skillIds: ['work-planning'],
      mcpIds: [],
    }),
    person('implementation', '实现专家', 'expert', {
      skillIds: ['implementation-skill'],
      mcpIds: ['api-tool'],
    }),
    person('reviewer', '评审专家', 'expert', { skillIds: ['review-skill'], mcpIds: [] }),
  );
  state.assets.push(
    ...['work-planning', 'implementation-skill', 'review-skill', 'extra-skill'].map((id) => ({
      id,
      name: `${id} Skill`,
      kind: 'skill',
      available: true,
      description: '',
      content: '',
    })),
    ...['api-tool', 'extra-tool'].map((id) => ({
      id,
      name: `${id} MCP`,
      kind: 'mcp',
      available: true,
      description: '',
      content: '',
    })),
  );
  const node = {
    id: 'node',
    title: '制定计划',
    description: '整理业务边界',
    output: '交付工作计划',
    input: '',
    assigneeId: 'chen',
    reviewRequired: false,
    reviewerIds: [],
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    rationale: '',
    position: { x: 60, y: 60 },
  };
  const task = {
    id: 'task',
    projectId: 'project',
    title: '订单改进',
    goal: '改善订单处理',
    ownerId: 'chen',
    participantIds: state.participants.map((p) => p.id),
    status: 'draft',
    workflows: [{ id: 'root', name: '主工作流', parentNodeId: null, nodes: [node] }],
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
  state.tasks.push(task);
  return { state, task, node };
}
function proposal(task, workflows) {
  return {
    id: 'proposal',
    taskId: task.id,
    baseRevision: 0,
    model: 'scripted-contract',
    result: { summary: '按当前分工生成计划', questions: [], assumptions: [], workflows },
  };
}
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
function localFixture() {
  const f = fixture();
  f.node.assigneeId = 'zhuma-work-planning'; // An intentional, draft-only removal of its required Skill.
  const target = {
    ...structuredClone(f.node),
    id: 'node-b',
    title: '实现接口',
    assigneeId: 'chen',
  };
  f.task.workflows[0].nodes = [target, f.node];
  return { ...f, target };
}
test('local expert closure changes only the target and only explicitly allowed resource fields; another node keeps its removed Skill', () => {
  const f = localFixture();
  const before = structuredClone(f.task.workflows);
  const after = structuredClone(before);
  after[0].nodes[0].assigneeId = 'implementation';
  for (const fields of [
    ['assigneeId', 'rationale'],
    ['assigneeId', 'skillIds'],
    [...LOCAL_PLANNING_FIELDS],
  ]) {
    const adjustment = { nodeId: 'node-b', fields };
    validateLocalPlanningChange(before, after, adjustment);
    const prepared = prepareExpertProposal(
      proposal(f.task, after),
      f.task,
      f.state.participants,
      f.state.assets,
      adjustment,
    );
    assert.equal(hash(prepared.result.workflows[0].nodes[1]), hash(before[0].nodes[1]));
    assert.doesNotThrow(() =>
      validateLocalPlanningChange(before, prepared.result.workflows, adjustment),
    );
    assert.deepEqual(
      prepared.result.workflows[0].nodes[0].skillIds,
      fields.includes('skillIds') ? ['implementation-skill'] : [],
    );
    assert.deepEqual(
      prepared.result.workflows[0].nodes[0].mcpIds,
      fields.includes('mcpIds') ? ['api-tool'] : [],
    );
  }
});
test('expert selection preserves extra choices across expert switches and humans; reviewers do not add execution resources', () => {
  const { state, node } = fixture();
  node.skillIds = ['extra-skill'];
  node.mcpIds = ['extra-tool'];
  node.assigneeId = 'zhuma-work-planning';
  const before = structuredClone(node);
  const first = selectExpertResources(node, state.participants, state.assets);
  assert.deepEqual(first, { skillIds: ['extra-skill', 'work-planning'], mcpIds: ['extra-tool'] });
  assert.deepEqual(node, before, 'selection must not mutate the draft');
  const next = { ...node, ...first, assigneeId: 'implementation' };
  const second = selectExpertResources(next, state.participants, state.assets);
  assert.deepEqual(second, {
    skillIds: ['extra-skill', 'work-planning', 'implementation-skill'],
    mcpIds: ['extra-tool', 'api-tool'],
  });
  assert.deepEqual(
    selectExpertResources(
      { ...next, ...second, assigneeId: 'chen', reviewerIds: ['reviewer'] },
      state.participants,
      state.assets,
    ),
    second,
  );
  assert.deepEqual(
    selectExpertResources(
      { ...next, ...second, assigneeId: null },
      state.participants,
      state.assets,
    ),
    second,
  );
});
test('missing, wrong-kind, unavailable, or out-of-task resources are not fabricated, and full selections are not evicted', () => {
  const { state, task, node } = fixture();
  node.assigneeId = 'implementation';
  state.assets = [
    { ...state.assets.find((a) => a.id === 'implementation-skill'), available: false },
    { ...state.assets.find((a) => a.id === 'api-tool'), kind: 'skill' },
  ];
  assert.deepEqual(selectExpertResources(node, state.participants, state.assets), {
    skillIds: [],
    mcpIds: [],
  });
  assert.deepEqual(
    expertResources(node, state.participants, state.assets).map((r) => [
      r.kind,
      r.available,
      r.name,
    ]),
    [
      ['skill', false, 'implementation-skill Skill'],
      ['mcp', false, '不可用 MCP'],
    ],
  );
  const input = proposal(task, task.workflows);
  const excluded = { ...task, participantIds: ['chen'] };
  const prepared = prepareExpertProposal(
    input,
    excluded,
    state.participants,
    fixture().state.assets,
  );
  assert.deepEqual(prepared.result.workflows[0].nodes[0].skillIds, []);
  const full = { ...node, skillIds: Array.from({ length: 100 }, (_, i) => `explicit-${i}`) };
  const fixed = selectExpertResources(full, state.participants, fixture().state.assets);
  assert.deepEqual(fixed.skillIds, full.skillIds);
  assert.deepEqual(fixed.mcpIds, ['api-tool']);
});
test('a newly received proposal is closed once across nested flows without changing its identity or old ready snapshots', () => {
  const { state, task, node } = fixture();
  node.assigneeId = 'zhuma-work-planning';
  const flows = [
    task.workflows[0],
    {
      id: 'child',
      name: '子工作流',
      parentNodeId: node.id,
      nodes: [{ ...node, id: 'child-node', assigneeId: 'implementation' }],
    },
  ];
  const input = proposal(task, flows);
  const before = structuredClone(input);
  const prepared = prepareExpertProposal(input, task, state.participants, state.assets);
  assert.deepEqual(
    [prepared.id, prepared.baseRevision, prepared.model],
    [input.id, input.baseRevision, input.model],
  );
  assert.deepEqual(input, before);
  assert.deepEqual(prepared.result.workflows[0].nodes[0].skillIds, ['work-planning']);
  assert.deepEqual(prepared.result.workflows[1].nodes[0].mcpIds, ['api-tool']);
  assert.equal(
    prepareExpertProposal(input, { ...task, status: 'ready' }, state.participants, state.assets),
    input,
  );
});

async function mount(t, element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}
async function click(element) {
  assert.ok(element);
  await act(async () => {
    element.click();
    await tick();
  });
}
function button(container, name) {
  const found = [...container.querySelectorAll('button')].find(
    (item) =>
      (item.querySelector('.zm-button-label')?.textContent ?? item.textContent).trim() === name,
  );
  assert.ok(found, `missing action ${name}`);
  return found;
}
async function executor(container, name, label = '执行者') {
  await click(container.querySelector(`[aria-label="选择${label}"]`));
  const dialog = document.querySelector('dialog');
  const row = [...dialog.querySelectorAll('label.zm-member')].find(
    (row) => row.querySelector('strong').textContent === name,
  );
  assert.ok(row, `missing visible executor ${name}`);
  await click(row.querySelector('input'));
  await click(button(dialog, '确认选择'));
}
async function choose(container, label, option) {
  await click(container.querySelector(`[aria-label="${label}"]`));
  const popup = document.querySelector('.zm-select-popup[data-open]');
  assert.ok(popup, 'the actual scope trigger must open the menu');
  await click(
    [...popup.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent.trim() === option,
    ),
  );
}
const appearance = { getSnapshot: () => 'light', subscribe: () => () => {}, set() {} };
function editorProps(f, extra = {}) {
  const calls = [];
  let current = f.state;
  const api = {
    member: {
      actorId: 'chen',
      capabilities: () => ({ tasks: [{ taskId: 'task', edit: true, confirm: true, plan: true }] }),
    },
    save: async (revision, command, requestId, intent) => {
      calls.push({ revision, command: structuredClone(command), requestId, intent });
      if (
        command.task.status === 'ready' &&
        !command.task.workflows[0].nodes[0].skillIds.includes('work-planning')
      )
        throw new WorkbenchError(
          'resource-unavailable',
          '工作节点「制定计划」缺少专家「工作规划专家」必需的 Skill：work-planning。',
        );
      current = applyWorkbenchCommand(current, command);
      return current;
    },
    plan: async () => assert.fail('No planning call was authorized'),
  };
  return {
    calls,
    props: {
      original: f.task,
      state: f.state,
      api,
      model: 'scripted-contract',
      saved() {},
      close() {},
      appearance,
      ...extra,
    },
  };
}
test(
  'React executor choice selects visible required resources; removal survives edits until explicit refill; role and human choices stay separate',
  dom,
  async (t) => {
    const f = fixture();
    let current;
    function Form({ roleMode = false }) {
      const [node, setNode] = useState(f.node);
      current = node;
      return el(NodeInspector, {
        node,
        workflow: f.task.workflows[0],
        members: f.state.participants,
        state: f.state,
        roleMode,
        readOnly: false,
        disabled: false,
        hasChild: false,
        update: (patch) => setNode((old) => ({ ...old, ...patch })),
        manageMembers() {},
        split() {},
        remove() {},
      });
    }
    const container = await mount(t, el(Form));
    await executor(container, '工作规划专家');
    assert.deepEqual(current.skillIds, ['work-planning']);
    const group = [...container.querySelectorAll('details.zm-config-group')].find((g) =>
      g.querySelector('summary').textContent.includes('能力与依赖'),
    );
    assert.equal(group.open, true);
    assert.match(group.textContent, /工作规划专家 · 必需能力/);
    const skill = [...group.querySelectorAll('label')]
      .find((row) => row.textContent.trim() === 'work-planning Skill')
      .querySelector('input');
    assert.equal(skill.checked, true);
    await click(skill);
    assert.deepEqual(current.skillIds, []);
    await click(container.querySelector('.zm-review input[type="checkbox"]'));
    assert.deepEqual(current.skillIds, []);
    await click(button(container, '补齐必需能力'));
    assert.deepEqual(current.skillIds, ['work-planning']);
    await executor(container, '实现专家');
    assert.deepEqual(current.skillIds, ['work-planning', 'implementation-skill']);
    assert.deepEqual(current.mcpIds, ['api-tool']);
    await executor(container, '陈宁');
    assert.deepEqual(current.mcpIds, ['api-tool']);
    assert.doesNotMatch(container.textContent, /必需能力/);
    const roles = await mount(t, el(Form, { roleMode: true }));
    await executor(roles, '工作规划专家', '执行角色');
    assert.deepEqual(current.skillIds, []);
    assert.doesNotMatch(roles.textContent, /必需能力/);
  },
);
test(
  'React draft keeps an intentional resource removal and displays the original confirmation error without silent re-add or retry',
  dom,
  async (t) => {
    const f = fixture();
    f.node.assigneeId = 'zhuma-work-planning';
    f.node.skillIds = ['work-planning'];
    const { calls, props } = editorProps(f);
    const container = await mount(t, el(TaskEditor, props));
    const skill = [...container.querySelectorAll('details.zm-multiselect label')]
      .find((row) => row.textContent.trim() === 'work-planning Skill')
      .querySelector('input');
    await click(skill);
    await click(button(container, '保存草稿'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].intent, 'update-task');
    assert.deepEqual(calls[0].command.task.workflows[0].nodes[0].skillIds, []);
    await click(button(container, '确认工作流'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].intent, 'confirm-task');
    assert.deepEqual(calls[1].command.task.workflows[0].nodes[0].skillIds, []);
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /缺少专家「工作规划专家」必需的 Skill/,
    );
    assert.equal(button(container, '确认工作流').disabled, false);
    assert.match(container.textContent, /必需能力未齐/);
    assert.equal(calls.length, 2, 'the failed confirmation does not retry or supplement resources');
  },
);
test(
  'React initial and explicit planning previews show added Skills/MCP before applying the same draft through the original save',
  dom,
  async (t) => {
    for (const initial of [true, false]) {
      const f = fixture();
      const originalFlows = structuredClone(f.task.workflows);
      const flows = structuredClone(originalFlows);
      flows[0].nodes[0].assigneeId = 'implementation';
      if (initial) f.task.workflows[0].nodes = [];
      const input = proposal(f.task, flows);
      const before = structuredClone(input);
      const { calls, props } = editorProps(
        f,
        initial
          ? {
              initialPlanning: {
                controller: new AbortController(),
                result: Promise.resolve({ ok: true, proposal: input }),
              },
            }
          : {},
      );
      let plans = 0;
      props.api.plan = async () => {
        plans++;
        return input;
      };
      const container = await mount(t, el(TaskEditor, props));
      if (!initial) {
        await click(button(container, '✧ AI 规划'));
        await click(button(container, '生成工作流草案'));
      }
      assert.equal(plans, initial ? 0 : 1);
      const changes = container.querySelector('[aria-label="变更预览"]');
      assert.match(changes.textContent, /Skills/);
      assert.match(changes.textContent, /implementation-skill Skill/);
      assert.match(changes.textContent, /MCP/);
      assert.match(changes.textContent, /api-tool MCP/);
      assert.equal(calls.length, 0, 'preview must not save or confirm');
      assert.deepEqual(input, before);
      await click(button(container, '应用草案'));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command.task.status, 'draft');
      assert.deepEqual(calls[0].command.task.workflows[0].nodes[0].skillIds, [
        'implementation-skill',
      ]);
      assert.deepEqual(calls[0].command.task.workflows[0].nodes[0].mcpIds, ['api-tool']);
    }
  },
);
test(
  'React missing-catalog preview stays a draft warning without invented choices; ready plans never rebind from the current catalog',
  dom,
  async (t) => {
    const f = fixture();
    f.node.assigneeId = 'implementation';
    f.state.assets = [];
    const { props, calls } = editorProps(f, {
      initialPlanning: {
        controller: new AbortController(),
        result: Promise.resolve({ ok: true, proposal: proposal(f.task, f.task.workflows) }),
      },
    });
    const container = await mount(t, el(TaskEditor, props));
    assert.match(container.textContent, /必需能力尚未齐备/);
    assert.match(container.textContent, /不可用 Skill/);
    assert.equal(calls.length, 0);
    assert.deepEqual(f.node.skillIds, []);
    const old = fixture();
    old.node.assigneeId = 'zhuma-work-planning';
    const ready = applyWorkbenchCommand(old.state, {
      type: 'save-task',
      task: { ...old.task, status: 'ready' },
    });
    const legacy = ready.tasks[0];
    const before = structuredClone(ready);
    const readonly = editorProps({ ...old, state: ready, task: legacy });
    const fixed = await mount(t, el(TaskEditor, readonly.props));
    assert.equal(readonly.calls.length, 0);
    assert.deepEqual(ready, before);
    assert.doesNotMatch(fixed.textContent, /补齐必需能力/);
    const markup = renderToStaticMarkup(
      el(NodeInspector, {
        node: legacy.workflows[0].nodes[0],
        workflow: legacy.workflows[0],
        members: ready.participants,
        state: ready,
        readOnly: true,
        disabled: false,
        hasChild: false,
        update: () => assert.fail(),
        manageMembers() {},
        split() {},
        remove() {},
      }),
    );
    assert.ok(!markup.includes('work-planning Skill'));
  },
);
test(
  'React local assignment/config previews and original apply preserve the non-target hash and respect allowed capability fields',
  dom,
  async (t) => {
    for (const resourcesAllowed of [false, true]) {
      const f = localFixture();
      const before = structuredClone(f.task.workflows);
      const after = structuredClone(before);
      after[0].nodes[0].assigneeId = 'implementation';
      const { calls, props } = editorProps(f);
      let adjustment;
      props.api.plan = async (_task, _revision, _instruction, _signal, _baseId, scope) => {
        adjustment = scope;
        validateLocalPlanningChange(before, after, scope);
        return proposal(f.task, after);
      };
      const container = await mount(t, el(TaskEditor, props));
      await click(button(container, '✧ AI 规划'));
      await choose(container, '调整范围', resourcesAllowed ? '仅当前节点配置' : '仅当前节点执行者');
      await click(button(container, resourcesAllowed ? '调整节点配置' : '调整执行者'));
      assert.deepEqual(adjustment, {
        nodeId: 'node-b',
        fields: resourcesAllowed ? [...LOCAL_PLANNING_FIELDS] : ['assigneeId', 'rationale'],
      });
      const preview = container.querySelector('[aria-label="变更预览"]');
      assert.match(preview.textContent, /实现专家/);
      assert.doesNotMatch(preview.textContent, /制定计划/);
      const fields = [...preview.querySelectorAll('.zm-change-field > strong')].map(
        (item) => item.textContent,
      );
      assert.equal(fields.includes('Skills'), resourcesAllowed);
      assert.equal(fields.includes('MCP'), resourcesAllowed);
      assert.match(container.textContent, /必需能力尚未齐备/);
      assert.equal(calls.length, 0);
      await click(button(container, '应用草案'));
      assert.equal(calls.length, 1);
      const saved = calls[0].command.task.workflows;
      assert.equal(hash(saved[0].nodes[1]), hash(before[0].nodes[1]));
      assert.deepEqual(saved[0].nodes[1].skillIds, []);
      assert.deepEqual(
        saved[0].nodes[0].skillIds,
        resourcesAllowed ? ['implementation-skill'] : [],
      );
      assert.deepEqual(saved[0].nodes[0].mcpIds, resourcesAllowed ? ['api-tool'] : []);
      assert.doesNotThrow(() => validateLocalPlanningChange(before, saved, adjustment));
    }
  },
);
test(
  'React local replacement cannot discard protected resources from an unapplied visible preview; it retains that preview and the original scope error',
  dom,
  async (t) => {
    const f = fixture();
    const first = structuredClone(f.task.workflows);
    first[0].nodes[0].assigneeId = 'implementation';
    const input = proposal(f.task, first);
    const { calls, props } = editorProps(f, {
      initialPlanning: {
        controller: new AbortController(),
        result: Promise.resolve({ ok: true, proposal: input }),
      },
    });
    props.api.plan = async (_task, _revision, _instruction, _signal, baseId, adjustment) => {
      assert.equal(baseId, input.id);
      const second = structuredClone(first);
      second[0].nodes[0].assigneeId = 'chen';
      validateLocalPlanningChange(first, second, adjustment);
      return { ...proposal(f.task, second), id: 'replacement' };
    };
    const container = await mount(t, el(TaskEditor, props));
    await choose(container, '调整范围', '仅当前节点执行者');
    await click(button(container, '调整执行者'));
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /本次只允许修改指定节点的指定字段/,
    );
    const preview = container.querySelector('[aria-label="变更预览"]');
    assert.match(preview.textContent, /实现专家/);
    assert.match(preview.textContent, /implementation-skill Skill/);
    assert.match(preview.textContent, /api-tool MCP/);
    assert.equal(calls.length, 0);
  },
);
