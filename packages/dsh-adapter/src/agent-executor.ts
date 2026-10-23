import type { ExecutionEngine, ExecutionFaultKind } from '@zhuma/agent-core';

/**
 * `verified` 表示这条原生路由在本进程里已经配好，不是评审签字。
 * 模拟执行器保持 false。缺配置的 DSH 也保持 false，并且不会改用模拟。
 */
export interface ExecutorCapabilities {
  readonly liveInjection: boolean;
  readonly sessionResume: boolean;
  readonly cancelReceipt: boolean;
  readonly streaming: boolean;
  readonly verified: boolean;
  readonly mode: 'simulated' | 'native';
}

export interface ResourceGrant {
  readonly kind: 'skill' | 'mcp' | 'attachment' | 'context';
  readonly id: string;
  readonly version: string;
  readonly toolsAuthorized: boolean;
}

/** 模拟执行器和 DSH 聊天执行器使用同一请求形状。码道仍未接入。 */
export interface AgentRunRequest {
  readonly runId: string;
  readonly attempt: number;
  readonly generation: number;
  readonly taskId: string;
  readonly nodeId: string;
  readonly workflowVersionId: string;
  readonly planRevision: number;
  readonly contextReferences: readonly string[];
  readonly expertVersionId: string;
  readonly resourceGrants: readonly ResourceGrant[];
  readonly instruction: string;
  readonly attachmentIds: readonly string[];
  readonly goal: string;
  /** 节点输入说明。非空时写入执行提示。 */
  readonly inputNote?: string;
  /** 节点交付说明。非空时写入执行提示。 */
  readonly expectedOutput?: string;
  readonly simulatedRequested: boolean;
  readonly signal: AbortSignal;
  readonly resumeSessionId?: string;
  readonly skills?: readonly {
    readonly id: string;
    readonly version: string;
    readonly label?: string;
    readonly description?: string;
    readonly body?: string;
  }[];
  readonly mcp?: readonly {
    readonly id: string;
    readonly version: string;
    readonly label?: string;
    readonly transport?: 'stdio' | 'streamable-http';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly url?: string;
  }[];
  readonly toolAllowlist?: readonly string[];
  readonly attachments?: readonly {
    readonly id: string;
    readonly name?: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
  readonly promptContext?: readonly { readonly id: string; readonly body: string }[];
}

export interface AgentActivity {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly simulated: boolean;
  readonly succeeded: boolean;
}

export interface AgentRunResult {
  readonly executorRunId: string;
  readonly simulated: boolean;
  readonly summary: string;
  readonly draftText: string;
  readonly sourceReferences: readonly string[];
  readonly verification: readonly {
    readonly id: string;
    readonly summary: string;
    readonly simulated: boolean;
  }[];
}

export type AgentRunEvent =
  | {
      readonly type: 'accepted';
      readonly executorRunId: string;
      readonly simulated: boolean;
      readonly sessionId?: string;
    }
  | { readonly type: 'delta'; readonly text: string; readonly simulated: boolean }
  | { readonly type: 'activity'; readonly activity: AgentActivity }
  | { readonly type: 'completed'; readonly result: AgentRunResult }
  | {
      readonly type: 'failed';
      readonly fault: ExecutionFaultKind;
      readonly message: string;
      readonly simulated: boolean;
      readonly droppedSessionId?: string;
    }
  | { readonly type: 'cancelled'; readonly simulated: boolean }
  | { readonly type: 'late-output'; readonly text: string; readonly simulated: boolean };

export interface CancelReceipt {
  readonly receipt: 'cancelled' | 'rejected' | 'unsupported';
  readonly reason?: string;
}

export interface AgentExecutor {
  readonly id: ExecutionEngine;
  readonly capabilities: ExecutorCapabilities;
  readonly unavailableReason?: string;
  run(request: AgentRunRequest): AsyncIterable<AgentRunEvent>;
  cancel(runId: string): Promise<CancelReceipt>;
}

export class ExecutorNotImplementedError extends Error {
  readonly code = 'executor-not-implemented';
  readonly verified = false;
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorNotImplementedError';
  }
}

const UNVERIFIED_NATIVE: ExecutorCapabilities = Object.freeze({
  liveInjection: false,
  sessionResume: false,
  cancelReceipt: false,
  streaming: false,
  verified: false,
  mode: 'native',
});

