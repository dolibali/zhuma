import { IdentityApiError, type IdentityApi, type MemberSession, type MemberSpace } from './api.js';

interface SpaceSnapshot {
  readonly session: MemberSession;
  readonly epoch: number;
}
export type MemberSpaceState = SpaceSnapshot &
  (
    | { readonly status: 'checking'; readonly requestedSpaceId?: string | undefined }
    | { readonly status: 'ready'; readonly space: MemberSpace; readonly refreshing: boolean }
    | { readonly status: 'empty' }
    | {
        readonly status: 'error';
        readonly error: IdentityApiError;
        readonly requestedSpaceId?: string | undefined;
      }
  );

export interface MemberSpacePreference {
  /** Untrusted hint; accepted only after a fresh member directory contains the ID. */
  readonly preferredSpaceId?: string | undefined;
  onConfirmedSelect?(spaceId: string): void;
  onUnavailable?(spaceId: string): void;
}

/** UI selection only. Every transition refreshes directory facts; business APIs authorize again. */
export function createMemberSpaceController(
  api: Pick<IdentityApi, 'session'>,
  initial: MemberSession,
  invalidate: () => void,
  preference?: MemberSpacePreference,
) {
  let state: MemberSpaceState = { status: 'checking', session: initial, epoch: 0 };
  let restoringPreference = preference?.preferredSpaceId;
  let epoch = 0;
  let pending: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(next: MemberSpaceState) {
    state = next;
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    ++epoch;
    pending?.abort();
    pending = undefined;
  }
  async function refresh(
    requestedSpaceId?: string,
    keepCurrent = false,
    explicit = false,
    caller?: AbortSignal,
  ) {
    if (caller?.aborted) return;
    const before = state;
    const restoring =
      !explicit &&
      restoringPreference !== undefined &&
      (requestedSpaceId === undefined || requestedSpaceId === restoringPreference);
    const targetId = restoring ? restoringPreference : requestedSpaceId;
    const previous = keepCurrent && state.status === 'ready' ? state : undefined;
    cancel();
    const currentEpoch = epoch;
    const request = new AbortController();
    pending = request;
    publish(
      previous
        ? { ...previous, refreshing: true }
        : { status: 'checking', session: state.session, epoch, requestedSpaceId: targetId },
    );
    const current = () => epoch === currentEpoch && !request.signal.aborted;
    const cancelled = () => {
      if (epoch !== currentEpoch) return;
      cancel();
      publish(
        before.status === 'ready'
          ? { ...before, epoch, refreshing: false }
          : {
              status: 'error',
              session: before.session,
              epoch,
              error: new IdentityApiError('unavailable'),
            },
      );
    };
    caller?.addEventListener('abort', cancelled, { once: true });
    if (caller?.aborted) cancelled();
    try {
      const session = await api.session(request.signal);
      if (!current()) return;
      // Host creates a fresh HTTP peer per request; peerId is not a stable login/session ID.
      if (session.accountId !== initial.accountId) throw new IdentityApiError('session-changed');
      if (restoring) restoringPreference = undefined;
      const defaultSpace = () =>
        session.spaces.find(({ kind }) => kind === 'personal') ?? session.spaces[0];
      const chosen =
        targetId === undefined ? defaultSpace() : session.spaces.find(({ id }) => id === targetId);
      if (targetId !== undefined && !chosen) preference?.onUnavailable?.(targetId);
      const space = chosen ?? (restoring ? defaultSpace() : undefined);
      if (targetId !== undefined && !chosen && !restoring) {
        publish({
          status: 'error',
          session,
          epoch,
          requestedSpaceId: targetId,
          error: new IdentityApiError('space-unavailable'),
        });
      } else if (space) {
        if (explicit) preference?.onConfirmedSelect?.(space.id);
        publish({
          status: 'ready',
          session,
          epoch: previous?.epoch ?? epoch,
          space,
          refreshing: false,
        });
      } else {
        publish({ status: 'empty', session, epoch });
      }
    } catch (error) {
      if (!current()) return;
      const failure =
        error instanceof IdentityApiError ? error : new IdentityApiError('unavailable');
      publish({
        status: 'error',
        session: state.session,
        epoch,
        error: failure,
        requestedSpaceId: targetId,
      });
      if (
        failure.code === 'unauthenticated' ||
        failure.code === 'session-changed' ||
        failure.code === 'member-session-required'
      )
        invalidate();
    } finally {
      caller?.removeEventListener('abort', cancelled);
      if (current()) pending = undefined;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      return refresh(
        state.status === 'ready'
          ? state.space.id
          : state.status === 'checking' || state.status === 'error'
            ? state.requestedSpaceId
            : undefined,
        true,
      );
    },
    select(spaceId: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.resolve();
      if (state.status === 'ready' && state.space.id === spaceId) return Promise.resolve();
      restoringPreference = undefined;
      return refresh(spaceId, false, true, signal);
    },
    /** Used by the scoped transport after a membership failure; no stale content remains visible. */
    invalidate(expectedEpoch: number) {
      if (state.status !== 'ready' || state.epoch !== expectedEpoch) return;
      const requestedSpaceId = state.space.id;
      cancel();
      publish({
        status: 'error',
        session: state.session,
        epoch,
        requestedSpaceId,
        error: new IdentityApiError('space-unavailable'),
      });
    },
    dispose() {
      cancel();
      // StrictMode may restart this controller. An old mounted view must not regain its epoch.
      state = { status: 'checking', session: state.session, epoch };
    },
  };
}
