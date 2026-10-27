import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DeliveryPanel } from './DeliveryPanel.js';
import { RevisionPanel } from './RevisionPanel.js';
import {
  ExecutionError,
  executionErrorMessage,
  type ExecutionApi,
  type ExecutionNodeWire,
  type RevisionViewWire,
} from './ExecutionApi.js';
import { nodeIdentity, useFormKey } from './interaction.js';

type Props = {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  headerAction?: ReactNode;
  onSubmitted(node: ExecutionNodeWire): void;
};
type Reading =
  | { kind: 'loading' }
  | { kind: 'ready'; view: RevisionViewWire }
  | { kind: 'error'; message: string };

function RevisionRead({ api, node }: Pick<Props, 'api' | 'node'>) {
  const [reading, setReading] = useState<Reading>({ kind: 'loading' });
  const alive = useRef(false);
  const active = useRef<AbortController>();
  const expected = node.rounds.find((round) => round.id === node.currentRoundId)?.artifactVersionId;
  const load = useCallback(async () => {
    if (!alive.current) return;
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    const current = () => alive.current && active.current === request && !request.signal.aborted;
    setReading({ kind: 'loading' });
    try {
      const view = await api.revision(
        { taskId: node.taskId, planId: node.planId, revision: node.revision, nodeId: node.nodeId },
        request.signal,
      );
      if (!current()) return;
      if (expected && view.reviewed && view.reviewed.id !== expected)
        throw new ExecutionError('revision-mismatch', '退回版本已变化，请刷新待办后重新选择。');
      setReading({ kind: 'ready', view });
    } catch (error) {
      if (current()) setReading({ kind: 'error', message: executionErrorMessage(error) });
    }
  }, [api, node.taskId, node.planId, node.revision, node.nodeId, expected]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      active.current?.abort();
    };
  }, [load]);
  return (
    <RevisionPanel
      api={api}
      target={{
        taskId: node.taskId,
        planId: node.planId,
        revision: node.revision,
        nodeId: node.nodeId,
      }}
      view={reading.kind === 'ready' ? reading.view : undefined}
      pending={reading.kind === 'loading'}
      error={reading.kind === 'error' ? reading.message : ''}
      reload={() => void load()}
    />
  );
}

export function RevisionWorkspace({ api, node, onSubmitted, headerAction }: Props) {
  const round = node.rounds.find((item) => item.id === node.currentRoundId);
  const key = useFormKey(
    api,
    JSON.stringify([
      nodeIdentity(node),
      node.version,
      node.status,
      node.currentRoundId,
      round?.artifactVersionId,
    ]),
  );
  return (
    <div className="zm-revision-workspace">
      {node.status === 'needs-revision' ? (
        <RevisionRead key={key} api={api} node={node} />
      ) : (
        <p role="status">节点状态已更新，请重新选择待办。</p>
      )}
      <DeliveryPanel
        api={api}
        node={node}
        mode="revise"
        onSubmitted={onSubmitted}
        headerAction={headerAction}
      />
    </div>
  );
}
