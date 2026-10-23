import type { NodeStatus } from './node-status.js';

/**
 * External directory identity only.
 * `human` is a person. `expert` is A's directory expert config, not a run.
 * Agent execution is not an identity. Runs live on Run; the adapter maps them.
 */
export type ParticipantKind = 'human' | 'expert';

/** Internal classification. `agent` is not an ActorRef kind. */
export type RuntimeAssigneeKind = ParticipantKind | 'agent';

/** Agent runs and expert configs both leave delivery to the task owner. */
export function assigneeUsesAgentRuntime(kind: RuntimeAssigneeKind): boolean {
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
 * `parentNodeId` / `rootTaskId` name the same tree as `NodeHandoff.childTaskId`.
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
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
  readonly contextPackId?: string;
}

/**
 * Versioned resource pointer. Credentials stay outside this object.
 * `version` is an AppliedPlan.id: a frozen plan snapshot, not a skill version
 * and not a separate asset-version number. A later asset-version store is a migration.
 */
export interface VersionedRef {
  readonly id: string;
  readonly version: string;
}

interface NodeHandoffFields {
  readonly nodeId: string;
  readonly taskId: string;
  readonly workflowVersionId: string;
  readonly revision: number;
  readonly goal: string;
  readonly dependencyNodeIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly reviewerIds: readonly string[];
  readonly inputRefs: readonly ContextInputRef[];
  readonly skillRefs: readonly VersionedRef[];
  readonly mcpRefs: readonly VersionedRef[];
  readonly inputNote: string;
  readonly expectedOutput: string;
  readonly childTaskId?: string;
}

/**
 * What A hands to B at a node boundary.
 * A human assignee may omit `expertRef`. An expert assignee must carry one.
 * `revision` is the applied plan revision this handoff was cut from.
 * It is not the node command version and not A's draft concurrency version.
 * Resource refs are separate from `inputRefs` and carry no credentials.
 * 待 A 对齐：这些字段的编辑、授权和计划差异不在本契约中实现。
 */
export type NodeHandoff =
  | (NodeHandoffFields & {
      readonly assignee: { readonly id: string; readonly kind: 'human' };
      readonly expertRef?: VersionedRef;
    })
  | (NodeHandoffFields & {
      readonly assignee: { readonly id: string; readonly kind: 'expert' };
      readonly expertRef: VersionedRef;
    });

type CredentialName =
  | 'credential'
  | 'credentials'
  | 'secret'
  | 'secretkey'
  | 'token'
  | 'apikey'
  | 'password'
  | 'passwd'
  | 'authorization'
  | 'auth'
  | 'accesstoken'
  | 'refreshtoken'
  | 'privatekey'
  | 'sessiontoken'
  | 'sessionid'
  | 'clientsecret'
  | 'idtoken'
  | 'bearer'
  | 'bearertoken'
  | 'cookie';

type StripSeparators<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? StripSeparators<`${Head}${Tail}`>
  : S extends `${infer Head}-${infer Tail}`
    ? StripSeparators<`${Head}${Tail}`>
    : S;

type IsCredential<K extends string> =
  StripSeparators<Lowercase<K>> extends CredentialName ? true : false;

type ForbiddenCredential<T> = T extends readonly (infer Item)[]
  ? ForbiddenCredential<Item>
  : T extends object
    ? string extends keyof T
      ? 'index-signature'
      : {
          [K in keyof T]-?: K extends string
            ? IsCredential<K> extends true
              ? K
              : ForbiddenCredential<NonNullable<T[K]>> extends never
                ? never
                : ForbiddenCredential<NonNullable<T[K]>>
            : never;
        }[keyof T]
    : never;

/** `true` when T has no credential-shaped field at any depth. */
export type PayloadExcludesCredentials<T> = [ForbiddenCredential<T>] extends [never] ? true : never;

/**
 * Compile-time lock: handoff payloads cannot grow credential fields.
 * The check is recursive, ignores case, and ignores `_` and `-` in field names.
 * It also rejects string index signatures.
 * Empty strings and empty ref arrays are valid; secrets are not part of the shape.
 */
export const handoffPayloadExcludesCredentials: PayloadExcludesCredentials<NodeHandoff> &
  PayloadExcludesCredentials<VersionedRef> &
  PayloadExcludesCredentials<ContextInputRef> &
  PayloadExcludesCredentials<ActorRef> = true;

export type NodeHandoffRead =
  | { readonly ok: true; readonly handoff: NodeHandoff }
  | {
      readonly ok: false;
      readonly code: 'agent-not-identity' | 'expert-ref-required' | 'invalid-handoff';
    };

export interface NodeHandoffInput extends NodeHandoffFields {
  readonly assignee: { readonly id: string; readonly kind: string };
  readonly expertRef?: VersionedRef;
  readonly engine?: string;
}

function usableRef(ref: unknown): 'missing' | 'blank' | 'invalid' | VersionedRef {
  if (ref === undefined) return 'missing';
  if (ref === null || typeof ref !== 'object') return 'invalid';
  const candidate = ref as { id?: unknown; version?: unknown };
  if (typeof candidate.id !== 'string' || typeof candidate.version !== 'string') return 'invalid';
  if (candidate.id.trim() === '' || candidate.version.trim() === '') return 'blank';
  return { id: candidate.id, version: candidate.version };
}

