import { z } from 'zod';
import { validatePlan } from './plan.js';
import {
  MemberAssetRegistrySchema,
  MemberAssetReferenceSchema,
  MemberAssetFileReferencesSchema,
  memberAssetDefinitionId,
} from './member-asset-contract.js';
import {
  ResourceOriginSchema,
  ImportPackageInputSchema,
  previewResourcePackage,
  packageFileBytes,
  AssetImportError,
  type ImportPackageInput,
} from './asset-package.js';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const title = z.string().trim().min(1).max(160);
const description = z.string().max(8000);
const ids = z.array(id).max(100);

export const ParticipantSchema = z
  .strictObject({
    id,
    name: title,
    kind: z.enum(['human', 'expert']),
    role: z.string().max(300),
    capabilities: z.array(z.string().trim().min(1).max(80)).max(30),
    instructions: z.string().max(32000),
    available: z.boolean(),
    origin: ResourceOriginSchema.optional(),
    memberAsset: MemberAssetReferenceSchema.optional(),
    resourceBindings: z.strictObject({ skillIds: ids, mcpIds: ids }).optional(),
  })
  .refine(
    (p) =>
      p.kind === 'expert' ||
      (!p.origin && !p.memberAsset && !p.resourceBindings && p.instructions.length <= 8000),
    '真人成员不能携带专家来源／能力，说明最多 8000 字符。',
  )
  .refine(
    (p) =>
      !p.memberAsset ||
      (p.memberAsset.kind === 'expert' && p.id === memberAssetDefinitionId(p.memberAsset)),
    '已发布专家必须保留完整固定引用与对应定义标识。',
  )
  .refine(
    (p) => !p.available || !p.origin?.missing.length,
    '来源仍有缺项，需重新导入补齐后才能启用。',
  );
