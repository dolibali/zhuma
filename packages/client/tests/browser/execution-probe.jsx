import { useMemo, useState } from 'react';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { ExecutionWorkspace } from '../../src/execution/ExecutionWorkspace.js';
import { ReviewWorkspace } from '../../src/execution/ReviewWorkspace.js';
import { DeliveryPanel } from '../../src/execution/DeliveryPanel.js';

import { reviewNode, deliveryNode, reviseNode, inbox } from './execution-fixture.mjs';
export function ExecutionProbe() {
  const mode = new URL(location.href).searchParams.get('execution-form');
  const [node, setNode] = useState(mode === 'delivery' ? deliveryNode : reviewNode);
  const [mounted, setMounted] = useState(true);
  const [session, setSession] = useState(0);
  const fixture = useMemo(() => {
    const calls = [];
    const control = {
      calls,
      hold: false,
      holdInbox: false,
      nodes: [reviewNode, deliveryNode, reviseNode],
      events: [],
      switch(axis) {
        if (axis === 'reset') {
          setNode(mode === 'delivery' ? deliveryNode : reviewNode);
          return;
        }
        setNode((current) => {
          if (axis === 'revision') return { ...current, revision: current.revision + 1 };
          if (axis === 'round') {
            const round = { ...current.rounds[0], id: `${current.currentRoundId}-next` };
            return { ...current, currentRoundId: round.id, rounds: [round] };
          }
          const field = { task: 'taskId', plan: 'planId', node: 'nodeId' }[axis];
          return { ...current, [field]: `${current[field]}-next`, goal: `新工作项 · ${axis}` };
        });
      },
      complete(index, outcome = 'success') {
        const call = calls[index];
        if (outcome === 'reject') call.reject(Error('late transport failure'));
        else if (outcome === 'failure')
          call.resolve({
            ok: false,
            error: {
              code: 'conflict',
              message: '内容已变化，请刷新后再试。',
              details: { actualVersion: 3 },
            },
          });
        else call.resolve(call.response);
      },
    };
    // Deliberately ignores abort to prove UI receipt isolation even for late transports.
    const rpc = {
      call(channel, endpoint, payload, signal) {
        // This legacy probe records its original commands; focused draft replay records draft reads separately.
        if (endpoint.endsWith('/draft') && !('idempotencyKey' in payload))
          return Promise.resolve({
            ok: true,
            value: { version: 0, text: '', links: [], files: [] },
          });
        const selected =
          control.nodes.find((entry) => entry.nodeId === payload.nodeId) ??
          control.formNode ??
          reviewNode;
        const response = endpoint.endsWith('/inbox')
          ? { ok: true, value: inbox(structuredClone(control.nodes)) }
          : endpoint.endsWith('/start-plan')
            ? { ok: true, value: { disposition: 'started', reports: [] } }
            : {
                ok: true,
                value: {
                  disposition: 'applied',
                  node: {
                    ...selected,
                    ...Object.fromEntries(
                      ['taskId', 'planId', 'revision', 'nodeId'].map((field) => [
                        field,
                        payload[field],
                      ]),
                    ),
                    version: selected.version + 1,
                  },
                },
              };
        const entry = { channel, endpoint, payload, signal, response };
        calls.push(entry);
        const hold = endpoint.endsWith('/inbox') ? control.holdInbox : control.hold;
        if (!hold) return Promise.resolve(response);
        return new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
      },
    };
    control.api = createExecutionApi(rpc);
    window.executionProbe = control;
    return control;
  }, [session]);
  fixture.formNode = node;
  return (
    <div className="zhuma">
      <main className="zm-page">
        <nav aria-label="执行契约预览控制" className="zm-actions">
          <span>客户端契约预览 · 无真实 Host</span>
          <button onClick={() => setMounted(!mounted)}>
            {mounted ? '卸载执行页' : '重新打开执行页'}
          </button>
          <button onClick={() => setSession((value) => value + 1)}>更换 API 会话</button>
          {mode &&
            ['task', 'plan', 'revision', 'node', 'round', 'reset'].map((axis) => (
              <button key={axis} onClick={() => fixture.switch(axis)}>
                切换 {axis}
              </button>
            ))}
          <button
            onClick={() => {
              const index = fixture.calls.findIndex((call) => call.resolve);
              if (index >= 0) fixture.complete(index);
            }}
          >
            完成挂起请求
          </button>
        </nav>
        {mounted &&
          (mode === 'review' ? (
            <ReviewWorkspace
              api={fixture.api}
              node={node}
              onSubmitted={(next) => fixture.events.push(next)}
            />
          ) : mode === 'delivery' ? (
            <DeliveryPanel
              api={fixture.api}
              node={node}
              onSubmitted={(next) => fixture.events.push(next)}
            />
          ) : (
            <ExecutionWorkspace
              api={fixture.api}
              plan={{
                taskId: 'task-orders',
                planId: 'plan-orders',
                revision: 1,
                title: '订单状态交付',
              }}
            />
          ))}
      </main>
    </div>
  );
}
