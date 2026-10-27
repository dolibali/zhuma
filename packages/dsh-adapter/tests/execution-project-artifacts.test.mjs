import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, writeFile } from 'node:fs/promises';
import { applyWorkbenchCommand, nodeRecordKey } from '@zhuma/agent-core';
import { open, caller, checked, refused } from './execution-service-run-fixture.mjs';
import {
  projectHost,
  projectWorkbench,
  listQuery,
  domainBytes,
} from './execution-project-artifacts-fixture.mjs';

const list = (h, patch) => h.service.projectArtifacts(caller(), listQuery(patch), h.source());
const content = (h, ref) =>
  h.service.projectArtifacts(caller(), { view: 'content', ref }, h.source());
const fileQuery = (ref, uploadId, patch = {}) => ({
  ...ref,
  purpose: 'accepted',
  uploadId,
  mode: 'download',
  ...patch,
});
const latch = () => Promise.withResolvers();

test('project artifacts: actual original JSON list/content are detached zero-write reads, private child facts never enter the projection', async (t) => {
  const h = await projectHost(t);
  const empty = checked(await list(h));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.coverage, 'latest-confirmed-plans');
  const ref = await h.submit('当前固定正文');
  await h.submit('PRIVATE_CHILD_BODY', [], 'private-child');
  h.resetCounts();
  const before = await domainBytes(h.root),
    result = checked(await list(h));
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].ref, ref);
  assert.equal(result.items[0].hasText, true);
  assert.equal(result.items[0].submittedBy, 'outside');
  assert.equal(JSON.stringify(result).includes('PRIVATE_CHILD'), false);
  assert.equal(JSON.stringify(result).includes('当前固定正文'), false);
  assert.equal(Object.hasOwn(result.items[0], 'acceptedAt'), false);
  const body = checked(await content(h, ref));
  assert.equal(body.content.text, '当前固定正文');
  result.items[0].ref.artifactVersionId = 'forged-copy';
  body.content.links.push('https://invalid.example/alias');
  assert.equal(checked(await list(h)).items[0].ref.artifactVersionId, ref.artifactVersionId);
  assert.deepEqual(checked(await content(h, ref)).content.links, []);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
  assert.equal(h.calls.bytes, 0);
});

test('project artifacts: current owner or participant reads accepted content; project visibility and forged caller do not grant it', async (t) => {
  const h = await projectHost(t),
    ref = await h.submit(),
    privateRef = await h.submit('PRIVATE', [], 'private-child');
  const original = h.service.storage.readNode;
  let privateReads = 0;
  h.service.storage.readNode = (location) => {
    if (location.includes('private-child')) privateReads++;
    return original(location);
  };
  try {
    refused(await content(h, privateRef), 'not-found');
    assert.equal(privateReads, 0, 'task authority precedes private node lookup');
    refused(await content(h, { ...ref, projectId: 'foreign' }), 'not-found');
    refused(await content(h, { ...ref, spaceId: 'foreign' }), 'not-found');
    refused(
      await h.service.projectArtifacts(caller('outside'), { view: 'content', ref }, h.source()),
      'unauthenticated',
    );
    // The current task owner need not be an assignee or inherit parent visibility.
    h.setWorkbench((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === ref.taskId ? { ...task, participantIds: ['outside'] } : task,
      ),
    }));
    assert.equal(checked(await content(h, ref)).content.text, '已接受的固定正文');
    h.setWorkbench((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === ref.taskId ? { ...task, ownerId: 'outside' } : task,
      ),
    }));
    refused(await content(h, ref), 'not-found');
    assert.deepEqual(checked(await list(h)).items, []);
  } finally {
    h.service.storage.readNode = original;
  }
});

