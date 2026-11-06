import { NODE_STATUSES, type NodeStatus } from '@zhuma/agent-core';
import { ExecutionError } from './ExecutionApi.js';

export interface TaskProgressTarget {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
}
export interface TaskProgressQuery {
  readonly spaceId: string;
  readonly plans: readonly TaskProgressTarget[];
}
export interface TaskProgressResources {
  /** Original record metadata, not proof of a live Agent or physical drain. */
  readonly authorHeld: number;
  readonly reviewHeld: number;
  readonly stopRequested: number;
}
export interface TaskProgressNodeState {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly authorHeld: number;
  readonly assignee: 'human' | 'expert';
}
export type TaskProgressWorkflow =
  'inactive' | 'running' | 'stopping' | 'paused' | 'completed' | 'requires-resume';
interface KnownCounts {
  readonly target: TaskProgressTarget;
  readonly expectedNodes: number;
  readonly acceptedNodes: number;
  readonly byStatus: Readonly<Record<NodeStatus, number>>;
  /** Null when the server did not opt into node detail. Never synthesized from counts. */
  readonly nodeStatuses: readonly TaskProgressNodeState[] | null;
  /** Null when node detail was not returned. */
  readonly workflow: TaskProgressWorkflow | null;
  readonly assigneeCounts: { readonly human: number; readonly expert: number };
  /** Human assignees whose node status is `ready`: delivery is waiting on that person. */
  readonly humanReady: number;
  readonly resources: TaskProgressResources;
}
export type TaskProgressUnknownReason =
  | 'empty-plan'
  | 'unsupported-child-workflow'
  | 'invalid-plan'
  | 'node-limit'
  | 'incomplete-plan'
  | 'invalid-node'
  | 'invalid-state'
  | 'invalid-accepted';
export type TaskProgressRow =
  | (KnownCounts & { readonly facts: 'not-started'; readonly delivery: 'pending' })
  | (KnownCounts & {
      readonly facts: 'present';
      readonly delivery: 'pending' | 'all-accepted' | 'cancelled' | 'mixed-terminal';
      readonly reason?: 'upstream-affected';
    })
  | {
      readonly target: TaskProgressTarget;
      readonly facts: 'unknown';
      readonly reason: TaskProgressUnknownReason;
      readonly delivery: 'unknown';
      readonly expectedNodes: number | null;
      readonly acceptedNodes: null;
      readonly byStatus: null;
      readonly nodeStatuses: null;
      readonly workflow: null;
      readonly assigneeCounts: null;
      readonly humanReady: null;
      readonly resources: null;
    };
