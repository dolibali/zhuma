import { NODE_STATUSES } from '@zhuma/agent-core';
export const target = { taskId: 'task', planId: 'plan', revision: 2 };
export const query = { spaceId: 'north', plans: [target] };
export const signal = () => new AbortController().signal;
function markers(byStatus, authorHeld) {
  const items = [];
  let index = 0;
  for (const status of NODE_STATUSES)
    for (let count = 0; count < (byStatus?.[status] ?? 0); count++)
      items.push({ nodeId: `n-${index++}`, status, authorHeld: 0, assignee: 'expert' });
  let left = authorHeld ?? 0;
  for (const item of items) {
    if (!left) break;
    if (item.status === 'running') {
      item.authorHeld = 1;
      left--;
    }
  }
  for (const item of items) {
    if (!left) break;
    item.authorHeld += 1;
    left--;
  }
  return items;
}
export function row(patch = {}) {
  const value = {
    target,
    facts: 'present',
    delivery: 'pending',
    expectedNodes: 5,
    acceptedNodes: 2,
    byStatus: {
      ...Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])),
      running: 2,
      'in-review': 1,
      completed: 2,
    },
    assigneeCounts: { human: 3, expert: 2 },
    humanReady: 0,
    resources: { authorHeld: 2, reviewHeld: 1, stopRequested: 0 },
    workflow: 'inactive',
    ...patch,
  };
  if (value.facts !== 'unknown' && !Object.hasOwn(patch, 'nodeStatuses'))
    value.nodeStatuses = markers(value.byStatus, value.resources?.authorHeld ?? 0);
  if (value.facts === 'not-started' && !Object.hasOwn(patch, 'workflow')) value.workflow = null;
  return value;
}
export const value = (items = [row()], patch = {}) => ({
  actorId: 'chen',
  spaceId: 'north',
  coverage: 'current-confirmed-plans',
  items,
  ...patch,
});
export const unknown = () =>
  row({
    facts: 'unknown',
    delivery: 'unknown',
    reason: 'node-limit',
    expectedNodes: 81,
    acceptedNodes: null,
    byStatus: null,
    nodeStatuses: null,
    workflow: null,
    assigneeCounts: null,
    humanReady: null,
    resources: null,
  });
