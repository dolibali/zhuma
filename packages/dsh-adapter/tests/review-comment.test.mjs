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
const qiu = {
  id: 'qiu',
  name: '邱衡',
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
  state.participants.push(lin, qiu);
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin', 'qiu'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            {
              ...task.workflows[0].nodes[0],
              id: 'design',
              assigneeId: 'chen',
              reviewerIds: ['lin', 'qiu'],
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

async function reviewing() {
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
  const submitted = await service.submit(session('chen'), {
    ...locate(applied, { expectedVersion: 1, idempotencyKey: 'deliver-1' }),
    text: '初稿',
  });
  assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.code);
  const roundId = submitted.value.node.currentRoundId;
  const artifactVersionId = submitted.value.node.artifacts.at(-1).id;
  return { state, applied, store, service, roundId, artifactVersionId };
}

function vote(applied, roundId, artifactVersionId, extra) {
  return {
    ...locate(applied, {
      expectedVersion: extra.expectedVersion,
      idempotencyKey: extra.idempotencyKey,
    }),
    roundId,
    artifactVersionId,
    action: extra.action,
    ...(extra.comment === undefined ? {} : { comment: extra.comment }),
    ...(extra.unresolvedCommentIds === undefined
      ? {}
      : { unresolvedCommentIds: extra.unresolvedCommentIds }),
  };
}

test('a comment leaves the round and the existing ballots unchanged', async () => {
  const { applied, store, service, roundId, artifactVersionId } = await reviewing();
  const version = store.node('design').command.version;
  const approved = await service.ballot(
    session('qiu'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-qiu',
      action: 'approve',
      comment: '可以通过-4e1',
    }),
  );
  assert.equal(approved.ok, true, approved.ok ? '' : approved.error.code);
  const before = store.node('design').rounds.find((item) => item.id === roundId);
  const kept = before.ballots.find((item) => item.reviewerId === 'qiu');
  const noted = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'note-1',
      action: 'comment',
      comment: '先记一笔-4e1',
    }),
  );
  assert.equal(noted.ok, true, noted.ok ? '' : noted.error.code);
  const node = store.node('design');
  const round = node.rounds.find((item) => item.id === roundId);
  assert.equal(node.command.status, 'in-review');
  assert.equal(node.command.version, version);
  assert.equal(round.status, 'open');
  assert.deepEqual(
    round.ballots.find((item) => item.reviewerId === 'qiu'),
    kept,
  );
  assert.equal(kept.action, 'approve');
  assert.equal(kept.comment, '可以通过-4e1');
  assert.equal(
    round.ballots.some((item) => item.action === 'comment' && item.comment === '先记一笔-4e1'),
    true,
  );
});

test('a whitespace-only comment is refused without writing the record', async () => {
  const { applied, store, service, roundId, artifactVersionId } = await reviewing();
  const version = store.node('design').command.version;
  const before = JSON.stringify(store.node('design'));
  let writes = 0;
  const writeNode = store.storage.writeNode;
  store.storage.writeNode = async (key, value) => {
    writes += 1;
    await writeNode(key, value);
  };
  const blanks = ['', ' ', '\n', '\t', ' \n\t '];
  for (const [index, comment] of blanks.entries()) {
    writes = 0;
    const refused = await service.ballot(
      session('lin'),
      vote(applied, roundId, artifactVersionId, {
        expectedVersion: version,
        idempotencyKey: `vote-blank-${index}`,
        action: 'comment',
        comment,
      }),
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'empty-comment');
    assert.equal(refused.error.message, '只评论时要写下评论，不能只留空白。');
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(store.node('design')), before);
  }
  writes = 0;
  const omitted = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-blank-omit',
      action: 'comment',
    }),
  );
  assert.equal(omitted.ok, false);
  assert.equal(omitted.error.code, 'empty-comment');
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(store.node('design')), before);
  const kept = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-blank-text',
      action: 'comment',
      comment: '  还有字-4e1  ',
    }),
  );
  assert.equal(kept.ok, true, kept.ok ? '' : kept.error.code);
  assert.equal(writes, 1);
});

