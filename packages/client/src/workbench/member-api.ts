import {
  CommandRequestSchema,
  PlanProposalSchema,
  PlanRequestSchema,
  ProjectSchema,
  WorkTaskSchema,
  WorkbenchError,
  WorkbenchSchema,
  type PlanProposal,
  type PlanRequest,
  type Project,
  type WorkTask,
  type Workbench,
} from '@zhuma/agent-core';
import { createIdentityApi, IdentityApiError, type MemberSpace } from '../identity/api.js';

export type MemberTaskInput = Omit<WorkTask, 'status' | 'updatedAt' | 'templateSource'>;
export interface MemberTemplateSaveInput {
  readonly templateId: string;
  readonly sourceTaskId: string;
  readonly sourceSpaceId?: string | undefined;
  readonly name: string;
  readonly description: string;
}
export type MemberWorkbenchCommand =
  | { readonly type: 'create-project' | 'update-project'; readonly project: Project }
  | { readonly type: 'create-task' | 'update-task'; readonly task: MemberTaskInput }
  | { readonly type: 'confirm-task'; readonly taskId: string }
  | {
      readonly type: 'instantiate-template';
      readonly input: {
        readonly templateId: string;
        readonly sourceSpaceId?: string | undefined;
        readonly task: Omit<MemberTaskInput, 'workflows'>;
        readonly roleBindings: Record<string, string | null>;
        readonly resourceBindings: Record<string, string | null>;
      };
    }
  | { readonly type: 'save-template'; readonly input: MemberTemplateSaveInput };
export interface MemberWorkbenchCommandInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly command: MemberWorkbenchCommand;
}
export interface MemberWorkbenchSnapshot {
  readonly actorId: string;
  readonly spaceId: string;
  readonly space: MemberSpace;
  readonly state: Workbench;
  readonly model: string | null;
  readonly capabilities: {
    readonly createProject: boolean;
    readonly createTask: boolean;
    readonly planning: boolean;
    readonly resources: 'not-connected' | 'authorized';
    readonly tasks: readonly {
      readonly taskId: string;
      readonly edit: boolean;
      readonly confirm: boolean;
      readonly plan: boolean;
    }[];
  };
}
export interface MemberWorkbenchPlanValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly proposal: PlanProposal;
}
export interface MemberWorkbenchApi {
  snapshot(signal?: AbortSignal): Promise<MemberWorkbenchSnapshot>;
  command(
    input: MemberWorkbenchCommandInput,
    signal?: AbortSignal,
  ): Promise<MemberWorkbenchSnapshot>;
  plan(input: PlanRequest, signal?: AbortSignal): Promise<MemberWorkbenchPlanValue>;
}
export interface MemberWorkbenchScope {
  readonly actorId: string;
  readonly spaceId: string;
  isCurrent(): boolean;
  onUnauthenticated(): void;
  onUnavailable(): void;
}

