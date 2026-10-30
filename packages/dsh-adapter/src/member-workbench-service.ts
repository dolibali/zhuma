import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  applyWorkbenchCommand,
  AssetSchema,
  ParticipantSchema,
  WorkbenchError,
  WorkbenchSchema,
  validateWorkTask,
  instantiateWorkflowTemplate,
  captureWorkflowTemplate,
  canonicalPayload,
  MemberAssetLegacySummarySchema,
  type MemberAssetDefinition,
  type MemberAssetLegacySource,
  type TeamAsset,
  type Participant,
  type Project,
  type Workbench,
  type WorkTask,
} from '@zhuma/agent-core';
import {
  MemberWorkbenchCommandSchema,
  MemberWorkbenchPlanSchema,
  MemberWorkbenchScopeSchema,
  type MemberWorkbenchCatalog,
  type MemberWorkbenchCommand,
  type MemberWorkbenchDirectory,
  type MemberWorkbenchOptions,
  type MemberWorkbenchSnapshot,
} from './member-workbench-dto.js';
import { WorkbenchService } from './workbench-service.js';
import { defaultMemberTemplateSource, ownedMemberTemplates } from './member-template-catalog.js';
import type { MemberAssetSourceSnapshot } from './member-asset-source-contract.js';
import { memberAssetPublishedCatalog, memberAssetFixedFiles } from './member-asset-service.js';
import {
  memberWorkbenchOperationKey,
  type MemberWorkbenchIntent,
} from './member-workbench-operation.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const memberSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w-]+$/u),
  name: z.string().trim().min(1).max(160).optional(),
});
const catalogSchema = z.strictObject({
  experts: z.array(ParticipantSchema.refine((p) => p.kind === 'expert')).max(100),
  assets: z.array(AssetSchema).max(100),
});
function fail(code: string, message: string): never {
  throw new WorkbenchError(code, message);
}

interface Scope {
  actorId: string;
  spaceId: string;
  directory: MemberWorkbenchDirectory;
  participants: Participant[];
  catalog: MemberWorkbenchCatalog;
}

/** Member authorization facade over the existing serialized Workbench fact owner. */
export class MemberWorkbenchService {
  constructor(
    private readonly workbench: WorkbenchService,
    private readonly options: MemberWorkbenchOptions,
  ) {}

  /** Host-only original source provider for assets; HTTP callers receive only
   * the later authority's metadata or explicitly selected detail projection. */
  async assetSources(raw: unknown, signal: AbortSignal): Promise<MemberAssetSourceSnapshot> {
    const { spaceId } = MemberWorkbenchScopeSchema.parse(raw);
    signal.throwIfAborted();
    const initial = await this.scope(spaceId);
    const revision = this.workbench.snapshot().revision;
    const fingerprint = canonicalPayload(initial.catalog);
    const items: MemberAssetSourceSnapshot['items'][number][] = [];
    const add = (
      original: TeamAsset | Participant,
      definition: MemberAssetDefinition,
      source: MemberAssetLegacySource,
      requirements: MemberAssetSourceSnapshot['items'][number]['requirements'] = [],
    ) => {
      items.push({
        summary: MemberAssetLegacySummarySchema.parse({
          source,
          kind: definition.kind,
          name: definition.name,
          description: definition.description,
          available: original.available,
          readOnly: true,
          canCopy:
            original.available &&
            source.kind !== 'unknown' &&
            !requirements.some((item) => item.kind === 'mcp'),
        }),
        definition,
        requirements,
      });
    };
    for (const asset of initial.catalog.assets) {
      if (asset.kind === 'mcp' || asset.memberAsset) continue;
      const definition: MemberAssetDefinition = {
        kind: asset.kind,
        name: asset.name,
        description: asset.description,
        content: asset.content,
        ...(asset.origin ? { origin: asset.origin } : {}),
      };
      const common = { spaceId, assetId: asset.id, assetKind: asset.kind };
      const builtin = defaultMemberTemplateSource(asset);
      const source: MemberAssetLegacySource = asset.memberTemplate
        ? {
            ...common,
            assetKind: 'template',
            kind: 'member-template',
            ownerId: asset.memberTemplate.ownerId,
            sourceTaskId: asset.memberTemplate.sourceTaskId,
            sourceWorkbenchRevision: asset.memberTemplate.sourceWorkbenchRevision,
            sha256: digest({ definition: asset, memberTemplate: asset.memberTemplate }),
          }
        : builtin
          ? { ...common, kind: 'builtin', ...builtin }
          : asset.origin
            ? { ...common, kind: 'package', origin: asset.origin, sha256: digest(asset) }
            : { ...common, kind: 'unknown', sha256: digest(asset) };
      add(asset, definition, source);
    }
    for (const expert of initial.catalog.experts) {
      if (expert.memberAsset) continue;
      const common = {
        spaceId,
        assetId: expert.id,
        assetKind: 'expert' as const,
        sha256: digest(expert),
      };
      const source: MemberAssetLegacySource = expert.origin
        ? { ...common, kind: 'package', origin: expert.origin }
        : { ...common, kind: 'unknown' };
      add(
        expert,
        {
          kind: 'expert',
          name: expert.name,
          description: expert.role,
          role: expert.role,
          capabilities: expert.capabilities,
          instructions: expert.instructions,
          ...(expert.origin ? { origin: expert.origin } : {}),
        },
        source,
        [
          ...(expert.resourceBindings?.skillIds ?? []).map((slotId) => ({
            slotId,
            kind: 'skill' as const,
          })),
          ...(expert.resourceBindings?.mcpIds ?? []).map((slotId) => ({
            slotId,
            kind: 'mcp' as const,
          })),
        ],
      );
    }
    const current = await this.scope(spaceId, initial.actorId);
    signal.throwIfAborted();
    if (
      current.directory !== initial.directory ||
      this.workbench.snapshot().revision !== revision ||
      canonicalPayload(current.catalog) !== fingerprint
    )
      fail('context-changed', '授权资产来源已变化，请重新读取。');
    return structuredClone({ actorId: initial.actorId, spaceId, items });
  }

