import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxItem } from '@zhuma/agent-core';
import {
  executionErrorMessage,
  type ExecutionApi,
  type ExecutionNodeWire,
} from './ExecutionApi.js';
import { DeliveryPanel } from './DeliveryPanel.js';
import { InboxPanel } from './InboxPanel.js';
import { ReviewWorkspace } from './ReviewWorkspace.js';
import { StartPlanPanel, type ExecutionPlan } from './StartPlanPanel.js';
import { nodeIdentity, reviewIdentity, useFormKey } from './interaction.js';

type Props = { api: ExecutionApi; plan?: ExecutionPlan };
type Selection = { item: InboxItem; identity: string; review: string; token: object };
export function ExecutionWorkspace(props: Props) {
  const key = useFormKey(props.api, 'workspace');
  return <Workspace key={key} {...props} />;
}
function Workspace({ api, plan }: Props) {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [nodes, setNodes] = useState<readonly ExecutionNodeWire[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [selected, setSelected] = useState<Selection | undefined>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const request = useRef<AbortController | undefined>(undefined);
  const alive = useRef(false);
  const reload = useCallback(async () => {
    if (!alive.current) return;
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    const valid = () => alive.current && request.current === current && !current.signal.aborted;
    setPending(true);
    setError('');
    try {
      const inbox = await api.inbox(current.signal);
      if (!valid()) return;
      setItems(inbox.items);
      setNodes(inbox.nodes);
    } catch (caught) {
      if (valid()) setError(executionErrorMessage(caught));
    } finally {
      if (valid()) setPending(false);
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, [reload]);

  const node = selected
    ? nodes.find((item) => nodeIdentity(item) === selected.identity)
    : undefined;
  function open(item: InboxItem) {
    const matches = nodes.filter(
      (node) => node.nodeId === item.nodeId && node.taskId === item.taskId,
    );
    if (matches.length !== 1) return;
    const node = matches[0]!;
    const selection = {
      item,
      identity: nodeIdentity(node),
      review: reviewIdentity(node),
      token: {},
    };
    selectedRef.current = selection;
    setSelected(selection);
  }
  function submitted(next: ExecutionNodeWire, selection: Selection) {
    if (
      !alive.current ||
      selectedRef.current?.token !== selection.token ||
      nodeIdentity(next) !== selection.identity
    )
      return;
    // A refreshed round must not be dismissed by a receipt from the previous round.
    if (selection.item.action === 'review' && node && reviewIdentity(node) !== selection.review)
      return;
    selectedRef.current = undefined;
    setSelected(undefined);
    void reload();
  }
  return (
    <div className="zm-execution-workspace">
      {plan && <StartPlanPanel api={api} plan={plan} onStarted={() => void reload()} />}
      <InboxPanel
        items={items}
        nodes={nodes}
        error={error}
        pending={pending}
        reload={() => void reload()}
        open={open}
      />
      {selected && !node && <p className="zm-empty">这项工作的版本已变化，请重新选择待办。</p>}
      {selected && node && selected.item.action === 'review' && (
        <ReviewWorkspace api={api} node={node} onSubmitted={(next) => submitted(next, selected)} />
      )}
      {selected &&
        node &&
        (selected.item.action === 'submit' || selected.item.action === 'revise') && (
          <DeliveryPanel api={api} node={node} onSubmitted={(next) => submitted(next, selected)} />
        )}
      {selected && node && !['review', 'submit', 'revise'].includes(selected.item.action) && (
        <p className="zm-empty">这个动作暂未接入当前执行入口。</p>
      )}
    </div>
  );
}
