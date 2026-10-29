import { WorkbenchError, WorkTaskSchema, type WorkTask } from '@zhuma/agent-core';
import type { WorkbenchApi } from './api.js';
import type {
  MemberWorkbenchApi,
  MemberWorkbenchCommand,
  MemberWorkbenchSnapshot,
  MemberTaskInput,
} from './member-api.js';

const inputSchema = WorkTaskSchema.omit({ status: true, updatedAt: true, templateSource: true });
function taskInput(task: WorkTask): MemberTaskInput {
  const {
    status: _status,
    updatedAt: _updatedAt,
    templateSource: _templateSource,
    ...input
  } = task;
  return inputSchema.parse(input);
}
function unsupported(): never {
  throw new WorkbenchError('unsupported', '此空间暂未接入这项定义管理操作。');
}

/** Reuse the editor without reopening owner RPC or inferring create/update intent from a stale cache. */
export function createMemberWorkbenchAdapter(
  api: MemberWorkbenchApi,
  actorId: string,
): WorkbenchApi {
  let latest: MemberWorkbenchSnapshot | undefined;
  function accept(value: MemberWorkbenchSnapshot) {
    latest = value;
    return value.state;
  }
  return {
    member: { actorId, capabilities: () => latest?.capabilities },
    async snapshot(signal) {
      const value = await api.snapshot(signal);
      return { state: accept(value), model: value.model ?? '未配置模型' };
    },
    async save(expectedRevision, command, requestId, intent) {
      let mapped: MemberWorkbenchCommand;
      if (
        command.type === 'save-project' &&
        (intent === 'create-project' || intent === 'update-project')
      ) {
        mapped = { type: intent, project: command.project };
      } else if (
        command.type === 'save-task' &&
        (intent === 'create-task' || intent === 'update-task')
      ) {
        if (command.task.status !== 'draft')
          throw new WorkbenchError('validation', '请通过确认操作应用工作流。');
        mapped = { type: intent, task: taskInput(command.task) };
      } else if (command.type === 'save-task' && intent === 'confirm-task') {
        const saved = latest?.state.tasks.find((task) => task.id === command.task.id);
        if (!saved || JSON.stringify(taskInput(saved)) !== JSON.stringify(taskInput(command.task)))
          throw new WorkbenchError('draft-not-saved', '请先保存修改，再确认工作流。');
        mapped = { type: 'confirm-task', taskId: saved.id };
      } else if (command.type === 'instantiate-template' && intent === 'create-task') {
        const { updatedAt: _updatedAt, ...task } = command.input.task;
        mapped = { type: 'instantiate-template', input: { ...command.input, task } };
      } else unsupported();
      return accept(await api.command({ expectedRevision, requestId, command: mapped }));
    },
    async saveTemplate(expectedRevision, input, requestId) {
      return accept(
        await api.command({
          expectedRevision,
          requestId,
          command: { type: 'save-template', input },
        }),
      );
    },
    async plan(taskId, expectedRevision, instruction, signal, baseProposalId, adjustment) {
      const value = await api.plan(
        {
          requestId: crypto.randomUUID(),
          taskId,
          expectedRevision,
          instruction,
          baseProposalId,
          adjustment,
        },
        signal,
      );
      return value.proposal;
    },
    async previewImport() {
      return unsupported();
    },
    async resourceFiles() {
      return unsupported();
    },
  };
}
