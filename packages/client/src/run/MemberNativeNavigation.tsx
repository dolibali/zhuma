import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import {
  remoteNodeTargetSchema,
  localReviewOptionsQuerySchema,
  type LocalReviewOptionsQuery,
} from '@zhuma/agent-core';
import type { MemberShell } from '../identity/shell.js';
import type { SharedBackendClient } from '../identity/shared-backend.js';
import { Modal } from '../workbench/controls.js';
import { Button } from '../workbench/Button.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { NativeRunWorkspace } from './NativeRunWorkspace.js';
import { createNativeRunApi, type NativeRunApi } from './api.js';
import { createCodeArtsSetupApi } from './codearts-setup.js';
import type { MemberNativeClient } from './member-native.js';
import type { LocalWorkspaceDirectory } from './workspace-directory.js';
import type { NativeRunTarget } from './native-run-contract.js';
import { createNativeReviewApi, type NativeReviewApi } from './review-api.js';
import { NativeReviewHistory } from './NativeReviewWorkspace.js';
import {
  createNativeConversationDelegate,
  type NativeConversationDelegate,
  type NativeConversationTarget,
} from './native-conversation.js';
import type { NativeRunRead } from './api.js';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid session navigation');
  return value as Record<string, unknown>;
};
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 200)
    throw Error('Invalid session identity');
  return value;
};
function classify(raw: unknown) {
  const row = record(raw);
  if (row.kind === 'ordinary' && Object.keys(row).length === 1)
    return { kind: 'ordinary' as const };
  if (row.kind === 'review')
    return {
      kind: 'review' as const,
      target: { ...localReviewOptionsQuerySchema.parse(row.target), runId: id(row.runId) },
      sessionId: id(row.sessionId),
    };
  if (row.kind !== 'task') throw Error('Invalid session classification');
  const scope = record(row.target);
  const node = remoteNodeTargetSchema.parse({
    spaceId: scope.spaceId,
    taskId: scope.taskId,
    planId: scope.planId,
    revision: scope.revision,
    nodeId: scope.nodeId,
  });
  if (
    typeof scope.generation !== 'number' ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1
  )
    throw Error('Invalid session generation');
  return {
    kind: 'task' as const,
    presentation:
      row.presentation === 'sdk-native' ? ('sdk-native' as const) : ('task-controls' as const),
    target: {
      ...node,
      runId: id(scope.runId),
      generation: scope.generation,
      segmentId: id(scope.segmentId),
    },
    sessionId: id(row.sessionId),
  };
}
export const nativeSessionPanel = 'zhuma-native-session' as MainPanelId;
type Entry = { key: number } & (
  | {
      kind: 'work';
      api: NativeRunApi;
      target: NativeRunTarget;
      sessionId: string;
      location: NativeConversationTarget;
      conversation?: { run: NativeRunRead; refresh(): Promise<NativeRunRead> };
    }
  | {
      kind: 'review';
      api: NativeReviewApi;
      target: NativeRunTarget;
      query: LocalReviewOptionsQuery;
      sessionId: string;
    }
);
type Guard = (
  target: unknown,
  signal: AbortSignal,
  intent?: 'restore' | 'explicit',
) => Promise<boolean>;

