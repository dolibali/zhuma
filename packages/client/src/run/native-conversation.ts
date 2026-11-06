import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/remote';
import type {
  SessionFollowFrame,
  SessionPage,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type { MemberNativeClient } from './member-native.js';
import type { NativeRunApi, NativeRunRead } from './api.js';
import type { NativeRunTarget } from './native-run-contract.js';
import { conversationLines } from './conversation.js';

export type NativeConversationTarget = Omit<NativeRunTarget, 'title' | 'description'> & {
  readonly runId: string;
  readonly generation: number;
  readonly segmentId: string;
};
export type NativeConversationDelegate = Pick<
  SessionRemote,
  'page' | 'follow' | 'prompt' | 'cancel'
> & {
  readonly signal: AbortSignal;
};
export interface NativeConversationStatus {
  readonly chatEpoch: number;
  readonly status: 'idle' | 'running' | 'detached';
  readonly eligible: boolean;
  readonly canStop: boolean;
}
const blocked = (message = '此操作需要当前任务授权，请重新打开工作会话。') =>
  Object.assign(new Error(message), {
    name: 'RemoteError',
    isDSHRemoteError: true as const,
    code: 'gateway/interactions-forbidden' as const,
    details: { endpoint: 'session/task-delegate' },
  });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw blocked();
  return value as Record<string, unknown>;
}
/** Original Session journal and composer remain the only Client chat state. This is a scoped transport adapter. */
export function createNativeConversationDelegate(options: {
  api: NativeRunApi;
  client: ReturnType<MemberNativeClient['scoped']>;
  target: NativeConversationTarget;
  sessionId: string;
  signal: AbortSignal;
  assertCurrent(): void;
  invalidate(): void;
  update(run: NativeRunRead, chat?: NativeConversationStatus): void;
  chat?: { restartHistory(): void };
}) {
  let chat: NativeConversationStatus | undefined;
  let pendingTransition: Promise<unknown> | undefined;
  let revision = 0;
  const current = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  const target = options.target;
  const locator = {
    taskId: target.taskId,
    planId: target.planId,
    revision: target.revision,
    nodeId: target.nodeId,
  };
  async function refresh(signal: AbortSignal) {
    current();
    const run = await options.api.read(locator, target.runId, signal);
    current();
    for (const key of [
      'taskId',
      'planId',
      'revision',
      'nodeId',
      'runId',
      'generation',
      'segmentId',
    ] as const)
      if (run[key] !== target[key]) {
        options.invalidate();
        throw blocked();
      }
    if (run.native?.sessionId !== options.sessionId) {
      options.invalidate();
      throw blocked();
    }
    if (options.chat) await refreshChat(signal);
    options.update(run, chat);
    return run;
  }
  async function refreshChat(signal: AbortSignal) {
    const { response, rpcId } = await request('session-status', {}, signal);
    const value = object(result(await response.json(), rpcId));
    if (
      !Number.isSafeInteger(value.chatEpoch) ||
      (value.chatEpoch as number) < 0 ||
      (value.status !== 'idle' && value.status !== 'running' && value.status !== 'detached') ||
      typeof value.eligible !== 'boolean' ||
      typeof value.canStop !== 'boolean'
    )
      throw blocked();
    chat = {
      chatEpoch: value.chatEpoch as number,
      status: value.status,
      eligible: value.eligible,
      canStop: value.canStop,
    };
    return chat;
  }
  function signalFor(signal?: AbortSignal) {
    return signal ? AbortSignal.any([options.signal, signal]) : options.signal;
  }
  function assertAddress(request: { address: { kind: string; sessionId?: unknown } }) {
    current();
    if (request.address.kind !== 'session' || request.address.sessionId !== options.sessionId)
      throw blocked();
  }
  async function request(
    endpoint:
      'session-page' | 'session-follow' | 'session-status' | 'session-send' | 'session-stop',
    query: unknown,
    signal: AbortSignal,
  ) {
    current();
    const rpcId = crypto.randomUUID();
    const response = await options.client.conversationRequest(
      endpoint,
      {
        target,
        sessionId: options.sessionId,
        request: query,
      },
      rpcId,
      signal,
    );
    current();
    signal.throwIfAborted();
    if (!response.ok) throw blocked();
    return { rpcId, response };
  }
  function result(raw: unknown, rpcId: string) {
    current();
    const wire = object(raw);
    if (wire.type !== 'server-response' || wire.rpcId !== rpcId) throw blocked();
    const result = object(wire.result);
    if (result.ok !== true) throw blocked();
    return result.value;
  }
  const delegate: NativeConversationDelegate = {
    signal: options.signal,
    async page(query, signal) {
      const reading = signalFor(signal);
      try {
        assertAddress(query);
        const { response, rpcId } = await request('session-page', query, reading);
        const value = result(await response.json(), rpcId);
        reading.throwIfAborted();
        current();
        return { ok: true, value: value as SessionPage };
      } catch (error) {
        if (!reading.aborted) options.invalidate();
        throw error;
      }
    },
    follow(query, signal) {
      const lifetime = new AbortController();
      const reading = AbortSignal.any([signalFor(signal), lifetime.signal]);
      const readingEpoch = chat?.chatEpoch ?? -1,
        readingRevision = revision;
      async function* frames() {
        try {
          assertAddress(query);
          const { response, rpcId } = await request('session-follow', query, reading);
          if (
            !response.body ||
            !response.headers.get('content-type')?.startsWith('application/x-ndjson')
          )
            throw blocked();
          for await (const raw of conversationLines(response.body, reading)) {
            current();
            reading.throwIfAborted();
            const wire = object(raw);
            if (wire.type !== 'server-frame' || wire.rpcId !== rpcId) throw blocked();
            const frame = object(wire.frame);
            if (frame.type === 'history-restart') {
              if (
                !options.chat ||
                !Number.isSafeInteger(frame.chatEpoch) ||
                (frame.chatEpoch as number) < 0
              )
                throw blocked();
              if (chat) chat = { ...chat, chatEpoch: frame.chatEpoch as number };
              options.chat.restartHistory();
              if (!reading.aborted) throw blocked();
              return;
            }
            // The original SessionEventStream validates full original SDK history and Assistant baselines.
            yield wire.frame as SessionFollowFrame;
          }
          if (!reading.aborted) throw blocked();
        } catch (error) {
          if (!reading.aborted && options.chat) {
            try {
              await pendingTransition;
              reading.throwIfAborted();
              const fresh = await refreshChat(reading);
              if (fresh && (fresh.chatEpoch > readingEpoch || revision > readingRevision)) {
                options.chat.restartHistory();
                if (reading.aborted) return;
              }
            } catch {
              /* A failed fresh authorization leaves this generation unavailable. */
            }
          }
          if (!reading.aborted) options.invalidate();
          throw error;
        } finally {
          lifetime.abort();
        }
      }
      const stream = frames();
      return {
        [Symbol.asyncIterator]: () => stream,
        send: () => {
          throw blocked();
        },
        end: () => undefined,
        dispose: () => lifetime.abort(),
      };
    },
    async prompt(query, signal) {
      const sending = signalFor(signal);
      current();
      if (query.sessionId !== options.sessionId) throw blocked();
      if (!query.content.length || query.content.some((part) => part.type !== 'text'))
        return { ok: false, error: blocked('任务会话暂支持文字输入，附件请在任务中提交。') };
      const text = query.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      if (!text.trim() || text.length > 16_384)
        return { ok: false, error: blocked('请输入 1–16384 个字符。') };
      const run = await refresh(sending);
      if (options.chat && ['completed', 'cancelled', 'failed'].includes(run.status)) {
        if (!chat?.eligible || query.mode === 'steer')
          return { ok: false, error: blocked('当前会话尚不能继续发送。') };
        const dispatch = request('session-send', { requestId: query.requestId, text }, sending);
        pendingTransition = dispatch;
        const { response, rpcId } = await dispatch;
        const value = object(result(await response.json(), rpcId));
        if (
          value.accepted !== true ||
          value.requestId !== query.requestId ||
          !Number.isSafeInteger(value.chatEpoch) ||
          (value.chatEpoch as number) < 1
        )
          throw blocked();
        revision++;
        // Native acceptance is final; a later metadata failure must not restore this prompt as unsent.
        void refresh(options.signal).catch(() => undefined);
        return { ok: true, value: { accepted: true } };
      }
      const mode =
        query.mode === 'steer' ? 'steer' : run.native?.status === 'running' ? 'queue' : 'followup';
      if (run.sendCapabilities[mode].kind !== 'available')
        return { ok: false, error: blocked('当前会话只读。原任务结果保持不变。') };
      current();
      await options.api.send(run, text, mode, query.requestId, sending);
      current();
      sending.throwIfAborted();
      return { ok: true, value: { accepted: true } };
    },
    async cancel(query) {
      const stopping = options.signal;
      if (query.sessionId !== options.sessionId) throw blocked();
      const run = await refresh(stopping);
      if (options.chat && ['completed', 'cancelled', 'failed'].includes(run.status)) {
        if (!chat?.canStop) return { ok: false, error: blocked('当前没有可停止的聊天运行。') };
        const dispatch = request('session-stop', {}, stopping);
        pendingTransition = dispatch;
        const { response, rpcId } = await dispatch;
        const value = object(result(await response.json(), rpcId));
        if (!['pending', 'stopped'].includes(String(value.status))) throw blocked();
        revision++;
        return { ok: true, value: { accepted: true } };
      }
      await options.api.stop(run, crypto.randomUUID(), stopping);
      current();
      stopping.throwIfAborted();
      await refresh(stopping);
      return { ok: true, value: { accepted: true } };
    },
  };
  return {
    delegate,
    refresh,
    stop: () =>
      delegate.cancel({
        sessionId: options.sessionId as Parameters<
          NativeConversationDelegate['cancel']
        >[0]['sessionId'],
      }),
  };
}
