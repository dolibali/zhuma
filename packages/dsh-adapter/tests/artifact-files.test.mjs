import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { openArtifactFileStore } from '../dist/artifact-files.js';
import { applyWorkbenchCommand, emptyWorkbench, nodeRecordKey } from '@zhuma/agent-core';

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

// Contract leases for isolated service tests; HTTP tests use the real issuer.
function contractLease(caller) {
  return {
    memberId: caller.member.memberId,
    expiresAt: Date.now() + 120_000,
    signal: new AbortController().signal,
    assertCurrent() {},
    release() {},
  };
}
function uploadFile(service, caller, options) {
  return service.uploadFile(caller, options, {
    lease: contractLease(caller),
    assertProjectSpace() {},
  });
}

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
  const upload = await uploadFile(service, session('chen'), {
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
  const replay = await uploadFile(service, session('chen'), {
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
  const mismatch = await uploadFile(service, session('chen'), {
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
  const wrongDigest = await uploadFile(service, session('chen'), {
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
  const over = await uploadFile(service, session('chen'), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: 21 * 1024 * 1024, sha256 },
    idempotencyKey: 'u-over',
  });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'file-too-large');

  // Non-assignee.
  const notAssignee = await uploadFile(service, session('outside'), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: content.length, sha256 },
    idempotencyKey: 'u-not-assignee',
  });
  assert.equal(notAssignee.ok, false);

  // Wrong scope.
  const wrongScope = await uploadFile(service, session('chen', ['south']), {
    ...base,
    declare: { name: 'a.md', mediaType: 'text/markdown', byteSize: content.length, sha256 },
    idempotencyKey: 'u-wrong-scope',
  });
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.error.code, 'not-found');

  // Missing provider.
  const noProvider = new ExecutionService(memory().storage, { readWorkbench: () => state }, spaces);
  const refused = await uploadFile(noProvider, session('chen'), {
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
  const upload = await uploadFile(service, session('chen'), {
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

/** Real published SDK bytes/JSON ledger; execution records and leases are contracts. */
async function realFiles(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-file-admission-'));
  const ctx = new Context();
  const fibers = [];
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root: join(root, 'metadata') }],
    [Domain, { backend: 'json' }],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const attachments = new LocalAttachmentStore(ctx, { dshHome: root });
  const files = await openArtifactFileStore(ctx);
  const state = fixtureState();
  const store = memory();
  const service = new ExecutionService(
    store.storage,
    { readWorkbench: () => state },
    spaces,
    attachments,
    files,
  );
  const plan = await startNode(service, state);
  const options = (content = 'actual bytes', extra = {}) => ({
    declare: {
      name: '接口说明🙂.md',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    },
    taskId: plan.taskId,
    planId: plan.id,
    revision: plan.revision,
    nodeId: 'design',
    spaceId: 'north',
    idempotencyKey: randomUUID(),
    data: bytesOf(content),
    ...extra,
  });
  t.after(async () => {
    await service.closeUploads();
    await service.closeFileReads();
    await files.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, ctx, service, attachments, files, store, plan, options };
}

async function attachmentFiles(root) {
  const entries = await readdir(join(root, 'attachments'), {
    recursive: true,
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

test('actual SDK: wrong digest/length leave no CAS, alias, temp or ledger', async (t) => {
  for (const [name, mismatch] of [
    ['digest', { sha256: '0'.repeat(64) }],
    ['length', { byteSize: 1 }],
  ]) {
    await t.test(name, async (t) => {
      const f = await realFiles(t);
      const request = f.options();
      request.declare = { ...request.declare, ...mismatch };
      const result = await uploadFile(f.service, session('chen'), request);
      assert.equal(result.error.code, 'digest-mismatch');
      await f.service.closeUploads();
      assert.deepEqual(await attachmentFiles(f.root), []);
      assert.equal(f.files.countInSpace('north'), 0);
    });
  }
});

function fileAuthority(caller = session('chen')) {
  return async () => ({ lease: contractLease(caller), assertProjectSpace() {} });
}

test('fixed file submission trusts the receipt, supports files only and replays one immutable version', async (t) => {
  const f = await realFiles(t);
  const uploaded = await uploadFile(f.service, session('chen'), f.options('fixed artifact bytes'));
  assert.equal(uploaded.ok, true);
  const reference = uploaded.value.reference;
  assert.equal(reference.id, uploaded.value.uploadId);
  const request = {
    taskId: f.plan.taskId,
    planId: f.plan.id,
    revision: f.plan.revision,
    nodeId: 'design',
    expectedVersion: f.store.node('design').command.version,
    idempotencyKey: 'submit-file-only',
    files: [{ ...reference, uploadComplete: false }],
  };
  const result = await f.service.submit(session('chen'), request, fileAuthority());
  assert.equal(result.ok, true, JSON.stringify(result));
  const artifact = f.store.node('design').artifactVersions.at(-1);
  assert.equal(artifact.files[0].uploadComplete, true);
  assert.equal(artifact.files[0].checksum, uploaded.value.sha256);
  assert.equal(artifact.files[0].id, uploaded.value.uploadId);
  const replay = await f.service.submit(session('chen'), request, fileAuthority());
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.value.disposition, 'replayed');
  assert.equal(f.store.node('design').artifactVersions.length, 1);
  const fixedFacts = f.store.snapshot();
  const publicArtifact = replay.value.node.artifacts.at(-1);
  publicArtifact.id = 'caller-edited';
  publicArtifact.files[0].checksum = '0'.repeat(64);
  publicArtifact.files.push({ ...reference });
  publicArtifact.links.push('https://example.test/caller-edited');
  assert.equal(
    f.store.snapshot(),
    fixedFacts,
    'A returned artifact DTO cannot rewrite fixed facts',
  );
});

test('forged file metadata and UUIDs never create a fixed artifact', async (t) => {
  const f = await realFiles(t);
  const uploaded = await uploadFile(f.service, session('chen'), f.options());
  const before = f.store.snapshot();
  const base = {
    taskId: f.plan.taskId,
    planId: f.plan.id,
    revision: f.plan.revision,
    nodeId: 'design',
    expectedVersion: f.store.node('design').command.version,
    idempotencyKey: 'forged-ref',
    files: [uploaded.value.reference],
  };
  for (const changed of [
    { id: randomUUID() },
    { checksum: '0'.repeat(64) },
    { mediaType: 'text/plain' },
    { byteSize: 0 },
    { accessPolicyId: 'owner' },
  ]) {
    const result = await f.service.submit(
      session('chen'),
      { ...base, files: [{ ...base.files[0], ...changed, uploadComplete: true }] },
      fileAuthority(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'not-found');
    assert.equal(f.store.snapshot(), before);
  }
  const denied = await f.service.submit(session('chen'), base);
  assert.equal(denied.error.code, 'unauthenticated');
  assert.equal(f.store.snapshot(), before);
});

test('equal-length corrupted SDK bytes fail before a fixed artifact or event is written', async (t) => {
  const f = await realFiles(t);
  const bytes = Buffer.from('the immutable version must preserve every byte');
  const uploaded = await uploadFile(f.service, session('chen'), f.options(bytes.toString()));
  const path = f.attachments.fileHostPath({
    attachmentId: uploaded.value.attachmentId,
    name: uploaded.value.name,
    bytes: uploaded.value.bytes,
  });
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  await chmod(path, 0o600);
  await writeFile(path, damaged);
  const before = f.store.snapshot();
  const result = await f.service.submit(
    session('chen'),
    {
      taskId: f.plan.taskId,
      planId: f.plan.id,
      revision: f.plan.revision,
      nodeId: 'design',
      expectedVersion: f.store.node('design').command.version,
      idempotencyKey: 'corrupt-fixed',
      files: [uploaded.value.reference],
    },
    fileAuthority(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unavailable');
  assert.equal(f.store.snapshot(), before);
});

test('verified read responses retain their eight slots until consumed or released', async (t) => {
  const f = await realFiles(t);
  const file = await uploadFile(f.service, session('chen'), f.options('owned response bytes'));
  const query = {
    taskId: f.plan.taskId,
    planId: f.plan.id,
    revision: f.plan.revision,
    nodeId: 'design',
    spaceId: 'north',
    uploadId: file.value.uploadId,
    purpose: 'draft',
    mode: 'download',
  };
  const responses = [];
  try {
    for (let i = 0; i < 8; i++) {
      const response = await f.service.fileContent(session('chen'), query, fileAuthority());
      assert.equal(response.ok, true, JSON.stringify(response));
      responses.push(response.value);
    }
    const ninth = await f.service.fileContent(session('chen'), query, fileAuthority());
    assert.equal(ninth.error.code, 'quota-exceeded');
    responses.shift().release();
    await new Promise(setImmediate);
    const retry = await f.service.fileContent(session('chen'), query, fileAuthority());
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(Buffer.from(retry.value.bytes).toString(), 'owned response bytes');
    retry.value.release();
  } finally {
    for (const response of responses) response.release();
  }
});

test('authorized metadata and completed draft projections never alias durable upload or draft facts', async (t) => {
  const f = await realFiles(t);
  const file = await uploadFile(f.service, session('chen'), f.options());
  const query = {
    taskId: f.plan.taskId,
    planId: f.plan.id,
    revision: f.plan.revision,
    nodeId: 'design',
  };
  const saved = await f.service.draft(
    session('chen'),
    {
      ...query,
      expectedVersion: 0,
      idempotencyKey: 'owned-draft',
      text: '原始正文',
      links: ['https://example.test/reference'],
      files: [file.value.reference],
    },
    fileAuthority(),
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));
  saved.value.links.push('https://example.test/forged');
  saved.value.files[0].checksum = '0'.repeat(64);
  saved.value.fileDetails[0].name = 'forged';
  const read = await f.service.fileContent(
    session('chen'),
    {
      ...query,
      spaceId: 'north',
      uploadId: file.value.uploadId,
      purpose: 'draft',
      mode: 'metadata',
    },
    fileAuthority(),
  );
  assert.equal(read.ok, true);
  read.value.info.reference.checksum = '0'.repeat(64);
  read.value.info.request.nodeId = 'foreign';
  read.value.release();
  const restored = await f.service.draft(session('chen'), query, fileAuthority());
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value.links, ['https://example.test/reference']);
  assert.equal(restored.value.files[0].checksum, file.value.sha256);
  assert.equal(restored.value.fileDetails[0].name, file.value.name);
  assert.equal(f.files.get(file.value.uploadId).sha256, file.value.sha256);
});

test('actual SDK: all durable fields are rejected before reading, and media type binds replay', async (t) => {
  const f = await realFiles(t);
  let reads = 0;
  const data = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield Buffer.from('x');
    },
  };
  const invalid = await uploadFile(
    f.service,
    session('chen'),
    f.options('x', { idempotencyKey: 'x'.repeat(101), data }),
  );
  assert.equal(invalid.error.code, 'validation');
  assert.equal(reads, 0);
  assert.deepEqual(await attachmentFiles(f.root), []);
  const request = f.options();
  const first = await uploadFile(f.service, session('chen'), request);
  assert.equal(first.ok, true, JSON.stringify(first));
  const changed = await uploadFile(f.service, session('chen'), {
    ...request,
    declare: { ...request.declare, mediaType: 'text/plain' },
    data,
  });
  assert.equal(changed.error.code, 'idempotency-mismatch');
  assert.equal(reads, 0);
  const replay = await uploadFile(f.service, session('chen'), {
    ...request,
    data: bytesOf('actual bytes'),
  });
  assert.deepEqual(replay, first);
  assert.equal(f.files.countInSpace('north'), 1);
  const chunks = [];
  for await (const chunk of f.attachments.readFileStream({
    attachmentId: first.value.attachmentId,
    name: first.value.name,
    bytes: first.value.bytes,
  }))
    chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'actual bytes');
});

test('actual SDK wrapped failure preserves the byte-cap code and deletes staging files', async (t) => {
  const f = await realFiles(t);
  const request = f.options('x', {
    data: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 21; i++) yield new Uint8Array(1024 * 1024);
      },
    },
  });
  const result = await uploadFile(f.service, session('chen'), request);
  assert.equal(result.error.code, 'file-too-large');
  await f.service.closeUploads();
  assert.deepEqual(await attachmentFiles(f.root), []);
  assert.equal(f.files.countInSpace('north'), 0);
});

function stalledSource() {
  const entered = Promise.withResolvers();
  const next = Promise.withResolvers();
  let cancelled = 0;
  return {
    entered: entered.promise,
    get cancelled() {
      return cancelled;
    },
    data: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        entered.resolve();
        return next.promise;
      },
      async return() {
        cancelled++;
        next.resolve({ done: true });
        return { done: true };
      },
    },
  };
}

