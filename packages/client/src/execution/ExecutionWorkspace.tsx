import { useEffect, useState } from 'react';
import { WorkbenchError, type InboxItem } from '@zhuma/agent-core';
import type { ExecutionApi, ExecutionNodeWire } from './ExecutionApi.js';
import { DeliveryPanel } from './DeliveryPanel.js';
import { InboxPanel } from './InboxPanel.js';
import { ReviewWorkspace } from './ReviewWorkspace.js';

export function ExecutionWorkspace({ api }: { api: ExecutionApi }) {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [nodes, setNodes] = useState<readonly ExecutionNodeWire[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<InboxItem | undefined>();

  async function reload(signal?: AbortSignal) {
    setPending(true);
    setError('');
    try {
      const inbox = await api.inbox(signal);
      if (signal?.aborted) return;
      setItems(inbox.items);
      setNodes(inbox.nodes);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof WorkbenchError ? caught.message : '待办暂时读不出来。');
    } finally {
      if (!signal?.aborted) setPending(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [api]);

  const node = selected
    ? nodes.find((item) => item.nodeId === selected.nodeId && item.taskId === selected.taskId)
    : undefined;
  function submitted(next: ExecutionNodeWire) {
    setNodes((current) =>
      current.map((item) =>
        item.nodeId === next.nodeId && item.taskId === next.taskId ? next : item,
      ),
    );
    setSelected(undefined);
    void reload();
  }

  return (
    <>
      <InboxPanel
        items={items}
        nodes={nodes}
        error={error}
        pending={pending}
        reload={() => void reload()}
        open={setSelected}
      />
      {selected && !node && <p className="zm-empty">这项工作的详情还没有同步。</p>}
      {selected && node && selected.action === 'review' && (
        <ReviewWorkspace api={api} node={node} onSubmitted={submitted} />
      )}
      {selected && node && (selected.action === 'submit' || selected.action === 'revise') && (
        <DeliveryPanel api={api} node={node} onSubmitted={submitted} />
      )}
      {selected &&
        node &&
        selected.action !== 'review' &&
        selected.action !== 'submit' &&
        selected.action !== 'revise' && (
          <p className="zm-empty">这个动作还没有接到交付或评审页面。</p>
        )}
    </>
  );
}
