import type { NodeHandoff } from './handoff.js';
import {
  AppliedPlanSchema,
  WorkbenchError,
  emptyWorkbench,
  validateWorkTask,
  type AppliedPlan,
} from './workbench.js';

/**
 * Translate a persisted definition into B's node contracts, never execution facts.
 * The caller must authorize and load the applied plan; this pure mapping grants no access.
 * Nested drafts cannot be flattened into runnable nodes before child-task conversion exists.
 */
export function createNodeHandoffs(applied: AppliedPlan): NodeHandoff[] {
  const snapshot = AppliedPlanSchema.parse(applied);
  const { task, participants, assets } = snapshot;
  if (task.id !== snapshot.taskId || task.status !== 'ready')
    throw new WorkbenchError('invalid-handoff', '交接必须来自该任务的已确认计划。');
  if (task.workflows.length !== 1 || task.workflows[0]?.parentNodeId !== null)
    throw new WorkbenchError('child-task-required', '嵌套工作流需要先转换为子任务，不能直接派发。');
  if (
    new Set(participants.map((p) => p.id)).size !== participants.length ||
    new Set(assets.map((a) => a.id)).size !== assets.length
  )
    throw new WorkbenchError('invalid-handoff', '计划快照包含重复的人员或资产。');

  // Project identity is already fixed in the snapshot; existence/access is a Host check.
  const errors = validateWorkTask(task, {
    ...emptyWorkbench(),
    projects: [{ id: task.projectId, name: task.projectId, description: '' }],
    participants,
    assets,
  });
  if (errors.length) throw new WorkbenchError('invalid-handoff', errors.join('\n'));

  return task.workflows[0].nodes.map((node): NodeHandoff => {
    const assignee = participants.find((p) => p.id === node.assigneeId)!;
    const fields = {
      nodeId: node.id,
      taskId: task.id,
      workflowVersionId: snapshot.id,
      revision: snapshot.revision,
      goal: node.description ? `${node.title}\n\n${node.description}` : node.title,
      dependencyNodeIds: [...node.dependsOn],
      reviewRequired: node.reviewRequired,
      reviewerIds: [...node.reviewerIds],
      inputNote: node.input,
      expectedOutput: node.output,
      // Artifact/context refs must be resolved by B/context with versions and permissions.
      inputRefs: [],
      skillRefs: node.skillIds.map((id) => ({ id, version: snapshot.id })),
      mcpRefs: node.mcpIds.map((id) => ({ id, version: snapshot.id })),
    };
    return assignee.kind === 'expert'
      ? {
          ...fields,
          assignee: { id: assignee.id, kind: 'expert' },
          expertRef: { id: assignee.id, version: snapshot.id },
        }
      : { ...fields, assignee: { id: assignee.id, kind: 'human' } };
  });
}
