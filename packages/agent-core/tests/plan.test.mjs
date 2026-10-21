import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '@zhuma/agent-core';

const step = (id, dependsOn = []) => ({ id, label: id, kind: 'agent', dependsOn });
const plan = (steps, revision = 1) => ({ id: 'plan-1', revision, steps });

test('accepts a valid dependency graph without changing input', () => {
  const value = plan([step('read'), step('implement', ['read']), step('verify', ['implement'])]);
  const before = structuredClone(value);
  assert.deepEqual(validatePlan(value), []);
  assert.deepEqual(value, before);
});
test('rejects an empty plan', () => {
  assert.equal(validatePlan(plan([]))[0].code, 'empty-plan');
});
test('requires a positive plan revision', () => {
  assert.equal(validatePlan(plan([step('a')], 0))[0].code, 'invalid-revision');
});
test('detects duplicate step identifiers', () => {
  assert.ok(validatePlan(plan([step('a'), step('a')])).some((i) => i.code === 'duplicate-step'));
});
test('does not accept unresolved dependencies', () => {
  assert.ok(
    validatePlan(plan([step('a', ['missing'])])).some((i) => i.code === 'unknown-dependency'),
  );
});
test('detects a cycle', () => {
  assert.ok(
    validatePlan(plan([step('a', ['b']), step('b', ['a'])])).some((i) => i.code === 'cycle'),
  );
});
test('detects self-dependency', () => {
  assert.ok(validatePlan(plan([step('a', ['a'])])).some((i) => i.code === 'cycle'));
});
test('supports a diamond and repeated dependency references', () => {
  assert.deepEqual(
    validatePlan(plan([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c', 'b'])])),
    [],
  );
});
