import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateWorkTask,
  WorkbenchError,
  captureWorkflowTemplate,
  resolveTemplateBindings,
  templateBindingGaps,
  type Workbench,
  type WorkTask,
  type Workflow,
  type WorkNode,
  type PlanProposal,
  type WorkflowTemplate,
} from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import { Field, MemberPicker, Modal, ParticipantSelect } from './controls.js';
import { WorkflowCanvas } from './WorkflowCanvas.js';
import { NodeInspector } from './NodeInspector.js';
import { TreeNavigator } from './TreeNavigator.js';
import { indexWorkTree, resolveWorkLocation, workflowPath } from './navigation.js';
import { Button } from './Button.js';
import { Appearance, type AppearanceStore } from './Appearance.js';
import { TemplateSaveDialog } from './TemplateSaveDialog.js';
import { TemplateBindings, type TemplateBindingValues } from './TemplateBindings.js';

// Started only by the create-form submit handler. The parent owns cancellation on task exit.
export type InitialPlanning = {
  controller: AbortController;
  result: Promise<{ ok: true; proposal: PlanProposal } | { ok: false; error: unknown }>;
};

export function newNode(): WorkNode {
  return {
    id: crypto.randomUUID(),
    title: '新工作节点',
    description: '',
    assigneeId: null,
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '',
    rationale: '',
    position: { x: 60, y: 60 },
  };
}

