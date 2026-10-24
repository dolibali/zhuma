import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../workbench/Button.js';
import { Field } from '../workbench/controls.js';
import { SingleSelect } from '../workbench/SingleSelect.js';
import {
  executionErrorMessage,
  type ExecutionApi,
  type StartablePlanWire,
} from './ExecutionApi.js';
import { StartPlanPanel } from './StartPlanPanel.js';
import { useFormKey } from './interaction.js';

type Props = { api: ExecutionApi; onStarted(): void };
type Choice = { key: string; token: object };
type Catalog =
  | { kind: 'loading' | 'ready'; plans: readonly StartablePlanWire[] }
  | { kind: 'error'; plans: readonly StartablePlanWire[]; message: string };
const planKey = (plan: StartablePlanWire) =>
  JSON.stringify([plan.taskId, plan.planId, plan.revision]);

export function StartablePlansPanel(props: Props) {
  const key = useFormKey(props.api, 'startable-plans');
  return <CatalogPanel key={key} {...props} />;
}
function CatalogPanel({ api, onStarted }: Props) {
  const heading = useId();
  const [catalog, setCatalog] = useState<Catalog>({ kind: 'loading', plans: [] });
  const [choice, setChoice] = useState<Choice>();
  const selection = useRef(choice);
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const read = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(async () => {
    if (!alive.current) return;
    read.current?.abort();
    const request = new AbortController();
    read.current = request;
    const current = () => alive.current && read.current === request && !request.signal.aborted;
    setCatalog((previous) => ({ kind: 'loading', plans: previous.plans }));
    try {
      const value = await api.startable(request.signal);
      if (!current()) return;
      if (
        selection.current &&
        !value.plans.some((plan) => planKey(plan) === selection.current?.key)
      ) {
        selection.current = undefined;
        setChoice(undefined);
      }
      setCatalog({ kind: 'ready', plans: value.plans });
    } catch (error) {
      if (current())
        setCatalog((previous) => ({
          kind: 'error',
          plans: previous.plans,
          message: executionErrorMessage(error),
        }));
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, [reload]);

  const plan = choice ? catalog.plans.find((plan) => planKey(plan) === choice.key) : undefined;
  function select(key: string) {
    const next = key ? { key, token: {} } : undefined;
    selection.current = next;
    setChoice(next);
    setNotice('');
  }
  function started(saved: Choice, title: string, revision: number) {
    if (!alive.current || selection.current?.token !== saved.token) return;
    selection.current = undefined;
    setChoice(undefined);
    setNotice(`「${title}」第 ${revision} 版已开始执行`);
    void reload();
    onStarted();
  }
  const label = (plan: StartablePlanWire) => `${plan.title} · 第 ${plan.revision} 版`;
  const labels = new Map<string, number>();
  for (const plan of catalog.plans) labels.set(label(plan), (labels.get(label(plan)) ?? 0) + 1);
  const options = catalog.plans.map((plan) => ({
    value: planKey(plan),
    label:
      (labels.get(label(plan)) ?? 0) > 1
        ? `${label(plan)} · ${plan.taskId} / ${plan.planId}`
        : label(plan),
  }));
  return (
    <section className="zm-execution-catalog" aria-labelledby={heading}>
      <div className="zm-page-heading">
        <h2 id={heading}>
          待开始{' '}
          {catalog.kind === 'ready' && <span className="zm-kind">{catalog.plans.length}</span>}
        </h2>
        <Button
          variant="quiet"
          busy={catalog.kind === 'loading'}
          busyLabel="正在读取…"
          onClick={() => void reload()}
        >
          刷新计划
        </Button>
      </div>
      {notice && (
        <p role="status" className="zm-execution-notice">
          {notice}
        </p>
      )}
      {catalog.kind === 'error' && (
        <div role="alert" className="zm-error">
          {catalog.message}
        </div>
      )}
      {catalog.kind === 'loading' && !catalog.plans.length && <p role="status">正在读取计划…</p>}
      {catalog.kind === 'ready' && !catalog.plans.length && (
        <p className="zm-empty">暂无待开始的计划</p>
      )}
      {!!catalog.plans.length && (
        <div className="zm-execution-plan-picker">
          <Field label="已确认计划">
            <SingleSelect
              label="已确认计划"
              value={choice?.key ?? ''}
              disabled={catalog.kind !== 'ready'}
              options={[{ value: '', label: '选择一个计划' }, ...options]}
              onValueChange={select}
            />
          </Field>
        </div>
      )}
      {choice && plan && (
        <StartPlanPanel
          api={api}
          plan={plan}
          disabled={catalog.kind !== 'ready'}
          onStarted={() => started(choice, plan.title, plan.revision)}
        />
      )}
    </section>
  );
}
