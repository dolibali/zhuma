import type { PlanDefinition, PlanIssue } from './types.js';

/** Check graph invariants only. This is not a scheduler or authorization gate. */
export function validatePlan(plan: PlanDefinition): readonly PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
    issues.push({ code: 'invalid-revision', message: 'Plan revision must be a positive integer.' });
  }
  if (plan.steps.length === 0) {
    issues.push({ code: 'empty-plan', message: 'A plan must contain at least one step.' });
  }
  const byId = new Map<string, (typeof plan.steps)[number]>();
  for (const step of plan.steps) {
    if (byId.has(step.id)) {
      issues.push({
        code: 'duplicate-step',
        stepId: step.id,
        message: `Duplicate step: ${step.id}`,
      });
    } else {
      byId.set(step.id, step);
    }
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        issues.push({
          code: 'unknown-dependency',
          stepId: step.id,
          message: `Step ${step.id} depends on missing step ${dependency}.`,
        });
      }
    }
  }
  // Iterative Kahn traversal avoids recursion limits on user-authored plans.
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of byId.values()) {
    const dependencies = [...new Set(step.dependsOn)].filter((id) => byId.has(id));
    remaining.set(step.id, dependencies.length);
    for (const id of dependencies) {
      const next = dependents.get(id) ?? [];
      next.push(step.id);
      dependents.set(id, next);
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    if (id === undefined) continue;
    visited += 1;
    for (const next of dependents.get(id) ?? []) {
      const count = remaining.get(next);
      if (count === undefined) throw new Error('Invalid dependency bookkeeping.');
      remaining.set(next, count - 1);
      if (count === 1) ready.push(next);
    }
  }
  if (visited !== byId.size) {
    issues.push({ code: 'cycle', message: 'The plan contains a dependency cycle.' });
  }
  return issues;
}
