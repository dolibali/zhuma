import { canonicalPayload } from './concurrency.js';
import { z } from 'zod';
import { WorkbenchError, type Workflow, type WorkNode } from './workbench.js';

/** A local adjustment edits an existing node's configuration, never its topology. */
export const LOCAL_PLANNING_FIELDS = [
  'title',
  'description',
  'assigneeId',
  'reviewRequired',
  'reviewerIds',
  'skillIds',
  'mcpIds',
  'input',
  'output',
  'rationale',
] as const satisfies readonly (keyof WorkNode)[];
export const PlanningAdjustmentSchema = z.strictObject({
  nodeId: z.string().min(1).max(100),
  fields: z
    .array(z.enum(LOCAL_PLANNING_FIELDS))
    .min(1)
    .max(LOCAL_PLANNING_FIELDS.length)
    .refine((fields) => new Set(fields).size === fields.length, '调整字段不能重复。'),
});
export type PlanningAdjustment = z.infer<typeof PlanningAdjustmentSchema>;
const NODE_FIELDS = [...LOCAL_PLANNING_FIELDS, 'dependsOn', 'position'] as const;
export type PlanningNodeField = (typeof NODE_FIELDS)[number];
export type PlanningNodeChange =
  | { kind: 'added'; workflowId: string; after: WorkNode }
  | { kind: 'removed'; workflowId: string; before: WorkNode }
  | {
      kind: 'changed';
      workflowId: string;
      before: WorkNode;
      after: WorkNode;
      fields: PlanningNodeField[];
    };
export type PlanningWorkflowChange =
  | { kind: 'added'; after: Workflow }
  | { kind: 'removed'; before: Workflow }
  | {
      kind: 'changed';
      before: Workflow;
      after: Workflow;
      fields: ('name' | 'parentNodeId' | 'nodeOrder')[];
    };
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);

export function requirePlanningTarget(workflows: readonly Workflow[], targetNodeId: string): void {
  if (!workflows.some((workflow) => workflow.nodes.some((node) => node.id === targetNodeId)))
    throw new WorkbenchError('invalid-scope', '调整的节点已不存在，请重新选择调整范围。');
}

/** Validate against the captured saved task or unapplied proposal, not a model-supplied baseline. */
export function validateLocalPlanningChange(
  before: readonly Workflow[],
  after: readonly Workflow[],
  adjustment: PlanningAdjustment,
): void {
  requirePlanningTarget(before, adjustment.nodeId);
  const editable = new Set<string>(adjustment.fields);
  const protectedShape = (workflows: readonly Workflow[]) =>
    workflows.map((workflow) => ({
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.id === adjustment.nodeId
          ? Object.fromEntries(Object.entries(node).filter(([field]) => !editable.has(field)))
          : node,
      ),
    }));
  if (!same(protectedShape(before), protectedShape(after)))
    throw new WorkbenchError(
      'invalid-plan',
      '本次只允许修改指定节点的指定字段。保留其余配置、其他节点、工作流层级、节点顺序、依赖和位置；不要增删或移动节点。',
    );
}

/** Describe every persisted graph difference, including ordering and layout-only edits. */
export function comparePlanningWorkflows(before: readonly Workflow[], after: readonly Workflow[]) {
  const workflows: PlanningWorkflowChange[] = [];
  const nodes: PlanningNodeChange[] = [];
  const previous = new Map(before.map((workflow) => [workflow.id, workflow]));
  const next = new Map(after.map((workflow) => [workflow.id, workflow]));
  for (const workflow of before)
    if (!next.has(workflow.id)) workflows.push({ kind: 'removed', before: workflow });
  for (const workflow of after) {
    const old = previous.get(workflow.id);
    if (!old) workflows.push({ kind: 'added', after: workflow });
    else {
      const fields: ('name' | 'parentNodeId' | 'nodeOrder')[] = [];
      if (old.name !== workflow.name) fields.push('name');
      if (old.parentNodeId !== workflow.parentNodeId) fields.push('parentNodeId');
      if (
        !same(
          old.nodes.map((node) => node.id),
          workflow.nodes.map((node) => node.id),
        )
      )
        fields.push('nodeOrder');
      if (fields.length) workflows.push({ kind: 'changed', before: old, after: workflow, fields });
    }
  }
  for (const workflowId of new Set([...previous.keys(), ...next.keys()])) {
    const oldNodes = previous.get(workflowId)?.nodes ?? [];
    const newNodes = next.get(workflowId)?.nodes ?? [];
    const oldById = new Map(oldNodes.map((node) => [node.id, node]));
    const newById = new Map(newNodes.map((node) => [node.id, node]));
    for (const node of oldNodes)
      if (!newById.has(node.id)) nodes.push({ kind: 'removed', workflowId, before: node });
    for (const node of newNodes) {
      const old = oldById.get(node.id);
      if (!old) nodes.push({ kind: 'added', workflowId, after: node });
      else {
        const fields = NODE_FIELDS.filter((field) => !same(old[field], node[field]));
        if (fields.length)
          nodes.push({ kind: 'changed', workflowId, before: old, after: node, fields });
      }
    }
  }
  const orderChanged = !same(
    before.map((workflow) => workflow.id),
    after.map((workflow) => workflow.id),
  );
  return {
    workflows,
    nodes,
    orderChanged,
    changed: !!(workflows.length || nodes.length || orderChanged),
  };
}
