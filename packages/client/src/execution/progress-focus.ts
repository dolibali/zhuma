import type { NodeStatus } from '@zhuma/agent-core';
import type { TaskProgressRow, TaskProgressNodeState } from './task-progress.js';
import type { TaskProgressState } from './useTaskProgress.js';

/**
 * Nodes the list and canvas should treat as the current execution, in plan order.
 * A live workflow may queue ready expert nodes. A ready human node is waiting.
 * Persisted intent and requires-resume are not execution, and missing node
 * detail is not filled in from counts.
 */
export function focusNodes(row: TaskProgressRow): readonly TaskProgressNodeState[] {
  if (row.facts !== 'present' || !row.nodeStatuses) return [];
  const active = row.nodeStatuses.filter(
    (node) => node.status === 'running' || node.authorHeld > 0,
  );
  if (active.length) return active;
  if (row.workflow !== 'running') return [];
  return row.nodeStatuses.filter((node) => node.status === 'ready' && node.assignee === 'expert');
}

/** Executing when a node is running, a run is held, or a live workflow has queued expert work. */
export function progressIsExecuting(row: TaskProgressRow): boolean {
  if (row.facts !== 'present' || row.delivery !== 'pending') return false;
  if (row.nodeStatuses) return focusNodes(row).length > 0;
  return row.byStatus.running > 0 || row.resources.authorHeld > 0;
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
  if (
    !progress ||
    progress.state !== 'ready' ||
    progress.row.facts !== 'present' ||
    !progress.row.nodeStatuses
  )
    return;
  const focus = new Set(focusNodes(progress.row).map((node) => node.nodeId));
  return new Map(
    progress.row.nodeStatuses.map((node) => [
      node.nodeId,
      { status: node.status, executing: focus.has(node.nodeId) },
    ]),
  );
}
