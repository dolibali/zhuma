/** Pure presentation geometry; callers decide whether an explicit edit saves positions. */
export type CanvasPoint = Readonly<{ x: number; y: number }>;
export type CanvasRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CanvasNode = CanvasRect & { readonly id: string };
export type CanvasLink = Readonly<{ id: string; source: string; target: string }>;
export type CanvasRoute = Readonly<{
  points: readonly CanvasPoint[];
  path: string;
  label: CanvasPoint;
}>;

const inset = (r: CanvasRect, padding: number): CanvasRect => ({
  x: r.x - padding,
  y: r.y - padding,
  width: r.width + padding * 2,
  height: r.height + padding * 2,
});
const middle = (r: CanvasRect) => r.y + r.height / 2;
const sorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const inside = (value: number, start: number, length: number) =>
  value > start + 1e-7 && value < start + length - 1e-7;
const segmentKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
const crowded = (a: CanvasRect, b: CanvasRect, clearance: number) =>
  a.x < b.x + b.width + clearance &&
  b.x < a.x + a.width + clearance &&
  a.y < b.y + b.height + clearance &&
  b.y < a.y + a.height + clearance;

/** Ports need a corridor too: disjoint cards with an 8px gap still cover the
 * router's padded exit/entry. Healthy hand-positioned layouts pass unchanged. */
export function canvasNeedsSpace(nodes: readonly CanvasNode[], clearance = 48): boolean {
  return nodes.some((a, index) => nodes.slice(index + 1).some((b) => crowded(a, b, clearance)));
}

/** A drop that covers another card moves only the dropped card to the closest
 * free side. Clear manual coordinates, including fractions, remain exact. */
export function separateCanvasNode(
  nodes: readonly CanvasNode[],
  id: string,
): readonly CanvasNode[] {
  const node = nodes.find((n) => n.id === id);
  const others = nodes.filter((n) => n.id !== id);
  if (!node || !others.some((other) => crowded(node, other, 48))) return nodes;
  const candidates = others
    .flatMap((other) => [
      { ...node, x: other.x - node.width - 72 },
      { ...node, x: other.x + other.width + 72 },
      { ...node, y: other.y - node.height - 72 },
      { ...node, y: other.y + other.height + 72 },
    ])
    .filter((candidate) => others.every((other) => !crowded(candidate, other, 48)));
  candidates.sort(
    (a, b) =>
      (a.x - node.x) ** 2 + (a.y - node.y) ** 2 - ((b.x - node.x) ** 2 + (b.y - node.y) ** 2),
  );
  const free = candidates[0];
  return free ? nodes.map((n) => (n.id === id ? free : n)) : nodes;
}

/** Compact only an untrusted/colliding initial layout, or an explicit arrange
 * action. Keep node order and identity; never infer or change dependencies. */
export function compactCanvasLayout(
  nodes: readonly CanvasNode[],
  width: number,
  height: number,
  gap = 72,
): readonly CanvasNode[] {
  if (!nodes.length) return nodes;
  const availableWidth = Math.max(1, (width || 900) - 64);
  const availableHeight = Math.max(1, (height || 600) - 64);
  const origin = { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) };
  let best: CanvasNode[] = [],
    bestScore = -Infinity;
  for (let columns = 1; columns <= nodes.length; columns++) {
    const rows = Math.ceil(nodes.length / columns);
    const widths = Array.from({ length: columns }, () => 0);
    const heights = Array.from({ length: rows }, () => 0);
    nodes.forEach((node, index) => {
      const column = index % columns,
        row = Math.floor(index / columns);
      widths[column] = Math.max(widths[column]!, node.width);
      heights[row] = Math.max(heights[row]!, node.height);
    });
    const totalWidth = widths.reduce((a, b) => a + b, 0) + (columns - 1) * gap;
    const totalHeight = heights.reduce((a, b) => a + b, 0) + (rows - 1) * gap;
    // Prefer readable labels; among equally readable arrangements, fewer rows
    // keep ordinary short workflows flowing left to right.
    const score =
      Math.min(1, availableWidth / totalWidth, availableHeight / totalHeight) - rows * 1e-5;
    if (score <= bestScore) continue;
    bestScore = score;
    const xs = [origin.x],
      ys = [origin.y];
    for (let i = 1; i < columns; i++) xs.push(xs[i - 1]! + widths[i - 1]! + gap);
    for (let i = 1; i < rows; i++) ys.push(ys[i - 1]! + heights[i - 1]! + gap);
    best = nodes.map((node, index) => ({
      ...node,
      x: xs[index % columns]!,
      y: ys[Math.floor(index / columns)]!,
    }));
  }
  return best;
}

