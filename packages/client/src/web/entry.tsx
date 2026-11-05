import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MemberExecutionPage } from '../execution/MemberExecutionPage.js';
import { createIdentityApi } from '../identity/api.js';
import { createMemberShell } from '../identity/shell.js';
import { SidebarAccountFooter } from '../identity/SidebarAccountFooter.js';
import { AccountTeamsDialog } from '../identity/AccountTeamsDialog.js';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SettingsIcon } from '../workbench/ControlIcon.js';
import {
  Appearance,
  type AppearancePreference,
  type AppearanceStore,
} from '../workbench/Appearance.js';
import workbenchStyles from '../workbench/workbench.css';
import flowStyles from '@xyflow/react/dist/style.css';
import nativeRunStyles from '../run/NativeRunPanel.css';
import webStyles from './web.css';

const shell = createMemberShell(createIdentityApi());
let preference: AppearancePreference = 'system';
try {
  const saved = localStorage.getItem('zhuma-web-appearance');
  if (saved === 'light' || saved === 'dark') preference = saved;
} catch {
  /* Presentation remains usable with browser storage disabled. */
}
const appearanceListeners = new Set<() => void>();
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyAppearance() {
  document.body.toggleAttribute(
    'data-ds-dark-theme',
    preference === 'dark' || (preference === 'system' && systemTheme.matches),
  );
}
systemTheme.addEventListener('change', applyAppearance);
applyAppearance();
const appearance: AppearanceStore = {
  getSnapshot: () => preference,
  subscribe: (listener) => {
    appearanceListeners.add(listener);
    return () => {
      appearanceListeners.delete(listener);
    };
  },
  set: (value) => {
    preference = value;
    try {
      localStorage.setItem('zhuma-web-appearance', value);
    } catch {
      /* Session-only preference. */
    }
    applyAppearance();
    appearanceListeners.forEach((listener) => listener());
  },
};

/** Only product HTTP APIs are loaded; this entry has no SDK owner Connection. */
function MemberWeb() {
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<'catalog' | 'work'>('catalog');
  const snapshot = useSyncExternalStore(shell.subscribe, shell.getSnapshot, shell.getSnapshot);
  const signedIn = snapshot.session.status === 'authenticated';
  useEffect(() => {
    shell.start();
    return () => shell.stop();
  }, []);
  useEffect(() => shell.setPageActive(true, view), [view]);
  useEffect(() => {
    if (!signedIn) {
      setSettingsOpen(false);
      setAccountOpen(false);
    }
  }, [signedIn]);
  const navigate = (next: typeof view) => shell.requestLeave(() => setView(next));
  const manageAccount = () =>
    shell.requestLeave(() => {
      setSettingsOpen(false);
      setAccountOpen(true);
    });
  return (
    <div className="zhuma zm-web-shell">
      {signedIn && (
        <aside className="zm-web-sidebar" aria-label="工作台导航">
          <div className="zm-web-identity">
            <a className="zm-web-brand" href="/workbench">
              Zhuma
            </a>
            <span className="zm-web-context">共享工作台</span>
          </div>
          <nav>
            <Button
              variant="quiet"
              aria-current={view === 'catalog' ? 'page' : undefined}
              onClick={() => navigate('catalog')}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <path d="M14 17.5h7m-3.5-3.5v7" />
              </svg>
              团队工作台
            </Button>
            <Button
              variant="quiet"
              aria-current={view === 'work' ? 'page' : undefined}
              onClick={() => navigate('work')}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2" />
              </svg>
              我的工作
            </Button>
          </nav>
          <p className="zm-web-local-context">工作区和 Agent 会话在本机 Zhuma 中打开。</p>
          <div className="zm-web-account">
            <div className="zhuma zm-account-settings" data-wide="true">
              <SidebarAccountFooter
                shell={shell}
                wide
                openWork={() => navigate('work')}
                manageAccount={manageAccount}
              />
              <button
                type="button"
                className="zm-settings-trigger"
                aria-label="设置"
                title="设置"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(true)}
              >
                <SettingsIcon />
              </button>
            </div>
          </div>
        </aside>
      )}
      <div className="zm-web-main">
        {signedIn && settingsOpen && (
          <Modal title="设置" close={() => setSettingsOpen(false)}>
            <div className="zhuma zm-form-body">
              <section aria-label="外观设置">
                <h3>外观</h3>
                <Appearance store={appearance} />
              </section>
              <Button onClick={manageAccount}>账号与团队</Button>
            </div>
          </Modal>
        )}
        {accountOpen && <AccountTeamsDialog shell={shell} close={() => setAccountOpen(false)} />}
        <MemberExecutionPage
          shell={shell}
          view={view}
          workbenchAppearance={appearance}
          openWork={() => navigate('work')}
          nativeExecution={false}
          allowRegistration
        />
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `${flowStyles}\n${workbenchStyles}\n${nativeRunStyles}\n${webStyles}`;
document.head.append(style);
const target = document.getElementById('zhuma-member-root');
if (!target) throw new Error('Member entry is unavailable');
createRoot(target).render(<MemberWeb />);