test('project artifacts: a new confirmed plan with no accepted output never falls back to the old plan', async (t) => {
  const h = await projectHost(t),
    ref = await h.submit();
  h.setWorkbench((state) => {
    const task = state.tasks.find((task) => task.id === ref.taskId);
    const draft = applyWorkbenchCommand(state, {
      type: 'save-task',
      task: { ...task, status: 'draft', title: '新确认计划' },
    });
    return applyWorkbenchCommand(draft, {
      type: 'save-task',
      task: { ...draft.tasks.find((task) => task.id === ref.taskId), status: 'ready' },
    });
  });
  h.resetCounts();
  const before = await domainBytes(h.root);
  assert.deepEqual(checked(await list(h)).items, []);
  refused(await content(h, ref), 'not-found');
  assert.deepEqual(await domainBytes(h.root), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('project artifacts: replaced accepted ref, wrong node/plan and a dangling accepted pointer never redirect to newer content', async (t) => {
  const h = await projectHost(t),
    ref = await h.submit(),
    key = nodeRecordKey(ref),
    node = h.service.readRunNode(ref),
    old = node.artifactVersions[0],
    replacement = { ...old, id: `${old.id}-new`, version: old.version + 1, text: 'NEW_BODY' };
  // Explicit later durable node fact; not a new submission/approval-path claim.
  await h.domain.table('nodes').put(key, {
    ...node,
    artifactVersions: [...node.artifactVersions, replacement],
    acceptedArtifactVersionId: replacement.id,
  });
  h.resetCounts();
  const before = await domainBytes(h.root);
  refused(await content(h, ref), 'not-found');
  refused(await content(h, { ...ref, planId: 'wrong-plan' }), 'not-found');
  refused(await content(h, { ...ref, nodeId: 'work-1' }), 'not-found');
  assert.equal(
    checked(await content(h, { ...ref, artifactVersionId: replacement.id })).content.text,
    'NEW_BODY',
  );
  assert.deepEqual(await domainBytes(h.root), before);
  await h.domain.table('nodes').put(key, { ...node, acceptedArtifactVersionId: 'missing-version' });
  assert.deepEqual(checked(await list(h)).items, []);
  refused(await content(h, { ...ref, artifactVersionId: 'missing-version' }), 'not-found');
});

test('project artifacts: strict bounded queries and absent original authority fail before any body/attachment lookup', async (t) => {
  const h = await projectHost(t);
  refused(
    await h.service.projectArtifacts(caller(), listQuery({ actorId: 'outside' }), h.source()),
    'unknown-field',
  );
  for (const body of [
    listQuery({ limit: 21 }),
    listQuery({ limit: 0 }),
    listQuery({ cursor: { offset: 0 } }),
    listQuery({ projectId: '' }),
    { view: 'content', ref: { ...h.locate(), artifactVersionId: 'missing' } },
  ])
    refused(await h.service.projectArtifacts(caller(), body, h.source()), 'validation');
  assert.equal(h.calls.source, 0);
  refused(await h.service.projectArtifacts(caller(), listQuery()), 'unauthenticated');
  assert.equal(h.calls.bytes, 0);
});

test('project artifacts: lists stop at 200 original node point reads and cursors cannot cross identity/scope or workspace revisions', async (t) => {
  const h = await projectHost(t, {
      workbench: projectWorkbench({ count: 240, privateTask: false }),
    }),
    original = h.service.storage.readNode,
    all = h.service.storage.listNodes;
  let points = 0;
  h.service.storage.readNode = (key) => {
    points++;
    return original(key);
  };
  h.service.storage.listNodes = () =>
    assert.fail('project query cannot scan the global node store');
  try {
    h.resetCounts();
    const first = checked(await list(h));
    assert.equal(points, 200);
    assert.deepEqual(first.items, []);
    assert.ok(first.nextCursor);
    const second = checked(await list(h, { cursor: first.nextCursor }));
    assert.equal(points, 240);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
    refused(
      await h.service.projectArtifacts(
        caller('outside'),
        listQuery({ cursor: first.nextCursor }),
        h.source('outside'),
      ),
      'conflict',
    );
    h.setWorkbench((state) => ({ ...state, revision: state.revision + 1 }));
    refused(await list(h, { cursor: first.nextCursor }), 'conflict');
  } finally {
    h.service.storage.readNode = original;
    h.service.storage.listNodes = all;
  }
});

test('project artifacts: explicit pagination is at most 20 results and cursor position cannot become a content grant', async (t) => {
  const h = await projectHost(t, {
    workbench: projectWorkbench({ count: 21, privateTask: false }),
  });
  for (let index = 0; index < 21; index++)
    await h.submit(`fixed-${index}`, [], 'task', `work-${index}`);
  h.resetCounts();
  const first = checked(await list(h));
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  const second = checked(await list(h, { cursor: first.nextCursor }));
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.ref.nodeId)).size, 21);
  h.setWorkbench((state) => ({
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      ownerId: 'outside',
      participantIds: ['outside'],
    })),
  }));
  refused(await content(h, first.items[0].ref), 'not-found');
});

