import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import type { LoginCredentials, MemberSpace } from './api.js';
import type { MemberSessionController, MemberShell } from './shell.js';
import {
  createLocalSetupApi,
  LocalSetupApiError,
  type LocalSetupInput,
  type LocalSetupSnapshot,
} from './local-setup-api.js';

/** Initial restore can have failed while setup was pending. Re-read the real
 * session before login, and never start a late login after this view closes. */
export async function loginAfterLocalSetup(
  session: Pick<MemberSessionController, 'restore' | 'login'>,
  credentials: LoginCredentials,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await session.restore();
  signal.throwIfAborted();
  await session.login(credentials);
}

/** The POST receipt nominates a team; the existing space controller still
 * re-reads membership, selects it and persists the confirmed preference. */
export async function enterTeamAfterLocalSetup(
  shell: MemberShell,
  credentials: LoginCredentials,
  team: MemberSpace | undefined,
  signal: AbortSignal,
): Promise<void> {
  await loginAfterLocalSetup(shell.session, credentials, signal);
  signal.throwIfAborted();
  if (!team) return;
  const member = shell.session.getSnapshot(),
    space = shell.space;
  if (
    member.status !== 'authenticated' ||
    member.session.accountId !== credentials.accountId ||
    !space
  )
    throw new LocalSetupApiError('unavailable');
  await space.refresh();
  signal.throwIfAborted();
  const current = () => {
    const now = shell.session.getSnapshot();
    return shell.space === space && now.status === 'authenticated' && now.epoch === member.epoch;
  };
  if (!current() || space.getSnapshot().status !== 'ready')
    throw new LocalSetupApiError('unavailable');
  await space.select(team.id, signal);
  signal.throwIfAborted();
  const selected = space.getSnapshot();
  if (
    !current() ||
    selected.status !== 'ready' ||
    selected.space.id !== team.id ||
    selected.space.kind !== 'team'
  )
    throw new LocalSetupApiError('unavailable');
}

export function LocalSetupForm({
  snapshot,
  initialize,
}: {
  readonly snapshot: LocalSetupSnapshot;
  initialize(input: LocalSetupInput): Promise<void>;
}) {
  const requestId = useRef(snapshot.kind === 'pending' ? snapshot.requestId : crypto.randomUUID());
  const [accountId, setAccountId] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [packIds, setPackIds] = useState(() => snapshot.packs.map((pack) => pack.id));
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const errorId = useId();
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && !busy) passwordInput.current?.focus();
  }, [error, busy]);
  return (
    <form
      className="zm-local-setup-card"
      aria-busy={busy || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !packIds.length) return;
        const input = {
          requestId: requestId.current,
          accountId: accountId.trim(),
          password,
          teamName: teamName.trim(),
          packIds: [...packIds],
        };
        setPassword('');
        setVisible(false);
        setError(undefined);
        setBusy(true);
        void initialize(input)
          .catch((failure: unknown) => {
            if (failure instanceof DOMException && failure.name === 'AbortError') return;
            setError(
              failure instanceof LocalSetupApiError
                ? failure.message
                : '设置尚未完成，请检查状态后继续。',
            );
            passwordInput.current?.focus();
          })
          .finally(() => setBusy(false));
      }}
    >
      <header>
        <span className="zm-login-brand">Zhuma</span>
        <h1>{snapshot.kind === 'pending' ? '继续完成首次设置' : '建立你的工作台'}</h1>
        <p>
          {snapshot.kind === 'pending'
            ? '请使用上次填写的账号、密码、团队名称和专家选择继续。'
            : '创建成员账号与团队，选择可参与任务的基础专家。'}
        </p>
      </header>
      <fieldset disabled={busy} className="zm-local-setup-fields">
        <legend className="zm-sr-only">首次账号、团队与专家</legend>
        <div className="zm-local-setup-account">
          <h2>账号与团队</h2>
          <Field label="账号">
            <input
              name="username"
              autoComplete="username"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              maxLength={64}
              pattern="[A-Za-z0-9_-]+"
              placeholder="例如：lin-ke"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            />
          </Field>
          <div className="zm-login-password">
            <Field label="密码">
              <input
                ref={passwordInput}
                name="password"
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={200}
                placeholder="至少 8 个字符"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
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
          <Field label="团队名称">
            <input
              name="teamName"
              required
              maxLength={160}
              placeholder="例如：产品研发团队"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
            />
          </Field>
          <small>同时创建你的个人空间。</small>
        </div>
        <section className="zm-local-setup-experts" aria-labelledby={`${errorId}-experts`}>
          <h2 id={`${errorId}-experts`}>团队基础专家</h2>
          {snapshot.packs.map((pack) => (
            <label key={pack.id}>
              <input
                type="checkbox"
                checked={packIds.includes(pack.id)}
                onChange={(event) =>
                  setPackIds(
                    event.target.checked
                      ? [...packIds, pack.id]
                      : packIds.filter((id) => id !== pack.id),
                  )
                }
              />
              <span>
                <strong>{pack.name}</strong>
                <small>{pack.role}</small>
              </span>
            </label>
          ))}
          {!packIds.length && <small role="status">至少选择一位基础专家。</small>}
        </section>
      </fieldset>
      {error && (
        <p id={errorId} className="zm-login-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          busyLabel="正在创建…"
          disabled={!packIds.length}
        >
          {snapshot.kind === 'pending' ? '继续设置并进入工作台' : '创建并进入工作台'}
        </Button>
      </footer>
    </form>
  );
}

