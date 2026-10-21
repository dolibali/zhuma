import assert from 'node:assert/strict';
import test from 'node:test';
import { selectExecutor } from '@zhuma/dsh-adapter';

const executor = (engine) => ({
  engine,
  execute: async () => ({ status: 'completed', summary: 'contract test only' }),
});

test('selects the explicitly configured engine', () => {
  const native = executor('dsh');
  const external = executor('codearts-cli');
  assert.equal(selectExecutor('codearts-cli', [native, external]), external);
});
test('does not silently fall back from unavailable external executor', () => {
  assert.throws(() => selectExecutor('codearts-cli', [executor('dsh')]), /not configured/);
});
test('rejects ambiguous duplicate bindings', () => {
  assert.throws(() => selectExecutor('dsh', [executor('dsh'), executor('dsh')]), /more than once/);
});
test('selecting an executor does not execute a task', () => {
  let calls = 0;
  const native = {
    engine: 'dsh',
    execute: async () => {
      calls += 1;
      return { status: 'cancelled', reason: 'test' };
    },
  };
  assert.equal(selectExecutor('dsh', [native]), native);
  assert.equal(calls, 0);
});
