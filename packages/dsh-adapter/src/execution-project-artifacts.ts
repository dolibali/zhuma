import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WorkbenchError,
  canonicalPayload,
  type AppliedPlan,
  type ArtifactVersion,
  type ExecutionNodeRecord,
  type Workbench,
  type WorkTask,
} from '@zhuma/agent-core';
import {
  PROJECT_ARTIFACT_LIMITS as limits,
  type ProjectArtifactContent,
  type ProjectArtifactCursor,
  type ProjectArtifactRef,
  type ProjectArtifactsQuery,
  type ProjectArtifactsValue,
  type ProjectArtifactSummary,
} from './execution-project-artifacts-contract.js';

const refuse = (code: 'not-found' | 'conflict' | 'quota-exceeded'): never => {
  throw new WorkbenchError(code, '项目成果暂不可用。');
};
const participates = (task: WorkTask, actorId: string) =>
  task.ownerId === actorId || task.participantIds.includes(actorId);
const contentSchema = z.strictObject({
  text: z.string().max(limits.textCharacters).optional(),
  links: z.array(z.string().min(1).max(2048)).max(20),
  files: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(1000),
        mediaType: z.string().min(1).max(200),
        byteSize: z
          .number()
          .int()
          .nonnegative()
          .max(20 * 1024 * 1024),
        checksum: z.string().min(1).max(200),
        accessPolicyId: z.string().min(1).max(200),
        uploadComplete: z.boolean(),
      }),
    )
    .max(20),
});
interface SelectedTask {
  readonly task: WorkTask;
  readonly plan: AppliedPlan;
}
function latestPlans(state: Workbench, visible: ReadonlySet<string>) {
  const latest = new Map<string, AppliedPlan>();
  for (const plan of state.appliedPlans) {
    if (!visible.has(plan.taskId)) continue;
    const prior = latest.get(plan.taskId);
    if (prior?.revision === plan.revision) return refuse('conflict');
    if (!prior || prior.revision < plan.revision) latest.set(plan.taskId, plan);
  }
  return latest;
}
export interface ProjectArtifactSelection {
  readonly spaceId: string;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly tasks: readonly SelectedTask[];
}
/** Original Workbench facts only. Project authority is checked by the Service;
 * every task is independently filtered before plan/node metadata is visited. */
