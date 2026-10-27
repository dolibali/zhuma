import {
  NODE_STATUSES,
  WorkbenchError,
  canonicalPayload,
  createNodeHandoffs,
  readNodeHandoff,
  toNodeExecutionReport,
  type AppliedPlan,
  type ExecutionNodeRecord,
  type NodeHandoff,
  type NodeStatus,
  type Workbench,
  type WorkTask,
} from '@zhuma/agent-core';
import { executionPlanReceiptSchema } from './execution-workflow-contract.js';
import { assertExecutionRunStoreCompatibility } from './execution-run-protocol.js';
import { readExecutionRunState } from './execution-run-state.js';
import { readExecutionReviewState } from './execution-review-state.js';
import {
  TASK_PROGRESS_LIMITS as limits,
  type TaskProgressQuery,
  type TaskProgressRow,
  type TaskProgressTarget,
  type TaskProgressUnknownReason,
  type TaskProgressValue,
} from './execution-task-progress-contract.js';

const refuse = (code: 'not-found' | 'conflict' | 'quota-exceeded'): never => {
  throw new WorkbenchError(code, '当前计划进度暂不可用。');
};
export interface TaskProgressSelection {
  readonly actorId: string;
  readonly spaceId: string;
  readonly fingerprint: string;
  readonly plans: readonly {
    readonly target: TaskProgressTarget;
    readonly projectId: string;
    readonly plan: AppliedPlan;
  }[];
}

/** The original Workbench owns confirmation. A request names a version, never
 * selects a draft, promotes an old plan, or inherits another task's permission. */
function authorizedTasks(state: Workbench, actorId: string, query: TaskProgressQuery): WorkTask[] {
  // Authorize the WHOLE batch before inspecting any requested plan or node.
  return query.plans.map((target) => {
    const task = state.tasks.find((item) => item.id === target.taskId);
    if (
      !task ||
      !state.projects.some((project) => project.id === task.projectId) ||
      (task.ownerId !== actorId && !task.participantIds.includes(actorId))
    )
      return refuse('not-found');
    return task;
  });
}
/** Project scopes must be authorized before even distinguishing a stale plan. */
export function taskProgressProjects(state: Workbench, actorId: string, query: TaskProgressQuery) {
  return [...new Set(authorizedTasks(state, actorId, query).map((task) => task.projectId))];
}
export function selectTaskProgress(
  state: Workbench,
  actorId: string,
  query: TaskProgressQuery,
): TaskProgressSelection {
  const tasks = authorizedTasks(state, actorId, query);
  const plans = query.plans.map((target, index) => {
    const task = tasks[index]!;
    const candidates = state.appliedPlans.filter((plan) => plan.taskId === task.id);
    const revision = Math.max(0, ...candidates.map((plan) => plan.revision));
    const latest = candidates.filter((plan) => plan.revision === revision);
    const plan = latest[0];
    if (
      latest.length !== 1 ||
      !plan ||
      plan.id !== target.planId ||
      plan.revision !== target.revision
    )
      return refuse('conflict');
    if (plan.task.id !== task.id || plan.task.projectId !== task.projectId)
      return refuse('conflict');
    return { target: { ...target }, projectId: task.projectId, plan };
  });
  return {
    actorId,
    spaceId: query.spaceId,
    plans,
    // Confirmation is immutable under this versioned owner. Draft/revocation
    // changes advance its revision; do not hash artifact bodies or global nodes.
    fingerprint: canonicalPayload({
      actorId,
      spaceId: query.spaceId,
      revision: state.revision,
      tasks: tasks.map((task) => [task.id, task.projectId, task.ownerId, task.participantIds]),
      plans: plans.map(({ plan }) => [plan.taskId, plan.id, plan.revision]),
    }),
  };
}

export interface TaskProgressFactsSource {
  readonly global: unknown;
  readPlan(target: TaskProgressTarget): unknown;
  readNode(target: TaskProgressTarget & { readonly nodeId: string }): unknown;
}
const zero = () =>
  Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])) as Record<NodeStatus, number>;
