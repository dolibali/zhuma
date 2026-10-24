import { useCallback, useMemo, useRef, useState } from 'react';
import { createIdentityApi } from '../identity/api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { MemberSpaceBoundary } from '../identity/MemberSpaceBoundary.js';
import { createExecutionHttpApi } from './http.js';
import { StartablePlansPanel } from './StartablePlansPanel.js';
import { ExecutionWorkspace } from './ExecutionWorkspace.js';

function MemberWork({
  fetcher,
  invalidate,
  accountId,
  spaceId,
  spaceUnavailable,
}: {
  fetcher: typeof fetch;
  invalidate(): void;
  accountId: string;
  spaceId: string;
  spaceUnavailable(): void;
}) {
  const currentInvalidation = useRef(invalidate);
  currentInvalidation.current = invalidate;
  const currentSpaceUnavailable = useRef(spaceUnavailable);
  currentSpaceUnavailable.current = spaceUnavailable;
  const api = useMemo(
    () =>
      createExecutionHttpApi(fetcher, () => currentInvalidation.current(), accountId, {
        spaceId,
        onUnavailable: () => currentSpaceUnavailable.current(),
      }),
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
      {(session, invalidate) => (
        <MemberSpaceBoundary api={identity} session={session} onUnauthenticated={invalidate}>
          {(space, spaceUnavailable) => (
            <MemberWork
              fetcher={fetcher}
              invalidate={invalidate}
              accountId={session.accountId}
              spaceId={space.id}
              spaceUnavailable={spaceUnavailable}
            />
          )}
        </MemberSpaceBoundary>
      )}
    </MemberSessionBoundary>
  );
}