test('actual SDK: stalled initial read aborts promptly and cleanup really settles', async (t) => {
  const f = await realFiles(t);
  const source = stalledSource();
  const controller = new AbortController();
  const operation = uploadFile(
    f.service,
    session('chen'),
    f.options('x', { data: source.data, signal: controller.signal }),
  );
  await source.entered;
  controller.abort();
  assert.equal((await operation).error.code, 'cancelled');
  await f.service.closeUploads();
  assert.equal(source.cancelled, 1);
  assert.deepEqual(await attachmentFiles(f.root), []);
  assert.equal(f.files.countInSpace('north'), 0);
});

test('same-key replay uses a real deadline even while next is stalled', async (t) => {
  const f = await realFiles(t);
  const request = f.options();
  assert.equal((await uploadFile(f.service, session('chen'), request)).ok, true);
  const source = stalledSource();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = uploadFile(f.service, session('chen'), { ...request, data: source.data });
  await source.entered;
  t.mock.timers.tick(60_001);
  assert.equal((await operation).error.code, 'upload-timeout');
  await f.service.closeUploads();
  assert.equal(source.cancelled, 1);
  assert.equal(f.files.countInSpace('north'), 1);
});

test('a paused SDK upload does not hold the execution command queue', async (t) => {
  const f = await realFiles(t);
  const source = stalledSource();
  const controller = new AbortController();
  const operation = uploadFile(
    f.service,
    session('chen'),
    f.options('x', { data: source.data, signal: controller.signal }),
  );
  try {
    await source.entered;
    const read = f.service.inbox(session('chen'), { spaceId: 'north' });
    const result = await Promise.race([
      read,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 250)),
    ]);
    assert.notEqual(result, 'blocked', 'A held next() must not delay another authorized command');
    assert.equal(result.ok, true);
  } finally {
    controller.abort();
    assert.equal((await operation).error.code, 'cancelled');
  }
});

