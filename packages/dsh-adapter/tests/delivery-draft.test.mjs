import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
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

function confirm() {
  const { state, task } = fixture();
  state.participants.push(lin);
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...task.workflows[0].nodes[0],
              id: 'design',
              assigneeId: 'chen',
              reviewerIds: ['lin'],
              reviewRequired: true,
              dependsOn: [],
            },
          ],
        },
      ],
      status: 'ready',
    },
  });
  return { state: ready, applied: ready.appliedPlans.at(-1) };
}

function session(memberId, spaceIds = ['project']) {
  return { member: { ok: true, memberId, spaceIds } };
}

function locate(applied, extra = {}) {
  return {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    nodeId: 'design',
    ...extra,
  };
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
}

const spaces = boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]);

async function opened() {
  const { state, applied } = confirm();
  const store = memory();
  const service = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const started = await service.startPlan(session('chen'), {
    taskId: applied.taskId,
    planId: applied.id,
    revision: applied.revision,
    idempotencyKey: 'start-1',
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error.code);
  assert.equal(store.node('design').command.status, 'ready');
  return { state, applied, store, service };
}

test('the assignee reads a saved draft back from the same node, including after a return', async () => {
  const { state, applied, store, service } = await opened();
  const saved = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '草稿正文-4e1' }),
  );
  assert.equal(saved.ok, true, saved.ok ? '' : saved.error.code);
  assert.deepEqual(saved.value, { version: 1, text: '草稿正文-4e1', links: [], files: [] });
  assert.equal(JSON.stringify(saved).includes('draft-1'), false);
  const reopened = new ExecutionService(store.storage, { readWorkbench: () => state }, spaces);
  const again = await reopened.draft(session('chen'), locate(applied));
  assert.deepEqual(again.value, saved.value);
  const node = store.node('design');
  node.command = { ...node.command, status: 'needs-revision', entryStatus: 'needs-revision' };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const returned = await reopened.draft(session('chen'), locate(applied));
  assert.equal(returned.value.text, '草稿正文-4e1');
});

test('a reviewer, another participant, and a non-deliverable node do not write', async () => {
  const { applied, store, service } = await opened();
  await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '只有执行者能看-4e1' }),
  );
  const before = JSON.stringify(store.node('design'));
  const reviewer = await service.draft(session('lin'), locate(applied));
  assert.equal(reviewer.ok, false);
  assert.equal(reviewer.error.code, 'not-assignee');
  assert.equal(JSON.stringify(reviewer).includes('只有执行者能看-4e1'), false);
  const outsider = await service.draft(
    session('outside'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-outsider', text: '代写' }),
  );
  assert.equal(outsider.ok, false);
  assert.equal(outsider.error.code, 'not-participant');
  const node = store.node('design');
  node.command = { ...node.command, status: 'in-review' };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const blocked = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-2', text: '评审中还改' }),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'not-deliverable');
  assert.equal(blocked.error.message, '这项工作现在不能保存交付草稿。');
  assert.equal(store.node('design').deliveryDraft.text, '只有执行者能看-4e1');
  assert.equal(JSON.stringify(store.node('design')).includes('评审中还改'), false);
  assert.equal(before.includes('只有执行者能看-4e1'), true);
});

