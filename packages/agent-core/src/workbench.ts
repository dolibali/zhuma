import { z } from 'zod';
import { validatePlan } from './plan.js';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const title = z.string().trim().min(1).max(160);
const description = z.string().max(8000);
const ids = z.array(id).max(100);

export const ParticipantSchema = z.strictObject({
  id,
  name: title,
  kind: z.enum(['human', 'expert']),
  role: z.string().max(300),
  capabilities: z.array(z.string().trim().min(1).max(80)).max(30),
  instructions: description,
  available: z.boolean(),
});
export const AssetSchema = z.strictObject({
  id,
  name: title,
  kind: z.enum(['skill', 'mcp', 'template']),
  description,
  content: description,
  available: z.boolean(),
});
export const ProjectSchema = z.strictObject({ id, name: title, description });
export const WorkNodeSchema = z.strictObject({
  id,
  title,
  description,
  assigneeId: id.nullable(),
  reviewerIds: ids,
  reviewRequired: z.boolean(),
  dependsOn: ids,
  skillIds: ids,
  mcpIds: ids,
  input: z.string().max(2000),
  output: z.string().max(2000),
  rationale: z.string().max(2000),
  position: z.strictObject({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  }),
});
export const WorkflowSchema = z.strictObject({
  id,
  name: title,
  parentNodeId: id.nullable(),
  nodes: z.array(WorkNodeSchema).max(80),
});
export const WorkTaskSchema = z.strictObject({
  id,
  projectId: id,
  title,
  goal: description,
  participantIds: ids,
  workflows: z.array(WorkflowSchema).min(1).max(30),
  status: z.enum(['draft', 'ready']),
  updatedAt: z.string().datetime(),
});
export const AppliedPlanSchema = z.strictObject({
  id,
  taskId: id,
  revision: z.number().int().positive(),
  sourceWorkbenchRevision: z.number().int().nonnegative(),
  task: WorkTaskSchema,
  participants: z.array(ParticipantSchema),
  assets: z.array(AssetSchema),
});
export type AppliedPlan = z.infer<typeof AppliedPlanSchema>;
export const WorkbenchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  projects: z.array(ProjectSchema).max(100),
  participants: z.array(ParticipantSchema).max(100),
  assets: z.array(AssetSchema).max(100),
  tasks: z.array(WorkTaskSchema).max(300),
  appliedPlans: z.array(AppliedPlanSchema).max(1000).default([]),
  receipts: z
    .array(z.strictObject({ id, fingerprint: z.string().max(100), revision: z.number().int() }))
    .max(200),
});
export type Participant = z.infer<typeof ParticipantSchema>;
export type TeamAsset = z.infer<typeof AssetSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type WorkNode = z.infer<typeof WorkNodeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkTask = z.infer<typeof WorkTaskSchema>;
export type Workbench = z.infer<typeof WorkbenchSchema>;

export function emptyWorkbench(): Workbench {
  return {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    participants: [],
    assets: [],
    tasks: [],
    appliedPlans: [],
    receipts: [],
  };
}

