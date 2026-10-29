import { useEffect, useRef, useState } from 'react';
import type { WorkbenchApi } from './api.js';
import { Button } from './Button.js';

/** Refresh model facts only: never replace the editor's inputs, draft or proposal. */
export function usePlanningReadiness(api: WorkbenchApi, initialModel: string) {
  const [model, setModel] = useState(initialModel);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController>();
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    setModel(initialModel);
    setError('');
    setChecking(false);
    return () => {
      alive.current = false;
      active.current?.abort();
    };
  }, [api, initialModel]);
  async function refresh() {
    if (!alive.current || checking) return;
    const request = new AbortController();
    active.current?.abort();
    active.current = request;
    const current = () => alive.current && active.current === request && !request.signal.aborted;
    setChecking(true);
    setError('');
    try {
      const snapshot = await api.snapshot(request.signal);
      if (current()) setModel(snapshot.model);
    } catch {
      if (current()) setError('暂时无法确认规划模型，请重试。');
    } finally {
      if (current()) setChecking(false);
    }
  }
  return {
    model,
    ready: !api.member || api.member.capabilities()?.planning === true,
    checking,
    error,
    refresh,
  };
}

export function PlanningReadiness({ value }: { value: ReturnType<typeof usePlanningReadiness> }) {
  return (
    <div className="zm-planning-readiness" aria-label="规划模型状态">
      <div>
        <strong>{value.ready ? `规划模型 · ${value.model}` : '当前服务未配置规划模型'}</strong>
        {!value.ready && (
          <p>请由服务操作者配置后刷新。本机模型设置不会自动配置共享服务，仍可手工编排。</p>
        )}
        {value.error && <p role="alert">{value.error}</p>}
      </div>
      <Button
        variant="quiet"
        busy={value.checking}
        busyLabel="正在检查…"
        onClick={() => void value.refresh()}
      >
        检查模型
      </Button>
    </div>
  );
}
