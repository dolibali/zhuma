import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextPack } from '@zhuma/context';

const task = { id: 'task-1', planRevision: 2 };
const evidence = () => ({
  id: 'e-1',
  source: 'code',
  locator: 'src/example.ts',
  revision: 'abc',
  confidence: 'inferred',
  summary: 'Needs confirmation.',
});

test('binds context to task and plan revision', () => {
  const pack = createContextPack(task, [evidence()]);
  assert.equal(pack.taskId, task.id);
  assert.equal(pack.planRevision, 2);
  assert.equal(pack.evidence[0].confidence, 'inferred');
});
test('captures a snapshot instead of mutable caller data', () => {
  const item = evidence();
  const pack = createContextPack(task, [item]);
  item.summary = 'Changed later';
  assert.equal(pack.evidence[0].summary, 'Needs confirmation.');
  assert.ok(Object.isFrozen(pack.evidence[0]));
});
test('rejects ambiguous duplicate evidence identifiers', () => {
  assert.throws(() => createContextPack(task, [evidence(), evidence()]), /Duplicate evidence/);
});
test('allows an empty pack without inventing knowledge', () => {
  assert.deepEqual(createContextPack(task, []).evidence, []);
});
