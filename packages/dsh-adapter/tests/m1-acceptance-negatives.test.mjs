/**
 * M1 acceptance negatives over the real release entry: stale round/version
 * ballots, concurrent submits and ballots, explicit space scope with two
 * teams and a cross-team member, and no unlock before full approval. Rejects
 * and replays are checked against the node's artifact versions, rounds,
 * receipts, events, and the JSON bytes. Real Host (real Connection /
 * credentials / JSON storage domains / member cookies). No browser, no model,
 * no external execution.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../dist/identity-session.js';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

if (process.env.S1A_HOST_MODULE === undefined) {
  process.env.S1A_HOST_MODULE = fileURLToPath(new URL('../dist/host-plugin.js', import.meta.url));
}

const PASSWORDS = {
  chen: 'chen-neg-secret',
  lin: 'lin-neg-secret',
  zhao: 'zhao-neg-secret',
  outside: 'outside-neg-secret',
};

const identityImport = {
  accounts: Object.entries(PASSWORDS).map(([id, password]) => ({
    id,
    passwordHash: hashPassword(password),
  })),
};

// Two teams with real projects: chen belongs to both (cross-team), lin to
// both, zhao only north. personal-chen is an empty personal space.
const spaceDirectoryImport = {
  spaces: [
    { id: 'personal-chen', kind: 'personal', name: '陈宁的个人空间' },
    { id: 'team-north', kind: 'team', name: '北队' },
    { id: 'team-south', kind: 'team', name: '南队' },
  ],
  memberships: [
    { spaceId: 'personal-chen', accountId: 'chen' },
    { spaceId: 'team-north', accountId: 'chen' },
    { spaceId: 'team-north', accountId: 'lin' },
    { spaceId: 'team-north', accountId: 'zhao' },
    { spaceId: 'team-south', accountId: 'chen' },
    { spaceId: 'team-south', accountId: 'lin' },
  ],
  projectSpaces: [
    { projectId: 'portal', spaceId: 'team-north' },
    { projectId: 'data', spaceId: 'team-south' },
  ],
};

const member = (id) => ({
  type: 'save-participant',
  participant: {
    id,
    name: id,
    kind: 'human',
    role: '',
    capabilities: [],
    instructions: '',
    available: true,
  },
});

function taskFixture({ id, projectId, title, participants, reviewers }) {
  return {
    type: 'save-task',
    task: {
      id,
      projectId,
      title,
      goal: `交付${title}`,
      participantIds: participants,
      ownerId: participants[0],
      workflows: [
        {
          id: `root-${id}`,
          name: `${title}工作流`,
          parentNodeId: null,
          nodes: [
            {
              id: 'build',
              title: '构建',
              description: '',
              assigneeId: participants[0],
              reviewerIds: reviewers,
              reviewRequired: true,
              dependsOn: [],
              skillIds: [],
              mcpIds: [],
              input: '需求',
              output: '产物',
              rationale: '',
              position: { x: 0, y: 0 },
            },
            {
              id: 'ship',
              title: '交付',
              description: '',
              assigneeId: participants[0],
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: ['build'],
              skillIds: [],
              mcpIds: [],
              input: '',
              output: '交付记录',
              rationale: '',
              position: { x: 1, y: 0 },
            },
          ],
        },
      ],
      status: 'ready',
      updatedAt: '2026-10-25T00:00:00.000Z',
    },
  };
}

const workbenchSeed = [
  { type: 'save-project', project: { id: 'portal', name: '客户门户', description: '' } },
  { type: 'save-project', project: { id: 'data', name: '数据平台', description: '' } },
  ...['chen', 'lin', 'zhao', 'outside'].map(member),
  taskFixture({
    id: 'portal-task',
    projectId: 'portal',
    title: '门户登录',
    participants: ['chen', 'lin', 'zhao'],
    reviewers: ['lin', 'zhao'],
  }),
  taskFixture({
    id: 'data-task',
    projectId: 'data',
    title: '数据同步',
    participants: ['chen', 'lin'],
    reviewers: ['lin'],
  }),
];

function planRef(plan, extra = {}) {
  return { taskId: plan.taskId, planId: plan.planId ?? plan.id, revision: plan.revision, ...extra };
}

function locate(plan, nodeId, extra = {}) {
  return { ...planRef(plan), nodeId, ...extra };
}

function eventsBody(plan, nodeId, extra = {}) {
  return {
    taskId: plan.taskId,
    planId: plan.planId ?? plan.id,
    revision: plan.revision,
    nodeId,
    after: 0,
    ...extra,
  };
}

const executionPath = (directory) => join(directory, 'storages', 'zhuma_execution.json');

async function executionText(directory) {
  return await readFile(executionPath(directory), 'utf8');
}

function executionFacts(text) {
  const document = JSON.parse(text);
  const nodes = {};
  for (const record of Object.values(document.tables.nodes)) {
    nodes[`${record.taskId}:${record.nodeId}`] = record;
  }
  return { nodes, plans: document.tables.plans };
}

function nodeOf(text, taskId, nodeId) {
  const node = executionFacts(text).nodes[`${taskId}:${nodeId}`];
  assert.ok(node, `${taskId}:${nodeId}`);
  return node;
}

/** Fields a multi-write must change. Dropping one makes the controls below equal. */
function durable(node) {
  return {
    artifactVersions: node.artifactVersions,
    rounds: node.rounds,
    receipts: node.receipts,
    events: node.events ?? [],
    status: node.command.status,
    version: node.command.version,
  };
}

