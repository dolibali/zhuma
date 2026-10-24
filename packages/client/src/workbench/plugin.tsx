import type { Context } from '@deepseek-ai/cordis';
import type { ComponentProps } from 'react';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-theme/client';
import type { AppearanceStore } from './Appearance.js';
import { createWorkbenchApi } from './api.js';
import { WorkbenchPage } from './WorkbenchPage.js';
import { MemberExecutionPage } from '../execution/MemberExecutionPage.js';
import { createIdentityApi } from '../identity/api.js';
import { createMemberShell } from '../identity/shell.js';
import { SidebarAccountFooter } from '../identity/SidebarAccountFooter.js';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import workbenchStyles from './workbench.css';
import flowStyles from '@xyflow/react/dist/style.css';

export const inject = ['slots', 'layout', 'connection', 'theme'];
export function apply(ctx: Context): void {
  const connection = ctx.get(
    'connection',
  ) as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle;
  const api = createWorkbenchApi(connection.rpc);
  const memberShell = createMemberShell(createIdentityApi());
  const executionPanel = 'zhuma-my-work' as MainPanelId;
  ctx.effect(() => {
    const syncPage = () =>
      memberShell.setPageActive(
        ctx.layout.panelInfo.getSnapshot().activePanelId === executionPanel,
      );
    syncPage();
    const unsubscribe = ctx.layout.panelInfo.subscribe(syncPage);
    memberShell.start();
    return () => {
      unsubscribe();
      memberShell.stop();
    };
  });
  const appearance: AppearanceStore = {
    getSnapshot: () => ctx.theme.getTheme().preference,
    subscribe: (listener) => ctx.on('theme/change', listener),
    set: (preference) => ctx.theme.setTheme(preference),
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = `${flowStyles}\n${workbenchStyles}`;
    document.head.append(style);
    return () => style.remove();
  });
  for (const panel of [
    {
      id: 'zhuma-workbench',
      label: '团队工作台',
      section: 'tasks',
      expertLibrary: false,
      order: -100,
    },
    { id: 'zhuma-experts', label: '专家', section: 'assets', expertLibrary: true, order: -90 },
  ] as const) {
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
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      { name: 'main', key: executionPanel, inject: () => ({}) },
      () => (
        <div className="zm-shell-panel">
          <div className="zm-shell-chrome" data-window-drag aria-hidden="true" />
          <MemberExecutionPage shell={memberShell} />
        </div>
      ),
    );
    return () => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === executionPanel)
        ctx.layout.selectPanel(null);
      dispose();
    };
  });
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: executionPanel, order: -95, label: '我的工作' },
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
          <path d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2" />
        </svg>
      ),
    ),
  );
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        order: -100,
        inject: () => ({
          shell: memberShell,
          openWork: () => {
            if (ctx.layout.panelInfo.getSnapshot().activePanelId !== executionPanel)
              ctx.layout.selectPanel(executionPanel);
          },
        }),
      },
      (props: SidebarFooterActionOwnerProps & { shell: typeof memberShell; openWork(): void }) => (
        <SidebarAccountFooter {...props} />
      ),
    ),
  );
}