export function TaskEditor({
  original,
  state,
  api,
  model,
  saved,
  close,
  appearance,
  initialPlanning,
}: {
  original: WorkTask;
  state: Workbench;
  api: WorkbenchApi;
  model: string;
  saved(state: Workbench): void;
  close(): void;
  appearance: AppearanceStore;
  initialPlanning?: InitialPlanning;
}) {
  const [task, setTask] = useState(() => structuredClone(original));
  const [baseline, setBaseline] = useState(() => JSON.stringify(original));
  const [revision, setRevision] = useState(state.revision);
  const [workflowId, setWorkflowId] = useState(original.workflows.find((w) => !w.parentNodeId)!.id);
  const [selectedId, setSelectedId] = useState<string | null>(
    original.workflows.find((w) => !w.parentNodeId)?.nodes[0]?.id ?? null,
  );
  const selectionMemory = useRef(new Map<string, string | null>());
  const previousPath = useRef<string[]>([]);
  const [navigationNotice, setNavigationNotice] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(original.workflows.map((w) => w.id)));
  const [locateRequest, setLocateRequest] = useState(0);
  const [view, setView] = useState<'list' | 'workflow'>('workflow');
  const [inspectorOpen, setInspectorOpen] = useState(
    () => !!initialPlanning || window.innerWidth > 1100,
  );
  const editorRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setCompact((entry?.contentRect.width ?? 0) <= 980),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!compact || !inspectorOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inspectorRef.current?.querySelector<HTMLElement>('button, input, textarea, select')?.focus();
    return () => {
      if (
        previous?.isConnected &&
        (inspectorRef.current?.contains(document.activeElement) ||
          document.activeElement === document.body)
      )
        previous.focus();
    };
  }, [compact, inspectorOpen]);
  const [tree, setTree] = useState(false);
  const [panel, setPanel] = useState<'config' | 'plan'>(initialPlanning ? 'plan' : 'config');
  const [membersOpen, setMembersOpen] = useState(false);
  const [memberDraft, setMemberDraft] = useState(task.participantIds);
  const [error, setError] = useState('');
  const [memberError, setMemberError] = useState('');
  const [templateSave, setTemplateSave] = useState<WorkflowTemplate | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [mappingRoles, setMappingRoles] = useState<TemplateBindingValues>({});
  const [mappingResources, setMappingResources] = useState<TemplateBindingValues>({});
  const [mappingError, setMappingError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(!!initialPlanning);
  const [planFailed, setPlanFailed] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const controller = useRef<AbortController | null>(initialPlanning?.controller ?? null);
  const pendingSave = useRef<{
    content: string;
    requestId: string;
    revision: number;
    task: WorkTask;
  } | null>(null);
  const dirty = JSON.stringify(task) !== baseline;
  const previewTask = useMemo(
    () =>
      proposal?.result.workflows.length ? { ...task, workflows: proposal.result.workflows } : null,
    [proposal, task],
  );
  const displayTask = previewTask ?? task;
  const workTree = useMemo(() => indexWorkTree(displayTask), [displayTask]);
  const locked = busy || planning || task.status === 'ready' || !!previewTask;
  const workflow = workTree.workflows.get(workflowId) ?? workTree.root;
  const node = workflow.nodes.find((n) => n.id === selectedId);
  const ancestors = workflowPath(workTree, workflow.id);
  useEffect(() => {
    const location = resolveWorkLocation(
      workTree,
      { workflowId, nodeId: selectedId },
      selectionMemory.current,
      previousPath.current,
    );
    if (location.workflowId !== workflowId || location.nodeId !== selectedId) {
      setWorkflowId(location.workflowId);
      setSelectedId(location.nodeId);
      setLocateRequest((request) => request + 1);
      if (selectedId || workflowId !== location.workflowId)
        setNavigationNotice('原定位在当前版本中不可用，已返回可见工作流。');
    }
    const path = workflowPath(workTree, location.workflowId).map((w) => w.id);
    for (let i = 1; i < path.length; i++) {
      const parentId = path[i - 1]!;
      if (!selectionMemory.current.has(parentId))
        selectionMemory.current.set(
          parentId,
          workTree.workflows.get(path[i]!)?.parentNodeId ?? null,
        );
    }
    previousPath.current = path;
    selectionMemory.current.set(location.workflowId, location.nodeId);
    setExpanded((current) =>
      path.every((id) => current.has(id)) ? current : new Set([...current, ...path]),
    );
  }, [workTree, workflowId, selectedId]);
  const gaps = templateBindingGaps(task);
  const hasGaps = !!(gaps.participants.length + gaps.assets.length);
  const actualMembers = state.participants.filter((m) => task.participantIds.includes(m.id));
  const members = [
    ...actualMembers,
    ...gaps.participants.map((p) => ({
      ...p,
      name: `待绑定 · ${p.name}`,
      role: '模板角色',
      placeholder: true,
      capabilities: [],
      instructions: '',
      available: false,
    })),
  ];
  const inspectorState: Workbench = {
    ...state,
    assets: [
      ...state.assets,
      ...gaps.assets.map((a) => ({
        ...a,
        name: `待绑定 · ${a.name}`,
        description: '',
        content: '',
        available: false,
      })),
    ],
  };
  useEffect(
    () => () => {
      // The creation request survives StrictMode's child effect replay. Its parent closes it.
      if (controller.current !== initialPlanning?.controller) controller.current?.abort();
    },
    [initialPlanning],
  );
  useEffect(() => {
    if (!initialPlanning) return;
    let subscribed = true;
    void initialPlanning.result.then((result) => {
      if (!subscribed || controller.current !== initialPlanning.controller) return;
      if (initialPlanning.controller.signal.aborted) setMessage('已取消规划');
      else if (result.ok) setProposal(result.proposal);
      else {
        setError(result.error instanceof Error ? result.error.message : '规划失败，请重试。');
        setConflict(result.error instanceof WorkbenchError && result.error.code === 'conflict');
        setPlanFailed(true);
      }
      setPlanning(false);
      controller.current = null;
    });
    return () => {
      subscribed = false;
    };
  }, [initialPlanning]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  function edit(next: WorkTask) {
    setTask(next);
    setProposal(null);
    setMessage('');
  }
  function navigate(id: string, nodeId?: string | null, local = false, locate = true) {
    selectionMemory.current.set(workflow.id, node?.id ?? null);
    const location = resolveWorkLocation(
      workTree,
      { workflowId: id, nodeId: nodeId ?? null },
      selectionMemory.current,
    );
    setWorkflowId(location.workflowId);
    setSelectedId(location.nodeId);
    setExpanded(
      (current) =>
        new Set([...current, ...workflowPath(workTree, location.workflowId).map((w) => w.id)]),
    );
    setNavigationNotice('');
    if (locate) setLocateRequest((request) => request + 1);
    if (local) {
      setTree(false);
      setPanel('config');
      if (compact) setInspectorOpen(false);
    }
  }
  function selectNode(id: string, locate = false) {
    const owner = workTree.owner.get(id);
    if (!owner) return;
    navigate(owner.id, id, false, locate);
    setPanel(proposal ? 'plan' : 'config');
    if (!tree) setInspectorOpen(true);
  }
  function changeWorkflow(next: Workflow) {
    const candidate = {
      ...task,
      workflows: task.workflows.map((w) => (w.id === next.id ? next : w)),
    };
    const errors = validateWorkTask(candidate, state).filter(
      (e) => e.includes('循环') || e.includes('无效依赖'),
    );
    if (errors.length) {
      setError(errors.join('\n'));
      return;
    }
    setError('');
    edit(candidate);
  }
  function updateNode(patch: Partial<WorkNode>) {
    if (node)
      changeWorkflow({
        ...workflow,
        nodes: workflow.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
      });
  }
  async function persist(next = task, expectedRevision = revision): Promise<Workbench | null> {
    if (!next.title.trim()) {
      setError('请填写任务标题。');
      return null;
    }
    const unnamed = next.workflows.flatMap((w) => w.nodes).find((n) => !n.title.trim());
    if (unnamed) {
      setSelectedId(unnamed.id);
      setWorkflowId(next.workflows.find((w) => w.nodes.includes(unnamed))!.id);
      setPanel('config');
      setInspectorOpen(true);
      setError('请填写所选工作节点的名称。');
      return null;
    }
    const errors = validateWorkTask(next, state);
    if (errors.length) {
      setError(errors.join('\n'));
      const invalid = next.workflows
        .flatMap((w) => w.nodes)
        .find((n) => errors.some((e) => e.includes(`「${n.title}」`)));
      if (invalid) {
        setSelectedId(invalid.id);
        setWorkflowId(next.workflows.find((w) => w.nodes.includes(invalid))!.id);
        setPanel('config');
        setInspectorOpen(true);
      }
      return null;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const content = JSON.stringify(next);
    if (pendingSave.current?.content !== content)
      pendingSave.current = {
        content,
        requestId: crypto.randomUUID(),
        revision: expectedRevision,
        task: { ...next, updatedAt: new Date().toISOString() },
      };
    try {
      const result = await api.save(
        pendingSave.current.revision,
        { type: 'save-task', task: pendingSave.current.task },
        pendingSave.current.requestId,
      );
      const committed = result.tasks.find((t) => t.id === next.id)!;
      setTask(structuredClone(committed));
      setBaseline(JSON.stringify(committed));
      setRevision(result.revision);
      saved(result);
      if (committed.status === 'ready') setPanel('config');
      pendingSave.current = null;
      setMessage('已保存');
      setConflict(false);
      return result;
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试。');
      setConflict(error instanceof WorkbenchError && error.code === 'conflict');
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function readLatest() {
    if (!confirm('读取最新版本会放弃未保存的修改和未应用草案，确定继续吗？')) return;
    setBusy(true);
    try {
      const latest = await api.snapshot();
      const current = latest.state.tasks.find((t) => t.id === task.id);
      if (!current) throw new Error('任务已不存在。');
      setTask(structuredClone(current));
      setBaseline(JSON.stringify(current));
      setRevision(latest.state.revision);
      saved(latest.state);
      pendingSave.current = null;
      setProposal(null);
      setPlanFailed(false);
      setConflict(false);
      setError('');
      // Reconcile against the new snapshot in the navigation effect, keeping a surviving ancestor.
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取失败。');
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    if (hasGaps) {
      setMappingRoles({});
      setMappingResources({});
      setMappingError('');
      setMappingOpen(true);
      return;
    }
    const result = dirty ? await persist() : state;
    if (!result) return;
    setPlanning(true);
    setPlanFailed(false);
    setError('');
    setMessage('');
    const abort = new AbortController();
    controller.current = abort;
    // Keep the reviewed proposal available if this replacement fails or is cancelled.
    try {
      const next = await api.plan(
        task.id,
        result.revision,
        instruction,
        abort.signal,
        proposal?.id,
      );
      abort.signal.throwIfAborted();
      setProposal(next);
    } catch (error) {
      if (abort.signal.aborted) setMessage('已取消规划');
      else {
        setError(error instanceof Error ? error.message : '规划失败。');
        setConflict(error instanceof WorkbenchError && error.code === 'conflict');
        setPlanFailed(true);
      }
    } finally {
      setPlanning(false);
      controller.current = null;
    }
  }
  async function applyProposal() {
    if (!proposal || proposal.result.questions.length) return;
    if (dirty) {
      setError('工作流已有未保存修改，请先保存后重新规划。');
      return;
    }
    const next = { ...task, workflows: proposal.result.workflows, status: 'draft' as const };
    const result = await persist(next, proposal.baseRevision);
    if (result) {
      setWorkflowId(next.workflows.find((w) => !w.parentNodeId)!.id);
      setSelectedId(next.workflows[0]?.nodes[0]?.id ?? null);
      setProposal(null);
      setPanel('config');
      setInspectorOpen(true);
      setMessage('草案已应用，可继续编辑。');
    }
  }
  function addNode() {
    const next = newNode();
    next.position = { x: workflow.nodes.length * 260 + 40, y: 80 };
    changeWorkflow({ ...workflow, nodes: [...workflow.nodes, next] });
    setSelectedId(next.id);
    setPanel('config');
    setInspectorOpen(true);
  }
  function splitNode() {
    if (!node) return;
    const existing = task.workflows.find((w) => w.parentNodeId === node.id);
    if (existing) {
      navigate(existing.id, undefined, true);
      return;
    }
    const child: Workflow = {
      id: crypto.randomUUID(),
      name: node.title,
      parentNodeId: node.id,
      nodes: [],
    };
    edit({ ...task, workflows: [...task.workflows, child] });
    setWorkflowId(child.id);
    setSelectedId(null);
  }
  function removeSubworkflow() {
    if (!workflow.parentNodeId || locked) return;
    if (!confirm('移除此子工作流及其下级工作流？上级工作节点会保留。')) return;
    const removed = new Set([workflow.id]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      const parentNodes = new Set(
        task.workflows.filter((w) => removed.has(w.id)).flatMap((w) => w.nodes.map((n) => n.id)),
      );
      for (const candidate of task.workflows)
        if (
          candidate.parentNodeId &&
          parentNodes.has(candidate.parentNodeId) &&
          !removed.has(candidate.id)
        ) {
          removed.add(candidate.id);
          expanded = true;
        }
    }
    const parent = task.workflows.find((w) => w.nodes.some((n) => n.id === workflow.parentNodeId))!;
    edit({ ...task, workflows: task.workflows.filter((w) => !removed.has(w.id)) });
    setWorkflowId(parent.id);
    setSelectedId(workflow.parentNodeId);
  }
  function moveNode(id: string, offset: number) {
    const index = workflow.nodes.findIndex((n) => n.id === id);
    const next = [...workflow.nodes];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    changeWorkflow({ ...workflow, nodes: next });
  }
  return (
    <div className="zm-editor" ref={editorRef}>
      <div className="zm-toolbar">
        <button
          className="zm-quiet"
          onClick={() => {
            if (!dirty || confirm('有未保存的修改，确定离开吗？')) close();
          }}
        >
          ← 任务清单
        </button>
        <span className="zm-path-divider">/</span>
        <span className="zm-editor-project">
          {state.projects.find((p) => p.id === task.projectId)?.name}
        </span>
        <span className="zm-spacer" />
        <Button
          variant="quiet"
          disabled={busy || planning || !!previewTask || !!pendingSave.current || hasGaps}
          title={hasGaps ? '先补齐映射，再保存为新工作流' : undefined}
          onClick={() => {
            try {
              setTemplateSave(captureWorkflowTemplate(task, state));
            } catch (e) {
              setError(e instanceof Error ? e.message : '请先补齐节点交付内容。');
            }
          }}
        >
          保存为工作流
        </Button>
        <Appearance store={appearance} />
        {conflict && (
          <Button disabled={busy || planning} onClick={() => void readLatest()}>
            读取最新版本
          </Button>
        )}
        <span className="zm-save-state zm-muted" role="status">
          {dirty ? '未保存' : message || '已保存'}
        </span>
        {task.status === 'ready' ? (
          <button
            disabled={busy || planning}
            onClick={() => void persist({ ...task, status: 'draft' })}
          >
            继续编辑
          </button>
        ) : (
          <>
            <Button
              title={!dirty ? '当前没有未保存的修改' : locked ? '请先完成当前操作' : undefined}
              disabled={locked || !dirty}
              busy={busy && task.status === 'draft' && !previewTask}
              busyLabel="保存中…"
              onClick={() => void persist()}
            >
              保存草稿
            </Button>
            <button
              className="primary"
              disabled={locked}
              onClick={() => void persist({ ...task, status: 'ready' })}
            >
              确认工作流
            </button>
          </>
        )}
      </div>
      <div className="zm-editor-heading">
        {task.status === 'ready' ? (
          <h1>{task.title}</h1>
        ) : (
          <input
            className="zm-title-input"
            aria-label="任务标题"
            maxLength={160}
            value={task.title}
            disabled={locked}
            onChange={(e) => edit({ ...task, title: e.target.value })}
          />
        )}
        <div className="zm-task-meta">
          <span className={`zm-status ${task.status}`}>
            {task.status === 'ready'
              ? `已确认 v${state.appliedPlans.filter((p) => p.taskId === task.id).at(-1)?.revision ?? 1} · 待执行接入`
              : '计划草稿'}
          </span>
          {locked ? (
            <span className="zm-task-owner-readonly">
              <span>负责人</span>
              <b title={members.find((p) => p.id === task.ownerId)?.name}>
                {task.ownerId
                  ? (members.find((p) => p.id === task.ownerId)?.name ?? '不可用成员')
                  : '待补选'}
              </b>
            </span>
          ) : (
            <ParticipantSelect
              label="负责人"
              members={actualMembers.filter((p) => p.kind === 'human')}
              selected={task.ownerId ? [task.ownerId] : []}
              change={(ids) => edit({ ...task, ownerId: ids[0] ?? null })}
            />
          )}
          <Button
            variant="quiet"
            disabled={busy || planning || !!previewTask}
            onClick={() => {
              setMemberDraft(task.participantIds);
              setMemberError('');
              setMembersOpen(true);
            }}
          >
            参与者 {actualMembers.length}
          </Button>
        </div>
        <details className="zm-goal">
          <summary>
            <span>
              {task.goal.slice(0, 120) || '补充任务目标'}
              {task.goal.length > 120 && '…'}
            </span>
            <b>需求详情</b>
          </summary>
          {task.status === 'ready' ? (
            <p className="zm-prewrap">{task.goal}</p>
          ) : (
            <textarea
              aria-label="任务目标"
              rows={5}
              disabled={locked}
              value={task.goal}
              onChange={(e) => edit({ ...task, goal: e.target.value })}
              placeholder="描述目标、背景和预期结果"
            />
          )}
        </details>
      </div>
      {hasGaps && (
        <div className="zm-template-gap-banner" role="status">
          <span>
            待绑定：{gaps.participants.length} 个角色 · {gaps.assets.length} 个资源
          </span>
          <Button
            disabled={locked}
            onClick={() => {
              setMappingRoles({});
              setMappingResources({});
              setMappingError('');
              setMappingOpen(true);
            }}
          >
            补齐映射
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="zm-error">
          {error}
          <button onClick={() => setError('')} aria-label="关闭错误">
            ×
          </button>
        </div>
      )}
      <div className={`zm-editor-layout ${inspectorOpen ? 'inspector-open' : 'inspector-closed'}`}>
        <section className="zm-workflow">
          <div className="zm-workflow-tools">
            <nav aria-label="工作树路径">
              {ancestors.map((w, i) => (
                <span key={w.id}>
                  {i > 0 && <span className="zm-path-divider">/</span>}
                  <button
                    title={w.name}
                    aria-current={w.id === workflow.id ? 'location' : undefined}
                    onClick={() => navigate(w.id)}
                  >
                    {i === 0 ? '主工作流' : w.name}
                  </button>
                </span>
              ))}
            </nav>
            <span className="zm-node-count">
              {tree ? `${workTree.workflows.size} 个工作流` : `${workflow.nodes.length} 节点`}
            </span>
            {workflow.parentNodeId && (
              <button
                className="zm-quiet"
                onClick={() => {
                  const parent = workTree.owner.get(workflow.parentNodeId!);
                  if (parent) navigate(parent.id);
                }}
              >
                ↑ 上一级
              </button>
            )}
            <span className="zm-spacer" />
            <div className="zm-segment">
              <button
                aria-pressed={view === 'list'}
                onClick={() => {
                  setView('list');
                  setTree(false);
                }}
              >
                列表
              </button>
              <button
                aria-pressed={view === 'workflow' && !tree}
                onClick={() => {
                  setView('workflow');
                  setTree(false);
                }}
              >
                工作流
              </button>
              <button
                aria-pressed={tree}
                onClick={() => {
                  setTree(!tree);
                  setView('workflow');
                  setPanel('config');
                  if (!tree && !compact) setInspectorOpen(true);
                }}
              >
                工作树定位
              </button>
            </div>
            {!locked && !tree && (
              <button className="zm-quiet" onClick={addNode}>
                ＋ 节点
              </button>
            )}
            <button
              className="zm-quiet"
              aria-pressed={inspectorOpen && panel === 'config'}
              onClick={() => {
                setPanel('config');
                setInspectorOpen(!inspectorOpen || panel !== 'config');
              }}
            >
              {tree ? '层级导航' : task.status === 'ready' ? '节点详情' : '配置'}
            </button>
            {task.status !== 'ready' && (
              <button
                className="zm-quiet"
                aria-pressed={inspectorOpen && panel === 'plan'}
                onClick={() => {
                  setPanel('plan');
                  setInspectorOpen(true);
                }}
              >
                ✧ AI 规划
              </button>
            )}
          </div>
          {previewTask && (
            <div className="zm-preview-banner">
              <strong>AI 草案</strong>
              <span>正在预览，应用后可继续编辑</span>
              <button
                onClick={() => {
                  setPanel('plan');
                  setInspectorOpen(true);
                }}
              >
                审阅草案 →
              </button>
            </div>
          )}
          {workflow.parentNodeId && !tree && !locked && (
            <details className="zm-flow-more">
              <summary>子工作流操作</summary>
              <button className="danger" onClick={removeSubworkflow}>
                移除子工作流
              </button>
            </details>
          )}
          {navigationNotice && (
            <p role="status" className="zm-hint">
              {navigationNotice}
            </p>
          )}
          {tree && (
            <div className="zm-tree-legend">
              <span>— 工作依赖</span>
              <span>┄ 层级拆分</span>
              <span className="zm-tree-path-key">当前位置与上级路径</span>
            </div>
          )}
          {view === 'workflow' && (workflow.nodes.length > 0 || tree) ? (
            <WorkflowCanvas
              key={tree ? 'tree' : workflow.id}
              workflow={workflow}
              task={displayTask}
              members={members}
              selectedId={selectedId}
              select={selectNode}
              change={changeWorkflow}
              locked={locked}
              tree={tree}
              workTree={workTree}
              expanded={expanded}
              locateRequest={locateRequest}
            />
          ) : workflow.nodes.length ? (
            <div className="zm-node-list">
              {workflow.nodes.map((n, i) => (
                <div
                  key={n.id}
                  className={`zm-node-row ${n.id === selectedId ? 'selected' : ''}`}
                  draggable={!locked}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', n.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (locked) return;
                    const source = e.dataTransfer.getData('text/plain');
                    if (!workflow.nodes.some((n) => n.id === source)) return;
                    const ordered = [...workflow.nodes];
                    const item = ordered.splice(
                      ordered.findIndex((n) => n.id === source),
                      1,
                    )[0]!;
                    ordered.splice(i, 0, item);
                    changeWorkflow({ ...workflow, nodes: ordered });
                  }}
                >
                  <span className="zm-order">{String(i + 1).padStart(2, '0')}</span>
                  <button className="zm-node-main" onClick={() => selectNode(n.id)}>
                    <strong>{n.title}</strong>
                    <span>
                      {members.find((m) => m.id === n.assigneeId)?.name ?? '未分配'}
                      <i>·</i>
                      {n.dependsOn.length ? `依赖 ${n.dependsOn.length} 个节点` : '无前置依赖'}
                      {displayTask.workflows.some((w) => w.parentNodeId === n.id) &&
                        ' · 含子工作流'}
                    </span>
                  </button>
                  <small>{n.reviewRequired ? `${n.reviewerIds.length} 人评审` : '无需评审'}</small>
                  {!locked && (
                    <div className="zm-row-actions">
                      <button
                        aria-label={`上移 ${n.title}`}
                        disabled={locked || i === 0}
                        onClick={() => moveNode(n.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`下移 ${n.title}`}
                        disabled={locked || i === workflow.nodes.length - 1}
                        onClick={() => moveNode(n.id, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          {!workflow.nodes.length && !tree && panel === 'plan' && (
            <div className="zm-empty zm-plan-canvas-placeholder">
              <span aria-hidden="true">✧</span>
              <h3>{planning ? '正在生成工作流' : '工作流将在这里展开'}</h3>
            </div>
          )}
          {!workflow.nodes.length && !tree && panel !== 'plan' && (
            <div className="zm-empty">
              <h3>从一个清晰的工作节点开始</h3>
              <p>手动编排，或让 AI 根据任务和团队情况生成草案。</p>
              <button
                onClick={() => {
                  setPanel('plan');
                  setInspectorOpen(true);
                }}
              >
                AI 规划
              </button>
              <button className="primary" disabled={locked} onClick={addNode}>
                添加节点
              </button>
            </div>
          )}
        </section>
        {inspectorOpen && (
          <button
            className="zm-drawer-scrim"
            aria-label="关闭配置面板"
            onClick={() => setInspectorOpen(false)}
          />
        )}
        <aside
          className="zm-config"
          data-panel={panel}
          ref={inspectorRef}
          role={compact && inspectorOpen ? 'dialog' : undefined}
          aria-modal={compact && inspectorOpen ? true : undefined}
          aria-label={
            panel === 'config' ? (tree ? '工作树导航面板' : '节点配置面板') : 'AI 规划面板'
          }
          hidden={!inspectorOpen}
          onKeyDown={(event) => {
            if (!compact) return;
            if (event.target instanceof HTMLElement && event.target.closest('dialog')) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setInspectorOpen(false);
            }
            if (event.key === 'Tab') {
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary',
                ),
              ].filter((e) => e.getClientRects().length > 0);
              const first = items[0],
                last = items.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <div className="zm-panel-tabs">
            <strong>
              {panel === 'config'
                ? tree
                  ? '工作树导航'
                  : task.status === 'ready'
                    ? '节点详情'
                    : '配置'
                : 'AI 规划'}
            </strong>
            <span className="zm-spacer" />
            <button aria-label="收起侧栏" onClick={() => setInspectorOpen(false)}>
              ×
            </button>
          </div>
          {panel === 'config' && tree ? (
            <TreeNavigator
              tree={workTree}
              workflow={workflow}
              selectedId={node?.id ?? null}
              expanded={expanded}
              toggle={(id) => {
                setLocateRequest((request) => request + 1);
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              expandAll={() => setExpanded(new Set(workTree.workflows.keys()))}
              select={(id) => selectNode(id, true)}
              enter={(id) => navigate(id, undefined, true)}
            />
          ) : panel === 'config' ? (
            node ? (
              <NodeInspector
                node={node}
                workflow={workflow}
                members={members}
                state={inspectorState}
                readOnly={task.status === 'ready' || !!previewTask}
                disabled={locked}
                hasChild={displayTask.workflows.some((w) => w.parentNodeId === node.id)}
                update={updateNode}
                manageMembers={() => {
                  setMemberDraft(task.participantIds);
                  setMemberError('');
                  setMembersOpen(true);
                }}
                split={splitNode}
                remove={() => {
                  if (confirm(`删除「${node.title}」及其依赖连线？`)) {
                    changeWorkflow({
                      ...workflow,
                      nodes: workflow.nodes
                        .filter((n) => n.id !== node.id)
                        .map((n) => ({
                          ...n,
                          dependsOn: n.dependsOn.filter((id) => id !== node.id),
                        })),
                    });
                    setSelectedId(null);
                  }
                }}
              />
            ) : (
              <div className="zm-empty">
                <p>选择工作节点进行配置。</p>
              </div>
            )
          ) : (
            <div className="zm-planner">
              <div className="zm-planner-body">
                <details className="zm-planning-context">
                  <summary>
                    <span>规划依据</span>
                    <span>
                      {members.length} 位参与者 · {state.assets.filter((a) => a.available).length}{' '}
                      项资产
                    </span>
                  </summary>
                  <ul>
                    {members.map((m) => (
                      <li key={m.id}>
                        {m.name} · {m.role || m.capabilities.join('、') || '尚无职责说明'}
                      </li>
                    ))}
                  </ul>
                  <p>模型：{model}</p>
                  <p>模型只读取任务、人员职责和资产定义，不获得工具授权。</p>
                </details>
                {!proposal && !planning && (
                  <div className="zm-planning-intro">
                    <span aria-hidden="true">✧</span>
                    <h3>把目标拆成可执行的工作</h3>
                    <p>结合参与者的职责与团队资产，组织分工、依赖和交付。</p>
                  </div>
                )}
                {planning && (
                  <div role="status" className="zm-planning-progress">
                    <span className="zm-spinner" aria-hidden="true" />
                    正在分析目标与团队能力…
                  </div>
                )}
                {proposal && (
                  <div className="zm-proposal">
                    <div className="zm-proposal-heading">
                      <h3>规划草案</h3>
                      <Button
                        variant="quiet"
                        disabled={busy || planning}
                        onClick={() => setProposal(null)}
                      >
                        放弃草案
                      </Button>
                    </div>
                    <details className="zm-plan-summary">
                      <summary>
                        {proposal.result.summary.slice(0, 150)}
                        {proposal.result.summary.length > 150 && '…'}
                      </summary>
                      <p>{proposal.result.summary}</p>
                    </details>
                    {proposal.result.questions.length > 0 && (
                      <div className="zm-questions">
                        <strong>需要你确认</strong>
                        <ol>
                          {proposal.result.questions.map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {proposal.result.assumptions.length > 0 && (
                      <details>
                        <summary>规划中的假设</summary>
                        <ul>
                          {proposal.result.assumptions.map((a) => (
                            <li key={a}>{a}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {previewTask && (
                      <div className="zm-proposal-node">
                        <span className="zm-current-node-label">当前节点</span>
                        <strong>{(node ?? workflow.nodes[0])?.title}</strong>
                        <p>{(node ?? workflow.nodes[0])?.rationale}</p>
                        <small>交付：{(node ?? workflow.nodes[0])?.output}</small>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="zm-planner-composer">
                <Field
                  label={proposal?.result.questions.length ? '回答问题或补充要求' : '补充要求'}
                >
                  <textarea
                    rows={3}
                    maxLength={8000}
                    value={instruction}
                    disabled={busy || planning}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder={
                      proposal
                        ? '调整这份计划，例如：让前后端并行…'
                        : '例如：前后端并行，测试专家独立评审…'
                    }
                  />
                </Field>
                <div className="zm-planning-actions">
                  <Button
                    variant={
                      proposal && !proposal.result.questions.length ? 'secondary' : 'primary'
                    }
                    busy={planning}
                    busyLabel="正在规划…"
                    title={
                      conflict
                        ? '请先读取最新版本，再重新生成草案'
                        : !members.length
                          ? '请先添加任务参与者'
                          : undefined
                    }
                    disabled={
                      busy || planning || conflict || task.status === 'ready' || !members.length
                    }
                    onClick={() => void generate()}
                  >
                    {proposal ? '重新规划' : planFailed ? '重试规划' : '生成工作流草案'}
                  </Button>
                  {planning && (
                    <Button variant="quiet" onClick={() => controller.current?.abort()}>
                      取消
                    </Button>
                  )}
                  {!planning && !proposal && (
                    <Button
                      variant="quiet"
                      disabled={busy || conflict}
                      onClick={() => {
                        setError('');
                        setPanel('config');
                        setTree(false);
                        setView('workflow');
                        if (!workflow.nodes.length) addNode();
                      }}
                    >
                      手动编排
                    </Button>
                  )}
                  {previewTask && proposal && (
                    <Button
                      variant="primary"
                      busy={busy}
                      busyLabel="应用中…"
                      title={
                        conflict
                          ? '请先读取最新版本，再重新生成草案'
                          : proposal.result.questions.length
                            ? '请先回答关键问题并重新规划'
                            : undefined
                      }
                      disabled={
                        busy ||
                        planning ||
                        conflict ||
                        !!proposal.result.questions.length ||
                        !proposal.result.workflows.length
                      }
                      onClick={() => void applyProposal()}
                    >
                      应用草案
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
      {membersOpen && (
        <Modal title="任务参与者" close={() => setMembersOpen(false)}>
          {memberError && (
            <p role="alert" className="zm-error">
              {memberError}
            </p>
          )}
          <MemberPicker
            members={state.participants}
            selected={memberDraft}
            change={setMemberDraft}
          />
          <footer>
            <button onClick={() => setMembersOpen(false)}>取消</button>
            <button
              className="primary"
              disabled={locked}
              onClick={() => {
                const referenced = task.workflows.flatMap((w) =>
                  w.nodes.flatMap((n) => [
                    ...(n.assigneeId ? [n.assigneeId] : []),
                    ...n.reviewerIds,
                  ]),
                );
                if (task.ownerId && !memberDraft.includes(task.ownerId)) {
                  setMemberError('请先更换任务负责人，再将该成员移出参与者。');
                  return;
                }
                if (
                  referenced.some(
                    (id) =>
                      !memberDraft.includes(id) && !gaps.participants.some((p) => p.id === id),
                  )
                ) {
                  setMemberError('被移除的参与者仍承担节点或评审，请先重新分配。');
                  return;
                }
                edit({ ...task, participantIds: memberDraft });
                setMembersOpen(false);
              }}
            >
              更新参与者
            </button>
          </footer>
        </Modal>
      )}
      {templateSave && (
        <TemplateSaveDialog
          definition={templateSave}
          initialName={task.title}
          api={api}
          revision={revision}
          close={() => setTemplateSave(null)}
          saved={(next) => {
            setRevision(next.revision);
            saved(next);
            setTemplateSave(null);
            setMessage('已保存到工作流');
          }}
        />
      )}
      {mappingOpen && (
        <Modal title="补齐模板映射" close={() => setMappingOpen(false)}>
          <div className="zm-form-body">
            <Button
              onClick={() => {
                setMemberDraft(task.participantIds);
                setMemberError('');
                setMembersOpen(true);
              }}
            >
              管理任务参与者
            </Button>
            <TemplateBindings
              roles={gaps.participants}
              resources={gaps.assets}
              members={actualMembers}
              assets={state.assets}
              roleValues={mappingRoles}
              resourceValues={mappingResources}
              changeRoles={setMappingRoles}
              changeResources={setMappingResources}
            />
            {mappingError && (
              <div role="alert" className="zm-error">
                {mappingError}
              </div>
            )}
          </div>
          <footer>
            <Button onClick={() => setMappingOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={
                ![...Object.values(mappingRoles), ...Object.values(mappingResources)].some(Boolean)
              }
              onClick={() => {
                try {
                  const roles = Object.fromEntries(
                    Object.entries(mappingRoles).filter(
                      (entry): entry is [string, string] => !!entry[1],
                    ),
                  );
                  const resources = Object.fromEntries(
                    Object.entries(mappingResources).filter(
                      (entry): entry is [string, string] => !!entry[1],
                    ),
                  );
                  edit(resolveTemplateBindings(task, state, roles, resources));
                  setMappingOpen(false);
                } catch (e) {
                  setMappingError(e instanceof Error ? e.message : '请重新检查映射。');
                }
              }}
            >
              应用映射
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