const taskInputSchema = WorkTaskSchema.omit({
  status: true,
  updatedAt: true,
  templateSource: true,
});
const unavailable = () => new WorkbenchError('unavailable', '工作台暂不可用，请重试。');
function invalid(): never {
  throw new WorkbenchError('invalid-response', '工作台返回的数据不完整，请重新读取。');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key))) invalid();
  return item;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) invalid();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function identifier(value: unknown): string {
  return ProjectSchema.shape.id.parse(value);
}
function uuid(value: unknown): string {
  const id = text(value);
  if (
    !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu.test(
      id,
    )
  )
    throw new Error('invalid UUID');
  return id;
}
function bindings(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      identifier(key),
      entry === null ? null : identifier(entry),
    ]),
  );
}
function commandInput(input: MemberWorkbenchCommandInput): MemberWorkbenchCommandInput {
  try {
    const request = record(input, ['requestId', 'expectedRevision', 'command']);
    const command = record(request.command, ['type', 'project', 'task', 'taskId', 'input']);
    let parsed: MemberWorkbenchCommand;
    switch (command.type) {
      case 'create-project':
      case 'update-project':
        record(command, ['type', 'project']);
        parsed = { type: command.type, project: ProjectSchema.parse(command.project) };
        break;
      case 'create-task':
      case 'update-task':
        record(command, ['type', 'task']);
        parsed = { type: command.type, task: taskInputSchema.parse(command.task) };
        break;
      case 'confirm-task': {
        record(command, ['type', 'taskId']);
        const taskId = text(command.taskId);
        if (!/^[\w-]{1,100}$/u.test(taskId)) throw new Error('invalid task');
        parsed = { type: 'confirm-task', taskId };
        break;
      }
      case 'instantiate-template': {
        record(command, ['type', 'input']);
        const source = record(command.input, [
          'templateId',
          'sourceSpaceId',
          'task',
          'roleBindings',
          'resourceBindings',
        ]);
        const task = taskInputSchema.omit({ workflows: true }).parse(source.task);
        uuid(task.id);
        parsed = {
          type: command.type,
          input: {
            templateId: identifier(source.templateId),
            ...(source.sourceSpaceId === undefined
              ? {}
              : { sourceSpaceId: identifier(source.sourceSpaceId) }),
            task,
            roleBindings: bindings(source.roleBindings),
            resourceBindings: bindings(source.resourceBindings),
          },
        };
        break;
      }
      case 'save-template': {
        record(command, ['type', 'input']);
        const source = record(command.input, [
          'templateId',
          'sourceTaskId',
          'sourceSpaceId',
          'name',
          'description',
        ]);
        const name = text(source.name).trim();
        if (
          name.length > 160 ||
          typeof source.description !== 'string' ||
          source.description.length > 8000
        )
          throw new Error('invalid template metadata');
        parsed = {
          type: command.type,
          input: {
            templateId: uuid(source.templateId),
            sourceTaskId: identifier(source.sourceTaskId),
            ...(source.sourceSpaceId === undefined
              ? {}
              : { sourceSpaceId: identifier(source.sourceSpaceId) }),
            name,
            description: source.description,
          },
        };
        break;
      }
      default:
        throw new Error('unsupported command');
    }
    return {
      requestId: CommandRequestSchema.shape.requestId.parse(request.requestId),
      expectedRevision: CommandRequestSchema.shape.expectedRevision.parse(request.expectedRevision),
      command: parsed,
    };
  } catch {
    throw new WorkbenchError('validation', '提交的数据格式不正确。');
  }
}

