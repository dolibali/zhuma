import {
  conversationLines,
  readConversationFrame,
  readNativeInbox,
  readNativeTurnEnd,
} from './conversation.js';
import { createIdentityApi } from '../identity/api.js';
import { createMemberWorkbenchApi } from '../workbench/member-api.js';
import { ExecutionError } from '../execution/ExecutionApi.js';
import type { MemberExecutionScope } from '../execution/http.js';
import { createWorkflowApi, type WorkflowApi } from '../workflow/api.js';
import type { LocalWorkspaceDirectory } from './workspace-directory.js';
import type { NativeReviewApi } from './review-api.js';
import { workspacePublishRanges, type WorkspacePublishRange } from './workspace-approvals.js';
import {
  createWorkspaceApprovalApi,
  type RegisterWorkspaceDirectory,
  type WorkspaceApprovalApi,
} from './workspace-approvals.js';
import type {
  NativeRunAction,
  NativeRunExpertChoice,
  NativeRunModelChoice,
  NativeRunPanelView,
  NativeRunResource,
  NativeRunSelection,
  NativeRunSendMode,
  NativeRunSummary,
  NativeRunTarget,
  NativeRunMessage,
  NativeRunInbox,
  NativeRunResultDelivery,
  NativeConversationFrame,
  NativeRunWorkspaceChoice,
} from './native-run-contract.js';

