import { validatePlan, type Workflow } from '@zhuma/agent-core';

/** Explicit dependencies whose ordering is already implied by another path in this workflow. */
export function transitiveDependencies(workflow: Workflow): Map<string, Set<string>> {
  const redundant = new Map<string, Set<string>>();
  if (!workflow.nodes.some((node) => node.dependsOn.length > 1)) return redundant;
  // During editing, keep the entire graph visible if its ordering is not well defined.
  const issues = validatePlan({
    id: workflow.id,
    revision: 1,
    steps: workflow.nodes.map((node) => ({
      id: node.id,
      label: node.title,
      kind: 'agent',
      dependsOn: node.dependsOn,
    })),
  });
  if (issues.length) return redundant;

  const parents = new Map(workflow.nodes.map((node) => [node.id, node.dependsOn]));
  for (const node of workflow.nodes) {
    if (node.dependsOn.length < 2) continue;
    // Start two hops upstream. A direct parent found here is reachable through a sibling parent.
    const pending = node.dependsOn.flatMap((parent) => parents.get(parent) ?? []);
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of parents.get(id) ?? []) pending.push(parent);
    }
    const implied = node.dependsOn.filter((id) => seen.has(id));
    if (implied.length) redundant.set(node.id, new Set(implied));
  }
  return redundant;
}
