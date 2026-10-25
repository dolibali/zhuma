import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

function MemberWork({
  fetcher,
  accountId,
  spaceId,
  spaceUnavailable,
  lifetime,
  appearance,
}: {
  fetcher: typeof fetch;
  accountId: string;
  spaceId: string;
  spaceUnavailable(): void;
  lifetime: MemberSpaceLifetime;
  appearance?: AppearanceStore;
}) {
  const currentSpaceUnavailable = useRef(spaceUnavailable);
  currentSpaceUnavailable.current = spaceUnavailable;
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const [view, setView] = useState<'catalog' | 'work'>(appearance ? 'catalog' : 'work');
  const presentation = useRef<object>({});
  const currentPresentation = presentation.current;
  const api = useMemo(
    () =>
      createExecutionHttpApi(
        fetcher,
        () => currentLifetime.current.onUnauthenticated(),
        accountId,
        {
          spaceId,
          onUnavailable: () => currentSpaceUnavailable.current(),
          isCurrent: () =>
            currentLifetime.current.isCurrent() &&
            view === 'work' &&
            presentation.current === currentPresentation,
        },
      ),
    [fetcher, accountId, spaceId, view, currentPresentation],
  );
  const workbench = useMemo(
    () =>
      createMemberWorkbenchAdapter(
        createMemberWorkbenchApi(
          {
            actorId: accountId,
            spaceId,
            isCurrent: () =>
              currentLifetime.current.isCurrent() &&
              view === 'catalog' &&
              presentation.current === currentPresentation,
            onUnauthenticated: () => currentLifetime.current.onUnauthenticated(),
            onUnavailable: () => currentSpaceUnavailable.current(),
          },
          fetcher,
        ),
        accountId,
      ),
    [fetcher, accountId, spaceId, view, currentPresentation],
  );
  function selectView(next: 'catalog' | 'work') {
    if (next === view || !currentLifetime.current.isCurrent()) return;
    if (
      currentLifetime.current.hasUnsavedChanges?.() &&
      !confirm('有未保存的内容，确定切换吗？已发送的操作仍可能完成。')
    )
      return;
    presentation.current = {};
    setView(next);
  }
  const [refreshKey, setRefreshKey] = useState(0);
  const started = useCallback(() => setRefreshKey((value) => value + 1), []);
  return (
    <div className="zm-member-work">
      {appearance && (
        <nav className="zm-tabs zm-member-views" aria-label="工作内容">
          <button
            aria-current={view === 'catalog' ? 'page' : undefined}
            onClick={() => selectView('catalog')}
          >
            项目与任务
          </button>
          <button
            aria-current={view === 'work' ? 'page' : undefined}
            onClick={() => selectView('work')}
          >
            待我处理
          </button>
        </nav>
      )}
      {appearance && view === 'catalog' ? (
        <div className="zm-member-catalog">
          <WorkbenchPage
            api={workbench}
            initialSection="tasks"
            appearance={appearance}
            openWork={() => selectView('work')}
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
}: {
  fetcher?: typeof fetch;
  shell?: MemberShell;
  workbenchAppearance?: AppearanceStore;
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
                fetcher={fetcher}
                accountId={session.accountId}
                spaceId={space.id}
                spaceUnavailable={spaceUnavailable}
                lifetime={lifetime}
                {...(workbenchAppearance ? { appearance: workbenchAppearance } : {})}
              />
            )}
          </MemberSpaceBoundary>
        )
      }
    </MemberSessionBoundary>
  );
}