function assertExtraWriteVisible(text, taskId, nodeId, mutate) {
  const original = durable(nodeOf(text, taskId, nodeId));
  const copy = structuredClone(executionFacts(text));
  mutate(copy.nodes[`${taskId}:${nodeId}`]);
  assert.notDeepEqual(durable(copy.nodes[`${taskId}:${nodeId}`]), original);
}

function assertSensitive(text, taskId, nodeId) {
  assertExtraWriteVisible(text, taskId, nodeId, (node) => {
    node.artifactVersions = [...node.artifactVersions, { id: 'artifact:phantom' }];
  });
  assertExtraWriteVisible(text, taskId, nodeId, (node) => {
    node.rounds = [...node.rounds, { id: 'round:phantom' }];
  });
  assertExtraWriteVisible(text, taskId, nodeId, (node) => {
    node.receipts = [...node.receipts, { idempotencyKey: 'receipt:phantom' }];
  });
  assertExtraWriteVisible(text, taskId, nodeId, (node) => {
    node.events = [
      ...(node.events ?? []),
      { eventId: 'evt:phantom', sequence: 99, type: 'phantom' },
    ];
  });
}

/** Whole-file bytes plus every node's artifacts, rounds, receipts, and events. */
async function assertDurableUnchanged(directory, beforeText) {
  const afterText = await executionText(directory);
  assert.equal(afterText, beforeText);
  const before = executionFacts(beforeText);
  const after = executionFacts(afterText);
  assert.deepEqual(after.plans, before.plans);
  assert.deepEqual(Object.keys(after.nodes).sort(), Object.keys(before.nodes).sort());
  for (const key of Object.keys(before.nodes)) {
    assert.deepEqual(durable(after.nodes[key]), durable(before.nodes[key]), key);
  }
  return afterText;
}

function withoutNode(text, taskId, nodeId) {
  const facts = executionFacts(text);
  delete facts.nodes[`${taskId}:${nodeId}`];
  return facts;
}

function codeOf(response) {
  assert.ok(response.result, JSON.stringify(response));
  return response.result.ok ? response.result.value.disposition : response.result.error.code;
}

/** One submit landed. A second artifact, round, receipt, event, or any other node write fails. */
function assertOneSubmit(beforeText, afterText, taskId, spec) {
  assert.deepEqual(
    withoutNode(afterText, taskId, 'build'),
    withoutNode(beforeText, taskId, 'build'),
  );
  const before = nodeOf(beforeText, taskId, 'build');
  const after = nodeOf(afterText, taskId, 'build');
  assert.deepEqual(
    after.artifactVersions.slice(0, before.artifactVersions.length),
    before.artifactVersions,
  );
  assert.equal(after.artifactVersions.length, before.artifactVersions.length + 1);
  assert.equal(after.rounds.length, before.rounds.length + 1);
  assert.deepEqual(after.rounds.slice(0, before.rounds.length), before.rounds);
  assert.deepEqual(after.receipts.slice(0, before.receipts.length), before.receipts);
  assert.equal(after.receipts.length, before.receipts.length + 1);
  const beforeEvents = before.events ?? [];
  const afterEvents = after.events ?? [];
  assert.deepEqual(afterEvents.slice(0, beforeEvents.length), beforeEvents);
  assert.equal(afterEvents.length, beforeEvents.length + 1);
  assert.equal(afterEvents.at(-1).type, 'delivery-submitted');
  assert.equal(after.command.status, 'in-review');
  const added = after.artifactVersions.at(-1);
  const key = added.id.slice('artifact:'.length);
  const texts = spec.byKey ? Object.values(spec.byKey) : spec.texts;
  if (spec.byKey) {
    assert.ok(Object.hasOwn(spec.byKey, key), key);
    assert.equal(added.text, spec.byKey[key]);
  } else assert.equal(key, spec.key);
  assert.ok(texts.includes(added.text), added.text);
  for (const text of texts) {
    if (text === added.text) continue;
    assert.equal(
      after.artifactVersions.some((item) => item.text === text),
      false,
      text,
    );
  }
  assert.equal(after.receipts.at(-1).idempotencyKey, key);
  assert.equal(after.receipts.at(-1).disposition, 'applied');
  assert.equal(after.rounds.at(-1).id, `round:${key}`);
  assert.equal(after.rounds.at(-1).ballots.length, 0);
  return durable(after);
}

