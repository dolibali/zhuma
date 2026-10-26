import type { NativeRunApi, NativeRunBegin, NativeRunOptions, NativeRunRead } from './api.js';
import { canonicalPayload } from '@zhuma/agent-core';
import type {
  NativeRunPanelProps,
  NativeRunPanelView,
  NativeRunSelection,
  NativeRunSendMode,
  NativeRunTarget,
} from './native-run-contract.js';

type Snapshot = {
  view: NativeRunPanelView;
  busy: NativeRunPanelProps['busy'];
  error: string | undefined;
};
const unavailable = { kind: 'unavailable' as const, message: '当前没有可操作的运行。' };

/** Ephemeral view state only. No persistence, authority, native handle or execution facts. */
export function createNativeRunController(api: NativeRunApi, target: NativeRunTarget) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let state: Snapshot = { view: { kind: 'loading' }, busy: undefined, error: undefined };
  let options: NativeRunOptions | undefined;
  let run: NativeRunRead | null = null;
  let selection: NativeRunSelection | null = null;
  let messages: Extract<NativeRunPanelView, { kind: 'ready' }>['messages'] = [];
  let cursor = -1;
  let reading: AbortController | undefined;
  let writing = false;
  let retry:
    { fingerprint: string; requestId: string; newRunId: string; newSegmentId: string } | undefined;
  const current = () => !lifetime.signal.aborted;
  function publish(change: Partial<Snapshot>) {
    if (!current()) return;
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  function ready() {
    if (!options) return;
    const held =
      run &&
      (run.resources === 'held' ||
        ['requested', 'running', 'waiting-for-input'].includes(run.status));
    publish({
      view: {
        kind: 'ready',
        run,
        messages,
        hasEarlier: false,
        selection: held ? options.selection : selection,
        models: options.models,
        experts: { kind: 'ready', items: options.experts },
        resources: options.resources,
        actions: {
          start: options.start,
          send: run?.sendCapabilities ?? {
            followup: unavailable,
            steer: unavailable,
            queue: unavailable,
          },
          stop:
            run?.resources === 'held' && run.stopPhase !== 'confirmed'
              ? { kind: 'available' }
              : unavailable,
        },
      },
    });
  }
  async function refresh(catalog = true) {
    lifetime.signal.throwIfAborted();
    if (!catalog && writing) return;
    reading?.abort();
    const request = new AbortController();
    reading = request;
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    const valid = () => current() && reading === request && !signal.aborted;
    publish({ busy: writing ? state.busy : 'refresh', error: undefined });
    try {
      const next = !catalog && options ? options : await api.options(target, signal);
      if (!valid()) return;
      const nextRun = next.currentRunId ? await api.read(target, next.currentRunId, signal) : null;
      if (!valid()) return;
      const changed =
        run?.runId !== nextRun?.runId ||
        run?.generation !== nextRun?.generation ||
        run?.segmentId !== nextRun?.segmentId;
      let nextMessages = changed ? [] : messages;
      let nextCursor = changed ? -1 : cursor;
      // Forward-only SDK history: retain the transcript and advance the real seq
      // cursor. Never call this "older messages" or infer missing events.
      if (nextRun?.native) {
        const page = await api.history(target, nextRun.runId, nextCursor, signal);
        if (!valid()) return;
        nextMessages = [...nextMessages, ...page.messages];
        nextCursor = page.nextAfter;
      }
      options = next;
      run = nextRun;
      if (next.selection) selection = next.selection;
      else if (changed) selection = null;
      messages = nextMessages;
      cursor = nextCursor;
      ready();
    } catch (error) {
      if (valid())
        publish({
          view: { kind: 'unavailable', message: '暂时无法读取这个工作节点，请刷新或重新进入。' },
        });
      throw error;
    } finally {
      if (valid() && !writing) publish({ busy: undefined });
    }
  }
  function key(fingerprint: string) {
    if (retry?.fingerprint !== fingerprint)
      retry = {
        fingerprint,
        requestId: crypto.randomUUID(),
        newRunId: crypto.randomUUID(),
        newSegmentId: crypto.randomUUID(),
      };
    return retry;
  }
  async function command(
    kind: 'start' | 'send' | 'stop',
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    lifetime.signal.throwIfAborted();
    if (writing || state.view.kind !== 'ready') throw Error('Run view is not ready');
    writing = true;
    reading?.abort();
    publish({ busy: kind, error: undefined });
    try {
      await work(lifetime.signal);
      lifetime.signal.throwIfAborted();
      retry = undefined;
      // A successful receipt remains successful even when the later read fails.
      await refresh().catch(() => undefined);
    } catch (error) {
      publish({ error: '操作结果尚未确认，请刷新状态。重试相同内容会沿用原请求。' });
      throw error;
    } finally {
      writing = false;
      publish({ busy: undefined });
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    refresh,
    select(next: NativeRunSelection) {
      if (!current() || writing || state.view.kind !== 'ready' || run?.resources === 'held') return;
      selection = next;
      ready();
    },
    start(next: NativeRunSelection) {
      return command('start', async (signal) => {
        if (!options || options.start.kind !== 'available' || !options.start.mode)
          throw Error('Start unavailable');
        const matches = (value: unknown, expected: unknown) =>
          canonicalPayload(value) === canonicalPayload(expected);
        if (
          options.models.kind !== 'ready' ||
          !options.models.items.some((item) => matches(item.value, next.model)) ||
          !options.experts.some((item) => matches(item.value, next.executor))
        )
          throw Error('Selection changed');
        const content = {
          spaceId: target.spaceId,
          taskId: target.taskId,
          planId: target.planId,
          revision: target.revision,
          nodeId: target.nodeId,
          expectedNodeVersion: options.nodeVersion,
          expectedRunVersion: options.runVersion,
          mode: options.start.mode,
          model: next.model,
          executor: next.executor,
          tools: options.tools,
          workspace: { kind: 'text-only' as const },
        };
        const saved = key(JSON.stringify(['begin', content]));
        const input: NativeRunBegin = {
          ...content,
          requestId: saved.requestId,
          newRunId: saved.newRunId,
          newSegmentId: saved.newSegmentId,
        };
        await api.begin(input, signal);
      });
    },
    send(text: string, mode: NativeRunSendMode) {
      return command('send', async (signal) => {
        if (
          !run ||
          run.sendCapabilities[mode].kind !== 'available' ||
          !text.trim() ||
          text.length > 16_384
        )
          throw Error('Send unavailable');
        const saved = key(
          JSON.stringify(['send', run.runId, run.generation, run.segmentId, text, mode]),
        );
        await api.send(run, text, mode, saved.requestId, signal);
      });
    },
    stop() {
      return command('stop', async (signal) => {
        if (!run || run.resources !== 'held') throw Error('Stop unavailable');
        const saved = key(JSON.stringify(['stop', run.runId, run.generation, run.segmentId]));
        await api.stop(run, saved.requestId, signal);
      });
    },
    dispose() {
      lifetime.abort();
      reading?.abort();
      listeners.clear();
    },
  };
}
