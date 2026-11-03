import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkbenchError } from '@zhuma/agent-core';
import type { PlanningModelChoices, WorkbenchApi } from './api.js';
import { Button } from './Button.js';
import { SingleSelect } from './SingleSelect.js';

/** Read the current planning route and, when the Host exposes it, the catalog. */
export async function readPlanningReadiness(
  api: WorkbenchApi,
  signal: AbortSignal,
): Promise<{ model: string; choices?: PlanningModelChoices }> {
  const snapshot = await api.snapshot(signal);
  const choices = api.planningModels ? await api.planningModels(signal) : undefined;
  return { model: snapshot.model, ...(choices ? { choices } : {}) };
}

/** Apply one catalog choice. The following snapshot is what the next plan will name. */
export async function choosePlanningModel(
  api: WorkbenchApi,
  items: PlanningModelChoices['items'],
  id: string,
  signal: AbortSignal,
): Promise<{ model: string; choices: PlanningModelChoices }> {
  const option = items.find((item) => item.id === id);
  if (!option || !api.selectPlanningModel)
    throw new WorkbenchError('model-unavailable', '所选规划模型当前不可用，请刷新后重试。');
  const choices = await api.selectPlanningModel(option.provider, option.model, signal);
  let model = choices.label;
  try {
    model = (await api.snapshot(signal)).model;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return { model, choices };
}

/** Refresh model facts only: never replace the editor's inputs, draft or proposal. */
export function usePlanningReadiness(api: WorkbenchApi, initialModel: string) {
  const [model, setModel] = useState(initialModel);
  const [choices, setChoices] = useState<PlanningModelChoices>();
  const [checking, setChecking] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController>(undefined);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      active.current?.abort();
    },
    [],
  );
  useEffect(() => {
    setModel(initialModel);
  }, [initialModel]);
  const begin = useCallback(() => {
    const request = new AbortController();
    active.current?.abort();
    active.current = request;
    const current = () => alive.current && active.current === request && !request.signal.aborted;
    return { request, current };
  }, []);
  const loadCatalog = useCallback(
    async (signal?: AbortSignal) => {
      if (!alive.current || !api.planningModels || signal?.aborted) return;
      const { request, current } = begin();
      const stop = () => request.abort();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const next = await api.planningModels(request.signal);
        if (current()) {
          setChoices(next);
          setError('');
        }
      } catch {
        if (current()) setError('暂时无法确认规划模型，请重试。');
      } finally {
        signal?.removeEventListener('abort', stop);
      }
    },
    [api, begin],
  );
  const refresh = useCallback(async () => {
    if (!alive.current || checking) return;
    const { request, current } = begin();
    setChecking(true);
    setSelecting(false);
    setError('');
    try {
      const next = await readPlanningReadiness(api, request.signal);
      if (!current()) return;
      setModel(next.model);
      if (next.choices) setChoices(next.choices);
    } catch {
      if (current()) setError('暂时无法确认规划模型，请重试。');
    } finally {
      if (current()) setChecking(false);
    }
  }, [api, begin, checking]);
  const selectModel = useCallback(
    async (id: string) => {
      if (!alive.current || checking || selecting || choices?.kind !== 'ready') return;
      const { request, current } = begin();
      setSelecting(true);
      setError('');
      try {
        const next = await choosePlanningModel(api, choices.items, id, request.signal);
        if (!current()) return;
        setChoices(next.choices);
        setModel(next.model);
      } catch (caught) {
        if (!current()) return;
        setError(
          caught instanceof WorkbenchError ? caught.message : '暂时无法切换规划模型，请重试。',
        );
      } finally {
        if (alive.current && active.current === request) setSelecting(false);
      }
    },
    [api, begin, checking, choices, selecting],
  );
  return {
    model,
    choices,
    ready: !api.member || api.member.capabilities()?.planning === true,
    checking,
    selecting,
    error,
    refresh,
    loadCatalog,
    selectModel,
  };
}

export function PlanningReadiness({ value }: { value: ReturnType<typeof usePlanningReadiness> }) {
  useEffect(() => {
    const request = new AbortController();
    void value.loadCatalog(request.signal);
    return () => request.abort();
  }, [value.loadCatalog]);
  const switchable = value.choices?.kind === 'ready' && value.choices.items.length > 0;
  const selected =
    switchable && value.choices?.selectedId
      ? value.choices.items.find((item) => item.id === value.choices?.selectedId)
      : undefined;
  return (
    <div className="zm-planning-readiness" aria-label="规划模型状态">
      <div>
        {switchable && value.choices?.kind === 'ready' ? (
          <div className="zm-planning-model">
            <strong>{selected ? '规划模型 · ' : `规划模型 · ${value.model}`}</strong>
            <SingleSelect
              label="规划模型"
              value={value.choices.selectedId ?? ''}
              options={value.choices.items.map((item) => ({ value: item.id, label: item.label }))}
              disabled={value.checking || value.selecting}
              onValueChange={(id) => void value.selectModel(id)}
            />
          </div>
        ) : (
          <strong>{value.ready ? `规划模型 · ${value.model}` : '当前服务未配置规划模型'}</strong>
        )}
        {!value.ready && !switchable && (
          <p>请由服务操作者配置后刷新。本机模型设置不会自动配置共享服务，仍可手工编排。</p>
        )}
        {value.choices?.kind === 'unavailable' && value.choices.message && (
          <p role="alert">{value.choices.message}</p>
        )}
        {value.choices?.kind === 'ready' && !value.choices.items.length && value.ready && (
          <p>
            当前没有可切换的规划模型。请由服务操作者配置后刷新。本机模型设置不会自动配置共享服务。
          </p>
        )}
        {value.error && <p role="alert">{value.error}</p>}
      </div>
      <Button
        variant="quiet"
        busy={value.checking || value.selecting}
        busyLabel={value.selecting ? '正在切换…' : '正在刷新…'}
        onClick={() => void value.refresh()}
      >
        刷新模型
      </Button>
    </div>
  );
}
