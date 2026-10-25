import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  applyWorkbenchCommand,
  AssetSchema,
  ParticipantSchema,
  WorkbenchError,
  WorkbenchSchema,
  validateWorkTask,
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
    const catalog = catalogData.data;
    // The catalog itself is trusted injection; references and collisions still fail closed.
    const allIds = [...members.map((m) => m.id), ...catalog.experts.map((p) => p.id)];
    if (
      new Set(allIds).size !== allIds.length ||
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
    // A catalog read may yield; revocation during that read must suppress both content and writes.
    const current = await this.options.resolve();
    if (!current.ok || current.memberId !== member.memberId)
      fail('unauthenticated', '当前登录身份已经变化。');
    if (!current.spaceIds.includes(spaceId) || !directory.isMember(spaceId, current.memberId))
      fail('not-found', '空间不可用。');
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

  private validateTask(task: WorkTask, state: Workbench, scope: Scope): void {
    if (!task.ownerId || !task.participantIds.includes(scope.actorId))
      fail('validation', '请选择负责人，并将当前成员加入任务。');
    if (
      task.participantIds.some((id) => !scope.participants.some((p) => p.id === id && p.available))
    )
      fail('resource-unavailable', '任务参与者不在当前授权目录中。');
    for (const node of task.workflows.flatMap((w) => w.nodes)) {
      for (const [ids, kind] of [
        [node.skillIds, 'skill'],
        [node.mcpIds, 'mcp'],
      ] as const)
        if (
          ids.some(
            (id) =>
              !scope.catalog.assets.some((a) => a.id === id && a.kind === kind && a.available),
          )
        )
          fail('resource-unavailable', '工作节点引用的资源不可用。');
    }
    const errors = validateWorkTask(task, this.catalogState(state, scope), { requireOwner: true });
    if (errors.length) fail('validation', errors.join('\n'));
  }

  private validateProject(project: Project, scope: Scope): void {
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
    return structuredClone({
      actorId: scope.actorId,
      spaceId,
      space,
      state: {
        ...state,
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
    const intent: MemberWorkbenchIntent = {
      actorId: initial.actorId,
      spaceId: request.spaceId,
      requestId: request.requestId,
      objectId:
        command.type === 'confirm-task'
          ? command.taskId
          : command.type === 'create-project' || command.type === 'update-project'
            ? command.project.id
            : command.task.id,
      commandType: command.type,
      expectedRevision: request.expectedRevision,
      fingerprint: digest([initial.actorId, request]),
    };
    const authorize = async () => {
      const scope = await this.scope(request.spaceId, initial.actorId);
      const state = this.workbench.snapshot();
      const command = request.command;
      if (command.type === 'create-project' || command.type === 'update-project') {
        this.validateProject(command.project, scope);
        if (state.projects.some((p) => p.id === command.project.id))
          await this.project(scope, command.project.id);
      } else {
        const taskId = command.type === 'confirm-task' ? command.taskId : command.task.id;
        const existing = state.tasks.find((t) => t.id === taskId);
        if (existing) {
          this.task(state, scope, taskId, command.type !== 'create-task');
          await this.project(scope, existing.projectId);
        }
        if (command.type !== 'confirm-task') {
          await this.project(scope, command.task.projectId);
          this.validateTask(
            { ...command.task, status: 'draft', updatedAt: new Date().toISOString() },
            state,
            scope,
          );
        } else if (existing) this.validateTask(existing, state, scope);
      }
      const fresh = await this.scope(request.spaceId, initial.actorId);
      if (command.type === 'create-project' || command.type === 'update-project')
        this.validateProject(command.project, fresh);
      else {
        const task =
          command.type === 'confirm-task'
            ? state.tasks.find((t) => t.id === command.taskId)
            : { ...command.task, status: 'draft' as const, updatedAt: new Date().toISOString() };
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
        const scope = await this.scope(request.spaceId, initial.actorId);
        return this.apply(state, scope, request.command, signal, async () => {
          signal.throwIfAborted();
          await authorize();
          await journal.begin(intent);
        });
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
  ): Promise<Workbench> {
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
        await this.scope(scope.spaceId, scope.actorId);
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
    const isCreate = command.type === 'create-task';
    const taskId = command.type === 'confirm-task' ? command.taskId : command.task.id;
    const previous = state.tasks.find((t) => t.id === taskId);
    if (isCreate && previous) fail('conflict', '任务标识已存在。');
    if (!isCreate) {
      this.task(state, scope, taskId, true);
      if (previous!.status !== 'draft') fail('confirmed-plan', '已确认计划不可直接修改。');
    }
    const task: WorkTask =
      command.type === 'confirm-task'
        ? {
            ...previous!,
            status: 'ready',
            updatedAt: (this.options.now ?? (() => new Date().toISOString()))(),
          }
        : {
            ...command.task,
            status: 'draft',
            updatedAt: (this.options.now ?? (() => new Date().toISOString()))(),
          };
    if (previous && previous.projectId !== task.projectId)
      fail('validation', '任务不能通过编辑移动到其他项目。');
    await this.project(scope, task.projectId);
    this.validateTask(task, state, scope);
    const next = applyWorkbenchCommand(this.catalogState(state, scope), {
      type: 'save-task',
      task,
    });
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
