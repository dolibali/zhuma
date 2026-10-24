import { useEffect, useRef, useState } from 'react';
import { WorkbenchError, type InboxItem } from '@zhuma/agent-core';
import type {
  ExecutionApi,
  ExecutionNodeWire,
  InboxPlace,
  RevisionViewWire,
} from './ExecutionApi.js';
import { DeliveryPanel } from './DeliveryPanel.js';
import { InboxPanel } from './InboxPanel.js';
import { RevisionPanel } from './RevisionPanel.js';
import { ReviewWorkspace } from './ReviewWorkspace.js';

/** Which panels an inbox action opens. A return lands on the reviewed content. */
export function executionPanels(action: string): readonly ('revision' | 'delivery' | 'review')[] {
  if (action === 'review') return ['review'];
  if (action === 'revise') return ['revision', 'delivery'];
  if (action === 'submit') return ['delivery'];
  return [];
}

export function ExecutionWorkspace({ api }: { api: ExecutionApi }) {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [places, setPlaces] = useState<readonly InboxPlace[]>([]);
  const [nodes, setNodes] = useState<readonly ExecutionNodeWire[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<InboxItem | undefined>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [revision, setRevision] = useState<RevisionViewWire | undefined>();
  const [revisionError, setRevisionError] = useState('');
  const [revisionPending, setRevisionPending] = useState(false);

  async function reload(signal?: AbortSignal) {
    setPending(true);
    setError('');
    try {
      const inbox = await api.inbox(signal);
      if (signal?.aborted) return;
      setItems(inbox.items);
      setPlaces(inbox.places ?? []);
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

  useEffect(() => {
    const panels = selected ? executionPanels(selected.action) : [];
    if (!selected || !panels.includes('revision')) {
      setRevision(undefined);
      setRevisionError('');
      setRevisionPending(false);
      return;
    }
    const current = nodes.find(
      (item) => item.nodeId === selected.nodeId && item.taskId === selected.taskId,
    );
    if (!current) return;
    const controller = new AbortController();
    setRevision(undefined);
    setRevisionError('');
    setRevisionPending(true);
    void api
      .revision(
        {
          taskId: current.taskId,
          planId: current.planId,
          revision: current.revision,
          nodeId: current.nodeId,
        },
        controller.signal,
      )
      .then((view) => {
        if (controller.signal.aborted) return;
        setRevision(view);
        setRevisionPending(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setRevisionError(
          caught instanceof WorkbenchError ? caught.message : '退回意见暂时读不出来。',
        );
        setRevisionPending(false);
      });
    return () => controller.abort();
  }, [api, nodes, selected]);

  useEffect(() => {
    if (!revision) return;
    const target = document.getElementById('revision-reviewed');
    target?.scrollIntoView({ block: 'start' });
    target?.focus();
  }, [revision]);

  const node = selected
    ? nodes.find((item) => item.nodeId === selected.nodeId && item.taskId === selected.taskId)
    : undefined;
  const panels = selected ? executionPanels(selected.action) : [];
  function submitted(next: ExecutionNodeWire) {
    setNodes((current) =>
      current.map((item) =>
        item.nodeId === next.nodeId && item.taskId === next.taskId ? next : item,
      ),
    );
    const current = selectedRef.current;
    if (!current || current.nodeId !== next.nodeId || current.taskId !== next.taskId) return;
    setSelected(undefined);
    void reload();
  }

  return (
    <>
      <InboxPanel
        items={items}
        nodes={nodes}
        places={places}
        error={error}
        pending={pending}
        reload={() => void reload()}
        open={setSelected}
      />
      {selected && !node && <p className="zm-empty">这项工作的详情还没有同步。</p>}
      {selected && node && panels.includes('revision') && (
        <RevisionPanel
          {...(revision === undefined ? {} : { view: revision })}
          pending={revisionPending}
          error={revisionError}
        />
      )}
      {selected && node && panels.includes('review') && (
        <ReviewWorkspace
          key={`${node.taskId}:${node.planId}:${node.revision}:${node.nodeId}:${node.currentRoundId ?? ''}`}
          api={api}
          node={node}
          onSubmitted={submitted}
        />
      )}
      {selected && node && panels.includes('delivery') && (
        <DeliveryPanel
          key={`${node.taskId}:${node.planId}:${node.revision}:${node.nodeId}`}
          api={api}
          node={node}
          onSubmitted={submitted}
        />
      )}
      {selected && node && panels.length === 0 && (
        <p className="zm-empty">这个动作还没有接到交付或评审页面。</p>
      )}
    </>
  );
}
