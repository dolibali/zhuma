import { useEffect, useMemo } from 'react';
import {
  createIdentityApi,
  createMemberShell,
  SidebarAccountSettingsLauncher,
} from '../../src/identity/index.js';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';

/** Actual member/account components with fixture HTTP; not an imitation of native layout. */
export function MemberProfileProbe({ appearance }) {
  const shell = useMemo(() => createMemberShell(createIdentityApi()), []);
  const view = new URL(location.href).searchParams.has('profile-work') ? 'work' : 'catalog';
  useEffect(() => {
    shell.setPageActive(true, view);
    shell.start();
    window.memberProfileProbe = { getSnapshot: shell.getSnapshot };
    return () => shell.stop();
  }, [shell, view]);
  return (
    <div className="zhuma" style={{ display: 'flex', height: '100%' }}>
      <aside style={{ width: 260, padding: 12, flex: 'none' }}>
        <SidebarAccountSettingsLauncher
          shell={shell}
          wide
          memberLifecycle
          openWork={() => shell.setPageActive(true, 'catalog')}
          settingsOpen={false}
          openSettings={() => {}}
        />
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        <MemberExecutionPage
          shell={shell}
          view={view}
          nativeExecution={false}
          workbenchAppearance={appearance}
        />
      </div>
    </div>
  );
}
