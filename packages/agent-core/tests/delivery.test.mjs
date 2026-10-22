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
  assert.equal(cancelled.reason, 'cancelled-run');
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
    appliedKeys: [],
  });
  assert.equal(applied.effect, 'applied');
  const replay = evaluateFeedbackApplication({
    batch,
    currentTargetVersionId: 'art-2',
    authorized: true,
    appliedKeys: ['batch-key'],
  });
  assert.equal(replay.effect, 'replayed');
  const conflict = evaluateFeedbackApplication({
    batch: { ...batch, idempotencyKey: 'batch-key-2' },
    currentTargetVersionId: 'art-2',
    authorized: true,
    appliedKeys: [],
  });
  assert.equal(conflict.code, 'version-conflict');
  const forbidden = evaluateFeedbackApplication({
    batch,
    currentTargetVersionId: 'art-1',
    authorized: false,
    appliedKeys: [],
  });
  assert.equal(forbidden.code, 'unauthorized');
  const incomplete = evaluateFeedbackApplication({
    batch: { ...batch, idempotencyKey: 'batch-key-3', dispositions: [batch.dispositions[0]] },
    currentTargetVersionId: 'art-1',
    authorized: true,
    appliedKeys: [],
  });
  assert.equal(incomplete.code, 'incomplete-disposition');
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
      node('n7', 'in-review'),
    ],
    rounds: [
      {
        roundId: 'round-1',
        nodeId: 'n7',
        taskId: 'task-1',
        status: 'open',
        reviewerIds: ['human-1', 'human-2'],
        terminalReviewerIds: [],
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
    items.map((item) => [item.kind, item.nodeId, item.reason]),
    [
      ['deliver', 'n1', 'assignee-delivery'],
      ['deliver', 'n2', 'revision-delivery'],
      ['review', 'n7', 'review-assigned'],
      ['confirm', 'n2', '确认反馈方案'],
      ['confirm', 'n6', 'parent-confirmation'],
    ],
  );
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
