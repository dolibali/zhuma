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
  const beforeRetry = JSON.parse(JSON.stringify(session.persistence()));
  assert.equal(beforeRetry.nodeState.status, 'cancelled');
  state.failNext = true;
  const retried = session.retry('once');
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'persist-failed');
  assert.deepEqual(session.persistence(), beforeRetry);
  assert.equal(
    session.persistence().nodeState.stored.some((item) => item.idempotencyKey === 'recovery:once'),
    false,
  );
  const again = session.retry('once');
  assert.equal(again.ok, true);
  assert.notEqual(again.code, 'recovery-not-available');
  await session.waitForRun(again.runId, 'running');
  assert.equal(session.snapshot().node.status, 'running');
  assert.equal(
    session.persistence().nodeState.stored.some((item) => item.idempotencyKey === 'recovery:once'),
    true,
  );

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
  assert.deepEqual(desk.persistence(), saved);
  assert.equal(desk.snapshot().persistenceFault, null);
});

test('契约：同步命令落盘失败后内存与调用前一致', async () => {
  const rows = [
    ['updateConfig', () => failingJournal(), (session) => session.updateConfig({ skillIds: [] })],
    [
      'setAvailability',
      () => failingJournal(),
      (session) => session.setAvailability({ expertId: 'api-impl', enabled: false }),
    ],
    [
      'setContextIncluded',
      () => failingJournal(),
      (session) => session.setContextIncluded('note', false),
    ],
    [
      'addAttachment',
      () => failingJournal(),
      (session) => session.addAttachment({ name: 'a.txt', mediaType: 'text/plain', text: 'hello' }),
    ],
    ['saveDraft', () => failingJournal(), (session) => session.saveDraft('退回的草稿')],
    ['recover', () => failingJournal(), (session) => session.recover('human-takeover')],
  ];
  for (const [name, open, act] of rows) {
    const { state, journal } = open();
    const session = openDesk(journal);
    const before = JSON.parse(JSON.stringify(session.persistence()));
    state.failNext = true;
    const result = act(session);
    assert.equal(result.code, 'persist-failed', name);
    assert.deepEqual(session.persistence(), before, name);
    assert.equal(session.snapshot().persistenceFault, null, name);
  }

  const attached = failingJournal();
  const withFile = openDesk(attached.journal);
  const added = withFile.addAttachment({ name: 'a.txt', mediaType: 'text/plain', text: 'hello' });
  const attachmentId = added.snapshot.attachments.at(-1).id;
  const beforeRemove = JSON.parse(JSON.stringify(withFile.persistence()));
  attached.state.failNext = true;
  const removed = withFile.removeAttachment(attachmentId);
  assert.equal(removed.code, 'persist-failed');
  assert.deepEqual(withFile.persistence(), beforeRemove);
  assert.equal(withFile.snapshot().attachments[0].contentAvailable, true);
  assert.equal(withFile.snapshot().persistenceFault, null);

  const plain = seed();
  plain.handoff = { ...plain.handoff, reviewRequired: false, reviewerIds: [] };
  const completing = failingJournal();
  const completable = ExecutionDesk.create(plain, {
    executors: [new SimulatedAgentExecutor({ chunkDelayMs: 0 })],
    newId: ids(),
    journal: completing.journal,
  });
  completable.updateConfig({ executorId: 'simulated', skillIds: ['test-design'], mcpIds: [] });
  const beforeComplete = JSON.parse(JSON.stringify(completable.persistence()));
  completing.state.failNext = true;
  const completed = completable.confirmCompleted();
  assert.equal(completed.code, 'persist-failed');
  assert.deepEqual(completable.persistence(), beforeComplete);
  assert.equal(completable.snapshot().persistenceFault, null);
  const done = completable.confirmCompleted();
  assert.equal(done.ok, true);
  const beforeReopen = JSON.parse(JSON.stringify(completable.persistence()));
  completing.state.failNext = true;
  const reopened = completable.reopenForRework();
  assert.equal(reopened.code, 'persist-failed');
  assert.deepEqual(completable.persistence(), beforeReopen);
  assert.equal(completable.snapshot().persistenceFault, null);

  const waiting = failingJournal();
  const runner = new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 });
  const running = openDesk(waiting.journal, runner);
  const started = running.send({ text: '整理开户字段', idempotencyKey: 'table-run' });
  await running.waitForRun(started.runId, 'running');
  const beforeWait = JSON.parse(JSON.stringify(running.persistence()));
  waiting.state.failNext = true;
  const marked = running.markWaitingForInput();
  assert.equal(marked.code, 'persist-failed');
  assert.deepEqual(running.persistence(), beforeWait);
  assert.equal(running.snapshot().persistenceFault, null);

  const beforeQueue = JSON.parse(JSON.stringify(running.persistence()));
  waiting.state.failNext = true;
  const queued = running.send({ text: '排队补充', idempotencyKey: 'table-queue' });
  assert.equal(queued.code, 'persist-failed');
  assert.deepEqual(running.persistence(), beforeQueue);
  assert.equal(running.snapshot().persistenceFault, null);

  const stopped = await running.stop();
  assert.equal(stopped.ok, true);
  const beforeRetry = JSON.parse(JSON.stringify(running.persistence()));
  waiting.state.failNext = true;
  const retried = running.retry('table-retry');
  assert.equal(retried.code, 'persist-failed');
  assert.deepEqual(running.persistence(), beforeRetry);
  assert.equal(running.snapshot().persistenceFault, null);

  const cited = seed();
  cited.handoff = {
    ...cited.handoff,
    inputRefs: [
      { sourceNodeId: 'node-src', artifactVersionId: 'av-note', contextPackId: 'pack-note' },
    ],
  };
  cited.contextItems = [
    {
      id: 'note',
      kind: 'project-knowledge',
      sourceId: 'note-1',
      version: '1',
      permission: 'granted',
      summary: '备注',
      required: false,
      includedByDefault: true,
      sourceNodeId: 'node-src',
      artifactVersionId: 'av-note',
      contextPackId: 'pack-note',
    },
  ];
  const sending = failingJournal();
  const sender = ExecutionDesk.create(cited, {
    executors: [new SimulatedAgentExecutor({ pauseBeforeAccept: true, chunkDelayMs: 0 })],
    newId: ids(),
    journal: sending.journal,
  });
  sender.updateConfig({ executorId: 'simulated', skillIds: ['test-design'], mcpIds: [] });
  const beforeSend = JSON.parse(JSON.stringify(sender.persistence()));
  const maxSequence = beforeSend.turns.reduce((max, turn) => Math.max(max, turn.sequence), 0);
  sending.state.failNext = true;
  const failedSend = sender.send({ text: '带上引用', idempotencyKey: 'table-send' });
  assert.equal(failedSend.code, 'persist-failed');
  assert.deepEqual(sender.persistence(), beforeSend);
  assert.equal(sender.snapshot().persistenceFault, null);
  const sent = sender.send({ text: '带上引用', idempotencyKey: 'table-send' });
  assert.equal(sent.ok, true);
  const userTurn = sender.snapshot().turns.find((turn) => turn.role === 'user');
  assert.equal(userTurn.sequence, maxSequence + 1);
  assert.equal(sender.snapshot().citations.length > 0, true);

  const held = failingJournal();
  const paused = openDesk(
    held.journal,
    new SimulatedAgentExecutor({ pauseAfterAccept: true, chunkDelayMs: 0 }),
  );
  const live = paused.send({ text: '保持运行', idempotencyKey: 'table-live' });
  await paused.waitForRun(live.runId, 'running');
  const crashed = JSON.parse(JSON.stringify(paused.persistence()));
  const gapJournal = failingJournal();
  gapJournal.state.value = crashed;
  const restored = ExecutionDesk.restore(crashed, {
    executors: [new SimulatedAgentExecutor({ chunkDelayMs: 0 })],
    newId: ids(),
    journal: gapJournal.journal,
  });
  assert.equal(restored.resumeInteraction().ok, true);
  const beforeGap = JSON.parse(JSON.stringify(restored.persistence()));
  gapJournal.state.failNext = true;
  const verified = restored.verifyAbandoned();
  assert.equal(verified.code, 'persist-failed');
  assert.deepEqual(restored.persistence(), beforeGap);
  assert.equal(restored.snapshot().persistenceFault, null);
  assert.equal(restored.snapshot().resumeGap.reason, 'session-not-resumed');

  const cold = failingJournal();
  const original = openDesk(cold.journal);
  const saved = JSON.parse(JSON.stringify(original.persistence()));
  const blockedJournal = {
    value: saved,
    save() {
      const error = new Error('ENOSPC: no space left');
      error.code = 'ENOSPC';
      throw error;
    },
  };
  const resumed = ExecutionDesk.restore(saved, {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal: blockedJournal,
  });
  const beforeResume = JSON.parse(JSON.stringify(resumed.persistence()));
  const resumedResult = resumed.resumeInteraction();
  assert.equal(resumedResult.code, 'persist-failed');
  assert.deepEqual(resumed.persistence(), beforeResume);
  assert.equal(resumed.snapshot().interactionReady, false);
  assert.equal(resumed.snapshot().persistenceFault, null);

  const round = failingJournal();
  const roundDesk = openDesk(round.journal);
  const roundSaved = JSON.parse(JSON.stringify(roundDesk.persistence()));
  roundSaved.activeRoundId = 'round-1';
  roundSaved.reviewRounds = [{ id: 'round-1', status: 'open' }];
  const roundJournal = {
    value: roundSaved,
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
  const accepting = ExecutionDesk.restore(JSON.parse(JSON.stringify(roundSaved)), {
    executors: [new SimulatedAgentExecutor()],
    newId: ids(),
    journal: roundJournal,
  });
  assert.equal(accepting.resumeInteraction().ok, true);
  const rejectedRound = accepting.acceptReviewResult('round-0', 'approved');
  assert.equal(rejectedRound.code, 'old-round-rejected');
  const beforeAccept = JSON.parse(JSON.stringify(accepting.persistence()));
  assert.notEqual(beforeAccept.lastError, null);
  roundJournal.failNext = true;
  const accepted = accepting.acceptReviewResult('round-1', 'approved');
  assert.equal(accepted.code, 'persist-failed');
  assert.deepEqual(accepting.persistence(), beforeAccept);
  assert.equal(accepting.snapshot().persistenceFault, null);
});
