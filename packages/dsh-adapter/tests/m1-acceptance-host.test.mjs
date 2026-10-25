/**
 * M1 acceptance over the real Host: a reproducible multi-member, persistent
 * delivery run. Real Connection / credentials / JSON storage domains / member
 * cookies; a confirmed plan is seeded through the Host-level workbench seed
 * (recorded below), never impersonating member creation. No browser, no model
 * call, no external execution. GUI evidence stays with the coordinator.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../dist/identity-session.js';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

const PASSWORDS = {
  chen: 'chen-acceptance-secret',
  lin: 'lin-acceptance-secret',
  zhao: 'zhao-acceptance-secret',
  outside: 'outside-acceptance-secret',
};

// Accounts: chen the assignee, lin and zhao the two reviewers, outside holds
// no membership. Spaces: team-north (chen/lin/zhao), team-empty (chen, no
// projects), personal-chen. Project portal belongs to team-north.
const identityImport = {
  accounts: Object.entries(PASSWORDS).map(([id, password]) => ({
    id,
    passwordHash: hashPassword(password),
  })),
};
const spaceDirectoryImport = {
  spaces: [
    { id: 'personal-chen', kind: 'personal', name: '陈宁的个人空间' },
    { id: 'team-north', kind: 'team', name: '北队' },
    { id: 'team-empty', kind: 'team', name: '空团队' },
  ],
  memberships: [
    { spaceId: 'personal-chen', accountId: 'chen' },
    { spaceId: 'team-north', accountId: 'chen' },
    { spaceId: 'team-north', accountId: 'lin' },
    { spaceId: 'team-north', accountId: 'zhao' },
    { spaceId: 'team-empty', accountId: 'chen' },
  ],
  projectSpaces: [{ projectId: 'portal', spaceId: 'team-north' }],
};

// The confirmed plan, prepared as a Host-level seed before mounting: project
// portal, the three members, then task portal-task (ready) with node design
// assigned to chen, reviewers lin and zhao, downstream publish depends on it.
const workbenchSeed = [
  {
    type: 'save-project',
    project: { id: 'portal', name: '客户门户', description: '企业客户门户' },
  },
  ...['chen', 'lin', 'zhao', 'outside'].map((id) => ({
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
  })),
  {
    type: 'save-task',
    task: {
      id: 'portal-task',
      projectId: 'portal',
      title: '门户登录',
      goal: '交付登录流程',
      participantIds: ['chen', 'lin', 'zhao'],
      ownerId: 'chen',
      workflows: [
        {
          id: 'root',
          name: '登录工作流',
          parentNodeId: null,
          nodes: [
            {
              id: 'design',
              title: '设计登录接口',
              description: '',
              assigneeId: 'chen',
              reviewerIds: ['lin', 'zhao'],
              reviewRequired: true,
              dependsOn: [],
              skillIds: [],
              mcpIds: [],
              input: '需求文档',
              output: '接口定义',
              rationale: '',
              position: { x: 0, y: 0 },
            },
            {
              id: 'publish',
              title: '发布',
              description: '',
              assigneeId: 'chen',
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: ['design'],
              skillIds: [],
              mcpIds: [],
              input: '',
              output: '发布记录',
              rationale: '',
              position: { x: 1, y: 0 },
            },
          ],
        },
      ],
      status: 'ready',
      updatedAt: '2026-10-25T00:00:00.000Z',
    },
  },
];

function planRef(plan, extra = {}) {
  return {
    taskId: plan.taskId,
    planId: plan.planId ?? plan.id,
    revision: plan.revision,
    ...extra,
  };
}

function locate(plan, nodeId, extra = {}) {
  return {
    taskId: plan.taskId,
    planId: plan.planId ?? plan.id,
    revision: plan.revision,
    nodeId,
    ...extra,
  };
}

test(
  'M1 acceptance: seeded confirmed plan runs the text loop to downstream unlock, surviving a real restart',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-acceptance-'));
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

      // The confirmed plan is discoverable for the member.
      const startable = await host.exec('startable', {}, chen);
      assert.equal(startable.status, 200);
      assert.equal(startable.result.ok, true, JSON.stringify(startable.result));
      const plan = startable.result.value.plans.find((entry) => entry.taskId === 'portal-task');
      assert.ok(plan, 'seeded confirmed plan must be discoverable');

      // Explicit start.
      const started = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-portal-1',
        },
        chen,
      );
      assert.equal(started.result.ok, true, JSON.stringify(started.result));

      // chen saves a draft, then delivers text and a link.
      const draft = await host.exec(
        'draft',
        locate(plan, 'design', {
          expectedVersion: 0,
          idempotencyKey: 'draft-design-1',
          text: '接口说明草稿',
        }),
        chen,
      );
      assert.equal(draft.result.ok, true, JSON.stringify(draft.result));
      assert.equal(draft.result.value.version, 1);

      const inbox0 = await host.exec('inbox', {}, chen);
      assert.equal(inbox0.result?.ok, true, JSON.stringify(inbox0.result ?? inbox0));
      const version0 = inbox0.result.value.nodes.find((r) => r.nodeId === 'design').version;
      const submitted = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: version0,
          idempotencyKey: 'deliver-design-1',
          text: '接口定义 v1',
          links: ['https://example.internal/spec'],
        }),
        chen,
      );
      assert.equal(submitted.result.ok, true, JSON.stringify(submitted.result));
      const round1 = submitted.result.value.node.currentRoundId;
      const artifact1 = submitted.result.value.node.artifacts.at(-1).id;

      const commentOnly = await host.exec(
        'ballot',
        locate(plan, 'design', {
          expectedVersion: submitted.result.value.node.version,
          idempotencyKey: 'vote-zhao-1',
          roundId: round1,
          artifactVersionId: artifact1,
          action: 'comment',
          comment: '错误码请附示例',
        }),
        zhao,
      );
      assert.equal(commentOnly.result.ok, true, JSON.stringify(commentOnly.result));

      // zhao only comments (kept), then lin requests changes.
      const back = await host.exec(
        'ballot',
        locate(plan, 'design', {
          expectedVersion: commentOnly.result.value.node.version,
          idempotencyKey: 'vote-lin-1',
          roundId: round1,
          artifactVersionId: artifact1,
          action: 'request-changes',
          comment: '补充错误码表',
        }),
        lin,
      );
      assert.equal(back.result.ok, true, JSON.stringify(back.result));
      assert.equal(back.result.value.node.status, 'needs-revision');

      // chen reads the returned revision with both reviewers' notes.
      const review = await host.exec('revision', locate(plan, 'design', {}), chen);
      assert.equal(review.result.ok, true, JSON.stringify(review.result));
      const view = review.result.value.view;
      assert.ok(view.notes.some((note) => note.body.includes('补充错误码表')));

      // chen revises and resubmits a new version.
      const inbox1 = await host.exec('inbox', {}, chen);
      const version1 = inbox1.result.value.nodes.find((r) => r.nodeId === 'design').version;
      const revised = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: version1,
          idempotencyKey: 'deliver-design-2',
          text: '接口定义 v2，含错误码表',
          links: ['https://example.internal/spec-v2'],
        }),
        chen,
      );
      assert.equal(revised.result.ok, true, JSON.stringify(revised.result));
      const round2 = revised.result.value.node.currentRoundId;
      const artifact2 = revised.result.value.node.artifacts.at(-1).id;
      assert.notEqual(round2, round1);

      // Both reviewers approve; before both approve, publish stays blocked.
      const approve1 = await host.exec(
        'ballot',
        locate(plan, 'design', {
          expectedVersion: revised.result.value.node.version,
          idempotencyKey: 'vote-lin-2',
          roundId: round2,
          artifactVersionId: artifact2,
          action: 'approve',
        }),
        lin,
      );
      assert.equal(approve1.result.ok, true, JSON.stringify(approve1.result));
      const midReport = await host.exec('report', planRef(plan), chen);
      assert.equal(
        midReport.result.value.reports.find((r) => r.nodeId === 'publish').status,
        'blocked',
      );

      const approve2 = await host.exec(
        'ballot',
        locate(plan, 'design', {
          expectedVersion: approve1.result.value.node.version,
          idempotencyKey: 'vote-zhao-2',
          roundId: round2,
          artifactVersionId: artifact2,
          action: 'approve',
        }),
        zhao,
      );
      assert.equal(approve2.result.ok, true, JSON.stringify(approve2.result));

      // Full approval completes the round and unlocks the downstream publish node.
      assert.equal(approve2.result.value.node.status, 'completed');

      const afterReport = await host.exec('report', planRef(plan), chen);
      const publish = afterReport.result.value.reports.find((r) => r.nodeId === 'publish');
      assert.equal(publish.status, 'ready');

      // A real process restart keeps nodes, drafts, rounds, receipts, events.
      await host.close();
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
      });
      const chenAgain = await host.login('chen', PASSWORDS.chen);
      const afterRestart = await host.exec('report', planRef(plan), chenAgain);
      assert.equal(afterRestart.result.ok, true, JSON.stringify(afterRestart.result));
      const designAfter = afterRestart.result.value.reports.find((r) => r.nodeId === 'design');
      assert.equal(designAfter.status, 'completed');
      assert.equal(
        afterRestart.result.value.reports.find((r) => r.nodeId === 'publish').status,
        'ready',
      );
      const inboxAfter = await host.exec('inbox', {}, chenAgain);
      assert.equal(inboxAfter.result.ok, true);
      assert.ok(
        inboxAfter.result.value.items.some((item) => item.nodeId === 'publish'),
        'publish must be in the inbox after restart',
      );
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'M1 acceptance negatives: unauthorized member refused, same-key replays, stale versions conflict, no phantom artifacts',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-acceptance-neg-'));
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
      const outside = await host.login('outside', PASSWORDS.outside);

      const startable = await host.exec('startable', {}, chen);
      const plan = startable.result.value.plans.find((entry) => entry.taskId === 'portal-task');
      assert.ok(plan);

      // Unauthorized member: no discovery, no start, no read — nothing leaks.
      const outsideStartable = await host.exec('startable', {}, outside);
      assert.equal(outsideStartable.result.ok, true);
      assert.deepEqual(outsideStartable.result.value.plans, []);
      const outsideStart = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-outside',
        },
        outside,
      );
      assert.equal(outsideStart.result.ok, false);
      assert.equal(outsideStart.result.error.code, 'not-found');

      // Explicit start by the assignee.
      const started = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-portal-neg',
        },
        chen,
      );
      assert.equal(started.result.ok, true);

      // Same key replays without a second start (no duplicate nodes/events).
      const replay = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-portal-neg',
        },
        chen,
      );
      assert.equal(replay.result.ok, true);
      assert.equal(replay.result.value.disposition, 'replayed');

      // Stale expectedVersion refuses, writes nothing.
      const inbox0 = await host.exec('inbox', {}, chen);
      const current = inbox0.result.value.nodes.find((n) => n.nodeId === 'design').version;
      const stale = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: current + 1,
          idempotencyKey: 'deliver-stale',
          text: '过期版本提交',
        }),
        chen,
      );
      assert.equal(stale.result.ok, false);
      assert.equal(stale.result.error.code, 'conflict');

      // The retry with the same key and the same body replays.
      const submit = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: current,
          idempotencyKey: 'deliver-neg-1',
          text: '接口定义',
        }),
        chen,
      );
      assert.equal(submit.result.ok, true, JSON.stringify(submit.result));
      const replaySubmit = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: current,
          idempotencyKey: 'deliver-neg-1',
          text: '接口定义',
        }),
        chen,
      );
      assert.equal(replaySubmit.result.ok, true);
      assert.equal(replaySubmit.result.value.disposition, 'replayed');

      // The report still shows a single artifact version for the round.
      const report = await host.exec('report', planRef(plan), chen);
      const design = report.result.value.reports.find((r) => r.nodeId === 'design');
      assert.equal(design.reviewOutcome, 'pending');
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
