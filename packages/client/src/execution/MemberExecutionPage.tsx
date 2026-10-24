import { useMemo, useRef } from 'react';
import { createIdentityApi } from '../identity/api.js';
import { MemberSessionBoundary } from '../identity/MemberSessionBoundary.js';
import { createExecutionHttpApi } from './http.js';
import { ExecutionWorkspace } from './ExecutionWorkspace.js';

function MemberWork({ fetcher, invalidate }: { fetcher: typeof fetch; invalidate(): void }) {
  const currentInvalidation = useRef(invalidate);
  currentInvalidation.current = invalidate;
  const api = useMemo(
    () => createExecutionHttpApi(fetcher, () => currentInvalidation.current()),
    [fetcher],
  );
  return (
    <main className="zm-page">
      <h1>我的工作</h1>
      <ExecutionWorkspace api={api} />
    </main>
  );
}

/** Formal navigation entry. It never substitutes an owner or a fixture member. */
export function MemberExecutionPage({ fetcher = globalThis.fetch }: { fetcher?: typeof fetch }) {
  const identity = useMemo(() => createIdentityApi(fetcher), [fetcher]);
  return (
    <MemberSessionBoundary api={identity}>
      {(_session, invalidate) => <MemberWork fetcher={fetcher} invalidate={invalidate} />}
    </MemberSessionBoundary>
  );
}
