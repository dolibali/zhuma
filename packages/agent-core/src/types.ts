/** Product contracts; these are not DSH runtime types. */
/** `simulated` 只能被显式选中。未配置真实执行器时不得改用它。 */
export type ExecutionEngine = 'dsh' | 'codearts-cli' | 'simulated';
export type StepKind = 'agent' | 'tool' | 'verify' | 'approval';
export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'waiting-for-input'
  | 'verifying'
  | 'awaiting-review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface TaskSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly planRevision: number;
  readonly candidateId?: string;
}

export interface PlanStep {
  readonly id: string;
  readonly label: string;
  readonly kind: StepKind;
  readonly dependsOn: readonly string[];
}

export interface PlanDefinition {
  readonly id: string;
  readonly revision: number;
  readonly steps: readonly PlanStep[];
}

export interface PlanIssue {
  readonly code:
    'empty-plan' | 'invalid-revision' | 'duplicate-step' | 'unknown-dependency' | 'cycle';
  readonly message: string;
  readonly stepId?: string;
}