test('project artifacts: withdrawal while original member authority is opening prevents late content without writes', async (t) => {
  const h = await projectHost(t),
    ref = await h.submit(),
    entered = latch(),
    finish = latch();
  h.hooks.source = async () => {
    entered.resolve();
    await finish.promise;
  };
  h.resetCounts();
  const before = await domainBytes(h.root),
    pending = content(h, ref);
  await entered.promise;
  h.member.abort();
  finish.resolve();
  assert.equal((await pending).ok, false);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
  assert.equal(h.calls.bytes, 0);
});

test('project artifacts: a real local fixed file is readable by current task owner/participant under accepted purpose only', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('文件交付说明', [upload.reference]);
  h.resetCounts();
  const before = await domainBytes(h.root),
    reads = h.calls.bytes;
  const result = checked(await list(h));
  assert.equal(result.items[0].fileCount, 1);
  const detail = checked(await content(h, ref));
  assert.deepEqual(detail.content.files, [upload.reference]);
  assert.equal(h.calls.bytes, reads, 'list and text do not open any attachment stream');
  const { projectId: _project, ...originalRef } = ref;
  refused(
    await h.service.fileContent(
      caller(),
      fileQuery(originalRef, upload.uploadId, { purpose: 'artifact' }),
      h.source(),
    ),
    'not-found',
  );
  const fixed = checked(
    await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
  );
  try {
    fixed.check();
    assert.equal(Buffer.from(fixed.bytes).toString(), '固定文件正文');
    assert.equal(fixed.info.reference.checksum, upload.sha256);
  } finally {
    fixed.release();
  }
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
});

test('project artifacts: held accepted file rechecks task membership/latest accepted pointer at every response check', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('固定说明', [upload.reference]);
  const fixed = checked(
    await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
  );
  try {
    fixed.check();
    h.setWorkbench((state) => ({
      ...state,
      tasks: state.tasks.map((task) =>
        task.id === ref.taskId
          ? { ...task, ownerId: 'outside', participantIds: ['outside'] }
          : task,
      ),
    }));
    assert.throws(() => fixed.check());
  } finally {
    fixed.release();
  }
  refused(
    await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
    'not-found',
  );
});

test('project artifacts: cold original JSON content and actual fixed bytes reopen without domain writes or Run/model creation', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('冷重开正文', [upload.reference]);
  await h.close();
  const before = await domainBytes(h.root),
    cold = await open(h.root, {
      seed: false,
      workbench: h.readWorkbench(),
      attachments: h.attachments,
    });
  const source = async () => ({
    lease: await cold.service.runHost.memberLease(cold.request),
    assertProjectSpace: cold.service.runHost.assertProjectSpace.bind(cold.service.runHost),
  });
  try {
    assert.equal(
      checked(await cold.service.projectArtifacts(caller(), { view: 'content', ref }, source))
        .content.text,
      '冷重开正文',
    );
    const fixed = checked(
      await cold.service.fileContent(caller(), fileQuery(ref, upload.uploadId), source),
    );
    try {
      assert.equal(Buffer.from(fixed.bytes).toString(), '固定文件正文');
    } finally {
      fixed.release();
    }
    assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
    assert.deepEqual(await domainBytes(h.root), before);
  } finally {
    await cold.close();
  }
});

test('project artifacts: original fixed bytes with a changed digest never enter the accepted response', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('固定说明', [upload.reference]),
    path = h.attachmentPath(upload);
  await chmod(path, 0o600);
  const damage = Buffer.from('固定文件正文');
  damage[damage.length - 1] ^= 1;
  await writeFile(path, damage);
  h.resetCounts();
  const before = await domainBytes(h.root);
  assert.equal(
    (await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source())).ok,
    false,
  );
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
});

test('project artifacts: accepted file shares the original eight held response slots and releases them normally', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('固定说明', [upload.reference]),
    responses = [];
  try {
    for (let index = 0; index < 8; index++)
      responses.push(
        checked(await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source())),
      );
    refused(
      await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
      'quota-exceeded',
    );
    responses.shift().release();
    const next = checked(
      await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
    );
    next.release();
  } finally {
    for (const response of responses) response.release();
  }
});

