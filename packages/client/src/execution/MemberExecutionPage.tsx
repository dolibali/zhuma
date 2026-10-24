import { useCallback, useMemo, useRef, useState } from 'react';
import { createIdentityApi } from '../identity/api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { MemberSpaceBoundary, type MemberSpaceLifetime } from '../identity/MemberSpaceBoundary.js';
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
export function MemberExecutionPage({ fetcher = globalThis.fetch }: { fetcher?: typeof fetch }) {
  const identity = useMemo(() => createIdentityApi(fetcher), [fetcher]);
  return (
    <MemberSessionBoundary api={identity}>
      {(session, invalidate, isSessionCurrent) => (
        <MemberSpaceBoundary
          api={identity}
          session={session}
          onUnauthenticated={invalidate}
          isSessionCurrent={isSessionCurrent}
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
      )}
    </MemberSessionBoundary>
  );
}
