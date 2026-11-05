import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyWorkbenchCommand,
  castBallot,
  emptyWorkbench,
  executionInbox,
  parseWorkflowTemplate,
  settleReview,
  startAppliedPlan,
  submitDelivery,
  unlockDownstream,
} from '@zhuma/agent-core';

const directory = new URL('../', import.meta.url);
const root = new URL('../../../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', directory), 'utf8'));
const legacyDigests = {
  'requirements-to-test.json': '05889adea412b2bbbc2d8d1fbb728e5dda6e2de1fb8e9a66b3cb76c284282b4d',
  'design-to-plan.json': '7668b76b1e105ee7460d438b3bac0d68d130001370d8ce186f5da72365a0dc92',
  'review-fix-verify.json': '6f74d69dbfb2e7ed149f8b4a60f09d1a0d0a064f85bbfe672da4b0a8511a1378',
  'sources-to-docs.json': '6341c51355b7f023cf06e0da6f3d80ca4a428d22918faf072e1c60886e9720dd',
};

test('legacy workflow bytes and IDs stay available beside the new default', async () => {
  assert.equal(catalog.workflows.length, 5);
  assert.equal(catalog.workflows[0].id, 'zhuma-eng-requirements-to-code');
  assert.equal(catalog.workflows[0].file, 'requirements-to-code.json');
  for (const [file, digest] of Object.entries(legacyDigests)) {
    const bytes = await readFile(new URL(file, directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, file);
    assert.ok(catalog.workflows.some((entry) => entry.file === file));
  }
});

test('all templates parse with the existing production v1 parser and bind real catalog Skills', async () => {
  const knownSkills = new Set(catalog.skills.map((entry) => entry.id));
  assert.equal(knownSkills.size, 11);
  for (const entry of catalog.workflows) {
    const template = parseWorkflowTemplate(await readFile(new URL(entry.file, directory), 'utf8'));
    for (const resource of template.resources) {
      if (resource.kind === 'skill') assert.ok(knownSkills.has(resource.suggestedAssetId));
    }
    for (const suggestions of Object.values(entry.roleSkillSuggestions)) {
      for (const assetId of suggestions) assert.ok(knownSkills.has(assetId));
    }
  }
  for (const entry of catalog.skills) {
    assert.match(await readFile(new URL(entry.entry, root), 'utf8'), /^---\nname:/);
    assert.match(await readFile(new URL(entry.licenseFile, root), 'utf8'), /MIT License/);
  }
});

test('six-node flow has concrete implementation Skill and fixed-input human review checkpoints', async () => {
  const template = parseWorkflowTemplate(
    await readFile(new URL('requirements-to-code.json', directory), 'utf8'),
  );
  const nodes = template.workflows[0].nodes;
  assert.deepEqual(
    nodes.map((node) => node.id),
    ['requirements', 'design', 'implement', 'verify', 'review', 'deliver'],
  );
  assert.deepEqual(nodes[2].skillIds, ['controlled-implementation']);
  assert.deepEqual(nodes[2].dependsOn, ['requirements', 'design']);
  assert.equal(template.roles.find((role) => role.id === 'human-approver').preferredKind, 'human');
  assert.equal(nodes[1].reviewRequired, true);
  assert.deepEqual(nodes[1].reviewerIds, ['human-approver']);
  assert.equal(nodes[4].reviewRequired, true);
  assert.equal(nodes[4].assigneeId, nodes[2].assigneeId);
  assert.deepEqual(nodes[4].reviewerIds, ['independent-reviewer', 'human-approver']);
  assert.ok(nodes[4].reviewerIds.every((id) => id !== nodes[4].assigneeId));
  assert.deepEqual(nodes[4].skillIds, ['bounded-fix', 'focused-verification']);
  assert.deepEqual(nodes[5].dependsOn, ['requirements', 'design', 'review']);
});

test('review rejection returns work to the implementer and delivery receives only the new accepted code/report version (domain contract)', async () => {
  const template = parseWorkflowTemplate(
    await readFile(new URL('requirements-to-code.json', directory), 'utf8'),
  );
  const state = emptyWorkbench();
  state.projects.push({ id: 'contract-project', name: '契约项目', description: '' });
  // Human stand-ins exercise the original domain commands; this is not Agent/model evidence.
  state.participants = template.roles.map((role) => ({
    id: role.id,
    name: role.name,
    kind: 'human',
    role: '',
    capabilities: role.capabilities,
    instructions: '',
    available: true,
  }));
  state.assets = template.resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    description: '',
    content: 'Contract-only Skill body',
    available: true,
  }));
  const confirmed = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      id: 'contract-task',
      projectId: 'contract-project',
      title: '退回与固定版本交接契约',
      goal: 'Contract-only synthetic code/report versions',
      ownerId: 'human-approver',
      participantIds: state.participants.map((person) => person.id),
      workflows: template.workflows,
      status: 'ready',
      updatedAt: '2026-11-05T00:00:00.000Z',
    },
  });
  const applied = confirmed.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'human-approver',
    existing: [],
  });
  assert.equal(started.ok, true);
  let records = started.records;
  let sequence = 0;
  const at = (id) => {
    const record = records.find((value) => value.nodeId === id);
    assert.ok(record, id);
    return record;
  };
  const save = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    records = records.map((record) =>
      record.nodeId === result.record.nodeId ? result.record : record,
    );
    return result.record;
  };
  const unlock = (id) =>
    save(
      unlockDownstream({
        record: at(id),
        dependencies: records,
        actorId: 'human-approver',
        idempotencyKey: `unlock:${id}:${sequence++}`,
        expectedVersion: at(id).command.version,
      }),
    );
  const submit = (id, version) =>
    save(
      submitDelivery({
        record: at(id),
        actorId: at(id).handoff.assignee.id,
        expectedVersion: at(id).command.version,
        idempotencyKey: `submit:${id}:${version}`,
        artifactId: `artifact:${id}:${version}`,
        roundId: `round:${id}:${version}`,
        draft: { text: `Contract: ${id} code/report ${version}`, files: [], links: [] },
      }),
    );
  const vote = (id, actorId, action, comment) => {
    const record = at(id),
      round = record.rounds.find((value) => value.id === record.currentRoundId);
    return save(
      castBallot({
        record,
        actorId,
        idempotencyKey: `vote:${round.id}:${actorId}:${action}`,
        expectedVersion: record.command.version,
        ballot: {
          reviewerId: actorId,
          roundId: round.id,
          artifactVersionId: round.artifactVersionId,
          action,
          ...(comment ? { comment } : {}),
        },
      }),
    );
  };
  const settle = (id) => {
    const record = at(id),
      round = record.rounds.find((value) => value.id === record.currentRoundId);
    return save(
      settleReview({
        record,
        actorId: 'human-approver',
        idempotencyKey: `settle:${round.id}:${sequence++}`,
        expectedVersion: record.command.version,
        roundId: round.id,
        artifactVersionId: round.artifactVersionId,
      }),
    );
  };

  submit('requirements', 'v1');
  unlock('design');
  submit('design', 'v1');
  vote('design', 'human-approver', 'approve');
  settle('design');
  for (const id of ['implement', 'verify']) {
    unlock(id);
    submit(id, 'v1');
  }
  unlock('review');
  submit('review', 'v1');
  const originalRound = structuredClone(at('review').rounds.at(-1));
  vote('review', 'independent-reviewer', 'request-changes', '契约意见：修正行号并重跑报告');
  assert.equal(settle('review').command.status, 'needs-revision');
  assert.equal(
    executionInbox({ actorId: 'implementer', records }).find((row) => row.nodeId === 'review')
      ?.action,
    'revise',
  );
  assert.equal(unlock('deliver').command.status, 'blocked');
  assert.equal(at('implement').command.status, 'completed');
  assert.equal(at('verify').command.status, 'completed');

  submit('review', 'v2');
  assert.equal(at('review').rounds.length, 2);
  assert.equal(at('review').rounds.at(-1).ballots.length, 0);
  const stale = castBallot({
    record: at('review'),
    actorId: 'independent-reviewer',
    idempotencyKey: 'stale-v1-vote',
    expectedVersion: at('review').command.version,
    ballot: {
      reviewerId: 'independent-reviewer',
      roundId: originalRound.id,
      artifactVersionId: originalRound.artifactVersionId,
      action: 'approve',
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-round');
  vote('review', 'independent-reviewer', 'approve');
  assert.equal(settle('review').command.status, 'in-review');
  vote('review', 'human-approver', 'approve');
  const accepted = settle('review');
  assert.equal(accepted.command.status, 'completed');
  assert.notEqual(accepted.acceptedArtifactVersionId, originalRound.artifactVersionId);
  const delivery = unlock('deliver');
  assert.equal(delivery.command.status, 'ready');
  assert.deepEqual(
    delivery.handoff.inputRefs.map((ref) => ref.sourceNodeId),
    ['requirements', 'design', 'review'],
  );
  assert.equal(
    delivery.handoff.inputRefs.find((ref) => ref.sourceNodeId === 'review').artifactVersionId,
    accepted.acceptedArtifactVersionId,
  );
});