export interface TaskProgressValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly coverage: 'current-confirmed-plans';
  readonly items: readonly TaskProgressRow[];
}
export interface TaskProgressApi {
  read(query: TaskProgressQuery, signal: AbortSignal): Promise<TaskProgressValue>;
}
const message = '任务进度与当前计划不一致，请刷新后重试。';
function invalid(): never {
  throw new ExecutionError('validation', message);
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid();
  return raw as Record<string, unknown>;
}
function id(raw: unknown): string {
  return typeof raw === 'string' && /^[\w-]{1,100}$/u.test(raw) ? raw : invalid();
}
function count(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max
    ? raw
    : invalid();
}
function target(raw: unknown): TaskProgressTarget {
  const value = object(raw, ['taskId', 'planId', 'revision']);
  const revision = count(value.revision);
  if (!revision) invalid();
  return { taskId: id(value.taskId), planId: id(value.planId), revision };
}
function oneOf<T extends string>(raw: unknown, values: readonly T[]): T {
  return typeof raw === 'string' && values.includes(raw as T) ? (raw as T) : invalid();
}
function same(a: TaskProgressTarget, b: TaskProgressTarget) {
  return a.taskId === b.taskId && a.planId === b.planId && a.revision === b.revision;
}
/** Node detail is one optional pair. A single new key, or any other key, is rejected. */
function detailPair(value: Record<string, unknown>): boolean {
  const nodes = Object.hasOwn(value, 'nodeStatuses');
  const workflow = Object.hasOwn(value, 'workflow');
  if (nodes !== workflow) invalid();
  return nodes;
}
function row(raw: unknown, expected: TaskProgressTarget): TaskProgressRow {
  const value = object(raw, [
    'target',
    'facts',
    'reason',
    'delivery',
    'expectedNodes',
    'acceptedNodes',
    'byStatus',
    'nodeStatuses',
    'workflow',
    'assigneeCounts',
    'humanReady',
    'resources',
  ]);
  const received = target(value.target);
  if (!same(received, expected)) invalid();
  if (value.facts === 'unknown') {
    if (
      value.delivery !== 'unknown' ||
      value.acceptedNodes !== null ||
      value.byStatus !== null ||
      value.assigneeCounts !== null ||
      value.resources !== null ||
      (Object.hasOwn(value, 'humanReady') && value.humanReady !== null) ||
      (detailPair(value) && (value.nodeStatuses !== null || value.workflow !== null))
    )
      invalid();
    return {
      target: received,
      facts: 'unknown',
      delivery: 'unknown',
      reason: oneOf(value.reason, [
        'empty-plan',
        'unsupported-child-workflow',
        'invalid-plan',
        'node-limit',
        'incomplete-plan',
        'invalid-node',
        'invalid-state',
        'invalid-accepted',
      ]),
      expectedNodes: value.expectedNodes === null ? null : count(value.expectedNodes),
      acceptedNodes: null,
      byStatus: null,
      nodeStatuses: null,
      workflow: null,
      assigneeCounts: null,
      humanReady: null,
      resources: null,
    };
  }
  const facts = oneOf(value.facts, ['not-started', 'present']);
  const expectedNodes = count(value.expectedNodes, 80);
  if (!expectedNodes) invalid();
  const acceptedNodes = count(value.acceptedNodes, expectedNodes);
  const statuses = object(value.byStatus, NODE_STATUSES);
  const byStatus = Object.fromEntries(
    NODE_STATUSES.map((status) => [status, count(statuses[status], expectedNodes)]),
  ) as Record<NodeStatus, number>;
  const assignments = object(value.assigneeCounts, ['human', 'expert']);
  const assigneeCounts = {
    human: count(assignments.human, expectedNodes),
    expert: count(assignments.expert, expectedNodes),
  };
  const held = object(value.resources, ['authorHeld', 'reviewHeld', 'stopRequested']);
  const resources = {
    authorHeld: count(held.authorHeld),
    reviewHeld: count(held.reviewHeld),
    stopRequested: count(held.stopRequested),
  };
  if (
    assigneeCounts.human + assigneeCounts.expert !== expectedNodes ||
    acceptedNodes > byStatus.completed
  )
    invalid();
  const common = {
    target: received,
    expectedNodes,
    acceptedNodes,
    byStatus,
    assigneeCounts,
    resources,
  };
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const detailed = detailPair(value);
  if (facts === 'not-started') {
    if (
      value.delivery !== 'pending' ||
      value.reason !== undefined ||
      total ||
      acceptedNodes ||
      Object.values(resources).some(Boolean) ||
      (detailed &&
        (value.workflow !== null ||
          !Array.isArray(value.nodeStatuses) ||
          value.nodeStatuses.length > 0))
    )
      invalid();
    const nodeStatuses = detailed ? [] : null;
    return {
      ...common,
      nodeStatuses,
      workflow: null,
      humanReady: readHumanReady(value, byStatus, assigneeCounts.human, nodeStatuses),
      facts,
      delivery: 'pending',
    };
  }
  if (
    total !== expectedNodes ||
    (value.reason !== undefined && value.reason !== 'upstream-affected')
  )
    invalid();
  const nodeStatuses = detailed
    ? readNodeStatuses(value.nodeStatuses, expectedNodes, byStatus, resources.authorHeld)
    : null;
  const workflow = detailed
    ? oneOf(value.workflow, [
        'inactive',
        'running',
        'stopping',
        'paused',
        'completed',
        'requires-resume',
      ])
    : null;
  const delivery = oneOf(value.delivery, [
    'pending',
    'all-accepted',
    'cancelled',
    'mixed-terminal',
  ]);
  if (
    (delivery === 'all-accepted' && acceptedNodes !== expectedNodes) ||
    (delivery === 'cancelled' && byStatus.cancelled !== expectedNodes)
  )
    invalid();
  if (value.reason === 'upstream-affected' && delivery !== 'pending') invalid();
  return {
    ...common,
    nodeStatuses,
    workflow,
    humanReady: readHumanReady(value, byStatus, assigneeCounts.human, nodeStatuses),
    facts,
    delivery,
    ...(value.reason === 'upstream-affected' ? { reason: value.reason } : {}),
  };
}
function readHumanReady(
  value: Record<string, unknown>,
  byStatus: Readonly<Record<NodeStatus, number>>,
  humans: number,
  nodeStatuses:
    | readonly {
        readonly status: NodeStatus;
        readonly assignee: 'human' | 'expert';
      }[]
    | null,
): number {
  if (!Object.hasOwn(value, 'humanReady')) {
    return (
      nodeStatuses?.filter((node) => node.status === 'ready' && node.assignee === 'human').length ??
      0
    );
  }
  return count(value.humanReady, Math.min(byStatus.ready, humans));
}
function readNodeStatuses(
  raw: unknown,
  expectedNodes: number,
  byStatus: Readonly<Record<NodeStatus, number>>,
  authorHeld: number,
): TaskProgressNodeState[] {
  if (!Array.isArray(raw) || raw.length !== expectedNodes) invalid();
  const seen = new Set<string>();
  const tallies = Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])) as Record<
    NodeStatus,
    number
  >;
  let held = 0;
  const items = raw.map((item) => {
    const value = object(item, ['nodeId', 'status', 'authorHeld', 'assignee']);
    const nodeId = id(value.nodeId);
    if (seen.has(nodeId)) invalid();
    seen.add(nodeId);
    const status = oneOf(value.status, NODE_STATUSES);
    const assignee = oneOf(value.assignee, ['human', 'expert']);
    const runs = count(value.authorHeld, 512);
    tallies[status]++;
    held += runs;
    return { nodeId, status, authorHeld: runs, assignee };
  });
  if (held !== authorHeld) invalid();
  for (const status of NODE_STATUSES) if (tallies[status] !== byStatus[status]) invalid();
  return items;
}
/** Pure member wire codec. Neither a latest-plan resolver nor an authorization cache. */
export function createTaskProgressApi(
  call: (
    query: TaskProgressQuery & { readonly detail?: 'nodes' },
    signal: AbortSignal,
  ) => Promise<unknown>,
  spaceId: string,
): TaskProgressApi {
  return {
    async read(raw, signal) {
      signal.throwIfAborted();
      const query = object(raw, ['spaceId', 'plans']);
      if (
        query.spaceId !== spaceId ||
        !Array.isArray(query.plans) ||
        query.plans.length < 1 ||
        query.plans.length > 5
      )
        invalid();
      const plans = query.plans.map(target);
      if (new Set(plans.map((plan) => plan.taskId)).size !== plans.length) invalid();
      const clean = { spaceId: id(spaceId), plans };
      const detailed = { ...clean, detail: 'nodes' as const };
      if (new TextEncoder().encode(JSON.stringify(detailed)).byteLength > 8192) invalid();
      let response: unknown;
      try {
        response = await call(detailed, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ExecutionError) || error.code !== 'unknown-field') throw error;
        response = await call(clean, signal);
      }
      signal.throwIfAborted();
      const value = object(response, ['actorId', 'spaceId', 'coverage', 'items']);
      if (
        value.spaceId !== spaceId ||
        value.coverage !== 'current-confirmed-plans' ||
        !Array.isArray(value.items) ||
        value.items.length !== plans.length
      )
        invalid();
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) invalid();
      return {
        actorId: id(value.actorId),
        spaceId,
        coverage: 'current-confirmed-plans',
        items: value.items.map((item, index) => row(item, plans[index]!)),
      };
    },
  };
}
