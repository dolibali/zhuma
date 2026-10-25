import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { openArtifactFileStore } from '../dist/artifact-files.js';
import { applyWorkbenchCommand, emptyWorkbench } from '@zhuma/agent-core';

/** In-memory attachment store that computes the real digest from the bytes. */
function memoryAttachments() {
  const objects = new Map();
  return {
    async saveFileStream(input) {
      const chunks = [];
      for await (const chunk of input.data) chunks.push(chunk);
      const data = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const sha256 = createHash('sha256').update(data).digest('hex');
      const attachmentId = `sha256:${sha256}`;
      objects.set(attachmentId, data);
      return { attachmentId, name: input.name ?? 'file', bytes: data.byteLength };
    },
    async *readFileStream(ref) {
      const data = objects.get(ref.attachmentId);
      if (!data) throw new Error('missing');
      yield new Uint8Array(data);
    },
  };
}

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
    listPlans: () => [...plans.entries()],
  };
  return {
    storage,
    node: (id) => [...nodes.values()].find((record) => record.nodeId === id),
    snapshot: () => JSON.stringify({ nodes: [...nodes], plans: [...plans] }),
  };
}

function mountFiles(shared = {}) {
  const ctx = new Context();
  const media = shared.media ?? new Map();
  const kv = {
    media,
    async open(descriptor) {
      let medium = media.get(descriptor.name);
      if (medium === undefined) {
        medium = { tables: new Map(), global: null };
        media.set(descriptor.name, medium);
      }
      return {
        async loadAll() {
          const tables = {};
          for (const table of descriptor.tables) {
            tables[table] = Object.fromEntries(medium.tables.get(table) ?? []);
          }
          return { tables, global: medium.global };
        },
        async putRecord(table, key, value) {
          const records = medium.tables.get(table) ?? new Map();
          medium.tables.set(table, records);
          records.set(key, structuredClone(value));
        },
        async deleteRecord(table, key) {
          medium.tables.get(table)?.delete(key);
        },
        async setGlobal(value) {
          medium.global = structuredClone(value);
        },
        async close() {},
      };
    },
  };
  ctx.provide('storage', { backend: { get: () => ({ kv, close: async () => {} }) } });
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory', routes: {} }));
  return { ctx, media };
}

