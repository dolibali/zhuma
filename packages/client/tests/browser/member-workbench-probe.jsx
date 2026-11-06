import { useEffect, useMemo, useRef, useState } from 'react';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { createIdentityApi } from '../../src/identity/api.js';
import { createMemberShell } from '../../src/identity/shell.js';
import { requestCatalogReturn } from '../../src/workbench/catalog-return.js';

/** Navigation contract fixture. The official patched LayoutController is tested separately. */
export function MemberWorkbenchProbe({ appearance }) {
  const shell = useMemo(() => createMemberShell(createIdentityApi()), []);
  const [view, setView] = useState('catalog');
  const navigation = useRef(new AbortController());
  useEffect(() => {
    shell.setPageActive(true, 'catalog');
    shell.start();
    return () => {
      navigation.current.abort();
      shell.stop();
    };
  }, [shell]);
  function select(next) {
    navigation.current.abort();
    const nextNavigation = new AbortController();
    navigation.current = nextNavigation;
    const finish = () => {
      if (nextNavigation.signal.aborted || next === view) return;
      shell.setPageActive(true, next);
      setView(next);
    };
    // The real sidebar still selects the already-open team workbench. That
    // reselect must leave task detail instead of returning before any guard.
    if (next === view && next === 'catalog' && requestCatalogReturn(nextNavigation.signal, finish))
      return;
    if (next === view) return;
    shell.requestLeave(finish, nextNavigation.signal);
  }
  return (
    <div className="zhuma" style={{ display: 'flex' }}>
      <nav aria-label="成员入口（契约夹具）" style={{ width: 160, flex: 'none', padding: 12 }}>
        <button
          aria-current={view === 'catalog' ? 'page' : undefined}
          onClick={() => select('catalog')}
        >
          团队工作台
        </button>
        <button aria-current={view === 'work' ? 'page' : undefined} onClick={() => select('work')}>
          我的工作
        </button>
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>
        <MemberExecutionPage
          key={view}
          shell={shell}
          view={view}
          workbenchAppearance={appearance}
          openWork={() => select('work')}
        />
      </div>
    </div>
  );
}
