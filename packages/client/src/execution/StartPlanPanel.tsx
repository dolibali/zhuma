import { useId } from 'react';
import { Button } from '../workbench/Button.js';
import type { ExecutionApi, StartablePlanWire } from './ExecutionApi.js';
import { useExecutionCommand, useFormKey } from './interaction.js';

export type ExecutionPlan = StartablePlanWire;
type Props = { api: ExecutionApi; plan: ExecutionPlan; disabled?: boolean; onStarted(): void };
export function StartPlanPanel(props: Props) {
  const key = useFormKey(
    props.api,
    JSON.stringify([props.plan.taskId, props.plan.planId, props.plan.revision]),
  );
  return <StartPlanForm key={key} {...props} />;
}
function StartPlanForm({ api, plan, disabled, onStarted }: Props) {
  const titleId = useId();
  const command = useExecutionCommand();
  const payload = { taskId: plan.taskId, planId: plan.planId, revision: plan.revision };
  return (
    <section className="zm-execution-start" aria-labelledby={titleId}>
      <div>
        <h3 id={titleId}>{plan.title}</h3>
        <p>已确认计划 · 第 {plan.revision} 版</p>
      </div>
      <Button
        variant="primary"
        disabled={disabled}
        busy={command.pending}
        busyLabel="正在派发…"
        onClick={() =>
          void command.run(
            payload,
            (idempotencyKey, signal) => api.startPlan({ ...payload, idempotencyKey }, signal),
            onStarted,
          )
        }
      >
        开始执行
      </Button>
      {command.error && (
        <div role="alert" className="zm-error">
          {command.error}
        </div>
      )}
    </section>
  );
}
