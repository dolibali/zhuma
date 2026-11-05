import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  acceptExecutionDraft,
  buildPlanningContext,
  checkPromptConstraints,
  executionConstraintText,
  loadPromptConstraints,
  parsePlanningResult,
  planningPrompt,
  readPromptConstraints,
} from '../dist/index.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const agents = `生成范围: packages/agent-core
输出格式: json
禁止路径: secrets, .env
`;

function skill(id, version, tools, description) {
  return {
    id,
    version,
    text: `---\nname: review\ndescription: ${description}\nallowed-tools: ${tools}\n---\n\n按此方法执行。\n`,
  };
}

function loaded(extra = {}) {
  const result = loadPromptConstraints({ agentsMd: agents, ...extra });
  assert.equal(result.ok, true);
  return result.snapshot;
}

function planText(task, output, description = '') {
  const workflows = structuredClone(task.workflows);
  workflows[0].nodes[0].output = output;
  workflows[0].nodes[0].description = description;
  return JSON.stringify({
    summary: '按约束分配',
    questions: [],
    assumptions: [],
    workflows,
  });
}

test('prompt constraints: planning and execution read one frozen snapshot', () => {
  const snapshot = loaded({ skills: [skill('review', '1', 'Read', '评审说明')] });
  const { state, task } = fixture();
  const context = buildPlanningContext(state, task, '按约束规划', undefined, snapshot);
  assert.equal(context.constraints, snapshot);
  assert.equal(readPromptConstraints(context.constraints), snapshot);
  const prompt = planningPrompt(state, task, '按约束规划', undefined, undefined, snapshot);
  const echoed = JSON.parse(prompt.input).context.constraints;
  assert.equal(echoed.id, snapshot.id);
  assert.equal(echoed.text, snapshot.text);
  assert.match(executionConstraintText(snapshot), new RegExp(snapshot.id));
  assert.match(executionConstraintText(snapshot), /禁止路径: secrets/);
  assert.match(executionConstraintText(snapshot), /allowed-tools: Read/);
  assert.equal(acceptExecutionDraft(snapshot, { text: '{"ok":true}' }), snapshot);
  assert.equal(
    checkPromptConstraints(snapshot, { paths: ['packages/agent-core/src/a.ts'] }).ok,
    true,
  );
});

test('prompt constraints: missing AGENTS.md is soft-ok and still shared', () => {
  const result = loadPromptConstraints({
    agentsMd: null,
    skills: [skill('review', '1', 'Read', '评审说明')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.agents.present, false);
  assert.equal(result.snapshot.agents.path, 'AGENTS.md');
  const { state, task } = fixture();
  const context = buildPlanningContext(state, task, '', undefined, result.snapshot);
  assert.equal(context.constraints, result.snapshot);
  assert.match(context.constraints.text, /未提供/);
  assert.match(executionConstraintText(readPromptConstraints(context.constraints)), /未提供/);
  assert.equal(checkPromptConstraints(result.snapshot, { tools: ['Read'] }).ok, true);
});

test('prompt constraints: conflicting Skill versions stay pinned to one snapshot', () => {
  const first = skill('review', '1', 'Read', '第一版说明');
  const second = skill('review', '2', 'Write', '第二版说明');
  const conflict = loadPromptConstraints({ skills: [first, second] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.issues[0].code, 'skill-version-conflict');
  const result = loadPromptConstraints({
    skills: [second, first],
    skillPins: [{ id: 'review', version: '1' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.snapshot.skills.map((item) => item.version),
    ['1'],
  );
  assert.deepEqual(result.snapshot.skills[0].allowedTools, ['Read']);
  assert.deepEqual(result.snapshot.pins[0].discardedVersions, ['2']);
  assert.equal(checkPromptConstraints(result.snapshot, { tools: ['Write'] }).ok, false);
  assert.equal(
    checkPromptConstraints(result.snapshot, { tools: ['Write'] }).issues[0].code,
    'tool-not-allowed',
  );
  assert.equal(checkPromptConstraints(result.snapshot, { tools: ['Read'] }).ok, true);
  const { state, task } = fixture();
  const context = buildPlanningContext(state, task, '', undefined, result.snapshot);
  assert.equal(context.constraints.skills[0].version, '1');
  assert.match(executionConstraintText(context.constraints), /review@1/);
  assert.doesNotMatch(executionConstraintText(context.constraints), /allowed-tools: Write/);
  assert.throws(() => readPromptConstraints({ ...result.snapshot }), {
    code: 'constraint-unfrozen',
  });
});

test('prompt constraints: scope, format and forbidden paths fail planning and execution', () => {
  const snapshot = loaded();
  const { state, task } = fixture();
  const context = buildPlanningContext(state, task, '', undefined, snapshot);
  assert.throws(
    () =>
      parsePlanningResult(
        planText(task, '接口定义', '读取 docs/spec.md 作为输入，禁止读取 secrets/token.txt'),
        state,
        task,
        context,
      ),
    (error) =>
      error.code === 'constraint-violation' &&
      /output-format-mismatch/.test(error.message) &&
      !/forbidden-path|scope-exceeded/.test(error.message),
  );
  parsePlanningResult(
    planText(
      task,
      '交付 json',
      '读取 docs/spec.md 作为输入，仅修改 packages/agent-core/src/a.ts；禁止读取 secrets/token.txt',
    ),
    state,
    task,
    context,
  );
  const scope = checkPromptConstraints(snapshot, { paths: ['packages/client/src/a.ts'] });
  assert.equal(scope.ok, false);
  assert.equal(scope.issues[0].code, 'scope-exceeded');
  const forbidden = checkPromptConstraints(snapshot, { paths: ['config/.env.local'] });
  assert.equal(forbidden.ok, false);
  assert.ok(forbidden.issues.some((item) => item.code === 'forbidden-path'));
  assert.throws(
    () => acceptExecutionDraft(snapshot, { text: '不是 JSON', paths: ['secrets/key.txt'] }),
    (error) => error.code === 'constraint-violation' && error.issues.length >= 2,
  );
});

test('prompt constraints: an explicit pin is checked even when only one Skill candidate exists', () => {
  const missing = loadPromptConstraints({
    skills: [skill('review', '2', 'Write', '第二版说明')],
    skillPins: [{ id: 'review', version: '1' }],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.snapshot, undefined);
  assert.equal(missing.issues[0].code, 'skill-version-conflict');
  assert.match(missing.issues[0].reason, /钉住版本 1 不存在/);
  const matched = loadPromptConstraints({
    skills: [skill('review', '1', 'Read', '第一版说明')],
    skillPins: [{ id: 'review', version: '1' }],
  });
  assert.equal(matched.ok, true);
  assert.deepEqual(
    matched.snapshot.skills.map((item) => item.version),
    ['1'],
  );
  assert.deepEqual(matched.snapshot.skills[0].allowedTools, ['Read']);
});

test('prompt constraints: prose may name inputs and forbidden paths; structured targets stay checked', () => {
  const result = loadPromptConstraints({
    agentsMd: '生成范围: src/\n禁止路径: secrets\n',
  });
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  const inputNote = '读取 docs/spec.md 作为输入，仅修改 src/a.ts';
  const prohibition = '仅修改 src/a.ts；禁止读取 secrets/token.txt';
  assert.equal(checkPromptConstraints(snapshot, { texts: [inputNote] }).ok, true);
  assert.equal(checkPromptConstraints(snapshot, { texts: [prohibition] }).ok, true);
  assert.equal(acceptExecutionDraft(snapshot, { text: inputNote }), snapshot);
  assert.equal(
    acceptExecutionDraft(snapshot, { text: prohibition, paths: ['src/a.ts'] }),
    snapshot,
  );
  const outside = checkPromptConstraints(snapshot, { paths: ['docs/spec.md'] });
  assert.equal(outside.ok, false);
  assert.equal(outside.issues[0].code, 'scope-exceeded');
  const forbidden = checkPromptConstraints(snapshot, { paths: ['src/secrets/token.txt'] });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.issues[0].code, 'forbidden-path');
  assert.throws(
    () => acceptExecutionDraft(snapshot, { paths: ['docs/spec.md'] }),
    (error) => {
      return error.code === 'constraint-violation' && error.issues[0].code === 'scope-exceeded';
    },
  );
});

test('prompt constraints: repository SKILL.md frontmatter loads', () => {
  const text = readFileSync(
    new URL('../../../resources/skills/engineering-starter/bounded-fix/SKILL.md', import.meta.url),
    'utf8',
  );
  const result = loadPromptConstraints({
    agentsMd: null,
    skills: [{ id: 'bounded-fix', version: '1.0.0', text }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.skills[0].name, 'bounded-fix');
  assert.match(result.snapshot.skills[0].description, /最小修复/);
  assert.equal(result.snapshot.skills[0].limitsTools, false);
});
