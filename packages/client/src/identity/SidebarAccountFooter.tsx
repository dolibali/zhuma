import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { ControlIcon } from '../workbench/ControlIcon.js';
import type { MemberShell, MemberShellSnapshot } from './shell.js';

export type SidebarAccountFooterProps = SidebarFooterActionOwnerProps & {
  readonly shell: MemberShell;
  openWork(): void;
  manageAccount?: (() => void) | undefined;
};
function spaceCaption(space: MemberShellSnapshot['space']) {
  if (!space || space.status === 'checking') return '正在确认空间';
  if (space.status === 'error') return '空间待重新确认';
  if (space.status === 'empty') return '未分配工作空间';
  return `${space.space.kind === 'personal' ? '个人' : '团队'} · ${space.space.name}`;
}
function PersonIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
    </svg>
  );
}

/** Account action reused by the composed Settings launcher; owns no session or theme state. */
export function SidebarAccountFooter({
  shell,
  wide,
  openWork,
  manageAccount,
}: SidebarAccountFooterProps) {
  const snapshot = useSyncExternalStore(shell.subscribe, shell.getSnapshot, shell.getSnapshot);
  const state = snapshot.session;
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state.status !== 'authenticated') setOpen(false);
  }, [state.status]);
  useEffect(() => {
    setOpen(false);
  }, [wide]);
  const caption = spaceCaption(snapshot.space);
  const accountId = state.status === 'authenticated' ? state.session.accountId : undefined;
  const label = accountId
    ? `账号与空间：${accountId}`
    : state.status === 'restoring'
      ? '正在连接账号'
      : state.status === 'signing-in'
        ? '正在登录'
        : state.status === 'signing-out'
          ? '正在退出登录'
          : state.status === 'unavailable'
            ? '登录状态待确认'
            : '登录账号';
  const busy = ['restoring', 'signing-in', 'signing-out'].includes(state.status);
  const contents = (
    <>
      <span className="zm-account-avatar" aria-hidden="true">
        {accountId ? Array.from(accountId)[0]?.toLocaleUpperCase() : <PersonIcon />}
      </span>
      {wide && (
        <>
          <span className="zm-account-caption">
            <strong>{accountId ?? label}</strong>
            {accountId && <small>{caption}</small>}
          </span>
          {accountId && <ControlIcon direction="down" />}
        </>
      )}
    </>
  );
  const spaces =
    snapshot.space?.session.spaces ??
    (state.status === 'authenticated' ? state.session.spaces : []);
  const selected =
    snapshot.space?.status === 'ready'
      ? snapshot.space.space.id
      : snapshot.space?.status === 'error' || snapshot.space?.status === 'checking'
        ? (snapshot.space.requestedSpaceId ?? '')
        : '';
  const value = spaces.some(({ id }) => id === selected) ? selected : '';
  return (
    <div className="zhuma zm-account-footer" data-wide={wide}>
      {state.status === 'authenticated' ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            ref={trigger}
            className="zm-account-trigger"
            aria-label={label}
            title={`${accountId} · ${caption}`}
            data-account-id={accountId}
          >
            {contents}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              side={wide ? 'top' : 'right'}
              align={wide ? 'start' : 'end'}
              sideOffset={8}
              collisionPadding={12}
              className="zm-account-positioner"
            >
              <Popover.Popup className="zhuma zm-account-popup">
                <Popover.Title className="zm-sr-only">账号与空间</Popover.Title>
                <div className="zm-account-identity">
                  <small>当前账号</small>
                  <strong>{accountId}</strong>
                </div>
                <Field label="工作空间">
                  <SingleSelect
                    label="切换工作空间"
                    value={value}
                    options={spaces.map((space) => ({
                      value: space.id,
                      label: `${space.kind === 'personal' ? '个人' : '团队'} · ${space.name}`,
                    }))}
                    disabled={!spaces.length}
                    onValueChange={(id) => {
                      setOpen(false);
                      openWork();
                      shell.requestSpace(id, () => trigger.current?.focus(), state.epoch);
                    }}
                  />
                </Field>
                {snapshot.space?.status === 'empty' && <p className="zm-muted">尚未分配工作空间</p>}
                {snapshot.space?.status === 'error' && (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      openWork();
                      void shell.space?.refresh();
                    }}
                  >
                    重新连接空间
                  </Button>
                )}
                <div className="zm-account-exit">
                  {manageAccount && (
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setOpen(false);
                        manageAccount();
                      }}
                    >
                      账号与团队
                    </Button>
                  )}
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setOpen(false);
                      openWork();
                      void shell.session.logout();
                    }}
                  >
                    退出登录
                  </Button>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        <button
          type="button"
          className="zm-account-trigger"
          aria-label={label}
          title={label}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={openWork}
        >
          {contents}
        </button>
      )}
    </div>
  );
}