type State =
  | { kind: 'checking' }
  | { kind: 'member' | 'configured' }
  | { kind: 'setup'; snapshot: LocalSetupSnapshot }
  | { kind: 'error'; message: string };

/** Owner-only setup precedes the existing member login boundary; it creates no member identity itself. */
export function LocalSetupBoundary({
  children,
  onInitialized,
  fetcher = globalThis.fetch,
}: {
  readonly children: ReactNode;
  onInitialized(
    credentials: LoginCredentials,
    team: MemberSpace | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  fetcher?: typeof fetch;
}) {
  const api = useMemo(() => createLocalSetupApi(fetcher), [fetcher]);
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [epoch, setEpoch] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const current = new AbortController();
    lifetime.current = current;
    setState({ kind: 'checking' });
    void api
      .status(current.signal)
      .then((snapshot) => {
        if (current.signal.aborted) return;
        setState(
          snapshot.kind === 'configured' ? { kind: 'configured' } : { kind: 'setup', snapshot },
        );
      })
      .catch((error: unknown) => {
        if (current.signal.aborted) return;
        setState(
          error instanceof LocalSetupApiError && error.code === 'untrusted-request'
            ? { kind: 'member' }
            : {
                kind: 'error',
                message:
                  error instanceof LocalSetupApiError ? error.message : '暂时无法检查首次设置。',
              },
        );
      });
    return () => {
      current.abort();
      if (lifetime.current === current) lifetime.current = undefined;
    };
  }, [api, epoch]);
  if (state.kind === 'configured' || state.kind === 'member') return children;
  const recovery = state.kind === 'setup' && state.snapshot.kind === 'recovery-required';
  return (
    <div className="zhuma zm-local-setup-entry">
      {state.kind === 'setup' && !recovery ? (
        <LocalSetupForm
          snapshot={state.snapshot}
          initialize={async (input) => {
            const current = lifetime.current;
            if (!current) throw new DOMException('Setup view closed', 'AbortError');
            const result = await api.initialize(input, current.signal);
            current.signal.throwIfAborted();
            if (result.kind !== 'configured')
              throw new LocalSetupApiError(
                result.kind === 'recovery-required' ? 'recovery-required' : 'unavailable',
              );
            await onInitialized(
              { accountId: input.accountId, password: input.password },
              result.createdTeam,
              current.signal,
            );
            current.signal.throwIfAborted();
            setState({ kind: 'configured' });
          }}
        />
      ) : (
        <section className="zm-login-card" aria-busy={state.kind === 'checking' || undefined}>
          <header>
            <span className="zm-login-brand">Zhuma</span>
            <h1>
              {state.kind === 'checking'
                ? '正在检查工作台'
                : recovery
                  ? '需要恢复首次设置'
                  : '暂时无法开始设置'}
            </h1>
          </header>
          {state.kind === 'checking' ? (
            <p className="zm-login-status" role="status">
              <span className="zm-spinner" aria-hidden />
              正在读取设置状态…
            </p>
          ) : (
            <>
              <p className="zm-login-error" role="alert">
                {state.kind === 'error'
                  ? state.message
                  : '现有初始化记录需要核实，请保留数据并联系管理员。'}
              </p>
              <Button variant="primary" onClick={() => setEpoch((value) => value + 1)}>
                重新检查
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
