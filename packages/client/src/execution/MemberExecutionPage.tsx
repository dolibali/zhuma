import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createIdentityApi } from '../identity/api.js';
import { createIdentityLifecycleApi } from '../identity/lifecycle-api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { MemberSpaceBoundary, type MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import type { MemberShell, SpaceSwitch } from '../identity/shell.js';
import { createExecutionHttpApi } from './http.js';
import { StartablePlansPanel } from './StartablePlansPanel.js';
import { ExecutionWorkspace } from './ExecutionWorkspace.js';
import type { AppearanceStore } from '../workbench/Appearance.js';
import { WorkbenchPage } from '../workbench/WorkbenchPage.js';
import { createMemberWorkbenchApi } from '../workbench/member-api.js';
import { createMemberWorkbenchAdapter } from '../workbench/member-adapter.js';
import { useLeaveConfirmation } from '../workbench/useLeaveConfirmation.js';
import { createNativeRunApi } from '../run/api.js';
import type { RegisterWorkspaceDirectory } from '../run/workspace-approvals.js';
import type { LocalWorkspaceDirectory } from '../run/workspace-directory.js';
import { createKnowledgeApi } from '../knowledge/api.js';
import { createProjectKnowledgeApi } from '../knowledge/project-knowledge-api.js';
import type { MemberNativeClient } from '../run/member-native.js';
import { createNativeReviewApi } from '../run/review-api.js';

