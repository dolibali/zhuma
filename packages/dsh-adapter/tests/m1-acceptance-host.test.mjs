/**
 * M1 acceptance over the real Host: a reproducible multi-member, persistent
 * delivery run. Real Connection / credentials / JSON storage domains / member
 * cookies; a confirmed plan is seeded through the Host-level workbench seed
 * (recorded below), never impersonating member creation. No browser, no model
 * call, no external execution. GUI evidence stays with the coordinator.
 *
 * `S1A_HOST_MODULE` is the Host entry for every boot. When a caller has not
 * set it, this file binds the built package entry so the source commit and
 * that file's digest are what the run records. A release-byte run sets the
 * variable to the emitted bundle instead; this file does not replace a value
 * that is already set. The seven Host release cases are a separate proof.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../dist/identity-session.js';
import { acceptanceModulePath, startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

if (process.env.S1A_HOST_MODULE === undefined) {
  process.env.S1A_HOST_MODULE = fileURLToPath(new URL('../dist/host-plugin.js', import.meta.url));
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

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

const executionPath = (directory) => join(directory, 'storages', 'zhuma_execution.json');

async function executionText(directory) {
  try {
    return await readFile(executionPath(directory), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function executionFacts(text) {
  const document = JSON.parse(text);
  const nodes = {};
  for (const record of Object.values(document.tables.nodes)) nodes[record.nodeId] = record;
  return { nodes, plans: document.tables.plans };
}

/** Fields a restart must still show. Dropping one makes the loss controls below equal. */
function retained(facts) {
  const design = facts.nodes.design;
  const publish = facts.nodes.publish;
  return {
    designDraft: design.deliveryDraft ?? null,
    designReceipts: design.receipts,
    designEvents: design.events ?? [],
    designRounds: design.rounds,
    designArtifacts: design.artifactVersions,
    designComments: design.comments,
    designStatus: design.command.status,
    designVersion: design.command.version,
    publishReceipts: publish.receipts,
    publishEvents: publish.events ?? [],
    publishStatus: publish.command.status,
    publishVersion: publish.command.version,
    plans: facts.plans,
  };
}

function assertLossVisible(text, mutate) {
  const original = retained(executionFacts(text));
  const copy = structuredClone(executionFacts(text));
  mutate(copy);
  assert.notDeepEqual(retained(copy), original);
}

async function assertBoundModule(host) {
  const modulePath = acceptanceModulePath();
  assert.equal(isAbsolute(modulePath), true);
  assert.equal(host.boundModule.modulePath, modulePath);
  assert.equal(
    host.boundModule.contentDigest,
    createHash('sha256')
      .update(await readFile(modulePath))
      .digest('hex'),
  );
  assert.equal(
    host.boundModule.sourceSha,
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  );
  assert.match(host.boundModule.sourceSha, /^[0-9a-f]{40}$/);
  assert.match(host.boundModule.contentDigest, /^[0-9a-f]{64}$/);
}

async function listedEvents(host, plan, nodeId, cookie) {
  const result = await host.exec(
    'events',
    {
      taskId: plan.taskId,
      planId: plan.planId ?? plan.id,
      revision: plan.revision,
      nodeId,
      after: 0,
    },
    cookie,
  );
  assert.equal(result.result?.ok, true, JSON.stringify(result.result ?? result));
  return result.result.value.events;
}