  private async scope(spaceId: string, actorId?: string): Promise<Scope> {
    const member = await this.options.resolve();
    if (!member.ok) fail(member.code, '请重新登录后再试。');
    if (actorId !== undefined && member.memberId !== actorId)
      fail('unauthenticated', '当前登录身份已经变化。');
    const directory = this.options.directory();
    if (!directory) fail('unavailable', '成员目录暂不可用。');
    if (!member.spaceIds.includes(spaceId) || !directory.isMember(spaceId, member.memberId))
      fail('not-found', '空间不可用。');
    const memberData = z.array(memberSchema).max(100).safeParse(directory.membersForSpace(spaceId));
    if (!memberData.success) fail('unavailable', '成员目录暂不可用。');
    const members = memberData.data;
    if (!members.some((m) => m.id === member.memberId)) fail('not-found', '成员不可用。');
    if (new Set(members.map((m) => m.id)).size !== members.length)
      fail('unavailable', '成员目录暂不可用。');
    const catalogData = catalogSchema.safeParse(
      this.options.catalog ? await this.options.catalog(spaceId) : { experts: [], assets: [] },
    );
    if (!catalogData.success) fail('unavailable', '授权资源目录暂不可用。');
    // Resolve identity after the yielding catalog read, before using a possibly retired directory.
    const current = await this.options.resolve();
    if (!current.ok || current.memberId !== member.memberId)
      fail('unauthenticated', '当前登录身份已经变化。');
    if (!current.spaceIds.includes(spaceId) || !directory.isMember(spaceId, current.memberId))
      fail('not-found', '空间不可用。');
    const space = directory.space(spaceId);
    if (!space) fail('not-found', '空间不可用。');
    const state = this.workbench.snapshot();
    const personalOwner =
      space.kind === 'personal' ? directory.administratorForSpace?.(spaceId) : undefined;
    if (
      space.kind === 'personal' &&
      (state.assets.some((asset) => asset.memberTemplate?.spaceId === spaceId) ||
        state.projects.some((project) =>
          project.fileRefs?.some((ref) => ref.spaceId === spaceId),
        ) ||
        state.tasks.some((task) => task.fileRefs?.some((ref) => ref.spaceId === spaceId)) ||
        catalogData.data.assets.some((asset) => asset.kind === 'template' || asset.memberAsset) ||
        catalogData.data.experts.some((expert) => expert.memberAsset))
    ) {
      if (!personalOwner) fail('unavailable', '个人工作流归属暂不可用。');
      if (personalOwner !== member.memberId) fail('not-found', '空间不可用。');
    }
    // Static grants are Host-owned. Member ownership comes only from the original asset row.
    if (catalogData.data.assets.some((asset) => asset.memberTemplate))
      fail('unavailable', '成员工作流目录来源不可用。');
    // A Host catalog marker must match an actual publication in this same fact
    // owner; a ref/hash/UUID supplied by another catalog is never authority.
    const published = memberAssetPublishedCatalog(state.memberAssets ?? [], spaceId);
    for (const [incoming, actual] of [
      [catalogData.data.assets, published.assets],
      [catalogData.data.experts, published.experts],
    ] as const)
      for (const value of incoming.filter((item) => item.memberAsset)) {
        const fixed = actual.find((item) => item.id === value.id);
        if (!fixed || canonicalPayload(fixed) !== canonicalPayload(value))
          fail('resource-unavailable', '已发布资产的空间或固定版本不可用。');
      }
    const catalog: MemberWorkbenchCatalog = {
      experts: catalogData.data.experts,
      assets: [
        ...catalogData.data.assets,
        ...ownedMemberTemplates(state.assets, {
          spaceId,
          actorId: member.memberId,
          kind: space.kind,
          ...(personalOwner ? { personalOwner } : {}),
        }),
      ],
    };
    // The catalog itself is trusted injection; references and collisions still fail closed.
    const allIds = [...members.map((m) => m.id), ...catalog.experts.map((p) => p.id)];
    if (
      new Set(allIds).size !== allIds.length ||
      catalog.assets.length > 100 ||
      new Set(catalog.assets.map((a) => a.id)).size !== catalog.assets.length
    )
      fail('unavailable', '授权目录存在标识冲突。');
    for (const expert of catalog.experts) {
      for (const [ids, kind] of [
        [expert.resourceBindings?.skillIds ?? [], 'skill'],
        [expert.resourceBindings?.mcpIds ?? [], 'mcp'],
      ] as const) {
        if (
          ids.some(
            (id) => !catalog.assets.some((a) => a.id === id && a.kind === kind && a.available),
          )
        )
          fail('resource-unavailable', '专家引用的资源不可用。');
      }
    }
    if (personalOwner && directory.administratorForSpace?.(spaceId) !== personalOwner)
      fail('not-found', '个人空间归属已变化。');
    const participants: Participant[] = members
      .filter((m) => directory.isMember(spaceId, m.id))
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        kind: 'human',
        role: '',
        capabilities: [],
        instructions: '',
        available: true,
      }));
    return {
      actorId: member.memberId,
      spaceId,
      directory,
      participants: [...participants, ...catalog.experts],
      catalog,
    };
  }

  private async project(scope: Scope, projectId: string): Promise<void> {
    const lookup = await scope.directory.spaceForProject(projectId);
    if (!lookup.ok && lookup.reason === 'unavailable') fail('unavailable', '项目目录暂不可用。');
    if (!lookup.ok || lookup.spaceId !== scope.spaceId) fail('not-found', '项目不可用。');
  }

  private task(state: Workbench, scope: Scope, taskId: string, edit = false): WorkTask {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !task.participantIds.includes(scope.actorId)) fail('not-found', '任务不可用。');
    if (edit && task.ownerId !== scope.actorId)
      fail('forbidden', '仅任务负责人可以修改或确认计划。');
    return task;
  }

  private catalogState(state: Workbench, scope: Scope): Workbench {
    // Legacy global profiles are never used to authorize or prompt a member.
    return {
      ...structuredClone(state),
      participants: structuredClone(scope.participants),
      assets: structuredClone([...scope.catalog.assets]),
    };
  }

  private validateFileOwner(scope: Scope, references: WorkTask['fileRefs']): void {
    if (references === undefined || scope.directory.space(scope.spaceId)?.kind !== 'personal')
      return;
    const owner = scope.directory.administratorForSpace?.(scope.spaceId);
    if (!owner) fail('unavailable', '个人资料归属暂不可用。');
    if (owner !== scope.actorId) fail('not-found', '空间不可用。');
  }

  private validateTask(task: WorkTask, state: Workbench, scope: Scope): void {
    this.validateFileOwner(scope, task.fileRefs);
    memberAssetFixedFiles(state.memberAssets ?? [], {
      spaceId: scope.spaceId,
      references: task.fileRefs ?? [],
    });
    if (!task.ownerId || !task.participantIds.includes(scope.actorId))
      fail('validation', '请选择负责人，并将当前成员加入任务。');
    if (
      task.participantIds.some((id) => !scope.participants.some((p) => p.id === id && p.available))
    )
      fail('resource-unavailable', '任务参与者不在当前授权目录中。');
    // Check new draft -> ready transitions, not already committed legacy replays.
    // The original scoped catalog gates kind, availability and source completeness.
    const confirming =
      task.status === 'ready' &&
      state.tasks.some((existing) => existing.id === task.id && existing.status === 'draft');
    for (const node of task.workflows.flatMap((w) => w.nodes)) {
      for (const [ids, kind] of [
        [node.skillIds, 'skill'],
        [node.mcpIds, 'mcp'],
      ] as const)
        if (
          ids.some(
            (id) =>
              !scope.catalog.assets.some((a) => a.id === id && a.kind === kind && a.available) &&
              !(
                task.status === 'draft' &&
                task.templateSource?.pendingAssets.some((a) => a.id === id && a.kind === kind)
              ),
          )
        )
          fail('resource-unavailable', '工作节点引用的资源不可用。');
      const assignee = scope.participants.find((p) => p.id === node.assigneeId);
      if (confirming && assignee?.kind === 'expert') {
        for (const [required, selected, label] of [
          [assignee.resourceBindings?.skillIds ?? [], node.skillIds, 'Skill'],
          [assignee.resourceBindings?.mcpIds ?? [], node.mcpIds, 'MCP'],
        ] as const) {
          const missing = required.filter((id) => !selected.includes(id));
          if (missing.length)
            fail(
              'resource-unavailable',
              `「${node.title}」的执行专家「${assignee.name}」需要在节点中选择 ${label}：${missing.join('、')}。`,
            );
        }
      }
    }
    const errors = validateWorkTask(task, this.catalogState(state, scope), { requireOwner: true });
    if (errors.length) fail('validation', errors.join('\n'));
  }

  private validateProject(project: Project, scope: Scope): void {
    this.validateFileOwner(scope, project.fileRefs);
    memberAssetFixedFiles(this.workbench.memberAssetRecords(), {
      spaceId: scope.spaceId,
      references: project.fileRefs ?? [],
    });
    if (
      (project.defaultParticipantIds ?? []).some(
        (id) => !scope.participants.some((p) => p.id === id && p.available),
      ) ||
      (project.assetIds ?? []).some(
        (id) => !scope.catalog.assets.some((a) => a.id === id && a.available),
      )
    )
      fail('resource-unavailable', '项目引用了未授权的成员或资源。');
  }

  private templateSpace(scope: Scope): void {
    const space = scope.directory.space(scope.spaceId);
    if (!space) fail('not-found', '空间不可用。');
    if (space.kind !== 'personal') return;
    const owner = scope.directory.administratorForSpace?.(scope.spaceId);
    if (!owner) fail('unavailable', '个人工作流归属暂不可用。');
    if (owner !== scope.actorId) fail('not-found', '空间不可用。');
  }

  private async sourceScope(scope: Scope, sourceSpaceId?: string): Promise<Scope> {
    this.templateSpace(scope);
    const source =
      !sourceSpaceId || sourceSpaceId === scope.spaceId
        ? scope
        : await this.scope(sourceSpaceId, scope.actorId);
    this.templateSpace(source);
    return source;
  }

  private async templateInput(
    state: Workbench,
    scope: Scope,
    command: Extract<MemberWorkbenchCommand['command'], { type: 'instantiate-template' }>,
    inheritanceState = state,
  ) {
    const source = await this.sourceScope(scope, command.input.sourceSpaceId);
    const asset = source.catalog.assets.find(
      (item) => item.id === command.input.templateId && item.kind === 'template' && item.available,
    );
    if (!asset) fail('template-unavailable', '该工作流模板已不可用，请重新选择。');
    const target = this.catalogState(state, scope);
    // Only the selected template structure crosses scopes; no source expert/Skill grants.
    target.assets = [
      ...target.assets.filter((item) => item.id !== asset.id),
      structuredClone(asset),
    ];
    const { sourceSpaceId: _source, ...input } = command.input;
    return {
      state: target,
      input: {
        ...input,
        task: {
          ...input.task,
          ...this.taskFileSelection(inheritanceState, input.task, true),
          updatedAt: (this.options.now ?? (() => new Date().toISOString()))(),
        },
      },
    };
  }

  private async savedTemplate(
    state: Workbench,
    scope: Scope,
    command: Extract<MemberWorkbenchCommand['command'], { type: 'save-template' }>,
    sourceWorkbenchRevision: number,
  ): Promise<TeamAsset> {
    const previous = state.assets.find((asset) => asset.id === command.input.templateId);
    if (previous) {
      if (!previous.memberTemplate || previous.kind !== 'template')
        fail('conflict', '资产标识已存在。');
      if (previous.memberTemplate.spaceId !== scope.spaceId) fail('not-found', '工作流不可用。');
      if (previous.memberTemplate.ownerId !== scope.actorId)
        fail('forbidden', '仅工作流作者可以更新。');
    }
    const source = await this.sourceScope(scope, command.input.sourceSpaceId);
    const task = this.task(state, source, command.input.sourceTaskId, true);
    await this.project(source, task.projectId);
    const definition = captureWorkflowTemplate(task, this.catalogState(state, source));
    return AssetSchema.parse({
      id: command.input.templateId,
      name: command.input.name,
      description: command.input.description,
      kind: 'template',
      available: true,
      content: JSON.stringify(definition),
      memberTemplate: {
        schemaVersion: 1,
        spaceId: scope.spaceId,
        ownerId: scope.actorId,
        sourceTaskId: task.id,
        sourceWorkbenchRevision,
      },
    });
  }

  private taskFileSelection(
    state: Workbench,
    input: Pick<WorkTask, 'id' | 'projectId' | 'fileRefs'>,
    creating: boolean,
  ): Pick<WorkTask, 'fileRefs'> {
    const previous = state.tasks.find((task) => task.id === input.id);
    const references =
      input.fileRefs !== undefined
        ? input.fileRefs
        : previous
          ? previous.fileRefs
          : creating
            ? state.projects.find((project) => project.id === input.projectId)?.fileRefs
            : undefined;
    // A raw omitted create replay uses the already committed task, including
    // its original omission. Never recompute inheritance from a changed project.
    return references === undefined ? {} : { fileRefs: structuredClone(references) };
  }

  private async commandTask(
    state: Workbench,
    scope: Scope,
    command: MemberWorkbenchCommand['command'],
  ): Promise<WorkTask | undefined> {
    if (
      command.type === 'create-project' ||
      command.type === 'update-project' ||
      command.type === 'save-template'
    )
      return undefined;
    if (command.type === 'confirm-task')
      return state.tasks.find((task) => task.id === command.taskId);
    const updatedAt = (this.options.now ?? (() => new Date().toISOString()))();
    if (command.type === 'instantiate-template') {
      // Original receipts handle retries. Pure construction can validate the same
      // request again without overwriting the existing task on the replay path.
      const prepared = await this.templateInput(
        { ...state, tasks: state.tasks.filter((task) => task.id !== command.input.task.id) },
        scope,
        command,
        state,
      );
      return instantiateWorkflowTemplate(prepared.state, prepared.input);
    }
    const previous = state.tasks.find((task) => task.id === command.task.id);
    return {
      ...command.task,
      ...this.taskFileSelection(state, command.task, command.type === 'create-task'),
      status: 'draft',
      updatedAt,
      ...(command.type === 'update-task' && previous?.templateSource
        ? { templateSource: structuredClone(previous.templateSource) }
        : {}),
    };
  }

  private mergeCatalog(state: Workbench, scope: Scope): Workbench {
    const next = structuredClone(state);
    for (const participant of scope.participants) {
      const previous = next.participants.find((p) => p.id === participant.id);
      if (
        previous &&
        (previous.kind !== participant.kind ||
          (participant.kind === 'expert' &&
            JSON.stringify(previous) !== JSON.stringify(participant)))
      )
        fail('resource-conflict', '授权参与者与已有定义冲突。');
      // Preserve legacy definitions. Member confirmation captures scoped definitions below,
      // never those private instructions; identity membership is not a profile overwrite.
      if (!previous) next.participants.push(structuredClone(participant));
    }
    for (const asset of scope.catalog.assets) {
      const previous = next.assets.find((a) => a.id === asset.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(asset))
        fail('resource-conflict', '授权资源与已有定义冲突。');
      if (!previous) next.assets.push(structuredClone(asset));
    }
    return next;
  }

  private async projectSnapshot(
    spaceId: string,
    actorId?: string,
  ): Promise<MemberWorkbenchSnapshot> {
    const scope = await this.scope(spaceId, actorId);
    const state = this.workbench.snapshot();
    const projects: Project[] = [];
    for (const project of state.projects) {
      const lookup = await scope.directory.spaceForProject(project.id);
      if (!lookup.ok && lookup.reason === 'unavailable') fail('unavailable', '项目目录暂不可用。');
      if (lookup.ok && lookup.spaceId === spaceId)
        projects.push({
          ...project,
          defaultParticipantIds: (project.defaultParticipantIds ?? []).filter((id) =>
            scope.participants.some((p) => p.id === id),
          ),
          assetIds: (project.assetIds ?? []).filter((id) =>
            scope.catalog.assets.some((a) => a.id === id),
          ),
        });
    }
    const tasks = state.tasks.filter(
      (task) =>
        projects.some((p) => p.id === task.projectId) &&
        task.participantIds.includes(scope.actorId),
    );
    const fresh = await this.scope(spaceId, scope.actorId);
    if (this.workbench.snapshot().revision !== state.revision)
      fail('conflict', '目录读取期间内容已变化，请刷新。');
    const space = fresh.directory.space(spaceId);
    if (!space) fail('not-found', '空间不可用。');
    const model = this.options.model?.();
    const { memberAssets: _privateAssetFacts, ...visibleState } = state;
    return structuredClone({
      actorId: scope.actorId,
      spaceId,
      space,
      state: {
        ...visibleState,
        projects: projects.map((project) => ({
          ...project,
          defaultParticipantIds: (project.defaultParticipantIds ?? []).filter((id) =>
            fresh.participants.some((p) => p.id === id),
          ),
          assetIds: (project.assetIds ?? []).filter((id) =>
            fresh.catalog.assets.some((a) => a.id === id),
          ),
        })),
        tasks,
        participants: fresh.participants,
        assets: [...fresh.catalog.assets],
        appliedPlans: state.appliedPlans
          .filter((p) => tasks.some((t) => t.id === p.taskId))
          .map((plan) => ({
            ...plan,
            // A frozen runtime fact is retained server-side, but is not an enduring read grant.
            participants: plan.participants.flatMap((participant) => {
              const authorized = fresh.participants.find(
                (p) => p.id === participant.id && p.kind === participant.kind,
              );
              if (!authorized) return [];
              return participant.kind === 'human'
                ? [authorized]
                : JSON.stringify(participant) === JSON.stringify(authorized)
                  ? [participant]
                  : [];
            }),
            assets: plan.assets.filter((asset) =>
              fresh.catalog.assets.some(
                (a) => a.id === asset.id && JSON.stringify(a) === JSON.stringify(asset),
              ),
            ),
          })),
        receipts: [],
      },
      model: model?.name ?? null,
      capabilities: {
        createProject: !!this.options.writer() && !!this.options.operations,
        createTask: projects.length > 0 && !!this.options.operations,
        planning: !!model,
        resources: this.options.catalog ? ('authorized' as const) : ('not-connected' as const),
        tasks: tasks.map((task) => ({
          taskId: task.id,
          edit:
            !!this.options.operations && task.ownerId === scope.actorId && task.status === 'draft',
          confirm:
            !!this.options.operations && task.ownerId === scope.actorId && task.status === 'draft',
          plan: !!model && task.ownerId === scope.actorId && task.status === 'draft',
        })),
      },
    });
  }

  async snapshot(raw: unknown): Promise<MemberWorkbenchSnapshot> {
    return this.projectSnapshot(MemberWorkbenchScopeSchema.parse(raw).spaceId);
  }

  async command(raw: unknown, signal: AbortSignal): Promise<MemberWorkbenchSnapshot> {
    const request = MemberWorkbenchCommandSchema.parse(raw);
    const initial = await this.scope(request.spaceId);
    const journal = this.options.operations;
    if (!journal) fail('unavailable', '成员操作恢复存储尚未接入。');
    const command = request.command;
    // Preserve every historical command fingerprint; map key order is immaterial in new template requests.
    const bodyFingerprint =
      command.type === 'save-template' || command.type === 'instantiate-template'
        ? digest(canonicalPayload([initial.actorId, request]))
        : digest([initial.actorId, request]);
    const saved =
      command.type === 'save-template'
        ? await this.savedTemplate(
            this.workbench.snapshot(),
            initial,
            command,
            request.expectedRevision,
          )
        : undefined;
    const pins =
      command.type === 'save-template' && saved
        ? (journal.templatePins({
            actorId: initial.actorId,
            spaceId: request.spaceId,
            requestId: request.requestId,
            fingerprint: bodyFingerprint,
          }) ?? {
            templatePriorFingerprint: (() => {
              const prior = this.workbench
                .snapshot()
                .assets.find((asset) => asset.id === command.input.templateId);
              return prior ? digest(prior) : null;
            })(),
            templateResultFingerprint: digest(saved),
          })
        : undefined;
    if (saved && pins?.templateResultFingerprint !== digest(saved))
      fail('context-changed', '模板来源已变化，请核对原操作。');
    // apply merges this authorized catalog and freezes its actual definitions, not only their IDs.
    const definitionFingerprint = (scope: Scope) =>
      digest([
        [...scope.participants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        command.type !== 'save-template'
          ? [...scope.catalog.assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          : scope.catalog.assets
              .flatMap((asset) => {
                const hash = digest(asset);
                if (
                  asset.id === command.input.templateId &&
                  hash === pins?.templateResultFingerprint
                )
                  return pins.templatePriorFingerprint
                    ? [[asset.id, pins.templatePriorFingerprint]]
                    : [];
                return [[asset.id, hash]];
              })
              .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
      ]);
    const context = async (scope: Scope): Promise<string> => {
      if (command.type !== 'save-template' && command.type !== 'instantiate-template')
        return definitionFingerprint(scope);
      const source = await this.sourceScope(scope, command.input.sourceSpaceId);
      return digest([
        definitionFingerprint(scope),
        source.spaceId === scope.spaceId ? null : definitionFingerprint(source),
        command.type === 'save-template'
          ? [
              digest(
                this.task(this.workbench.snapshot(), source, command.input.sourceTaskId, true),
              ),
              digest(
                await this.savedTemplate(
                  this.workbench.snapshot(),
                  scope,
                  command,
                  request.expectedRevision,
                ),
              ),
            ]
          : null,
      ]);
    };
    const contextFingerprint = await context(initial);
    const pinnedScope = async () => {
      let scope: Scope;
      try {
        scope = await this.scope(request.spaceId, initial.actorId);
      } catch (error) {
        if (error instanceof WorkbenchError && error.code === 'resource-unavailable')
          fail('context-changed', '授权定义已变化，请刷新后核对原操作。');
        throw error;
      }
      if ((await context(scope)) !== contextFingerprint)
        fail('context-changed', '授权定义已变化，请刷新后核对原操作。');
      return scope;
    };
    const intent: MemberWorkbenchIntent = {
      actorId: initial.actorId,
      spaceId: request.spaceId,
      requestId: request.requestId,
      objectId:
        command.type === 'confirm-task'
          ? command.taskId
          : command.type === 'create-project' || command.type === 'update-project'
            ? command.project.id
            : command.type === 'save-template'
              ? command.input.templateId
              : command.type === 'instantiate-template'
                ? command.input.task.id
                : command.task.id,
      commandType: command.type,
      expectedRevision: request.expectedRevision,
      fingerprint: bodyFingerprint,
      contextFingerprint,
      ...pins,
    };
    // Compare an interrupted operation's durable pin before considering the current catalog.
    journal.inspect(intent);
    const authorize = async () => {
      const scope = await pinnedScope();
      const state = this.workbench.snapshot();
      const command = request.command;
      if (command.type === 'save-template') {
        const asset = await this.savedTemplate(state, scope, command, request.expectedRevision);
        applyWorkbenchCommand(this.mergeCatalog(state, scope), { type: 'save-asset', asset });
      } else if (command.type === 'create-project' || command.type === 'update-project') {
        this.validateProject(command.project, scope);
        if (state.projects.some((p) => p.id === command.project.id))
          await this.project(scope, command.project.id);
      } else {
        const taskId =
          command.type === 'confirm-task'
            ? command.taskId
            : command.type === 'instantiate-template'
              ? command.input.task.id
              : command.task.id;
        const existing = state.tasks.find((t) => t.id === taskId);
        if (existing) {
          this.task(
            state,
            scope,
            taskId,
            command.type !== 'create-task' && command.type !== 'instantiate-template',
          );
          await this.project(scope, existing.projectId);
        }
        if (command.type !== 'confirm-task') {
          await this.project(
            scope,
            command.type === 'instantiate-template'
              ? command.input.task.projectId
              : command.task.projectId,
          );
          const task = (await this.commandTask(state, scope, command))!;
          this.validateTask(task, state, scope);
        } else if (existing) this.validateTask(existing, state, scope);
      }
      const fresh = await pinnedScope();
      if (command.type === 'save-template') {
        await this.savedTemplate(state, fresh, command, request.expectedRevision);
      } else if (command.type === 'create-project' || command.type === 'update-project')
        this.validateProject(command.project, fresh);
      else {
        const task = await this.commandTask(state, fresh, command);
        if (task) this.validateTask(task, state, fresh);
      }
    };
    await this.workbench.memberCommand(
      {
        receiptId: memberWorkbenchOperationKey(intent),
        fingerprint: intent.fingerprint,
        expectedRevision: request.expectedRevision,
      },
      signal,
      authorize,
      async (state) => {
        const scope = await pinnedScope();
        return this.apply(
          state,
          scope,
          request.command,
          signal,
          async () => {
            signal.throwIfAborted();
            await authorize();
            await journal.begin(intent);
          },
          authorize,
        );
      },
      { journal, intent },
    );
    signal.throwIfAborted();
    return this.projectSnapshot(request.spaceId, initial.actorId);
  }

  private async apply(
    state: Workbench,
    scope: Scope,
    command: MemberWorkbenchCommand['command'],
    signal: AbortSignal,
    begin: () => Promise<void>,
    reauthorize: () => Promise<void>,
  ): Promise<Workbench> {
    if (command.type === 'save-template') {
      const asset = await this.savedTemplate(state, scope, command, state.revision);
      const next = applyWorkbenchCommand(this.mergeCatalog(state, scope), {
        type: 'save-asset',
        asset,
      });
      await begin();
      return next;
    }
    if (command.type === 'create-project' || command.type === 'update-project') {
      const exists = state.projects.some((p) => p.id === command.project.id);
      if (command.type === 'create-project' && exists) fail('conflict', '项目标识已存在。');
      if (command.type === 'update-project') {
        if (!exists) fail('not-found', '项目不可用。');
        await this.project(scope, command.project.id);
      }
      this.validateProject(command.project, scope);
      // Validate the complete next Workbench before the first cross-domain write.
      const next = applyWorkbenchCommand(this.mergeCatalog(state, scope), {
        type: 'save-project',
        project: command.project,
      });
      if (command.type === 'create-project') {
        if (!this.options.writer()) fail('unavailable', '项目目录尚未接入写入。');
        const lookup = await scope.directory.spaceForProject(command.project.id);
        if (!lookup.ok && lookup.reason === 'unavailable')
          fail('unavailable', '项目目录暂不可用。');
        if (lookup.ok && lookup.spaceId !== scope.spaceId) fail('not-found', '项目不可用。');
      }
      await begin();
      if (command.type === 'create-project') {
        const writer = this.options.writer();
        if (!writer) fail('unavailable', '项目目录尚未接入写入。');
        signal.throwIfAborted();
        await reauthorize();
        const prior = await scope.directory.spaceForProject(command.project.id);
        if (!prior.ok && prior.reason === 'unavailable') fail('unavailable', '项目目录暂不可用。');
        if (prior.ok && prior.spaceId !== scope.spaceId) fail('conflict', '项目已有其他空间归属。');
        if (!prior.ok) {
          try {
            await writer.assignProjectSpace(command.project.id, scope.spaceId);
          } catch (error) {
            const recovered = await scope.directory.spaceForProject(command.project.id);
            if (!recovered.ok || recovered.spaceId !== scope.spaceId) throw error;
          }
        }
        await this.project(scope, command.project.id);
      }
      return next;
    }
    const isCreate = command.type === 'create-task' || command.type === 'instantiate-template';
    const taskId =
      command.type === 'confirm-task'
        ? command.taskId
        : command.type === 'instantiate-template'
          ? command.input.task.id
          : command.task.id;
    const previous = state.tasks.find((t) => t.id === taskId);
    if (isCreate && previous) fail('conflict', '任务标识已存在。');
    if (!isCreate) {
      this.task(state, scope, taskId, true);
      if (previous!.status !== 'draft') fail('confirmed-plan', '已确认计划不可直接修改。');
    }
    await this.project(
      scope,
      command.type === 'confirm-task'
        ? previous!.projectId
        : command.type === 'instantiate-template'
          ? command.input.task.projectId
          : command.task.projectId,
    );
    const task: WorkTask =
      command.type === 'confirm-task'
        ? {
            ...previous!,
            status: 'ready',
            updatedAt: (this.options.now ?? (() => new Date().toISOString()))(),
          }
        : (await this.commandTask(state, scope, command))!;
    if (previous && previous.projectId !== task.projectId)
      fail('validation', '任务不能通过编辑移动到其他项目。');
    this.validateTask(task, state, scope);
    // Only the original template command may introduce a source snapshot. Ordinary
    // save-task deliberately rejects a new or changed templateSource.
    const prepared =
      command.type === 'instantiate-template'
        ? await this.templateInput(state, scope, command)
        : undefined;
    const next = prepared
      ? applyWorkbenchCommand(prepared.state, {
          type: 'instantiate-template',
          input: prepared.input,
        })
      : applyWorkbenchCommand(this.catalogState(state, scope), { type: 'save-task', task });
    const merged = this.mergeCatalog(state, scope);
    const validated = WorkbenchSchema.parse({
      ...next,
      participants: merged.participants,
      assets: merged.assets,
    });
    await begin();
    return validated;
  }

  async plan(raw: unknown, signal: AbortSignal) {
    const { spaceId, ...request } = MemberWorkbenchPlanSchema.parse(raw);
    const initial = await this.scope(spaceId);
    const read = async () => {
      const scope = await this.scope(spaceId, initial.actorId);
      const state = this.workbench.snapshot();
      const task = this.task(state, scope, request.taskId, true);
      await this.project(scope, task.projectId);
      this.validateTask(task, state, scope);
      const fresh = await this.scope(spaceId, initial.actorId);
      this.validateTask(task, state, fresh);
      if (this.workbench.snapshot().revision !== state.revision)
        fail('conflict', '规划依据已经变化，请刷新后再试。');
      return this.catalogState(
        {
          ...state,
          projects: state.projects
            .filter((p) => p.id === task.projectId)
            .map((project) => ({
              ...project,
              defaultParticipantIds: (project.defaultParticipantIds ?? []).filter((id) =>
                fresh.participants.some((p) => p.id === id),
              ),
              assetIds: (project.assetIds ?? []).filter((id) =>
                fresh.catalog.assets.some((a) => a.id === id),
              ),
            })),
          tasks: [task],
          appliedPlans: state.appliedPlans.filter((p) => p.taskId === task.id),
          receipts: [],
        },
        fresh,
      );
    };
    await read();
    const model = this.options.model?.();
    if (!model) fail('model-unavailable', '请先配置可用模型。');
    const proposal = await this.workbench.plan(request, model, signal, {
      scopeKey: `${initial.actorId}/${spaceId}`,
      read,
    });
    await read();
    signal.throwIfAborted();
    return { actorId: initial.actorId, spaceId, proposal };
  }
}
