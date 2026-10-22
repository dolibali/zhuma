import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Position,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react';
import type { WorkTask, Workflow, Participant } from '@zhuma/agent-core';

export function WorkflowCanvas({
  workflow,
  members,
  selectedId,
  select,
  change,
  locked,
  task,
  tree,
  openWorkflow,
}: {
  workflow: Workflow;
  members: Participant[];
  selectedId: string | null;
  select(id: string): void;
  change(workflow: Workflow): void;
  locked: boolean;
  task: WorkTask;
  tree: boolean;
  openWorkflow(id: string): void;
}) {
  const nodes: Node[] = tree
    ? task.workflows.flatMap((w, index) =>
        w.nodes.map((n, j) => ({
          id: n.id,
          position: { x: index * 300, y: j * 140 },
          data: {
            label: (
              <>
                <small>{w.name}</small>
                <strong>{n.title}</strong>
                <span>{members.find((m) => m.id === n.assigneeId)?.name ?? '未分配'}</span>
              </>
            ),
          },
          className: `zm-flow-node ${w.id === workflow.id ? 'zm-tree-current' : ''}`,
          selected: n.id === selectedId,
        })),
      )
    : workflow.nodes.map((n) => ({
        id: n.id,
        position: n.position,
        data: {
          label: (
            <>
              <strong>{n.title}</strong>
              <span>{members.find((m) => m.id === n.assigneeId)?.name ?? '未分配'}</span>
              <small>
                {n.reviewRequired ? `${n.reviewerIds.length} 位评审人` : '无需评审'}
                {task.workflows.some((w) => w.parentNodeId === n.id) ? ' · 含子工作流' : ''}
              </small>
            </>
          ),
        },
        className: 'zm-flow-node',
        selected: n.id === selectedId,
      }));
  const flows = tree ? task.workflows : [workflow];
  const edges: Edge[] = flows.flatMap((w) =>
    w.nodes.flatMap((n) =>
      n.dependsOn.map((source) => ({
        id: `${source}-${n.id}`,
        source,
        target: n.id,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#438d88', strokeWidth: 2 },
      })),
    ),
  );
  if (tree)
    for (const w of task.workflows)
      if (w.parentNodeId)
        for (const n of w.nodes.filter((n) => !n.dependsOn.length))
          edges.push({
            id: `tree-${n.id}`,
            source: w.parentNodeId,
            target: n.id,
            label: '拆分',
            style: { strokeDasharray: '5 5', stroke: '#a096be' },
            type: 'smoothstep',
          });
  function connect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    change({
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n.id === connection.target
          ? { ...n, dependsOn: [...new Set([...n.dependsOn, connection.source])] }
          : n,
      ),
    });
  }
  return (
    <div className="zm-canvas">
      <ReactFlow
        nodes={nodes.map((n) => ({
          ...n,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        }))}
        edges={edges}
        fitView
        minZoom={0.15}
        maxZoom={1.8}
        nodesDraggable={!locked && !tree}
        nodesConnectable={!locked && !tree}
        deleteKeyCode={null}
        onNodeClick={(_, n) => {
          if (tree) {
            const owner = task.workflows.find((w) => w.nodes.some((node) => node.id === n.id));
            if (owner) openWorkflow(owner.id);
          }
          select(n.id);
        }}
        onNodesChange={(changes) => {
          if (locked || tree) return;
          const positions = new Map(
            changes.flatMap((c) =>
              c.type === 'position' && c.position ? [[c.id, c.position] as const] : [],
            ),
          );
          if (positions.size)
            change({
              ...workflow,
              nodes: workflow.nodes.map((n) =>
                positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n,
              ),
            });
        }}
        onNodeDragStop={(_, n) =>
          change({
            ...workflow,
            nodes: workflow.nodes.map((node) =>
              node.id === n.id ? { ...node, position: n.position } : node,
            ),
          })
        }
        onConnect={connect}
        onEdgeDoubleClick={(_, edge) => {
          if (!locked && !tree)
            change({
              ...workflow,
              nodes: workflow.nodes.map((n) =>
                n.id === edge.target
                  ? { ...n, dependsOn: n.dependsOn.filter((id) => id !== edge.source) }
                  : n,
              ),
            });
        }}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