test('a comment of only zero-width characters is refused and does not return the node', async () => {
  const { applied, store, service, roundId, artifactVersionId } = await reviewing();
  const version = store.node('design').command.version;
  const before = JSON.stringify(store.node('design'));
  let writes = 0;
  const writeNode = store.storage.writeNode;
  store.storage.writeNode = async (key, value) => {
    writes += 1;
    await writeNode(key, value);
  };
  const blanks = [
    '\u200b',
    ' \u200b ',
    '\u200c',
    '\u200d',
    '\u2060',
    '\u180e',
    '\u00ad',
    '\u200b\u200c\u200d\u2060\u180e\u00ad',
    ' \u200b\u3000\u00ad ',
  ];
  for (const [index, comment] of blanks.entries()) {
    for (const action of ['comment', 'request-changes']) {
      writes = 0;
      const refused = await service.ballot(
        session('lin'),
        vote(applied, roundId, artifactVersionId, {
          expectedVersion: version,
          idempotencyKey: `vote-zw-${action}-${index}`,
          action,
          comment,
        }),
      );
      assert.equal(refused.ok, false, comment);
      assert.equal(
        refused.error.code,
        action === 'comment' ? 'empty-comment' : 'empty-request-changes',
      );
      assert.equal(writes, 0);
      assert.equal(store.node('design').command.status, 'in-review');
      assert.equal(JSON.stringify(store.node('design')), before);
    }
  }
});

test('a return with no opinion and no open comment is refused before any write', async () => {
  const { applied, store, service, roundId, artifactVersionId } = await reviewing();
  const version = store.node('design').command.version;
  const before = JSON.stringify(store.node('design'));
  const empty = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-empty',
      action: 'request-changes',
    }),
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'empty-request-changes');
  assert.equal(empty.error.message, '退回要写意见，或引用一条还没解决的评论。');
  assert.equal(JSON.stringify(store.node('design')), before);
  const node = store.node('design');
  node.comments = [{ id: 'c-closed', status: 'resolved', versionId: artifactVersionId }];
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const closed = JSON.stringify(store.node('design'));
  const cited = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-closed',
      action: 'request-changes',
      unresolvedCommentIds: ['c-closed'],
    }),
  );
  assert.equal(cited.ok, false);
  assert.equal(cited.error.code, 'comment-not-unresolved');
  assert.equal(JSON.stringify(store.node('design')), closed);
});

test('a return can cite an unresolved comment instead of writing a new opinion', async () => {
  const { applied, store, service, roundId, artifactVersionId } = await reviewing();
  const node = store.node('design');
  const version = node.command.version;
  node.comments = [
    { id: 'c-open', status: 'open', versionId: artifactVersionId, targetId: artifactVersionId },
  ];
  await store.storage.writeNode(`${applied.taskId}:${applied.id}:${applied.revision}:design`, node);
  const cited = await service.ballot(
    session('lin'),
    vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-cite',
      action: 'request-changes',
      unresolvedCommentIds: ['c-open'],
    }),
  );
  assert.equal(cited.ok, true, cited.ok ? '' : cited.error.code);
  const round = store.node('design').rounds.find((item) => item.id === roundId);
  assert.equal(round.status, 'changes-requested');
  assert.equal(store.node('design').command.status, 'needs-revision');
});

test('a missing task and another space return the same not-found bytes for a ballot', async () => {
  const { applied, store, service } = await reviewing();
  const before = JSON.stringify(store.node('design'));
  const caller = session('chen', ['elsewhere']);
  const body = vote(applied, 'round-1', 'artifact-1', {
    expectedVersion: 1,
    idempotencyKey: 'vote-hidden',
    action: 'comment',
    comment: '不该写-4e1',
  });
  const hidden = await service.ballot(caller, body);
  const missing = await service.ballot(caller, { ...body, taskId: 'absent-task' });
  assert.equal(Buffer.compare(bytes(hidden), bytes(missing)), 0);
  assert.deepEqual(hidden, {
    ok: false,
    error: { code: 'not-found', message: '找不到这个节点。', details: {} },
  });
  assert.equal(JSON.stringify(hidden).includes('absent-task'), false);
  assert.equal(JSON.stringify(store.node('design')), before);
});

test('an illegal or failed directory answer is the same unavailable bytes whether or not the task exists', async () => {
  const { state, applied, store, roundId, artifactVersionId } = await reviewing();
  const version = store.node('design').command.version;
  const shapes = [
    { throw: true },
    { ok: true, spaceId: '' },
    { ok: true },
    { ok: 'yes', spaceId: 5 },
  ];
  for (const shape of shapes) {
    const before = JSON.stringify(store.node('design'));
    const directory = {
      async spaceForProject() {
        if (shape.throw) throw new Error('space-down-4e1');
        return shape;
      },
    };
    const service = new ExecutionService(store.storage, { readWorkbench: () => state }, directory);
    const body = vote(applied, roundId, artifactVersionId, {
      expectedVersion: version,
      idempotencyKey: 'vote-down',
      action: 'comment',
      comment: '写不了-4e1',
    });
    const present = await service.ballot(session('chen', ['elsewhere']), body);
    const missing = await service.ballot(session('chen', ['elsewhere']), {
      ...body,
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
    assert.equal(JSON.stringify(missing).includes('space-down-4e1'), false);
    assert.equal(JSON.stringify(missing).includes('写不了-4e1'), false);
    assert.equal(JSON.stringify(store.node('design')), before);
  }
});