test('missing task and another space return the same not-found bytes and do not write', async () => {
  const { applied, store, service } = await opened();
  const before = JSON.stringify(store.node('design'));
  const caller = session('chen', ['elsewhere']);
  const write = {
    expectedVersion: 0,
    idempotencyKey: 'draft-hidden',
    text: '不该写进去-4e1',
  };
  const hidden = await service.draft(caller, locate(applied, write));
  const missing = await service.draft(caller, { ...locate(applied, write), taskId: 'absent-task' });
  assert.equal(Buffer.compare(bytes(hidden), bytes(missing)), 0);
  assert.deepEqual(hidden, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  assert.equal(JSON.stringify(hidden).includes('absent-task'), false);
  assert.equal(JSON.stringify(hidden).includes('不该写进去-4e1'), false);
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('an illegal directory answer is the same unavailable bytes whether or not the task exists', async () => {
  const shapes = [{ ok: true, spaceId: '' }, { ok: true }, { ok: 'yes', spaceId: 5 }];
  for (const shape of shapes) {
    const { state, applied, store } = await opened();
    const node = store.node('design');
    node.handoff = null;
    await store.storage.writeNode(
      `${applied.taskId}:${applied.id}:${applied.revision}:design`,
      node,
    );
    const before = JSON.stringify(store.node('design'));
    const directory = {
      async spaceForProject() {
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const write = { expectedVersion: 0, idempotencyKey: 'draft-illegal', text: '不该写-4e1' };
    const present = await service.draft(session('chen', ['elsewhere']), locate(applied, write));
    const missing = await service.draft(session('chen', ['elsewhere']), {
      ...locate(applied, write),
      taskId: 'absent-task',
    });
    assert.equal(Buffer.compare(bytes(present), bytes(missing)), 0);
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: 'unavailable',
        message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
        details: {},
      },
    });
    assert.equal(JSON.stringify(missing).includes('absent-task'), false);
    assert.equal(JSON.stringify(missing).includes('不该写-4e1'), false);
    assert.equal(JSON.stringify(store.node('design')), before);
    assert.equal(store.node('design').deliveryDraft, undefined);
  }
});

test('a directory failure stays unavailable whether or not the node exists', async () => {
  const { state, applied, store } = await opened();
  const down = {
    async spaceForProject() {
      throw new Error('space-down-4e1');
    },
  };
  const ask = (storage) =>
    new ExecutionService(storage, { readWorkbench: () => state }, down).draft(
      session('chen'),
      locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-down', text: '写不了' }),
    );
  const present = await ask(store.storage);
  const absent = await ask(memory().storage);
  assert.equal(Buffer.compare(bytes(present), bytes(absent)), 0);
  assert.deepEqual(present.error, {
    code: 'unavailable',
    message: '执行记录暂时不可用，请稍后用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(present).includes('space-down-4e1'), false);
  assert.equal(store.node('design').deliveryDraft, undefined);
});

test('a disk write failure still says the record cannot be written', async () => {
  const { applied, store, service } = await opened();
  const before = JSON.stringify(store.node('design'));
  store.storage.writeNode = async () => {
    throw new Error('disk-full-4e1');
  };
  const failed = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-disk', text: '写不进去-4e1' }),
  );
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.error, {
    code: 'unavailable',
    message: '执行记录暂时写不进去，请用同一个请求再试一次。',
    details: {},
  });
  assert.equal(JSON.stringify(failed).includes('disk-full-4e1'), false);
  assert.equal(JSON.stringify(failed).includes('写不进去-4e1'), false);
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('a stale draft version conflicts, and the same key cannot change the text', async () => {
  const { applied, store, service } = await opened();
  const first = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '第一份' }),
  );
  assert.equal(first.value.version, 1);
  const before = JSON.stringify(store.node('design'));
  const stale = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-2', text: '被盖掉' }),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'conflict');
  assert.equal(stale.error.message, '内容已变化，请刷新后再试。');
  assert.deepEqual(stale.error.details, { currentVersion: 1, expectedVersion: 0 });
  assert.equal(JSON.stringify(store.node('design')), before);
  const mismatch = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-1', text: '另一份' }),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'idempotency-mismatch');
  const replay = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '第一份' }),
  );
  assert.equal(replay.value.version, 1);
  assert.equal(replay.value.text, '第一份');
  assert.equal(JSON.stringify(store.node('design')), before);
  const next = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 1, idempotencyKey: 'draft-2', text: '第二份' }),
  );
  assert.equal(next.value.version, 2);
  assert.equal(next.value.text, '第二份');
});

test('a successful submit clears the saved draft', async () => {
  const { applied, store, service } = await opened();
  await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-1', text: '即将清掉-4e1' }),
  );
  assert.equal(store.node('design').deliveryDraft.text, '即将清掉-4e1');
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, { expectedVersion: 1, idempotencyKey: 'deliver-1' }),
    text: '正式交付',
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  assert.equal(store.node('design').deliveryDraft, undefined);
  assert.equal(JSON.stringify(store.node('design')).includes('即将清掉-4e1'), false);
});

test('an expert assignee cannot save a human delivery draft', async () => {
  const { applied, store, service } = await opened();
  const node = store.node('design');
  node.handoff = { ...node.handoff, assignee: { ...node.handoff.assignee, kind: 'expert' } };
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const before = JSON.stringify(store.node('design'));
  const refused = await service.draft(
    session('chen'),
    locate(applied, { expectedVersion: 0, idempotencyKey: 'draft-expert', text: '专家草稿' }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'not-assignee');
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('a draft link over the per-item or total limit is refused before any write', async () => {
  const { applied, store, service } = await opened();
  const before = JSON.stringify(store.node('design'));
  const one = await service.draft(
    session('chen'),
    locate(applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-long',
      links: [`https://example.test/${'a'.repeat(2049)}`],
    }),
  );
  assert.equal(one.ok, false);
  assert.equal(one.error.code, 'validation');
  assert.equal(one.error.message, '单条链接不能超过 2048 个字符。');
  assert.equal(JSON.stringify(store.node('design')), before);
  const many = await service.draft(
    session('chen'),
    locate(applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-total',
      links: Array.from({ length: 5 }, () => 'b'.repeat(2000)),
    }),
  );
  assert.equal(many.ok, false);
  assert.equal(many.error.code, 'validation');
  assert.equal(many.error.message, '草稿里的链接合计不能超过 8192 个字符。');
  assert.equal(JSON.stringify(store.node('design')), before);
  const kept = await service.draft(
    session('chen'),
    locate(applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-ok',
      links: ['https://example.test/short'],
    }),
  );
  assert.equal(kept.ok, true, kept.ok ? '' : kept.error.code);
  assert.deepEqual(kept.value.links, ['https://example.test/short']);
});

