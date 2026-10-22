import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCastBallot,
  canReadFile,
  canSubmitNode,
  createArtifactVersion,
  deriveInbox,
  evaluateFeedbackApplication,
  observeRunSignal,
  projectWorkTreeNode,
  requestNodeRun,
  taskAccess,
  transitionRun,
  validateDeliveryContent,
} from '@zhuma/agent-core';

const file = (overrides = {}) => ({
  id: 'file-1',
  mediaType: 'text/plain',
  byteSize: 4,
  checksum: 'abc',
  accessPolicyId: 'policy-1',
  uploadComplete: true,
  ...overrides,
});

test('accepts text, files, or links and refuses an empty or unfinished submission', () => {
  assert.equal(validateDeliveryContent({ text: ' 只写文字 ', files: [], links: [] }).ok, true);
  assert.equal(
    validateDeliveryContent({ files: [], links: [' https://example.test/result '] }).ok,
    true,
  );
  assert.equal(
    validateDeliveryContent({ text: '   ', files: [], links: [' '] }).code,
    'empty-delivery',
  );
  assert.equal(
    validateDeliveryContent({
      text: '已输入的文字还在',
      files: [file({ uploadComplete: false })],
      links: [],
    }).code,
    'upload-incomplete',
  );
  assert.equal(
    validateDeliveryContent({ files: [file({ checksum: ' ' })], links: [] }).code,
    'invalid-file',
  );
  assert.equal(
    validateDeliveryContent({ files: [], links: ['javascript:alert(1)'] }).code,
    'invalid-link',
  );
  assert.equal(validateDeliveryContent({ files: [], links: ['not a url'] }).code, 'invalid-link');
  assert.equal(validateDeliveryContent({ files: [], links: ['http://example.test/a'] }).ok, true);
  assert.equal(
    validateDeliveryContent({ files: [file({ byteSize: 0 })], links: [] }).code,
    'empty-delivery',
  );
  assert.equal(
    validateDeliveryContent({ text: '还有文字', files: [file({ byteSize: 0 })], links: [] }).ok,
    true,
  );
  assert.equal(
    validateDeliveryContent({ files: [], links: ['https://user:p4ss@example.test/x'] }).code,
    'invalid-link',
  );
  assert.equal(
    validateDeliveryContent({ files: [], links: ['https://user@example.test/x'] }).code,
    'invalid-link',
  );
});

test('creates the next immutable artifact version without rewriting the previous one', () => {
  const draftFile = file();
  const draft = { text: ' 第一版 ', files: [draftFile], links: [' https://example.test/a '] };
  const created = createArtifactVersion({
    id: 'art-1',
    nodeId: 'node-1',
    submittedBy: 'human-1',
    draft,
    previous: [],
  });
  assert.equal(created.ok, true);
  draftFile.checksum = 'mutated';
  draft.text = '被改掉';
  assert.equal(created.version.version, 1);
  assert.equal(created.version.text, '第一版');
  assert.equal(created.version.files[0].checksum, 'abc');
  assert.deepEqual(created.version.links, ['https://example.test/a']);

  const next = createArtifactVersion({
    id: 'art-2',
    nodeId: 'node-1',
    submittedBy: 'human-1',
    draft: { files: [file({ id: 'file-2' })], links: [] },
    previous: [created.version],
  });
  assert.equal(next.version.version, 2);
  assert.equal(created.version.version, 1);
  assert.equal(created.version.text, '第一版');
});

test('keeps one active run and does not let stale or cancelled output advance work', () => {
  const runs = [
    { id: 'run-old', nodeId: 'node-1', status: 'completed' },
    { id: 'run-live', nodeId: 'node-1', status: 'running' },
  ];
  assert.equal(
    requestNodeRun({ nodeId: 'node-1', nodeStatus: 'ready', runs }).code,
    'active-run-exists',
  );
  assert.equal(requestNodeRun({ nodeId: 'node-1', nodeStatus: 'ready', runs: [runs[0]] }).ok, true);
  assert.equal(
    requestNodeRun({ nodeId: 'node-1', nodeStatus: 'in-review', runs: [] }).code,
    'node-not-executable',
  );
  assert.equal(
    requestNodeRun({ nodeId: 'node-1', nodeStatus: 'needs-revision', runs: [] }).ok,
    true,
  );

  const success = observeRunSignal({
    runStatus: 'running',
    runGeneration: 2,
    currentGeneration: 2,
    signal: 'succeeded',
  });
  assert.equal(success.mayUpdateRunRecord, true);
  assert.equal(success.mayChangeNodeStatus, false);
  assert.equal(success.mayTriggerDownstream, false);

  const stale = observeRunSignal({
    runStatus: 'running',
    runGeneration: 1,
    currentGeneration: 2,
    signal: 'succeeded',
  });
  assert.equal(stale.attachOnly, true);
  assert.equal(stale.reason, 'stale-generation');
  assert.equal(stale.mayChangeNodeStatus, false);
  assert.equal(stale.mayTriggerDownstream, false);

  const cancelled = observeRunSignal({
    runStatus: 'cancelled',
    runGeneration: 2,
    currentGeneration: 2,
    signal: 'output-arrived',
  });
  assert.equal(cancelled.reason, 'terminal-run');
  assert.equal(cancelled.mayChangeNodeStatus, false);
  assert.equal(cancelled.mayTriggerDownstream, false);
  assert.equal(cancelled.attachOnly, true);

  const failure = observeRunSignal({
    runStatus: 'running',
    runGeneration: 2,
    currentGeneration: 2,
    signal: 'failed',
  });
  assert.equal(failure.mayChangeNodeStatus, true);
  assert.equal(failure.mayTriggerDownstream, false);
  assert.equal(failure.suggestedTransition, 'execution-failed');
});

