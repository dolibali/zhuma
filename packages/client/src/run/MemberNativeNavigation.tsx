import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
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
  | { kind: 'work'; api: NativeRunApi; target: NativeRunTarget }
  | {
      kind: 'review';
      api: NativeReviewApi;
      target: NativeRunTarget;
      query: LocalReviewOptionsQuery;
      sessionId: string;
    }
);
type Guard = (target: unknown, signal: AbortSignal) => Promise<boolean>;

/** Existing Workspace navigation is classified before retain/resume. Task
 * hits open the same controlled task view, never the ordinary Conversation. */
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
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const close = () => {
    ++epoch;
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
      if (entry) leave?.(accepted, signal);
      else options.shell.requestLeave(accepted, signal);
    });
  }
  const source = ctx.get('uiWorkspace') as unknown as {
    registerSessionNavigationGuard?: (guard: Guard) => () => void;
  };
  if (!source?.registerSessionNavigationGuard) throw Error('工作区导航需要配套的 Zhuma 界面版本。');
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
        return active && acceptedEpoch === epoch && bindingCurrent(binding);
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
    const api = createNativeRunApi(
      options.native.scoped(member.session.accountId, location.spaceId, location.runId).fetcher,
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
    const accepted = await ask(() => {
      current();
      acceptedEpoch = ++epoch;
      entryBinding = binding;
      entry = {
        key: acceptedEpoch,
        kind: 'work',
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
  const unguard = source.registerSessionNavigationGuard(async (value, signal) => {
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
    if (member.status !== 'authenticated')
      return refuse('请先登录账号并选择有权空间，再重新打开会话。');
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
