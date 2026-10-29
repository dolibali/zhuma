import type { NativeRunApi, NativeRunBegin, NativeRunOptions, NativeRunRead } from './api.js';
import { createConversationState } from './conversation-state.js';
import { canonicalPayload } from '@zhuma/agent-core';
import { workspacePublishRanges } from './workspace-approvals.js';
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
type Command = 'start' | 'send' | 'stop';
type Retry = { fingerprint: string; requestId: string; newRunId: string; newSegmentId: string };
type ActiveCommand = { epoch: number; abort: AbortController };
const runIdentity = (run: NativeRunRead | null) =>
  run ? JSON.stringify([run.runId, run.generation, run.segmentId]) : undefined;
const conversationIdentity = (run: NativeRunRead | null) =>
  run ? JSON.stringify([runIdentity(run), run.native?.sessionId, run.native?.agentId]) : undefined;
const isMessageTransportUnavailable = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code !== undefined) return code === 'unavailable';
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')
  );
};

/** Ephemeral view state only. No persistence, authority, native handle or execution facts. */
export function createNativeRunController(api: NativeRunApi, target: NativeRunTarget) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let state: Snapshot = { view: { kind: 'loading' }, busy: undefined, error: undefined };
  let options: NativeRunOptions | undefined;
  let run: NativeRunRead | null = null;
  let selection: NativeRunSelection | null = null;
  const transcript = createConversationState();
  let observing: { abort: AbortController; identity: string | undefined } | undefined;
  let resync: ReturnType<typeof setTimeout> | undefined;
  let cursor = -1;
  let reading: AbortController | undefined;
  let epoch = 0;
  let stopFence: string | undefined;
  const active: Partial<Record<Command, ActiveCommand>> = {};
  const retries: Partial<Record<Command, Retry>> = {};
  const current = () => !lifetime.signal.aborted;
  const isActive = (kind: Command) => active[kind]?.epoch === epoch;
  const writing = () => Object.values(active).some((command) => command.epoch === epoch);
  function publishBusy() {
    publish({
      busy: isActive('stop')
        ? 'stop'
        : isActive('start')
          ? 'start'
          : active.send?.epoch === epoch
            ? 'send'
            : reading && !reading.signal.aborted
              ? 'refresh'
              : undefined,
    });
  }
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
    const stopping = stopFence !== undefined && stopFence === runIdentity(run);
    const stopPending = {
      kind: 'unavailable' as const,
      message: '停止结果尚待确认，请刷新或重试停止。',
    };
    // Passive reads may finish a Run while catalog=false retains older start
    // capabilities. Do not repeat a pre-settlement resource reason or enable
    // an old start action; only a fresh catalog can authorize the next round.
    const submittedWithOldOptions =
      run?.status === 'completed' &&
      run.resources === 'settled' &&
      run.resultDelivery?.kind === 'delivered' &&
      (options.currentRunId !== run.runId ||
        options.nodeVersion !== run.nodeVersion ||
        options.runVersion !== run.runVersion);
    publish({
      view: {
        kind: 'ready',
        run,
        messages: transcript.messages(),
        hasEarlier: false,
        ...(transcript.turnEnd() ? { turnEnd: transcript.turnEnd()! } : {}),
        selection: held ? options.selection : selection,
        models: options.models,
        ...(options.knowledgeLibraries ? { knowledgeLibraries: options.knowledgeLibraries } : {}),
        experts: { kind: 'ready', items: options.experts },
        resources: options.resources,
        ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
        ...(options.workspaceApprovalScope === undefined
          ? {}
          : {
              workspaceApprovalScope: options.workspaceApprovalScope,
            }),
        actions: {
          start: stopping
            ? stopPending
            : submittedWithOldOptions
              ? { kind: 'unavailable', message: '产物已提交，本轮会话只读。' }
              : options.start,
          send: stopping
            ? { followup: stopPending, steer: stopPending, queue: stopPending }
            : (run?.sendCapabilities ?? {
                followup: unavailable,
                steer: unavailable,
                queue: unavailable,
              }),
          stop:
            run?.resources === 'held' && run.stopPhase !== 'confirmed'
              ? { kind: 'available' }
              : unavailable,
        },
      },
    });
  }
  function stopObserving() {
    observing?.abort.abort();
    observing = undefined;
    clearTimeout(resync);
    resync = undefined;
    transcript.disconnect();
  }
  function observe() {
    if (!api.observe || !run?.native || observing || !current()) return;
    const fixed = run;
    const ticket = { abort: new AbortController(), identity: conversationIdentity(fixed) };
    observing = ticket;
    const signal = AbortSignal.any([ticket.abort.signal, lifetime.signal]);
    const valid = () =>
      current() &&
      observing === ticket &&
      !signal.aborted &&
      conversationIdentity(run) === ticket.identity;
    void (async () => {
      let gap = false;
      try {
        for await (const frame of api.observe!(fixed, cursor, signal)) {
          if (!valid()) return;
          gap = transcript.frame(frame);
          ready();
          if (gap) break;
        }
      } catch {
        if (valid()) publish({ error: '实时连接已断开，正在同步已保存的消息。' });
      } finally {
        if (observing === ticket) {
          observing = undefined;
          transcript.disconnect();
          ready();
          // Never adopt gap.after as a local cursor: it can include frames this
          // view did not receive. The normal history read fills from cursor.
          if (gap && current())
            resync = setTimeout(() => {
              resync = undefined;
              void refresh(false).catch(() => undefined);
            }, 2500);
        }
        ticket.abort.abort();
      }
    })();
  }
  async function refresh(catalog = true) {
    lifetime.signal.throwIfAborted();
    clearTimeout(resync);
    resync = undefined;
    // Passive polling yields to existing reads/commands; explicit refresh can replace a read.
    if (!catalog && (reading || writing())) return;
    reading?.abort();
    const request = new AbortController();
    reading = request;
    const signal = AbortSignal.any([request.signal, lifetime.signal]);
    const valid = () => current() && reading === request && !signal.aborted;
    publish({ error: undefined });
    publishBusy();
    let adopted = false;
    try {
      const next = !catalog && options ? options : await api.options(target, signal);
      if (!valid()) return;
      const nextRun = next.currentRunId ? await api.read(target, next.currentRunId, signal) : null;
      if (!valid()) return;
      const changed =
        run?.runId !== nextRun?.runId ||
        run?.generation !== nextRun?.generation ||
        run?.segmentId !== nextRun?.segmentId;
      if (changed) stopObserving();
      options = next;
      run = nextRun;
      if (changed) epoch++;
      // An uncertain stop is not undone by a still-running read or a late send.
      // Only fresh physical settlement or a different Run releases this UI fence.
      if (
        stopFence &&
        (stopFence !== runIdentity(run) ||
          (run?.resources === 'settled' && run.stopPhase === 'confirmed'))
      )
        stopFence = undefined;
      if (next.selection) selection = next.selection;
      else if (changed) selection = null;
      if (changed) {
        transcript.clear();
        cursor = -1;
      }
      // The authoritative status is independent of the historical reader's
      // lifetime. A retired Session reader must not hide a fresh settled Run.
      adopted = true;
      ready();
      // Forward-only SDK history: retain the transcript and advance the real seq
      // cursor. Never call this "older messages" or infer missing events.
      if (nextRun?.native) {
        const page = await api.history(target, nextRun.runId, cursor, signal);
        if (!valid()) return;
        transcript.history(page.messages, page.nextAfter);
        if (page.turnEnd) transcript.frame(page.turnEnd);
        cursor = page.nextAfter;
        ready();
        if (api.inbox) {
          const inbox = await api.inbox(nextRun, signal);
          if (!valid()) return;
          transcript.inbox(inbox);
          ready();
        }
      }
      observe();
    } catch (error) {
      if (valid()) {
        if (adopted && isMessageTransportUnavailable(error)) {
          ready();
          publish({ error: '运行状态已更新，部分会话消息暂未同步，请刷新重试。' });
          observe();
        } else {
          stopObserving();
          publish({
            view: { kind: 'unavailable', message: '暂时无法读取这个工作节点，请刷新或重新进入。' },
          });
        }
      }
      throw error;
    } finally {
      if (reading === request) {
        reading = undefined;
        publishBusy();
      }
    }
  }
  function key(kind: Command, fingerprint: string) {
    if (retries[kind]?.fingerprint !== fingerprint)
      retries[kind] = {
        fingerprint,
        requestId: crypto.randomUUID(),
        newRunId: crypto.randomUUID(),
        newSegmentId: crypto.randomUUID(),
      };
    return retries[kind]!;
  }
  async function command(kind: Command, work: (signal: AbortSignal) => Promise<void>) {
    lifetime.signal.throwIfAborted();
    if (
      state.view.kind !== 'ready' ||
      isActive(kind) ||
      (kind === 'stop'
        ? isActive('start')
        : writing() || (stopFence && stopFence === runIdentity(run)))
    )
      throw Error('Run view is not ready');
    if (kind === 'stop') {
      if (!run || run.resources !== 'held') throw Error('Stop unavailable');
      epoch++;
      stopFence = runIdentity(run);
      // Cancel only the client wait. The admitted Host command retains its own
      // lifetime; stopping still goes through the independent real stop API.
    }
    const supersededSend = kind === 'stop' ? active.send : undefined;
    const ticket = { epoch, abort: new AbortController() };
    active[kind] = ticket;
    const valid = () => current() && ticket.epoch === epoch;
    reading?.abort();
    reading = undefined;
    ready();
    publish({ error: undefined });
    publishBusy();
    supersededSend?.abort.abort();
    try {
      await work(AbortSignal.any([lifetime.signal, ticket.abort.signal]));
      lifetime.signal.throwIfAborted();
      if (!valid()) throw new DOMException('Command superseded', 'AbortError');
      delete retries[kind];
      // A successful receipt remains successful even when the later read fails.
      await refresh().catch(() => undefined);
    } catch (error) {
      if (valid()) publish({ error: '操作结果尚未确认，请刷新状态。重试相同内容会沿用原请求。' });
      throw error;
    } finally {
      if (active[kind] === ticket) delete active[kind];
      publishBusy();
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
      if (!current() || writing() || state.view.kind !== 'ready' || run?.resources === 'held')
        return;
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
        const chosenWorkspace = next.workspace;
        if (
          next.knowledge &&
          (options.knowledgeLibraries?.kind !== 'ready' ||
            !options.knowledgeLibraries.items.some(
              (library) => library.id === next.knowledge!.libraryId,
            ))
        )
          throw Error('Knowledge library changed');
        if (
          chosenWorkspace?.kind === 'unavailable' ||
          (chosenWorkspace?.kind === 'local' &&
            !options.workspaces?.some((item) => item.id === chosenWorkspace.id))
        )
          throw Error('Workspace changed');
        if (chosenWorkspace?.kind === 'local' && chosenWorkspace.publish !== undefined) {
          if (
            options.workspaces?.find((item) => item.id === chosenWorkspace.id)?.publication !==
            'per-run'
          )
            throw Error('Workspace changed');
          workspacePublishRanges(chosenWorkspace.publish);
        }
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
          ...(next.knowledge ? { knowledge: next.knowledge } : {}),
          executor: next.executor,
          tools: chosenWorkspace?.kind === 'local' ? ('local-tools' as const) : options.tools,
          workspace: chosenWorkspace ?? { kind: 'text-only' as const },
        };
        const saved = key('start', JSON.stringify(['begin', content]));
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
          'send',
          JSON.stringify(['send', run.runId, run.generation, run.segmentId, text, mode]),
        );
        await api.send(run, text, mode, saved.requestId, signal);
      });
    },
    stop() {
      return command('stop', async (signal) => {
        if (!run || run.resources !== 'held') throw Error('Stop unavailable');
        const saved = key(
          'stop',
          JSON.stringify(['stop', run.runId, run.generation, run.segmentId]),
        );
        await api.stop(run, saved.requestId, signal);
      });
    },
    dispose() {
      lifetime.abort();
      stopObserving();
      for (const command of Object.values(active)) command.abort.abort();
      reading?.abort();
      listeners.clear();
    },
  };
}
