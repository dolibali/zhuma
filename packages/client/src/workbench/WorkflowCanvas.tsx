import { useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  Panel,
  MarkerType,
  Position,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
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
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>(
    {},
  );
  const columns = new Map<number, number>();
  const depths = new Map<string, number>();
  function depth(w: Workflow): number {
    if (depths.has(w.id)) return depths.get(w.id)!;
    const parent = task.workflows.find((candidate) =>
      candidate.nodes.some((n) => n.id === w.parentNodeId),
    );
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(w.id, value);
    return value;
  }
  const flows = tree ? task.workflows : [workflow];
  const nodes: Node[] = flows.flatMap((w) => {
    const level = tree ? depth(w) : 0;
    const offset = columns.get(level) ?? 0;
    columns.set(level, offset + w.nodes.length * 164 + 60);
    return w.nodes.map((n, index) => {
      const member = members.find((m) => m.id === n.assigneeId);
      return {
        id: n.id,
        initialWidth: 240,
        initialHeight: 164,
        ...(dimensions[n.id] ? { measured: dimensions[n.id] } : {}),
        position: tree ? { x: level * 340, y: offset + index * 164 } : n.position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          label: (
            <>
              {tree && <small className="zm-flow-context">{w.name}</small>}
              <strong title={n.title}>{n.title}</strong>
              <div className="zm-flow-assignee">
                <span className={`zm-avatar ${member?.kind ?? 'human'}`}>
                  {member?.kind === 'expert' ? 'AI' : (member?.name.slice(0, 1) ?? '—')}
                </span>
                <span>
                  {member?.name ?? '未分配'}
                  <small>{member?.kind === 'expert' ? 'Agent 专家' : '团队成员'}</small>
                </span>
              </div>
              <div className="zm-flow-footer">
                <span>{n.reviewRequired ? `${n.reviewerIds.length} 位评审人` : '无需评审'}</span>
                {task.workflows.some((child) => child.parentNodeId === n.id) && (
                  <span>含子工作流 ↗</span>
                )}
              </div>
            </>
          ),
        },
        className: `zm-flow-node ${tree && w.id === workflow.id ? 'zm-tree-current' : ''}`,
        selected: n.id === selectedId,
      };
    });
  });
  const edges: Edge[] = flows.flatMap((w) =>
    w.nodes.flatMap((n) =>
      n.dependsOn.map((source) => ({
        id: `${source}-${n.id}`,
        source,
        target: n.id,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--zm-edge)' },
        style: { stroke: 'var(--zm-edge)', strokeWidth: 1.5 },
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
            type: 'smoothstep',
            style: { strokeDasharray: '5 5', stroke: 'var(--zm-expert)' },
            labelStyle: { fill: 'var(--zm-muted)', fontSize: 12 },
            labelBgStyle: { fill: 'var(--zm-paper)' },
          });
  function connect(connection: Connection) {
    if (
      locked ||
      tree ||
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    change({
      ...workflow,
      nodes: workflow.nodes.map((n) =>
        n.id === connection.target
          ? { ...n, dependsOn: [...new Set([...n.dependsOn, connection.source])] }
          : n,
      ),
    });
  }
  const current = nodes.find((n) => n.id === selectedId) ?? nodes[0];
  function locate(instance = flow) {
    if (!instance || !current) return;
    void instance.setViewport({
      x: 40 - current.position.x,
      y: Math.max(70, (canvas.current?.clientHeight ?? 500) / 2 - 70) - current.position.y,
      zoom: 1,
    });
    setZoom(1);
  }
  return (
    <div className="zm-canvas" ref={canvas}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        minZoom={0.15}
        maxZoom={1.8}
        onInit={(instance) => {
          setFlow(instance);
          locate(instance);
        }}
        onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
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
          const measured = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
          if (measured.length)
            setDimensions((current) => {
              const next = { ...current };
              let changed = false;
              for (const change of measured)
                if (
                  change.type === 'dimensions' &&
                  change.dimensions &&
                  (next[change.id]?.width !== change.dimensions.width ||
                    next[change.id]?.height !== change.dimensions.height)
                ) {
                  next[change.id] = change.dimensions;
                  changed = true;
                }
              return changed ? next : current;
            });
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
        <Background gap={24} size={1} color="var(--zm-grid)" />
        <Panel position="bottom-left" className="zm-canvas-controls">
          <button aria-label="缩小画布" onClick={() => void flow?.zoomOut()}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button aria-label="放大画布" onClick={() => void flow?.zoomIn()}>
            ＋
          </button>
          <button onClick={() => locate()}>定位当前</button>
          <button onClick={() => void flow?.fitView({ padding: 0.15, maxZoom: 1 })}>
            适应全图
          </button>
        </Panel>
        <MiniMap
          style={{ width: 130, height: 86 }}
          pannable
          zoomable
          nodeColor="var(--zm-minimap-node)"
          maskColor="var(--zm-minimap-mask)"
          bgColor="var(--zm-paper)"
        />
      </ReactFlow>
    </div>
  );
}
