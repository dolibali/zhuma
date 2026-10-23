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
    contextItems: [
      {
        id: 'note',
        kind: 'project-knowledge',
        sourceId: 'note-1',
        version: '1',
        permission: 'granted',
        summary: '备注',
        required: false,
        includedByDefault: true,
      },
    ],
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

function openDesk(journal, simulated = new SimulatedAgentExecutor({ chunkDelayMs: 0 })) {
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

test('契约：创建时日志写不进去就不交出工作台', () => {
  const journal = {
    load: () => null,
    save() {
      const error = new Error('ENOSPC: no space left');
      error.code = 'ENOSPC';
      throw error;
    },
  };
  assert.throws(
    () =>
      ExecutionDesk.create(seed(), {
        executors: [new SimulatedAgentExecutor()],
        newId: ids(),
        journal,
      }),
    (error) => error instanceof Error && error.code === 'persist-failed',
  );
});

test('契约：恢复交互写不进去时仍不能发送', () => {
  const { state, journal } = failingJournal();
  const session = openDesk(journal);
  const saved = JSON.parse(JSON.stringify(state.value));
  const restored = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal: {
      value: saved,
      save(value) {
        const error = new Error('ENOSPC: no space left');
        error.code = 'ENOSPC';
        throw error;
      },
    },
  });
  const resumed = restored.resumeInteraction();
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'persist-failed');
  assert.equal(restored.snapshot().interactionReady, false);
  const blocked = restored.send({ text: '整理开户字段', idempotencyKey: 'after-resume' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'restore-facts-first');
});

test('契约：配置、上下文、附件和恢复请求保存失败时退回', () => {
  const { state, journal } = failingJournal();
  const session = openDesk(journal);
  const executorBefore = session.snapshot().config.executorId;
  state.failNext = true;
  const config = session.updateConfig({ executorId: 'dsh' });
  assert.equal(config.ok, false);
  assert.equal(config.code, 'persist-failed');
  assert.equal(session.snapshot().config.executorId, executorBefore);

  state.failNext = true;
  const availability = session.setAvailability({ expertId: 'api-impl', enabled: false });
  assert.equal(availability.code, 'persist-failed');
  assert.equal(session.snapshot().config.expertEnabled, true);

  state.failNext = true;
  const context = session.setContextIncluded('note', false);
  assert.equal(context.code, 'persist-failed');
  assert.equal(session.snapshot().contextItems.find((item) => item.id === 'note').included, true);

  const before = session.snapshot().attachments.length;
  state.failNext = true;
  const added = session.addAttachment({
    name: 'context.txt',
    mediaType: 'text/plain',
    text: 'hello',
  });
  assert.equal(added.code, 'persist-failed');
  assert.equal(session.snapshot().attachments.length, before);

  const kept = session.addAttachment({
    name: 'context.txt',
    mediaType: 'text/plain',
    text: 'hello',
  });
  assert.equal(kept.ok, true);
  const attachmentId = kept.snapshot.attachments.at(-1).id;
  state.failNext = true;
  const removed = session.removeAttachment(attachmentId);
  assert.equal(removed.code, 'persist-failed');
  assert.equal(
    session.snapshot().attachments.some((item) => item.id === attachmentId),
    true,
  );

  state.failNext = true;
  const recovery = session.recover('human-takeover');
  assert.equal(recovery.code, 'persist-failed');
  assert.equal(session.snapshot().recoveryRequests.length, 0);
  assert.equal(state.value.recoveryRequests.length, 0);
});

test('契约：确认完成、退回和等待输入保存失败时退回', async () => {
  const plain = seed();
  plain.handoff = { ...plain.handoff, reviewRequired: false, reviewerIds: [] };
  const { state, journal } = failingJournal();
  const simulated = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  const session = ExecutionDesk.create(plain, {
    executors: [simulated],
    newId: ids(),
    journal,
  });
  session.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  state.failNext = true;
  const completed = session.confirmCompleted();
  assert.equal(completed.ok, false);
  assert.equal(completed.code, 'persist-failed');
  assert.equal(session.snapshot().node.status, 'ready');
  assert.equal(state.value.nodeState.status, 'ready');

  const done = session.confirmCompleted();
  assert.equal(done.ok, true);
  assert.equal(session.snapshot().node.status, 'completed');
  state.failNext = true;
  const reopened = session.reopenForRework();
  assert.equal(reopened.code, 'persist-failed');
  assert.equal(session.snapshot().node.status, 'completed');

  const again = seed();
  const held = failingJournal();
  const runner = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  const waiting = ExecutionDesk.create(again, {
    executors: [runner],
    newId: ids(),
    journal: held.journal,
  });
  waiting.updateConfig({
    executorId: 'simulated',
    skillIds: ['test-design'],
    mcpIds: ['api-docs'],
  });
  const started = waiting.send({ text: '整理开户字段', idempotencyKey: 'wait-1' });
  await waiting.waitForRun(started.runId, 'running');
  held.state.failNext = true;
  const marked = waiting.markWaitingForInput();
  assert.equal(marked.code, 'persist-failed');
  assert.equal(waiting.snapshot().runs.at(-1).status, 'running');
  assert.equal(waiting.snapshot().node.status, 'running');
});