test(
  'M1 acceptance: seeded confirmed plan runs the text loop to downstream unlock, surviving a real restart',
  { timeout: 90000 },
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
      await assertBoundModule(host);
      assert.equal(host.seeded, true);
      assert.equal(
        (await host.act('inspect')).opened.filter((name) => name === 'zhuma_workbench').length,
        2,
      );

      let chen = await host.login('chen', PASSWORDS.chen);
      let lin = await host.login('lin', PASSWORDS.lin);
      let zhao = await host.login('zhao', PASSWORDS.zhao);
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
      assert.equal(draft.result.value.text, '接口说明草稿');

      // Reopen after the draft is saved and read the same content and version back.
      await host.close();
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
      });
      await assertBoundModule(host);
      assert.equal(host.seeded, false);
      chen = await host.login('chen', PASSWORDS.chen);
      lin = await host.login('lin', PASSWORDS.lin);
      zhao = await host.login('zhao', PASSWORDS.zhao);
      const draftAgain = await host.exec('draft', locate(plan, 'design'), chen);
      assert.equal(draftAgain.result.ok, true, JSON.stringify(draftAgain.result));
      assert.deepEqual(draftAgain.result.value, {
        version: 1,
        text: '接口说明草稿',
        links: [],
        files: [],
      });

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

      // The submit tombstone is the cross-round boundary: version advanced, body cleared.
      const tombstone = await host.exec('draft', locate(plan, 'design'), chen);
      assert.equal(tombstone.result.ok, true, JSON.stringify(tombstone.result));
      assert.deepEqual(tombstone.result.value, { version: 2, text: '', links: [], files: [] });
      const duringReturn = await executionText(directory);
      const lateDraft = await host.exec(
        'draft',
        locate(plan, 'design', {
          expectedVersion: 0,
          idempotencyKey: 'draft-old-round',
          text: '旧轮正文',
        }),
        chen,
      );
      assert.equal(lateDraft.result.ok, false);
      assert.equal(lateDraft.result.error.code, 'conflict');
      assert.equal(await executionText(directory), duringReturn);
      const tombstoneStill = await host.exec('draft', locate(plan, 'design'), chen);
      assert.deepEqual(tombstoneStill.result.value, tombstone.result.value);

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

      const eventsBefore = {
        design: await listedEvents(host, plan, 'design', chen),
        publish: await listedEvents(host, plan, 'publish', chen),
      };
      const revisionBefore = await host.exec('revision', locate(plan, 'design'), chen);
      assert.equal(revisionBefore.result.ok, true, JSON.stringify(revisionBefore.result));
      const storedBefore = await executionText(directory);
      const kept = retained(executionFacts(storedBefore));
      assert.deepEqual(kept.designDraft, {
        version: 3,
        idempotencyKey: '',
        fingerprint: '',
        text: '',
        links: [],
        files: [],
      });
      assert.equal(kept.designStatus, 'completed');
      assert.equal(kept.publishStatus, 'ready');
      assert.equal(kept.designArtifacts.length, 2);
      assert.equal(kept.designRounds.length, 2);
      assert.ok(kept.designRounds.some((round) => round.status === 'changes-requested'));
      assert.ok(kept.designRounds.some((round) => round.status === 'approved'));
      assert.ok(
        kept.designRounds.some((round) =>
          round.ballots.some((ballot) => (ballot.comment ?? '').includes('补充错误码表')),
        ),
      );
      assert.ok(
        kept.designRounds.some((round) =>
          round.ballots.some((ballot) => (ballot.comment ?? '').includes('错误码请附示例')),
        ),
      );
      assert.ok(kept.designReceipts.length > 0);
      assert.ok(kept.designEvents.length > 0);
      assert.ok(kept.publishEvents.length > 0);
      assert.deepEqual(
        eventsBefore.design.map((event) => event.eventId),
        kept.designEvents.map((event) => event.eventId),
      );
      assert.deepEqual(
        eventsBefore.publish.map((event) => event.eventId),
        kept.publishEvents.map((event) => event.eventId),
      );
      // Losing the tombstone, receipts, or events must make this same comparison fail.
      assertLossVisible(storedBefore, (facts) => {
        facts.nodes.design.deliveryDraft = undefined;
      });
      assertLossVisible(storedBefore, (facts) => {
        facts.nodes.design.receipts = [];
        facts.nodes.publish.receipts = [];
      });
      assertLossVisible(storedBefore, (facts) => {
        facts.nodes.design.events = [];
        facts.nodes.publish.events = [];
      });

      await host.close();
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
      });
      await assertBoundModule(host);
      assert.equal(host.seeded, false);
      assert.equal(
        (await host.act('inspect')).opened.filter((name) => name === 'zhuma_workbench').length,
        1,
      );
      const chenAgain = await host.login('chen', PASSWORDS.chen);
      assert.equal(await executionText(directory), storedBefore);
      assert.deepEqual(retained(executionFacts(await executionText(directory))), kept);
      const eventsAfter = {
        design: await listedEvents(host, plan, 'design', chenAgain),
        publish: await listedEvents(host, plan, 'publish', chenAgain),
      };
      assert.deepEqual(eventsAfter, eventsBefore);
      const revisionAfter = await host.exec('revision', locate(plan, 'design'), chenAgain);
      assert.deepEqual(revisionAfter.result.value.view, revisionBefore.result.value.view);
      const afterRestart = await host.exec('report', planRef(plan), chenAgain);
      assert.equal(afterRestart.result.ok, true, JSON.stringify(afterRestart.result));
      assert.deepEqual(afterRestart.result.value.reports, afterReport.result.value.reports);
      const inboxAfter = await host.exec('inbox', {}, chenAgain);
      assert.equal(inboxAfter.result.ok, true);
      assert.ok(
        inboxAfter.result.value.items.some((item) => item.nodeId === 'publish'),
        'publish must be in the inbox after restart',
      );

      const bytesAfterRead = await executionText(directory);
      const startAgain = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-portal-1',
        },
        chenAgain,
      );
      assert.equal(startAgain.result.ok, true, JSON.stringify(startAgain.result));
      assert.equal(startAgain.result.value.disposition, 'replayed');
      assert.equal(await executionText(directory), bytesAfterRead);
      const submitAgain = await host.exec(
        'submit',
        locate(plan, 'design', {
          expectedVersion: version1,
          idempotencyKey: 'deliver-design-2',
          text: '接口定义 v2，含错误码表',
          links: ['https://example.internal/spec-v2'],
        }),
        chenAgain,
      );
      assert.equal(submitAgain.result.ok, true, JSON.stringify(submitAgain.result));
      assert.equal(submitAgain.result.value.disposition, 'replayed');
      assert.deepEqual(
        submitAgain.result.value.node.artifacts.map((item) => item.id),
        kept.designArtifacts.map((item) => item.id),
      );
      assert.equal(await executionText(directory), bytesAfterRead);
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'M1 acceptance negatives: unauthorized member refused, same-key replays, stale versions conflict, no phantom artifacts',
  { timeout: 90000 },
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
      await assertBoundModule(host);
      assert.equal(host.seeded, true);
      const chen = await host.login('chen', PASSWORDS.chen);
      const outside = await host.login('outside', PASSWORDS.outside);

      const startable = await host.exec('startable', {}, chen);
      const plan = startable.result.value.plans.find((entry) => entry.taskId === 'portal-task');
      assert.ok(plan);

      // Unauthorized member: no discovery, no start, no read — nothing leaks.
      const beforeRefusal = await executionText(directory);
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
      const outsideRead = await host.exec('report', planRef(plan), outside);
      assert.equal(outsideRead.result.ok, false);
      assert.equal(outsideRead.result.error.code, 'not-found');
      assert.equal(await executionText(directory), beforeRefusal);

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
      const afterStart = await executionText(directory);
      const startedFacts = retained(executionFacts(afterStart));
      const startedEvents = {
        design: await listedEvents(host, plan, 'design', chen),
        publish: await listedEvents(host, plan, 'publish', chen),
      };

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
      assert.deepEqual(replay.result.value.reports, started.result.value.reports);
      assert.equal(await executionText(directory), afterStart);
      assert.deepEqual(retained(executionFacts(await executionText(directory))), startedFacts);
      assert.deepEqual(
        {
          design: await listedEvents(host, plan, 'design', chen),
          publish: await listedEvents(host, plan, 'publish', chen),
        },
        startedEvents,
      );

      // Stale expectedVersion refuses, writes nothing.
      const inbox0 = await host.exec('inbox', {}, chen);
      const current = inbox0.result.value.nodes.find((n) => n.nodeId === 'design').version;
      const beforeStale = await executionText(directory);
      const staleFacts = retained(executionFacts(beforeStale));
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
      assert.equal(await executionText(directory), beforeStale);
      assert.deepEqual(retained(executionFacts(beforeStale)), staleFacts);

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
      const afterSubmit = await executionText(directory);
      const submittedFacts = retained(executionFacts(afterSubmit));
      const submittedEvents = await listedEvents(host, plan, 'design', chen);
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
      assert.deepEqual(replaySubmit.result.value.report, submit.result.value.report);
      assert.deepEqual(replaySubmit.result.value.node, submit.result.value.node);
      assert.equal(await executionText(directory), afterSubmit);
      assert.deepEqual(retained(executionFacts(afterSubmit)), submittedFacts);
      assert.deepEqual(await listedEvents(host, plan, 'design', chen), submittedEvents);
      assert.deepEqual(
        submittedFacts.designArtifacts.map((item) => item.id),
        ['artifact:deliver-neg-1'],
      );
      assert.equal(submittedFacts.designRounds.length, 1);
      assert.deepEqual(
        submittedFacts.designEvents.map((event) => event.eventId),
        submittedEvents.map((event) => event.eventId),
      );
      assert.deepEqual(
        submittedEvents.map((event) => event.eventId),
        ['evt:design:1', 'evt:design:2'],
      );

      // An extra stored artifact or event must fail the same comparison.
      assertLossVisible(afterSubmit, (facts) => {
        facts.nodes.design.artifactVersions = [
          ...facts.nodes.design.artifactVersions,
          { id: 'artifact:phantom' },
        ];
      });
      assertLossVisible(afterSubmit, (facts) => {
        facts.nodes.design.events = [
          ...(facts.nodes.design.events ?? []),
          { eventId: 'evt:phantom', sequence: 99, type: 'phantom' },
        ];
      });

      const report = await host.exec('report', planRef(plan), chen);
      const design = report.result.value.reports.find((r) => r.nodeId === 'design');
      assert.equal(design.reviewOutcome, 'pending');
      assert.equal(await executionText(directory), afterSubmit);
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('an explicit missing or non-host S1A_HOST_MODULE fails and does not use another entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-module-'));
  const probe = fileURLToPath(
    new URL('./fixtures/m1-acceptance-module-probe.mjs', import.meta.url),
  );
  const decoy = join(directory, 'decoy-entry.js');
  await writeFile(decoy, 'export const marker = "decoy";\n');
  const cases = [
    { modulePath: undefined, expect: /S1A_HOST_MODULE must name the Host entry/ },
    { modulePath: join(directory, 'missing-entry.js'), expect: /does not exist/ },
    { modulePath: decoy, expect: /Host boot failed/ },
  ];
  try {
    for (const item of cases) {
      const env = { ...process.env };
      if (item.modulePath === undefined) delete env.S1A_HOST_MODULE;
      else env.S1A_HOST_MODULE = item.modulePath;
      const child = spawnSync(process.execPath, [probe], {
        env,
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(
        child.status,
        1,
        `${item.modulePath ?? '(unset)'}\n${child.stdout}\n${child.stderr}`,
      );
      assert.match(child.stdout, item.expect, child.stderr);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'M1 acceptance: a real file uploads to durable storage with a server-computed receipt, surviving restart',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-m1-upload-'));
    let host;
    try {
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
        workbenchSeed,
      });
      const chen = await host.login('chen', PASSWORDS.chen);
      const outside = await host.login('outside', PASSWORDS.outside);

      const startable = await host.exec('startable', {}, chen);
      const plan = startable.result.value.plans.find((entry) => entry.taskId === 'portal-task');
      assert.ok(plan);
      const started = await host.exec(
        'start-plan',
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          idempotencyKey: 'start-upload',
        },
        chen,
      );
      assert.equal(started.result.ok, true);

      // A real file uploads: the server computes the digest and length.
      const bytes = new TextEncoder().encode('# 接口说明\n\n真实文件内容。\n');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploaded = await host.upload(
        { name: '接口说明🙂.md', mediaType: 'text/markdown', byteSize: bytes.byteLength, sha256 },
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          nodeId: 'design',
          spaceId: 'team-north',
          idempotencyKey: 'upload-spec-1',
        },
        bytes,
        chen,
      );
      assert.equal(uploaded.json?.ok, true, JSON.stringify(uploaded.json));
      assert.equal(uploaded.json.value.sha256, sha256);
      assert.equal(uploaded.json.value.bytes, bytes.byteLength);
      assert.equal(uploaded.json.value.name, '接口说明🙂.md');
      assert.ok(uploaded.json.value.uploadId.length > 0);

      // A forged declaration fails closed and writes nothing.
      const forged = await host.upload(
        {
          name: 'fake.md',
          mediaType: 'text/markdown',
          byteSize: bytes.byteLength,
          sha256: '0'.repeat(64),
        },
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          nodeId: 'design',
          spaceId: 'team-north',
          idempotencyKey: 'upload-forged',
        },
        bytes,
        chen,
      );
      assert.equal(forged.json?.ok, false);
      assert.equal(forged.json?.error?.code, 'digest-mismatch');

      // An unauthorized member cannot upload.
      const denied = await host.upload(
        { name: '接口说明🙂.md', mediaType: 'text/markdown', byteSize: bytes.byteLength, sha256 },
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          nodeId: 'design',
          spaceId: 'team-north',
          idempotencyKey: 'upload-outside',
        },
        bytes,
        outside,
      );
      assert.equal(denied.json?.ok, false);

      // A real restart keeps the receipt metadata.
      await host.close();
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport,
      });
      const chenAgain = await host.login('chen', PASSWORDS.chen);
      // Same idempotency key replays the same receipt after the restart.
      const replayed = await host.upload(
        { name: '接口说明🙂.md', mediaType: 'text/markdown', byteSize: bytes.byteLength, sha256 },
        {
          taskId: plan.taskId,
          planId: plan.planId,
          revision: plan.revision,
          nodeId: 'design',
          spaceId: 'team-north',
          idempotencyKey: 'upload-spec-1',
        },
        bytes,
        chenAgain,
      );
      assert.equal(replayed.json?.ok, true);
      assert.equal(replayed.json?.value?.uploadId, uploaded.json.value.uploadId);
    } finally {
      if (host) await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function storedAttachmentFiles(directory) {
  const entries = await readdir(join(directory, 'attachments'), {
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

test(
  'M1 real HTTP: four accounts and two actual team tasks keep distinct receipts for identical bytes',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-file-two-teams-'));
    let host;
    try {
      const secondTask = structuredClone(workbenchSeed.at(-1).task);
      Object.assign(secondTask, {
        id: 'support-task',
        projectId: 'support',
        ownerId: 'zhao',
        participantIds: ['zhao', 'lin'],
      });
      for (const workflow of secondTask.workflows)
        for (const node of workflow.nodes) {
          node.assigneeId = 'zhao';
          node.reviewerIds = node.reviewRequired ? ['lin'] : [];
        }
      host = await startAcceptanceHost(directory, {
        deploymentMode: 'multi-member',
        identityImport,
        spaceDirectoryImport: {
          spaces: [
            ...spaceDirectoryImport.spaces,
            { id: 'team-south', kind: 'team', name: '南队' },
          ],
          memberships: [
            ...spaceDirectoryImport.memberships,
            { spaceId: 'team-south', accountId: 'zhao' },
            { spaceId: 'team-south', accountId: 'lin' },
          ],
          projectSpaces: [
            ...spaceDirectoryImport.projectSpaces,
            { projectId: 'support', spaceId: 'team-south' },
          ],
        },
        workbenchSeed: [
          ...workbenchSeed,
          { type: 'save-project', project: { id: 'support', name: '支持服务', description: '' } },
          { type: 'save-task', task: secondTask },
        ],
      });
      const cookies = {};
      for (const account of Object.keys(PASSWORDS))
        cookies[account] = await host.login(account, PASSWORDS[account]);
      const bytes = Buffer.from('identical real bytes in independently authorized tasks');
      const declare = {
        name: '共享字节.md',
        mediaType: 'text/markdown',
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const receipts = [];
      for (const [member, taskId, spaceId] of [
        ['chen', 'portal-task', 'team-north'],
        ['zhao', 'support-task', 'team-south'],
      ]) {
        const startable = await host.exec('startable', { spaceId }, cookies[member]);
        const plan = startable.result.value.plans.find((entry) => entry.taskId === taskId);
        assert.ok(plan);
        assert.equal(
          (
            await host.exec(
              'start-plan',
              { ...planRef(plan), idempotencyKey: `start-${taskId}` },
              cookies[member],
            )
          ).result.ok,
          true,
        );
        const options = {
          ...planRef(plan),
          nodeId: 'design',
          spaceId,
          idempotencyKey: `file-${taskId}`,
        };
        const uploaded = await host.upload(declare, options, bytes, cookies[member]);
        assert.equal(uploaded.json?.ok, true, JSON.stringify(uploaded.json));
        receipts.push(uploaded.json.value);
        for (const forbidden of ['lin', 'outside']) {
          const denied = await host.upload(
            declare,
            { ...options, idempotencyKey: `deny-${forbidden}-${taskId}` },
            bytes,
            cookies[forbidden],
          );
          assert.equal(denied.json?.ok, false);
        }
      }
      assert.equal(
        receipts[0].attachmentId,
        receipts[1].attachmentId,
        'The SDK can deduplicate bytes',
      );
      assert.notEqual(
        receipts[0].uploadId,
        receipts[1].uploadId,
        'A digest cannot share a product authorization fact',
      );
      await host.close();
      const ledger = JSON.parse(
        await readFile(join(directory, 'storages', 'zhuma_files.json'), 'utf8'),
      );
      const rows = Object.values(ledger.tables.files);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => [row.uploadedBy, row.spaceId, row.taskId]).sort(), [
        ['chen', 'team-north', 'portal-task'],
        ['zhao', 'team-south', 'support-task'],
      ]);
    } finally {
      await host?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'M1 real HTTP: an opened paused reader cancels on disconnect, live membership revoke and deadline',
  { timeout: 30000 },
  async (t) => {
    for (const mode of ['disconnect', 'revoke', 'deadline']) {
      await t.test(mode, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'zhuma-file-http-lifetime-'));
        let host;
        const controller = new AbortController();
        try {
          host = await startAcceptanceHost(directory, {
            deploymentMode: 'multi-member',
            identityImport,
            spaceDirectoryImport,
            workbenchSeed,
            observeUpload: true,
          });
          const chen = await host.login('chen', PASSWORDS.chen);
          const startable = await host.exec('startable', {}, chen);
          const plan = startable.result.value.plans.find((entry) => entry.taskId === 'portal-task');
          assert.equal(
            (
              await host.exec(
                'start-plan',
                { ...planRef(plan), idempotencyKey: `start-${mode}` },
                chen,
              )
            ).result.ok,
            true,
          );
          const before = await executionText(directory);
          if (mode === 'deadline') await host.act('enableFileUploadClock');
          const bytes = Buffer.from('first chunk plus a withheld final chunk');
          const body = new ReadableStream({
            start(stream) {
              stream.enqueue(bytes.subarray(0, 11));
            },
          });
          const upload = host.upload(
            {
              name: `held-${mode}.md`,
              mediaType: 'text/markdown',
              byteSize: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            {
              ...planRef(plan),
              nodeId: 'design',
              spaceId: 'team-north',
              idempotencyKey: `held-${mode}`,
            },
            body,
            chen,
            controller.signal,
          );
          // The real SDK has asked for a second chunk after opening and consuming
          // the first raw HTTP read. No EOS or final bytes are supplied.
          await host.wait('file-upload-read-2');
          const inbox = await host.exec('inbox', { spaceId: 'team-north' }, chen);
          assert.equal(inbox.result.ok, true, 'The upload cannot occupy the global writes queue');
          if (mode === 'disconnect') {
            controller.abort();
            await assert.rejects(upload, { name: 'AbortError' });
          } else {
            await host.act(
              mode === 'revoke' ? 'revokeFileAssigneeMembership' : 'advanceFileUploadClock',
            );
            const result = await upload;
            assert.equal(result.json?.ok, false, JSON.stringify(result.json));
            assert.equal(
              result.json.error.code,
              mode === 'revoke' ? 'cancelled' : 'upload-timeout',
            );
          }
          await host.wait('file-upload-settled');
          // An IPC round trip also proves the real carrier did not die with
          // Node's queued onData/controller-closed exception.
          assert.equal((await host.act('inspect')).modelCalls, 0);
          assert.equal(await executionText(directory), before);
          await host.close();
          assert.deepEqual(await storedAttachmentFiles(directory), []);
          const ledger = await readFile(
            join(directory, 'storages', 'zhuma_files.json'),
            'utf8',
          ).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (ledger) assert.deepEqual(JSON.parse(ledger).tables.files, {});
        } finally {
          controller.abort();
          await host?.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  },
);