function MemberWork({
  fetcher,
  accountId,
  spaceId,
  spaceUnavailable,
  lifetime,
  appearance,
  view,
  openWork,
  registerLeaveGuard,
  registerWorkspaceDirectory,
  localDirectory,
  openModelSettings,
  nativeExecution,
  memberNative,
}: {
  fetcher: typeof fetch;
  accountId: string;
  spaceId: string;
  spaceUnavailable(): void;
  lifetime: MemberSpaceLifetime;
  appearance?: AppearanceStore;
  registerWorkspaceDirectory?: RegisterWorkspaceDirectory | undefined;
  localDirectory?: LocalWorkspaceDirectory | undefined;
  openModelSettings?: (() => void) | undefined;
  nativeExecution: boolean;
  memberNative?: MemberNativeClient | undefined;
  view: 'catalog' | 'work';
  openWork?: (() => void) | undefined;
  registerLeaveGuard?:
    ((leave: (proceed: () => void, signal?: AbortSignal) => void) => () => void) | undefined;
}) {
  const currentSpaceUnavailable = useRef(spaceUnavailable);
  currentSpaceUnavailable.current = spaceUnavailable;
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const alive = useRef(true);
  // Restore before child passive effects start requests during StrictMode replay.
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const leaveConfirmation = useLeaveConfirmation(
    () => alive.current && currentLifetime.current.isCurrent(),
  );
  useEffect(
    () =>
      registerLeaveGuard?.((proceed, signal) => {
        leaveConfirmation.request(
          proceed,
          currentLifetime.current.hasUnsavedChanges?.() ?? false,
          signal,
        );
      }),
    [registerLeaveGuard, leaveConfirmation.request],
  );
  const api = useMemo(
    () =>
      createExecutionHttpApi(
        fetcher,
        () => currentLifetime.current.onUnauthenticated(),
        accountId,
        {
          spaceId,
          onUnavailable: () => currentSpaceUnavailable.current(),
          isCurrent: () => alive.current && currentLifetime.current.isCurrent() && view === 'work',
        },
      ),
    [fetcher, accountId, spaceId, view],
  );
  const workbench = useMemo(
    () =>
      createMemberWorkbenchAdapter(
        createMemberWorkbenchApi(
          {
            actorId: accountId,
            spaceId,
            isCurrent: () =>
              alive.current && currentLifetime.current.isCurrent() && view === 'catalog',
            onUnauthenticated: () => currentLifetime.current.onUnauthenticated(),
            onUnavailable: () => currentSpaceUnavailable.current(),
          },
          fetcher,
        ),
        accountId,
      ),
    [fetcher, accountId, spaceId, view],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const projectExecution = useMemo(
    () =>
      createExecutionHttpApi(
        fetcher,
        () => currentLifetime.current.onUnauthenticated(),
        accountId,
        {
          spaceId,
          isCurrent: () =>
            alive.current && currentLifetime.current.isCurrent() && view === 'catalog',
          onUnavailable: () => currentSpaceUnavailable.current(),
        },
      ),
    [fetcher, accountId, spaceId, view],
  );
  const projectContext = useMemo(
    () => ({ api: projectExecution, spaceId }),
    [projectExecution, spaceId],
  );
  const nativeApi = useMemo(() => {
    const nativeFetcher = memberNative?.scoped(accountId, spaceId).fetcher ?? fetcher;
    const api = createNativeRunApi(
      nativeFetcher,
      accountId,
      {
        spaceId,
        isCurrent: () => alive.current && currentLifetime.current.isCurrent(),
        onUnavailable: () => currentSpaceUnavailable.current(),
      },
      () => currentLifetime.current.onUnauthenticated(),
      registerWorkspaceDirectory,
      openModelSettings,
      localDirectory,
      !!memberNative,
    );
    if (!memberNative) return api;
    const { workspaceApprovals: _approvals, ...localNativeApi } = api;
    return {
      ...localNativeApi,
      review: createNativeReviewApi(
        nativeFetcher,
        accountId,
        {
          spaceId,
          isCurrent: () => alive.current && currentLifetime.current.isCurrent(),
          onUnavailable: () => currentSpaceUnavailable.current(),
        },
        () => currentLifetime.current.onUnauthenticated(),
      ),
    };
  }, [
    fetcher,
    accountId,
    spaceId,
    view,
    registerWorkspaceDirectory,
    openModelSettings,
    localDirectory,
    memberNative,
  ]);
  const nativeRun = useMemo(() => ({ api: nativeApi, spaceId }), [nativeApi, spaceId]);
  const knowledgeApi = useMemo(() => {
    const scope = {
      actorId: accountId,
      spaceId,
      isCurrent: () => alive.current && currentLifetime.current.isCurrent() && view === 'catalog',
      onUnauthenticated: () => currentLifetime.current.onUnauthenticated(),
    };
    return {
      api: createKnowledgeApi(scope, fetcher),
      projectApi: createProjectKnowledgeApi(scope, fetcher),
    };
  }, [fetcher, accountId, spaceId, view]);
  const started = useCallback(() => setRefreshKey((value) => value + 1), []);
  return (
    <div className="zm-member-work">
      {leaveConfirmation.dialog}
      {appearance && view === 'catalog' ? (
        <div className="zm-member-catalog">
          <WorkbenchPage
            api={workbench}
            initialSection="tasks"
            appearance={appearance}
            knowledge={{ ...knowledgeApi, actorId: accountId, spaceId, lifetime }}
            {...(nativeExecution ? { nativeRun } : {})}
            projectExecution={projectContext}
            {...(openWork ? { openWork } : {})}
          />
        </div>
      ) : (
        <main className="zm-page">
          <h1>我的工作</h1>
          <div className="zm-execution-workspace">
            <StartablePlansPanel api={api} onStarted={started} />
            <ExecutionWorkspace
              api={api}
              refreshKey={refreshKey}
              {...(nativeExecution ? { nativeRun } : {})}
            />
          </div>
        </main>
      )}
    </div>
  );
}

/** Formal navigation entry. It never substitutes an owner or a fixture member. */
const noSubscription = () => () => {};
const noShellSnapshot = () => undefined;
export function MemberExecutionPage({
  fetcher = globalThis.fetch,
  shell,
  pageKey,
  workbenchAppearance,
  view,
  openWork,
  registerWorkspaceDirectory,
  localDirectory,
  openModelSettings,
  nativeExecution = true,
  memberNative,
  allowRegistration = false,
}: {
  fetcher?: typeof fetch;
  shell?: MemberShell;
  /** Official slots may retain hidden panels; only this panel owns its UI lifetime. */
  pageKey?: string;
  workbenchAppearance?: AppearanceStore;
  view?: 'catalog' | 'work';
  openWork?: () => void;
  registerWorkspaceDirectory?: RegisterWorkspaceDirectory | undefined;
  localDirectory?: LocalWorkspaceDirectory | undefined;
  openModelSettings?: (() => void) | undefined;
  /** Web members do not implicitly run an Agent on the backend machine. */
  nativeExecution?: boolean;
  memberNative?: MemberNativeClient | undefined;
  allowRegistration?: boolean;
}) {
  const snapshot = useSyncExternalStore(
    shell?.subscribe ?? noSubscription,
    shell?.getSnapshot ?? noShellSnapshot,
    shell?.getSnapshot ?? noShellSnapshot,
  );
  const epoch = snapshot?.pageEpoch ?? 0;
  const pageCurrent = useCallback(
    () => (shell ? shell.isPageCurrent(epoch, pageKey) : true),
    [shell, epoch, pageKey],
  );
  const registerSwitchGuard = useCallback(
    (select: SpaceSwitch) => shell?.registerSpaceGuard(epoch, select, pageKey) ?? (() => {}),
    [shell, epoch, pageKey],
  );
  const registerLeaveGuard = useCallback(
    (leave: (proceed: () => void, signal?: AbortSignal) => void) =>
      shell?.registerLeaveGuard(epoch, leave, pageKey) ?? (() => {}),
    [shell, epoch, pageKey],
  );
  const identity = useMemo(() => shell?.api ?? createIdentityApi(fetcher), [fetcher, shell]);
  const lifecycle = useMemo(() => createIdentityLifecycleApi(fetcher), [fetcher]);
  // Two replacement controllers can share the same account, space and numeric
  // epoch. Their forms and captured handlers must still have separate lifetimes.
  const controllers = useRef({
    identity,
    session: shell?.session,
    space: shell?.space,
    generation: 0,
  });
  if (
    controllers.current.identity !== identity ||
    controllers.current.session !== shell?.session ||
    controllers.current.space !== shell?.space
  ) {
    controllers.current = {
      identity,
      session: shell?.session,
      space: shell?.space,
      generation: controllers.current.generation + 1,
    };
  }
  return (
    <MemberSessionBoundary
      key={controllers.current.generation}
      api={identity}
      controller={shell?.session}
      showAccountHeader={!shell}
      registerAccount={allowRegistration ? lifecycle.register : undefined}
    >
      {(session, invalidate, isSessionCurrent) =>
        shell && !shell.space ? (
          <div role="status">正在确认工作空间…</div>
        ) : (
          <MemberSpaceBoundary
            key={epoch}
            api={identity}
            session={session}
            onUnauthenticated={invalidate}
            isSessionCurrent={isSessionCurrent}
            controller={shell?.space}
            isPageCurrent={pageCurrent}
            registerSwitchGuard={shell ? registerSwitchGuard : undefined}
          >
            {(space, spaceUnavailable, lifetime) => (
              <MemberWork
                key={view ?? (workbenchAppearance ? 'catalog' : 'work')}
                fetcher={fetcher}
                accountId={session.accountId}
                spaceId={space.id}
                spaceUnavailable={spaceUnavailable}
                lifetime={lifetime}
                view={view ?? (workbenchAppearance ? 'catalog' : 'work')}
                openWork={openWork}
                registerLeaveGuard={shell ? registerLeaveGuard : undefined}
                registerWorkspaceDirectory={registerWorkspaceDirectory}
                localDirectory={localDirectory}
                openModelSettings={openModelSettings}
                nativeExecution={nativeExecution}
                memberNative={memberNative}
                {...(workbenchAppearance ? { appearance: workbenchAppearance } : {})}
              />
            )}
          </MemberSpaceBoundary>
        )
      }
    </MemberSessionBoundary>
  );
}