function copyInputRefs(refs: unknown): readonly ContextInputRef[] | undefined {
  if (!Array.isArray(refs)) return undefined;
  const copied: ContextInputRef[] = [];
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return undefined;
    const candidate = ref as {
      sourceNodeId?: unknown;
      artifactVersionId?: unknown;
      contextPackId?: unknown;
    };
    if (typeof candidate.sourceNodeId !== 'string' || candidate.sourceNodeId.trim() === '') {
      return undefined;
    }
    if (
      typeof candidate.artifactVersionId !== 'string' ||
      candidate.artifactVersionId.trim() === ''
    ) {
      return undefined;
    }
    const next: {
      sourceNodeId: string;
      artifactVersionId: string;
      contextPackId?: string;
    } = {
      sourceNodeId: candidate.sourceNodeId,
      artifactVersionId: candidate.artifactVersionId,
    };
    if (candidate.contextPackId !== undefined) {
      if (typeof candidate.contextPackId !== 'string' || candidate.contextPackId.trim() === '') {
        return undefined;
      }
      next.contextPackId = candidate.contextPackId;
    }
    copied.push(next);
  }
  return copied;
}

function copyRefs(refs: unknown): readonly VersionedRef[] | undefined {
  if (!Array.isArray(refs)) return undefined;
  const copied: VersionedRef[] = [];
  for (const ref of refs) {
    const usable = usableRef(ref);
    if (usable === 'missing' || usable === 'blank' || usable === 'invalid') return undefined;
    copied.push(usable);
  }
  return copied;
}

/**
 * Accept a human handoff without an expert or an engine.
 * An expert handoff must name a versioned expert. `agent` is not an identity.
 */
export function readNodeHandoff(input: NodeHandoffInput): NodeHandoffRead {
  if (
    input == null ||
    typeof input !== 'object' ||
    input.assignee == null ||
    typeof input.assignee !== 'object'
  ) {
    return { ok: false, code: 'invalid-handoff' };
  }
  const kind = input.assignee.kind;
  if (kind === 'agent') return { ok: false, code: 'agent-not-identity' };
  if (kind !== 'human' && kind !== 'expert') return { ok: false, code: 'invalid-handoff' };
  const ref = usableRef(input.expertRef);
  const inputRefs = copyInputRefs(input.inputRefs);
  const skillRefs = copyRefs(input.skillRefs);
  const mcpRefs = copyRefs(input.mcpRefs);
  if (inputRefs === undefined || skillRefs === undefined || mcpRefs === undefined) {
    return { ok: false, code: 'invalid-handoff' };
  }
  if (ref === 'invalid' || (kind === 'human' && ref === 'blank')) {
    return { ok: false, code: 'invalid-handoff' };
  }
  if (kind === 'expert' && (ref === 'missing' || ref === 'blank')) {
    return { ok: false, code: 'expert-ref-required' };
  }
  const fields: NodeHandoffFields = {
    nodeId: input.nodeId,
    taskId: input.taskId,
    workflowVersionId: input.workflowVersionId,
    revision: input.revision,
    goal: input.goal,
    dependencyNodeIds: input.dependencyNodeIds,
    reviewRequired: input.reviewRequired,
    reviewerIds: input.reviewerIds,
    inputRefs,
    skillRefs,
    mcpRefs,
    inputNote: input.inputNote,
    expectedOutput: input.expectedOutput,
    ...(input.childTaskId === undefined ? {} : { childTaskId: input.childTaskId }),
  };
  if (kind === 'human' && ref === 'missing') {
    return { ok: true, handoff: { ...fields, assignee: { id: input.assignee.id, kind: 'human' } } };
  }
  if (typeof ref !== 'object') return { ok: false, code: 'invalid-handoff' };
  if (kind === 'human') {
    return {
      ok: true,
      handoff: { ...fields, assignee: { id: input.assignee.id, kind: 'human' }, expertRef: ref },
    };
  }
  return {
    ok: true,
    handoff: { ...fields, assignee: { id: input.assignee.id, kind: 'expert' }, expertRef: ref },
  };
}

/**
 * Read one frozen snapshot.
 * `id` on the snapshot is the AppliedPlan.id (`VersionedRef.version`).
 * `assetId` is the asset (`VersionedRef.id`). Both must match.
 * The result is a deep copy, so a caller cannot edit the stored snapshot.
 * This is not an asset-version store.
 */
export function readVersionedSnapshot<T extends { readonly assetId: string; readonly id: string }>(
  ref: VersionedRef,
  snapshots: readonly T[],
): T | undefined {
  if (ref == null || typeof ref !== 'object' || !Array.isArray(snapshots)) return undefined;
  const found = snapshots.find(
    (snapshot) => snapshot.assetId === ref.id && snapshot.id === ref.version,
  );
  if (found === undefined) return undefined;
  try {
    return structuredClone(found);
  } catch {
    return undefined;
  }
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