/** Member-only HTTP: explicit scope, fresh identity, exact RPC envelope and no owner fallback. */
export function createMemberWorkbenchApi(
  scope: MemberWorkbenchScope,
  fetcher: typeof fetch = globalThis.fetch,
): MemberWorkbenchApi {
  const { actorId, spaceId } = scope;
  if (!actorId.trim() || !/^[\w-]{1,100}$/u.test(spaceId))
    throw new WorkbenchError('validation', '工作台必须绑定当前账号和空间。');
  const identity = createIdentityApi(fetcher);
  function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!scope.isCurrent()) throw new DOMException('Workbench view changed', 'AbortError');
  }
  function staleActor(): never {
    scope.onUnauthenticated();
    throw new WorkbenchError('unauthenticated', '账号已发生变化，请重新登录。');
  }
  function staleSpace(): never {
    scope.onUnavailable();
    throw new WorkbenchError('space-unavailable', '此空间已不可访问，请重新选择。');
  }
  async function inspect(signal: AbortSignal) {
    current(signal);
    try {
      const session = await identity.session(signal);
      current(signal);
      if (session.accountId !== actorId) staleActor();
      if (!session.spaces.some((space) => space.id === spaceId)) staleSpace();
    } catch (error) {
      current(signal);
      if (error instanceof WorkbenchError) throw error;
      if (
        error instanceof IdentityApiError &&
        ['unauthenticated', 'member-session-required', 'session-changed'].includes(error.code)
      )
        staleActor();
      throw new WorkbenchError('scope-unavailable', '暂时无法确认空间权限，请重试。');
    }
  }
  function scoped(value: unknown, keys: readonly string[]) {
    const item = record(value, ['actorId', 'spaceId', ...keys]);
    if (item.actorId !== actorId) staleActor();
    if (item.spaceId !== spaceId) staleSpace();
    return item;
  }
  function snapshot(value: unknown): MemberWorkbenchSnapshot {
    const item = scoped(value, ['space', 'state', 'model', 'capabilities']);
    const space = record(item.space, ['id', 'kind', 'name']);
    if (space.id !== spaceId) staleSpace();
    if (space.kind !== 'personal' && space.kind !== 'team') invalid();
    const parsed = WorkbenchSchema.safeParse(item.state);
    if (
      !parsed.success ||
      parsed.data.receipts.length ||
      (item.model !== null && typeof item.model !== 'string')
    )
      invalid();
    const capabilities = record(item.capabilities, [
      'createProject',
      'createTask',
      'planning',
      'resources',
      'tasks',
    ]);
    if (
      !['not-connected', 'authorized'].includes(String(capabilities.resources)) ||
      !Array.isArray(capabilities.tasks)
    )
      invalid();
    const tasks = new Set(parsed.data.tasks.map((task) => task.id));
    const seen = new Set<string>();
    const taskCapabilities = capabilities.tasks.map((raw) => {
      const task = record(raw, ['taskId', 'edit', 'confirm', 'plan']);
      const taskId = text(task.taskId);
      if (!tasks.has(taskId) || seen.has(taskId)) invalid();
      seen.add(taskId);
      return { taskId, edit: bool(task.edit), confirm: bool(task.confirm), plan: bool(task.plan) };
    });
    if (seen.size !== tasks.size) invalid();
    if (
      capabilities.resources === 'not-connected' &&
      (parsed.data.assets.length || parsed.data.participants.some((p) => p.kind === 'expert'))
    )
      invalid();
    return {
      actorId,
      spaceId,
      space: { id: spaceId, kind: space.kind, name: text(space.name) },
      state: parsed.data,
      model: item.model,
      capabilities: {
        createProject: bool(capabilities.createProject),
        createTask: bool(capabilities.createTask),
        planning: bool(capabilities.planning),
        resources: capabilities.resources as 'not-connected' | 'authorized',
        tasks: taskCapabilities,
      },
    };
  }
  async function call(
    endpoint: 'snapshot' | 'command' | 'plan',
    payload: object,
    caller?: AbortSignal,
  ): Promise<unknown> {
    // The Host's whole-operation deadline is 120s, including real model planning.
    const deadline = AbortSignal.timeout(125_000);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    try {
      await inspect(signal);
      current(signal);
      const rpcId = crypto.randomUUID();
      const response = await fetcher(`/api/zhuma-member/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `zhuma-member/${endpoint}`,
          payload,
        }),
        signal,
      });
      current(signal);
      if (response.status === 401) staleActor();
      if (!response.ok)
        throw response.status === 403
          ? new WorkbenchError('untrusted-request', '当前入口无法处理请求，请重新打开工作台。')
          : unavailable();
      const raw: unknown = await response.json();
      current(signal);
      const envelope = record(raw, ['type', 'rpcId', 'result']);
      if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) invalid();
      const result = record(envelope.result, ['ok', 'value', 'error']);
      if (result.ok === true && 'value' in result && !('error' in result)) return result.value;
      if (result.ok !== false || !('error' in result) || 'value' in result) invalid();
      const error = record(result.error, ['code', 'message']);
      const code = text(error.code);
      if (code === 'unauthenticated') staleActor();
      if (endpoint === 'snapshot' && code === 'not-found') staleSpace();
      throw new WorkbenchError(code, text(error.message));
    } catch (error) {
      current(signal);
      if (error instanceof WorkbenchError) throw error;
      throw unavailable();
    }
  }
  return {
    async snapshot(signal) {
      return snapshot(await call('snapshot', { spaceId }, signal));
    },
    async command(input, signal) {
      const parsed = commandInput(input);
      return snapshot(await call('command', { spaceId, ...parsed }, signal));
    },
    async plan(input, signal) {
      const parsed = PlanRequestSchema.safeParse(input);
      if (!parsed.success) throw new WorkbenchError('validation', '规划请求格式不正确。');
      const value = scoped(await call('plan', { spaceId, ...parsed.data }, signal), ['proposal']);
      const proposal = PlanProposalSchema.safeParse(value.proposal);
      if (
        !proposal.success ||
        proposal.data.taskId !== parsed.data.taskId ||
        proposal.data.baseRevision !== parsed.data.expectedRevision
      )
        invalid();
      return { actorId, spaceId, proposal: proposal.data };
    },
  };
}