const unknown = (
  target: TaskProgressTarget,
  reason: TaskProgressUnknownReason,
  expectedNodes: number | null = null,
): TaskProgressRow => ({
  target: { ...target },
  facts: 'unknown',
  reason,
  delivery: 'unknown',
  expectedNodes,
  acceptedNodes: null,
  byStatus: null,
  assigneeCounts: null,
  resources: null,
});

/** Metadata comparison excludes only the original downstream materialization. */
function sameHandoff(actual: NodeHandoff, expected: NodeHandoff) {
  const { inputRefs: _actualInputs, ...left } = actual;
  const { inputRefs: _expectedInputs, ...right } = expected;
  return canonicalPayload(left) === canonicalPayload(right);
}
function nodeAt(
  raw: unknown,
  target: TaskProgressTarget,
  expected: NodeHandoff,
  ownerId: string | null,
): ExecutionNodeRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const node = raw as ExecutionNodeRecord;
  if (
    node.taskId !== target.taskId ||
    node.planId !== target.planId ||
    node.revision !== target.revision ||
    node.nodeId !== expected.nodeId ||
    node.ownerId !== ownerId ||
    !node.command ||
    !NODE_STATUSES.includes(node.command.status) ||
    !Number.isSafeInteger(node.command.version) ||
    node.command.version < 0 ||
    typeof node.command.upstreamAffected !== 'boolean' ||
    !Array.isArray(node.command.stored) ||
    !Array.isArray(node.rounds) ||
    !Array.isArray(node.artifactVersions) ||
    !Array.isArray(node.comments) ||
    !Array.isArray(node.receipts)
  )
    return;
  const handoff = readNodeHandoff(node.handoff);
  return handoff.ok && sameHandoff(handoff.handoff, expected) ? node : undefined;
}
function accepted(node: ExecutionNodeRecord) {
  const id = node.acceptedArtifactVersionId;
  if (typeof id !== 'string' || !id.trim()) return false;
  const artifacts = node.artifactVersions.filter((artifact) => artifact.id === id);
  const artifact = artifacts[0];
  if (
    artifacts.length !== 1 ||
    !artifact ||
    artifact.nodeId !== node.nodeId ||
    !Number.isSafeInteger(artifact.version) ||
    artifact.version < 1 ||
    typeof artifact.submittedBy !== 'string' ||
    !artifact.submittedBy.trim() ||
    !Array.isArray(artifact.files) ||
    !Array.isArray(artifact.links)
  )
    return false;
  if (node.handoff.reviewRequired || node.currentRoundId !== undefined) {
    const rounds = node.rounds.filter((round) => round.id === node.currentRoundId);
    const round = rounds[0];
    if (
      rounds.length !== 1 ||
      round?.status !== 'approved' ||
      round.artifactVersionId !== id ||
      toNodeExecutionReport(node).reviewOutcome !== 'approved'
    )
      return false;
  }
  return true;
}

