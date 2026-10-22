import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE_STATUSES } from '@zhuma/agent-core';
import {
  INBOX_KIND_LABELS,
  NODE_STATUS_LABELS,
  createInboxItemView,
  createNodeExecutionView,
} from '@zhuma/client';

const report = {
  nodeId: 'node-1',
  taskId: 'task-1',
  workflowVersionId: 'plan-1',
  revision: 3,
  status: 'in-review',
  upstreamAffected: false,
  reviewOutcome: 'pending',
};

test('projects every node status without mutating the execution report', () => {
  for (const status of NODE_STATUSES) {
    assert.equal(typeof NODE_STATUS_LABELS[status], 'string');
    assert.ok(NODE_STATUS_LABELS[status].length > 0);
  }
  const before = structuredClone(report);
  const view = createNodeExecutionView(report);
  createNodeExecutionView({ ...report, status: 'completed' });
  assert.deepEqual(report, before);
  assert.equal(view.status, 'in-review');
  assert.equal(view.statusLabel, '待评审');
  assert.equal(view.taskId, report.taskId);
  assert.equal(view.revision, 3);
  assert.equal(view.reviewOutcome, 'pending');
  assert.equal('blockReason' in view, false);
});

test('inbox labels distinguish delivery, review, and confirmation', () => {
  assert.deepEqual(Object.keys(INBOX_KIND_LABELS).sort(), ['confirm', 'deliver', 'review']);
  const item = {
    id: 'deliver:node-1:human-1',
    kind: 'deliver',
    actorId: 'human-1',
    nodeId: 'node-1',
    taskId: 'task-1',
    reason: 'assignee-delivery',
  };
  const before = structuredClone(item);
  const view = createInboxItemView(item);
  assert.deepEqual(item, before);
  assert.equal(view.kindLabel, '待我交付');
  assert.equal(view.reason, 'assignee-delivery');
});
