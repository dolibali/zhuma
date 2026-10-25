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
}: {
  fetcher: typeof fetch;
  accountId: string;
  spaceId: string;
  spaceUnavailable(): void;
  lifetime: MemberSpaceLifetime;
  appearance?: AppearanceStore;
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
            {...(openWork ? { openWork } : {})}
          />
        </div>
      ) : (
        <main className="zm-page">
          <h1>我的工作</h1>
          <div className="zm-execution-workspace">
            <StartablePlansPanel api={api} onStarted={started} />
            <ExecutionWorkspace api={api} refreshKey={refreshKey} />
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
  workbenchAppearance,
  view,
  openWork,
}: {
  fetcher?: typeof fetch;
  shell?: MemberShell;
  workbenchAppearance?: AppearanceStore;
  view?: 'catalog' | 'work';
  openWork?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    shell?.subscribe ?? noSubscription,
    shell?.getSnapshot ?? noShellSnapshot,
    shell?.getSnapshot ?? noShellSnapshot,
  );
  const epoch = snapshot?.pageEpoch ?? 0;
  const pageCurrent = useCallback(
    () => (shell ? shell.isPageCurrent(epoch) : true),
    [shell, epoch],
  );
  const registerSwitchGuard = useCallback(
    (select: SpaceSwitch) => shell?.registerSpaceGuard(epoch, select) ?? (() => {}),
    [shell, epoch],
  );
  const registerLeaveGuard = useCallback(
    (leave: (proceed: () => void, signal?: AbortSignal) => void) =>
      shell?.registerLeaveGuard(epoch, leave) ?? (() => {}),
    [shell, epoch],
  );
  const identity = useMemo(() => shell?.api ?? createIdentityApi(fetcher), [fetcher, shell]);
  return (
    <MemberSessionBoundary api={identity} controller={shell?.session} showAccountHeader={!shell}>
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
                {...(workbenchAppearance ? { appearance: workbenchAppearance } : {})}
              />
            )}
          </MemberSpaceBoundary>
        )
      }
    </MemberSessionBoundary>
  );
}
