import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MemberExecutionPage } from '../execution/MemberExecutionPage.js';
import { createIdentityApi } from '../identity/api.js';
import { createMemberShell } from '../identity/shell.js';
import { SidebarAccountFooter } from '../identity/SidebarAccountFooter.js';
import { AccountTeamsDialog } from '../identity/AccountTeamsDialog.js';
import { Button } from '../workbench/Button.js';
import type { AppearancePreference, AppearanceStore } from '../workbench/Appearance.js';
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
  const [view, setView] = useState<'catalog' | 'work'>('catalog');
  const snapshot = useSyncExternalStore(shell.subscribe, shell.getSnapshot, shell.getSnapshot);
  useEffect(() => {
    shell.start();
    return () => shell.stop();
  }, []);
  useEffect(() => shell.setPageActive(true, view), [view]);
  const navigate = (next: typeof view) => shell.requestLeave(() => setView(next));
  const signedIn = snapshot.session.status === 'authenticated';
  return (
    <div className="zm-web-shell">
      {signedIn && (
        <aside className="zm-web-sidebar" aria-label="工作台导航">
          <a className="zm-web-brand" href="/workbench">
            Zhuma
          </a>
          <nav>
            <Button
              variant="quiet"
              aria-current={view === 'catalog' ? 'page' : undefined}
              onClick={() => navigate('catalog')}
            >
              团队工作台
            </Button>
            <Button
              variant="quiet"
              aria-current={view === 'work' ? 'page' : undefined}
              onClick={() => navigate('work')}
            >
              我的工作
            </Button>
          </nav>
          <div className="zm-web-account">
            <SidebarAccountFooter
              shell={shell}
              wide
              openWork={() => navigate('work')}
              manageAccount={() => shell.requestLeave(() => setAccountOpen(true))}
            />
          </div>
        </aside>
      )}
      <div className="zm-web-main">
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
