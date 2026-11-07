import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
  MiniMap,
  getSmoothStepPath,
  MarkerType,
  Position,
  type Node,
  type Edge,
  type Connection,
  type ReactFlowInstance,
  type EdgeProps,
} from '@xyflow/react';
import type { WorkTask, Workflow, Participant } from '@zhuma/agent-core';
import { NODE_STATUS_LABELS } from '../execution-view.js';
import type { FlowNodeMark } from '../execution/progress-focus.js';
import { visibleWorkflows, workflowPath, type WorkTree } from './navigation.js';
import { NodeStatusMark } from './NodeStatusMark.js';
import { transitiveDependencies } from './workflow-sequence.js';
import {
  canvasBounds,
  canvasOverview,
  routeCanvasLinks,
  type CanvasRoute,
} from './workflow-routing.js';

type RoutedEdge = Edge<{ route: CanvasRoute | undefined }>;

function DependencyEdge(props: EdgeProps<RoutedEdge>) {
  const route = props.data?.route;
  const [path, labelX, labelY] = route
    ? ([route.path, route.label.x, route.label.y] as const)
    : getSmoothStepPath(props);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
      label={props.label}
      labelX={labelX}
      labelY={labelY}
      {...(props.labelStyle ? { labelStyle: props.labelStyle } : {})}
      {...(props.labelBgStyle ? { labelBgStyle: props.labelBgStyle } : {})}
    />
  );
}
const edgeTypes = { dependency: DependencyEdge };

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
  marks,
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
  marks?: ReadonlyMap<string, FlowNodeMark> | undefined;
}) {
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<Node, RoutedEdge> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [allDependencies, setAllDependencies] = useState(false);
  const implied = useMemo(() => (tree ? null : transitiveDependencies(workflow)), [tree, workflow]);
  const viewportMode = useRef<'overview' | 'manual' | 'located'>('overview');
  const handledLocate = useRef(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
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
      const mark = marks?.get(n.id);
      const statusLabel = mark
        ? mark.executing || mark.status === 'running'
          ? '执行中'
          : NODE_STATUS_LABELS[mark.status]
        : '';
      return {
        id: n.id,
        initialWidth: 240,
        initialHeight: 164,
        ...(dimensions[n.id] ? { measured: dimensions[n.id] } : {}),
        position: tree ? { x: level * 340, y: offset + index * 210 } : n.position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        ariaLabel: `${n.title}，${w.name}${statusLabel ? `，${statusLabel}` : ''}`,
        data: {
          label: (
            <>
              <NodeStatusMark status={mark?.status} executing={mark?.executing === true} />
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
        className: `zm-flow-node${mark ? ' zm-flow-node-status' : ''} ${tree && parentNodes.has(n.id) ? 'zm-tree-ancestor' : ''}`,
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
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color:
              n.id === selectedId || source === selectedId ? 'var(--zm-accent)' : 'var(--zm-edge)',
          },
          style: {
            stroke:
              n.id === selectedId || source === selectedId ? 'var(--zm-accent)' : 'var(--zm-edge)',
            strokeWidth: n.id === selectedId || source === selectedId ? 2.5 : 1.7,
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
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: path.some((p) => p.id === w.id) ? 'var(--zm-accent)' : 'var(--zm-expert)',
            },
            style: {
              strokeDasharray: '5 5',
              stroke: path.some((p) => p.id === w.id) ? 'var(--zm-accent)' : 'var(--zm-expert)',
              strokeWidth: path.some((p) => p.id === w.id) ? 2.5 : 1,
            },
            ariaLabel: `层级拆分：${workTree.nodes.get(w.parentNodeId)?.title} → ${n.title}`,
            labelStyle: { fill: 'var(--zm-muted)', fontSize: 12 },
            labelBgStyle: { fill: 'var(--zm-paper)' },
          });
  const sequenceEdges = implied?.size
    ? edges.filter((edge) => !implied.get(edge.target)?.has(edge.source))
    : edges;
  const visibleEdges = allDependencies ? edges : sequenceEdges;
  // Selection/status labels do not change geometry; the view decides which links need routing.
  const routing = useMemo(() => {
    const geometry = nodes.map((node) => ({
      id: node.id,
      ...node.position,
      width: dimensions[node.id]?.width ?? 240,
      height: dimensions[node.id]?.height ?? 164,
    }));
    const routes = routeCanvasLinks(geometry, visibleEdges);
    return { routes, bounds: canvasBounds(geometry, routes.values()) };
  }, [workflow, tree, workTree, expanded, dimensions, allDependencies]);
  const renderedEdges: RoutedEdge[] = visibleEdges.map((edge) => ({
    ...edge,
    type: 'dependency',
    data: { route: routing.routes.get(edge.id) },
  }));
  const overview = useMemo(
    () => canvasOverview(routing.bounds, size.width, size.height),
    [routing.bounds, size],
  );
  const measured = nodes.every((node) => dimensions[node.id]);
  function connect(connection: Connection) {
    if (
      locked ||
      tree ||
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    // Keep a newly drawn explicit edge visible even if there is already an indirect path.
    setAllDependencies(true);
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
    viewportMode.current = 'located';
    void instance.setViewport({
      x: size.width / 2 - current.position.x - (dimensions[current.id]?.width ?? 240) / 2,
      y: size.height / 2 - current.position.y - (dimensions[current.id]?.height ?? 164) / 2,
      zoom: 1,
    });
    setZoom(1);
  }
  useEffect(() => {
    if (!flow || !measured || locateRequest <= 0 || handledLocate.current === locateRequest) return;
    handledLocate.current = locateRequest;
    locate();
  }, [flow, locateRequest, measured]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth,
        height = element.clientHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!flow || !measured || !overview || viewportMode.current !== 'overview') return;
    const frame = requestAnimationFrame(() => {
      if (viewportMode.current === 'overview') void flow.setViewport(overview);
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, measured, overview]);
  function fitAll() {
    viewportMode.current = 'overview';
    if (flow && overview) void flow.setViewport(overview);
  }
  function zoomBy(direction: 'in' | 'out') {
    viewportMode.current = 'manual';
    if (direction === 'in') void flow?.zoomIn();
    else void flow?.zoomOut();
  }
  const controls = (
    <>
      <button type="button" aria-label="缩小画布" onClick={() => zoomBy('out')}>
        −
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大画布" onClick={() => zoomBy('in')}>
        ＋
      </button>
      <button type="button" onClick={() => locate()}>
        定位当前
      </button>
      <button type="button" onClick={fitAll}>
        适应全图
      </button>
    </>
  );
  return (
    <ReactFlowProvider>
      <div className={`zm-canvas ${fitInitially ? 'zm-canvas-overview' : ''}`}>
        <div className="zm-canvas-surface" ref={canvas}>
          <ReactFlow
            nodes={nodes}
            edges={renderedEdges}
            edgeTypes={edgeTypes}
            minZoom={Math.min(0.15, overview?.zoom ?? 0.15)}
            maxZoom={1.8}
            onInit={(instance) => {
              setFlow(instance);
            }}
            onMoveStart={(event) => {
              if (event) viewportMode.current = 'manual';
            }}
            onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
            onNodeDragStart={() => {
              viewportMode.current = 'manual';
            }}
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
              if (positions.size) viewportMode.current = 'manual';
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
          </ReactFlow>
        </div>
        <div className="zm-canvas-controls zm-canvas-dock" role="toolbar" aria-label="工作流视图">
          <div className="zm-canvas-actions">
            {controls}
            {sequenceEdges.length < edges.length ? (
              <div className="zm-dependency-views" role="group" aria-label="显示连线">
                <button
                  type="button"
                  aria-pressed={!allDependencies}
                  title="显示决定执行先后的连线，保留分支与汇合"
                  onClick={() => setAllDependencies(false)}
                >
                  执行顺序 <span>{sequenceEdges.length}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={allDependencies}
                  title="显示每个节点明确指定的所有前置依赖"
                  onClick={() => setAllDependencies(true)}
                >
                  全部依赖 <span>{edges.length}</span>
                </button>
              </div>
            ) : (
              <span>{edges.length} 条连线</span>
            )}
          </div>
          {!fitInitially && (
            <div
              className="zm-canvas-map"
              onPointerDownCapture={() => {
                viewportMode.current = 'manual';
              }}
              onWheelCapture={() => {
                viewportMode.current = 'manual';
              }}
            >
              <MiniMap
                style={{ width: 112, height: 64 }}
                pannable
                zoomable
                nodeColor="var(--zm-minimap-node)"
                maskColor="var(--zm-minimap-mask)"
                bgColor="var(--zm-paper)"
              />
            </div>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
