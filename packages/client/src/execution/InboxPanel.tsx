import { useId, type ReactNode } from 'react';
import type { InboxItem, NodeStatus } from '@zhuma/agent-core';
import {
  INBOX_GROUPS,
  inboxItemGroup,
  NODE_STATUS_LABELS,
  createInboxItemView,
} from '../execution-view.js';
import { Button } from '../workbench/Button.js';
import type { ExecutionNodeWire, InboxPlaceWire } from './ExecutionApi.js';

function statusLabel(status: string): string {
  return status in NODE_STATUS_LABELS ? NODE_STATUS_LABELS[status as NodeStatus] : status;
}
function readyFor(item: InboxItem, node: ExecutionNodeWire): boolean {
  if (item.action === 'submit') return node.status === 'ready';
  if (item.action === 'revise') return node.status === 'needs-revision';
  if (item.action === 'continue-handling') return node.status === 'running';
  if (item.action === 'review')
    return (
      node.status === 'in-review' &&
      node.rounds.some((round) => round.id === node.currentRoundId && round.status === 'open')
    );
  return false;
}
function indexBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const existing = index.get(id);
    if (existing) existing.push(value);
    else index.set(id, [value]);
  }
  return index;
}

export function InboxPanel({
  items,
  nodes,
  places,
  error,
  pending = false,
  reload,
  open,
  renderAgentAction,
}: {
  items: readonly InboxItem[];
  nodes: readonly ExecutionNodeWire[];
  places?: readonly InboxPlaceWire[];
  error?: string;
  pending?: boolean;
  reload(): void;
  open(item: InboxItem): void;
  renderAgentAction?: ((node: ExecutionNodeWire) => ReactNode) | undefined;
}) {
  const heading = useId();
  const nodeKey = (value: { taskId: string; nodeId: string }) =>
    JSON.stringify([value.taskId, value.nodeId]);
  const nodeIndex = indexBy(nodes, nodeKey);
  const itemIndex = indexBy(items, (item) => item.id);
  const placeIndex = indexBy(places ?? [], (place) => place.itemId);
  const rows = items.map((item, index) => {
    const matches = nodeIndex.get(nodeKey(item)) ?? [];
    const uniqueItem = itemIndex.get(item.id)?.length === 1;
    const locations = uniqueItem ? placeIndex.get(item.id) : undefined;
    const node = uniqueItem && matches.length === 1 ? matches[0] : undefined;
    return {
      item,
      index,
      node,
      group: inboxItemGroup(item),
      view: createInboxItemView(item),
      place: node && locations?.length === 1 ? locations[0] : undefined,
    };
  });
  return (
    <section aria-labelledby={heading}>
      <div className="zm-page-heading">
        <div>
          <p className="zm-eyebrow">执行</p>
          <div className="zm-inbox-title">
            <h2 id={heading}>需要我处理</h2>
            {!!rows.length && <span className="zm-kind">已载入 {rows.length} 个工作项</span>}
          </div>
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
      {!rows.length && !pending && !error && <p className="zm-empty">现在没有需要你处理的工作。</p>}
      {INBOX_GROUPS.map((group) => {
        const grouped = rows.filter((row) => row.group === group.id);
        if (!grouped.length) return null;
        const groupHeading = `${heading}-${group.id}`;
        return (
          <section key={group.id} className="zm-inbox-group" aria-labelledby={groupHeading}>
            <h3 id={groupHeading}>
              {group.label}
              <span className="zm-kind">{grouped.length} 个工作项</span>
            </h3>
            <div className="zm-directory zm-execution-inbox">
              {grouped.map(({ item, index, node, place, view }) => {
                const agent = group.id === 'active';
                const supported = agent || ['deliver', 'revise', 'review'].includes(group.id);
                const current = supported && !!node && readyFor(item, node);
                const enabled = current && (!agent || !!renderAgentAction);
                return (
                  <article
                    className="zm-directory-row"
                    key={JSON.stringify([item.id, item.taskId, item.nodeId, index])}
                    aria-label={node?.goal || view.kindLabel}
                  >
                    <div className="zm-directory-content">
                      <strong>{node?.goal || view.nodeId}</strong>
                      <p className="zm-inbox-path">{place?.taskPath || '来源路径未提供'}</p>
                      <div className="zm-inbox-meta">
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
                        <span>任务负责人：{place?.ownerName || '未提供'}</span>
                      </div>
                      {view.detail && <p className="zm-inbox-detail">{view.detail}</p>}
                      {node?.blockReason && <small>{node.blockReason}</small>}
                      {!node && <small>工作版本尚未确定，请刷新待办。</small>}
                      {supported && node && !current && (
                        <small>工作状态或当前轮次已变化，请刷新待办。</small>
                      )}
                      {agent && current && !renderAgentAction && (
                        <small>Agent 会话暂不可用，请刷新后重试。</small>
                      )}
                    </div>
                    <div className="zm-directory-actions">
                      {agent && enabled ? (
                        renderAgentAction!(node!)
                      ) : supported ? (
                        <Button disabled={!enabled} onClick={() => open(item)}>
                          {agent ? '打开 Agent 会话' : view.actionLabel}
                        </Button>
                      ) : (
                        <span className="zm-muted zm-inbox-unavailable">
                          {view.actionLabel} · 处理入口尚未接入
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}
