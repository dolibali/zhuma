/** E's deterministic postcommit-abort reproduction, retained as a contract.
 * Original emitted owner/bridge + synthetic signed member resolver/execution port.
 * No actual Service commit, HTTP connection, SDK driver or model is certified. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { createHostWorkflowOwner } from '../dist/host-workflow-owner.js';
import {
  installMemberResolver,
  memberCredential,
  MEMBER_COOKIE_NAME,
} from '../dist/member-session.js';
import { workflowExecutionIntentSchema } from '../dist/execution-workflow-contract.js';

for (const { recovery, abortAfterCommit, negative, stopping = false } of [
  ...[false, true].flatMap((recovery) =>
    [false, true].map((abortAfterCommit) => ({ recovery, abortAfterCommit })),
  ),
  { recovery: false, abortAfterCommit: false, negative: 'already-aborted' },
  { recovery: false, abortAfterCommit: false, negative: 'refused' },
  { recovery: true, abortAfterCommit: false, stopping: true },
  { recovery: true, abortAfterCommit: false, stopping: true, negative: 'refused' },
]) {
  test(`Host resume contract: ${stopping ? 'stopping ' : ''}${negative ?? `${recovery ? 'recovery' : 'warm'} accepted generation with caller abort=${abortAfterCommit}`}`, async () => {
    const data = fixture();
    const state = applyWorkbenchCommand(data.state, {
      type: 'save-task',
      task: { ...data.task, status: 'ready' },
    });
    const plan = state.appliedPlans[0];
    const location = {
      spaceId: 'north',
      taskId: data.task.id,
      planId: plan.id,
      revision: plan.revision,
    };
    const intent = workflowExecutionIntentSchema.parse({
      schemaVersion: 1,
      intentId: 'intent',
      actorId: data.task.ownerId,
      spaceId: 'north',
      generation: 1,
      version: 1,
      status: stopping ? 'stopping' : 'paused',
      defaults: {
        model: { provider: 'contract', model: 'model', maxTokens: 1000 },
        tools: 'text-only',
        workspace: { kind: 'text-only' },
      },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
      commandReceipts: [
        { requestId: 'start', kind: 'start', fingerprint: '0'.repeat(64), generation: 1 },
      ],
      starts: [],
    });
    const ctx = {},
      lifetime = new AbortController(),
      wait = new AbortController();
    let committed = false,
      claims = 0,
      resumeCalls = 0,
      preparations = 0;
    const secret = Buffer.alloc(32, 7),
      expiresAt = Date.now() + 60_000;
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const uninstall = installMemberResolver(ctx, {
      secret,
      requestRejection: () => undefined,
      findSession: (id) =>
        id === sessionId ? { accountId: data.task.ownerId, expiresAt } : undefined,
      spaceIdsFor: () => ['north'],
      singleUserAccountId: () => undefined,
      admitOwner: () => false,
    });
    const request = {
      headers: {
        cookie: `${MEMBER_COOKIE_NAME}=${memberCredential(secret, sessionId, expiresAt)}`,
      },
    };
    const view = () => ({
      disposition: 'unchanged',
      location,
      intent: {
        ...intent,
        generation: committed ? 2 : 1,
        version: committed ? 2 : 1,
        status: committed ? 'running' : stopping ? 'stopping' : 'paused',
      },
      requiresResume: !committed && recovery && !stopping,
      activeRunIds: [],
      state: committed ? 'running' : stopping ? 'stopping' : 'paused',
    });
    const execution = {
      readWorkflowExecution: async () => ({ ok: true, value: view() }),
      readRunNode: () => undefined,
      resumeWorkflowExecution: async () => {
        resumeCalls++;
        if (negative === 'refused')
          return { ok: false, error: { code: 'workflow-authority-denied' } };
        if (recovery && resumeCalls === 1)
          return { ok: false, error: { code: 'workflow-recovery-required' } };
        committed = true;
        if (abortAfterCommit) wait.abort();
        return { ok: true, value: view() };
      },
      claimWorkflowExecution: async (original, accepted) => {
        claims++;
        assert.equal(original, request);
        assert.deepEqual(accepted, { ...location, intentId: 'intent', generation: 2 });
        return { ok: false, error: { code: 'probe-attach-observed' } };
      },
    };
    const owner = createHostWorkflowOwner(ctx, {
      execution,
      runs: {},
      signal: lifetime.signal,
      workspaces: {},
      readWorkbench: () => state,
      prepareResume: async (original, before) => {
        preparations++;
        assert.equal(original, request);
        if (stopping) {
          assert.equal(before.state, 'stopping');
          assert.equal(before.intent.generation, 1);
          assert.equal(before.intent.version, 1);
        }
      },
    });
    try {
      if (negative === 'already-aborted') wait.abort();
      const operation = owner.operations.resume(
        request,
        {
          ...location,
          intentId: 'intent',
          generation: 1,
          expectedVersion: 1,
          requestId: 'resume',
        },
        wait.signal,
      );
      if (negative) {
        if (negative === 'already-aborted') await assert.rejects(operation, { name: 'AbortError' });
        else assert.equal((await operation).ok, false);
        assert.equal(committed, false);
        assert.equal(resumeCalls, negative === 'refused' ? 1 : 0);
        assert.equal(preparations, 0);
        assert.equal(claims, 0);
        return;
      }
      await assert.rejects(operation, { code: 'probe-attach-observed' });
      assert.equal(committed, true);
      assert.equal(resumeCalls, recovery ? 2 : 1);
      assert.equal(preparations, recovery ? 1 : 0);
      assert.equal(claims, 1, 'A caller disconnect cannot retract the accepted generation');
    } finally {
      await owner.close();
      uninstall();
    }
  });
}
