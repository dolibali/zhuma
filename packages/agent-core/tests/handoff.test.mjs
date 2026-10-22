import assert from 'node:assert/strict';
import test from 'node:test';
import { assigneeUsesAgentRuntime, handoffPayloadExcludesCredentials } from '@zhuma/agent-core';

test('expert and agent assignees use the agent runtime, humans do not', () => {
  assert.equal(assigneeUsesAgentRuntime('expert'), true);
  assert.equal(assigneeUsesAgentRuntime('agent'), true);
  assert.equal(assigneeUsesAgentRuntime('human'), false);
});

test('handoff payload type excludes credential fields', () => {
  assert.equal(handoffPayloadExcludesCredentials, true);
});
