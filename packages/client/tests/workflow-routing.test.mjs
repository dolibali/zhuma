import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasBounds,
  canvasNeedsSpace,
  canvasOverview,
  compactCanvasLayout,
  routeCanvasLinks,
  separateCanvasNode,
} from '../dist/workbench/workflow-routing.js';

const dependencies = [[], [0], [0, 1], [0, 1, 2], [0, 2, 3], [0, 1, 3, 4]];
const cards = () =>
  dependencies.map((_, i) => ({ id: String(i), x: i * 360, y: 0, width: 240, height: 310 }));
const links = dependencies.flatMap((sources, target) =>
  sources.map((source) => ({
    id: `${source}-${target}`,
    source: String(source),
    target: String(target),
  })),
);

function assertAvoidsCards(nodes, routes) {
  for (const [id, route] of routes) {
    assert.ok(!/NaN|Infinity/.test(route.path), id);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i];
      assert.ok(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6, `${id}: orthogonal`);
      for (const node of nodes) {
        const vertical = Math.abs(a.x - b.x) < 1e-6;
        const intersects = vertical
          ? a.x > node.x + 1e-6 &&
            a.x < node.x + node.width - 1e-6 &&
            Math.max(a.y, b.y) > node.y + 1e-6 &&
            Math.min(a.y, b.y) < node.y + node.height - 1e-6
          : a.y > node.y + 1e-6 &&
            a.y < node.y + node.height - 1e-6 &&
            Math.max(a.x, b.x) > node.x + 1e-6 &&
            Math.min(a.x, b.x) < node.x + node.width - 1e-6;
        assert.equal(intersects, false, `${id}: crosses card ${node.id}`);
      }
    }
  }
}

test('six same-row cards keep all thirteen dependencies outside card interiors', () => {
  const nodes = Object.freeze(cards().map(Object.freeze));
  const original = structuredClone(nodes);
  const routes = routeCanvasLinks(nodes, links);
  assert.equal(routes.size, 13);
  assertAvoidsCards(nodes, routes);
  for (const link of links) {
    const source = nodes.find((n) => n.id === link.source);
    const target = nodes.find((n) => n.id === link.target);
    assert.deepEqual(routes.get(link.id).points[0], { x: source.x + source.width, y: 155 });
    assert.deepEqual(routes.get(link.id).points.at(-1), { x: target.x, y: 155 });
  }
  // Long dependencies must leave the row rather than pass through intermediate cards.
  assert.ok(routes.get('0-4').points.some((p) => p.y < 0 || p.y > 310));
  const corridors = new Set(
    [...routes.values()].flatMap((r) =>
      r.points.filter((p) => p.y < 0 || p.y > 310).map((p) => p.y),
    ),
  );
  assert.ok(corridors.size > 1, 'fan-out has more than one outer corridor');
  assert.deepEqual(nodes, original, 'routing never rewrites saved positions');
});

test('fractional dragged cards, different heights, backwards and hierarchy links avoid cards', () => {
  const nodes = [
    { id: 'parent', x: 0.1, y: -73.3, width: 240, height: 193 },
    { id: 'child', x: 340.7, y: -35.1, width: 240, height: 284 },
    { id: 'later', x: 680.3, y: 150.2, width: 240, height: 160 },
    { id: 'sibling', x: 340.7, y: 470.5, width: 240, height: 217 },
  ];
  const edges = [
    { id: 'split', source: 'parent', target: 'child' },
    { id: 'cross', source: 'parent', target: 'later' },
    { id: 'back', source: 'later', target: 'child' },
    { id: 'down', source: 'parent', target: 'sibling' },
  ];
  const routes = routeCanvasLinks(nodes, edges);
  assert.equal(routes.size, edges.length);
  assertAvoidsCards(nodes, routes);
});

test('temporarily overlapping cards retain every addressable dependency', () => {
  const nodes = cards().map((node) => ({ ...node, x: 0, y: 0 }));
  const routes = routeCanvasLinks(nodes, links);
  assert.equal(routes.size, 13);
  assert.ok([...routes.values()].every((route) => !/NaN|Infinity/.test(route.path)));
});

test('untrusted 220px AI spacing is compacted using real card bounds; ports and paths remain outside every card', () => {
  for (const spacing of [220, 0, 248]) {
    const original = Object.freeze(
      dependencies.map((_, i) =>
        Object.freeze({
          id: String(i),
          x: i * spacing,
          y: 0,
          width: 240,
          height: 149.59375 + (i % 2) * 42,
        }),
      ),
    );
    assert.equal(canvasNeedsSpace(original), true);
    for (const [width, height] of [
      [620, 510],
      [1050, 600],
    ]) {
      const nodes = compactCanvasLayout(original, width, height);
      assert.equal(canvasNeedsSpace(nodes), false);
      assert.deepEqual(
        nodes.map((n) => n.id),
        original.map((n) => n.id),
      );
      const routes = routeCanvasLinks(nodes, links);
      assert.equal(routes.size, 13);
      assertAvoidsCards(nodes, routes);
      for (const link of links) {
        const source = nodes.find((n) => n.id === link.source),
          target = nodes.find((n) => n.id === link.target);
        const points = routes.get(link.id).points;
        assert.deepEqual(points[0], {
          x: source.x + source.width,
          y: source.y + source.height / 2,
        });
        assert.deepEqual(points.at(-1), { x: target.x, y: target.y + target.height / 2 });
        assert.ok(points[1].x >= points[0].x, 'exit points right');
        assert.ok(points.at(-2).x <= points.at(-1).x, 'entry points right');
      }
    }
    assert.equal(original[1].x, spacing, 'projection never changes source geometry');
  }
});

test('clear manual coordinates remain exact; an overlapping drop moves only that node to a free side', () => {
  const nodes = [
    { id: 'a', x: 0.1, y: 0.2, width: 240, height: 150 },
    { id: 'b', x: 350.3, y: 0.4, width: 240, height: 192 },
    { id: 'c', x: 0.1, y: 260.7, width: 240, height: 150 },
  ];
  assert.equal(canvasNeedsSpace(nodes), false);
  assert.equal(separateCanvasNode(nodes, 'b'), nodes);
  const covered = nodes.map((n) => (n.id === 'b' ? { ...n, x: 40.2, y: 10.3 } : n));
  const placed = separateCanvasNode(covered, 'b');
  assert.equal(canvasNeedsSpace(placed), false);
  assert.equal(placed[0], nodes[0]);
  assert.equal(placed[2], nodes[2]);
  assert.equal(separateCanvasNode(placed, 'b'), placed, 'stable after drop');
});

test('overview includes the full routed extent at narrow and wide inspector sizes', () => {
  const nodes = cards();
  const routes = routeCanvasLinks(nodes, links);
  const bounds = canvasBounds(nodes, routes.values());
  const extent = nodes
    .flatMap((n) => [n, { x: n.x + n.width, y: n.y + n.height }])
    .concat([...routes.values()].flatMap((r) => r.points));
  for (const [width, height] of [
    [900, 580],
    [1280, 640],
    [220, 180],
  ]) {
    const viewport = canvasOverview(bounds, width, height);
    assert.ok(viewport.zoom > 0 && viewport.zoom <= 1);
    for (const p of extent) {
      const x = p.x * viewport.zoom + viewport.x;
      const y = p.y * viewport.zoom + viewport.y;
      assert.ok(x > 0 && x < width && y > 0 && y < height, `clipped ${JSON.stringify(p)}`);
    }
  }
  assert.ok(bounds.y < 0 && bounds.height > 310);
  assert.equal(canvasOverview(bounds, 0, 100), undefined);
});
