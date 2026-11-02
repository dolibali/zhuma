import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '../workbench/Button.js';
import { Field, Modal } from '../workbench/controls.js';
import type { SharedBackendClient } from './shared-backend.js';

export function SharedBackendBoundary({
  client,
  requestChange,
  refreshed,
  children,
}: {
  client: SharedBackendClient;
  requestChange(work: () => Promise<void>, signal: AbortSignal): void;
  refreshed(): void;
  children(remote: boolean): ReactNode;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<'local' | 'shared'>('local'),
    [origin, setOrigin] = useState(''),
    [busy, setBusy] = useState<'saving' | 'checking' | null>(null),
    [error, setError] = useState('');
  const lifetime = useRef<AbortController>();
  const opener = useRef<HTMLButtonElement>(),
    restorePending = useRef(false);
  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    if (client.getSnapshot().phase !== 'ready') void client.refresh().catch(() => undefined);
    return () => {
      active.abort();
    };
  }, [client]);
  useEffect(() => {
    if (open) {
      restorePending.current = true;
      return;
    }
    if (!restorePending.current || busy) return;
    restorePending.current = false;
    const target = opener.current;
    if (target?.isConnected && !target.disabled) target.focus();
  }, [open, busy]);
  function select(next: string | null) {
    const active = lifetime.current;
    if (!active || busy) return;
    if (next !== null) {
      try {
        const url = new URL(next);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        )
          throw new Error();
        next = url.origin;
      } catch {
        setError('请填写服务根地址，例如 http://host:3080。');
        return;
      }
    }
    if (state.phase === 'ready' && next === state.selection?.origin) {
      setOpen(false);
      return;
    }
    requestChange(async () => {
      setBusy('saving');
      setError('');
      try {
        await client.select(next, active.signal);
        if (!active.signal.aborted) setOpen(false);
      } catch (failure) {
        if (!active.signal.aborted)
          setError(failure instanceof Error ? failure.message : '连接失败，请重试。');
      } finally {
        if (!active.signal.aborted) setBusy(null);
      }
    }, active.signal);
  }
  async function check() {
    const active = lifetime.current;
    if (!active || busy) return;
    setBusy('checking');
    setError('');
    try {
      if (state.phase !== 'ready') await client.refresh();
      await client.check(active.signal);
    } catch {
      if (!active.signal.aborted) setError('无法检查当前服务，请重新读取设置后重试。');
    } finally {
      if (!active.signal.aborted) setBusy(null);
    }
  }
  const verification = {
    checking: '正在检查…',
    reachable: '可访问',
    'login-required': '可访问，请登录',
    unavailable: '无法访问，请检查网络和服务地址',
    'invalid-response': '响应无效，请核对地址和服务版本',
  } as const;
  return (
    <div className="zhuma zm-shared-backend">
      {state.phase === 'ready' ? (
        children(state.selection?.origin != null)
      ) : (
        <main className="zm-page">
          {state.phase === 'loading' ? (
            <p role="status">正在读取服务连接…</p>
          ) : (
            <>
              <p role="alert">暂时无法读取服务设置。</p>
              <Button
                onClick={() => {
                  void client
                    .refresh()
                    .then(refreshed)
                    .catch(() => undefined);
                }}
              >
                重新读取设置
              </Button>
            </>
          )}
        </main>
      )}
      <div className="zm-backend-bar" aria-label="服务连接">
        <Button
          variant="quiet"
          disabled={busy !== null}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setMode(state.selection?.origin ? 'shared' : 'local');
            setOrigin(state.selection?.origin ?? '');
            setError('');
            setOpen(true);
          }}
        >
          {state.selection?.origin ? new URL(state.selection.origin).host : '本机服务'} · 连接设置
        </Button>
      </div>
      {open && (
        <Modal
          title="服务连接"
          close={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              select(mode === 'local' ? null : origin.trim());
            }}
          >
            <div className="zm-form-body">
              <section className="zm-backend-current" aria-label="当前服务">
                <div>
                  <span className="zm-muted">当前使用</span>
                  <strong>
                    {state.selection ? (state.selection.origin ?? '本机服务') : '尚未读取'}
                  </strong>
                  <span role="status" className="zm-muted">
                    {state.phase === 'error'
                      ? '设置未读取，请重新检查'
                      : state.phase === 'loading'
                        ? '正在读取设置…'
                        : `最近检查：${state.verification ? verification[state.verification] : '尚未检查'}`}
                  </span>
                </div>
                <Button
                  disabled={busy !== null}
                  busy={busy === 'checking'}
                  busyLabel="检查中…"
                  onClick={() => void check()}
                >
                  检查连接
                </Button>
              </section>
              <fieldset className="zm-backend-target" disabled={busy !== null}>
                <legend>工作数据保存在哪里</legend>
                <label>
                  <input
                    type="radio"
                    name="backend-target"
                    value="local"
                    checked={mode === 'local'}
                    onChange={() => {
                      setMode('local');
                      setError('');
                    }}
                  />
                  本机服务
                </label>
                <label>
                  <input
                    type="radio"
                    name="backend-target"
                    value="shared"
                    checked={mode === 'shared'}
                    onChange={() => {
                      setMode('shared');
                      setError('');
                    }}
                  />
                  自定义共享服务
                </label>
              </fieldset>
              {mode === 'shared' ? (
                <Field label="服务根地址">
                  <input
                    required
                    type="url"
                    maxLength={2048}
                    value={origin}
                    disabled={busy !== null}
                    placeholder="https://zhuma.example.com"
                    onChange={(event) => setOrigin(event.target.value)}
                  />
                </Field>
              ) : null}
              <p className="zm-muted">
                {mode === 'shared'
                  ? '使用共享服务中的成员账号登录，Agent 仍在本机执行。'
                  : '项目和团队数据保存在这台设备。'}
              </p>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <span className="zm-spacer" />
              <Button disabled={busy !== null} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={busy === 'saving'}
                busyLabel="保存中…"
                disabled={busy !== null || !state.selection}
              >
                保存并切换
              </Button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
