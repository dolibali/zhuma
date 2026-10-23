import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionDesk, SimulatedAgentExecutor } from '@zhuma/dsh-adapter';

function ids() {
  let n = 0;
  return (prefix) => `${prefix}-${++n}`;
}

function seed() {
  return {
    handoff: {
      nodeId: 'node-fields',
      taskId: 'task-portal',
      workflowVersionId: 'plan-1',
      revision: 3,
      goal: '确认企业开户字段与校验规则',
      assignee: { id: 'chen-ning', kind: 'human' },
      dependencyNodeIds: [],
      reviewRequired: true,
      reviewerIds: ['lin-ke'],
      inputRefs: [],
      expertRef: { id: 'api-impl', version: 'api-impl-v1' },
      skillRefs: [],
      mcpRefs: [],
      inputNote: '',
      expectedOutput: '',
    },
    taskTitle: '企业客户门户季度交付',
    taskGoal: '完成企业客户开户闭环',
    actorId: 'chen-ning',
    nodeStatus: 'ready',
    catalog: {
      experts: [
        {
          id: 'api-impl',
          versionId: 'api-impl-v1',
          label: '接口实现',
          summary: '整理接口字段',
          enabled: true,
          presetSkillIds: ['test-design'],
          presetMcpIds: ['api-docs'],
        },
      ],
      skills: [{ id: 'test-design', version: '1', label: '测试设计', available: true }],
      mcp: [{ id: 'api-docs', version: '1', label: '接口文档只读', available: true }],
      executors: [
        {
          id: 'simulated',
          label: '模拟执行器',
          available: true,
          verified: false,
          simulated: true,
        },
      ],
    },
    contextItems: [],
    reviewRounds: [],
  };
}

function failingJournal() {
  const state = { value: null, failNext: false };
  const journal = {
    load: () => state.value,
    save: (value) => {
      if (state.failNext) {
        state.failNext = false;
        const error = new Error('ENOSPC: no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      state.value = JSON.parse(JSON.stringify(value));
    },
  };
  return { state, journal };
}

function openDesk(journal, simulated) {
  const created = ExecutionDesk.create(seed(), {
    executors: [simulated],
    newId: ids(),
    journal,
  });
  created.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  return created;
}

test('契约：首次受理保存失败后同键重试会启动，写权不残留', async () => {
  const { state, journal } = failingJournal();
  const simulated = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  let started = 0;
  const run = simulated.run.bind(simulated);
  simulated.run = (request) => {
    started += 1;
    return run(request);
  };
  const session = openDesk(journal, simulated);
  state.failNext = true;
  const first = session.send({ text: '整理开户字段', idempotencyKey: 'k1' });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'persist-failed');
  assert.equal(first.replayed, undefined);
  assert.equal(session.snapshot().runs.length, 0);
  assert.equal(state.value.runs.length, 0);
  assert.equal(
    session.snapshot().claims.some((claim) => claim.active),
    false,
  );
  assert.equal(
    state.value.claims.some((claim) => claim.active),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(started, 0);

  const frozen = JSON.parse(JSON.stringify(state.value));
  const otherJournal = {
    value: frozen,
    save(value) {
      this.value = JSON.parse(JSON.stringify(value));
    },
  };
  const other = ExecutionDesk.restore(frozen, {
    executors: [new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal: otherJournal,
  });
  other.resumeInteraction();
  assert.equal(other.snapshot().runs.length, 0);
  assert.equal(
    other.snapshot().claims.some((claim) => claim.active),
    false,
  );

  const retry = session.send({ text: '整理开户字段', idempotencyKey: 'k1' });
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, false);
  await session.waitForRun(retry.runId, 'running');
  assert.equal(started, 1);
  assert.equal(session.snapshot().runs.length, 1);
  assert.equal(session.snapshot().claims.filter((claim) => claim.active).length, 1);
  const queued = session.send({ text: '不要再起一个进程', idempotencyKey: 'k2' });
  assert.equal(queued.ok, true);
  assert.equal(session.snapshot().runs.length, 1);
  assert.equal(started, 1);
  const stopped = await session.stop();
  assert.equal(stopped.ok, true);
  await session.flush();
  assert.equal(started, 1);
  assert.equal(session.snapshot().runs.length, 1);
  const saved = JSON.parse(JSON.stringify(state.value));
  const reopened = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal: {
      value: saved,
      save(value) {
        this.value = JSON.parse(JSON.stringify(value));
      },
    },
  });
  reopened.resumeInteraction();
  assert.equal(reopened.snapshot().runs.length, 1);
  assert.equal(reopened.snapshot().runs[0].acknowledged, true);
  assert.equal(reopened.snapshot().runs[0].idempotencyKey, 'k1');
  assert.equal(reopened.persistence().runs.length, 1);
});
