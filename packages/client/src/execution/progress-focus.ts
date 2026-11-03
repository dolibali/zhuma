import type { NodeStatus } from '@zhuma/agent-core';
import type { TaskProgressRow, TaskProgressNodeState } from './task-progress.js';
import type { TaskProgressState } from './useTaskProgress.js';

/** Nodes the list and canvas should treat as the current execution, in plan order. */
export function focusNodes(row: TaskProgressRow): readonly TaskProgressNodeState[] {
  if (row.facts !== 'present') return [];
  const active = row.nodeStatuses.filter(
    (node) => node.status === 'running' || node.authorHeld > 0,
  );
  if (active.length) return active;
  if (row.workflow === 'running' || row.workflow === 'stopping')
    return row.nodeStatuses.filter((node) => node.status === 'ready');
  return [];
}

/** A confirmed plan is executing when a node, a held run, or the workflow intent says so. */
export function progressIsExecuting(row: TaskProgressRow): boolean {
  if (row.facts !== 'present' || row.delivery !== 'pending') return false;
  return focusNodes(row).length > 0;
}

export function confirmedNodeTitles(
  plans: readonly {
    readonly id: string;
    readonly taskId: string;
    readonly revision: number;
    readonly task: {
      readonly workflows: readonly {
        readonly nodes: readonly { readonly id: string; readonly title: string }[];
      }[];
    };
  }[],
  progress: TaskProgressState | undefined,
): ReadonlyMap<string, string> | undefined {
  if (!progress || progress.state !== 'ready' || progress.row.facts === 'unknown') return;
  const target = progress.row.target;
  const plan = plans.find(
    (item) =>
      item.id === target.planId &&
      item.taskId === target.taskId &&
      item.revision === target.revision,
  );
  if (!plan) return;
  return new Map(
    plan.task.workflows.flatMap((workflow) =>
      workflow.nodes.map((node) => [node.id, node.title] as const),
    ),
  );
}

export interface FlowNodeMark {
  readonly status: NodeStatus;
  readonly executing: boolean;
}

export function progressNodeMarks(
  progress: TaskProgressState | undefined,
): ReadonlyMap<string, FlowNodeMark> | undefined {
  if (!progress || progress.state !== 'ready' || progress.row.facts !== 'present') return;
  const focus = new Set(focusNodes(progress.row).map((node) => node.nodeId));
  return new Map(
    progress.row.nodeStatuses.map((node) => [
      node.nodeId,
      { status: node.status, executing: focus.has(node.nodeId) },
    ]),
  );
}
