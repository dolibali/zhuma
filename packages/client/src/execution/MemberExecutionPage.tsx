import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createIdentityApi } from '../identity/api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { MemberSpaceBoundary, type MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
import type { MemberShell } from '../identity/shell.js';
import { createExecutionHttpApi } from './http.js';
import { StartablePlansPanel } from './StartablePlansPanel.js';
import { ExecutionWorkspace } from './ExecutionWorkspace.js';

function MemberWork({
  fetcher,
  accountId,
  spaceId,
  spaceUnavailable,
  lifetime,
}: {
  fetcher: typeof fetch;
  accountId: string;
  spaceId: string;
  spaceUnavailable(): void;
  lifetime: MemberSpaceLifetime;
}) {
  const currentSpaceUnavailable = useRef(spaceUnavailable);
  currentSpaceUnavailable.current = spaceUnavailable;
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const api = useMemo(
    () =>
      createExecutionHttpApi(
        fetcher,
        () => currentLifetime.current.onUnauthenticated(),
        accountId,
        {
          spaceId,
          onUnavailable: () => currentSpaceUnavailable.current(),
          isCurrent: () => currentLifetime.current.isCurrent(),
        },
      ),
    [fetcher, accountId, spaceId],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const started = useCallback(() => setRefreshKey((value) => value + 1), []);
  return (
    <main className="zm-page">
      <h1>我的工作</h1>
      <div className="zm-execution-workspace">
        <StartablePlansPanel api={api} onStarted={started} />
        <ExecutionWorkspace api={api} refreshKey={refreshKey} />
      </div>
    </main>
  );
}

/** Formal navigation entry. It never substitutes an owner or a fixture member. */
const noSubscription = () => () => {};
const noShellSnapshot = () => undefined;
export function MemberExecutionPage({
  fetcher = globalThis.fetch,
  shell,
}: {
  fetcher?: typeof fetch;
  shell?: MemberShell;
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
    (select: (id: string) => void) => shell?.registerSpaceGuard(epoch, select) ?? (() => {}),
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
              />
            )}
          </MemberSpaceBoundary>
        )
      }
    </MemberSessionBoundary>
  );
}
