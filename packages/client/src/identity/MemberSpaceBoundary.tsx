import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { ControlIcon } from '../workbench/ControlIcon.js';
import { UnsavedChangesBoundary } from '../workbench/UnsavedChanges.js';
import type { IdentityApi, MemberSession, MemberSpace } from './api.js';
import { createMemberSpaceController } from './spaces.js';
import type { MemberSpaceController, SpaceSwitch } from './shell.js';

export interface MemberSpaceLifetime {
  /** UI generation only, never an authorization fact. */
  isCurrent(): boolean;
  onUnauthenticated(): void;
  /** UI form presence only; never a service permission or execution fact. */
  hasUnsavedChanges?(): boolean;
}
export interface MemberSpaceBoundaryProps {
  readonly api: IdentityApi;
  readonly session: MemberSession;
  readonly isSessionCurrent?: () => boolean;
  readonly isPageCurrent?: (() => boolean) | undefined;
  readonly controller?: MemberSpaceController | undefined;
  readonly showSpacePicker?: boolean;
  readonly registerSwitchGuard?: ((select: SpaceSwitch) => () => void) | undefined;
  onUnauthenticated(): void;
  /** The transport must bind all work queries and commands to this explicit space. */
  readonly children: (
    space: MemberSpace,
    onSpaceUnavailable: () => void,
    lifetime: MemberSpaceLifetime,
  ) => ReactNode;
}

export function MemberSpaceBoundary({
  api,
  session,
  isSessionCurrent,
  isPageCurrent,
  controller: provided,
  showSpacePicker = true,
  registerSwitchGuard,
  onUnauthenticated,
  children,
}: MemberSpaceBoundaryProps) {
  const invalidation = useRef(onUnauthenticated);
  invalidation.current = onUnauthenticated;
  const controller = useMemo(
    () => provided ?? createMemberSpaceController(api, session, () => invalidation.current()),
    [api, session, provided],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const dirtyForms = useRef(new Set<object>());
  const register = useCallback((token: object, dirty: boolean) => {
    if (dirty) dirtyForms.current.add(token);
    return () => {
      dirtyForms.current.delete(token);
    };
  }, []);
  const pickerId = useId();
  const confirmationId = useId();
  const [proposed, setProposed] = useState<{
    id: string;
    restoreFocus: (() => void) | undefined;
  }>();
  useEffect(() => {
    if (provided) return;
    void controller.refresh();
    return () => controller.dispose();
  }, [controller, provided]);
  useEffect(() => {
    if (state.status !== 'ready') setProposed(undefined);
  }, [state.status]);
  const select = useCallback(
    (id: string, restoreFocus?: () => void) => {
      const current = controller.getSnapshot();
      if (current.status === 'ready') {
        if (current.space.id === id) return;
        if (dirtyForms.current.size) {
          setProposed({ id, restoreFocus });
          return;
        }
      }
      void controller.select(id);
    },
    [controller],
  );
  useEffect(() => registerSwitchGuard?.(select), [registerSwitchGuard, select]);
  const selected =
    state.status === 'ready'
      ? state.space.id
      : state.status === 'checking'
        ? (state.requestedSpaceId ?? '')
        : '';
  const options = state.session.spaces.map((space) => ({
    value: space.id,
    label: `${space.kind === 'personal' ? '个人' : '团队'} · ${space.name}`,
  }));
  const refreshing = state.status === 'checking' || (state.status === 'ready' && state.refreshing);
  const caption =
    state.status === 'ready'
      ? state.space.name
      : state.status === 'checking'
        ? '正在确认空间…'
        : state.status === 'empty'
          ? '尚未分配空间'
          : '选择空间';
  const isCurrent = () => {
    const current = controller.getSnapshot();
    return (
      isSessionCurrent?.() !== false &&
      isPageCurrent?.() !== false &&
      state.status === 'ready' &&
      current.status === 'ready' &&
      current.epoch === state.epoch
    );
  };
  return (
    <div className="zm-space-boundary">
      <nav className="zm-space-bar" aria-label="工作空间" data-window-drag>
        {showSpacePicker ? (
          <SingleSelect
            id={pickerId}
            label="当前空间"
            popupMinWidth={260}
            className="zm-space-switcher"
            title={options.find((option) => option.value === selected)?.label ?? caption}
            value={selected}
            options={options}
            onValueChange={(id) => select(id, () => document.getElementById(pickerId)?.focus())}
            disabled={!options.length}
            triggerContent={
              <>
                <span className="zm-select-value">{caption}</span>
                <ControlIcon direction="down" />
              </>
            }
          />
        ) : (
          <div className="zm-space-summary">
            <span>工作空间</span>
            <strong>{state.status === 'ready' ? state.space.name : '正在确认'}</strong>
          </div>
        )}
        <Button
          variant="quiet"
          className="zm-space-refresh"
          aria-label="刷新空间"
          title={refreshing ? '正在刷新空间…' : '刷新空间'}
          busy={refreshing}
          busyLabel=""
          onClick={() => {
            // Revalidation can revoke access. It must not wait on a discard prompt.
            void controller.refresh();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 4v6h-6M20 10a8 8 0 1 0-2 8" />
          </svg>
        </Button>
      </nav>
      {state.status === 'checking' && (
        <div className="zm-space-state" role="status" aria-busy="true">
          正在确认空间访问权限…
        </div>
      )}
      {state.status === 'empty' && (
        <section className="zm-space-state">
          <h1>尚未分配空间</h1>
          <p>请联系管理员分配个人或团队空间，然后刷新。</p>
        </section>
      )}
      {state.status === 'error' && (
        <section className="zm-space-state">
          <h1>暂时无法打开空间</h1>
          <p role="alert">{state.error.message}</p>
          <Button onClick={() => void controller.refresh()}>重新连接</Button>
        </section>
      )}
      {state.status === 'ready' && (
        <UnsavedChangesBoundary register={register}>
          <div key={`${state.epoch}:${state.space.id}`} className="zm-space-content">
            {children(state.space, () => controller.invalidate(state.epoch), {
              isCurrent,
              hasUnsavedChanges: () => dirtyForms.current.size > 0,
              onUnauthenticated: () => {
                if (isCurrent()) invalidation.current();
              },
            })}
          </div>
        </UnsavedChangesBoundary>
      )}
      {state.status === 'ready' && proposed && (
        <Modal
          title="切换空间？"
          variant="confirmation"
          descriptionId={confirmationId}
          initialFocusId={`${confirmationId}-cancel`}
          restoreFocus={proposed.restoreFocus}
          close={() => setProposed(undefined)}
        >
          <div className="zm-confirmation-body">
            <div className="zm-confirmation-message" id={confirmationId}>
              <p>切换后，当前未保存的产物或评审意见将被放弃。</p>
              <p className="zm-confirmation-note">已保存的内容不受影响；已发送的操作仍可能完成。</p>
            </div>
            <div className="zm-confirmation-actions">
              <Button id={`${confirmationId}-cancel`} onClick={() => setProposed(undefined)}>
                留在当前空间
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const id = proposed.id;
                  setProposed(undefined);
                  void controller.select(id);
                }}
              >
                放弃修改并切换
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
