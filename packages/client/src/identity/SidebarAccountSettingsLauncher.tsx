import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import { useEffect, useState } from 'react';
import { AccountTeamsDialog } from './AccountTeamsDialog.js';
import { SettingsIcon } from '../workbench/ControlIcon.js';
import { SidebarAccountFooter } from './SidebarAccountFooter.js';
import type { MemberShell } from './shell.js';

export type SidebarAccountSettingsLauncherProps = SettingsLauncherOwnerProps & {
  readonly shell: MemberShell;
  openWork(): void;
  bindSettingsLauncher?: ((open: () => void) => () => void) | undefined;
  memberLifecycle?: boolean;
  fetcher?: typeof fetch;
};

/** One expanded footer row; two independent 36px rail actions when collapsed. */
export function SidebarAccountSettingsLauncher({
  shell,
  openWork,
  wide,
  settingsOpen,
  settingsShortcut,
  openSettings,
  bindSettingsLauncher,
  memberLifecycle = false,
  fetcher = globalThis.fetch,
}: SidebarAccountSettingsLauncherProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  useEffect(() => bindSettingsLauncher?.(openSettings), [bindSettingsLauncher, openSettings]);
  return (
    <div className="zhuma zm-account-settings" data-wide={wide}>
      <SidebarAccountFooter
        shell={shell}
        wide={wide}
        openWork={openWork}
        manageAccount={
          memberLifecycle ? () => shell.requestLeave(() => setAccountOpen(true)) : undefined
        }
      />
      {accountOpen && (
        <AccountTeamsDialog shell={shell} fetcher={fetcher} close={() => setAccountOpen(false)} />
      )}
      <button
        type="button"
        className="zm-settings-trigger"
        aria-label="设置"
        title="设置"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        aria-keyshortcuts={settingsShortcut?.aria}
        onClick={openSettings}
      >
        <SettingsIcon />
      </button>
    </div>
  );
}
