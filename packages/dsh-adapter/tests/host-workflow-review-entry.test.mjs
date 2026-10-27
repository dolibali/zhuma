/** Emitted projection + original core confirmed plan; signed resolver/Service are
 * contracts, not real member login or Agent dispatch evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { createHostWorkflowOwner } from '../dist/host-workflow-owner.js';
import {
  installMemberResolver,
  memberCredential,
  MEMBER_COOKIE_NAME,
} from '../dist/member-session.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

test('workflow review entry projection uses required reviewers in the confirmed plan, preserving zero expert assignments', async () => {
  for (const scenario of [
    { required: true, reviewer: 'qa', expected: true },
    { required: false, reviewer: 'qa', expected: false },
    { required: true, reviewer: 'outside', expected: false },
  ]) {
    const data = fixture();
    const state = applyWorkbenchCommand(data.state, {
      type: 'save-task',
      task: {
        ...data.task,
        status: 'ready',
        participantIds: ['chen', 'qa', 'outside'],
        workflows: [
          {
            ...data.task.workflows[0],
            nodes: [
              {
                ...data.node,
                assigneeId: 'chen',
                reviewRequired: scenario.required,
                reviewerIds: scenario.required ? [scenario.reviewer] : [],
                skillIds: [],
                mcpIds: [],
              },
            ],
          },
        ],
      },
    });
    const plan = state.appliedPlans[0];
    const location = {
      spaceId: 'north',
      taskId: plan.taskId,
      planId: plan.id,
      revision: plan.revision,
    };
    // A mutable current draft/directory must not reinterpret a fixed reviewer.
    state.participants.find((member) => member.id === 'qa').kind = 'human';
    const ctx = {},
      lifetime = new AbortController();
    const secret = Buffer.alloc(32, 9),
      expiresAt = Date.now() + 60000,
      sessionId = '00000000-0000-4000-8000-000000000001';
    const uninstall = installMemberResolver(ctx, {
      secret,
      requestRejection: () => undefined,
      findSession: (id) => (id === sessionId ? { accountId: 'chen', expiresAt } : undefined),
      spaceIdsFor: () => ['north'],
      singleUserAccountId: () => undefined,
      admitOwner: () => false,
    });
    const request = {
      headers: {
        cookie: `${MEMBER_COOKIE_NAME}=${memberCredential(secret, sessionId, expiresAt)}`,
      },
    };
    const owner = createHostWorkflowOwner(ctx, {
      execution: {
        readWorkflowExecution: async () => ({
          ok: true,
          value: {
            disposition: 'unchanged',
            location,
            intent: undefined,
            requiresResume: false,
            activeRunIds: [],
            state: 'inactive',
          },
        }),
        readRunNode: () => undefined,
      },
      runs: {},
      workspaces: {},
      signal: lifetime.signal,
      readWorkbench: () => state,
      prepareResume: async () => assert.fail(),
    });
    try {
      const result = await owner.operations.read(request, location);
      assert.equal(result.ok, true, JSON.stringify(result));
      const view = result.value;
      assert.equal(view.expertNodeCount, 0);
      assert.equal(view.expertReviewRequired, scenario.expected);
      assert.equal(view.planStarted, false);
    } finally {
      await owner.close();
      uninstall();
    }
  }
});
