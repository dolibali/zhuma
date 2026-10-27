import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createIdentityApi,
  createMemberShell,
  SidebarAccountSettingsLauncher,
} from '../../src/identity/index.js';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { createMemberExecutionSpacesReplay } from './member-execution-spaces-probe.jsx';

/** Separate React roots test shared ownership. No sidebar, host layout or Settings is imitated. */
export function createMemberAccountProbe() {
  const replay = createMemberExecutionSpacesReplay();
  const shell = createMemberShell(createIdentityApi(replay.fetcher));
  const footerHost = document.createElement('section');
  footerHost.setAttribute('aria-label', '账号组件契约');
  document.body.insertBefore(footerHost, document.getElementById('root'));
  const footer = createRoot(footerHost);
  function setWide(wide) {
    footerHost.style.width = wide ? '260px' : '56px';
    footer.render(
      <SidebarAccountSettingsLauncher
        shell={shell}
        wide={wide}
        openWork={() => shell.setPageActive(true)}
        settingsOpen={false}
        openSettings={() => {}}
        openOnboarding={() => {}}
      />,
    );
  }
  shell.setPageActive(true);
  shell.start();
  setWide(true);
  window.memberAccountProbe = { shell, replay, setWide };
  window.addEventListener(
    'beforeunload',
    () => {
      shell.stop();
      footer.unmount();
      footerHost.remove();
    },
    { once: true },
  );
  function Main() {
    const snapshot = useSyncExternalStore(shell.subscribe, shell.getSnapshot);
    return (
      <>
        <p>共享会话组件契约；宿主侧栏几何另验。</p>
        <button onClick={() => shell.setPageActive(false)}>卸载工作页</button>
        {snapshot.pageActive ? (
          <MemberExecutionPage shell={shell} fetcher={replay.fetcher} />
        ) : (
          <p>工作页未挂载</p>
        )}
      </>
    );
  }
  return <Main />;
}