test('a saved draft keeps file metadata pending instead of uploaded', async () => {
  const host = await opened();
  const saved = await host.service.draft(
    session('chen'),
    locate(host.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-file-pending',
      files: [
        draftFile({
          id: 'notes',
          mediaType: 'text/plain',
          checksum: 'abc',
          accessPolicyId: 'policy',
        }),
      ],
    }),
  );
  assert.equal(saved.ok, true, saved.ok ? '' : saved.error.code);
  assert.equal(saved.value.files[0].uploadComplete, false);
  assert.equal(saved.value.files[0].id, 'notes');
  assert.equal(host.store.node('design').deliveryDraft.files[0].uploadComplete, false);
});

function draftFile(fields) {
  return {
    id: fields.id,
    mediaType: fields.mediaType,
    byteSize: 1,
    checksum: fields.checksum,
    accessPolicyId: fields.accessPolicyId,
    uploadComplete: true,
  };
}

test('draft caps accept the exact limit and refuse one more character before any write', async () => {
  const exactLink = await opened();
  const link = await exactLink.service.draft(
    session('chen'),
    locate(exactLink.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-link-exact',
      links: ['a'.repeat(2048)],
    }),
  );
  assert.equal(link.ok, true, link.ok ? '' : link.error.message);
  assert.equal(link.value.links[0].length, 2048);

  const exactTotal = await opened();
  const links = Array.from({ length: 4 }, () => 'b'.repeat(2048));
  const total = await exactTotal.service.draft(
    session('chen'),
    locate(exactTotal.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-total-exact',
      links,
    }),
  );
  assert.equal(total.ok, true, total.ok ? '' : total.error.message);
  assert.equal(
    total.value.links.reduce((sum, item) => sum + item.length, 0),
    8192,
  );

  const overTotal = await opened();
  const overTotalBefore = JSON.stringify(overTotal.store.node('design'));
  const totalPlus = await overTotal.service.draft(
    session('chen'),
    locate(overTotal.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-total-plus',
      links: [...links, 'c'],
    }),
  );
  assert.equal(totalPlus.ok, false);
  assert.equal(totalPlus.error.code, 'validation');
  assert.equal(totalPlus.error.message, '草稿里的链接合计不能超过 8192 个字符。');
  assert.equal(JSON.stringify(overTotal.store.node('design')), overTotalBefore);

  const exactField = await opened();
  const field = await exactField.service.draft(
    session('chen'),
    locate(exactField.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-field-exact',
      files: [
        draftFile({
          id: 'f'.repeat(2048),
          mediaType: 'text/plain',
          checksum: 'sum',
          accessPolicyId: 'policy',
        }),
      ],
    }),
  );
  assert.equal(field.ok, true, field.ok ? '' : field.error.message);
  assert.equal(field.value.files[0].id.length, 2048);

  const overField = await opened();
  const overFieldBefore = JSON.stringify(overField.store.node('design'));
  const fieldPlus = await overField.service.draft(
    session('chen'),
    locate(overField.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-field-plus',
      files: [
        draftFile({
          id: 'f'.repeat(2049),
          mediaType: 'text/plain',
          checksum: 'sum',
          accessPolicyId: 'policy',
        }),
      ],
    }),
  );
  assert.equal(fieldPlus.ok, false);
  assert.equal(fieldPlus.error.code, 'validation');
  assert.equal(fieldPlus.error.message, '文件信息的每一项不能超过 2048 个字符。');
  assert.equal(JSON.stringify(overField.store.node('design')), overFieldBefore);

  const full = 'd'.repeat(2048);
  const files = [
    ...Array.from({ length: 19 }, () =>
      draftFile({ id: full, mediaType: full, checksum: full, accessPolicyId: full }),
    ),
    draftFile({
      id: full,
      mediaType: full,
      checksum: full,
      accessPolicyId: 'e'.repeat(352),
    }),
  ];
  const text = 't'.repeat(100_000);
  const exactBody = await opened();
  const body = await exactBody.service.draft(
    session('chen'),
    locate(exactBody.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-body-exact',
      text,
      files,
    }),
  );
  assert.equal(body.ok, true, body.ok ? '' : body.error.message);
  assert.equal(body.value.text.length, 100_000);

  const overBody = await opened();
  const overBodyBefore = JSON.stringify(overBody.store.node('design'));
  const bodyPlus = await overBody.service.draft(
    session('chen'),
    locate(overBody.applied, {
      expectedVersion: 0,
      idempotencyKey: 'draft-body-plus',
      text,
      files: [
        ...files.slice(0, 19),
        draftFile({
          id: full,
          mediaType: full,
          checksum: full,
          accessPolicyId: 'e'.repeat(353),
        }),
      ],
    }),
  );
  assert.equal(bodyPlus.ok, false);
  assert.equal(bodyPlus.error.code, 'validation');
  assert.equal(bodyPlus.error.message, '草稿合计不能超过 262144 个字符。');
  assert.equal(JSON.stringify(overBody.store.node('design')), overBodyBefore);
});