export function canvasBounds(
  nodes: readonly CanvasNode[],
  routes: Iterable<CanvasRoute>,
): CanvasRect {
  const points = nodes.flatMap((r) => [r, { x: r.x + r.width, y: r.y + r.height }]);
  for (const route of routes) points.push(...route.points);
  if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  return inset(
    {
      x: left,
      y: top,
      width: Math.max(1, Math.max(...points.map((p) => p.x)) - left),
      height: Math.max(1, Math.max(...points.map((p) => p.y)) - top),
    },
    16,
  );
}

export function canvasOverview(bounds: CanvasRect, width: number, height: number) {
  if (width <= 0 || height <= 0) return undefined;
  const padding = Math.min(32, width / 8, height / 8);
  const zoom = Math.min(
    1,
    (width - padding * 2) / bounds.width,
    (height - padding * 2) / bounds.height,
  );
  return {
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

type QueueItem = { state: number; cost: number; priority: number };
class RouteQueue {
  private readonly items: QueueItem[] = [];
  push(item: QueueItem) {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]!.priority <= item.priority) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = item;
  }
  pop(): QueueItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (
        child + 1 < this.items.length &&
        this.items[child + 1]!.priority < this.items[child]!.priority
      )
        child++;
      if (last.priority <= this.items[child]!.priority) break;
      this.items[index] = this.items[child]!;
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

/** Rectangle-boundary visibility grid, shared by every edge in this layout.
 * Row/column interval sweeps keep construction quadratic rather than checking
 * every grid segment against every card. */
function routingGrid(nodes: readonly CanvasNode[], padding: number, lanes: number) {
  const obstacles = nodes.map((node) => inset(node, padding));
  const bounds = canvasBounds(nodes, []);
  const rails = Array.from({ length: lanes }, (_, i) => (i + 1) * 12 + padding);
  const xs = sorted([
    ...obstacles.flatMap((r) => [r.x, r.x + r.width]),
    ...rails.flatMap((gap) => [bounds.x - gap, bounds.x + bounds.width + gap]),
  ]);
  const ys = sorted([
    ...obstacles.flatMap((r) => [r.y, r.y + r.height]),
    ...nodes.map(middle),
    ...rails.flatMap((gap) => [bounds.y - gap, bounds.y + bounds.height + gap]),
  ]);
  const columns = xs.length;
  const xIndex = new Map(xs.map((x, i) => [x, i]));
  const yIndex = new Map(ys.map((y, i) => [y, i]));
  const free = new Uint8Array(columns * ys.length);
  const right = new Uint8Array(free.length);
  const down = new Uint8Array(free.length);
  const mark = (diff: Int32Array, start: number, end: number) => {
    if (start >= end) return;
    diff[start] = diff[start]! + 1;
    diff[end] = diff[end]! - 1;
  };
  for (const [row, y] of ys.entries()) {
    const points = new Int32Array(columns + 1);
    const segments = new Int32Array(columns + 1);
    for (const r of obstacles) {
      if (!inside(y, r.y, r.height)) continue;
      const left = xIndex.get(r.x)!;
      const end = xIndex.get(r.x + r.width)!;
      mark(points, left + 1, end);
      mark(segments, left, end);
    }
    let pointCount = 0,
      segmentCount = 0;
    for (let column = 0; column < columns; column++) {
      pointCount += points[column]!;
      segmentCount += segments[column]!;
      const index = row * columns + column;
      free[index] = pointCount === 0 ? 1 : 0;
      right[index] = segmentCount === 0 && column + 1 < columns ? 1 : 0;
    }
  }
  for (const [column, x] of xs.entries()) {
    const segments = new Int32Array(ys.length + 1);
    for (const r of obstacles)
      if (inside(x, r.x, r.width)) mark(segments, yIndex.get(r.y)!, yIndex.get(r.y + r.height)!);
    let count = 0;
    for (let row = 0; row < ys.length; row++) {
      count += segments[row]!;
      down[row * columns + column] = count === 0 && row + 1 < ys.length ? 1 : 0;
    }
  }
  const point = (index: number): CanvasPoint => ({
    x: xs[index % columns]!,
    y: ys[Math.floor(index / columns)]!,
  });
  const used = new Map<string, number>();
  const coordinateIndex = (
    lookup: ReadonlyMap<number, number>,
    values: readonly number[],
    value: number,
  ) => lookup.get(value) ?? values.findIndex((candidate) => Math.abs(candidate - value) < 1e-6);
  function route(source: CanvasPoint, target: CanvasPoint): CanvasPoint[] | undefined {
    const sx = coordinateIndex(xIndex, xs, source.x),
      sy = coordinateIndex(yIndex, ys, source.y);
    const tx = coordinateIndex(xIndex, xs, target.x),
      ty = coordinateIndex(yIndex, ys, target.y);
    if ([sx, sy, tx, ty].some((index) => index < 0)) return undefined;
    const start = sy * columns + sx;
    const end = ty * columns + tx;
    if (!free[start] || !free[end]) return undefined;
    const costs = new Map<number, number>();
    const previous = new Map<number, number>();
    const queue = new RouteQueue();
    for (const state of [start * 2, start * 2 + 1]) {
      costs.set(state, 0);
      queue.push({ state, cost: 0, priority: 0 });
    }
    let current: QueueItem | undefined;
    while ((current = queue.pop())) {
      if (costs.get(current.state) !== current.cost) continue;
      const index = Math.floor(current.state / 2);
      if (index === end) {
        const indices: number[] = [];
        let state: number | undefined = current.state;
        while (state !== undefined) {
          indices.push(Math.floor(state / 2));
          state = previous.get(state);
        }
        indices.reverse();
        for (let i = 1; i < indices.length; i++) {
          const key = segmentKey(indices[i - 1]!, indices[i]!);
          used.set(key, (used.get(key) ?? 0) + 1);
        }
        return indices.map(point);
      }
      const from = point(index);
      const candidates = [
        ...(index % columns > 0 && right[index - 1] ? [[index - 1, 0]] : []),
        ...(right[index] ? [[index + 1, 0]] : []),
        ...(index >= columns && down[index - columns] ? [[index - columns, 1]] : []),
        ...(down[index] ? [[index + columns, 1]] : []),
      ];
      for (const [next, direction] of candidates) {
        if (next === undefined || direction === undefined || !free[next]) continue;
        const to = point(next);
        const distance = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
        const cost =
          current.cost +
          distance * (1 + (used.get(segmentKey(index, next)) ?? 0) * 3) +
          (current.state % 2 === direction ? 0 : 24);
        const state = next * 2 + direction;
        if (cost >= (costs.get(state) ?? Infinity)) continue;
        costs.set(state, cost);
        previous.set(state, current.state);
        queue.push({
          state,
          cost,
          priority: cost + Math.abs(to.x - target.x) + Math.abs(to.y - target.y),
        });
      }
    }
    return undefined;
  }
  return { route };
}

function simplify(points: readonly CanvasPoint[]): CanvasPoint[] {
  const result: CanvasPoint[] = [];
  for (const p of points) {
    const last = result.at(-1);
    if (last?.x === p.x && last.y === p.y) continue;
    const before = result.at(-2);
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))
    )
      result.pop();
    result.push(p);
  }
  return result;
}

