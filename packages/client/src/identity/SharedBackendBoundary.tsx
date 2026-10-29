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
    [origin, setOrigin] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lifetime = useRef<AbortController>();
  useEffect(() => {
    const active = new AbortController();
    lifetime.current = active;
    if (client.getSnapshot().phase !== 'ready') void client.refresh().catch(() => undefined);
    return () => {
      active.abort();
    };
  }, [client]);
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
    requestChange(async () => {
      setBusy(true);
      setError('');
      try {
        await client.select(next, active.signal);
        if (!active.signal.aborted) setOpen(false);
      } catch (failure) {
        if (!active.signal.aborted)
          setError(failure instanceof Error ? failure.message : '连接失败，请重试。');
      } finally {
        if (!active.signal.aborted) setBusy(false);
      }
    }, active.signal);
  }
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
              <p role="alert">暂时无法读取共享服务连接。</p>
              <Button
                onClick={() => {
                  void client
                    .refresh()
                    .then(refreshed)
                    .catch(() => undefined);
                }}
              >
                重新连接
              </Button>
            </>
          )}
        </main>
      )}
      <div className="zm-backend-bar" aria-label="服务连接">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => {
            setOrigin(state.selection?.origin ?? '');
            setError('');
            setOpen(true);
          }}
        >
          {state.selection?.origin ? new URL(state.selection.origin).host : '本机团队'} · 连接设置
        </Button>
      </div>
      {open && (
        <Modal
          title="连接共享后端"
          close={() => {
            if (!busy) setOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              select(origin.trim());
            }}
          >
            <div className="zm-form-body">
              <Field label="服务地址">
                <input
                  autoFocus
                  required
                  type="url"
                  maxLength={2048}
                  value={origin}
                  disabled={busy}
                  placeholder="http://192.168.1.20:3080"
                  onChange={(event) => setOrigin(event.target.value)}
                />
              </Field>
              <p className="zm-muted">连接后使用服务中的成员账号登录。</p>
              {error && <p role="alert">{error}</p>}
            </div>
            <footer>
              <Button disabled={busy || !state.selection} onClick={() => select(null)}>
                使用本机团队
              </Button>
              <span className="zm-spacer" />
              <Button disabled={busy} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!state.selection}>
                连接
              </Button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
