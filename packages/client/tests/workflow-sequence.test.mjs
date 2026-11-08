import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transitiveDependencies } from '../dist/workbench/workflow-sequence.js';

const graph = (entries) => ({
  id: 'demo',
  nodes: entries.map(([id, ...dependsOn]) => ({ id, title: id, dependsOn })),
});

test('the engineering template has five ordering edges and retains all thirteen explicit inputs', () => {
  const template = JSON.parse(
    readFileSync(
      new URL(
        '../../../resources/workflows/engineering-starter/requirements-to-code.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const workflow = template.workflows[0];
  const saved = structuredClone(workflow);
  const implied = transitiveDependencies(workflow);
  const visible = workflow.nodes.map((n) => n.dependsOn.filter((p) => !implied.get(n.id)?.has(p)));
  assert.deepEqual(visible, [
    [],
    ['requirements'],
    ['design'],
    ['implement'],
    ['verify'],
    ['review'],
  ]);
  assert.equal(workflow.nodes.flatMap((n) => n.dependsOn).length, 13);
  assert.deepEqual(workflow, saved);
});

test('independent branches, joins and disconnected components survive in arbitrary node order', () => {
  const workflow = graph([
    ['done', 'a', 'b', 'c', 'join', 'extra'],
    ['b', 'a'],
    ['join', 'b', 'c'],
    ['extra'],
    ['a'],
    ['c', 'a'],
  ]);
  assert.deepEqual(transitiveDependencies(workflow), new Map([['done', new Set(['a', 'b', 'c'])]]));
});

test('cyclic, missing-parent and duplicate-node drafts keep all explicit dependencies visible', () => {
  for (const entries of [
    [
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'a', 'b'],
    ],
    [['a'], ['b', 'a'], ['c', 'a', 'b', 'missing']],
    [['a'], ['a'], ['b', 'a'], ['c', 'a', 'b']],
  ])
    assert.equal(transitiveDependencies(graph(entries)).size, 0);
});
