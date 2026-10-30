import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxItem } from '@zhuma/agent-core';
import {
  executionErrorMessage,
  type ExecutionApi,
  type ExecutionNodeWire,
  type InboxPlaceWire,
} from './ExecutionApi.js';
import { DeliveryPanel } from './DeliveryPanel.js';
import { InboxPanel } from './InboxPanel.js';
import { ReviewWorkspace } from './ReviewWorkspace.js';
import { RevisionWorkspace } from './RevisionWorkspace.js';
import { StartPlanPanel, type ExecutionPlan } from './StartPlanPanel.js';
import { nodeIdentity, reviewIdentity, useFormKey } from './interaction.js';
import { NativeRunLauncher } from '../run/NativeRunWorkspace.js';
import type { NativeRunApi } from '../run/api.js';

type Props = {
  api: ExecutionApi;
  plan?: ExecutionPlan;
  refreshKey?: number;
  nativeRun?: { api: NativeRunApi; spaceId: string };
};
type Selection = { item: InboxItem; identity: string; token: object };
export function ExecutionWorkspace(props: Props) {
  const key = useFormKey(props.api, 'workspace');
  return <Workspace key={key} {...props} />;
}
function Workspace({ api, plan, refreshKey, nativeRun }: Props) {
  const [items, setItems] = useState<readonly InboxItem[]>([]);
  const [nodes, setNodes] = useState<readonly ExecutionNodeWire[]>([]);
  const [places, setPlaces] = useState<readonly InboxPlaceWire[]>();
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
      setPlaces(inbox.places);
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
  }, [reload, refreshKey]);

  const node = selected
    ? nodes.find((item) => nodeIdentity(item) === selected.identity)
    : undefined;
  // Compare receipts with the context currently presented, rather than the round
  // that happened to be selected before a later inbox refresh.
  const presentedReview = node ? reviewIdentity(node) : undefined;
  const presentation = useRef<{ token: object; review: string | undefined } | undefined>(undefined);
  presentation.current = selected ? { token: selected.token, review: presentedReview } : undefined;
  function open(item: InboxItem) {
    const matches = nodes.filter(
      (node) => node.nodeId === item.nodeId && node.taskId === item.taskId,
    );
    if (matches.length !== 1) return;
    const node = matches[0]!;
    const selection = {
      item,
      identity: nodeIdentity(node),
      token: {},
    };
    selectedRef.current = selection;
    setSelected(selection);
  }
  function submitted(next: ExecutionNodeWire, selection: Selection, requestReview?: string) {
    if (
      !alive.current ||
      selectedRef.current?.token !== selection.token ||
      nodeIdentity(next) !== selection.identity
    )
      return;
    // A refreshed round must not be dismissed by a receipt from the previous round.
    if (
      selection.item.action === 'review' &&
      (presentation.current?.token !== selection.token ||
        presentation.current.review !== requestReview)
    )
      return;
    selectedRef.current = undefined;
    setSelected(undefined);
    void reload();
  }
  const agentAction = (node: ExecutionNodeWire, label?: string) =>
    nativeRun ? (
      <NativeRunLauncher
        api={nativeRun.api}
        label={label}
        target={{
          spaceId: nativeRun.spaceId,
          taskId: node.taskId,
          planId: node.planId,
          revision: node.revision,
          nodeId: node.nodeId,
          title: node.goal.split('\n')[0]!.slice(0, 160),
          description: node.goal,
        }}
      />
    ) : undefined;
  const nativeAction =
    selected && node && ['submit', 'revise'].includes(selected.item.action)
      ? agentAction(node)
      : undefined;
  return (
    <div className="zm-execution-workspace">
      {plan && <StartPlanPanel api={api} plan={plan} onStarted={() => void reload()} />}
      <InboxPanel
        items={items}
        nodes={nodes}
        {...(places === undefined ? {} : { places })}
        error={error}
        pending={pending}
        reload={() => void reload()}
        open={open}
        renderAgentAction={nativeRun ? (node) => agentAction(node, '打开 Agent 会话') : undefined}
      />
      {selected && !node && <p className="zm-empty">这项工作的版本已变化，请重新选择待办。</p>}
      {selected && node && selected.item.action === 'review' && (
        <ReviewWorkspace
          api={api}
          node={node}
          {...(nativeRun?.api.review
            ? { nativeReview: { api: nativeRun.api.review, spaceId: nativeRun.spaceId } }
            : {})}
          onSubmitted={(next) => submitted(next, selected, presentedReview)}
        />
      )}
      {selected && node && selected.item.action === 'submit' && (
        <DeliveryPanel
          api={api}
          node={node}
          headerAction={nativeAction}
          onSubmitted={(next) => submitted(next, selected)}
        />
      )}
      {selected && node && selected.item.action === 'revise' && (
        <RevisionWorkspace
          api={api}
          node={node}
          headerAction={nativeAction}
          onSubmitted={(next) => submitted(next, selected)}
        />
      )}
      {selected && node && !['review', 'submit', 'revise'].includes(selected.item.action) && (
        <p className="zm-empty">这个动作暂未接入当前执行入口。</p>
      )}
    </div>
  );
}
