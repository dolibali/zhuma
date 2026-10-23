import {
  IdentityApiError,
  type IdentityApi,
  type LoginCredentials,
  type MemberSession,
} from './api.js';

export type MemberSessionState =
  | { readonly status: 'restoring' }
  | { readonly status: 'signed-out'; readonly error?: IdentityApiError }
  | { readonly status: 'signing-in' }
  | { readonly status: 'authenticated'; readonly session: MemberSession; readonly epoch: number }
  | { readonly status: 'signing-out' }
  | {
      readonly status: 'unavailable';
      readonly action: 'restore' | 'logout';
      readonly error: IdentityApiError;
    };

/** Session projection only. It does not select spaces, cache workbench data or start work. */
export function createMemberSessionController(api: IdentityApi) {
  let state: MemberSessionState = { status: 'restoring' };
  let epoch = 0;
  let pending: AbortController | undefined;
  const listeners = new Set<() => void>();
  function publish(next: MemberSessionState) {
    state = next;
    listeners.forEach((listener) => listener());
  }
  function cancel() {
    ++epoch;
    pending?.abort();
    pending = undefined;
  }
  async function run(action: 'restore' | 'login' | 'logout', credentials?: LoginCredentials) {
    if (pending) return;
    const requestEpoch = ++epoch;
    const request = new AbortController();
    pending = request;
    publish({
      status:
        action === 'restore' ? 'restoring' : action === 'login' ? 'signing-in' : 'signing-out',
    });
    const current = () => requestEpoch === epoch && !request.signal.aborted;
    try {
      if (action === 'logout') {
        await api.logout(request.signal);
        if (current()) publish({ status: 'signed-out' });
      } else {
        const login = credentials ? await api.login(credentials, request.signal) : undefined;
        if (login && login.accountId !== credentials?.accountId)
          throw new IdentityApiError('session-changed');
        credentials = undefined;
        if (!current()) return;
        const session = await api.session(request.signal);
        if (!current()) return;
        if (login && login.accountId !== session.accountId)
          throw new IdentityApiError('session-changed');
        publish({ status: 'authenticated', session, epoch: requestEpoch });
      }
    } catch (error) {
      if (!current()) return;
      const failure =
        error instanceof IdentityApiError ? error : new IdentityApiError('unavailable');
      if (action === 'logout' && failure.code === 'unauthenticated') {
        publish({ status: 'signed-out' });
      } else if (action === 'login') {
        publish({ status: 'signed-out', error: failure });
      } else if (
        action === 'restore' &&
        (failure.code === 'unauthenticated' || failure.code === 'member-session-required')
      ) {
        publish({ status: 'signed-out' });
      } else {
        publish({ status: 'unavailable', action, error: failure });
      }
    } finally {
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
    restore() {
      // An unsuccessful logout cannot reopen protected content by restoring its old cookie.
      if (state.status === 'unavailable' && state.action === 'logout') return Promise.resolve();
      return run('restore');
    },
    login(credentials: LoginCredentials) {
      if (state.status !== 'signed-out') return Promise.resolve();
      return run('login', credentials);
    },
    logout() {
      if (
        state.status !== 'authenticated' &&
        !(state.status === 'unavailable' && state.action === 'logout')
      )
        return Promise.resolve();
      return run('logout');
    },
    /** A protected transport reports a 401 here; old account content is removed immediately. */
    invalidate(expectedEpoch?: number) {
      if (
        expectedEpoch !== undefined &&
        (state.status !== 'authenticated' || state.epoch !== expectedEpoch)
      )
        return;
      cancel();
      publish({ status: 'signed-out', error: new IdentityApiError('unauthenticated') });
    },
    /** Abort and forget, while permitting the same controller's StrictMode effect to restart. */
    dispose() {
      cancel();
      state = { status: 'restoring' };
    },
  };
}