test('契约：重试和核实断开保存失败时不改节点', async () => {
  const { state, journal } = failingJournal();
  const simulated = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  const session = openDesk(journal, simulated);
  const started = session.send({ text: '整理开户字段', idempotencyKey: 'stop-key' });
  await session.waitForRun(started.runId, 'running');
  const running = JSON.parse(JSON.stringify(session.persistence()));
  const stopped = await session.stop();
  assert.equal(stopped.ok, true);
  await session.flush();
  const status = session.snapshot().node.status;
  const runs = session.snapshot().runs.length;
  state.failNext = true;
  const retried = session.retry('once');
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'persist-failed');
  assert.equal(session.snapshot().node.status, status);
  assert.equal(session.snapshot().runs.length, runs);

  const gapState = { failNext: false, value: running };
  const restored = ExecutionDesk.restore(running, {
    executors: [new SimulatedAgentExecutor({ chunkDelayMs: 0 })],
    newId: ids(),
    journal: {
      load: () => gapState.value,
      save(value) {
        if (gapState.failNext) {
          gapState.failNext = false;
          const error = new Error('ENOSPC: no space left');
          error.code = 'ENOSPC';
          throw error;
        }
        gapState.value = JSON.parse(JSON.stringify(value));
      },
    },
  });
  assert.equal(restored.resumeInteraction().ok, true);
  assert.notEqual(restored.snapshot().resumeGap, null);
  const nodeBefore = restored.snapshot().node.status;
  gapState.failNext = true;
  const verified = restored.verifyAbandoned();
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'persist-failed');
  assert.notEqual(restored.snapshot().resumeGap, null);
  assert.equal(restored.snapshot().node.status, nodeBefore);
  assert.equal(restored.snapshot().runs.at(-1).status, 'running');
});

test('契约：取消回执之后的保存失败不撤销已经取消的运行', async () => {
  const simulated = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  let cancels = 0;
  const cancel = simulated.cancel.bind(simulated);
  simulated.cancel = async (runId) => {
    cancels += 1;
    return cancel(runId);
  };
  const state = { value: null };
  const journal = {
    load: () => state.value,
    save(value) {
      const dropped = value.interventions?.some((item) => item.phase === 'not-applied');
      if (dropped) {
        const error = new Error('ENOSPC: no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      state.value = JSON.parse(JSON.stringify(value));
    },
  };
  const session = openDesk(journal, simulated);
  const started = session.send({ text: '整理开户字段', idempotencyKey: 'cancel-after' });
  await session.waitForRun(started.runId, 'running');
  const queued = session.send({ text: '排队补充', idempotencyKey: 'cancel-queue' });
  assert.equal(queued.ok, true);
  const stopped = await session.stop();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.code, 'persist-failed');
  assert.equal(cancels, 1);
  assert.equal(session.snapshot().runs.at(-1).status, 'cancelled');
  assert.equal(
    session.snapshot().interventions.some((item) => item.phase === 'not-applied'),
    true,
  );
  assert.equal(
    state.value.interventions.some((item) => item.phase === 'not-applied'),
    false,
  );
  assert.equal(session.snapshot().persistenceFault?.code, 'persist-failed');
});

test('契约：丢掉入口的测试钩子在保存失败时保留内存标记', () => {
  const { state, journal } = failingJournal();
  const session = openDesk(journal);
  state.failNext = true;
  session.dropRecordedEntry();
  assert.equal(session.persistence().nodeState.entryStatus, undefined);
  assert.equal(state.value.nodeState.entryStatus, 'ready');
  assert.equal(session.snapshot().persistenceFault?.code, 'persist-failed');
});

test('契约：接受当前轮次的结果保存失败时不报成功', () => {
  const { state, journal } = failingJournal();
  const session = openDesk(journal);
  const saved = JSON.parse(JSON.stringify(state.value));
  saved.activeRoundId = 'round-1';
  saved.reviewRounds = [{ id: 'round-1', status: 'open' }];
  const failing = {
    value: saved,
    failNext: false,
    save(value) {
      if (this.failNext) {
        this.failNext = false;
        const error = new Error('ENOSPC: no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      this.value = JSON.parse(JSON.stringify(value));
    },
  };
  const desk = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal: failing,
  });
  assert.equal(desk.resumeInteraction().ok, true);
  failing.failNext = true;
  const accepted = desk.acceptReviewResult('round-1', 'approved');
  assert.equal(accepted.ok, false);
  assert.equal(accepted.code, 'persist-failed');
  assert.equal(failing.value.activeRoundId, 'round-1');
});