test('a draft idempotency key stops at 200 characters and is not echoed or written', async () => {
  const marker = 'draft-key-secret-9f3e';
  const exact = await opened();
  const saved = await exact.service.draft(
    session('chen'),
    locate(exact.applied, {
      expectedVersion: 0,
      idempotencyKey: 'k'.repeat(200),
      text: '恰好两百',
    }),
  );
  assert.equal(saved.ok, true, saved.ok ? '' : saved.error.message);
  assert.equal(JSON.stringify(saved).includes('k'.repeat(200)), false);

  const over = await opened();
  let writes = 0;
  const writeNode = over.store.storage.writeNode;
  over.store.storage.writeNode = async (key, value) => {
    writes += 1;
    return writeNode(key, value);
  };
  const refused = await over.service.draft(
    session('chen'),
    locate(over.applied, {
      expectedVersion: 0,
      idempotencyKey: marker + 'x'.repeat(201 - marker.length),
      text: '多一个',
    }),
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'validation');
  assert.equal(refused.error.message, '幂等键不能超过 200 个字符。');
  assert.equal(JSON.stringify(refused).includes(marker), false);
  assert.equal(writes, 0);
  assert.equal(over.store.node('design').deliveryDraft, undefined);

  const huge = await opened();
  let hugeWrites = 0;
  const hugeWrite = huge.store.storage.writeNode;
  huge.store.storage.writeNode = async (key, value) => {
    hugeWrites += 1;
    return hugeWrite(key, value);
  };
  const blocked = await huge.service.draft(
    session('chen'),
    locate(huge.applied, {
      expectedVersion: 0,
      idempotencyKey: marker + 'h'.repeat((16 << 20) - marker.length),
      text: '太大',
    }),
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.message, '幂等键不能超过 200 个字符。');
  assert.equal(JSON.stringify(blocked).includes(marker), false);
  assert.equal(hugeWrites, 0);
  assert.equal(huge.store.node('design').deliveryDraft, undefined);

  const missing = await opened();
  const legalMissing = await missing.service.draft(session('chen'), {
    ...locate(missing.applied, { expectedVersion: 0, idempotencyKey: 'legal-key', text: 'x' }),
    taskId: 'absent-task',
  });
  const overMissing = await missing.service.draft(session('chen'), {
    ...locate(missing.applied, {
      expectedVersion: 0,
      idempotencyKey: marker + 'y'.repeat(201),
      text: 'x',
    }),
    taskId: 'absent-task',
  });
  assert.equal(Buffer.compare(bytes(legalMissing), bytes(overMissing)), 0);
  assert.equal(legalMissing.error.code, 'not-found');
  assert.equal(JSON.stringify(overMissing).includes(marker), false);

  const downState = await opened();
  const down = new ExecutionService(
    downState.store.storage,
    { readWorkbench: () => downState.state },
    {
      async spaceForProject() {
        throw new Error('space-down-4e1');
      },
    },
  );
  const legalDown = await down.draft(
    session('chen'),
    locate(downState.applied, { expectedVersion: 0, idempotencyKey: 'legal-key', text: 'x' }),
  );
  const overDown = await down.draft(
    session('chen'),
    locate(downState.applied, {
      expectedVersion: 0,
      idempotencyKey: marker + 'z'.repeat(201),
      text: 'x',
    }),
  );
  assert.equal(Buffer.compare(bytes(legalDown), bytes(overDown)), 0);
  assert.equal(legalDown.error.code, 'unavailable');
  assert.equal(legalDown.error.message, '执行记录暂时不可用，请稍后用同一个请求再试一次。');
  assert.equal(JSON.stringify(overDown).includes(marker), false);
  assert.equal(JSON.stringify(overDown).includes('space-down-4e1'), false);
});
