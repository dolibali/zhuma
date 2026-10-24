import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '../workbench/Button.js';
import { Modal } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import { UnsavedChangesBoundary } from '../workbench/UnsavedChanges.js';
import type { IdentityApi, MemberSession, MemberSpace } from './api.js';
import { createMemberSpaceController } from './spaces.js';

export interface MemberSpaceBoundaryProps {
  readonly api: IdentityApi;
  readonly session: MemberSession;
  onUnauthenticated(): void;
  /** The transport must bind all work queries and commands to this explicit space. */
  readonly children: (space: MemberSpace, onSpaceUnavailable: () => void) => ReactNode;
}

export function MemberSpaceBoundary({
  api,
  session,
  onUnauthenticated,
  children,
}: MemberSpaceBoundaryProps) {
  const invalidation = useRef(onUnauthenticated);
  invalidation.current = onUnauthenticated;
  const controller = useMemo(
    () => createMemberSpaceController(api, session, () => invalidation.current()),
    [api, session],
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
  const [proposed, setProposed] = useState<string>();
  useEffect(() => {
    void controller.refresh();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (state.status !== 'ready') setProposed(undefined);
  }, [state.status]);
  function select(id: string) {
    if (state.status === 'ready' && state.space.id === id) return;
    if (dirtyForms.current.size) setProposed(id);
    else void controller.select(id);
  }
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
  return (
    <div className="zm-space-boundary">
      <nav className="zm-space-bar" aria-label="工作空间">
        <SingleSelect
          label="当前空间"
          value={selected}
          options={options}
          onValueChange={select}
          disabled={!options.length}
          triggerContent={
            selected ? undefined : (
              <>
                <span>{state.status === 'checking' ? '正在确认空间…' : '选择空间'}</span>
                <span aria-hidden>⌄</span>
              </>
            )
          }
        />
        <Button
          variant="quiet"
          busy={state.status === 'checking' || (state.status === 'ready' && state.refreshing)}
          busyLabel="正在刷新…"
          onClick={() => {
            // Revalidation can revoke access. It must not wait on a discard prompt.
            void controller.refresh();
          }}
        >
          刷新空间
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
            {children(state.space, () => controller.invalidate(state.epoch))}
          </div>
        </UnsavedChangesBoundary>
      )}
      {state.status === 'ready' && proposed && (
        <Modal title="切换空间？" close={() => setProposed(undefined)}>
          <div className="zm-space-discard">
            <p>切换后会清空未提交的产物和评审意见。</p>
            <p>已经发送的操作仍可能在服务端完成。</p>
            <div className="zm-actions">
              <Button onClick={() => setProposed(undefined)}>留在当前空间</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const id = proposed;
                  setProposed(undefined);
                  void controller.select(id);
                }}
              >
                清空并切换
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
