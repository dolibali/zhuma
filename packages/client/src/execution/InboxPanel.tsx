import type { InboxItem, InboxKind, NodeStatus } from '@zhuma/agent-core';
import { NODE_STATUS_LABELS, createInboxItemView } from '../execution-view.js';
import { Button } from '../workbench/Button.js';
import type { ExecutionNodeWire, InboxPlace } from './ExecutionApi.js';

const GROUPS: readonly { readonly kind: InboxKind; readonly label: string }[] = [
  { kind: 'deliver', label: '交付' },
  { kind: 'review', label: '评审' },
  { kind: 'confirm', label: '确认' },
];

function statusLabel(status: string): string {
  return status in NODE_STATUS_LABELS ? NODE_STATUS_LABELS[status as NodeStatus] : status;
}

export function InboxPanel({
  items,
  nodes,
  places = [],
  error,
  pending = false,
  reload,
  open,
}: {
  items: readonly InboxItem[];
  nodes: readonly ExecutionNodeWire[];
  places?: readonly InboxPlace[];
  error?: string;
  pending?: boolean;
  reload(): void;
  open(item: InboxItem): void;
}) {
  const rows = items.map((item) => ({
    item,
    view: createInboxItemView(item),
    node: nodes.find((node) => node.nodeId === item.nodeId && node.taskId === item.taskId),
    place: places.find((place) => place.itemId === item.id),
  }));
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((row) => row.item.kind === group.kind),
  })).filter((group) => group.rows.length > 0);
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
      {groups.map((group) => (
        <section
          key={group.kind}
          data-inbox-group={group.kind}
          aria-labelledby={`inbox-${group.kind}`}
        >
          <h3 id={`inbox-${group.kind}`}>{group.label}</h3>
          <div className="zm-directory">
            {group.rows.map(({ item, view, node, place }) => (
              <article
                className="zm-directory-row"
                key={item.id}
                aria-label={node?.goal || view.kindLabel}
              >
                <div className="zm-directory-content">
                  <strong>{node?.goal || view.nodeId}</strong>
                  {place?.taskPath && <p>{place.taskPath}</p>}
                  {place?.ownerName && <p>负责人 {place.ownerName}</p>}
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
                  <Button
                    data-revision-target={
                      item.action === 'revise' ? 'revision-reviewed' : undefined
                    }
                    onClick={() => open(item)}
                  >
                    {view.actionLabel}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