/** Classify before original mainView retention. Task Conversations install a scoped transport first. */
export function installMemberNativeNavigation(
  ctx: Context,
  options: {
    shell: MemberShell;
    backend: SharedBackendClient;
    native: MemberNativeClient;
    directory: LocalWorkspaceDirectory;
    openModelSettings(): void;
  },
) {
  let entry: Entry | undefined;
  let notice: string | undefined;
  let acceptedPanel: Entry | undefined;
  let returnPanel: MainPanelId | null = null;
  let installed = true;
  let navigation = 0;
  let epoch = 0;
  let entryBinding:
    { member: number; connection: string | null; space: string; spaceEpoch: number } | undefined;
  let leave: ((proceed: () => void, signal: AbortSignal) => void) | undefined;
  let retireLeave: (() => void) | undefined;
  let retireConversation: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const close = () => {
    ++epoch;
    const retire = retireConversation;
    retireConversation = undefined;
    retire?.();
    retireLeave?.();
    entry = undefined;
    acceptedPanel = undefined;
    entryBinding = undefined;
    notice = undefined;
    publish();
  };
  const dismissNotice = () => {
    notice = undefined;
    publish();
  };
  const bindingCurrent = (binding: NonNullable<typeof entryBinding>) => {
    const member = options.shell.session.getSnapshot();
    const backend = options.backend.getSnapshot();
    const space = options.shell.getSnapshot().space;
    return (
      installed &&
      member.status === 'authenticated' &&
      member.epoch === binding.member &&
      backend.phase === 'ready' &&
      backend.selection?.connectionId === binding.connection &&
      space?.status === 'ready' &&
      space.space.id === binding.space &&
      space.epoch === binding.spaceEpoch
    );
  };
  const state = {
    getSnapshot: () => entry,
    getNoticeSnapshot: () => notice,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
    dismissNotice,
    exit: () => ctx.layout.selectPanel(returnPanel),
    guardPanel(target: MainPanelId | null, proceed: () => void, signal: AbortSignal) {
      if (target === nativeSessionPanel && entry && acceptedPanel === entry) {
        acceptedPanel = undefined;
        if (!signal.aborted && entryBinding && bindingCurrent(entryBinding)) proceed();
        return true;
      }
      if (
        target !== nativeSessionPanel &&
        ctx.layout.panelInfo.getSnapshot().activePanelId === nativeSessionPanel &&
        entry
      ) {
        void ask(() => {
          close();
          proceed();
        }, signal).catch(() => undefined);
        return true;
      }
      return false;
    },
    registerLeave(handler: NonNullable<typeof leave>) {
      leave = handler;
      const lifetime = new AbortController();
      const page = options.shell.getSnapshot();
      const unleave = options.shell.registerLeaveGuard(
        page.pageEpoch,
        (proceed, signal) => handler(proceed, signal ?? lifetime.signal),
        nativeSessionPanel,
      );
      const unspace = options.shell.registerSpaceGuard(
        page.pageEpoch,
        (spaceId) =>
          handler(() => {
            if (entryBinding && bindingCurrent(entryBinding))
              void options.shell.space?.select(spaceId);
          }, lifetime.signal),
        nativeSessionPanel,
      );
      const retire = () => {
        lifetime.abort();
        unleave();
        unspace();
        if (leave === handler) leave = undefined;
        if (retireLeave === retire) retireLeave = undefined;
      };
      retireLeave = retire;
      return retire;
    },
  };
  function reveal() {
    const previous = ctx.layout.panelInfo.getSnapshot().activePanelId;
    if (previous !== nativeSessionPanel) returnPanel = previous;
    // The Session guard has already obtained leave consent. Hand that consent
    // to this one synchronous public panel selection before it replaces the
    // SDK navigation signal; no later selection inherits the permit.
    const accepted = entry;
    acceptedPanel = accepted;
    try {
      ctx.layout.selectPanel(nativeSessionPanel);
    } finally {
      queueMicrotask(() => {
        if (acceptedPanel === accepted) acceptedPanel = undefined;
      });
    }
  }
  function ask(proceed: () => void, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const aborted = () => resolve(false);
      signal.addEventListener('abort', aborted, { once: true });
      const accepted = () => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) resolve(false);
        else {
          try {
            proceed();
            resolve(true);
          } catch (error) {
            reject(error);
          }
        }
      };
      if (entry && leave) leave(accepted, signal);
      else options.shell.requestLeave(accepted, signal);
    });
  }
  const source = ctx.get('uiWorkspace') as unknown as {
    registerSessionNavigationGuard?: (guard: Guard) => () => void;
    clearSessionSelection?: (sessionId: string) => void;
  };
  const sessions = ctx.get('sessions') as unknown as {
    registerSessionDelegate?: (id: string, delegate: NativeConversationDelegate) => () => void;
  };
  if (
    !source?.registerSessionNavigationGuard ||
    !source.clearSessionSelection ||
    !sessions?.registerSessionDelegate
  )
    throw Error('工作区导航需要配套的 Zhuma 界面版本。');
  const blocks = ctx.conversation.blocks;
  const navigate = async (value: unknown, signal: AbortSignal, attempt: number) => {
    signal.throwIfAborted();
    const member = options.shell.session.getSnapshot();
    const selected = options.backend.getSnapshot().selection;
    if (member.status !== 'authenticated' || !selected) return false;
    const scope = options.shell.getSnapshot().space;
    if (scope?.status !== 'ready') return false;
    const binding = {
      member: member.epoch,
      connection: selected.connectionId,
      space: scope.space.id,
      spaceEpoch: scope.epoch,
    };
    const initialEpoch = epoch;
    const current = () => {
      signal.throwIfAborted();
      if (attempt !== navigation || epoch !== initialEpoch || !bindingCurrent(binding))
        throw new DOMException('Member navigation changed', 'AbortError');
    };
    const ids =
      typeof value === 'string'
        ? [id(value)]
        : (() => {
            const row = record(value);
            if (Object.keys(row).length !== 2) throw Error('Invalid session address');
            return {
              parentSessionId: id(row.parentSessionId),
              childSessionId: id(row.childSessionId),
            };
          })();
    const sessionId = typeof ids === 'object' && !Array.isArray(ids) ? ids.childSessionId : ids[0]!;
    const client = options.native.scoped(member.session.accountId, scope.space.id);
    const found = classify(await client.lookup(sessionId, signal));
    current();
    if (typeof ids === 'object' && !Array.isArray(ids)) {
      const parent = classify(await client.lookup(ids.parentSessionId, signal));
      current();
      if (parent.kind !== 'ordinary' && found.kind === 'ordinary')
        throw Error('Invalid session relationship');
    }
    if (found.kind === 'ordinary')
      return ask(() => {
        current();
        close();
      }, signal);
    if (found.sessionId !== sessionId) throw Error('Invalid session identity');
    const location = found.target;
    let active = true;
    let acceptedEpoch = -1;
    const nativeScope = {
      spaceId: location.spaceId,
      isCurrent: () => {
        return (
          active &&
          bindingCurrent(binding) &&
          (acceptedEpoch < 0
            ? !signal.aborted && attempt === navigation && initialEpoch === epoch
            : acceptedEpoch === epoch)
        );
      },
      onUnavailable: close,
    };
    const review = createNativeReviewApi(
      options.native.scoped(member.session.accountId, location.spaceId).fetcher,
      member.session.accountId,
      nativeScope,
      () => options.shell.session.invalidate(member.epoch),
    );
    if (found.kind === 'review') {
      const accepted = await ask(() => {
        current();
        acceptedEpoch = ++epoch;
        entryBinding = binding;
        const { runId: _runId, ...query } = found.target;
        entry = {
          key: acceptedEpoch,
          kind: 'review',
          api: review,
          query,
          sessionId,
          target: {
            spaceId: location.spaceId,
            taskId: location.taskId,
            planId: location.planId,
            revision: location.revision,
            nodeId: location.nodeId,
            title: 'Agent 评审记录',
          },
        };
        publish();
        reveal();
      }, signal);
      if (!accepted) active = false;
      return false;
    }
    const taskLocation = found.target;
    const taskClient = options.native.scoped(
      member.session.accountId,
      location.spaceId,
      location.runId,
    );
    const api = createNativeRunApi(
      taskClient.fetcher,
      member.session.accountId,
      nativeScope,
      () => options.shell.session.invalidate(member.epoch),
      undefined,
      options.openModelSettings,
      options.directory,
      !!selected.origin,
      createCodeArtsSetupApi(globalThis.fetch, () => nativeScope.isCurrent?.() !== false),
    );
    const { workflow: _workflow, workspaceApprovals: _approvals, ...remoteApi } = api;
    if (!selected.origin && found.presentation === 'sdk-native') {
      const lifetime = new AbortController();
      const update = (run: NativeRunRead) => {
        if (entry?.kind !== 'work' || entry.key !== acceptedEpoch || !entry.conversation) return;
        const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
        blocks.set(
          sessionId as Parameters<typeof blocks.set>[0],
          terminal
            ? { reason: '本轮任务已结束，当前仅可查看。原任务结果保持不变。' }
            : Object.values(run.sendCapabilities).some((value) => value.kind === 'available')
              ? undefined
              : { reason: '当前任务不可发送，请先处理任务状态。' },
        );
        entry = { ...entry, conversation: { ...entry.conversation, run } };
        publish();
      };
      const conversation = createNativeConversationDelegate({
        api,
        client: taskClient,
        target: taskLocation,
        sessionId,
        signal: lifetime.signal,
        assertCurrent: () => {
          if (acceptedEpoch < 0) current();
          else if (!nativeScope.isCurrent())
            throw new DOMException('Task authority changed', 'AbortError');
        },
        invalidate: close,
        update,
      });
      const run = await conversation.refresh(lifetime.signal);
      current();
      const accepted = await ask(() => {
        current();
        const retire = retireConversation;
        retireConversation = undefined;
        retire?.();
        acceptedEpoch = ++epoch;
        entryBinding = binding;
        const unregister = sessions.registerSessionDelegate!(sessionId, conversation.delegate);
        retireConversation = () => {
          lifetime.abort();
          unregister();
          source.clearSessionSelection!(sessionId);
          blocks.forget(sessionId as Parameters<typeof blocks.forget>[0]);
        };
        entry = {
          key: acceptedEpoch,
          kind: 'work',
          api: { ...api, review },
          sessionId,
          location: taskLocation,
          target: { ...location, title: 'Agent 工作会话' },
          conversation: { run, refresh: () => conversation.refresh(lifetime.signal) },
        };
        update(run);
      }, signal);
      if (!accepted) {
        active = false;
        lifetime.abort();
      }
      // Original uiWorkspace now retains the sole mainView reference and renders main.conversation.
      return accepted;
    }
    const accepted = await ask(() => {
      current();
      acceptedEpoch = ++epoch;
      entryBinding = binding;
      entry = {
        key: acceptedEpoch,
        kind: 'work',
        sessionId,
        location: taskLocation,
        api: { ...(selected.origin ? remoteApi : api), review },
        target: {
          spaceId: location.spaceId,
          taskId: location.taskId,
          planId: location.planId,
          revision: location.revision,
          nodeId: location.nodeId,
          title: 'Agent 工作会话',
        },
      };
      publish();
      reveal();
    }, signal);
    if (!accepted) active = false;
    return false;
  };
  const unguard = source.registerSessionNavigationGuard(async (value, signal, intent) => {
    signal.throwIfAborted();
    if (!installed) throw new DOMException('Navigation disposed', 'AbortError');
    const attempt = ++navigation;
    const initialEpoch = epoch;
    dismissNotice();
    const member = options.shell.session.getSnapshot();
    const backend = options.backend.getSnapshot();
    const scope = options.shell.getSnapshot().space;
    const refuse = (message: string) => {
      notice = message;
      publish();
      return false;
    };
    if (member.status !== 'authenticated') {
      if (intent === 'restore') return false;
      return refuse('请先登录账号并选择有权空间，再重新打开会话。');
    }
    if (backend.phase !== 'ready' || !backend.selection)
      return refuse('服务连接尚未就绪。请检查账号菜单中的服务连接后重试。');
    if (scope?.status !== 'ready')
      return refuse('空间目录尚未就绪。请刷新或重新选择有权空间后重试。');
    const binding = {
      member: member.epoch,
      connection: backend.selection.connectionId,
      space: scope.space.id,
      spaceEpoch: scope.epoch,
    };
    try {
      const allowed = await navigate(value, signal, attempt);
      if (allowed) {
        signal.throwIfAborted();
        if (attempt !== navigation || !bindingCurrent(binding))
          throw new DOMException('Member navigation changed', 'AbortError');
      }
      return allowed;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt !== navigation || epoch !== initialEpoch || !bindingCurrent(binding))
        throw new DOMException('Member navigation changed', 'AbortError');
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Transport and authority failures deliberately share neutral feedback.
      // Never display raw errors or turn an unknown task into ordinary history.
      return refuse('请确认当前账号、所选空间和服务连接，然后从侧栏重新打开。');
    }
  });
  const stop = options.shell.subscribe(() => {
    if (entryBinding && !bindingCurrent(entryBinding)) close();
    else if (notice) dismissNotice();
  });
  const stopBackend = options.backend.subscribe(() => {
    if (entryBinding && !bindingCurrent(entryBinding)) close();
    else if (notice) dismissNotice();
  });
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: nativeSessionPanel, inject: () => ({ state }) },
      MemberNativeNavigation,
    ),
  );
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'zhuma-native-session', inject: () => ({ state }) },
      MemberNativeNavigationNotice,
    ),
  );
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'zhuma-task-controls',
        inject: (sessionId) => ({ state, sessionId }),
      },
      NativeTaskConversationControls,
    ),
  );
  ctx.effect(() => () => {
    installed = false;
    ++navigation;
    unguard();
    stop();
    stopBackend();
    close();
  });
  return state;
}
type NavigationState = ReturnType<typeof installMemberNativeNavigation>;
function nativeTaskConversationStatus(run: NativeRunRead) {
  if (run.stopPhase === 'receipt-rejected') return '停止未确认';
  if (run.stopPhase === 'requested') return '正在停止';
  if (run.status === 'cancelled' || run.stopPhase === 'confirmed')
    return run.stopPhase === 'confirmed' && run.resources === 'settled' ? '已停止' : '等待停止确认';
  if (run.status === 'completed')
    return run.resources === 'settled' ? '已完成' : '任务已结束，正在收尾';
  if (run.status === 'failed')
    return run.resources === 'settled' ? '执行失败' : '执行失败，正在收尾';
  return run.status === 'running'
    ? '执行中'
    : run.status === 'waiting-for-input'
      ? '等待输入'
      : '准备中';
}
function NativeTaskConversationControls({
  state,
  sessionId,
}: {
  state: NavigationState;
  sessionId: string;
}) {
  const entry = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (entry?.kind !== 'work' || entry.sessionId !== sessionId || !entry.conversation) return null;
  const { run, refresh } = entry.conversation;
  return (
    <div className="zhuma zm-task-conversation-controls" aria-label="任务执行控制">
      <span title={`${entry.target.taskId} · ${entry.target.nodeId}`}>
        任务 · {nativeTaskConversationStatus(run)}
      </span>
      <span
        className="zm-task-conversation-hint"
        title="附件、模型和权限请在任务配置中管理；当前输入框发送文字。"
      >
        文字会话
      </span>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await refresh();
          } catch {
            setError('刷新未完成，请重新打开会话。');
          } finally {
            setBusy(false);
          }
        }}
      >
        刷新状态
      </Button>
      {error ? <span role="status">{error}</span> : null}
    </div>
  );
}
function MemberNativeNavigation({ state }: { state: NavigationState }) {
  const entry = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  return (
    <div className="zhuma zhuma-workbench zm-shell-panel">
      <div className="zm-shell-chrome" data-window-drag aria-hidden="true" />
      {entry ? (
        <MemberNativeSession key={entry.key} state={state} entry={entry} />
      ) : (
        <div className="zm-native-run__empty" role="status">
          <p>请从工作区选择当前有权查看的任务会话。</p>
          <Button onClick={state.exit}>返回</Button>
        </div>
      )}
    </div>
  );
}
function MemberNativeSession({ state, entry }: { state: NavigationState; entry: Entry }) {
  const [dirty, setDirty] = useState(false);
  const leave = useLeaveConfirmation(() => state.getSnapshot() === entry);
  useEffect(
    () => state.registerLeave((proceed, signal) => leave.request(proceed, dirty, signal)),
    [state, leave.request, dirty],
  );
  return (
    <>
      {leave.dialog}
      <div className="zm-run-workspace-dialog">
        {entry.kind === 'review' ? (
          <NativeReviewHistory
            api={entry.api}
            target={entry.query}
            sessionId={entry.sessionId}
            close={state.exit}
          />
        ) : (
          <NativeRunWorkspace
            api={entry.api}
            target={entry.target}
            onDirtyChange={setDirty}
            onClose={state.exit}
          />
        )}
      </div>
    </>
  );
}
function MemberNativeNavigationNotice({ state }: { state: NavigationState }) {
  const notice = useSyncExternalStore(
    state.subscribe,
    state.getNoticeSnapshot,
    state.getNoticeSnapshot,
  );
  const noticeId = useId();
  return (
    <>
      {notice && (
        <Modal
          title="暂时无法打开会话"
          variant="confirmation"
          descriptionId={noticeId}
          initialFocusId={`${noticeId}-dismiss`}
          close={state.dismissNotice}
        >
          <div className="zm-confirmation-body">
            <p id={noticeId} role="alert">
              {notice}
            </p>
            <div className="zm-confirmation-actions">
              <Button id={`${noticeId}-dismiss`} variant="primary" onClick={state.dismissNotice}>
                知道了
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
