import { useEffect, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { LoginCredentials } from './api.js';
import { IdentityLifecycleError, type RegisterAccount } from './lifecycle-api.js';

export function RegistrationForm({
  register,
  complete,
  cancel,
}: {
  register: RegisterAccount;
  complete(credentials: LoginCredentials): void;
  cancel(): void;
}) {
  const [accountId, setAccountId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const active = useRef<AbortController>();
  useEffect(() => () => active.current?.abort(), []);
  return (
    <div className="zhuma zm-member-session">
      <main className="zm-login-entry">
        <form
          className="zm-login-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (password !== confirm) {
              setError('两次输入的密码不一致。');
              return;
            }
            const request = new AbortController();
            active.current = request;
            setBusy(true);
            setError('');
            void register({ requestId: requestId.current, accountId, password }, request.signal)
              .then(() => {
                if (!request.signal.aborted) {
                  setPassword('');
                  setConfirm('');
                  complete({ accountId, password });
                }
              })
              .catch((error: unknown) => {
                if (!request.signal.aborted)
                  setError(
                    error instanceof IdentityLifecycleError
                      ? error.message
                      : '注册结果未确认，请尝试重新连接或登录。',
                  );
              })
              .finally(() => {
                if (!request.signal.aborted) setBusy(false);
              });
          }}
        >
          <header>
            <span className="zm-login-brand">Zhuma</span>
            <h1>创建账号</h1>
          </header>
          <fieldset disabled={busy}>
            <legend className="zm-sr-only">注册账号</legend>
            <Field label="账号">
              <input
                autoFocus
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                pattern={'[A-Za-z0-9_\\-]+'}
                maxLength={64}
                placeholder="字母、数字、下划线或短横线"
                value={accountId}
                onChange={(event) => {
                  requestId.current = crypto.randomUUID();
                  setAccountId(event.target.value);
                }}
              />
            </Field>
            <Field label="密码">
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={password}
                onChange={(event) => {
                  requestId.current = crypto.randomUUID();
                  setPassword(event.target.value);
                }}
              />
            </Field>
            <Field label="确认密码">
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
          </fieldset>
          {error && (
            <p role="alert" className="zm-login-error">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy} busyLabel="正在创建…">
            注册并登录
          </Button>
          <Button variant="quiet" disabled={busy} onClick={cancel}>
            返回登录
          </Button>
        </form>
      </main>
    </div>
  );
}
