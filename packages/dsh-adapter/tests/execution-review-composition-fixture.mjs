import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  startAppliedPlan,
  submitDelivery,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { executionReviewTarget, prepareExecutionReview } from '../dist/execution-review-state.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';

// Getter output exported from C's exact committed 14ead7c6 sources, not native runtime evidence.
export const reviewDescriptors = JSON.parse(
  readFileSync(new URL('./native-review-descriptors-14ead7c.json', import.meta.url), 'utf8'),
);
export function reviewCompositionFacts({
  resources = false,
  text = 'PRIVATE_FIXED_BODY_FETCH_USING_REVIEW_READER',
} = {}) {
  const f = fixture();
  const reviewer = f.state.participants.find((p) => p.id === 'qa');
  reviewer.instructions = 'Read the fixed artifact independently and explain concrete issues.';
  if (resources) {
    reviewer.resourceBindings = { skillIds: ['review-skill'], mcpIds: ['review-mcp'] };
    f.state.assets.push(
      {
        id: 'review-skill',
        name: 'Review method',
        kind: 'skill',
        description: 'Review',
        content: 'Check the fixed API contract.',
        available: true,
      },
      {
        id: 'review-mcp',
        name: 'Review tool',
        kind: 'mcp',
        description: 'Review',
        content: 'PRIVATE_MCP_CONFIGURATION_NOT_IN_REVIEW_PROMPT',
        available: true,
      },
    );
  }
  const workbench = applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      status: 'ready',
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [
            f.node,
            // Existing snapshot qualification: reference the review assets in another
            // real node. Production missing expert-only pins must fail, never read live assets.
            ...(resources
              ? [
                  {
                    ...f.node,
                    id: 'resource-pins',
                    skillIds: ['review-skill'],
                    mcpIds: ['review-mcp'],
                    reviewerIds: [],
                    reviewRequired: false,
                  },
                ]
              : []),
          ],
        },
      ],
    },
  });
  const applied = workbench.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
    applied,
    actorId: 'chen',
    existing: [],
  });
  if (!started.ok) throw Error(started.code);
  const ready = started.records[0];
  const delivery = submitDelivery({
    record: ready,
    actorId: 'chen',
    idempotencyKey: 'submit-review-target',
    expectedVersion: ready.command.version,
    artifactId: 'fixed-review-artifact',
    roundId: 'fixed-review-round',
    draft: { text, files: [], links: [] },
  });
  if (!delivery.ok) throw Error(delivery.code);
  const node = delivery.record;
  const attempt = prepareExecutionReview(node, applied, {
    requestId: 'review-composition',
    expectedReviewVersion: 0,
    target: executionReviewTarget(node, 'north'),
    reviewerId: 'qa',
    controllerMemberId: 'chen',
    configurationId: 'candidate-only',
    newRunId: 'review-run-one',
    newSegmentId: 'review-segment-one',
  }).attempt;
  const facts = {
    node,
    applied,
    scope: attempt.scope,
    model: { provider: 'contract', model: 'contract-review', maxTokens: 3000 },
    tools: {
      readTarget: structuredClone(reviewDescriptors.readTarget),
      completeReview: structuredClone(reviewDescriptors.completeReview),
    },
  };
  if (resources)
    facts.resourceCatalog = {
      sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
      mcp: [
        {
          ref: { id: 'review-mcp', version: applied.id },
          definitionDigest: executionResourceDigest(
            applied.assets.find((a) => a.id === 'review-mcp'),
          ),
          connectionRef: { id: 'actual-contract-source', version: '1' },
          serverName: 'review',
          tools: [
            {
              name: 'mcp__review__lookup',
              description: 'Read contract references',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
              outputSchema: { type: 'object' },
            },
          ],
        },
      ],
    };
  return facts;
}
export function rebindReviewDefinition(facts) {
  facts.scope.review.principal.reviewerRef.digest = createHash('sha256')
    .update(canonicalPayload(facts.applied.participants.find((p) => p.id === 'qa')))
    .digest('hex');
}
