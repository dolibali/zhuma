import type { Context } from '@deepseek-ai/cordis';
import type { ComponentProps } from 'react';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-theme/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client';
import type { AppearanceStore } from './Appearance.js';
import { createWorkbenchApi } from './api.js';
import { WorkbenchPage } from './WorkbenchPage.js';
import { MemberExecutionPage } from '../execution/MemberExecutionPage.js';
import { createIdentityApi } from '../identity/api.js';
import { createMemberShell } from '../identity/shell.js';
import { SidebarAccountSettingsLauncher } from '../identity/SidebarAccountSettingsLauncher.js';
import { LocalSetupBoundary, enterTeamAfterLocalSetup } from '../identity/LocalSetupBoundary.js';
import workbenchStyles from './workbench.css';
import flowStyles from '@xyflow/react/dist/style.css';
import nativeRunStyles from '../run/NativeRunPanel.css';
import {
  createLocalWorkspaceDirectory,
  createWorkspaceDirectoryRegistrar,
} from '../run/workspace-directory.js';
import { ExecutionError } from '../execution/ExecutionApi.js';
import { createSharedBackendClient } from '../identity/shared-backend.js';
import { SharedBackendBoundary } from '../identity/SharedBackendBoundary.js';
import { createMemberNativeClient } from '../run/member-native.js';
import { installMemberNativeNavigation } from '../run/MemberNativeNavigation.js';

