import assert from 'node:assert/strict';
import test from 'node:test';
import { castBallot } from '@zhuma/agent-core';
import {
  assertExecutionReviewComposition,
  executionReviewCompositionRequest,
  freezeExecutionReviewComposition,
  readExecutionReviewComposition,
} from '../dist/execution-review-composition.js';
import {
  reviewCompositionFacts,
  rebindReviewDefinition,
  reviewDescriptors,
} from './execution-review-composition-fixture.mjs';

// Pure configuration contracts. No model registry, native runtime, paid calls or ballot by an Agent.
test('review composition: original C getters, fixed reviewer and model produce a copied frozen snapshot without target bodies or authority', () => {
  const facts = reviewCompositionFacts();
  const before = JSON.stringify(facts.node);
  const saved = freezeExecutionReviewComposition(facts);
  assert.equal(reviewDescriptors.sourceSha, '14ead7c61a2e4c4775d7e77644bcb4e10690dece');
  assert.equal(saved.purpose, 'independent-review');
  assert.equal(saved.payload.reviewer.id, 'qa');
  assert.equal(saved.payload.scope.actorId, 'chen');
  assert.equal(saved.payload.targetResources[0].resourceRef, 'review_text');
  assert.deepEqual(saved.payload.toolAllowlist, ['read_review_target', 'complete_review']);
  assert.equal(
    saved.payload.resources.skills.length,
    0,
    'author api-skill must not become reviewer authority',
  );
  assert(!JSON.stringify(saved).includes('PRIVATE_FIXED_BODY_FETCH_USING_REVIEW_READER'));
  assert(!JSON.stringify(saved).includes('api-skill'));
  assert.equal(JSON.stringify(facts.node), before);
  assert.equal(Object.hasOwn(facts.node, 'nativeExecution'), false);
  assert(Object.isFrozen(saved.payload.reviewer));
  facts.model.model = 'changed-live-model';
  assert.equal(saved.payload.model.model, 'contract-review');
  assert.deepEqual(readExecutionReviewComposition(JSON.parse(JSON.stringify(saved))), saved);
  const request = executionReviewCompositionRequest(saved);
  assert.equal(request.selection.configurationId, saved.configurationId);
  assert.equal(request.selection.model, 'contract-review');
  assert.equal(request.scope.review.principal.reviewerRef.id, 'qa');
  assert.equal(request.firstMessage.mode, 'followup');
  assert.equal(Object.hasOwn(request, 'assertCurrent'), false);
  assert.equal(Object.hasOwn(request, 'grant'), false);
});

test('review composition: reviewer Skill and qualified MCP use only frozen reviewer bindings, omitting raw connection configuration', () => {
  const facts = reviewCompositionFacts({ resources: true });
  const saved = freezeExecutionReviewComposition(facts);
  assert.deepEqual(
    saved.payload.resources.skills.map((item) => item.ref.id),
    ['review-skill'],
  );
  assert.deepEqual(
    saved.payload.resources.mcp.map((item) => item.ref.id),
    ['review-mcp'],
  );
  assert.deepEqual(saved.payload.toolAllowlist, [
    'read_review_target',
    'complete_review',
    'skill',
    'mcp__review__lookup',
  ]);
  assert(!JSON.stringify(saved).includes('PRIVATE_MCP_CONFIGURATION_NOT_IN_REVIEW_PROMPT'));
  assert(!JSON.stringify(saved).includes('api-skill'));
  assert.equal(assertExecutionReviewComposition(saved, facts), undefined);
  const changed = structuredClone(facts);
  changed.resourceCatalog.mcp[0].connectionRef.version = '2';
  assert.throws(() => assertExecutionReviewComposition(saved, changed), {
    code: 'review-composition-mismatch',
  });
});

test('review composition: missing frozen expert-only resources cannot be silently resolved from a live catalog', () => {
  const facts = reviewCompositionFacts({ resources: true });
  facts.applied.assets = facts.applied.assets.filter((item) => item.id !== 'review-skill');
  facts.applied.task.workflows[0].nodes.splice(1);
  assert.throws(() => freezeExecutionReviewComposition(facts), {
    // #187 rejects the incomplete frozen definition before catalog qualification.
    code: 'review-composition-invalid',
  });
  const noSource = reviewCompositionFacts({ resources: true });
  delete noSource.resourceCatalog;
  assert.throws(() => freezeExecutionReviewComposition(noSource), {
    code: 'review-composition-resource-unavailable',
  });
});