export const AssetSchema = z
  .strictObject({
    id,
    name: title,
    kind: z.enum(['skill', 'mcp', 'template']),
    description,
    content: z.string().max(150000),
    available: z.boolean(),
    origin: ResourceOriginSchema.optional(),
    memberAsset: MemberAssetReferenceSchema.optional(),
    memberTemplate: z
      .strictObject({
        schemaVersion: z.literal(1),
        spaceId: id,
        ownerId: id,
        sourceTaskId: id,
        sourceWorkbenchRevision: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .refine(
    (a) =>
      !a.memberAsset ||
      (a.memberAsset.kind === a.kind &&
        a.id === memberAssetDefinitionId(a.memberAsset) &&
        !a.memberTemplate),
    '已发布资产必须保留完整固定引用与对应定义标识。',
  )
  .refine((a) => !a.memberTemplate || a.kind === 'template', '成员工作流归属仅适用于工作流资产。')
  .refine((a) => a.kind === 'template' || a.content.length <= (a.kind === 'skill' ? 60000 : 8000), {
    path: ['content'],
    message: 'Skill 正文最多 60000 字符，MCP 正文最多 8000 字符。',
  })
  .refine(
    (a) => !a.available || !a.origin?.missing.length,
    '来源仍有缺项，需重新导入补齐后才能启用。',
  )
  .refine(
    (a) =>
      !a.origin ||
      (a.kind === 'skill' && a.origin.format === 'agent-skill') ||
      (a.kind === 'template' && a.origin.format === 'workflow'),
    '定义类型与来源格式不一致。',
  );
const projectLink = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '请填写不含账号密码的 http 或 https 链接。');
export const ProjectSchema = z.strictObject({
  id,
  name: title,
  description,
  // Optional fields preserve old snapshots and command fingerprints without a migration.
  defaultParticipantIds: ids.optional(),
  assetIds: ids.optional(),
  fileRefs: MemberAssetFileReferencesSchema.optional(),
  references: z
    .array(z.strictObject({ id, name: title, url: projectLink }))
    .max(30)
    .optional(),
});
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
export const WorkflowTemplateSchema = z.strictObject({
  format: z.literal('zhuma-workflow-template'),
  schemaVersion: z.literal(1),
  roles: z
    .array(
      z.strictObject({
        id,
        name: title,
        preferredKind: z.enum(['human', 'expert', 'any']),
        capabilities: z.array(z.string().trim().min(1).max(80)).max(30),
      }),
    )
    .max(100),
  resources: z
    .array(
      z.strictObject({
        id,
        name: title,
        kind: z.enum(['skill', 'mcp']),
        suggestedAssetId: id.optional(),
      }),
    )
    .max(100),
  workflows: z.array(WorkflowSchema).min(1).max(30),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export const TemplateSourceSchema = z.strictObject({
  assetId: id,
  memberAsset: MemberAssetReferenceSchema.optional(),
  sourceWorkbenchRevision: z.number().int().nonnegative(),
  definition: WorkflowTemplateSchema,
  pendingParticipants: z
    .array(z.strictObject({ id, name: title, kind: z.enum(['human', 'expert']) }))
    .max(100),
  pendingAssets: z
    .array(z.strictObject({ id, name: title, kind: z.enum(['skill', 'mcp']) }))
    .max(100),
});
export const WorkTaskSchema = z.strictObject({
  id,
  projectId: id,
  title,
  goal: description,
  participantIds: ids,
  // Legacy drafts and frozen plans remain readable; ownership is chosen explicitly before confirmation.
  ownerId: id.nullable().default(null),
  workflows: z.array(WorkflowSchema).min(1).max(30),
  status: z.enum(['draft', 'ready']),
  updatedAt: z.string().datetime(),
  templateSource: TemplateSourceSchema.optional(),
  fileRefs: MemberAssetFileReferencesSchema.optional(),
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
  // One original Workbench fact owner; absence keeps existing snapshots byte-compatible.
  memberAssets: MemberAssetRegistrySchema.optional(),
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
  z.strictObject({ type: z.literal('import-package'), input: ImportPackageInputSchema }),
  z.strictObject({
    type: z.literal('instantiate-template'),
    input: z.strictObject({
      templateId: id,
      task: WorkTaskSchema.omit({ workflows: true, status: true, templateSource: true }).extend({
        id: z.uuid(),
      }),
      roleBindings: z.record(id, id.nullable()),
      resourceBindings: z.record(id, id.nullable()),
    }),
  }),
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
function assignedExperts(task: WorkTask, state: Workbench): Participant[] {
  const assigned = new Set(
    task.workflows.flatMap((workflow) =>
      workflow.nodes.flatMap((node) => [
        ...(node.assigneeId ? [node.assigneeId] : []),
        ...node.reviewerIds,
      ]),
    ),
  );
  return state.participants.filter(
    (participant) =>
      participant.kind === 'expert' &&
      task.participantIds.includes(participant.id) &&
      assigned.has(participant.id),
  );
}

export function validateWorkTask(
  task: WorkTask,
  state: Workbench,
  { requireOwner = task.status === 'ready' }: { requireOwner?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (!state.projects.some((p) => p.id === task.projectId)) errors.push('项目不存在。');
  const participantIds = new Set(task.participantIds);
  if (!task.ownerId) {
    if (requireOwner) errors.push('请选择一位参与任务的团队成员作为负责人。');
  } else {
    const owner = state.participants.find((p) => p.id === task.ownerId);
    if (!participantIds.has(task.ownerId) || owner?.kind !== 'human')
      errors.push('任务负责人必须是参与任务的真人成员。');
    else if (task.status === 'ready' && !owner.available)
      errors.push('任务负责人当前不可用，请重新选择。');
  }
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
        const pending = task.templateSource?.pendingParticipants.find((p) => p.id === memberId);
        if (pending) {
          if (task.status === 'ready')
            errors.push(`「${node.title}」请绑定角色：${pending.name}。`);
          continue;
        }
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
          const pending = task.templateSource?.pendingAssets.find(
            (a) => a.id === assetId && a.kind === kind,
          );
          if (pending) {
            if (task.status === 'ready')
              errors.push(`「${node.title}」请绑定资源：${pending.name}。`);
            continue;
          }
          if (!asset || (task.status === 'ready' && !asset.available))
            errors.push(`「${node.title}」引用的 ${kind} 不存在或不可用。`);
        }
      }
    }
  }
  if (task.status === 'ready') {
    for (const expert of assignedExperts(task, state)) {
      for (const [refs, kind] of [
        [expert.resourceBindings?.skillIds ?? [], 'skill'],
        [expert.resourceBindings?.mcpIds ?? [], 'mcp'],
      ] as const) {
        if (
          new Set(refs).size !== refs.length ||
          refs.some(
            (id) =>
              !state.assets.some(
                (asset) => asset.id === id && asset.kind === kind && asset.available,
              ),
          )
        )
          errors.push(`专家「${expert.name}」绑定的 ${kind} 不存在、不可用或重复，请重新选择。`);
      }
    }
  }
  return [...new Set(errors)];
}

/** Validate the reusable graph using role/resource slots, never live execution identities. */
export function parseWorkflowTemplate(content: string): WorkflowTemplate {
  if (content.length > 150000)
    throw new WorkbenchError('template-invalid', '工作流模板超过大小限制。');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new WorkbenchError('template-legacy', '这是文字模板，请先转换成结构化工作流。');
  }
  const parsed = WorkflowTemplateSchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkbenchError('template-invalid', '工作流模板格式不完整，请检查角色、资源和节点。');
  const definition = parsed.data;
  if (new Set(definition.resources.map((a) => a.id)).size !== definition.resources.length)
    throw new WorkbenchError('template-invalid', '模板资源标识不能重复。');
  const task: WorkTask = {
    id: 'template-validation',
    projectId: 'template-project',
    title: '模板',
    goal: '',
    participantIds: definition.roles.map((r) => r.id),
    ownerId: null,
    workflows: definition.workflows,
    status: 'ready',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const catalog: Workbench = {
    ...emptyWorkbench(),
    projects: [{ id: task.projectId, name: '模板结构验证', description: '' }],
    participants: definition.roles.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.preferredKind === 'expert' ? 'expert' : 'human',
      role: '',
      capabilities: r.capabilities,
      instructions: '',
      available: true,
    })),
    assets: definition.resources.map((a) => ({
      ...a,
      description: '',
      content: '',
      available: true,
    })),
  };
  const errors = validateWorkTask(task, catalog, { requireOwner: false });
  if (errors.length) throw new WorkbenchError('template-invalid', errors.join('\n'));
  return definition;
}

/** Capture definitions and role slots; no task owner, sessions, artifacts or personal instructions. */
export function captureWorkflowTemplate(
  task: WorkTask,
  state: Workbench,
  options: {
    rolePreferences?: Record<string, 'human' | 'expert' | 'any'>;
    resourceHints?: Record<string, string>;
  } = {},
): WorkflowTemplate {
  const roles: WorkflowTemplate['roles'] = [];
  const resources: WorkflowTemplate['resources'] = [];
  const roleIds = new Map<string, string>();
  const resourceIds = new Map<string, string>();
  function role(sourceId: string | null, missingKey: string, review = false): string {
    const key = sourceId ?? missingKey;
    const known = roleIds.get(key);
    if (known) return known;
    const person = state.participants.find((p) => p.id === sourceId);
    const pending = task.templateSource?.pendingParticipants.find((p) => p.id === sourceId);
    const roleId = `role-${roles.length + 1}`;
    const baseName = (
      person?.role.trim() ||
      pending?.name ||
      `${review ? '评审' : '执行'}角色 ${roles.length + 1}`
    ).slice(0, 150);
    let name = baseName;
    for (let suffix = 2; roles.some((r) => r.name === name); suffix++)
      name = `${baseName} · ${suffix}`;
    roles.push({
      id: roleId,
      name,
      preferredKind: options.rolePreferences?.[key] ?? person?.kind ?? 'any',
      capabilities: [...(person?.capabilities ?? [])],
    });
    roleIds.set(key, roleId);
    return roleId;
  }
  function resource(sourceId: string, kind: 'skill' | 'mcp'): string {
    const key = `${kind}:${sourceId}`;
    const known = resourceIds.get(key);
    if (known) return known;
    const asset = state.assets.find((a) => a.id === sourceId && a.kind === kind);
    const pending = task.templateSource?.pendingAssets.find(
      (a) => a.id === sourceId && a.kind === kind,
    );
    const resourceId = `resource-${resources.length + 1}`;
    resources.push({
      id: resourceId,
      kind,
      name: asset?.name ?? pending?.name ?? '待绑定资源',
      ...(asset || options.resourceHints?.[sourceId]
        ? { suggestedAssetId: asset?.id ?? options.resourceHints![sourceId]! }
        : {}),
    });
    resourceIds.set(key, resourceId);
    return resourceId;
  }
  const flowIds = new Map(task.workflows.map((w, i) => [w.id, `flow-${i + 1}`]));
  const nodeIds = new Map(
    task.workflows.flatMap((w) => w.nodes).map((n, i) => [n.id, `node-${i + 1}`]),
  );
  const workflows = task.workflows.map((w) => ({
    ...w,
    id: flowIds.get(w.id)!,
    parentNodeId: w.parentNodeId ? nodeIds.get(w.parentNodeId)! : null,
    nodes: w.nodes.map((n) => ({
      ...structuredClone(n),
      id: nodeIds.get(n.id)!,
      assigneeId: role(n.assigneeId, `assignee:${n.id}`),
      reviewerIds: n.reviewRequired
        ? n.reviewerIds.length
          ? n.reviewerIds.map((id) => role(id, id, true))
          : [role(null, `review:${n.id}`, true)]
        : [],
      skillIds: n.skillIds.map((id) => resource(id, 'skill')),
      mcpIds: n.mcpIds.map((id) => resource(id, 'mcp')),
      dependsOn: n.dependsOn.map((id) => nodeIds.get(id) ?? id),
      rationale: '',
    })),
  }));
  return parseWorkflowTemplate(
    JSON.stringify({
      format: 'zhuma-workflow-template',
      schemaVersion: 1,
      roles,
      resources,
      workflows,
    }),
  );
}

type TemplateInput = Extract<WorkbenchCommand, { type: 'instantiate-template' }>['input'];

/** Pure preview and Host construction share this function; applying the command is atomic. */
export function instantiateWorkflowTemplate(state: Workbench, input: TemplateInput): WorkTask {
  const source = state.assets.find(
    (a) => a.id === input.templateId && a.kind === 'template' && a.available,
  );
  if (!source)
    throw new WorkbenchError('template-unavailable', '该工作流模板已不可用，请重新选择。');
  if (state.tasks.some((t) => t.id === input.task.id))
    throw new WorkbenchError('task-exists', '任务标识已被使用，请重新创建。');
  const definition = parseWorkflowTemplate(source.content);
  for (const key of Object.keys(input.roleBindings))
    if (!definition.roles.some((r) => r.id === key))
      throw new WorkbenchError('template-binding', '角色映射引用了未知角色。');
  for (const key of Object.keys(input.resourceBindings))
    if (!definition.resources.some((r) => r.id === key))
      throw new WorkbenchError('template-binding', '资源映射引用了未知资源。');
  const pendingParticipants: z.infer<typeof TemplateSourceSchema>['pendingParticipants'] = [];
  const pendingAssets: z.infer<typeof TemplateSourceSchema>['pendingAssets'] = [];
  const roleMap = new Map(
    definition.roles.map((r, i) => {
      const target = input.roleBindings[r.id];
      if (target) {
        if (
          !input.task.participantIds.includes(target) ||
          !state.participants.some((p) => p.id === target && p.available)
        )
          throw new WorkbenchError('template-binding', `「${r.name}」请选择已参与任务的可用成员。`);
        return [r.id, target];
      }
      const pendingId = `${input.task.id}-p-${i}`;
      if (state.participants.some((p) => p.id === pendingId))
        throw new WorkbenchError('template-binding', '角色占位标识冲突，请重新创建任务。');
      pendingParticipants.push({
        id: pendingId,
        name: r.name,
        kind: r.preferredKind === 'expert' ? 'expert' : 'human',
      });
      return [r.id, pendingId];
    }),
  );
  const resourceMap = new Map(
    definition.resources.map((r, i) => {
      const target = input.resourceBindings[r.id];
      if (target) {
        if (!state.assets.some((a) => a.id === target && a.kind === r.kind && a.available))
          throw new WorkbenchError('template-binding', `「${r.name}」请选择同类型的可用资源。`);
        return [r.id, target];
      }
      const pendingId = `${input.task.id}-a-${i}`;
      if (state.assets.some((a) => a.id === pendingId))
        throw new WorkbenchError('template-binding', '资源占位标识冲突，请重新创建任务。');
      pendingAssets.push({ id: pendingId, name: r.name, kind: r.kind });
      return [r.id, pendingId];
    }),
  );
  const flowMap = new Map(definition.workflows.map((w, i) => [w.id, `${input.task.id}-f-${i}`]));
  const nodeMap = new Map(
    definition.workflows.flatMap((w) => w.nodes).map((n, i) => [n.id, `${input.task.id}-n-${i}`]),
  );
  const task = WorkTaskSchema.parse({
    ...input.task,
    status: 'draft',
    workflows: definition.workflows.map((w) => ({
      ...w,
      id: flowMap.get(w.id)!,
      parentNodeId: w.parentNodeId ? nodeMap.get(w.parentNodeId)! : null,
      nodes: w.nodes.map((n) => ({
        ...structuredClone(n),
        id: nodeMap.get(n.id)!,
        assigneeId: roleMap.get(n.assigneeId!)!,
        reviewerIds: n.reviewerIds.map((id) => roleMap.get(id)!),
        skillIds: n.skillIds.map((id) => resourceMap.get(id)!),
        mcpIds: n.mcpIds.map((id) => resourceMap.get(id)!),
        dependsOn: n.dependsOn.map((id) => nodeMap.get(id)!),
      })),
    })),
    templateSource: {
      assetId: source.id,
      ...(source.memberAsset ? { memberAsset: source.memberAsset } : {}),
      sourceWorkbenchRevision: state.revision,
      definition,
      pendingParticipants,
      pendingAssets,
    },
  });
  const errors = validateWorkTask(task, state);
  if (errors.length) throw new WorkbenchError('template-binding', errors.join('\n'));
  return task;
}

/** Replace only still-present placeholders, preserving later manual edits and all graph IDs. */
export function resolveTemplateBindings(
  task: WorkTask,
  state: Workbench,
  roles: Record<string, string>,
  resources: Record<string, string>,
): WorkTask {
  const next = structuredClone(task);
  const participantMap = new Map<string, string>();
  const assetMap = new Map<string, string>();
  for (const [from, to] of Object.entries(roles)) {
    if (
      !task.templateSource?.pendingParticipants.some((p) => p.id === from) ||
      !task.participantIds.includes(to) ||
      !state.participants.some((p) => p.id === to && p.available)
    )
      throw new WorkbenchError('template-binding', '角色映射需要已参与任务的可用成员。');
    participantMap.set(from, to);
  }
  for (const [from, to] of Object.entries(resources)) {
    const pending = task.templateSource?.pendingAssets.find((a) => a.id === from);
    if (
      !pending ||
      !state.assets.some((a) => a.id === to && a.kind === pending.kind && a.available)
    )
      throw new WorkbenchError('template-binding', '资源映射需要同类型的可用资源。');
    assetMap.set(from, to);
  }
  for (const node of next.workflows.flatMap((w) => w.nodes)) {
    node.assigneeId = node.assigneeId
      ? (participantMap.get(node.assigneeId) ?? node.assigneeId)
      : null;
    node.reviewerIds = node.reviewerIds.map((id) => participantMap.get(id) ?? id);
    node.skillIds = [...new Set(node.skillIds.map((id) => assetMap.get(id) ?? id))];
    node.mcpIds = [...new Set(node.mcpIds.map((id) => assetMap.get(id) ?? id))];
  }
  const errors = validateWorkTask(next, state);
  if (errors.length) throw new WorkbenchError('template-binding', errors.join('\n'));
  return next;
}

/** Draft UI projection only. Placeholders never become runtime participants or resources. */
export function templateBindingGaps(task: WorkTask) {
  const nodes = task.workflows.flatMap((w) => w.nodes);
  const people = new Set(
    nodes.flatMap((n) => [...(n.assigneeId ? [n.assigneeId] : []), ...n.reviewerIds]),
  );
  const assets = new Set(nodes.flatMap((n) => [...n.skillIds, ...n.mcpIds]));
  return {
    participants: task.templateSource?.pendingParticipants.filter((p) => people.has(p.id)) ?? [],
    assets: task.templateSource?.pendingAssets.filter((a) => assets.has(a.id)) ?? [],
  };
}

/** Same domain command and revision; package bytes are stored separately by the Host. */
export function applyResourceImport(state: Workbench, input: ImportPackageInput): Workbench {
  const preview = previewResourcePackage(input.files, parseWorkflowTemplate);
  const next = structuredClone(state);
  const chosen = new Map(input.choices.map((c) => [c.key, c]));
  if (
    chosen.size !== input.choices.length ||
    new Set(input.choices.map((c) => c.id)).size !== input.choices.length
  )
    throw new WorkbenchError('asset-import', '不能重复选择定义或目标标识。');
  for (const choice of input.choices) {
    const item = preview.items.find((i) => i.key === choice.key);
    if (!item) throw new WorkbenchError('asset-import', '选择的定义不属于当前资产包。');
    const all = [...next.assets, ...next.participants];
    const existing = all.find((r) => r.id === choice.id);
    const sameKind =
      item.kind === 'expert'
        ? next.participants.some((p) => p.id === choice.id && p.kind === 'expert')
        : next.assets.some((a) => a.id === choice.id && a.kind === item.kind);
    if ((choice.replace && (!existing || !sameKind)) || (!choice.replace && existing))
      throw new WorkbenchError('asset-import', '新建标识已存在，或更新目标的类型不匹配。');
    const catalog =
      item.kind === 'expert'
        ? next.participants.filter((p) => p.kind === 'expert')
        : next.assets.filter((a) => a.kind === item.kind);
    if (
      catalog.some(
        (r) =>
          r.id !== choice.id &&
          r.name.normalize('NFC').toLowerCase() === choice.name.normalize('NFC').toLowerCase(),
      )
    )
      throw new WorkbenchError(
        'asset-import',
        `「${choice.name}」已存在，请改名或明确更新已有定义。`,
      );
    const skillIds = item.skillKeys.flatMap((key) =>
      chosen.has(key) ? [chosen.get(key)!.id] : [],
    );
    const missingPaths = [
      ...item.missing,
      ...item.skillKeys.filter((key) => {
        const choice = chosen.get(key);
        const skill = preview.items.find((i) => i.key === key);
        return !choice?.available || !!skill?.missing.length;
      }),
    ];
    const missing = missingPaths.length > 0 || skillIds.length !== item.skillKeys.length;
    const origin = ResourceOriginSchema.parse({
      versionId: input.versionId,
      format: item.format,
      entryPath: item.key,
      filePaths: item.filePaths,
      totalBytes: preview.files
        .filter((f) => item.filePaths.includes(f.path))
        .reduce((sum, f) => sum + packageFileBytes(f), 0),
      missing: [...new Set(missingPaths)],
      ...(item.sourceVersion ? { sourceVersion: item.sourceVersion } : {}),
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    });
    if (item.kind === 'expert') {
      const previous = state.participants.find((p) => p.id === choice.id && p.kind === 'expert');
      const expert = ParticipantSchema.parse({
        id: choice.id,
        name: choice.name,
        kind: 'expert',
        role: choice.role,
        capabilities: choice.capabilities,
        instructions: item.content,
        available: choice.available && !missing,
        origin,
        resourceBindings: {
          skillIds: item.skillKeys.length ? skillIds : (previous?.resourceBindings?.skillIds ?? []),
          mcpIds: previous?.resourceBindings?.mcpIds ?? [],
        },
      });
      next.participants = [...next.participants.filter((p) => p.id !== expert.id), expert];
    } else {
      const asset = AssetSchema.parse({
        id: choice.id,
        name: choice.name,
        kind: item.kind,
        description: choice.description,
        content: item.content,
        available: choice.available && !missing,
        origin,
      });
      next.assets = [...next.assets.filter((a) => a.id !== asset.id), asset];
    }
  }
  return next;
}

function keepImportedBody(
  previous: { origin?: unknown; content?: string; instructions?: string } | undefined,
  next: { origin?: unknown; content?: string; instructions?: string },
) {
  if (
    JSON.stringify(previous?.origin ?? null) !== JSON.stringify(next.origin ?? null) ||
    (previous?.origin &&
      (previous.content !== next.content || previous.instructions !== next.instructions))
  )
    throw new WorkbenchError(
      'asset-source',
      '包文件和来源版本需通过重新导入更新；名称、用途和可用性可直接编辑。',
    );
}

function validateDefaultResources(participant: Participant, state: Workbench) {
  if (!participant.resourceBindings) return;
  for (const [refs, kind] of [
    [participant.resourceBindings.skillIds, 'skill'],
    [participant.resourceBindings.mcpIds, 'mcp'],
  ] as const) {
    if (
      new Set(refs).size !== refs.length ||
      refs.some((id) => !state.assets.some((a) => a.id === id && a.kind === kind))
    )
      throw new WorkbenchError(
        'asset-binding',
        '专家默认能力不存在、类型不匹配或重复，请重新选择。',
      );
  }
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
      for (const [references, catalog] of [
        [command.project.defaultParticipantIds ?? [], state.participants],
        [command.project.assetIds ?? [], state.assets],
      ] as const) {
        if (
          new Set(references).size !== references.length ||
          references.some((id) => !catalog.some((item) => item.id === id))
        )
          throw new WorkbenchError(
            'project-reference',
            '项目关联的参与者或资产不存在或重复，请重新选择。',
          );
      }
      if (
        new Set(command.project.references?.map((r) => r.id)).size !==
        (command.project.references?.length ?? 0)
      )
        throw new WorkbenchError('project-reference', '项目资料标识不能重复。');
      next.projects = upsert(next.projects, command.project);
      break;
    case 'save-participant':
      keepImportedBody(
        state.participants.find((p) => p.id === command.participant.id),
        command.participant,
      );
      if (
        command.participant.kind === 'human' &&
        (command.participant.origin || command.participant.resourceBindings)
      )
        throw new WorkbenchError('asset-source', '真人成员不能携带专家包或默认能力。');
      validateDefaultResources(command.participant, state);
      next.participants = upsert(next.participants, command.participant);
      break;
    case 'save-asset':
      keepImportedBody(
        state.assets.find((a) => a.id === command.asset.id),
        command.asset,
      );
      next.assets = upsert(next.assets, command.asset);
      break;
    case 'import-package': {
      try {
        const imported = applyResourceImport(state, command.input);
        next.assets = imported.assets;
        next.participants = imported.participants;
      } catch (error) {
        if (error instanceof AssetImportError)
          throw new WorkbenchError('asset-import', error.message);
        throw error;
      }
      break;
    }
    case 'save-task': {
      const errors = validateWorkTask(command.task, next);
      if (errors.length) throw new WorkbenchError('validation', errors.join('\n'));
      const prior = state.tasks.find((t) => t.id === command.task.id);
      if (
        JSON.stringify(prior?.templateSource ?? null) !==
        JSON.stringify(command.task.templateSource ?? null)
      )
        throw new WorkbenchError(
          'template-source',
          '模板来源快照不能通过任务编辑改写，请从工作流模板创建任务。',
        );
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
    case 'instantiate-template': {
      const task = instantiateWorkflowTemplate(state, command.input);
      next.tasks = upsert(next.tasks, task);
      break;
    }
  }
  next.revision += 1;
  return WorkbenchSchema.parse(next);
}

function definitionSnapshot(task: WorkTask, state: Workbench) {
  // Executor and reviewer methods keep their own dependencies. Freezing their
  // definitions does not grant those tools to the author's node or fill old plans.
  const assetIds = new Set([
    ...task.workflows.flatMap((workflow) =>
      workflow.nodes.flatMap((node) => [...node.skillIds, ...node.mcpIds]),
    ),
    ...assignedExperts(task, state).flatMap((expert) => [
      ...(expert.resourceBindings?.skillIds ?? []),
      ...(expert.resourceBindings?.mcpIds ?? []),
    ]),
  ]);
  return structuredClone({
    task,
    participants: state.participants.filter((p) => task.participantIds.includes(p.id)),
    assets: state.assets.filter((asset) => assetIds.has(asset.id)),
  });
}

export interface AppliedPlanRef {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
}

/** Read the exact frozen version locked by the caller, independently of the current draft. */
export function createExecutionHandoff(reference: AppliedPlanRef, state: Workbench): AppliedPlan {
  if (
    !reference.taskId ||
    !reference.planId ||
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1
  )
    throw new WorkbenchError('plan-reference-required', '请提供任务、计划标识和精确计划版本。');
  const applied = state.appliedPlans.find(
    (p) =>
      p.taskId === reference.taskId &&
      p.id === reference.planId &&
      p.revision === reference.revision,
  );
  if (!applied || applied.task.id !== reference.taskId || applied.task.status !== 'ready')
    throw new WorkbenchError('plan-not-found', '找不到该任务指定的已确认计划版本。');
  return structuredClone(applied);
}