export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('save-project'), project: ProjectSchema }),
  z.strictObject({ type: z.literal('save-participant'), participant: ParticipantSchema }),
  z.strictObject({ type: z.literal('save-asset'), asset: AssetSchema }),
  z.strictObject({ type: z.literal('save-task'), task: WorkTaskSchema }),
]);
export const CommandRequestSchema = z.strictObject({
  requestId: id,
  expectedRevision: z.number().int().nonnegative(),
  command: CommandSchema,
});
export type WorkbenchCommand = z.infer<typeof CommandSchema>;
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export class WorkbenchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Definitions are validated here; runtime and review decisions remain execution-owned. */
export function validateWorkTask(task: WorkTask, state: Workbench): string[] {
  const errors: string[] = [];
  if (!state.projects.some((p) => p.id === task.projectId)) errors.push('项目不存在。');
  const participantIds = new Set(task.participantIds);
  if (participantIds.size !== task.participantIds.length) errors.push('参与者不能重复。');
  for (const memberId of participantIds) {
    if (!state.participants.some((p) => p.id === memberId))
      errors.push(`参与者不存在：${memberId}`);
  }
  const allNodes = task.workflows.flatMap((w) => w.nodes);
  const byNode = new Map(allNodes.map((n) => [n.id, n]));
  if (byNode.size !== allNodes.length) errors.push('节点标识不能重复。');
  if (new Set(task.workflows.map((w) => w.id)).size !== task.workflows.length)
    errors.push('工作流标识不能重复。');
  if (task.workflows.filter((w) => w.parentNodeId === null).length !== 1)
    errors.push('任务必须有且只有一个根工作流。');
  const parents = task.workflows.flatMap((w) => (w.parentNodeId ? [w.parentNodeId] : []));
  if (new Set(parents).size !== parents.length) errors.push('一个节点只能拆分为一个子工作流。');
  if (allNodes.length > 400) errors.push('任务最多包含 400 个节点。');
  for (const workflow of task.workflows) {
    if (workflow.parentNodeId && !byNode.has(workflow.parentNodeId)) errors.push('父节点不存在。');
    const visited = new Set<string>();
    let parent: Workflow | undefined = workflow;
    while (parent) {
      if (visited.has(parent.id)) {
        errors.push('工作树不能包含循环。');
        break;
      }
      visited.add(parent.id);
      const parentNode: string | null = parent.parentNodeId;
      parent = parentNode
        ? task.workflows.find((w) => w.nodes.some((n) => n.id === parentNode))
        : undefined;
    }
    const graphIssues = validatePlan({
      id: workflow.id,
      revision: 1,
      steps: workflow.nodes.map((n) => ({
        id: n.id,
        label: n.title,
        kind: 'agent',
        dependsOn: n.dependsOn,
      })),
    });
    if (graphIssues.some((i) => i.code !== 'empty-plan'))
      errors.push(`「${workflow.name}」存在重复节点、无效依赖或循环连线。`);
    if (task.status === 'ready' && !workflow.nodes.length)
      errors.push(`「${workflow.name}」还没有工作节点。`);
    for (const node of workflow.nodes) {
      if (task.status === 'ready' && node.reviewRequired && !node.reviewerIds.length)
        errors.push(`「${node.title}」请选择评审人。`);
      if (!node.reviewRequired && node.reviewerIds.length)
        errors.push(`「${node.title}」未启用评审。`);
      if (new Set(node.reviewerIds).size !== node.reviewerIds.length)
        errors.push('评审人不能重复。');
      if (node.reviewerIds.includes(node.assigneeId ?? ''))
        errors.push(`「${node.title}」执行者不能同时评审自己。`);
      for (const memberId of [...(node.assigneeId ? [node.assigneeId] : []), ...node.reviewerIds]) {
        if (!participantIds.has(memberId)) errors.push(`「${node.title}」引用了未参与任务的成员。`);
        if (
          task.status === 'ready' &&
          !state.participants.find((p) => p.id === memberId)?.available
        )
          errors.push(`「${node.title}」的成员目前不可用。`);
      }
      if (task.status === 'ready' && (!node.assigneeId || !node.output.trim()))
        errors.push(`「${node.title}」需要执行者和交付说明。`);
      for (const [references, kind] of [
        [node.skillIds, 'skill'],
        [node.mcpIds, 'mcp'],
      ] as const) {
        if (new Set(references).size !== references.length) errors.push('资产引用不能重复。');
        for (const assetId of references) {
          const asset = state.assets.find((a) => a.id === assetId && a.kind === kind);
          if (!asset || (task.status === 'ready' && !asset.available))
            errors.push(`「${node.title}」引用的 ${kind} 不存在或不可用。`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

/** Pure command application. Caller serializes writes and commits revision + receipt atomically. */
export function applyWorkbenchCommand(state: Workbench, command: WorkbenchCommand): Workbench {
  const next = structuredClone(state);
  const upsert = <T extends { id: string }>(items: T[], item: T): T[] => [
    ...items.filter((i) => i.id !== item.id),
    structuredClone(item),
  ];
  switch (command.type) {
    case 'save-project':
      next.projects = upsert(next.projects, command.project);
      break;
    case 'save-participant':
      next.participants = upsert(next.participants, command.participant);
      break;
    case 'save-asset':
      next.assets = upsert(next.assets, command.asset);
      break;
    case 'save-task': {
      const errors = validateWorkTask(command.task, next);
      if (errors.length) throw new WorkbenchError('validation', errors.join('\n'));
      const prior = state.tasks.find((t) => t.id === command.task.id);
      if (prior?.status === 'ready' && command.task.status === 'ready')
        throw new WorkbenchError('confirmed-plan', '请先创建编辑草稿，再确认新的计划版本。');
      if (command.task.status === 'ready') {
        const revision =
          Math.max(
            0,
            ...state.appliedPlans
              .filter((p) => p.taskId === command.task.id)
              .map((p) => p.revision),
          ) + 1;
        const snapshot = definitionSnapshot(command.task, state);
        next.appliedPlans.push({
          ...snapshot,
          id: `${command.task.id}-v${revision}`,
          taskId: command.task.id,
          revision,
          sourceWorkbenchRevision: state.revision,
        });
      }
      next.tasks = upsert(next.tasks, command.task);
      break;
    }
  }
  next.revision += 1;
  return WorkbenchSchema.parse(next);
}

function definitionSnapshot(task: WorkTask, state: Workbench) {
  return structuredClone({
    task,
    participants: state.participants.filter((p) => task.participantIds.includes(p.id)),
    assets: state.assets.filter((a) =>
      task.workflows.some((w) => w.nodes.some((n) => [...n.skillIds, ...n.mcpIds].includes(a.id))),
    ),
  });
}

/** B consumes a persisted, immutable plan version; subsequent drafts and catalog changes cannot rewrite it. */
export function createExecutionHandoff(task: WorkTask, state: Workbench): AppliedPlan {
  if (task.status !== 'ready') throw new WorkbenchError('not-ready', '请先确认工作流。');
  const applied = state.appliedPlans.filter((p) => p.taskId === task.id).at(-1);
  if (!applied) throw new WorkbenchError('not-ready', '请重新确认工作流，生成交接版本。');
  return structuredClone(applied);
}
