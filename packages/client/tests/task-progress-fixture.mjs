import { NODE_STATUSES } from '@zhuma/agent-core';
export const target = { taskId: 'task', planId: 'plan', revision: 2 };
export const query = { spaceId: 'north', plans: [target] };
export const signal = () => new AbortController().signal;
export function row(patch = {}) {
  return {
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
    resources: { authorHeld: 2, reviewHeld: 1, stopRequested: 0 },
    ...patch,
  };
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
    assigneeCounts: null,
    resources: null,
  });
