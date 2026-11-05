import type { NodeStatus } from '@zhuma/agent-core';
import { NODE_STATUS_LABELS } from '../execution-view.js';

/** Canvas mark for one confirmed node. Rendering does not start or change work. */
export function NodeStatusMark({
  status,
  executing = false,
}: {
  status?: NodeStatus | undefined;
  executing?: boolean;
}) {
  if (executing || status === 'running')
    return (
      <span className="zm-flow-status zm-flow-status-running" title="执行中">
        <span className="zm-spinner" role="img" aria-label="执行中" />
      </span>
    );
  if (status === 'completed')
    return (
      <span
        className="zm-flow-status zm-flow-status-completed"
        role="img"
        aria-label="已完成"
        title="已完成"
      />
    );
  if (status === 'blocked' || status === 'ready' || status === 'waiting-for-input') {
    const label = NODE_STATUS_LABELS[status];
    return (
      <span
        className="zm-flow-status zm-flow-status-waiting"
        role="img"
        aria-label={label}
        title={label}
      />
    );
  }
  return null;
}