test('a late signal on any finished run is recorded as an attachment only', () => {
  for (const runStatus of ['completed', 'failed', 'cancelled']) {
    for (const signal of ['failed', 'cancel-confirmed', 'succeeded', 'output-arrived']) {
      const observed = observeRunSignal({
        runStatus,
        runGeneration: 2,
        currentGeneration: 2,
        signal,
      });
      assert.equal(observed.reason, 'terminal-run', `${runStatus} ${signal}`);
      assert.equal(observed.attachOnly, true);
      assert.equal(observed.mayUpdateRunRecord, false);
      assert.equal(observed.mayChangeNodeStatus, false);
      assert.equal(observed.mayTriggerDownstream, false);
      assert.equal(observed.suggestedTransition, undefined);
    }
  }
});

test('a run moves only after the executor acknowledges it and a finished run stays finished', () => {
  assert.equal(transitionRun('requested', { type: 'executor-acknowledged' }).to, 'running');
  assert.equal(transitionRun('requested', { type: 'succeeded' }).code, 'illegal-run-transition');
  assert.equal(transitionRun('requested', { type: 'failed' }).to, 'failed');
  assert.equal(transitionRun('running', { type: 'input-required' }).to, 'waiting-for-input');
  assert.equal(transitionRun('waiting-for-input', { type: 'input-supplied' }).to, 'running');
  assert.equal(transitionRun('running', { type: 'succeeded' }).to, 'completed');
  assert.equal(transitionRun('waiting-for-input', { type: 'failed' }).to, 'failed');
  assert.equal(transitionRun('requested', { type: 'cancel-confirmed' }).to, 'cancelled');
  const refused = observeRunSignal({
    runStatus: 'requested',
    runGeneration: 1,
    currentGeneration: 1,
    signal: 'failed',
  });
  assert.equal(refused.mayUpdateRunRecord, true);
  assert.equal(refused.mayChangeNodeStatus, false);
  assert.equal(refused.attachOnly, false);
  assert.equal(refused.suggestedTransition, undefined);
  const earlySuccess = observeRunSignal({
    runStatus: 'requested',
    runGeneration: 1,
    currentGeneration: 1,
    signal: 'succeeded',
  });
  assert.equal(earlySuccess.attachOnly, true);
  assert.equal(earlySuccess.mayUpdateRunRecord, false);
  assert.equal(earlySuccess.mayChangeNodeStatus, false);
  assert.equal(
    requestNodeRun({
      nodeId: 'node-1',
      nodeStatus: 'ready',
      runs: [{ id: 'run-refused', nodeId: 'node-1', status: 'failed' }],
    }).ok,
    true,
  );

  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(transitionRun(status, { type: 'cancel-confirmed' }).ok, false, status);
    assert.equal(transitionRun(status, { type: 'failed' }).ok, false, status);
    assert.equal(transitionRun(status, { type: 'succeeded' }).ok, false, status);
  }
});

