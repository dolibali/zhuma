import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { loadPromptConstraints } from '@zhuma/agent-core';
import { taskPrompt } from '../dist/agent-executor.js';
import { WorkbenchService } from '../dist/workbench-service.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const agents = `生成范围: packages/agent-core
输出格式: json
禁止路径: secrets
`;

function skill(version, tools, description) {
  return {
    id: 'review',
    version,
    text: `---\nname: review\ndescription: ${description}\nallowed-tools: ${tools}\n---\n\n按此方法执行。\n`,
  };
}

function snapshot() {
  const result = loadPromptConstraints({
    agentsMd: agents,
    skills: [skill('1', 'Read', '第一版说明'), skill('2', 'Write', '第二版说明')],
    skillPins: [{ id: 'review', version: '1' }],
  });
  assert.equal(result.ok, true);
  return result.snapshot;
}

function service() {
  let state = fixture().state;
  return new WorkbenchService(
    { read: () => state, write: async (next) => (state = next) },
    { get: () => undefined, put: async () => {} },
  );
}

test('prompt constraints: execution prompt reads the pinned snapshot and rejects a forbidden tool', () => {
  const frozen = snapshot();
  const prompt = taskPrompt({
    goal: '只改 packages/agent-core/src/a.ts',
    instruction: '给出 json',
    promptConstraints: frozen,
    toolAllowlist: ['Read'],
  });
  assert.match(prompt, new RegExp(frozen.id));
  assert.ok(prompt.includes(frozen.text));
  assert.match(prompt, /review@1/);
  assert.throws(
    () =>
      taskPrompt({
        goal: '整理',
        instruction: '继续',
        promptConstraints: frozen,
        toolAllowlist: ['Write'],
      }),
    (error) => error.code === 'constraint-violation' && error.issues[0].code === 'tool-not-allowed',
  );
});

test('prompt constraints: planning service puts the same snapshot in the model input', async () => {
  const frozen = snapshot();
  const { task } = fixture();
  const workflows = structuredClone(task.workflows);
  workflows[0].nodes[0].output = '交付 json';
  let seen = '';
  const model = {
    name: 'contract-fixture',
    generate: async (_system, input) => {
      seen = input;
      return JSON.stringify({
        summary: '按约束分配',
        questions: [],
        assumptions: [],
        workflows,
      });
    },
  };
  const proposal = await service().plan(
    { requestId: randomUUID(), taskId: 'task', expectedRevision: 0, instruction: '按约束' },
    model,
    new AbortController().signal,
    undefined,
    frozen,
  );
  const echoed = JSON.parse(seen).context.constraints;
  assert.equal(echoed.id, frozen.id);
  assert.equal(echoed.text, frozen.text);
  assert.equal(echoed.skills[0].version, '1');
  assert.equal(proposal.result.workflows[0].nodes[0].output, '交付 json');
});

test('prompt constraints: planning service reports a constraint violation', async () => {
  const frozen = snapshot();
  const { task } = fixture();
  const model = {
    name: 'contract-fixture',
    generate: async () =>
      JSON.stringify({
        summary: '越界草案',
        questions: [],
        assumptions: [],
        workflows: task.workflows,
      }),
  };
  await assert.rejects(
    service().plan(
      { requestId: randomUUID(), taskId: 'task', expectedRevision: 0, instruction: '' },
      model,
      new AbortController().signal,
      undefined,
      frozen,
    ),
    (error) =>
      error.code === 'constraint-violation' &&
      /forbidden-path|output-format-mismatch/.test(error.message),
  );
});