test('in-flight same-key requests cannot publish a second object or consume another body', async (t) => {
  const f = await realFiles(t);
  const source = stalledSource();
  const controller = new AbortController();
  const request = f.options('x', { data: source.data, signal: controller.signal });
  const active = uploadFile(f.service, session('chen'), request);
  let reads = 0;
  const data = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield Buffer.from('x');
    },
  };
  try {
    await source.entered;
    const same = await uploadFile(f.service, session('chen'), { ...request, data });
    assert.equal(same.error.code, 'conflict');
    assert.equal(same.error.details.reason, 'upload-in-progress');
    const changed = await uploadFile(f.service, session('chen'), {
      ...request,
      data,
      declare: { ...request.declare, mediaType: 'text/plain' },
    });
    assert.equal(changed.error.code, 'idempotency-mismatch');
    assert.equal(reads, 0);
  } finally {
    controller.abort();
    await active;
  }
  await f.service.closeUploads();
  assert.equal(f.files.countInSpace('north'), 0);
  assert.deepEqual(await attachmentFiles(f.root), []);
});

test('the complete plan receipt and exact durable locator are required before any body read', async (t) => {
  const f = await realFiles(t);
  const request = f.options();
  const key = `${f.plan.taskId}:${f.plan.id}:${f.plan.revision}`;
  const receipt = f.store.storage.readPlan(key);
  let reads = 0;
  request.data = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield Buffer.from('actual bytes');
    },
  };
  await f.store.storage.writePlan(key, { ...receipt, nodeIds: ['missing-node'] });
  assert.equal(
    (await uploadFile(f.service, session('chen'), request)).error.code,
    'plan-incomplete',
  );
  await f.store.storage.writePlan(key, receipt);
  const node = f.store.node('design');
  await f.store.storage.writeNode(nodeRecordKey(request), { ...node, taskId: 'foreign-task' });
  assert.equal((await uploadFile(f.service, session('chen'), request)).error.code, 'not-found');
  assert.equal(reads, 0);
  assert.deepEqual(await attachmentFiles(f.root), []);
});