/** 占位。调用会失败，不会伪装成模拟执行或成功结果。 */
export class UnimplementedNativeExecutor implements AgentExecutor {
  readonly capabilities = UNVERIFIED_NATIVE;
  constructor(readonly id: 'dsh' | 'codearts-cli') {}

  async *run(): AsyncIterable<AgentRunEvent> {
    throw new ExecutorNotImplementedError(
      this.id === 'dsh'
        ? 'DSH 执行器尚未实现，也未验证。不会改用模拟执行器。'
        : '码道执行器尚未实现，也未验证。不会改用模拟执行器。',
    );
  }

  async cancel(): Promise<CancelReceipt> {
    return { receipt: 'unsupported', reason: '执行器尚未实现，不能伪造取消回执。' };
  }
}

export interface SimulatedExecutorOptions {
  readonly chunkDelayMs?: number;
  readonly pauseBeforeAccept?: boolean;
  readonly pauseAfterAccept?: boolean;
}

/**
 * 必须显式选择。回复、活动和结果都带模拟标识，不报告真实模型或工具成功。
 * 不支持实时注入；支持取消回执。取消后仍会交出一条迟到输出，供上层丢弃其推进效果。
 */
export class SimulatedAgentExecutor implements AgentExecutor {
  readonly id = 'simulated' as const;
  readonly capabilities: ExecutorCapabilities = Object.freeze({
    liveInjection: false,
    sessionResume: false,
    cancelReceipt: true,
    streaming: true,
    verified: false,
    mode: 'simulated',
  });

  private readonly known = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly earlyRelease = new Set<string>();
  private readonly gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  private readonly receipts = new Map<string, (receipt: CancelReceipt) => void>();

  constructor(private readonly options: SimulatedExecutorOptions = {}) {}

  release(runId: string): void {
    const gate = this.gates.get(runId);
    if (gate) {
      gate.release();
      return;
    }
    this.earlyRelease.add(runId);
  }

  private async waitGate(runId: string, enabled: boolean): Promise<void> {
    if (!enabled) return;
    if (this.earlyRelease.has(runId)) {
      this.earlyRelease.delete(runId);
      return;
    }
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(runId, { promise, release });
    await promise;
    this.gates.delete(runId);
  }

  async cancel(runId: string): Promise<CancelReceipt> {
    if (!this.known.has(runId)) {
      return { receipt: 'rejected', reason: '没有这次运行。' };
    }
    if (this.finished.has(runId)) {
      return { receipt: 'rejected', reason: '运行已经结束，迟到的停止不能改写结果。' };
    }
    this.cancelled.add(runId);
    this.release(runId);
    return new Promise((resolve) => {
      this.receipts.set(runId, resolve);
    });
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    this.known.add(request.runId);
    const finish = (receipt: CancelReceipt) => {
      this.finished.add(request.runId);
      const resolve = this.receipts.get(request.runId);
      if (resolve) {
        this.receipts.delete(request.runId);
        resolve(receipt);
      }
    };
    const aborted = () => request.signal.aborted || this.cancelled.has(request.runId);
    await delay(this.options.chunkDelayMs ?? 0);
    if (aborted()) {
      yield { type: 'cancelled', simulated: true };
      yield {
        type: 'late-output',
        text: '【模拟】取消后的迟到输出。它不能推进节点，也不能触发下游。',
        simulated: true,
      };
      finish({ receipt: 'cancelled' });
      return;
    }
    await this.waitGate(request.runId, this.options.pauseBeforeAccept === true);
    const executorRunId = `sim-${request.runId}`;
    yield { type: 'accepted', executorRunId, simulated: true };
    await this.waitGate(request.runId, this.options.pauseAfterAccept === true);
    if (aborted()) {
      yield { type: 'cancelled', simulated: true };
      yield {
        type: 'late-output',
        text: '【模拟】取消后的迟到输出。它不能推进节点，也不能触发下游。',
        simulated: true,
      };
      finish({ receipt: 'cancelled' });
      return;
    }
    const text = simulatedReply(request);
    const size = 28;
    for (let index = 0; index < text.length; index += size) {
      if ((this.options.chunkDelayMs ?? 0) > 0) await delay(this.options.chunkDelayMs ?? 0);
      if (aborted()) {
        yield { type: 'cancelled', simulated: true };
        yield {
          type: 'late-output',
          text: '【模拟】取消后的迟到输出。它不能推进节点，也不能触发下游。',
          simulated: true,
        };
        finish({ receipt: 'cancelled' });
        return;
      }
      yield { type: 'delta', text: text.slice(index, index + size), simulated: true };
    }
    yield {
      type: 'activity',
      activity: {
        id: `act-${request.runId}`,
        title: '模拟执行器',
        detail: '没有调用真实模型，也没有真实工具调用成功。',
        simulated: true,
        succeeded: false,
      },
    };
    yield {
      type: 'completed',
      result: {
        executorRunId,
        simulated: true,
        summary: '【模拟】本轮结束。这不是节点交付，也没有真实验证证据。',
        draftText: text,
        sourceReferences: [...request.contextReferences],
        verification: [
          {
            id: `ver-${request.runId}`,
            summary: '模拟执行器不能提供真实验证证据',
            simulated: true,
          },
        ],
      },
    };
    finish({ receipt: 'rejected', reason: '运行已按模拟结果结束，没有待确认的取消。' });
  }
}

