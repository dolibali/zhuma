import type { NodeStatus } from './node-status.js';

export type ParticipantKind = 'human' | 'agent';

export interface ActorRef {
  readonly id: string;
  readonly kind: ParticipantKind;
}

/**
 * Minimal project fact B can read.
 * 待 A 对齐：归档影响、成员目录和资源引用的完整形状由 A 维护。
 */
export interface ProjectDependency {
  readonly id: string;
  readonly status: 'active' | 'archived';
}

/**
 * Minimal task fact B can read.
 * 待 A 对齐：目标正文、参与者明细和任务汇总状态由 A 维护。
 */
export interface TaskDependency {
  readonly id: string;
  readonly projectId: string;
  readonly rootTaskId: string;
  readonly ownerId: string;
  readonly participantIds: readonly string[];
  readonly parentNodeId?: string;
}

/**
 * Frozen or draft plan pointer.
 * 待 A 对齐：节点、边、布局和成环校验的完整对象由 A 维护。
 */
export interface WorkflowVersionDependency {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly state: 'draft' | 'applied';
}

export interface ContextInputRef {
  readonly sourceNodeId?: string;
  readonly artifactVersionId?: string;
  readonly contextPackId?: string;
}

/**
 * What A hands to B at a node boundary: goal, assignee, dependencies, reviewers, inputs.
 * 待 A 对齐：这些字段的编辑、授权和计划差异不在本契约中实现。
 */
export interface NodeHandoff {
  readonly nodeId: string;
  readonly taskId: string;
  readonly workflowVersionId: string;
  readonly revision: number;
  readonly goal: string;
  readonly assignee: ActorRef;
  readonly dependencyNodeIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly reviewerIds: readonly string[];
  readonly inputRefs: readonly ContextInputRef[];
  readonly childTaskId?: string;
}

/**
 * What B returns to A. A renders this; B does not compute task rollup status.
 * 待 A 对齐：任务汇总如何折叠多个 NodeExecutionReport。
 */
export interface NodeExecutionReport {
  readonly nodeId: string;
  readonly taskId: string;
  readonly workflowVersionId: string;
  readonly revision: number;
  readonly status: NodeStatus;
  readonly upstreamAffected: boolean;
  readonly blockReason?: string;
  readonly acceptedArtifactVersionId?: string;
  readonly activeRunId?: string;
  readonly reviewOutcome?: 'pending' | 'approved' | 'changes-requested';
}