test('replays one feedback batch and refuses a moved target version', () => {
  const batch = {
    id: 'batch-1',
    commentIds: ['c1', 'c2'],
    targetVersionId: 'art-1',
    idempotencyKey: 'batch-key',
    dispositions: [
      { commentId: 'c1', kind: 'accepted', reply: '已改' },
      { commentId: 'c2', kind: 'conflict-pending', reply: '两条意见冲突，待人决定' },
    ],
  };
  const applied = evaluateFeedbackApplication({
    batch,
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedBatches: [],
  });
  assert.equal(applied.effect, 'applied');
  const stored = [{ idempotencyKey: 'batch-key', fingerprint: applied.fingerprint }];
  const replay = evaluateFeedbackApplication({
    batch,
    currentTargetVersionId: 'art-2',
    authorized: true,
    appliedBatches: stored,
  });
  assert.equal(replay.effect, 'replayed');
  const mismatch = evaluateFeedbackApplication({
    batch: {
      ...batch,
      dispositions: [{ commentId: 'c1', kind: 'declined', reply: '不改' }, batch.dispositions[1]],
    },
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedBatches: stored,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'idempotency-mismatch');
  const proposalMismatch = evaluateFeedbackApplication({
    batch: { ...batch, proposal: { summary: '另一方案' } },
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedBatches: stored,
  });
  assert.equal(proposalMismatch.code, 'idempotency-mismatch');
  const conflict = evaluateFeedbackApplication({
    batch: { ...batch, idempotencyKey: 'batch-key-2' },
    currentTargetVersionId: 'art-2',
    authorized: true,
    appliedBatches: [],
  });
  assert.equal(conflict.code, 'version-conflict');
  const forbidden = evaluateFeedbackApplication({
    batch,
    currentTargetVersionId: 'art-1',
    authorized: false,
    appliedBatches: [],
  });
  assert.equal(forbidden.code, 'unauthorized');
  const incomplete = evaluateFeedbackApplication({
    batch: { ...batch, idempotencyKey: 'batch-key-3', dispositions: [batch.dispositions[0]] },
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedBatches: [],
  });
  assert.equal(incomplete.code, 'incomplete-disposition');
  const empty = evaluateFeedbackApplication({
    batch: { ...batch, idempotencyKey: 'batch-key-4', commentIds: [], dispositions: [] },
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedBatches: [],
  });
  assert.equal(empty.code, 'invalid-batch');
});

test('derives separate inbox rows and omits read-only, finished, and agent delivery', () => {
  const items = deriveInbox({
    actorId: 'human-1',
    nodes: [
      node('n1', 'ready'),
      node('n2', 'needs-revision'),
      node('n3', 'completed'),
      node('n4', 'ready', { access: 'read' }),
      node('n5', 'ready', { assignee: { id: 'human-1', kind: 'agent' } }),
      node('n6', 'ready', { awaitingParentConfirmation: true }),
      node('n7', 'in-review', { currentRoundId: 'round-1' }),
      node('n8', 'running'),
      node('n9', 'waiting-for-input'),
      node('n10', 'failed'),
      node('n11', 'blocked'),
      node('n12', 'child-workflow'),
    ],
    rounds: [
      {
        roundId: 'round-old',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1', 'human-2'],
        terminalReviewerIds: [],
      },
      {
        roundId: 'round-void',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'voided',
        reviewerIds: ['human-1'],
        terminalReviewerIds: [],
      },
      {
        roundId: 'round-1',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1', 'human-2'],
        terminalReviewerIds: [],
        current: false,
      },
      {
        roundId: 'round-old',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1', 'human-2'],
        terminalReviewerIds: [],
        current: true,
      },
    ],
    confirmations: [
      {
        id: 'confirm-1',
        nodeId: 'n2',
        taskId: 'task-1',
        actorId: 'human-1',
        reason: '确认反馈方案',
        confirmed: false,
      },
    ],
  });
  assert.deepEqual(
    items.map((item) => [item.kind, item.nodeId, item.reason, item.action]),
    [
      ['deliver', 'n1', 'assignee-delivery', 'submit'],
      ['deliver', 'n10', 'retry-or-take-back', 'retry-or-take-back'],
      ['deliver', 'n2', 'revision-delivery', 'revise'],
      ['deliver', 'n8', 'agent-assisted-delivery', 'continue-handling'],
      ['deliver', 'n9', 'input-required', 'provide-input'],
      ['review', 'n7', 'review-assigned', 'review'],
      ['confirm', 'n2', 'explicit-confirmation', 'confirm'],
      ['confirm', 'n6', 'parent-confirmation', 'confirm'],
    ],
  );
  assert.equal(items.filter((item) => item.kind === 'review').length, 1);
  assert.equal(items.find((item) => item.kind === 'review').id, 'review:round-1:human-1');
  assert.equal(
    items.find((item) => item.nodeId === 'n2' && item.kind === 'confirm').detail,
    '确认反馈方案',
  );
  assert.equal(
    items.some((item) => item.nodeId === 'n11' || item.nodeId === 'n12'),
    false,
  );
});

test('review to-dos follow the current round, and an agent stall notifies the owner', () => {
  const nodes = [
    node('n7', 'in-review'),
    node('agent-wait', 'waiting-for-input', {
      assignee: { id: 'agent-1', kind: 'agent' },
      ownerId: 'human-1',
    }),
    node('agent-fail', 'failed', {
      assignee: { id: 'agent-1', kind: 'agent' },
      ownerId: 'human-1',
    }),
    node('agent-run', 'running', {
      assignee: { id: 'agent-1', kind: 'agent' },
      ownerId: 'human-1',
    }),
    node('expert-wait', 'waiting-for-input', {
      assignee: { id: 'expert-cfg', kind: 'expert' },
      ownerId: 'human-1',
    }),
    node('expert-fail', 'failed', {
      assignee: { id: 'expert-cfg', kind: 'expert' },
      ownerId: 'human-1',
    }),
  ];
  const unmarked = deriveInbox({
    actorId: 'human-1',
    nodes,
    rounds: [
      {
        roundId: 'r1',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: [],
      },
      {
        roundId: 'r2',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: ['human-1'],
      },
    ],
    confirmations: [],
  });
  assert.equal(
    unmarked.some((item) => item.kind === 'review'),
    false,
  );
  const flagged = deriveInbox({
    actorId: 'human-1',
    nodes,
    rounds: [
      {
        roundId: 'r2',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: ['human-1'],
        current: true,
      },
      {
        roundId: 'r1',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: [],
        current: false,
      },
    ],
    confirmations: [],
  });
  assert.equal(flagged.filter((item) => item.kind === 'review').length, 0);
  const current = deriveInbox({
    actorId: 'human-1',
    nodes: [node('n7', 'in-review')],
    rounds: [
      {
        roundId: 'r1',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: [],
      },
      {
        roundId: 'r2',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1'],
        terminalReviewerIds: [],
        current: true,
      },
    ],
    confirmations: [],
  });
  assert.deepEqual(
    current.filter((item) => item.kind === 'review').map((item) => item.id),
    ['review:r2:human-1'],
  );
  assert.deepEqual(
    unmarked
      .filter((item) => item.kind === 'deliver')
      .map((item) => [item.nodeId, item.reason, item.action]),
    [
      ['agent-fail', 'owner-take-back', 'retry-or-take-back'],
      ['agent-wait', 'owner-input-required', 'provide-input'],
      ['expert-fail', 'owner-take-back', 'retry-or-take-back'],
      ['expert-wait', 'owner-input-required', 'provide-input'],
    ],
  );
  const asExpert = deriveInbox({
    actorId: 'expert-cfg',
    nodes,
    rounds: [],
    confirmations: [],
  });
  assert.equal(asExpert.length, 0);
});

test('keeps task access, submission, review votes, and files on their own grant', () => {
  const grants = [{ actorId: 'human-1', taskId: 'task-1', access: 'write' }];
  assert.equal(taskAccess('human-1', 'task-2', grants), 'none');
  assert.equal(
    canSubmitNode({ actorId: 'owner', assigneeId: 'human-1', taskAccess: 'write' }),
    false,
  );
  assert.equal(
    canSubmitNode({ actorId: 'human-1', assigneeId: 'human-1', taskAccess: 'read' }),
    false,
  );
  assert.equal(
    canSubmitNode({ actorId: 'human-1', assigneeId: 'human-1', taskAccess: 'write' }),
    true,
  );
  assert.equal(canCastBallot('owner', ['reviewer-1']), false);
  assert.equal(canCastBallot('reviewer-1', ['reviewer-1']), true);
  assert.equal(
    canReadFile({ actorId: 'human-1', fileTaskId: 'task-2', grants, referencedByUpstream: true }),
    false,
  );
  assert.equal(
    canReadFile({ actorId: 'human-1', fileTaskId: 'task-1', grants, referencedByUpstream: false }),
    true,
  );
});

test('redacts an unauthorized work-tree ancestor down to its id', () => {
  const node = {
    id: 'ancestor',
    title: '未授权标题',
    fileNames: ['secret.pdf'],
    commentIds: ['c-secret'],
  };
  const hidden = projectWorkTreeNode({ canAccess: false, node });
  assert.deepEqual(hidden, { access: 'redacted', id: 'ancestor' });
  assert.equal(JSON.stringify(hidden).includes('未授权标题'), false);
  assert.equal(JSON.stringify(hidden).includes('secret.pdf'), false);
  const visible = projectWorkTreeNode({ canAccess: true, node });
  node.title = 'changed';
  assert.equal(visible.node.title, '未授权标题');
});

function node(nodeId, status, overrides = {}) {
  return {
    nodeId,
    taskId: 'task-1',
    status,
    assignee: { id: 'human-1', kind: 'human' },
    access: 'write',
    awaitingParentConfirmation: false,
    ...overrides,
  };
}