export interface DshModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
}

export type DshModelConfigResult =
  | { readonly ok: true; readonly config: DshModelConfig }
  | { readonly ok: false; readonly reason: string };

/** 只读环境变量。缺哪一项就在原因里点名，不写出地址和密钥。 */
export function readDshModelConfig(env: NodeJS.ProcessEnv = process.env): DshModelConfigResult {
  const baseUrl = env.ZHUMA_MODEL_BASE_URL?.trim() ?? '';
  const apiKey = env.ZHUMA_MODEL_API_KEY?.trim() ?? '';
  const modelId = env.ZHUMA_MODEL_ID?.trim() ?? '';
  const missing: string[] = [];
  if (baseUrl.length === 0) missing.push('ZHUMA_MODEL_BASE_URL');
  if (apiKey.length === 0) missing.push('ZHUMA_MODEL_API_KEY');
  if (modelId.length === 0) missing.push('ZHUMA_MODEL_ID');
  if (missing.length > 0) {
    return { ok: false, reason: `缺少 ${missing.join('、')}。不会改用模拟执行器。` };
  }
  return { ok: true, config: { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, modelId } };
}

export function selectAgentExecutor(
  id: ExecutionEngine,
  executors: readonly AgentExecutor[],
): AgentExecutor {
  const matches = executors.filter((executor) => executor.id === id);
  if (matches.length === 0) {
    throw new Error(`执行器未配置：${id}。不会静默改用模拟执行器。`);
  }
  if (matches.length !== 1) throw new Error(`执行器重复注册：${id}`);
  const executor = matches[0];
  if (!executor) throw new Error(`执行器未配置：${id}。不会静默改用模拟执行器。`);
  return executor;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 节点目标、输入说明、交付说明和本轮要求。空的说明不写入。 */
export function taskPrompt(
  request: Pick<AgentRunRequest, 'goal' | 'instruction' | 'inputNote' | 'expectedOutput'>,
): string {
  const parts = [`节点目标：${request.goal}`];
  const inputNote = request.inputNote?.trim() ?? '';
  const expectedOutput = request.expectedOutput?.trim() ?? '';
  if (inputNote.length > 0) parts.push(`输入说明：${inputNote}`);
  if (expectedOutput.length > 0) parts.push(`交付说明：${expectedOutput}`);
  parts.push(`本轮要求：${request.instruction}`);
  return parts.join('\n');
}

function simulatedReply(request: AgentRunRequest): string {
  const attachments =
    request.attachmentIds.length === 0 ? '无' : `${request.attachmentIds.length} 个`;
  const context =
    request.contextReferences.length === 0 ? '无' : `${request.contextReferences.length} 项`;
  return [
    '【模拟】这是模拟执行器的回复，不是模型输出。',
    '没有调用真实模型，也没有真实工具调用成功。',
    taskPrompt(request),
    `附件：${attachments}`,
    `上下文：${context}`,
    '可编辑草稿：',
    `（模拟草稿）${request.instruction}`,
  ].join('\n');
}
