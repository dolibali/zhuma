import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWorkTask } from '@zhuma/agent-core';
import {
  indexWorkTree,
  workflowPath,
  resolveWorkLocation,
  visibleWorkflows,
  nodeRelations,
} from '../dist/workbench/navigation.js';
import { treeFixture } from '../../../tests/fixtures/workbench-tree.mjs';

test('three-level planning fixture is legal and preserves parallel branches', () => {
  const state = treeFixture();
  assert.deepEqual(validateWorkTask({ ...state.tasks[0], status: 'ready' }, state), []);
  const tree = indexWorkTree(state.tasks[0]);
  assert.deepEqual(
    workflowPath(tree, 'tree-export').map((w) => w.id),
    ['tree-root', 'tree-orders', 'tree-export'],
  );
  assert.deepEqual(
    nodeRelations(tree, 'summary').before.map((n) => n.id),
    ['exceptions', 'cases'],
  );
  assert.deepEqual(
    nodeRelations(tree, 'mapping').after.map((n) => n.id),
    ['exceptions', 'cases'],
  );
  assert.equal(visibleWorkflows(tree, new Set(['tree-orders', 'tree-export'])).length, 3);
  assert.deepEqual(state, treeFixture(), 'Indexing and navigating cannot mutate task data');
});

test('navigation restores per-layer selections and falls back to the nearest surviving ancestor', () => {
  const task = treeFixture().tasks[0];
  const memory = new Map([
    ['tree-root', 'orders'],
    ['tree-orders', 'export'],
    ['tree-export', 'exceptions'],
  ]);
  assert.deepEqual(
    resolveWorkLocation(indexWorkTree(task), { workflowId: 'tree-export', nodeId: null }, memory),
    { workflowId: 'tree-export', nodeId: 'exceptions' },
  );
  task.workflows = task.workflows.filter((w) => w.id !== 'tree-export');
  assert.deepEqual(
    resolveWorkLocation(
      indexWorkTree(task),
      { workflowId: 'tree-export', nodeId: 'exceptions' },
      memory,
      ['tree-root', 'tree-orders', 'tree-export'],
    ),
    { workflowId: 'tree-orders', nodeId: 'export' },
  );
  task.workflows.find((w) => w.id === 'tree-orders').nodes = [];
  assert.deepEqual(
    resolveWorkLocation(
      indexWorkTree(task),
      { workflowId: 'tree-orders', nodeId: 'export' },
      memory,
    ),
    { workflowId: 'tree-orders', nodeId: null },
  );
});

test('missing parents, disconnected cycles and cross-workflow references expose no phantom content', () => {
  const task = treeFixture().tasks[0];
  const foreign = {
    ...structuredClone(task.workflows[0].nodes[0]),
    id: 'hidden-node',
    title: 'NOT_VISIBLE',
  };
  task.workflows.push({
    id: 'orphan',
    name: 'NOT_VISIBLE',
    parentNodeId: 'absent-parent',
    nodes: [foreign],
  });
  task.workflows.push({
    id: 'cycle',
    name: 'NOT_VISIBLE',
    parentNodeId: 'cycle-node',
    nodes: [{ ...foreign, id: 'cycle-node' }],
  });
  task.workflows[0].nodes[0].dependsOn.push('hidden-node', 'mapping');
  const tree = indexWorkTree(task);
  assert.equal(tree.workflows.size, 4);
  assert.equal(tree.nodes.size, 14);
  assert.deepEqual(workflowPath(tree, 'orphan'), []);
  assert.deepEqual(nodeRelations(tree, 'goal').before, []);
  assert.deepEqual(
    resolveWorkLocation(tree, { workflowId: 'foreign-task', nodeId: 'hidden-node' }, new Map()),
    { workflowId: 'tree-root', nodeId: 'goal' },
  );
});