test('a late provider stays owned after cancellation and cannot commit a delayed receipt', async (t) => {
  const f = await realFiles(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const save = f.attachments.saveFileStream.bind(f.attachments);
  f.attachments.saveFileStream = async (input) => {
    const ref = await save(input); // Real valid CAS bytes exist; only the reply is held.
    entered.resolve();
    await release.promise;
    return ref;
  };
  const controller = new AbortController();
  const request = f.options('valid held bytes', { signal: controller.signal });
  const operation = uploadFile(f.service, session('chen'), request);
  await entered.promise;
  controller.abort();
  assert.equal((await operation).error.code, 'cancelled');
  const retry = await uploadFile(f.service, session('chen'), {
    ...request,
    signal: undefined,
    data: bytesOf('valid held bytes'),
  });
  assert.equal(
    retry.error.code,
    'conflict',
    'The actual held resource retains its key reservation',
  );
  let closed = false;
  const closing = f.service.closeUploads().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false, 'Logical cancellation cannot pretend a held provider has drained');
  release.resolve();
  await closing;
  assert.equal(f.files.countInSpace('north'), 0);
});

test('only eight real streams in a space can reserve resources, with no ninth body read', async (t) => {
  const f = await realFiles(t);
  const controllers = [],
    operations = [];
  try {
    for (let i = 0; i < 8; i++) {
      const source = stalledSource(),
        controller = new AbortController();
      controllers.push(controller);
      operations.push(
        uploadFile(
          f.service,
          session('chen'),
          f.options('x', { data: source.data, signal: controller.signal }),
        ),
      );
      await source.entered;
    }
    let reads = 0;
    const refused = await uploadFile(
      f.service,
      session('chen'),
      f.options('x', {
        data: {
          async *[Symbol.asyncIterator]() {
            reads++;
            yield Buffer.from('x');
          },
        },
      }),
    );
    assert.equal(refused.error.code, 'quota-exceeded');
    assert.equal(reads, 0);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(operations);
    await f.service.closeUploads();
  }
  assert.deepEqual(await attachmentFiles(f.root), []);
  assert.equal(f.files.countInSpace('north'), 0);
});

test('project assertions must decide synchronously with undefined before any SDK body read', async (t) => {
  for (const [name, value] of [
    ['async', Promise.resolve()],
    ['false', false],
  ])
    await t.test(name, async (t) => {
      const f = await realFiles(t);
      let reads = 0;
      const request = f.options('x', {
        data: {
          async *[Symbol.asyncIterator]() {
            reads++;
            yield Buffer.from('x');
          },
        },
      });
      const result = await f.service.uploadFile(session('chen'), request, {
        lease: contractLease(session('chen')),
        assertProjectSpace() {
          return value;
        },
      });
      assert.equal(result.error.code, 'not-found');
      assert.equal(reads, 0);
      assert.equal(f.files.countInSpace('north'), 0);
      assert.deepEqual(await attachmentFiles(f.root), []);
    });
});