test('project artifacts: membership revoked during original attachment verification returns no late bytes and writes nothing', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('固定说明', [upload.reference]),
    entered = latch(),
    finish = latch();
  h.hooks.beforeBytes = async () => {
    entered.resolve();
    await finish.promise;
  };
  h.resetCounts();
  const before = await domainBytes(h.root),
    pending = h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source());
  await entered.promise;
  h.member.abort();
  finish.resolve();
  assert.equal((await pending).ok, false);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
});

test('project artifacts: accepted-file ref never redirects after pointer replacement or a newer unstarted plan; old assignee artifact gate stays intact', async (t) => {
  const h = await projectHost(t, { file: true }),
    upload = await h.upload(),
    ref = await h.submit('固定说明', [upload.reference]),
    node = h.service.readRunNode(ref),
    key = nodeRecordKey(ref),
    old = node.artifactVersions[0],
    replacement = { ...old, id: `${old.id}-next`, version: old.version + 1 };
  await h.domain.table('nodes').put(key, {
    ...node,
    artifactVersions: [...node.artifactVersions, replacement],
    acceptedArtifactVersionId: replacement.id,
  });
  const beforeReads = h.calls.bytes;
  refused(
    await h.service.fileContent(caller(), fileQuery(ref, upload.uploadId), h.source()),
    'not-found',
  );
  refused(
    await h.service.fileContent(
      caller(),
      fileQuery({ ...ref, artifactVersionId: replacement.id }, 'foreign-upload'),
      h.source(),
    ),
    'not-found',
  );
  assert.equal(h.calls.bytes, beforeReads);
  h.setWorkbench((state) => {
    const current = state.tasks.find((task) => task.id === ref.taskId),
      draft = applyWorkbenchCommand(state, {
        type: 'save-task',
        task: { ...current, status: 'draft' },
      });
    return applyWorkbenchCommand(draft, {
      type: 'save-task',
      task: { ...current, status: 'ready' },
    });
  });
  refused(
    await h.service.fileContent(
      caller(),
      fileQuery({ ...ref, artifactVersionId: replacement.id }, upload.uploadId),
      h.source(),
    ),
    'not-found',
  );
  const { projectId: _project, ...oldRef } = ref;
  const original = checked(
    await h.service.fileContent(
      caller('outside'),
      fileQuery(oldRef, upload.uploadId, { purpose: 'artifact' }),
      h.source('outside'),
    ),
  );
  try {
    assert.equal(Buffer.from(original.bytes).toString(), '固定文件正文');
  } finally {
    original.release();
  }
});

test('project artifacts: full legitimate 100k text stays intact on demand, while oversized durable content cannot escape the read budget', async (t) => {
  const h = await projectHost(t),
    text = '界'.repeat(100_000),
    ref = await h.submit(text);
  h.resetCounts();
  const before = await domainBytes(h.root),
    result = checked(await content(h, ref)),
    metadata = checked(await list(h));
  assert.equal(result.content.text, text);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 128 * 1024);
  assert.equal(JSON.stringify(metadata).includes(text), false);
  assert.deepEqual(await domainBytes(h.root), before);
  const node = h.service.readRunNode(ref);
  await h.domain.table('nodes').put(nodeRecordKey(ref), {
    ...node,
    artifactVersions: node.artifactVersions.map((artifact) => ({ ...artifact, text: `${text}x` })),
  });
  refused(await content(h, ref), 'not-found');
});

test('project artifacts: a qualification change during projection cannot return a partly authorized list', async (t) => {
  const h = await projectHost(t);
  await h.submit();
  let checks = 0;
  h.hooks.project = () => {
    if (++checks !== 3) return;
    h.setWorkbench((state) => ({
      ...state,
      revision: state.revision + 1,
      tasks: state.tasks.map((task) =>
        task.id === 'task' ? { ...task, ownerId: 'outside', participantIds: ['outside'] } : task,
      ),
    }));
  };
  h.resetCounts();
  const before = await domainBytes(h.root);
  refused(await list(h), 'conflict');
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  assert.deepEqual(await domainBytes(h.root), before);
});
