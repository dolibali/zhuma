import assert from 'node:assert/strict';
import test from 'node:test';
import { upstreamInputsFor } from '../dist/upstream-inputs.js';

const hidden = (count) => ({
  access: 'hidden',
  blocking: true,
  count,
  message: `有 ${count} 个上游来源你没有权限查看。`,
});

test('upstream inputs match task, plan, revision, and node, and hide the idempotency key', () => {
  const cited = 'artifact:idem-key-4e1';
  const views = upstreamInputsFor(
    {
      nodeId: 'node-2',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      handoff: {
        inputRefs: [
          { sourceNodeId: 'node-1', artifactVersionId: cited },
          { sourceNodeId: 'node-3', artifactVersionId: 'artifact:old' },
          { sourceNodeId: 'node-4', artifactVersionId: 'artifact:old' },
          { sourceNodeId: 'node-absent-4e1', artifactVersionId: 'ver-absent-4e1' },
        ],
      },
    },
    [
      {
        nodeId: 'node-1',
        taskId: 'task-peer-4e1',
        planId: 'plan',
        revision: 1,
        handoff: { goal: '别的任务目标' },
        acceptedArtifactVersionId: cited,
        artifactVersions: [{ id: cited, version: 9, text: '别的正文' }],
      },
      {
        nodeId: 'node-1',
        taskId: 'task',
        planId: 'plan',
        revision: 2,
        handoff: { goal: '另一版本目标' },
        acceptedArtifactVersionId: cited,
        artifactVersions: [{ id: cited, version: 8 }],
      },
      {
        nodeId: 'node-1',
        taskId: 'task',
        planId: 'plan-other-4e1',
        revision: 1,
        handoff: { goal: '另一计划目标' },
        acceptedArtifactVersionId: cited,
        artifactVersions: [{ id: cited, version: 7 }],
      },
      {
        nodeId: 'node-1',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        handoff: { goal: '本计划目标' },
        acceptedArtifactVersionId: cited,
        artifactVersions: [
          {
            id: cited,
            version: 2,
            text: '错误码说明',
            files: [{ id: 'spec.pdf', checksum: 'checksum-do-not-leak' }],
          },
        ],
      },
      {
        nodeId: 'node-3',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        handoff: { goal: '还在写' },
      },
      {
        nodeId: 'node-4',
        taskId: 'task',
        planId: 'plan',
        revision: 1,
        handoff: { goal: '已经改过' },
        acceptedArtifactVersionId: 'artifact:new-key-4e1',
        artifactVersions: [{ id: 'artifact:new-key-4e1', version: 3, text: '新正文' }],
      },
    ],
  );
  const encoded = JSON.stringify(views);
  for (const secret of [
    'idem-key-4e1',
    'new-key-4e1',
    '别的任务目标',
    '另一版本目标',
    '另一计划目标',
    'task-peer-4e1',
    'plan-other-4e1',
    'node-absent-4e1',
    'ver-absent-4e1',
    'spec.pdf',
    'checksum-do-not-leak',
    '错误码说明',
    '新正文',
  ]) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  assert.deepEqual(views, [
    {
      access: 'visible',
      blocking: false,
      sourceNodeId: 'node-1',
      sourceGoal: '本计划目标',
      version: 2,
      name: '第 2 版',
    },
    {
      access: 'pending',
      pending: 'none',
      blocking: false,
      sourceNodeId: 'node-3',
      message: '上游节点 node-3 尚无已接受版本。',
    },
    {
      access: 'pending',
      pending: 'replaced',
      blocking: false,
      sourceNodeId: 'node-4',
      message: '上游节点 node-4 已有新的已接受版本，当前引用的版本已被取代。',
    },
    hidden(1),
  ]);
});

test('hidden upstream sources are one count, not one row each', () => {
  const views = upstreamInputsFor(
    {
      nodeId: 'publish',
      taskId: 'task',
      planId: 'plan',
      revision: 1,
      handoff: {
        inputRefs: [
          { sourceNodeId: 'secret-a-4e1', artifactVersionId: 'ver-a-4e1' },
          { sourceNodeId: 'secret-b-4e1', artifactVersionId: 'ver-b-4e1' },
        ],
      },
    },
    [],
  );
  assert.equal(views.length, 1);
  assert.deepEqual(views, [hidden(2)]);
  const encoded = JSON.stringify(views);
  for (const secret of ['secret-a-4e1', 'secret-b-4e1', 'ver-a-4e1', 'ver-b-4e1']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});
