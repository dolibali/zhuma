import { useEffect, useRef, useState } from 'react';
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
import { visibleWorkflows, workflowPath, type WorkTree } from './navigation.js';

export function WorkflowCanvas({
  workflow,
  members,
  selectedId,
  select,
  change,
  locked,
  task,
  tree,
  workTree,
  expanded,
  locateRequest,
  fitInitially = false,
  roleMode = false,
}: {
  workflow: Workflow;
  members: Participant[];
  selectedId: string | null;
  select(id: string): void;
  change(workflow: Workflow): void;
  locked: boolean;
  task: WorkTask;
  tree: boolean;
  workTree: WorkTree;
  expanded: ReadonlySet<string>;
  locateRequest: number;
  fitInitially?: boolean;
  roleMode?: boolean;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [zoom, setZoom] = useState(1);
  const initiallyFitted = useRef(false);
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>(
    {},
  );
  const columns = new Map<number, number>();
  const path = workflowPath(workTree, workflow.id);
  const parentNodes = new Set(path.flatMap((w) => (w.parentNodeId ? [w.parentNodeId] : [])));
  const flows = tree ? visibleWorkflows(workTree, expanded) : [workflow];
  const nodes: Node[] = flows.flatMap((w) => {
    const level = tree ? workflowPath(workTree, w.id).length - 1 : 0;
    const offset = columns.get(level) ?? 0;
    columns.set(level, offset + w.nodes.length * 210 + 60);
    return w.nodes.map((n, index) => {
      const member = members.find((m) => m.id === n.assigneeId);
      return {
        id: n.id,
        initialWidth: 240,
        initialHeight: 164,
        ...(dimensions[n.id] ? { measured: dimensions[n.id] } : {}),
        position: tree ? { x: level * 340, y: offset + index * 210 } : n.position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        ariaLabel: `${n.title}，${w.name}`,
        data: {
          label: (
            <>
              {tree && (
                <small className="zm-flow-context">
                  <span>{w.name}</span>
                  {n.id === selectedId && <b>当前定位</b>}
                </small>
              )}
              <strong title={n.title}>{n.title}</strong>
              <div className="zm-flow-assignee">
                <span className={`zm-avatar ${member?.kind ?? 'human'}`}>
                  {member?.kind === 'expert' ? 'AI' : (member?.name.slice(0, 1) ?? '—')}
                </span>
                <span>
                  {member?.name ?? (n.assigneeId ? '执行者信息未提供' : '未分配')}
                  <small>
                    {roleMode
                      ? '模板角色'
                      : member?.kind === 'expert'
                        ? 'Agent 专家'
                        : member
                          ? '团队成员'
                          : n.assigneeId
                            ? '身份待核实'
                            : '待分配'}
                  </small>
                </span>
              </div>
              <div className="zm-flow-footer">
                <span>
                  {n.reviewRequired
                    ? `${n.reviewerIds.length} ${roleMode ? '个评审角色' : '位评审人'}`
                    : '无需评审'}
                </span>
                {task.workflows.some((child) => child.parentNodeId === n.id) && (
                  <span>含子工作流 ↗</span>
                )}
              </div>
            </>
          ),
        },
        className: `zm-flow-node ${tree && parentNodes.has(n.id) ? 'zm-tree-ancestor' : ''}`,
        selected: n.id === selectedId,
      };
    });
  });
  const edges: Edge[] = flows.flatMap((w) =>
    w.nodes.flatMap((n) =>
      n.dependsOn
        .filter((source) => w.nodes.some((node) => node.id === source))
        .map((source) => ({
          id: `${source}-${n.id}`,
          source,
          target: n.id,
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--zm-edge)' },
          style: {
            stroke:
              tree && (n.id === selectedId || source === selectedId)
                ? 'var(--zm-accent)'
                : 'var(--zm-edge)',
            strokeWidth: tree && (n.id === selectedId || source === selectedId) ? 2.5 : 1.5,
          },
          ariaLabel: `工作依赖：${workTree.nodes.get(source)?.title} → ${n.title}`,
        })),
    ),
  );
  if (tree)
    for (const w of flows)
      if (w.parentNodeId)
        for (const n of w.nodes.filter((n) => !n.dependsOn.length))
          edges.push({
            id: `tree-${n.id}`,
            source: w.parentNodeId,
            target: n.id,
            label: '拆分',
            type: 'smoothstep',
            style: {
              strokeDasharray: '5 5',
              stroke: path.some((p) => p.id === w.id) ? 'var(--zm-accent)' : 'var(--zm-expert)',
              strokeWidth: path.some((p) => p.id === w.id) ? 2.5 : 1,
            },
            ariaLabel: `层级拆分：${workTree.nodes.get(w.parentNodeId)?.title} → ${n.title}`,
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
      x:
        (tree ? Math.max(40, (canvas.current?.clientWidth ?? 400) - 280) : 40) - current.position.x,
      y: Math.max(70, (canvas.current?.clientHeight ?? 500) / 2 - 70) - current.position.y,
      zoom: 1,
    });
    setZoom(1);
  }
  useEffect(() => {
    if (!fitInitially || locateRequest > 0) locate();
  }, [flow, locateRequest]);
  useEffect(() => {
    const element = canvas.current;
    if (!fitInitially || !flow || !element || initiallyFitted.current) return;
    // Native dialogs open after child effects. Fit only after their real viewport
    // and node measurements exist; never replace a user's later pan/zoom.
    let frame = 0;
    const fit = () => {
      if (!element.clientWidth || !element.clientHeight || initiallyFitted.current) return;
      if (!workflow.nodes.every((n) => dimensions[n.id])) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void flow.fitView({ padding: 0.2, maxZoom: 1 }).then((done) => {
          if (done) initiallyFitted.current = true;
        });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [flow, fitInitially, dimensions, workflow.nodes]);
  const controls = (
    <>
      <button type="button" aria-label="缩小画布" onClick={() => void flow?.zoomOut()}>
        −
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大画布" onClick={() => void flow?.zoomIn()}>
        ＋
      </button>
      <button type="button" onClick={() => locate()}>
        定位当前
      </button>
      <button type="button" onClick={() => void flow?.fitView({ padding: 0.2, maxZoom: 1 })}>
        适应全图
      </button>
    </>
  );
  return (
    <div className={`zm-canvas ${fitInitially ? 'zm-canvas-overview' : ''}`} ref={canvas}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        minZoom={0.15}
        maxZoom={1.8}
        onInit={(instance) => {
          setFlow(instance);
          if (!fitInitially) locate(instance);
        }}
        onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
        nodesDraggable={!locked && !tree}
        nodesConnectable={!locked && !tree}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        ariaLabelConfig={{
          'node.a11yDescription.default': '按回车或空格定位工作节点。',
          'node.a11yDescription.keyboardDisabled':
            '按回车或空格定位工作节点；方向键移动可编辑节点。',
          'minimap.ariaLabel': '工作流缩略图',
        }}
        onNodeClick={(_, n) => select(n.id)}
        onNodesChange={(changes) => {
          const selected = changes.find(
            (c) => c.type === 'select' && c.selected && c.id !== selectedId,
          );
          if (selected?.type === 'select') select(selected.id);
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
        {!fitInitially && (
          <Panel position="bottom-left" className="zm-canvas-controls">
            {controls}
          </Panel>
        )}
        {!fitInitially && (
          <MiniMap
            style={{ width: 130, height: 86 }}
            pannable
            zoomable
            nodeColor="var(--zm-minimap-node)"
            maskColor="var(--zm-minimap-mask)"
            bgColor="var(--zm-paper)"
          />
        )}
      </ReactFlow>
      {fitInitially && <div className="zm-canvas-controls zm-canvas-dock">{controls}</div>}
    </div>
  );
}