export type NativeRunLocator = Pick<NativeRunTarget, 'taskId' | 'planId' | 'revision' | 'nodeId'>;
export type NativeRunOptions = {
  target: NativeRunLocator & { spaceId: string };
  nodeVersion: number;
  runVersion: number;
  currentRunId: string | null;
  selection: NativeRunSelection | null;
  models: Extract<NativeRunPanelView, { kind: 'ready' }>['models'];
  experts: readonly NativeRunExpertChoice[];
  resources: readonly NativeRunResource[];
  start: NativeRunAction & { mode?: 'begin' | 'retry' | 'restart' };
  tools: 'text-only' | 'accepted-input-reader';
  workspaces?: readonly NativeRunWorkspaceChoice[];
  workspaceApprovalScope?: { readonly spaceId: string; readonly projectId: string };
  knowledgeLibraries?: Extract<NativeRunPanelView, { kind: 'ready' }>['knowledgeLibraries'];
};
export type NativeRunRead = NativeRunSummary & {
  sendCapabilities: Readonly<Record<NativeRunSendMode, NativeRunAction>>;
};
export type NativeRunBegin = NativeRunLocator & {
  spaceId: string;
  requestId: string;
  newRunId: string;
  newSegmentId: string;
  expectedNodeVersion: number;
  expectedRunVersion: number;
  mode: 'begin' | 'retry' | 'restart';
  model: NativeRunSelection['model'];
  knowledge?: NativeRunSelection['knowledge'];
  executor: NativeRunSelection['executor'];
  tools: 'text-only' | 'accepted-input-reader' | 'local-tools';
  workspace:
    | { kind: 'text-only' }
    | { kind: 'local'; id: string; publish?: readonly WorkspacePublishRange[] };
};
export interface NativeRunApi {
  readonly review?: NativeReviewApi;
  openNativeSession?: ((run: NativeRunSummary, signal: AbortSignal) => Promise<void>) | undefined;
  readonly workflow?: WorkflowApi;
  readonly workspaceApprovals?: WorkspaceApprovalApi;
  readonly openModelSettings?: (() => void) | undefined;
  inbox?(run: NativeRunSummary, signal: AbortSignal): Promise<NativeRunInbox>;
  observe?(
    run: NativeRunSummary,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<NativeConversationFrame>;
  options(target: NativeRunLocator, signal: AbortSignal): Promise<NativeRunOptions>;
  read(target: NativeRunLocator, runId: string, signal: AbortSignal): Promise<NativeRunRead>;
  history(
    target: NativeRunLocator,
    runId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<{
    messages: readonly NativeRunMessage[];
    nextAfter: number;
    turnEnd?: Extract<NativeConversationFrame, { type: 'turn-end' }>;
  }>;
  begin(input: NativeRunBegin, signal: AbortSignal): Promise<void>;
  send(
    run: NativeRunSummary,
    text: string,
    mode: NativeRunSendMode,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void>;
  stop(run: NativeRunSummary, requestId: string, signal: AbortSignal): Promise<void>;
}
const invalid = (): never => {
  throw new ExecutionError('validation', 'Agent 服务返回的数据不完整，请刷新。');
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function string(value: unknown, max = 200): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
}
function integer(value: unknown, min = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
    ? value
    : invalid();
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : invalid();
}
function array(value: unknown, max = 256): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
function model(value: unknown): NativeRunSelection['model'] {
  const row = object(value);
  const maxTokens = integer(row.maxTokens, 1);
  if (maxTokens > 65_536) invalid();
  return {
    provider: string(row.provider),
    model: string(row.model),
    maxTokens,
    ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: string(row.reasoningEffort) }),
  };
}
function executor(value: unknown): NativeRunSelection['executor'] {
  const row = object(value);
  if (row.kind === 'builtin') return { kind: 'builtin' };
  if (row.kind !== 'plan-expert') invalid();
  const ref = object(row.ref);
  return { kind: 'plan-expert', ref: { id: string(ref.id), version: string(ref.version) } };
}
function selection(value: unknown): NativeRunSelection {
  const row = object(value);
  return {
    model: model(row.model),
    executor: executor(row.executor),
    ...(row.knowledge === undefined ? {} : { knowledge: knowledge(row.knowledge) }),
    ...(row.workspace === undefined
      ? {}
      : {
          workspace:
            object(row.workspace).kind === 'unavailable'
              ? { kind: 'unavailable' as const }
              : workspace(row.workspace),
        }),
  };
}
function knowledge(value: unknown): NonNullable<NativeRunSelection['knowledge']> {
  const row = object(value);
  return { libraryId: string(row.libraryId, 100), allowDrafts: boolean(row.allowDrafts) };
}
function workspace(value: unknown): NativeRunBegin['workspace'] {
  const row = object(value);
  return row.kind === 'text-only'
    ? { kind: 'text-only' }
    : row.kind === 'local'
      ? {
          kind: 'local',
          id: string(row.id),
          ...(row.publish === undefined ? {} : { publish: workspacePublishRanges(row.publish) }),
        }
      : invalid();
}
function locator(value: unknown, expected: NativeRunLocator): NativeRunLocator {
  const row = object(value);
  const result = {
    taskId: string(row.taskId),
    planId: string(row.planId),
    revision: integer(row.revision, 1),
    nodeId: string(row.nodeId),
  };
  if (
    result.taskId !== expected.taskId ||
    result.planId !== expected.planId ||
    result.revision !== expected.revision ||
    result.nodeId !== expected.nodeId
  )
    invalid();
  return result;
}
function optionsView(
  value: unknown,
  expected: NativeRunLocator,
  spaceId: string,
): NativeRunOptions {
  const row = object(value);
  const target = { ...locator(row.target, expected), spaceId: string(object(row.target).spaceId) };
  if (target.spaceId !== spaceId) invalid();
  const choices = object(row.models);
  const models: NativeRunOptions['models'] =
    choices.kind === 'ready'
      ? {
          kind: 'ready',
          items: array(choices.items).map((raw): NativeRunModelChoice => {
            const item = object(raw);
            return {
              id: string(item.id, 500),
              label: string(item.label, 300),
              value: model(item.value),
            };
          }),
        }
      : choices.kind === 'unavailable'
        ? { kind: 'unavailable', message: string(choices.message, 500) }
        : invalid();
  const start = object(row.start);
  return {
    target,
    nodeVersion: integer(row.nodeVersion),
    runVersion: integer(row.runVersion),
    currentRunId: row.currentRunId === null ? null : string(row.currentRunId),
    selection: row.selection === null ? null : selection(row.selection),
    models,
    ...(row.knowledgeLibraries === undefined
      ? {}
      : {
          knowledgeLibraries:
            object(row.knowledgeLibraries).kind === 'ready'
              ? {
                  kind: 'ready' as const,
                  items: array(object(row.knowledgeLibraries).items, 100).map((value) => {
                    const item = object(value);
                    return { id: string(item.id, 100), label: string(item.label, 200) };
                  }),
                }
              : {
                  kind: 'unavailable' as const,
                  message: string(object(row.knowledgeLibraries).message),
                },
        }),
    experts: array(row.experts, 100).map((raw) => {
      const item = object(raw);
      return {
        id: string(item.id, 500),
        label: string(item.label),
        description:
          typeof item.description === 'string' && item.description.length <= 2000
            ? item.description
            : invalid(),
        value: executor(item.value),
      };
    }),
    resources: array(row.resources, 300).map((raw) => {
      const item = object(raw);
      return {
        id: string(item.id),
        name: string(item.name),
        kind: oneOf(item.kind, ['skill', 'mcp', 'input']),
        status: oneOf(item.status, ['fixed', 'unavailable', 'unknown']),
      };
    }),
    start:
      start.kind === 'available'
        ? { kind: 'available', mode: oneOf(start.mode, ['begin', 'retry', 'restart']) }
        : start.kind === 'unavailable'
          ? { kind: 'unavailable', message: string(start.message, 500) }
          : invalid(),
    tools: oneOf(row.tools, ['text-only', 'accepted-input-reader']),
    ...(row.workspaces === undefined
      ? {}
      : {
          workspaces: array(row.workspaces, 100).map((raw) => {
            const item = object(raw);
            return {
              id: string(item.id),
              label: string(item.label),
              access: oneOf(item.access, ['read', 'write']),
              publish: boolean(item.publish),
              ...(item.publication === undefined
                ? {}
                : { publication: oneOf(item.publication, ['per-run']) }),
            };
          }),
        }),
    ...(row.workspaceApprovalScope === undefined
      ? {}
      : {
          workspaceApprovalScope: {
            spaceId:
              object(row.workspaceApprovalScope).spaceId === target.spaceId
                ? target.spaceId
                : invalid(),
            projectId: string(object(row.workspaceApprovalScope).projectId),
          },
        }),
  };
}
const unavailable: NativeRunAction = { kind: 'unavailable', message: '当前运行暂不支持此操作。' };
function capability(value: unknown): NativeRunAction {
  const row = object(value);
  return row.kind === 'available'
    ? { kind: 'available' }
    : row.kind === 'unavailable'
      ? unavailable
      : row.kind === 'unknown'
        ? { kind: 'unknown', message: '暂时无法确认操作权限，请刷新。' }
        : invalid();
}
function resultDelivery(value: unknown): NativeRunResultDelivery {
  const row = object(value);
  const kind = oneOf(row.kind, ['pending', 'delivered']);
  if (kind === 'pending')
    return { kind, phase: oneOf(row.phase, ['draining', 'not-durable', 'delivery-unconfirmed']) };
  const receipt = object(row.receipt);
  const protocol =
    row.protocolVersion === undefined && row.manifestDigest === undefined
      ? {}
      : row.protocolVersion === 2 &&
          typeof row.manifestDigest === 'string' &&
          /^[a-f0-9]{64}$/u.test(row.manifestDigest)
        ? { protocolVersion: 2 as const, manifestDigest: row.manifestDigest }
        : invalid();
  return {
    kind,
    artifactVersionId: string(row.artifactVersionId),
    artifactVersion: integer(row.artifactVersion, 1),
    ...(row.roundId === undefined ? {} : { roundId: string(row.roundId) }),
    receipt: {
      idempotencyKey: string(receipt.idempotencyKey),
      version: integer(receipt.version, 1),
    },
    ...protocol,
  };
}
function readView(value: unknown, expected: NativeRunLocator, runId: string): NativeRunRead {
  const row = object(value);
  if (row.runId !== runId) invalid();
  const native = row.native === null ? null : object(row.native);
  const caps = row.sendCapabilities === undefined ? undefined : object(row.sendCapabilities);
  const delivery =
    row.resultDelivery === undefined ? undefined : resultDelivery(row.resultDelivery);
  if (
    delivery &&
    (delivery.kind === 'delivered'
      ? row.status !== 'completed' || row.resources !== 'settled' || row.stopPhase !== 'none'
      : row.resources !== 'held' || row.stopPhase !== 'none')
  )
    invalid();
  return {
    ...locator(row, expected),
    runId,
    generation: integer(row.generation, 1),
    segmentId: string(row.segmentId),
    nodeVersion: integer(row.nodeVersion),
    runVersion: integer(row.runVersion, 1),
    status: oneOf(row.status, [
      'requested',
      'running',
      'waiting-for-input',
      'completed',
      'failed',
      'cancelled',
    ]),
    dispatch: oneOf(row.dispatch, ['reserved', 'received', 'unknown']),
    resources: oneOf(row.resources, ['held', 'settled']),
    acknowledged: boolean(row.acknowledged),
    stopPhase: oneOf(row.stopPhase, ['none', 'requested', 'confirmed', 'receipt-rejected']),
    ...(delivery ? { resultDelivery: delivery } : {}),
    ...(row.submission === undefined
      ? {}
      : {
          submission: {
            artifactVersionId: string(object(row.submission).artifactVersionId, 1000),
            ...(object(row.submission).roundId === undefined
              ? {}
              : { roundId: string(object(row.submission).roundId, 1000) }),
          },
        }),
    native: native
      ? {
          sessionId: string(native.sessionId),
          agentId: string(native.agentId),
          status: oneOf(native.status, ['idle', 'running', 'detached']),
        }
      : null,
    sendCapabilities: {
      followup: caps ? capability(caps.followup) : unavailable,
      steer: caps ? capability(caps.steer) : unavailable,
      queue: caps ? capability(caps.queue) : unavailable,
    },
  };
}

/** Project only known public transcript fields; never stringify unknown event payloads. */
export function projectNativeRunMessages(events: readonly unknown[]): NativeRunMessage[] {
  return events.flatMap<NativeRunMessage>((raw) => {
    const event = object(raw);
    const sequence = integer(event.seq);
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return [];
    if (!['user/message', 'assistant/message', 'tool/call'].includes(String(event.type))) return [];
    const data = object(event.data);
    if (event.type === 'tool/call')
      return [
        {
          id: `event-${sequence}`,
          sequence,
          role: 'tool' as const,
          label: '工具调用',
          text: string(data.name),
        },
      ];
    const message = event.type === 'user/message' ? data : object(data.message);
    const role = event.type === 'user/message' ? ('user' as const) : ('assistant' as const);
    const source = message.source;
    // SDK 0.2.1-rc.2 also persists runtime-context/instruction/catalog injection
    // as user/message. Role/text alone cannot identify a human conversation.
    if (
      message.role !== role ||
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      !('kind' in source) ||
      source.kind !== (role === 'user' ? 'user' : 'model')
    )
      return [];
    const text = array(message.content, 1000)
      .flatMap((raw) => {
        const block = object(raw);
        return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
      })
      .join('\n');
    return text
      ? [
          {
            id: `event-${sequence}`,
            sequence,
            role,
            text: text.slice(0, 262_144),
            ...(typeof message.id === 'string' ? { nativeId: message.id } : {}),
          },
        ]
      : [];
  });
}

/** Exact same-origin member routes only. Account and view hints never grant Host authority. */
export function createNativeRunApi(
  fetcher: typeof fetch,
  accountId: string,
  scope: MemberExecutionScope,
  onUnauthenticated: () => void,
  registerDirectory?: RegisterWorkspaceDirectory,
  openModelSettings?: () => void,
  localDirectory?: LocalWorkspaceDirectory,
  serverAllocatedRunIds = false,
): NativeRunApi {
  const identity = createIdentityApi(fetcher);
  const directory = createMemberWorkbenchApi(
    {
      actorId: accountId,
      spaceId: scope.spaceId,
      isCurrent: () => scope.isCurrent?.() !== false,
      onUnauthenticated,
      onUnavailable: () => scope.onUnavailable(),
    },
    fetcher,
  );
  function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (scope.isCurrent?.() === false) throw new DOMException('View changed', 'AbortError');
  }
  async function authorizeLocal(signal: AbortSignal) {
    current(signal);
    const session = await identity.session(signal);
    current(signal);
    if (session.accountId !== accountId)
      throw new ExecutionError('unauthenticated', '账号已变化，请重新登录。');
    if (!session.spaces.some((item) => item.id === scope.spaceId))
      throw new ExecutionError('space-unavailable', '此空间已不可访问。');
  }
  function report(error: unknown, signal: AbortSignal): never {
    current(signal);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['unauthenticated', 'member-session-required', 'session-changed'].includes(String(code)))
      onUnauthenticated();
    else if (['scope-mismatch', 'space-unavailable'].includes(String(code))) scope.onUnavailable();
    throw error;
  }
  function result(envelope: Record<string, unknown>, rpcId: string): unknown {
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) invalid();
    const value = object(envelope.result);
    if (value.ok !== true)
      throw new ExecutionError(
        string(object(value.error).code),
        '操作尚未确认，请刷新状态后重试。',
      );
    return value.value;
  }
  async function open(
    endpoint: string,
    payload: object,
    caller: AbortSignal,
    group: 'run' | 'workflow' | 'workspaces' = 'run',
  ) {
    const connecting = new AbortController();
    const timer = setTimeout(() => connecting.abort(), 10_000);
    const signal = AbortSignal.any([caller, connecting.signal]);
    let response: Response | undefined;
    let delivered = false;
    try {
      current(signal);
      const session = await identity.session(signal);
      current(signal);
      if (session.accountId !== accountId)
        throw new ExecutionError('unauthenticated', '账号已变化，请重新登录。');
      if (!session.spaces.some((space) => space.id === scope.spaceId))
        throw new ExecutionError('space-unavailable', '此空间已不可访问。');
      const rpcId = crypto.randomUUID();
      response = await fetcher(`/api/zhuma-${group}/${endpoint}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `zhuma-${group}/${endpoint}`,
          payload,
        }),
      });
      current(signal);
      if (response.status === 401)
        throw new ExecutionError('unauthenticated', '登录已失效，请重新登录。');
      if (response.status === 403 && group === 'workspaces')
        throw new ExecutionError('workspace-owner-required', '请在本机所有者入口管理目录授权。');
      if (!response.ok)
        throw new ExecutionError('unavailable', 'Agent 服务暂不可用，请刷新后重试。');
      delivered = true;
      return { response, rpcId };
    } finally {
      clearTimeout(timer);
      if (!delivered) await response?.body?.cancel().catch(() => undefined);
    }
  }
  async function call(
    endpoint: string,
    payload: object,
    caller: AbortSignal,
    group: 'run' | 'workflow' | 'workspaces' = 'run',
  ): Promise<unknown> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(10_000)]);
    try {
      const { response, rpcId } = await open(endpoint, payload, signal, group);
      const envelope = object(await response.json());
      current(signal);
      return result(envelope, rpcId);
    } catch (error) {
      return report(error, signal);
    }
  }
  const clean = (target: NativeRunLocator): NativeRunLocator => ({
    taskId: target.taskId,
    planId: target.planId,
    revision: target.revision,
    nodeId: target.nodeId,
  });
  const runLocator = (run: NativeRunSummary) => ({ ...clean(run), runId: run.runId });
  return {
    ...(localDirectory?.openSession
      ? {
          async openNativeSession(run: NativeRunSummary, signal: AbortSignal) {
            try {
              const latest = readView(await call('read', runLocator(run), signal), run, run.runId);
              if (
                !latest.native ||
                !run.native ||
                latest.generation !== run.generation ||
                latest.segmentId !== run.segmentId ||
                latest.native.sessionId !== run.native.sessionId
              )
                throw new ExecutionError('unavailable', '工作会话已变化，请刷新后重试。');
              current(signal);
              await localDirectory.openSession!(latest.native.sessionId, signal, () =>
                authorizeLocal(signal),
              );
              current(signal);
            } catch (error) {
              return report(error, signal);
            }
          },
        }
      : {}),
    ...(openModelSettings
      ? {
          openModelSettings: () => {
            if (scope.isCurrent?.() === false) throw new DOMException('View changed', 'AbortError');
            openModelSettings();
          },
        }
      : {}),
    workspaceApprovals: {
      ...(localDirectory
        ? {
            existingDirectories: async (signal: AbortSignal) => {
              try {
                const entries = await localDirectory.read(signal, () => authorizeLocal(signal));
                current(signal);
                return entries;
              } catch (error) {
                return report(error, signal);
              }
            },
          }
        : {}),
      ...createWorkspaceApprovalApi(
        (endpoint, payload, signal) => call(endpoint, payload, signal, 'workspaces'),
        scope.spaceId,
        registerDirectory
          ? async (signal) => {
              const authorize = async () => {
                current(signal);
                const session = await identity.session(signal);
                current(signal);
                if (session.accountId !== accountId)
                  throw new ExecutionError('unauthenticated', '账号已变化，请重新登录。');
                if (!session.spaces.some((item) => item.id === scope.spaceId))
                  throw new ExecutionError('space-unavailable', '此空间已不可访问。');
              };
              try {
                await authorize();
                const value = await registerDirectory(signal, authorize);
                await authorize();
                return value;
              } catch (error) {
                return report(error, signal);
              }
            }
          : undefined,
      ),
      async context(location, signal) {
        if (location.spaceId !== scope.spaceId) invalid();
        current(signal);
        const snapshot = await directory.snapshot(signal);
        current(signal);
        const project = snapshot.state.projects.find((item) => item.id === location.projectId);
        if (!project) throw new ExecutionError('not-found', '当前项目已不可用，请返回工作台刷新。');
        return { accountName: snapshot.actorId, projectName: project.name };
      },
    },
    workflow: createWorkflowApi(
      (endpoint, payload, signal) => call(endpoint, payload, signal, 'workflow'),
      scope.spaceId,
    ),
    async inbox(run, signal) {
      return readNativeInbox(await call('inbox', runLocator(run), signal), run, scope.spaceId);
    },
    async *observe(run, after, signal) {
      try {
        const { response, rpcId } = await open('observe', { ...runLocator(run), after }, signal);
        const body = response.body;
        if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !body) {
          result(object(await response.json()), rpcId);
          invalid();
        }
        if (!body) return invalid();
        for await (const raw of conversationLines(body, signal)) {
          current(signal);
          const envelope = object(raw);
          if (envelope.type === 'server-response') {
            result(envelope, rpcId);
            invalid();
          }
          if (envelope.type !== 'server-frame' || envelope.rpcId !== rpcId) invalid();
          yield readConversationFrame(envelope.frame, run, scope.spaceId);
        }
      } catch (error) {
        report(error, signal);
      }
    },
    async options(target, signal) {
      return optionsView(
        await call('options', { ...clean(target), spaceId: scope.spaceId }, signal),
        target,
        scope.spaceId,
      );
    },
    async read(target, runId, signal) {
      return readView(await call('read', { ...clean(target), runId }, signal), target, runId);
    },
    async history(target, runId, after, signal) {
      const value = object(
        await call('history', { ...clean(target), runId, after, limit: 100 }, signal),
      );
      locator(value, target);
      if (value.runId !== runId) invalid();
      const events = array(value.events, 100);
      let previous = after;
      for (const event of events) {
        const seq = integer(object(event).seq);
        if (seq <= previous) invalid();
        previous = seq;
      }
      const nextAfter = integer(value.nextAfter, -1);
      if (nextAfter !== previous) invalid();
      let boundary: unknown;
      for (const event of events) if (object(event).type === 'turn/end') boundary = event;
      let turnEnd: Extract<NativeConversationFrame, { type: 'turn-end' }> | undefined;
      if (boundary) {
        const event = object(boundary),
          data = object(event.data);
        turnEnd = readNativeTurnEnd({
          seq: event.seq,
          time: event.time,
          turn: data.turn,
          reason: data.reason,
        });
      }
      return {
        messages: projectNativeRunMessages(events),
        nextAfter,
        ...(turnEnd ? { turnEnd } : {}),
      };
    },
    async begin(input, signal) {
      if (input.spaceId !== scope.spaceId) invalid();
      const value = object(
        await call(
          'begin',
          {
            ...clean(input),
            spaceId: scope.spaceId,
            requestId: input.requestId,
            newRunId: input.newRunId,
            newSegmentId: input.newSegmentId,
            expectedNodeVersion: input.expectedNodeVersion,
            expectedRunVersion: input.expectedRunVersion,
            mode: input.mode,
            model: model(input.model),
            ...(input.knowledge ? { knowledge: knowledge(input.knowledge) } : {}),
            executor: executor(input.executor),
            tools: input.tools,
            workspace: workspace(input.workspace),
          },
          signal,
        ),
      );
      locator(value, input);
      if (serverAllocatedRunIds) {
        string(value.runId);
        string(value.segmentId);
      } else if (value.runId !== input.newRunId || value.segmentId !== input.newSegmentId)
        invalid();
    },
    async send(run, text, mode, requestId, signal) {
      const value = object(
        await call(
          'send',
          {
            ...runLocator(run),
            generation: run.generation,
            segmentId: run.segmentId,
            requestId,
            text,
            mode,
          },
          signal,
        ),
      );
      locator(value, run);
      if (value.runId !== run.runId || value.requestId !== requestId || value.mode !== mode)
        invalid();
      oneOf(value.status, ['received', 'claimed']);
    },
    async stop(run, requestId, signal) {
      const value = object(
        await call(
          'stop',
          {
            ...runLocator(run),
            spaceId: scope.spaceId,
            generation: run.generation,
            segmentId: run.segmentId,
            requestId,
            expectedNodeVersion: run.nodeVersion,
            expectedRunVersion: run.runVersion,
          },
          signal,
        ),
      );
      locator(value, run);
      if (value.runId !== run.runId) invalid();
      oneOf(value.status, ['pending', 'stopped']);
    },
  };
}
