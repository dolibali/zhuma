import { useCallback, useMemo, useRef, useState } from 'react';
import { createIdentityApi } from '../identity/api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { createExecutionHttpApi } from './http.js';
import { StartablePlansPanel } from './StartablePlansPanel.js';
import { ExecutionWorkspace } from './ExecutionWorkspace.js';

function MemberWork({
  fetcher,
  invalidate,
  accountId,
}: {
  fetcher: typeof fetch;
  invalidate(): void;
  accountId: string;
}) {
  const currentInvalidation = useRef(invalidate);
  currentInvalidation.current = invalidate;
  const api = useMemo(
    () => createExecutionHttpApi(fetcher, () => currentInvalidation.current(), accountId),
    [fetcher, accountId],
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
        <MemberWork fetcher={fetcher} invalidate={invalidate} accountId={session.accountId} />
      )}
    </MemberSessionBoundary>
  );
}