function workflowNode(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function fixtureState() {
  const state = emptyWorkbench();
  let next = applyWorkbenchCommand(state, {
    type: 'save-project',
    project: { id: 'portal', name: '客户门户', description: '' },
  });
  next = applyWorkbenchCommand(next, {
    type: 'save-participant',
    participant: {
      id: 'chen',
      name: '陈宁',
      kind: 'human',
      role: '',
      capabilities: [],
      instructions: '',
      available: true,
    },
  });
  next = applyWorkbenchCommand(next, {
    type: 'save-task',
    task: {
      id: 'portal-task',
      projectId: 'portal',
      title: '门户登录',
      goal: '交付登录流程',
      participantIds: ['chen'],
      ownerId: 'chen',
      workflows: [
        {
          id: 'root',
          name: '工作流',
          parentNodeId: null,
          nodes: [workflowNode({ id: 'design', title: '设计' })],
        },
      ],
      status: 'ready',
      updatedAt: '2026-10-25T00:00:00.000Z',
    },
  });
  return next;
}

const spaces = boundedProjectSpaces([{ projectId: 'portal', spaceId: 'north' }]);
const session = (memberId, spaceIds = ['north']) => ({ member: { ok: true, memberId, spaceIds } });

async function* bytesOf(text) {
  yield new TextEncoder().encode(text);
}

async function startNode(service, state) {
  const applied = state.appliedPlans.at(-1);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  return applied;
}

test('upload computes the real digest and issues a trusted receipt; declaration only diagnoses', async () => {
  const state = fixtureState();
  const { ctx } = mountFiles();
  const fileStore = await openArtifactFileStore(ctx);
  const store = memory();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    spaces,
    memoryAttachments(),
    fileStore,
  );
  const applied = await startNode(service, state);

  const content = '接口说明文件正文';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const upload = await service.uploadFile(session('chen'), {
    declare: {
      name: 'spec.md',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(content),
      sha256,
    },
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    spaceId: 'north',
    idempotencyKey: 'upload-spec-1',
    data: bytesOf(content),
  });
  assert.equal(upload.ok, true, JSON.stringify(upload.ok ? '' : upload.error));
  if (!upload.ok) return;
  assert.equal(upload.value.sha256, sha256);
  assert.equal(upload.value.bytes, Buffer.byteLength(content));
  assert.equal(upload.value.name, 'spec.md');
  assert.ok(upload.value.uploadId.length > 0);
  assert.ok(upload.value.attachmentId.startsWith('sha256:'));

  // Same key replays the same receipt.
  const replay = await service.uploadFile(session('chen'), {
    declare: {
      name: 'spec.md',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(content),
      sha256,
    },
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    spaceId: 'north',
    idempotencyKey: 'upload-spec-1',
    data: bytesOf(content),
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.value.uploadId, upload.value.uploadId);

  // Same key with a different declared digest refuses.
  const mismatch = await service.uploadFile(session('chen'), {
    declare: {
      name: 'spec.md',
      mediaType: 'text/markdown',
      byteSize: content.length,
      sha256: '0'.repeat(64),
    },
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    spaceId: 'north',
    idempotencyKey: 'upload-spec-1',
    data: bytesOf(content),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'idempotency-mismatch');
});

test('upload refuses: wrong digest, oversize, non-assignee, wrong scope, missing provider', async () => {
  const state = fixtureState();
  const { ctx } = mountFiles();
  const fileStore = await openArtifactFileStore(ctx);
  const store = memory();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    spaces,
    memoryAttachments(),
    fileStore,
  );
  const applied = await startNode(service, state);
  const content = '正文';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const base = {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    spaceId: 'north',
    data: bytesOf(content),
  };

  // Declared digest does not match the real bytes.
  const wrongDigest = await service.uploadFile(session('chen'), {
    ...base,
    declare: {
      name: 'a.md',
      mediaType: 'text/markdown',
      byteSize: content.length,
      sha256: '0'.repeat(64),
    },
    idempotencyKey: 'u-wrong-digest',
  });
  assert.equal(wrongDigest.ok, false);
  assert.equal(wrongDigest.error.code, 'digest-mismatch');
  assert.equal(fileStore.countInSpace('north'), 0);

  // Oversize refuses before reading.
  const over = await service.uploadFile(session('chen'), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: 21 * 1024 * 1024, sha256 },
    idempotencyKey: 'u-over',
  });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'file-too-large');

  // Non-assignee.
  const notAssignee = await service.uploadFile(session('outside'), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: content.length, sha256 },
    idempotencyKey: 'u-not-assignee',
  });
  assert.equal(notAssignee.ok, false);

  // Wrong scope.
  const wrongScope = await service.uploadFile(session('chen', ['south']), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: content.length, sha256 },
    idempotencyKey: 'u-wrong-scope',
  });
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.error.code, 'not-found');

  // Missing provider.
  const noProvider = new ExecutionService(memory().storage, { readWorkbench: () => state }, spaces);
  const refused = await noProvider.uploadFile(session('chen'), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: content.length, sha256 },
    idempotencyKey: 'u-no-provider',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'unavailable');
});

test('upload receipts survive a reopen on the same medium', async () => {
  const state = fixtureState();
  const media = new Map();
  const firstMount = mountFiles({ media });
  const firstStore = await openArtifactFileStore(firstMount.ctx);
  const store = memory();
  const attachments = memoryAttachments();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    spaces,
    attachments,
    firstStore,
  );
  const applied = await startNode(service, state);
  const content = '持久化验证';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const upload = await service.uploadFile(session('chen'), {
    declare: {
      name: 'persist.md',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(content),
      sha256,
    },
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    spaceId: 'north',
    idempotencyKey: 'upload-persist',
    data: bytesOf(content),
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) return;
  await firstStore.close();

  const secondMount = mountFiles({ media });
  const secondStore = await openArtifactFileStore(secondMount.ctx);
  const found = secondStore.findByIdempotencyKey('upload-persist');
  assert.ok(found);
  assert.equal(found.sha256, sha256);
  await secondStore.close();
});
