import { createHash } from 'node:crypto';
import {
  applyWorkbenchCommand,
  CommandRequestSchema,
  PlanRequestSchema,
  WorkbenchError,
  planningPrompt,
  parsePlanningResult,
  type Workbench,
  type PlanProposal,
} from '@zhuma/agent-core';

export interface WorkbenchStorage {
  read(): Workbench;
  write(state: Workbench): Promise<void>;
}
export interface PlanningAudit {
  id: string;
  fingerprint: string;
  taskId: string;
  baseRevision: number;
  model: string;
  system: string;
  attempts: { input: string; output: string }[];
  status: 'started' | 'completed' | 'failed';
  proposal?: PlanProposal | undefined;
}
export interface PlanningAuditStorage {
  get(id: string): PlanningAudit | undefined;
  put(audit: PlanningAudit): Promise<void>;
}
export interface PlanningModel {
  readonly name: string;
  generate(system: string, input: string, signal: AbortSignal): Promise<string>;
}
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host owner of serialized durable commands. Browser state is never authoritative. */
export class WorkbenchService {
  private writes: Promise<unknown> = Promise.resolve();
  private planning = false;
  constructor(
    private readonly storage: WorkbenchStorage,
    private readonly audits: PlanningAuditStorage,
  ) {}
  snapshot(): Workbench {
    return structuredClone(this.storage.read());
  }

  command(raw: unknown, signal: AbortSignal): Promise<Workbench> {
    const request = CommandRequestSchema.parse(raw);
    const operation = this.writes.then(async () => {
      signal.throwIfAborted();
      const state = this.storage.read();
      const hash = fingerprint(request.command);
      const receipt = state.receipts.find((r) => r.id === request.requestId);
      if (receipt) {
        if (receipt.fingerprint !== hash)
          throw new WorkbenchError('request-reused', '请求标识已用于另一个操作。');
        return this.snapshot();
      }
      if (state.revision !== request.expectedRevision)
        throw new WorkbenchError('conflict', '内容已被其他窗口修改。请先刷新，再应用你的更改。');
      const next = applyWorkbenchCommand(state, request.command);
      next.receipts = [
        ...state.receipts,
        { id: request.requestId, fingerprint: hash, revision: next.revision },
      ].slice(-200);
      // Once durability starts cancellation cannot roll back a successful write; retry with the same ID.
      await this.storage.write(next);
      return structuredClone(next);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async plan(raw: unknown, model: PlanningModel, signal: AbortSignal): Promise<PlanProposal> {
    const request = PlanRequestSchema.parse(raw);
    const previous = this.audits.get(request.requestId);
    const hash = fingerprint(request);
    if (previous) {
      if (previous.fingerprint !== hash)
        throw new WorkbenchError('request-reused', '请求标识已用于另一次规划。');
      if (previous.proposal) return structuredClone(previous.proposal);
      throw new WorkbenchError('plan-interrupted', '这次规划未完成，请重新发起规划。');
    }
    if (this.planning)
      throw new WorkbenchError('planning-busy', '已有规划正在生成，请等待或取消后重试。');
    const state = this.snapshot();
    if (request.expectedRevision !== state.revision)
      throw new WorkbenchError('conflict', '规划依据已经变化，请刷新后再试。');
    const task = state.tasks.find((t) => t.id === request.taskId);
    if (!task) throw new WorkbenchError('not-found', '任务不存在。');
    if (task.status !== 'draft')
      throw new WorkbenchError('not-draft', '请先将工作流切回草稿，再重新规划。');
    const prompt = planningPrompt(state, task, request.instruction);
    const audit: PlanningAudit = {
      id: request.requestId,
      fingerprint: hash,
      taskId: task.id,
      baseRevision: state.revision,
      model: model.name,
      system: prompt.system,
      attempts: [],
      status: 'started',
    };
    this.planning = true;
    try {
      let input = prompt.input;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        audit.attempts.push({ input, output: '' });
        await this.audits.put(structuredClone(audit));
        const output = await model.generate(prompt.system, input, signal);
        signal.throwIfAborted();
        audit.attempts[attempt]!.output = output;
        await this.audits.put(structuredClone(audit));
        try {
          const result = parsePlanningResult(output, state, task);
          const proposal: PlanProposal = {
            id: request.requestId,
            taskId: task.id,
            baseRevision: state.revision,
            model: model.name,
            result,
          };
          audit.status = 'completed';
          audit.proposal = proposal;
          await this.audits.put(structuredClone(audit));
          return proposal;
        } catch (error) {
          if (!(error instanceof WorkbenchError) || error.code !== 'invalid-plan' || attempt === 1)
            throw error;
          input = JSON.stringify({
            original: prompt.input,
            rejectedOutput: output,
            validationErrors: error.message,
            instruction: '修复上述校验问题，只返回完整 JSON 对象。',
          });
        }
      }
      throw new WorkbenchError('invalid-plan', '规划没有产生有效草案。');
    } catch (error) {
      audit.status = 'failed';
      await this.audits.put(structuredClone(audit));
      throw error;
    } finally {
      this.planning = false;
    }
  }
}