function outcomePair(left, right) {
  return [codeOf(left), codeOf(right)].sort();
}

test(
  'M1 negatives: wrong-space refusal, stale rounds, concurrent writes checked against durable facts, no early unlock',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-neg-'));
    let host;
    try {
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
        workbenchSeed,
      });
      const chen = await host.login('chen', PASSWORDS.chen);
      const lin = await host.login('lin', PASSWORDS.lin);
      const zhao = await host.login('zhao', PASSWORDS.zhao);
      const outside = await host.login('outside', PASSWORDS.outside);

      // --- Explicit scope isolation: chen holds both teams. ---
      const northStartable = await host.exec('startable', { spaceId: 'team-north' }, chen);
      assert.equal(northStartable.result.ok, true, JSON.stringify(northStartable.result));
      assert.deepEqual(
        northStartable.result.value.plans.map((p) => p.taskId),
        ['portal-task'],
      );
      assert.equal(northStartable.result.value.spaceId, 'team-north');
      const southStartable = await host.exec('startable', { spaceId: 'team-south' }, chen);
      assert.deepEqual(
        southStartable.result.value.plans.map((p) => p.taskId),
        ['data-task'],
      );
      // A scope chen does not hold (personal-a of someone else) hides everything.
      const ghost = await host.exec('startable', { spaceId: 'team-north' }, outside);
      assert.equal(ghost.result.ok, false);
      assert.equal(
        ghost.result.value,
        undefined,
        'foreign scope refusal cannot carry any task metadata',
      );
      // Empty personal space returns an empty projection, not an error.
      const personal = await host.exec('startable', { spaceId: 'personal-chen' }, chen);
      assert.equal(personal.result.ok, true);
      assert.deepEqual(personal.result.value.plans, []);

      const portalPlan = northStartable.result.value.plans[0];
      const dataPlan = southStartable.result.value.plans[0];

      // Start portal-task and deliver build.
      const started = await host.exec(
        'start-plan',
        { ...planRef(portalPlan), idempotencyKey: 'start-portal' },
        chen,
      );
      assert.equal(started.result.ok, true, JSON.stringify(started.result));
      const inbox0 = await host.exec('inbox', { spaceId: 'team-north' }, chen);
      const buildV0 = inbox0.result.value.nodes.find((n) => n.nodeId === 'build').version;

      // --- Stale round ballot: after round 1 is returned, its id must not apply. ---
      const submitted1 = await host.exec(
        'submit',
        locate(portalPlan, 'build', {
          expectedVersion: buildV0,
          idempotencyKey: 'deliver-1',
          text: '接口定义 v1',
        }),
        chen,
      );
      assert.equal(submitted1.result.ok, true);
      const round1 = submitted1.result.value.node.currentRoundId;
      const artifact1 = submitted1.result.value.node.artifacts.at(-1).id;

      // One reviewer comments (kept), the other requests changes → new round.
      const zhaoComment = await host.exec(
        'ballot',
        locate(portalPlan, 'build', {
          expectedVersion: submitted1.result.value.node.version,
          idempotencyKey: 'vote-zhao-c1',
          roundId: round1,
          artifactVersionId: artifact1,
          action: 'comment',
          comment: '建议附示例',
        }),
        zhao,
      );
      assert.equal(zhaoComment.result.ok, true, JSON.stringify(zhaoComment.result));
      const linBack = await host.exec(
        'ballot',
        locate(portalPlan, 'build', {
          expectedVersion: zhaoComment.result.value.node.version,
          idempotencyKey: 'vote-lin-back',
          roundId: round1,
          artifactVersionId: artifact1,
          action: 'request-changes',
          comment: '补充错误码',
        }),
        lin,
      );
      assert.equal(linBack.result.ok, true, JSON.stringify(linBack.result));
      assert.equal(linBack.result.value.node.status, 'needs-revision');

      // chen revises and resubmits → new round 2.
      const inbox1 = await host.exec('inbox', { spaceId: 'team-north' }, chen);
      const buildV1 = inbox1.result.value.nodes.find((n) => n.nodeId === 'build').version;
      const submitted2 = await host.exec(
        'submit',
        locate(portalPlan, 'build', {
          expectedVersion: buildV1,
          idempotencyKey: 'deliver-2',
          text: '接口定义 v2',
        }),
        chen,
      );
      assert.equal(submitted2.result.ok, true, JSON.stringify(submitted2.result));
      const round2 = submitted2.result.value.node.currentRoundId;
      const artifact2 = submitted2.result.value.node.artifacts.at(-1).id;
      assert.notEqual(round2, round1);

      async function listedEvents(plan, nodeId, cookie, extra = {}) {
        const result = await host.exec('events', eventsBody(plan, nodeId, extra), cookie);
        assert.equal(result.result?.ok, true, JSON.stringify(result.result ?? result));
        return result.result.value.events;
      }

      async function assertEventsMatchDisk(plan, nodeId, cookie, text) {
        const listed = await listedEvents(plan, nodeId, cookie);
        assert.deepEqual(
          listed.map((event) => event.eventId),
          durable(nodeOf(text, plan.taskId, nodeId)).events.map((event) => event.eventId),
        );
        await assertDurableUnchanged(directory, text);
      }

      // A ballot naming the old round, then the old artifact, writes nothing.
      const beforeStale = await executionText(directory);
      const beforeStaleEvents = await listedEvents(portalPlan, 'build', lin);
      await assertDurableUnchanged(directory, beforeStale);
      const staleRound = await host.exec(
        'ballot',
        locate(portalPlan, 'build', {
          expectedVersion: submitted2.result.value.node.version,
          idempotencyKey: 'vote-stale-round',
          roundId: round1,
          artifactVersionId: artifact2,
          action: 'approve',
        }),
        lin,
      );
      assert.equal(staleRound.result.ok, false);
      assert.equal(staleRound.result.error.code, 'stale-round');
      await assertDurableUnchanged(directory, beforeStale);
      assert.deepEqual(await listedEvents(portalPlan, 'build', lin), beforeStaleEvents);
      await assertDurableUnchanged(directory, beforeStale);
      assertSensitive(beforeStale, 'portal-task', 'build');

      const staleVersion = await host.exec(
        'ballot',
        locate(portalPlan, 'build', {
          expectedVersion: submitted2.result.value.node.version,
          idempotencyKey: 'vote-stale-version',
          roundId: round2,
          artifactVersionId: artifact1,
          action: 'approve',
        }),
        lin,
      );
      assert.equal(staleVersion.result.ok, false);
      assert.equal(staleVersion.result.error.code, 'stale-version');
      await assertDurableUnchanged(directory, beforeStale);
      assert.deepEqual(await listedEvents(portalPlan, 'build', lin), beforeStaleEvents);
      await assertDurableUnchanged(directory, beforeStale);
      const staleNode = nodeOf(beforeStale, 'portal-task', 'build');
      assert.equal(staleNode.currentRoundId, round2);
      assert.equal(staleNode.artifactVersions.at(-1).id, artifact2);
      assert.equal(
        staleNode.rounds
          .find((round) => round.id === round2)
          .ballots.some((ballot) => ballot.action === 'approve'),
        false,
      );

      // Concurrent ballots on the open round. Same-key replays once; a different
      // body cannot share that key. Two reviewers' different keys each land once.
      const ballotVersion = submitted2.result.value.node.version;
      const beforeSameBallot = await executionText(directory);
      const [sameBallotA, sameBallotB] = await Promise.all([
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-lin-same',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: '附边界示例',
          }),
          lin,
        ),
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-lin-same',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: '附边界示例',
          }),
          lin,
        ),
      ]);
      assert.deepEqual(outcomePair(sameBallotA, sameBallotB), ['applied', 'replayed']);
      const afterSameBallot = await executionText(directory);
      const sameBallotNode = nodeOf(afterSameBallot, 'portal-task', 'build');
      assert.deepEqual(sameBallotNode.artifactVersions, staleNode.artifactVersions);
      assert.equal(sameBallotNode.rounds.length, staleNode.rounds.length);
      assert.deepEqual(
        sameBallotNode.rounds.filter((round) => round.id !== round2),
        staleNode.rounds.filter((round) => round.id !== round2),
      );
      assert.equal(sameBallotNode.receipts.length, staleNode.receipts.length + 1);
      assert.equal((sameBallotNode.events ?? []).length, (staleNode.events ?? []).length + 1);
      assert.equal(sameBallotNode.events.at(-1).type, 'ballot-recorded');
      const sameComments = sameBallotNode.rounds
        .find((round) => round.id === round2)
        .ballots.filter((ballot) => ballot.comment === '附边界示例');
      assert.equal(sameComments.length, 1);
      assert.deepEqual(
        withoutNode(afterSameBallot, 'portal-task', 'build'),
        withoutNode(beforeSameBallot, 'portal-task', 'build'),
      );
      assertSensitive(afterSameBallot, 'portal-task', 'build');
      await assertEventsMatchDisk(portalPlan, 'build', chen, afterSameBallot);

      const beforeDiffBallot = await executionText(directory);
      const diffComments = ['北侧说明甲', '北侧说明乙'];
      const [diffBallotA, diffBallotB] = await Promise.all([
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-zhao-diff',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: diffComments[0],
          }),
          zhao,
        ),
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-zhao-diff',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: diffComments[1],
          }),
          zhao,
        ),
      ]);
      assert.deepEqual(outcomePair(diffBallotA, diffBallotB), ['applied', 'idempotency-mismatch']);
      const appliedDiffBallot = [diffBallotA, diffBallotB].find(
        (response) => response.result.ok && response.result.value.disposition === 'applied',
      );
      const winnerComment = appliedDiffBallot.result.value.node.rounds
        .find((round) => round.id === round2)
        .ballots.filter((ballot) => ballot.reviewerId === 'zhao')
        .at(-1).comment;
      assert.ok(diffComments.includes(winnerComment));
      const afterDiffBallot = await executionText(directory);
      const diffBallotNode = nodeOf(afterDiffBallot, 'portal-task', 'build');
      assert.deepEqual(diffBallotNode.artifactVersions, sameBallotNode.artifactVersions);
      assert.equal(diffBallotNode.rounds.length, sameBallotNode.rounds.length);
      assert.deepEqual(
        diffBallotNode.rounds.filter((round) => round.id !== round2),
        sameBallotNode.rounds.filter((round) => round.id !== round2),
      );
      assert.equal(diffBallotNode.receipts.length, sameBallotNode.receipts.length + 1);
      assert.equal((diffBallotNode.events ?? []).length, (sameBallotNode.events ?? []).length + 1);
      const zhaoComments = diffBallotNode.rounds
        .find((round) => round.id === round2)
        .ballots.filter((ballot) => ballot.reviewerId === 'zhao')
        .map((ballot) => ballot.comment);
      assert.deepEqual(zhaoComments, [winnerComment]);
      assert.equal(
        diffComments
          .filter((comment) => comment !== winnerComment)
          .some((comment) => zhaoComments.includes(comment)),
        false,
      );
      assert.deepEqual(
        withoutNode(afterDiffBallot, 'portal-task', 'build'),
        withoutNode(beforeDiffBallot, 'portal-task', 'build'),
      );
      assertSensitive(afterDiffBallot, 'portal-task', 'build');

      const beforePairBallot = await executionText(directory);
      const [linConcurrent, zhaoConcurrent] = await Promise.all([
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-lin-concurrent',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: '并发评甲',
          }),
          lin,
        ),
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: ballotVersion,
            idempotencyKey: 'vote-zhao-concurrent',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'comment',
            comment: '并发评乙',
          }),
          zhao,
        ),
      ]);
      assert.deepEqual(outcomePair(linConcurrent, zhaoConcurrent), ['applied', 'applied']);
      const afterPairBallot = await executionText(directory);
      const pairNode = nodeOf(afterPairBallot, 'portal-task', 'build');
      assert.deepEqual(pairNode.artifactVersions, diffBallotNode.artifactVersions);
      assert.equal(pairNode.rounds.length, diffBallotNode.rounds.length);
      assert.equal(pairNode.receipts.length, diffBallotNode.receipts.length + 2);
      assert.equal((pairNode.events ?? []).length, (diffBallotNode.events ?? []).length + 2);
      const pairBallots = pairNode.rounds.find((round) => round.id === round2).ballots;
      assert.equal(pairBallots.filter((ballot) => ballot.comment === '并发评甲').length, 1);
      assert.equal(pairBallots.filter((ballot) => ballot.comment === '并发评乙').length, 1);
      assert.equal(pairNode.command.status, 'in-review');
      assert.deepEqual(
        withoutNode(afterPairBallot, 'portal-task', 'build'),
        withoutNode(beforePairBallot, 'portal-task', 'build'),
      );
      assertSensitive(afterPairBallot, 'portal-task', 'build');
      await assertEventsMatchDisk(portalPlan, 'build', chen, afterPairBallot);

      // Two different keys from lin both approve. Exactly one approval is stored,
      // so ship stays blocked.
      const beforeApprove = await executionText(directory);
      const [approveA, approveB] = await Promise.all([
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: pairNode.command.version,
            idempotencyKey: 'vote-lin-race-a',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'approve',
          }),
          lin,
        ),
        host.exec(
          'ballot',
          locate(portalPlan, 'build', {
            expectedVersion: pairNode.command.version,
            idempotencyKey: 'vote-lin-race-b',
            roundId: round2,
            artifactVersionId: artifact2,
            action: 'approve',
          }),
          lin,
        ),
      ]);
      assert.deepEqual(outcomePair(approveA, approveB), ['applied', 'ignored']);
      const afterApprove = await executionText(directory);
      const approvedNode = nodeOf(afterApprove, 'portal-task', 'build');
      assert.deepEqual(approvedNode.artifactVersions, pairNode.artifactVersions);
      assert.equal(approvedNode.rounds.length, pairNode.rounds.length);
      assert.deepEqual(approvedNode.receipts.slice(0, pairNode.receipts.length), pairNode.receipts);
      assert.equal(approvedNode.command.status, 'in-review');
      assert.equal(approvedNode.command.version, pairNode.command.version);
      const approvals = approvedNode.rounds
        .find((round) => round.id === round2)
        .ballots.filter((ballot) => ballot.action === 'approve');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].reviewerId, 'lin');
      assert.equal(approvedNode.receipts.length, pairNode.receipts.length + 2);
      assert.deepEqual(
        approvedNode.receipts
          .slice(-2)
          .map((receipt) => receipt.idempotencyKey)
          .sort(),
        ['vote-lin-race-a', 'vote-lin-race-b'],
      );
      assert.equal((approvedNode.events ?? []).length, (pairNode.events ?? []).length + 1);
      assert.equal(approvedNode.events.at(-1).type, 'ballot-recorded');
      assert.deepEqual(
        withoutNode(afterApprove, 'portal-task', 'build'),
        withoutNode(beforeApprove, 'portal-task', 'build'),
      );
      assert.equal(nodeOf(afterApprove, 'portal-task', 'ship').command.status, 'blocked');
      assertSensitive(afterApprove, 'portal-task', 'build');
      const midReport = await host.exec('report', planRef(portalPlan), chen);
      assert.equal(midReport.result.ok, true, JSON.stringify(midReport.result));
      assert.equal(
        midReport.result.value.reports.find((report) => report.nodeId === 'ship').status,
        'blocked',
      );
      assert.equal(
        midReport.result.value.reports.find((report) => report.nodeId === 'build').status,
        'in-review',
      );
      await assertDurableUnchanged(directory, afterApprove);

      // --- Concurrent submits on the south node. ---
      const startData = await host.exec(
        'start-plan',
        { ...planRef(dataPlan), idempotencyKey: 'start-data' },
        chen,
      );
      assert.equal(startData.result.ok, true, JSON.stringify(startData.result));
      const dataInbox = await host.exec('inbox', { spaceId: 'team-south' }, chen);
      assert.equal(dataInbox.result.ok, true, JSON.stringify(dataInbox.result));
      assert.ok(dataInbox.result.value.nodes.every((node) => node.taskId === 'data-task'));
      const dataBuildV = dataInbox.result.value.nodes.find(
        (node) => node.nodeId === 'build',
      ).version;
      const beforeRace = await executionText(directory);
      assert.equal(durable(nodeOf(beforeRace, 'data-task', 'build')).artifactVersions.length, 0);
      assert.equal(durable(nodeOf(beforeRace, 'data-task', 'build')).events.length, 1);
      const [raceA, raceB] = await Promise.all([
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: dataBuildV,
            idempotencyKey: 'race-a',
            text: '并发A',
          }),
          chen,
        ),
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: dataBuildV,
            idempotencyKey: 'race-b',
            text: '并发B',
          }),
          chen,
        ),
      ]);
      assert.deepEqual(outcomePair(raceA, raceB), ['applied', 'conflict']);
      const afterRace = await executionText(directory);
      const raced = assertOneSubmit(beforeRace, afterRace, 'data-task', {
        byKey: { 'race-a': '并发A', 'race-b': '并发B' },
      });
      assert.equal(raced.artifactVersions.length, 1);
      assert.equal(raced.events.length, 2);
      assert.equal(raced.receipts.length, 1);
      assert.equal(raced.rounds.length, 1);
      assertSensitive(afterRace, 'data-task', 'build');
      await assertEventsMatchDisk(dataPlan, 'build', chen, afterRace);
      const dataReport = await host.exec('report', planRef(dataPlan), chen);
      assert.equal(
        dataReport.result.value.reports.find((report) => report.nodeId === 'build').status,
        'in-review',
      );
      await assertDurableUnchanged(directory, afterRace);

      const racedNode = nodeOf(afterRace, 'data-task', 'build');
      const sentBack = await host.exec(
        'ballot',
        locate(dataPlan, 'build', {
          expectedVersion: racedNode.command.version,
          idempotencyKey: 'data-back-1',
          roundId: racedNode.currentRoundId,
          artifactVersionId: racedNode.artifactVersions.at(-1).id,
          action: 'request-changes',
          comment: '退回后才能再次提交',
        }),
        lin,
      );
      assert.equal(sentBack.result.ok, true, JSON.stringify(sentBack.result));
      assert.equal(sentBack.result.value.node.status, 'needs-revision');

      const beforeSame = await executionText(directory);
      const sameVersion = sentBack.result.value.node.version;
      const [sameA, sameB] = await Promise.all([
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: sameVersion,
            idempotencyKey: 'data-same-body',
            text: '同体正文',
          }),
          chen,
        ),
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: sameVersion,
            idempotencyKey: 'data-same-body',
            text: '同体正文',
          }),
          chen,
        ),
      ]);
      assert.deepEqual(outcomePair(sameA, sameB), ['applied', 'replayed']);
      const afterSame = await executionText(directory);
      const sameFacts = assertOneSubmit(beforeSame, afterSame, 'data-task', {
        key: 'data-same-body',
        texts: ['同体正文'],
      });
      assert.equal(sameFacts.artifactVersions.length, 2);
      assertSensitive(afterSame, 'data-task', 'build');
      await assertEventsMatchDisk(dataPlan, 'build', chen, afterSame);
      const replayed = [sameA, sameB].find(
        (response) => response.result.value.disposition === 'replayed',
      );
      const appliedSame = [sameA, sameB].find(
        (response) => response.result.value.disposition === 'applied',
      );
      assert.deepEqual(
        replayed.result.value.node.artifacts.map((item) => item.id),
        appliedSame.result.value.node.artifacts.map((item) => item.id),
      );
      assert.deepEqual(
        sameFacts.artifactVersions.map((item) => item.id),
        appliedSame.result.value.node.artifacts.map((item) => item.id),
      );

      const sameNode = nodeOf(afterSame, 'data-task', 'build');
      const sentBackAgain = await host.exec(
        'ballot',
        locate(dataPlan, 'build', {
          expectedVersion: sameNode.command.version,
          idempotencyKey: 'data-back-2',
          roundId: sameNode.currentRoundId,
          artifactVersionId: sameNode.artifactVersions.at(-1).id,
          action: 'request-changes',
          comment: '再次退回',
        }),
        lin,
      );
      assert.equal(sentBackAgain.result.ok, true, JSON.stringify(sentBackAgain.result));
      assert.equal(sentBackAgain.result.value.node.status, 'needs-revision');

      const beforeDiff = await executionText(directory);
      const diffVersion = sentBackAgain.result.value.node.version;
      const diffBodies = ['异体甲', '异体乙'];
      const [diffA, diffB] = await Promise.all([
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: diffVersion,
            idempotencyKey: 'data-diff-body',
            text: diffBodies[0],
          }),
          chen,
        ),
        host.exec(
          'submit',
          locate(dataPlan, 'build', {
            expectedVersion: diffVersion,
            idempotencyKey: 'data-diff-body',
            text: diffBodies[1],
          }),
          chen,
        ),
      ]);
      assert.deepEqual(outcomePair(diffA, diffB), ['applied', 'idempotency-mismatch']);
      const afterDiff = await executionText(directory);
      const diffFacts = assertOneSubmit(beforeDiff, afterDiff, 'data-task', {
        key: 'data-diff-body',
        texts: diffBodies,
      });
      assert.equal(diffFacts.artifactVersions.length, 3);
      assert.equal(diffFacts.rounds.length, 3);
      assertSensitive(afterDiff, 'data-task', 'build');
      await assertEventsMatchDisk(dataPlan, 'build', chen, afterDiff);
      const diffReport = await host.exec('report', planRef(dataPlan), chen);
      assert.equal(
        diffReport.result.value.reports.find((report) => report.nodeId === 'build').status,
        'in-review',
      );
      await assertDurableUnchanged(directory, afterDiff);

      // The south node exists. A north-only member and an outsider cannot read
      // or write it. A wrong spaceId on start, report, and events is not-found
      // for a member who could otherwise see the node. Bytes stay put.
      const southNode = nodeOf(afterDiff, 'data-task', 'build');
      const southRound = southNode.currentRoundId;
      const southArtifact = southNode.artifactVersions.at(-1).id;
      const southVersion = southNode.command.version;
      const beforeScope = await executionText(directory);
      assert.equal(beforeScope, afterDiff);

      const seenReport = await host.exec(
        'report',
        { ...planRef(dataPlan), spaceId: 'team-south' },
        chen,
      );
      assert.equal(seenReport.result.ok, true, JSON.stringify(seenReport.result));
      assert.ok(seenReport.result.value.reports.some((report) => report.nodeId === 'build'));
      const seenEvents = await host.exec(
        'events',
        eventsBody(dataPlan, 'build', { spaceId: 'team-south' }),
        chen,
      );
      assert.equal(seenEvents.result.ok, true, JSON.stringify(seenEvents.result));
      assert.equal(seenEvents.result.value.spaceId, 'team-south');
      assert.ok(seenEvents.result.value.events.length >= 2);
      const northReport = await host.exec('report', planRef(portalPlan), zhao);
      assert.equal(northReport.result.ok, true, JSON.stringify(northReport.result));
      assert.ok(northReport.result.value.reports.some((report) => report.nodeId === 'build'));
      await assertDurableUnchanged(directory, beforeScope);

      const refused = [
        [
          'chen start south as north',
          () =>
            host.exec(
              'start-plan',
              { ...planRef(dataPlan), idempotencyKey: 'start-data', spaceId: 'team-north' },
              chen,
            ),
        ],
        [
          'chen report south as north',
          () => host.exec('report', { ...planRef(dataPlan), spaceId: 'team-north' }, chen),
        ],
        [
          'chen events south as north',
          () => host.exec('events', eventsBody(dataPlan, 'build', { spaceId: 'team-north' }), chen),
        ],
        [
          'chen start north as south',
          () =>
            host.exec(
              'start-plan',
              { ...planRef(portalPlan), idempotencyKey: 'start-portal', spaceId: 'team-south' },
              chen,
            ),
        ],
        [
          'chen report north as south',
          () => host.exec('report', { ...planRef(portalPlan), spaceId: 'team-south' }, chen),
        ],
        [
          'chen events north as south',
          () =>
            host.exec('events', eventsBody(portalPlan, 'build', { spaceId: 'team-south' }), chen),
        ],
        [
          'zhao start north as south',
          () =>
            host.exec(
              'start-plan',
              {
                ...planRef(portalPlan),
                idempotencyKey: 'start-portal-zhao',
                spaceId: 'team-south',
              },
              zhao,
            ),
        ],
        [
          'zhao report north as south',
          () => host.exec('report', { ...planRef(portalPlan), spaceId: 'team-south' }, zhao),
        ],
        [
          'zhao events north as south',
          () =>
            host.exec('events', eventsBody(portalPlan, 'build', { spaceId: 'team-south' }), zhao),
        ],
        ['zhao report south', () => host.exec('report', planRef(dataPlan), zhao)],
        ['zhao events south', () => host.exec('events', eventsBody(dataPlan, 'build'), zhao)],
        [
          'zhao events south scoped',
          () => host.exec('events', eventsBody(dataPlan, 'build', { spaceId: 'team-south' }), zhao),
        ],
        [
          'zhao start south',
          () =>
            host.exec(
              'start-plan',
              { ...planRef(dataPlan), idempotencyKey: 'start-zhao-south', spaceId: 'team-south' },
              zhao,
            ),
        ],
        ['zhao revision south', () => host.exec('revision', locate(dataPlan, 'build'), zhao)],
        ['zhao draft south', () => host.exec('draft', locate(dataPlan, 'build'), zhao)],
        [
          'zhao submit south',
          () =>
            host.exec(
              'submit',
              locate(dataPlan, 'build', {
                expectedVersion: southVersion,
                idempotencyKey: 'submit-zhao-south',
                text: '北队成员写入南队',
              }),
              zhao,
            ),
        ],
        [
          'zhao ballot south',
          () =>
            host.exec(
              'ballot',
              locate(dataPlan, 'build', {
                expectedVersion: southVersion,
                idempotencyKey: 'vote-zhao-south',
                roundId: southRound,
                artifactVersionId: southArtifact,
                action: 'approve',
              }),
              zhao,
            ),
        ],
        [
          'outside report south',
          () => host.exec('report', { ...planRef(dataPlan), spaceId: 'team-south' }, outside),
        ],
        [
          'outside events south',
          () =>
            host.exec('events', eventsBody(dataPlan, 'build', { spaceId: 'team-south' }), outside),
        ],
        [
          'outside start south',
          () =>
            host.exec(
              'start-plan',
              { ...planRef(dataPlan), idempotencyKey: 'start-outside-south' },
              outside,
            ),
        ],
        ['outside revision south', () => host.exec('revision', locate(dataPlan, 'build'), outside)],
        [
          'outside submit south',
          () =>
            host.exec(
              'submit',
              locate(dataPlan, 'build', {
                expectedVersion: southVersion,
                idempotencyKey: 'submit-outside-south',
                text: '无权写入',
              }),
              outside,
            ),
        ],
        [
          'outside ballot south',
          () =>
            host.exec(
              'ballot',
              locate(dataPlan, 'build', {
                expectedVersion: southVersion,
                idempotencyKey: 'vote-outside-south',
                roundId: southRound,
                artifactVersionId: southArtifact,
                action: 'approve',
              }),
              outside,
            ),
        ],
      ];
      for (const [label, call] of refused) {
        const response = await call();
        assert.equal(response.result?.ok, false, `${label} ${JSON.stringify(response.result)}`);
        assert.equal(response.result.error.code, 'not-found', label);
        await assertDurableUnchanged(directory, beforeScope);
      }
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