/** No caller identity, queue, filesystem, repair, native action, or persisted rollup. */
export function taskProgressProjection(
  selection: TaskProgressSelection,
  source: TaskProgressFactsSource,
): TaskProgressValue {
  let reads = 0;
  if (selection.plans.length > limits.plans) return refuse('quota-exceeded');
  const items = selection.plans.map(({ plan, target }): TaskProgressRow => {
    try {
      assertExecutionRunStoreCompatibility(source.global, []);
    } catch {
      return unknown(target, 'invalid-state');
    }
    if (plan.task.workflows.length !== 1 || plan.task.workflows[0]?.parentNodeId !== null)
      return unknown(target, 'unsupported-child-workflow');
    const width = plan.task.workflows[0].nodes.length;
    if (width > limits.nodesPerPlan) return unknown(target, 'node-limit');
    if (width === 0) return unknown(target, 'empty-plan', 0);
    let expected: NodeHandoff[];
    try {
      expected = createNodeHandoffs(plan);
    } catch {
      return unknown(target, 'invalid-plan');
    }
    if (!expected.length) return unknown(target, 'empty-plan', 0);
    const count = expected.length;
    const receipt = source.readPlan(target);
    const raw = expected.map((handoff) => {
      if (++reads > limits.nodeReads) return refuse('quota-exceeded');
      return source.readNode({ ...target, nodeId: handoff.nodeId });
    });
    const byStatus = zero();
    const assigneeCounts = { human: 0, expert: 0 };
    for (const handoff of expected) assigneeCounts[handoff.assignee.kind]++;
    const resources = { authorHeld: 0, reviewHeld: 0, stopRequested: 0 };
    if (receipt === undefined && raw.every((node) => node === undefined))
      return {
        target: { ...target },
        facts: 'not-started',
        delivery: 'pending',
        expectedNodes: count,
        acceptedNodes: 0,
        byStatus,
        assigneeCounts,
        resources,
      };
    if (
      receipt &&
      typeof receipt === 'object' &&
      'nodeIds' in receipt &&
      Array.isArray(receipt.nodeIds) &&
      receipt.nodeIds.length > limits.nodesPerPlan
    )
      return unknown(target, 'incomplete-plan', count);
    const parsed = executionPlanReceiptSchema.safeParse(receipt);
    if (
      !parsed.success ||
      parsed.data.fingerprint !== canonicalPayload(target) ||
      parsed.data.nodeIds.length !== count ||
      new Set(parsed.data.nodeIds).size !== count ||
      !expected.every((node) => parsed.data.nodeIds.includes(node.nodeId)) ||
      raw.some((node) => node === undefined)
    )
      return unknown(target, 'incomplete-plan', count);
    let acceptedNodes = 0,
      affected = false;
    for (const [index, value] of raw.entries()) {
      if (
        value &&
        typeof value === 'object' &&
        'handoff' in value &&
        value.handoff &&
        typeof value.handoff === 'object' &&
        'childTaskId' in value.handoff &&
        value.handoff.childTaskId !== undefined
      )
        return unknown(target, 'unsupported-child-workflow', count);
      let node: ExecutionNodeRecord | undefined;
      try {
        node = nodeAt(value, target, expected[index]!, plan.task.ownerId);
      } catch {
        return unknown(target, 'invalid-node', count);
      }
      if (!node) return unknown(target, 'invalid-node', count);
      if (node.handoff.childTaskId !== undefined)
        return unknown(target, 'unsupported-child-workflow', count);
      try {
        assertExecutionRunStoreCompatibility(source.global, [node]);
        const author = readExecutionRunState(node);
        const reviews = readExecutionReviewState(node);
        for (const run of author?.runs ?? []) {
          resources.authorHeld += Number(run.resources === 'held');
          resources.stopRequested += Number(run.attempt.stopPhase === 'requested');
        }
        for (const attempt of reviews?.attempts ?? []) {
          resources.reviewHeld += Number(attempt.resources === 'held');
          resources.stopRequested += Number(
            'stopPhase' in attempt && attempt.stopPhase === 'requested',
          );
        }
        if (node.command.status === 'completed') {
          if (!accepted(node)) return unknown(target, 'invalid-accepted', count);
          if (!node.command.upstreamAffected) acceptedNodes++;
        }
      } catch {
        return unknown(target, 'invalid-state', count);
      }
      byStatus[node.command.status]++;
      affected ||= node.command.upstreamAffected;
    }
    return {
      target: { ...target },
      facts: 'present',
      delivery:
        acceptedNodes === count
          ? 'all-accepted'
          : byStatus.cancelled === count
            ? 'cancelled'
            : !affected && byStatus.completed + byStatus.cancelled + byStatus.failed === count
              ? 'mixed-terminal'
              : 'pending',
      ...(affected ? { reason: 'upstream-affected' as const } : {}),
      expectedNodes: count,
      acceptedNodes,
      byStatus,
      assigneeCounts,
      resources,
    };
  });
  const value: TaskProgressValue = {
    actorId: selection.actorId,
    spaceId: selection.spaceId,
    coverage: 'current-confirmed-plans',
    items,
  };
  if (Buffer.byteLength(JSON.stringify(value)) > limits.responseBytes)
    return refuse('quota-exceeded');
  return value;
}
