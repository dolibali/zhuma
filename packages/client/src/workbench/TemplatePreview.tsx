import { useMemo, useState } from 'react';
import type { Participant, WorkflowTemplate, WorkTask } from '@zhuma/agent-core';
import { WorkflowCanvas } from './WorkflowCanvas.js';
import { SingleSelect } from './SingleSelect.js';
import { indexWorkTree } from './navigation.js';

export function templateRoleMembers(definition: WorkflowTemplate): Participant[] {
  return definition.roles.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.preferredKind === 'expert' ? 'expert' : 'human',
    role: r.name,
    capabilities: r.capabilities,
    instructions: '',
    available: true,
  }));
}

export function TemplatePreview({ definition }: { definition: WorkflowTemplate }) {
  const task = useMemo<WorkTask>(
    () => ({
      id: 'template-preview',
      projectId: 'template-preview',
      title: '工作流预览',
      goal: '',
      participantIds: definition.roles.map((r) => r.id),
      ownerId: null,
      workflows: definition.workflows,
      status: 'draft',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    [definition],
  );
  const workTree = useMemo(() => indexWorkTree(task), [task]);
  const [flowId, setFlowId] = useState(workTree.root.id);
  const [view, setView] = useState<'list' | 'workflow'>('workflow');
  const workflow = workTree.workflows.get(flowId) ?? workTree.root;
  const [selectedId, setSelectedId] = useState<string | null>(workflow.nodes[0]?.id ?? null);
  const members = templateRoleMembers(definition);
  const node = task.workflows.flatMap((w) => w.nodes).find((n) => n.id === selectedId);
  const name = (id: string | null) => members.find((p) => p.id === id)?.name ?? '待分配角色';
  return (
    <section className="zm-template-preview" aria-label="工作流预览">
      <div className="zm-template-preview-tools">
        <SingleSelect
          label="预览工作流层级"
          value={flowId}
          onValueChange={(id) => {
            setFlowId(id);
            setSelectedId(workTree.workflows.get(id)?.nodes[0]?.id ?? null);
          }}
          options={definition.workflows.map((w) => ({ value: w.id, label: w.name }))}
        />
        <div className="zm-view-switch" aria-label="预览显示方式">
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            清单
          </button>
          <button
            type="button"
            aria-pressed={view === 'workflow'}
            onClick={() => setView('workflow')}
          >
            工作流
          </button>
        </div>
      </div>
      <div className="zm-template-preview-body">
        {view === 'workflow' ? (
          <WorkflowCanvas
            key={workflow.id}
            workflow={workflow}
            task={task}
            members={members}
            selectedId={selectedId}
            select={setSelectedId}
            change={() => {}}
            locked
            tree={false}
            workTree={workTree}
            expanded={new Set(workTree.workflows.keys())}
            locateRequest={0}
            fitInitially
            roleMode
          />
        ) : (
          <ol className="zm-template-node-list">
            {workflow.nodes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  aria-pressed={n.id === selectedId}
                  onClick={() => setSelectedId(n.id)}
                >
                  <strong>{n.title}</strong>
                  <span>{name(n.assigneeId)}</span>
                  <small>{n.output}</small>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {node && (
        <div className="zm-template-node-detail">
          <strong>{node.title}</strong>
          <p>交付：{node.output}</p>
          <small>
            {name(node.assigneeId)}
            {node.reviewRequired ? ` · 评审：${node.reviewerIds.map(name).join('、')}` : ''}
          </small>
        </div>
      )}
    </section>
  );
}
