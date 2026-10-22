import type { NodeStatus } from './node-status.js';

/**
 * `human` is a person. `agent` is B's runtime marker for a run.
 * `expert` is A's directory expert config, not a run instance.
 * Identifiers are A's directory ids. B does not keep an identity directory.
 */
export type ParticipantKind = 'human' | 'agent' | 'expert';

/** Agent runs and expert configs both leave delivery to the task owner. */
export function assigneeUsesAgentRuntime(kind: ParticipantKind): boolean {
  return kind === 'agent' || kind === 'expert';
}

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

/** Versioned resource pointer. Credentials stay outside this object. */
export interface VersionedRef {
  readonly id: string;
  readonly version: string;
}

/**
 * What A hands to B at a node boundary.
 * `revision` is the applied plan revision this handoff was cut from.
 * It is not the node command version and not A's draft concurrency version.
 * Resource refs are separate from `inputRefs` and carry no credentials.
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
  readonly expertRef: VersionedRef;
  readonly skillRefs: readonly VersionedRef[];
  readonly mcpRefs: readonly VersionedRef[];
  readonly inputNote: string;
  readonly expectedOutput: string;
  readonly childTaskId?: string;
}

type CredentialField =
  'credential' | 'credentials' | 'secret' | 'token' | 'apiKey' | 'password' | 'authorization';

type ExcludesCredentialFields<T> = Extract<keyof T, CredentialField> extends never ? true : never;

/**
 * Compile-time lock: handoff payloads cannot grow credential fields.
 * Empty strings and empty ref arrays are valid; secrets are not part of the shape.
 */
export const handoffPayloadExcludesCredentials: ExcludesCredentialFields<NodeHandoff> &
  ExcludesCredentialFields<VersionedRef> &
  ExcludesCredentialFields<ContextInputRef> = true;

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
