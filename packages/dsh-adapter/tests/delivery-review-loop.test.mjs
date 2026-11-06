import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand, previewFixedDelivery } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const lin = {
  id: 'lin',
  name: '林夏',
  kind: 'human',
  role: '复核',
  capabilities: [],
  instructions: '',
  available: true,
};

function memory() {
  const nodes = new Map();
  const plans = new Map();
  const storage = {
    readNode: (key) => nodes.get(key),
    writeNode: async (key, value) => {
      nodes.set(key, structuredClone(value));
    },
    listNodes: () => [...nodes.values()],
    readPlan: (key) => plans.get(key),
    writePlan: async (key, value) => {
      plans.set(key, structuredClone(value));
    },
    listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
  };
  return {
    storage,
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
  };
}

function session(memberId) {
  return { member: { ok: true, memberId, spaceIds: ['project'] } };
}

test('review pins a comment to that version, return blocks downstream, and resubmit opens a new version', async () => {
  const { state, task } = fixture();
  state.participants.push(lin);
  const base = task.workflows[0].nodes[0];
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin', 'outside'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...base,
              id: 'design',
              assigneeId: 'chen',
              reviewerIds: ['lin'],
              reviewRequired: true,
              dependsOn: [],
            },
            {
              ...base,
              id: 'publish',
              title: '发布',
              assigneeId: 'outside',
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: ['design'],
            },
          ],
        },
      ],
      status: 'ready',
    },
  });
  const applied = ready.appliedPlans.at(-1);
  const store = memory();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => ready },
    boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
  );
  const locate = (nodeId, extra) => ({
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId,
    ...extra,
  });
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-loop',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.deepEqual(store.node('publish').handoff.inputRefs, []);

  const submitted = await service.submit(session('chen'), {
    ...locate('design', { expectedVersion: 1, idempotencyKey: 'deliver-v1' }),
    text: '第一行\n保留',
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  const v1 = submitted.value.node.artifacts.at(-1).id;
  const roundId = submitted.value.node.currentRoundId;
  const version = store.node('design').command.version;
  const noted = await service.ballot(session('lin'), {
    ...locate('design', { expectedVersion: version, idempotencyKey: 'note-v1' }),
    roundId,
    artifactVersionId: v1,
    action: 'comment',
    comment: '请改第二行',
  });
  assert.equal(noted.ok, true, noted.ok ? '' : noted.error.code);
  assert.equal(store.node('design').command.status, 'in-review');
  assert.equal(store.node('design').command.version, version);
  const pinnedComment = store.node('design').comments.find((item) => item.body === '请改第二行');
  assert.equal(pinnedComment.status, 'open');
  assert.equal(pinnedComment.versionId, v1);
  assert.equal(pinnedComment.targetId, v1);
  const replay = await service.ballot(session('lin'), {
    ...locate('design', { expectedVersion: version, idempotencyKey: 'note-v1' }),
    roundId,
    artifactVersionId: v1,
    action: 'comment',
    comment: '请改第二行',
  });
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.code);
  assert.equal(replay.value.disposition, 'replayed');
  assert.equal(
    store.node('design').comments.filter((item) => item.body === '请改第二行').length,
    1,
  );
  const previewV1 = previewFixedDelivery(store.node('design').artifactVersions, v1);
  assert.equal(previewV1.ok, true);
  assert.equal(previewV1.preview.text, '第一行\n保留');
  assert.equal(previewV1.preview.diff, '');

  const returned = await service.ballot(session('lin'), {
    ...locate('design', { expectedVersion: version, idempotencyKey: 'return-v1' }),
    roundId,
    artifactVersionId: v1,
    action: 'request-changes',
    comment: '第二行不对',
    unresolvedCommentIds: [pinnedComment.id],
  });
  assert.equal(returned.ok, true, returned.ok ? '' : returned.error.code);
  assert.equal(store.node('design').command.status, 'needs-revision');
  assert.equal(store.node('design').acceptedArtifactVersionId, undefined);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.deepEqual(store.node('publish').handoff.inputRefs, []);
  const returnBallot = store
    .node('design')
    .rounds.find((item) => item.id === roundId)
    .ballots.find((item) => item.action === 'request-changes');
  assert.ok(returnBallot.unresolvedCommentIds.includes(pinnedComment.id));
  const returnComment = store.node('design').comments.find((item) => item.body === '第二行不对');
  assert.equal(returnComment.versionId, v1);
  assert.ok(returnBallot.unresolvedCommentIds.includes(returnComment.id));

  const revised = await service.submit(session('chen'), {
    ...locate('design', {
      expectedVersion: store.node('design').command.version,
      idempotencyKey: 'deliver-v2',
    }),
    text: '第一行\n已改',
  });
  assert.equal(revised.ok, true, revised.ok ? '' : revised.error.code);
  const versions = store.node('design').artifactVersions;
  assert.deepEqual(
    versions.map((item) => item.version),
    [1, 2],
  );
  const v2 = versions[1].id;
  assert.notEqual(store.node('design').currentRoundId, roundId);
  assert.equal(store.node('publish').command.status, 'blocked');
  assert.deepEqual(store.node('publish').handoff.inputRefs, []);
  for (const comment of store.node('design').comments) {
    assert.equal(comment.versionId, v1);
    assert.notEqual(comment.versionId, v2);
  }
  const stale = await service.ballot(session('lin'), {
    ...locate('design', {
      expectedVersion: store.node('design').command.version,
      idempotencyKey: 'note-old',
    }),
    roundId: store.node('design').currentRoundId,
    artifactVersionId: v1,
    action: 'comment',
    comment: '还在评旧版',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale-version');
  assert.equal(
    store.node('design').comments.some((item) => item.body === '还在评旧版'),
    false,
  );
  const currentPreview = previewFixedDelivery(store.node('design').artifactVersions, v2);
  const oldPreview = previewFixedDelivery(store.node('design').artifactVersions, v1);
  assert.equal(currentPreview.preview.text, '第一行\n已改');
  assert.equal(currentPreview.preview.baseVersion, 1);
  assert.match(currentPreview.preview.diff, /^-保留$/m);
  assert.match(currentPreview.preview.diff, /^\+已改$/m);
  assert.equal(oldPreview.preview.text, '第一行\n保留');
  assert.equal(oldPreview.preview.diff.includes('已改'), false);

  const onNew = await service.ballot(session('lin'), {
    ...locate('design', {
      expectedVersion: store.node('design').command.version,
      idempotencyKey: 'note-v2',
    }),
    roundId: store.node('design').currentRoundId,
    artifactVersionId: v2,
    action: 'comment',
    comment: '第二行已看到',
  });
  assert.equal(onNew.ok, true, onNew.ok ? '' : onNew.error.code);
  const v2Comment = store.node('design').comments.find((item) => item.body === '第二行已看到');
  assert.equal(v2Comment.versionId, v2);
  assert.equal(store.node('design').comments.filter((item) => item.versionId === v1).length, 2);

  const accepted = await service.ballot(session('lin'), {
    ...locate('design', {
      expectedVersion: store.node('design').command.version,
      idempotencyKey: 'approve-v2',
    }),
    roundId: store.node('design').currentRoundId,
    artifactVersionId: v2,
    action: 'approve',
  });
  assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.error.code);
  assert.equal(store.node('design').command.status, 'completed');
  assert.equal(store.node('design').acceptedArtifactVersionId, v2);
  assert.equal(store.node('publish').command.status, 'ready');
  assert.deepEqual(store.node('publish').handoff.inputRefs, [
    { sourceNodeId: 'design', artifactVersionId: v2 },
  ]);
});
