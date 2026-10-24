import type { InboxItem, NodeStatus } from '@zhuma/agent-core';
import { NODE_STATUS_LABELS, createInboxItemView } from '../execution-view.js';
import { Button } from '../workbench/Button.js';
import type { ExecutionNodeWire } from './ExecutionApi.js';

function statusLabel(status: string): string {
  return status in NODE_STATUS_LABELS ? NODE_STATUS_LABELS[status as NodeStatus] : status;
}

export function InboxPanel({
  items,
  nodes,
  error,
  pending = false,
  reload,
  open,
}: {
  items: readonly InboxItem[];
  nodes: readonly ExecutionNodeWire[];
  error?: string;
  pending?: boolean;
  reload(): void;
  open(item: InboxItem): void;
}) {
  const rows = items.map((item) => ({
    item,
    view: createInboxItemView(item),
    node: nodes.find((node) => node.nodeId === item.nodeId && node.taskId === item.taskId),
  }));
  return (
    <section aria-labelledby="zhuma-inbox-title">
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">执行</p>
          <h2 id="zhuma-inbox-title">需要我处理</h2>
        </div>
        <Button variant="secondary" busy={pending} busyLabel="正在读取…" onClick={reload}>
          刷新
        </Button>
      </div>
      {error && (
        <div role="alert" className="zm-error">
          {error}
        </div>
      )}
      {!rows.length && !pending && <p className="zm-empty">现在没有需要你处理的工作。</p>}
      {!!rows.length && (
        <div className="zm-directory">
          {rows.map(({ item, view, node }) => (
            <article
              className="zm-directory-row"
              key={item.id}
              aria-label={node?.goal || view.kindLabel}
            >
              <div className="zm-directory-content">
                <strong>{node?.goal || view.nodeId}</strong>
                <p>
                  <span className="zm-kind">{view.kindLabel}</span>
                  {node && (
                    <span
                      className={
                        node.status === 'ready' || node.status === 'completed'
                          ? 'zm-status ready'
                          : 'zm-status'
                      }
                    >
                      {statusLabel(node.status)}
                    </span>
                  )}
                </p>
                {node?.blockReason && <small>{node.blockReason}</small>}
              </div>
              <div className="zm-directory-actions">
                <Button onClick={() => open(item)}>{view.actionLabel}</Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
