import type { WorkTask, WorkNode, Workflow } from '@zhuma/agent-core';

export type WorkLocation = { workflowId: string; nodeId: string | null };
export type WorkTree = {
  root: Workflow;
  workflows: Map<string, Workflow>;
  nodes: Map<string, WorkNode>;
  owner: Map<string, Workflow>;
  child: Map<string, Workflow>;
};

// Only index the supplied task's reachable hierarchy. No global task lookup or permission inference.
export function indexWorkTree(task: WorkTask): WorkTree {
  const root = task.workflows.find((w) => !w.parentNodeId) ?? {
    id: '',
    name: '工作流不可用',
    parentNodeId: null,
    nodes: [],
  };
  const children = new Map(
    task.workflows.filter((w) => w.parentNodeId).map((w) => [w.parentNodeId!, w]),
  );
  const tree: WorkTree = {
    root,
    workflows: new Map(),
    nodes: new Map(),
    owner: new Map(),
    child: new Map(),
  };
  const visit = (workflow: Workflow) => {
    if (tree.workflows.has(workflow.id)) return;
    tree.workflows.set(workflow.id, workflow);
    for (const node of workflow.nodes) {
      if (tree.nodes.has(node.id)) continue;
      tree.nodes.set(node.id, node);
      tree.owner.set(node.id, workflow);
      const child = children.get(node.id);
      if (child && !tree.workflows.has(child.id)) {
        tree.child.set(node.id, child);
        visit(child);
      }
    }
  };
  visit(root);
  return tree;
}

export function workflowPath(tree: WorkTree, workflowId: string): Workflow[] {
  const result: Workflow[] = [];
  const seen = new Set<string>();
  let current = tree.workflows.get(workflowId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.unshift(current);
    current = current.parentNodeId ? tree.owner.get(current.parentNodeId) : undefined;
  }
  return result;
}

export function resolveWorkLocation(
  tree: WorkTree,
  requested: WorkLocation,
  remembered: ReadonlyMap<string, string | null>,
  fallbackPath: readonly string[] = [],
): WorkLocation {
  const workflow =
    [requested.workflowId, ...fallbackPath.slice().reverse()]
      .map((id) => tree.workflows.get(id))
      .find((w) => w) ?? tree.root;
  const candidates = [
    requested.workflowId === workflow.id ? requested.nodeId : null,
    remembered.get(workflow.id),
  ];
  const nodeId =
    candidates.find((id) => id && workflow.nodes.some((n) => n.id === id)) ??
    workflow.nodes[0]?.id ??
    null;
  return { workflowId: workflow.id, nodeId };
}

export function visibleWorkflows(tree: WorkTree, expanded: ReadonlySet<string>): Workflow[] {
  return [...tree.workflows.values()].filter((w) =>
    workflowPath(tree, w.id)
      .slice(1)
      .every((ancestor) => expanded.has(ancestor.id)),
  );
}

export function nodeRelations(tree: WorkTree, nodeId: string | null) {
  const node = nodeId ? tree.nodes.get(nodeId) : undefined;
  const workflow = node ? tree.owner.get(node.id) : undefined;
  // Dependency references are local to this workflow; invalid/hidden IDs never become labels.
  return {
    before: workflow?.nodes.filter((n) => node?.dependsOn.includes(n.id)) ?? [],
    after: workflow?.nodes.filter((n) => node && n.dependsOn.includes(node.id)) ?? [],
  };
}
