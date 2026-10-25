/**
 * M1 acceptance negatives over the real release entry: stale round/version
 * ballots, concurrent submits, explicit space scope with two teams and a
 * cross-team member, and no unlock before full approval. Real Host (real
 * Connection / credentials / JSON storage domains / member cookies). No
 * browser, no model, no external execution.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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

test(
  'M1 negatives: space isolation, stale rounds, concurrent writes, and no early unlock',
  { timeout: 90000 },
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
      assert.equal(ghost.result.ok, true);
      assert.deepEqual(ghost.result.value.plans, []);
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

      // A ballot naming the OLD round id must not act on the new round.
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

      // A ballot naming the OLD artifact version must not act either.
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

      // --- No early unlock: ship stays blocked until both reviewers approve. ---
      const approveLin = await host.exec(
        'ballot',
        locate(portalPlan, 'build', {
          expectedVersion: submitted2.result.value.node.version,
          idempotencyKey: 'vote-lin-r2',
          roundId: round2,
          artifactVersionId: artifact2,
          action: 'approve',
        }),
        lin,
      );
      assert.equal(approveLin.result.ok, true, JSON.stringify(approveLin.result));
      const midReport = await host.exec('report', planRef(portalPlan), chen);
      assert.equal(
        midReport.result.value.reports.find((r) => r.nodeId === 'ship').status,
        'blocked',
      );
      assert.equal(
        midReport.result.value.reports.find((r) => r.nodeId === 'build').status,
        'in-review',
      );

      // --- Concurrent submits with different keys on data-task: exactly one applies. ---
      const startData = await host.exec(
        'start-plan',
        { ...planRef(dataPlan), idempotencyKey: 'start-data' },
        chen,
      );
      assert.equal(startData.result.ok, true, JSON.stringify(startData.result));
      const dataInbox = await host.exec('inbox', { spaceId: 'team-south' }, chen);
      const dataBuildV = dataInbox.result.value.nodes.find((n) => n.nodeId === 'build').version;
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
      const outcomes = [raceA, raceB].map((r) =>
        r.result.ok ? r.result.value.disposition : r.result.error.code,
      );
      // Exactly one applies; the other conflicts on the version. No two artifacts.
      assert.ok(outcomes.includes('applied'));
      assert.ok(outcomes.includes('conflict'));
      const dataReport = await host.exec('report', planRef(dataPlan), chen);
      const dataBuild = dataReport.result.value.reports.find((r) => r.nodeId === 'build');
      assert.equal(dataBuild.status, 'in-review');
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
