import { useEffect, useMemo, useState } from 'react';
import {
  createIdentityApi,
  MemberSessionBoundary,
  MemberSpaceBoundary,
} from '../../src/identity/index.js';
import { useUnsavedChanges } from '../../src/workbench/UnsavedChanges.js';

// Boundary-only HTTP replay. This child is not an execution API, workspace or authorization source.
function SpaceContent({ space, invalidate }) {
  const [text, setText] = useState('');
  useUnsavedChanges(!!text);
  useEffect(() => {
    window.memberSpacesProbe ??= { visits: [], invalidations: [] };
    window.memberSpacesProbe.visits.push(space.id);
    window.memberSpacesProbe.invalidations.push(invalidate);
  }, [space.id, invalidate]);
  return (
    <main className="zm-page">
      <h1>{space.name}</h1>
      <p data-testid="space-id">{space.id}</p>
      <label>
        交互夹具输入
        <textarea value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <button onClick={invalidate}>模拟当前空间权限失效</button>
    </main>
  );
}
export function MemberSpacesProbe() {
  const api = useMemo(() => createIdentityApi(), []);
  return (
    <MemberSessionBoundary api={api}>
      {(session, invalidate) => (
        <MemberSpaceBoundary api={api} session={session} onUnauthenticated={invalidate}>
          {(space, invalidateSpace) => <SpaceContent space={space} invalidate={invalidateSpace} />}
        </MemberSpaceBoundary>
      )}
    </MemberSessionBoundary>
  );
}
