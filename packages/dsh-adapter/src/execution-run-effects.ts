import type { ExecutionRunDecision, ExecutionRunEffect } from './execution-run-state.js';
import { ExecutionRunError } from './execution-run-state.js';

type Dispatch = Extract<ExecutionRunEffect, { readonly kind: 'dispatch' | 'reconcile' }>;
type Stop = Extract<ExecutionRunEffect, { readonly kind: 'stop' }>;

/** A/C supply actual capability-checked native operations. Reconciliation is read-only:
 * it must not delegate back to dispatch, resume an Agent, or resend unknown input.
 */
export interface ExecutionRunEffectDriver<T> {
  dispatch(effect: Dispatch): Promise<T>;
  reconcile(effect: Dispatch): Promise<T>;
  stop(effect: Stop): Promise<T>;
}

/** Explicit command orchestration, no own queue or storage. B's commit callback must
 * resolve only after its existing queue has written the full node exactly once.
 * Native work consequently runs outside that queue, after durability. A failed native
 * call is ambiguous: its error never implies no admission, completion, or freed claims.
 */
export async function afterExecutionRunCommit<T>(
  commit: () => Promise<ExecutionRunDecision>,
  driver: ExecutionRunEffectDriver<T>,
): Promise<{ readonly decision: ExecutionRunDecision; readonly result?: T }> {
  const decision = await commit();
  const effect = decision.effect;
  if (!effect) return { decision };
  try {
    const result =
      effect.kind === 'dispatch'
        ? await driver.dispatch(effect)
        : effect.kind === 'reconcile'
          ? await driver.reconcile(effect)
          : await driver.stop(effect);
    return { decision, result };
  } catch {
    throw new ExecutionRunError('run-effect-unknown');
  }
}
