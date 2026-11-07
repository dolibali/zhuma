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
  canvasNeedsSpace,
  canvasOverview,
  compactCanvasLayout,
  routeCanvasLinks,
  separateCanvasNode,
  type CanvasNode,
  type CanvasPoint,
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
const positionKey = (workflow: Workflow) =>
  JSON.stringify([
    workflow.id,
    workflow.nodes.map((node) => [node.id, node.position.x, node.position.y]),
  ]);

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
  const implied = useMemo(
    () =>
      new Map(
        (tree ? visibleWorkflows(workTree, expanded) : [workflow]).flatMap((flow) => [
          ...transitiveDependencies(flow),
        ]),
      ),
    [tree, workflow, workTree, expanded],
  );
  const viewportMode = useRef<'overview' | 'manual' | 'located'>('overview');
  const handledLocate = useRef(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dimensions, setDimensions] = useState<
    ReadonlyMap<string, { width: number; height: number }>
  >(() => new Map());
  const [manualPositions, setManualPositions] = useState<string>();
  const [viewPositions, setViewPositions] = useState<{
    key: string;
    positions: ReadonlyMap<string, CanvasPoint>;
  }>();
  const path = workflowPath(workTree, workflow.id);
  const parentNodes = new Set(path.flatMap((w) => (w.parentNodeId ? [w.parentNodeId] : [])));
  const flows = tree ? visibleWorkflows(workTree, expanded) : [workflow];
  const geometryKey = positionKey(workflow);
  const geometry = useMemo(() => {
    if (tree) {
      // A workflow stays inside its hierarchy column. Compact its own nodes
      // instead of making every root step another full-height tree row.
      const depth = Math.max(1, ...flows.map((w) => workflowPath(workTree, w.id).length));
      const availableWidth = Math.max(240, ((size.width || 900) - (depth - 1) * 80) / depth + 64);
      const groups = flows.map((w) => ({
        level: workflowPath(workTree, w.id).length - 1,
        nodes: compactCanvasLayout(
          w.nodes.map((node) => ({
            id: node.id,
            x: 0,
            y: 0,
            ...(dimensions.get(node.id) ?? { width: 200, height: 128 }),
          })),
          availableWidth,
          size.height || 600,
          48,
        ),
      }));
      const widths = Array.from({ length: depth }, (_, level) =>
        Math.max(
          0,
          ...groups
            .filter((group) => group.level === level)
            .flatMap((group) => group.nodes.map((node) => node.x + node.width)),
        ),
      );
      const xs = [0],
        offsets = Array.from({ length: depth }, () => 0);
      for (let level = 1; level < depth; level++) xs.push(xs[level - 1]! + widths[level - 1]! + 80);
      return groups.flatMap((group) => {
        const offset = offsets[group.level]!;
        const nodes = group.nodes.map((node) => ({
          ...node,
          x: node.x + xs[group.level]!,
          y: node.y + offset,
        }));
        offsets[group.level] =
          offset + Math.max(0, ...group.nodes.map((node) => node.y + node.height)) + 80;
        return nodes;
      });
    }
    const original: CanvasNode[] = flows.flatMap((w) => {
      const result = w.nodes.map((node) => {
        const measured = dimensions.get(node.id) ?? { width: 240, height: 164 };
        const position =
          viewPositions?.key === geometryKey
            ? (viewPositions.positions.get(node.id) ?? node.position)
            : node.position;
        return {
          id: node.id,
          ...measured,
          x: position.x,
          y: position.y,
        };
      });
      return result;
    });
    return !tree &&
      manualPositions !== geometryKey &&
      viewPositions?.key !== geometryKey &&
      canvasNeedsSpace(original)
      ? compactCanvasLayout(original, size.width, size.height)
      : original;
  }, [workflow, tree, workTree, expanded, dimensions, size, manualPositions, viewPositions]);
  const positions = new Map(geometry.map((node) => [node.id, { x: node.x, y: node.y }]));
  const nodes: Node[] = flows.flatMap((w) => {
    return w.nodes.map((n) => {
      const member = members.find((m) => m.id === n.assigneeId);
      const mark = marks?.get(n.id);
      const statusLabel = mark
        ? mark.executing || mark.status === 'running'
          ? '执行中'
          : NODE_STATUS_LABELS[mark.status]
        : '';
      return {
        id: n.id,
        initialWidth: tree ? 200 : 240,
        initialHeight: tree ? 128 : 164,
        ...(dimensions.has(n.id) ? { measured: dimensions.get(n.id)! } : {}),
        position: positions.get(n.id)!,
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
        className: `zm-flow-node${tree ? ' zm-flow-tree' : ''}${mark ? ' zm-flow-node-status' : ''} ${tree && parentNodes.has(n.id) ? 'zm-tree-ancestor' : ''}`,
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
    const routes = routeCanvasLinks(geometry, visibleEdges);
    return { routes, bounds: canvasBounds(geometry, routes.values()) };
  }, [geometry, workflow, tree, workTree, expanded, allDependencies]);
  const renderedEdges: RoutedEdge[] = visibleEdges.map((edge) => ({
    ...edge,
    type: 'dependency',
    data: { route: routing.routes.get(edge.id) },
  }));
  const overview = useMemo(
    () => canvasOverview(routing.bounds, size.width, size.height),
    [routing.bounds, size],
  );
  const measured = nodes.every((node) => dimensions.has(node.id));
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
      x: size.width / 2 - current.position.x - (dimensions.get(current.id)?.width ?? 240) / 2,
      y: size.height / 2 - current.position.y - (dimensions.get(current.id)?.height ?? 164) / 2,
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
  function arrange() {
    const arranged = compactCanvasLayout(geometry, size.width, size.height);
    const arrangedPositions = new Map(arranged.map((node) => [node.id, { x: node.x, y: node.y }]));
    viewportMode.current = 'overview';
    if (locked) {
      setViewPositions({ key: geometryKey, positions: arrangedPositions });
    } else {
      const next = {
        ...workflow,
        nodes: workflow.nodes.map((node) => ({
          ...node,
          position: arrangedPositions.get(node.id)!,
        })),
      };
      setManualPositions(positionKey(next));
      setViewPositions(undefined);
      change(next);
    }
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
      {!tree && (
        <button type="button" onClick={arrange} disabled={!nodes.length}>
          整理布局
        </button>
      )}
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
                  const next = new Map(current);
                  let changed = false;
                  for (const change of measured)
                    if (
                      change.type === 'dimensions' &&
                      change.dimensions &&
                      (next.get(change.id)?.width !== change.dimensions.width ||
                        next.get(change.id)?.height !== change.dimensions.height)
                    ) {
                      next.set(change.id, change.dimensions);
                      changed = true;
                    }
                  return changed ? next : current;
                });
              if (locked || tree) return;
              const moved = new Map(
                changes.flatMap((c) =>
                  c.type === 'position' && c.position ? [[c.id, c.position] as const] : [],
                ),
              );
              if (moved.size) {
                viewportMode.current = 'manual';
                let placed: readonly CanvasNode[] = geometry.map((node) => {
                  const position = moved.get(node.id);
                  return position ? { ...node, x: position.x, y: position.y } : node;
                });
                if (!changes.some((c) => c.type === 'position' && c.dragging))
                  for (const id of moved.keys()) placed = separateCanvasNode(placed, id);
                const dropped = new Map(placed.map((node) => [node.id, { x: node.x, y: node.y }]));
                // A deliberate drag saves the geometry the user actually saw,
                // including repaired peers, rather than hidden AI collisions.
                const next = {
                  ...workflow,
                  nodes: workflow.nodes.map((n) => ({
                    ...n,
                    position: dropped.get(n.id)!,
                  })),
                };
                setManualPositions(positionKey(next));
                setViewPositions(undefined);
                change(next);
              }
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