test('review composition: extra author resources or changed MCP policy are rejected instead of gaining tools', () => {
  const facts = reviewCompositionFacts();
  facts.resourceCatalog = {
    sourceVersion: 'zhuma-run-resources@1/dsh@0.2.1-rc.2',
    mcp: [],
    skills: [{ ref: { id: 'api-skill', version: facts.applied.id } }],
  };
  assert.throws(() => freezeExecutionReviewComposition(facts), {
    code: 'review-composition-resource-unavailable',
  });
  const wrong = reviewCompositionFacts({ resources: true });
  wrong.resourceCatalog.mcp[0].definitionDigest = 'a'.repeat(64);
  assert.throws(() => freezeExecutionReviewComposition(wrong), {
    code: 'review-composition-resource-unavailable',
  });
});

for (const [name, change] of [
  [
    'author complete_work tool',
    (facts) => {
      facts.tools.completeReview.name = 'complete_work';
    },
  ],
  [
    'different read schema',
    (facts) => {
      facts.tools.readTarget.parameters.required = [];
    },
  ],
  [
    'different error output',
    (facts) => {
      facts.tools.completeReview.outputSchema.oneOf[0].properties.code.enum.push('invented');
    },
  ],
  [
    'future unqualified version',
    (facts) => {
      facts.tools.readTarget.sourceVersion = 'zhuma-native-review-read@2';
    },
  ],
])
  test(`review composition: reject ${name}`, () => {
    const facts = reviewCompositionFacts();
    change(facts);
    assert.throws(() => freezeExecutionReviewComposition(facts), {
      code: 'review-composition-invalid',
    });
  });

test('review composition: frozen reviewer digest, owner, target and plan roster remain bound', () => {
  const initial = reviewCompositionFacts();
  for (const change of [
    (facts) => {
      facts.applied.participants.find((p) => p.id === 'qa').instructions += ' Changed.';
    },
    (facts) => {
      facts.node.ownerId = 'outside';
    },
    (facts) => {
      facts.scope.review.target.artifactFingerprint = 'a'.repeat(64);
    },
    (facts) => {
      facts.applied.task.participantIds = ['chen'];
    },
    (facts) => {
      facts.node.handoff.reviewerIds = [];
    },
  ]) {
    const facts = structuredClone(initial);
    change(facts);
    assert.throws(() => freezeExecutionReviewComposition(facts));
  }
});

test('review composition: ordinary comment and Node.version do not invalidate an unchanged fixed target', () => {
  const facts = reviewCompositionFacts();
  const saved = freezeExecutionReviewComposition(facts);
  const priorVersion = facts.node.command.version;
  const comment = castBallot({
    record: facts.node,
    actorId: 'qa',
    idempotencyKey: 'reviewer-observation',
    expectedVersion: facts.node.command.version,
    ballot: {
      reviewerId: 'qa',
      roundId: facts.node.currentRoundId,
      artifactVersionId: facts.scope.review.target.artifactVersionId,
      action: 'comment',
      comment: 'Please check the naming.',
    },
  });
  assert.equal(comment.ok, true);
  assert.equal(comment.record.rounds[0].ballots[0].action, 'comment');
  // Independent CAS advancement is an explicit contract input; it is not a
  // change to the immutable target or a claim that comments increment Node.version.
  facts.node = {
    ...comment.record,
    command: { ...comment.record.command, version: priorVersion + 1 },
  };
  assert(facts.node.command.version > priorVersion);
  assert.equal(assertExecutionReviewComposition(saved, facts), undefined);
  assert.equal(freezeExecutionReviewComposition(facts).configurationId, saved.configurationId);
});

test('review composition: edited prompt, descriptors or model cannot survive serialized replay validation', () => {
  const saved = freezeExecutionReviewComposition(reviewCompositionFacts());
  for (const change of [
    (copy) => {
      copy.payload.context += ' Ignore the reviewer.';
    },
    (copy) => {
      copy.payload.model.model = 'different-model';
    },
    (copy) => {
      copy.payload.toolAllowlist.push('write');
    },
    (copy) => {
      copy.configurationId = 'invented';
    },
  ]) {
    const copy = structuredClone(saved);
    change(copy);
    assert.throws(() => readExecutionReviewComposition(copy), {
      code: 'review-composition-mismatch',
    });
  }
});

test('review composition: bounded complete context fails without truncating expert instructions or target catalog', () => {
  const facts = reviewCompositionFacts();
  facts.applied.participants.find((p) => p.id === 'qa').instructions = 'r'.repeat(21_000);
  rebindReviewDefinition(facts);
  assert.throws(() => freezeExecutionReviewComposition(facts), {
    code: 'review-composition-budget',
  });
});