function describeRoute(points: CanvasPoint[], radius: number): CanvasRoute {
  let path = `M ${points[0]!.x} ${points[0]!.y}`;
  let longest = -1;
  let label = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      c = points[i + 1];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (length > longest) {
      longest = length;
      label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    const r = c ? Math.min(radius, length / 2, (Math.abs(c.x - b.x) + Math.abs(c.y - b.y)) / 2) : 0;
    if (!r || !c) {
      path += ` L ${b.x} ${b.y}`;
      continue;
    }
    const before = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const after = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return { points, path, label };
}

export function routeCanvasLinks(nodes: readonly CanvasNode[], links: readonly CanvasLink[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grids = new Map<number, ReturnType<typeof routingGrid>>();
  const result = new Map<string, CanvasRoute>();
  const bounds = canvasBounds(nodes, []);
  for (const [index, link] of links.entries()) {
    const source = byId.get(link.source),
      target = byId.get(link.target);
    if (!source || !target) continue;
    const start = { x: source.x + source.width, y: middle(source) };
    const end = { x: target.x, y: middle(target) };
    let routed = false;
    for (const padding of [18, 8, 0]) {
      let grid = grids.get(padding);
      if (!grid) {
        grid = routingGrid(nodes, padding, Math.min(8, Math.max(2, links.length)));
        grids.set(padding, grid);
      }
      const points = grid.route(
        { x: start.x + padding, y: start.y },
        { x: end.x - padding, y: end.y },
      );
      if (!points) continue;
      result.set(
        link.id,
        describeRoute(simplify([start, ...points, end]), Math.min(6, padding / 2)),
      );
      routed = true;
      break;
    }
    // Overlapping cards can physically cover their own ports. Keep the real
    // dependency visible and addressable even while the user drags them apart.
    if (!routed) {
      const top = bounds.y - 30 - (index % 8) * 12;
      result.set(
        link.id,
        describeRoute(
          simplify([
            start,
            { x: start.x + 18, y: start.y },
            { x: start.x + 18, y: top },
            { x: end.x - 18, y: top },
            { x: end.x - 18, y: end.y },
            end,
          ]),
          0,
        ),
      );
    }
  }
  return result;
}
