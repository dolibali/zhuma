import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import {
  remoteNodeTargetSchema,
  localReviewOptionsQuerySchema,
  type LocalReviewOptionsQuery,
} from '@zhuma/agent-core';
import type { MemberShell } from '../identity/shell.js';
import type { SharedBackendClient } from '../identity/shared-backend.js';
import { Modal } from '../workbench/controls.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { NativeRunWorkspace } from './NativeRunWorkspace.js';
import { createNativeRunApi, type NativeRunApi } from './api.js';
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
type Entry =
  | { kind: 'work'; api: NativeRunApi; target: NativeRunTarget }
  | {
      kind: 'review';
      api: NativeReviewApi;
      target: NativeRunTarget;
      query: LocalReviewOptionsQuery;
      sessionId: string;
    };
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
  let epoch = 0;
  let entryBinding: { member: number; connection: string | null } | undefined;
  let leave: ((proceed: () => void, signal: AbortSignal) => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const close = () => {
    ++epoch;
    entry = undefined;
    entryBinding = undefined;
    publish();
  };
  const state = {
    getSnapshot: () => entry,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
    registerLeave(handler: NonNullable<typeof leave>) {
      leave = handler;
      return () => {
        if (leave === handler) leave = undefined;
      };
    },
  };
  function ask(proceed: () => void, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const aborted = () => resolve(false);
      signal.addEventListener('abort', aborted, { once: true });
      const accepted = () => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) resolve(false);
        else {
          proceed();
          resolve(true);
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
  const unguard = source.registerSessionNavigationGuard(async (value, signal) => {
    signal.throwIfAborted();
    const member = options.shell.session.getSnapshot();
    const selected = options.backend.getSnapshot().selection;
    if (member.status !== 'authenticated' || !selected) return false;
    const current = () => {
      signal.throwIfAborted();
      const now = options.shell.session.getSnapshot();
      if (
        now.status !== 'authenticated' ||
        now.epoch !== member.epoch ||
        options.backend.getSnapshot().selection?.connectionId !== selected.connectionId
      )
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
    const scope = options.shell.getSnapshot().space;
    const initialSpace = scope?.status === 'ready' ? scope.space.id : member.session.spaces[0]?.id;
    if (!initialSpace) return false;
    const client = options.native.scoped(member.session.accountId, initialSpace);
    const found = classify(await client.lookup(sessionId, signal));
    current();
    if (typeof ids === 'object' && !Array.isArray(ids)) {
      const parent = classify(await client.lookup(ids.parentSessionId, signal));
      current();
      if (parent.kind !== 'ordinary' && found.kind === 'ordinary') return false;
    }
    if (found.kind === 'ordinary') return ask(close, signal);
    if (found.sessionId !== sessionId) return false;
    const location = found.target;
    let active = true;
    let acceptedEpoch = -1;
    const nativeScope = {
      spaceId: location.spaceId,
      isCurrent: () => {
        const now = options.shell.session.getSnapshot();
        return (
          active &&
          acceptedEpoch === epoch &&
          now.status === 'authenticated' &&
          now.epoch === member.epoch &&
          options.backend.getSnapshot().selection?.connectionId === selected.connectionId
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
        acceptedEpoch = ++epoch;
        entryBinding = { member: member.epoch, connection: selected.connectionId };
        const { runId: _runId, ...query } = found.target;
        entry = {
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
    );
    const { workflow: _workflow, workspaceApprovals: _approvals, ...remoteApi } = api;
    const accepted = await ask(() => {
      acceptedEpoch = ++epoch;
      entryBinding = { member: member.epoch, connection: selected.connectionId };
      entry = {
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
    }, signal);
    if (!accepted) active = false;
    return false;
  });
  const stop = options.shell.subscribe(() => {
    const session = options.shell.session.getSnapshot();
    if (
      entryBinding &&
      (session.status !== 'authenticated' || session.epoch !== entryBinding.member)
    )
      close();
  });
  const stopBackend = options.backend.subscribe(() => {
    if (
      entryBinding &&
      options.backend.getSnapshot().selection?.connectionId !== entryBinding.connection
    )
      close();
  });
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'zhuma-native-session', inject: () => ({ state }) },
      MemberNativeNavigation,
    ),
  );
  ctx.effect(() => () => {
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
  const [dirty, setDirty] = useState(false);
  const leave = useLeaveConfirmation();
  useEffect(
    () => state.registerLeave((proceed, signal) => leave.request(proceed, dirty, signal)),
    [state, leave, dirty],
  );
  return (
    <>
      {leave.dialog}
      {entry && (
        <Modal
          title={entry.target.title}
          variant="workspace"
          close={() => leave.request(state.close, dirty)}
        >
          <div className="zm-run-workspace-dialog">
            {entry.kind === 'review' ? (
              <NativeReviewHistory
                api={entry.api}
                target={entry.query}
                sessionId={entry.sessionId}
                close={state.close}
              />
            ) : (
              <NativeRunWorkspace
                api={entry.api}
                target={entry.target}
                onDirtyChange={setDirty}
                onClose={() => leave.request(state.close, dirty)}
              />
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