export const inject = ['slots', 'layout', 'connection', 'theme', 'uiWorkspace'];
function deploymentMode(): 'legacy-single-user' | 'multi-member' {
  const boot = (globalThis as { __ZHUMA_WORKBENCH_BOOT__?: unknown }).__ZHUMA_WORKBENCH_BOOT__;
  if (
    typeof boot === 'object' &&
    boot !== null &&
    !Array.isArray(boot) &&
    Object.keys(boot).every((key) =>
      ['version', 'deploymentMode', 'localSetup', 'sharedBackend'].includes(key),
    ) &&
    (!('localSetup' in boot) || boot.localSetup === true) &&
    (!('sharedBackend' in boot) ||
      (boot.sharedBackend === true &&
        'localSetup' in boot &&
        boot.localSetup === true &&
        'deploymentMode' in boot &&
        boot.deploymentMode === 'multi-member')) &&
    'version' in boot &&
    boot.version === 1 &&
    'deploymentMode' in boot &&
    (boot.deploymentMode === 'legacy-single-user' || boot.deploymentMode === 'multi-member')
  )
    return boot.deploymentMode;
  throw new Error('Invalid workbench boot configuration');
}
export function apply(ctx: Context): void {
  const mode = deploymentMode();
  const localSetup =
    mode === 'multi-member' &&
    (globalThis as { __ZHUMA_WORKBENCH_BOOT__?: { localSetup?: unknown } }).__ZHUMA_WORKBENCH_BOOT__
      ?.localSetup === true;
  const layout = ctx.layout as typeof ctx.layout & {
    registerPanelGuard?: (
      guard: (target: MainPanelId | null, proceed: () => void, signal: AbortSignal) => void,
    ) => () => void;
  };
  if (mode === 'multi-member' && !layout.registerPanelGuard)
    throw new Error('成员工作台需要更新配套界面，请刷新 Zhuma 发行文件后重试。');
  const connection = ctx.get(
    'connection',
  ) as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle;
  const api = createWorkbenchApi(connection.rpc);
  let memberShell: ReturnType<typeof createMemberShell>;
  const restoreBackendMember = () => {
    memberShell.session.invalidate();
    const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
    const memberPage = active === 'zhuma-my-work' || active === 'zhuma-workbench';
    memberShell.setPageActive(false);
    memberShell.setPageActive(memberPage, memberPage ? active : undefined);
    void memberShell.session.restore();
  };
  const sharedBackend =
    localSetup &&
    (globalThis as { __ZHUMA_WORKBENCH_BOOT__?: { sharedBackend?: unknown } })
      .__ZHUMA_WORKBENCH_BOOT__?.sharedBackend === true
      ? createSharedBackendClient(connection.rpc, restoreBackendMember)
      : undefined;
  const memberFetch = sharedBackend?.fetcher ?? globalThis.fetch;
  const memberNative = sharedBackend ? createMemberNativeClient(sharedBackend) : undefined;
  memberShell = createMemberShell(createIdentityApi(memberFetch));
  if (sharedBackend) ctx.effect(() => () => sharedBackend.close());
  const registerWorkspaceDirectory = createWorkspaceDirectoryRegistrar(ctx);
  const originalLocalDirectory = createLocalWorkspaceDirectory(ctx);
  // Native task Sessions require C's scoped continuation registration before
  // exposing ordinary Conversation navigation. The existing directory reader
  // is safe independently: selection never registers a directory or starts work.
  const localDirectory = sharedBackend
    ? originalLocalDirectory
    : { read: originalLocalDirectory.read };
  let settingsLauncher: (() => void) | undefined;
  const bindSettingsLauncher = (open: () => void) => {
    settingsLauncher = open;
    return () => {
      if (settingsLauncher === open) settingsLauncher = undefined;
    };
  };
  const openModelSettings = () => {
    ctx.fiber.assertActive();
    if (!settingsLauncher)
      throw new ExecutionError('unavailable', '设置入口暂不可用，请稍后重试。');
    settingsLauncher();
  };
  if (sharedBackend && memberNative)
    installMemberNativeNavigation(ctx, {
      shell: memberShell,
      backend: sharedBackend,
      native: memberNative,
      directory: originalLocalDirectory,
      openModelSettings,
    });
  const executionPanel = 'zhuma-my-work' as MainPanelId;
  const workbenchPanel = 'zhuma-workbench' as MainPanelId;
  ctx.effect(() => {
    const syncPage = () => {
      const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
      const memberPage =
        active === executionPanel || (mode === 'multi-member' && active === workbenchPanel);
      memberShell.setPageActive(memberPage, memberPage ? active : undefined);
    };
    syncPage();
    const unsubscribe = ctx.layout.panelInfo.subscribe(syncPage);
    memberShell.start();
    return () => {
      unsubscribe();
      memberShell.stop();
    };
  });
  if (mode === 'multi-member')
    ctx.effect(() =>
      layout.registerPanelGuard!((target, proceed, signal) => {
        if (target === layout.panelInfo.getSnapshot().activePanelId) proceed();
        else memberShell.requestLeave(proceed, signal);
      }),
    );
  const appearance: AppearanceStore = {
    getSnapshot: () => ctx.theme.getTheme().preference,
    subscribe: (listener) => ctx.on('theme/change', listener),
    set: (preference) => ctx.theme.setTheme(preference),
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = `${flowStyles}\n${workbenchStyles}\n${nativeRunStyles}`;
    document.head.append(style);
    return () => style.remove();
  });
  const legacyPanels = [
    {
      id: 'zhuma-workbench',
      label: '团队工作台',
      section: 'tasks',
      expertLibrary: false,
      order: -100,
    },
    { id: 'zhuma-experts', label: '专家', section: 'assets', expertLibrary: true, order: -90 },
  ] as const;
  for (const panel of mode === 'legacy-single-user' ? legacyPanels : []) {
    const panelId = panel.id as MainPanelId;
    ctx.slots.inject('main', () => {
      const dispose = ctx.slots.register(
        {
          name: 'main',
          key: panelId,
          inject: () => ({
            api,
            appearance,
            initialSection: panel.section,
            expertLibrary: panel.expertLibrary,
            legacyMode: true,
          }),
        },
        (props: ComponentProps<typeof WorkbenchPage>) => (
          <div className="zm-shell-panel">
            <div className="zm-shell-chrome" data-window-drag aria-hidden="true" />
            <WorkbenchPage {...props} />
          </div>
        ),
      );
      // Only the workbench is the initial landing; opening a catalog never starts work.
      if (!panel.expertLibrary && ctx.layout.panelInfo.getSnapshot().activePanelId === null)
        ctx.layout.selectPanel(panelId);
      return () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === panelId)
          ctx.layout.selectPanel(null);
        dispose();
      };
    });
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: panelId, order: panel.order, label: panel.label },
        () => (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            {panel.expertLibrary ? (
              <>
                <path d="M4 4h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v15h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4z" />
                <path d="M12 5v15" />
              </>
            ) : (
              <>
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <path d="M14 17.5h7m-3.5-3.5v7" />
              </>
            )}
          </svg>
        ),
      ),
    );
  }
  const memberPanels =
    mode === 'multi-member'
      ? [
          { id: workbenchPanel, label: '团队工作台', view: 'catalog' as const, order: -100 },
          { id: executionPanel, label: '我的工作', view: 'work' as const, order: -95 },
        ]
      : [{ id: executionPanel, label: '我的工作', view: 'work' as const, order: -95 }];
  for (const panel of memberPanels) {
    ctx.slots.inject('main', () => {
      const dispose = ctx.slots.register(
        { name: 'main', key: panel.id, inject: () => ({}) },
        () => {
          const content = (remote: boolean) => (
            <div className="zm-shell-panel">
              <div className="zm-shell-chrome" data-window-drag aria-hidden="true" />
              <MemberExecutionPage
                key={sharedBackend?.getSnapshot().selection?.connectionId ?? 'local'}
                fetcher={memberFetch}
                shell={memberShell}
                pageKey={panel.id}
                nativeExecution={!remote || !!memberNative}
                memberNative={remote ? memberNative : undefined}
                allowRegistration={mode === 'multi-member'}
                registerWorkspaceDirectory={registerWorkspaceDirectory}
                localDirectory={localDirectory}
                openModelSettings={openModelSettings}
                view={panel.view}
                openWork={() => ctx.layout.selectPanel(executionPanel)}
                {...(panel.view === 'catalog' ? { workbenchAppearance: appearance } : {})}
              />
            </div>
          );
          const setup = (remote: boolean) =>
            localSetup && !remote ? (
              <LocalSetupBoundary
                onInitialized={(credentials, team, signal) =>
                  enterTeamAfterLocalSetup(memberShell, credentials, team, signal)
                }
              >
                {content(false)}
              </LocalSetupBoundary>
            ) : (
              content(remote)
            );
          return sharedBackend ? (
            <SharedBackendBoundary
              client={sharedBackend}
              refreshed={restoreBackendMember}
              requestChange={(work, signal) =>
                memberShell.requestLeave(() => {
                  memberShell.session.invalidate();
                  memberShell.setPageActive(false);
                  void work()
                    .finally(() => {
                      if (!signal.aborted && sharedBackend.getSnapshot().phase !== 'ready')
                        restoreBackendMember();
                    })
                    .catch(() => undefined);
                }, signal)
              }
            >
              {setup}
            </SharedBackendBoundary>
          ) : (
            setup(false)
          );
        },
      );
      return () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === panel.id)
          ctx.layout.selectPanel(null);
        dispose();
      };
    });
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: panel.id,
          order: panel.order,
          label: panel.label,
        },
        () => (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            {panel.view === 'catalog' ? (
              <>
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <path d="M14 17.5h7m-3.5-3.5v7" />
              </>
            ) : (
              <path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2" />
            )}
          </svg>
        ),
      ),
    );
  }
  if (mode === 'multi-member') {
    const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
    if (active === null || active === 'zhuma-experts') ctx.layout.selectPanel(workbenchPanel);
  }
  ctx.slots.inject('settings.launcher', () =>
    ctx.slots.register(
      {
        name: 'settings.launcher',
        inject: () => ({
          shell: memberShell,
          memberLifecycle: mode === 'multi-member',
          fetcher: memberFetch,
          bindSettingsLauncher,
          openWork: () => {
            if (ctx.layout.panelInfo.getSnapshot().activePanelId !== executionPanel)
              ctx.layout.selectPanel(executionPanel);
          },
        }),
      },
      SidebarAccountSettingsLauncher,
    ),
  );
}
