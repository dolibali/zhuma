import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { IdentityApi, LoginCredentials, MemberSession } from './api.js';
import { createMemberSessionController, type MemberSessionState } from './session.js';

export interface MemberSessionBoundaryProps {
  readonly api: IdentityApi;
  /** Consumers must abort their own requests on unmount and report member 401 responses. */
  readonly children: (session: MemberSession, onUnauthenticated: () => void) => ReactNode;
}

function LoginForm({
  state,
  login,
}: {
  state: Extract<MemberSessionState, { status: 'signed-out' | 'signing-in' }>;
  login(credentials: LoginCredentials): void;
}) {
  const [accountId, setAccountId] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const busy = state.status === 'signing-in';
  const error = state.status === 'signed-out' ? state.error : undefined;
  useEffect(() => {
    if (error?.code === 'invalid-login') passwordInput.current?.focus();
  }, [error]);
  return (
    <form
      className="zm-login-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setPassword('');
        setVisible(false);
        login({ accountId, password });
      }}
    >
      <header>
        <span className="zm-login-brand">Zhuma</span>
        <h1>登录工作台</h1>
      </header>
      <fieldset disabled={busy}>
        <legend className="zm-sr-only">成员账号</legend>
        <Field label="账号">
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            maxLength={64}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            aria-invalid={error?.code === 'invalid-login' || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </Field>
        <div className="zm-login-password">
          <Field label="密码">
            <input
              ref={passwordInput}
              name="password"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              required
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error?.code === 'invalid-login' || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </Field>
          <Button
            variant="quiet"
            className="zm-password-toggle"
            aria-pressed={visible}
            onClick={() => setVisible(!visible)}
          >
            {visible ? '隐藏密码' : '显示密码'}
          </Button>
        </div>
      </fieldset>
      {error && (
        <p id={errorId} role="alert" className="zm-login-error">
          {error.message}
        </p>
      )}
      <Button type="submit" variant="primary" busy={busy} busyLabel="正在登录…">
        登录
      </Button>
    </form>
  );
}

/** Controlled surface for composition and contract previews; it never establishes identity itself. */
export function MemberSessionView({
  state,
  login,
  retry,
  logout,
  children,
}: {
  readonly state: MemberSessionState;
  login(credentials: LoginCredentials): void;
  retry(): void;
  logout(): void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="zhuma zm-member-session">
      {state.status === 'authenticated' ? (
        <>
          <header className="zm-current-account">
            <span className="zm-account-mark" aria-hidden>
              {state.session.accountId.slice(0, 1)}
            </span>
            <span>
              <small>当前账号</small>
              <strong>{state.session.accountId}</strong>
            </span>
            <Button variant="quiet" onClick={logout}>
              退出登录
            </Button>
          </header>
          <div className="zm-member-content" key={state.epoch}>
            {children}
          </div>
        </>
      ) : (
        <main className="zm-login-entry">
          {state.status === 'signed-out' || state.status === 'signing-in' ? (
            <LoginForm state={state} login={login} />
          ) : (
            <section
              className="zm-login-card"
              aria-busy={state.status !== 'unavailable' || undefined}
            >
              <header>
                <span className="zm-login-brand">Zhuma</span>
                <h1>
                  {state.status === 'restoring'
                    ? '正在恢复登录'
                    : state.status === 'signing-out'
                      ? '正在退出登录'
                      : state.action === 'logout'
                        ? '尚未完成退出'
                        : '暂时无法登录'}
                </h1>
              </header>
              {state.status === 'unavailable' ? (
                <>
                  <p role="alert" className="zm-login-error">
                    {state.error.message}
                  </p>
                  <Button variant="primary" onClick={retry}>
                    {state.action === 'logout' ? '重试退出' : '重新连接'}
                  </Button>
                </>
              ) : (
                <p role="status" className="zm-login-status">
                  <span className="zm-spinner" aria-hidden />
                  {state.status === 'restoring' ? '正在检查登录状态…' : '正在结束当前会话…'}
                </p>
              )}
            </section>
          )}
        </main>
      )}
    </div>
  );
}

/** Opt-in boundary. The Host installs member mode and its routes before mounting this component. */
export function MemberSessionBoundary({ api, children }: MemberSessionBoundaryProps) {
  const controller = useMemo(() => createMemberSessionController(api), [api]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.restore();
    return () => controller.dispose();
  }, [controller]);
  return (
    <MemberSessionView
      state={state}
      login={(credentials) => {
        void controller.login(credentials);
      }}
      logout={() => {
        void controller.logout();
      }}
      retry={() => {
        void (state.status === 'unavailable' && state.action === 'logout'
          ? controller.logout()
          : controller.restore());
      }}
    >
      {state.status === 'authenticated'
        ? children(state.session, () => controller.invalidate(state.epoch))
        : null}
    </MemberSessionView>
  );
}
