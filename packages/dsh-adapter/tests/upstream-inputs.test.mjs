import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeRecordKey } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { upstreamInputsFor } from '../dist/upstream-inputs.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const secretFile = {
  id: 'secret.pdf',
  mediaType: 'application/pdf',
  byteSize: 12,
  checksum: 'checksum-do-not-leak',
  accessPolicyId: 'task-read',
  uploadComplete: true,
};

test('upstreamInputsFor names the accepted version and hides a source the reader cannot see', () => {
  const views = upstreamInputsFor(
    {
      nodeId: 'publish',
      handoff: {
        inputRefs: [
          { sourceNodeId: 'design', artifactVersionId: 'artifact-2' },
          { sourceNodeId: 'hidden', artifactVersionId: 'artifact-secret' },
        ],
      },
    },
    [
      {
        nodeId: 'design',
        handoff: { goal: '设计登录接口' },
        acceptedArtifactVersionId: 'artifact-2',
        artifactVersions: [
          {
            id: 'artifact-2',
            version: 2,
            text: '错误码说明',
            files: [{ ...secretFile, id: 'spec.pdf' }],
          },
        ],
      },
    ],
  );
  assert.deepEqual(views, [
    {
      access: 'visible',
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: 'artifact-2',
    },
    { access: 'redacted', sourceNodeId: 'hidden' },
  ]);
  const encoded = JSON.stringify(views);
  for (const secret of ['机密', 'secret.pdf', 'spec.pdf', '错误码说明', 'checksum-do-not-leak']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});

function memory() {
  const nodes = new Map();
  const plans = new Map();
  return {
    storage: {
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
    },
  };
}

function stored(fields) {
  return {
    ownerId: 'chen',
    rounds: [],
    receipts: [],
    artifactVersions: [],
    comments: [],
    command: { status: 'ready', version: 1 },
    ...fields,
    handoff: {
      assignee: { id: 'chen', kind: 'human' },
      reviewerIds: [],
      dependencyNodeIds: [],
      goal: '发布登录说明',
      expectedOutput: '说明',
      inputRefs: [],
      ...fields.handoff,
    },
  };
}

test('inbox shows an accepted upstream reference and withholds another task', async () => {
  const { state } = fixture();
  state.tasks.push({
    id: 'other',
    projectId: 'project',
    ownerId: 'lin',
    participantIds: ['lin'],
    title: '其他任务',
    goal: '其他',
    workflows: [],
    status: 'ready',
    updatedAt: '2026-10-22T00:00:00.000Z',
  });
  const store = memory();
  const plan = { idempotencyKey: 'plan', fingerprint: 'plan', nodeIds: ['design', 'publish'] };
  await store.storage.writePlan('task:plan:1', plan);
  await store.storage.writePlan('other:plan:1', {
    idempotencyKey: 'other',
    fingerprint: 'other',
    nodeIds: ['hidden'],
  });
  const design = stored({
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
    command: { status: 'completed', version: 2 },
    acceptedArtifactVersionId: 'artifact-2',
    handoff: { goal: '设计登录接口', dependencyNodeIds: [] },
    artifactVersions: [
      {
        id: 'artifact-2',
        nodeId: 'design',
        version: 2,
        text: '错误码说明',
        files: [{ ...secretFile, id: 'spec.pdf' }],
        links: [],
        submittedBy: 'chen',
      },
    ],
  });
  const publish = stored({
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'publish',
    handoff: {
      goal: '发布登录说明',
      dependencyNodeIds: ['design', 'hidden'],
      inputRefs: [
        { sourceNodeId: 'design', artifactVersionId: 'artifact-2' },
        { sourceNodeId: 'hidden', artifactVersionId: 'artifact-secret' },
      ],
    },
  });
  const hidden = stored({
    taskId: 'other',
    planId: 'plan',
    revision: 1,
    nodeId: 'hidden',
    ownerId: 'lin',
    command: { status: 'completed', version: 2 },
    acceptedArtifactVersionId: 'artifact-secret',
    handoff: {
      assignee: { id: 'lin', kind: 'human' },
      goal: '机密目标',
    },
    artifactVersions: [
      {
        id: 'artifact-secret',
        nodeId: 'hidden',
        version: 4,
        text: '机密正文',
        files: [secretFile],
        links: ['https://example.test/secret'],
        submittedBy: 'lin',
      },
    ],
  });
  for (const record of [design, publish, hidden]) {
    await store.storage.writeNode(nodeRecordKey(record), record);
  }
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
  );
  const inbox = await service.inbox(
    { member: { ok: true, memberId: 'chen', spaceIds: ['project'] } },
    {},
  );
  assert.equal(inbox.ok, true);
  const node = inbox.value.nodes.find((item) => item.nodeId === 'publish');
  assert.deepEqual(node.inputs, [
    {
      access: 'visible',
      sourceNodeId: 'design',
      sourceGoal: '设计登录接口',
      version: 2,
      name: 'artifact-2',
    },
    { access: 'redacted', sourceNodeId: 'hidden' },
  ]);
  const encoded = JSON.stringify(inbox.value);
  for (const secret of ['机密目标', '机密正文', 'secret.pdf', 'spec.pdf', 'checksum-do-not-leak']) {
    assert.equal(encoded.includes(secret), false, secret);
  }
});