export function selectProjectArtifacts(
  state: Workbench,
  actorId: string,
  spaceId: string,
  projectId: string,
): ProjectArtifactSelection {
  if (!state.projects.some((project) => project.id === projectId)) return refuse('not-found');
  const tasks = state.tasks
    .filter((task) => task.projectId === projectId && participates(task, actorId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const visible = new Set(tasks.map((task) => task.id));
  const latest = latestPlans(state, visible);
  const selected = tasks.flatMap((task) => {
    const plan = latest.get(task.id);
    // Do not fall back to an older plan after a new confirmation or project move.
    return plan &&
      plan.task.id === task.id &&
      plan.task.projectId === projectId &&
      plan.task.status === 'ready'
      ? [{ task, plan }]
      : [];
  });
  return {
    spaceId,
    projectId,
    tasks: selected,
    fingerprint: createHash('sha256')
      .update(
        canonicalPayload({
          actorId,
          spaceId,
          projectId,
          revision: state.revision,
          plans: selected.map(({ task, plan }) => [task.id, plan.id, plan.revision]),
        }),
      )
      .digest('hex'),
  };
}
const nodes = (selected: SelectedTask) =>
  selected.plan.task.workflows.flatMap((workflow) => workflow.nodes);

/** No status label, hash, parent visibility or list result substitutes for this
 * exact current accepted pointer and latest confirmed plan. */
function selectedProjectArtifact(selection: ProjectArtifactSelection, ref: ProjectArtifactRef) {
  const selected = selection.tasks.find(({ task }) => task.id === ref.taskId);
  if (
    ref.spaceId !== selection.spaceId ||
    ref.projectId !== selection.projectId ||
    !selected ||
    selected.plan.id !== ref.planId ||
    selected.plan.revision !== ref.revision ||
    !selected.plan.task.workflows.some((workflow) =>
      workflow.nodes.some((item) => item.id === ref.nodeId),
    )
  )
    return refuse('not-found');
  return selected;
}
export function acceptedProjectArtifact(
  selection: ProjectArtifactSelection,
  ref: ProjectArtifactRef,
  node: ExecutionNodeRecord,
): ArtifactVersion {
  selectedProjectArtifact(selection, ref);
  if (
    node.taskId !== ref.taskId ||
    node.planId !== ref.planId ||
    node.revision !== ref.revision ||
    node.nodeId !== ref.nodeId ||
    node.acceptedArtifactVersionId !== ref.artifactVersionId
  )
    return refuse('not-found');
  if (!Array.isArray(node.artifactVersions)) return refuse('not-found');
  // Current accepted versions are normally at the tail; do not clone history.
  for (let index = node.artifactVersions.length - 1; index >= 0; index--) {
    const artifact = node.artifactVersions[index]!;
    if (artifact.id !== ref.artifactVersionId) continue;
    if (
      artifact.nodeId !== ref.nodeId ||
      !Number.isSafeInteger(artifact.version) ||
      artifact.version < 1 ||
      typeof artifact.submittedBy !== 'string' ||
      artifact.submittedBy.length > 200 ||
      !Array.isArray(artifact.files) ||
      !Array.isArray(artifact.links) ||
      artifact.files.length > 20 ||
      artifact.links.length > 20 ||
      (artifact.text !== undefined &&
        (typeof artifact.text !== 'string' || artifact.text.length > limits.textCharacters))
    )
      return refuse('not-found');
    return artifact;
  }
  return refuse('not-found');
}

/** A file's per-chunk check visits only its current task/latest plan; it does
 * not rebuild, sort or hash a whole project's list for every stream pull. */
export function acceptedProjectFileArtifact(
  state: Workbench,
  actorId: string,
  ref: ProjectArtifactRef,
  node: ExecutionNodeRecord,
): ArtifactVersion {
  const task = state.tasks.find((item) => item.id === ref.taskId);
  if (
    !state.projects.some((project) => project.id === ref.projectId) ||
    !task ||
    task.projectId !== ref.projectId ||
    !participates(task, actorId)
  )
    return refuse('not-found');
  const plan = latestPlans(state, new Set([task.id])).get(task.id);
  if (
    !plan ||
    plan.task.id !== task.id ||
    plan.task.projectId !== ref.projectId ||
    plan.task.status !== 'ready'
  )
    return refuse('not-found');
  return acceptedProjectArtifact(
    {
      spaceId: ref.spaceId,
      projectId: ref.projectId,
      fingerprint: '',
      tasks: [{ task, plan }],
    },
    ref,
    node,
  );
}

function* candidates(selection: ProjectArtifactSelection, cursor?: ProjectArtifactCursor) {
  if (cursor && cursor.selection !== selection.fingerprint) return refuse('conflict');
  let start = cursor
    ? selection.tasks.findIndex(
        ({ task, plan }) =>
          task.id === cursor.taskId &&
          plan.id === cursor.planId &&
          plan.revision === cursor.revision,
      )
    : 0;
  if (start < 0) return refuse('conflict');
  for (; start < selection.tasks.length; start++) {
    const selected = selection.tasks[start]!,
      items = nodes(selected),
      offset = cursor?.taskId === selected.task.id ? cursor.offset : 0;
    if (offset > items.length) return refuse('conflict');
    for (let index = offset; index < items.length; index++)
      yield {
        selected,
        node: items[index]!,
        cursor: {
          selection: selection.fingerprint,
          taskId: selected.task.id,
          planId: selected.plan.id,
          revision: selected.plan.revision,
          offset: index,
        },
      };
  }
}
function bounded<T>(value: T, bytes: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) return refuse('quota-exceeded');
  return value;
}

/** Pure bounded projection over original point reads. No report, inbox,
 * reconciliation, attachment stream, new fact store or automatic write. */
export function projectArtifactsProjection(
  selection: ProjectArtifactSelection,
  query: ProjectArtifactsQuery,
  read: (ref: {
    taskId: string;
    planId: string;
    revision: number;
    nodeId: string;
  }) => ExecutionNodeRecord | undefined,
): ProjectArtifactsValue {
  if (query.view === 'content') {
    selectedProjectArtifact(selection, query.ref); // authorize before point read
    const node = read(query.ref);
    if (!node) return refuse('not-found');
    const artifact = acceptedProjectArtifact(selection, query.ref, node);
    const content = contentSchema.safeParse({
      ...(artifact.text === undefined ? {} : { text: artifact.text }),
      links: artifact.links,
      files: artifact.files,
    });
    if (!content.success) return refuse('not-found');
    return bounded<ProjectArtifactContent>(
      {
        view: 'content',
        ref: { ...query.ref },
        version: artifact.version,
        content: {
          ...(content.data.text === undefined ? {} : { text: content.data.text }),
          links: content.data.links,
          files: content.data.files,
        },
      },
      limits.contentBytes,
    );
  }
  const iterator = candidates(selection, query.cursor),
    items: ProjectArtifactSummary[] = [];
  let step = iterator.next(),
    scanned = 0;
  while (!step.done && items.length < query.limit && scanned < limits.scannedNodes) {
    const { selected, node: definition } = step.value,
      ref = {
        spaceId: selection.spaceId,
        projectId: selection.projectId,
        taskId: selected.task.id,
        planId: selected.plan.id,
        revision: selected.plan.revision,
        nodeId: definition.id,
      };
    scanned++;
    const node = read(ref);
    if (node?.acceptedArtifactVersionId) {
      const fixed = { ...ref, artifactVersionId: node.acceptedArtifactVersionId };
      let artifact: ArtifactVersion | undefined;
      try {
        artifact = acceptedProjectArtifact(selection, fixed, node);
      } catch (error) {
        if (!(error instanceof WorkbenchError) || error.code !== 'not-found') throw error;
      }
      if (artifact)
        items.push({
          ref: fixed,
          version: artifact.version,
          taskTitle: selected.task.title,
          nodeTitle: definition.title,
          nodeStatus: node.command.status,
          submittedBy: artifact.submittedBy,
          hasText: !!artifact.text?.length,
          linkCount: artifact.links.length,
          fileCount: artifact.files.length,
        });
    }
    step = iterator.next();
  }
  return bounded(
    {
      view: 'list' as const,
      spaceId: selection.spaceId,
      projectId: selection.projectId,
      coverage: 'latest-confirmed-plans' as const,
      items,
      ...(step.done ? {} : { nextCursor: step.value.cursor }),
    },
    limits.listBytes,
  );
}
