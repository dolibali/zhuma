import { useMemo, useState } from 'react';
import {
  captureWorkflowTemplate,
  parseWorkflowTemplate,
  validateWorkTask,
  type Participant,
  type Workbench,
  type Workflow,
  type WorkflowTemplate,
  type WorkTask,
} from '@zhuma/agent-core';
import { Modal, Field } from './controls.js';
import { SingleSelect } from './SingleSelect.js';
import { Button } from './Button.js';
import { NodeInspector } from './NodeInspector.js';
import { WorkflowCanvas } from './WorkflowCanvas.js';
import { indexWorkTree } from './navigation.js';
import { newNode } from './TaskEditor.js';
import { templateRoleMembers } from './TemplatePreview.js';

function seed(content: string, state: Workbench) {
  let definition: WorkflowTemplate;
  let legacy = '';
  try {
    definition = parseWorkflowTemplate(content);
  } catch {
    legacy = content;
    definition = {
      format: 'zhuma-workflow-template',
      schemaVersion: 1,
      roles: [{ id: 'role-1', name: '执行角色', preferredKind: 'any', capabilities: [] }],
      resources: [],
      workflows: [
        {
          id: 'flow-1',
          name: '主工作流',
          parentNodeId: null,
          nodes: [{ ...newNode(), id: 'node-1', assigneeId: 'role-1', title: '填写工作节点' }],
        },
      ],
    };
  }
  const pendingAssets: NonNullable<WorkTask['templateSource']>['pendingAssets'] = [];
  const resourceHints: Record<string, string> = {};
  const resourceIds = new Map(
    definition.resources.map((r) => {
      const asset = state.assets.find((a) => a.id === r.suggestedAssetId && a.kind === r.kind);
      if (asset) return [r.id, asset.id];
      const id = crypto.randomUUID();
      pendingAssets.push({ id, name: r.name, kind: r.kind });
      if (r.suggestedAssetId) resourceHints[id] = r.suggestedAssetId;
      return [r.id, id];
    }),
  );
  const task: WorkTask = {
    id: 'template-editor',
    projectId: 'template-editor',
    title: '工作流模板',
    goal: '',
    status: 'draft',
    participantIds: definition.roles.map((r) => r.id),
    ownerId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflows: definition.workflows.map((w) => ({
      ...w,
      nodes: w.nodes.map((n) => ({
        ...n,
        skillIds: n.skillIds.map((id) => resourceIds.get(id)!),
        mcpIds: n.mcpIds.map((id) => resourceIds.get(id)!),
      })),
    })),
    templateSource: {
      assetId: 'template-editor',
      sourceWorkbenchRevision: state.revision,
      definition,
      pendingParticipants: [],
      pendingAssets,
    },
  };
  return {
    task,
    members: templateRoleMembers(definition),
    preferences: Object.fromEntries(definition.roles.map((r) => [r.id, r.preferredKind])),
    legacy,
    resourceHints,
  };
}

