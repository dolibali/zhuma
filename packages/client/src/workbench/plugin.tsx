import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { createWorkbenchApi } from './api.js';
import { WorkbenchPage } from './WorkbenchPage.js';
import workbenchStyles from './workbench.css';
import flowStyles from '@xyflow/react/dist/style.css';

export const inject = ['slots', 'layout', 'connection'];
export function apply(ctx: Context): void {
  const connection = ctx.get(
    'connection',
  ) as import('@deepseek-ai/dsh-client-connection/client').ConnectionHandle;
  const api = createWorkbenchApi(connection.rpc);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = `${flowStyles}\n${workbenchStyles}`;
    document.head.append(style);
    return () => style.remove();
  });
  const panelId = 'zhuma-workbench' as MainPanelId;
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register(
      { name: 'main', key: panelId, inject: () => ({ api, initialSection: 'projects' as const }) },
      WorkbenchPage,
    );
    // Initial product landing only; selecting DSH conversations remains available.
    if (ctx.layout.panelInfo.getSnapshot().activePanelId === null) ctx.layout.selectPanel(panelId);
    return () => {
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === panelId)
        ctx.layout.selectPanel(null);
      dispose();
    };
  });
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: panelId, order: -100, label: '团队工作台' },
      () => (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <path d="M14 17.5h7m-3.5-3.5v7" />
        </svg>
      ),
    ),
  );
}
