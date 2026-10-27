import { useEffect, useMemo, useRef, useState } from 'react';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { createIdentityApi } from '../../src/identity/api.js';
import { createMemberShell } from '../../src/identity/shell.js';

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
    if (next === view) return;
    navigation.current.abort();
    const nextNavigation = new AbortController();
    navigation.current = nextNavigation;
    shell.requestLeave(() => {
      if (nextNavigation.signal.aborted) return;
      shell.setPageActive(true, next);
      setView(next);
    }, nextNavigation.signal);
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