export function TemplateDefinitionEditor({
  content,
  state,
  apply,
  close,
}: {
  content: string;
  state: Workbench;
  apply(content: string): void;
  close(): void;
}) {
  const [initial] = useState(() => seed(content, state));
  const [task, setTask] = useState(initial.task);
  const [members, setMembers] = useState(initial.members);
  const [preferences, setPreferences] = useState(initial.preferences);
  const [flowId, setFlowId] = useState(initial.task.workflows[0]!.id);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.task.workflows[0]!.nodes[0]?.id ?? null,
  );
  const [error, setError] = useState('');
  const [rolesOpen, setRolesOpen] = useState(false);
  const [roleDraft, setRoleDraft] = useState(members);
  const [preferenceDraft, setPreferenceDraft] = useState(preferences);
  const workTree = useMemo(() => indexWorkTree(task), [task]);
  const workflow = task.workflows.find((w) => w.id === flowId) ?? workTree.root;
  const node = workflow.nodes.find((n) => n.id === selectedId);
  const editorState: Workbench = {
    ...state,
    participants: members,
    projects: [...state.projects, { id: 'template-editor', name: '模板', description: '' }],
    assets: [
      ...state.assets,
      ...(task.templateSource?.pendingAssets ?? []).map((a) => ({
        ...a,
        description: '',
        content: '',
        available: false,
      })),
    ],
  };
  function updateWorkflow(next: Workflow) {
    const candidate = {
      ...task,
      workflows: task.workflows.map((w) => (w.id === next.id ? next : w)),
    };
    const errors = validateWorkTask(candidate, editorState).filter(
      (e) => e.includes('循环') || e.includes('无效依赖'),
    );
    if (errors.length) {
      setError(errors.join('\n'));
      return;
    }
    setError('');
    setTask(candidate);
  }
  function openRoles() {
    setRoleDraft(structuredClone(members));
    setPreferenceDraft({ ...preferences });
    setRolesOpen(true);
  }
  function save() {
    try {
      const result = captureWorkflowTemplate(
        task,
        { ...editorState, assets: state.assets },
        { rolePreferences: preferences, resourceHints: initial.resourceHints },
      );
      const oldNodes = task.workflows.flatMap((w) => w.nodes);
      result.workflows
        .flatMap((w) => w.nodes)
        .forEach((n, i) => {
          n.rationale = oldNodes[i]?.rationale ?? '';
        });
      apply(JSON.stringify(result));
    } catch (e) {
      setError(e instanceof Error ? e.message : '请补齐工作节点与交付内容。');
    }
  }
  function removeWorkflow() {
    if (!workflow.parentNodeId) return;
    const parent = task.workflows.find((w) => w.nodes.some((n) => n.id === workflow.parentNodeId));
    if (!parent) return;
    const removed = new Set([workflow.id]);
    for (let i = 0; i < task.workflows.length; i++) {
      const nodes = new Set(
        task.workflows.filter((w) => removed.has(w.id)).flatMap((w) => w.nodes.map((n) => n.id)),
      );
      for (const w of task.workflows)
        if (w.parentNodeId && nodes.has(w.parentNodeId)) removed.add(w.id);
    }
    setTask({ ...task, workflows: task.workflows.filter((w) => !removed.has(w.id)) });
    setFlowId(parent.id);
    setSelectedId(workflow.parentNodeId);
  }
  return (
    <Modal title="编辑工作流" close={close}>
      <div className="zm-template-definition-editor">
        <div className="zm-template-definition-tools">
          <SingleSelect
            label="编辑工作流层级"
            value={workflow.id}
            options={task.workflows.map((w) => ({ value: w.id, label: w.name }))}
            onValueChange={(id) => {
              setFlowId(id);
              setSelectedId(task.workflows.find((w) => w.id === id)?.nodes[0]?.id ?? null);
            }}
          />
          <input
            aria-label="工作流名称"
            maxLength={160}
            value={workflow.name}
            onChange={(e) => updateWorkflow({ ...workflow, name: e.target.value })}
          />
          <Button onClick={openRoles}>管理角色 {members.length}</Button>
          {workflow.parentNodeId && (
            <Button variant="quiet" onClick={removeWorkflow}>
              移除子工作流
            </Button>
          )}
          <Button
            onClick={() => {
              const n = {
                ...newNode(),
                assigneeId: members[0]?.id ?? null,
                position: { x: 60 + workflow.nodes.length * 280, y: 60 },
              };
              updateWorkflow({ ...workflow, nodes: [...workflow.nodes, n] });
              setSelectedId(n.id);
            }}
          >
            添加节点
          </Button>
        </div>
        {initial.legacy && (
          <details className="zm-template-legacy-reference">
            <summary>原文字参考</summary>
            <pre>{initial.legacy}</pre>
          </details>
        )}
        {error && (
          <div role="alert" className="zm-error">
            {error}
          </div>
        )}
        <div className="zm-template-definition-layout">
          <WorkflowCanvas
            key={workflow.id}
            workflow={workflow}
            task={task}
            members={members}
            selectedId={selectedId}
            select={setSelectedId}
            change={updateWorkflow}
            locked={false}
            tree={false}
            workTree={workTree}
            expanded={new Set(task.workflows.map((w) => w.id))}
            locateRequest={0}
            fitInitially
            roleMode
          />
          <aside>
            {node ? (
              <NodeInspector
                node={node}
                workflow={workflow}
                members={members}
                state={editorState}
                readOnly={false}
                disabled={false}
                roleMode
                hasChild={task.workflows.some((w) => w.parentNodeId === node.id)}
                manageMembers={openRoles}
                update={(patch) =>
                  updateWorkflow({
                    ...workflow,
                    nodes: workflow.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
                  })
                }
                split={() => {
                  const child = task.workflows.find((w) => w.parentNodeId === node.id);
                  if (child) {
                    setFlowId(child.id);
                    setSelectedId(child.nodes[0]?.id ?? null);
                    return;
                  }
                  const n = { ...newNode(), assigneeId: members[0]?.id ?? null };
                  const next = {
                    id: crypto.randomUUID(),
                    name: `${node.title} · 子工作流`.slice(0, 160),
                    parentNodeId: node.id,
                    nodes: [n],
                  };
                  setTask({ ...task, workflows: [...task.workflows, next] });
                  setFlowId(next.id);
                  setSelectedId(n.id);
                }}
                remove={() => {
                  updateWorkflow({
                    ...workflow,
                    nodes: workflow.nodes
                      .filter((n) => n.id !== node.id)
                      .map((n) => ({
                        ...n,
                        dependsOn: n.dependsOn.filter((id) => id !== node.id),
                      })),
                  });
                  setSelectedId(null);
                }}
              />
            ) : (
              <p className="zm-empty-inline">选择节点配置角色、交付和评审。</p>
            )}
          </aside>
        </div>
      </div>
      <footer>
        <Button onClick={close}>取消</Button>
        <Button variant="primary" onClick={save}>
          应用到模板
        </Button>
      </footer>
      {rolesOpen && (
        <Modal title="管理模板角色" close={() => setRolesOpen(false)}>
          <div className="zm-form-body zm-template-role-editor">
            {roleDraft.map((p, index) => {
              const used = task.workflows.some((w) =>
                w.nodes.some((n) => n.assigneeId === p.id || n.reviewerIds.includes(p.id)),
              );
              return (
                <section key={p.id}>
                  <Field label="角色名称">
                    <input
                      aria-label={`角色名称 ${index + 1}`}
                      maxLength={160}
                      value={p.name}
                      onChange={(e) =>
                        setRoleDraft(
                          roleDraft.map((r) =>
                            r.id === p.id
                              ? { ...r, name: e.target.value, role: e.target.value }
                              : r,
                          ),
                        )
                      }
                    />
                  </Field>
                  <SingleSelect
                    label={`角色偏好 ${index + 1}`}
                    value={preferenceDraft[p.id] ?? 'any'}
                    options={[
                      { value: 'any', label: '不限' },
                      { value: 'human', label: '真人' },
                      { value: 'expert', label: 'Agent 专家' },
                    ]}
                    onValueChange={(value) => {
                      setPreferenceDraft({
                        ...preferenceDraft,
                        [p.id]: value as 'human' | 'expert' | 'any',
                      });
                      setRoleDraft(
                        roleDraft.map((r) =>
                          r.id === p.id
                            ? { ...r, kind: value === 'expert' ? 'expert' : 'human' }
                            : r,
                        ),
                      );
                    }}
                  />
                  <Field label="能力关键词">
                    <input
                      aria-label={`角色能力 ${index + 1}`}
                      value={p.capabilities.join('，')}
                      onChange={(e) =>
                        setRoleDraft(
                          roleDraft.map((r) =>
                            r.id === p.id
                              ? { ...r, capabilities: e.target.value.split(/[,，]/u) }
                              : r,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Button
                    variant="quiet"
                    disabled={used}
                    title={used ? '请先修改使用此角色的节点' : undefined}
                    onClick={() => setRoleDraft(roleDraft.filter((r) => r.id !== p.id))}
                  >
                    移除
                  </Button>
                </section>
              );
            })}
            <Button
              onClick={() => {
                const id = crypto.randomUUID();
                setRoleDraft([
                  ...roleDraft,
                  {
                    id,
                    name: `角色 ${roleDraft.length + 1}`,
                    kind: 'human',
                    role: `角色 ${roleDraft.length + 1}`,
                    capabilities: [],
                    instructions: '',
                    available: true,
                  },
                ]);
                setPreferenceDraft({ ...preferenceDraft, [id]: 'any' });
              }}
            >
              添加角色
            </Button>
          </div>
          <footer>
            <Button onClick={() => setRolesOpen(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={roleDraft.some((p) => !p.name.trim())}
              onClick={() => {
                setMembers(
                  roleDraft.map((p) => ({
                    ...p,
                    name: p.name.trim(),
                    capabilities: [...new Set(p.capabilities.map((c) => c.trim()).filter(Boolean))],
                  })),
                );
                setPreferences(preferenceDraft);
                setTask({ ...task, participantIds: roleDraft.map((p) => p.id) });
                setRolesOpen(false);
              }}
            >
              确认角色
            </Button>
          </footer>
        </Modal>
      )}
    </Modal>
  );
}
