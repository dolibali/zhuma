import { useMemo, useState } from 'react';
import { createExecutionApi } from '../../src/execution/ExecutionApi.js';
import { StartablePlansPanel } from '../../src/execution/StartablePlansPanel.js';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { deliveryNode, reviewNode, inbox } from './execution-fixture.mjs';

// Explicit response replay. It does not authenticate, authorize or execute a task.
export const plans = [
  { taskId: 'orders', planId: 'plan-main', revision: 1, title: '订单筛选方案' },
  { taskId: 'payments', planId: 'plan-main', revision: 1, title: '支付状态方案' },
  { taskId: 'orders', planId: 'plan-export', revision: 1, title: '订单导出方案' },
  { taskId: 'orders', planId: 'plan-main', revision: 2, title: '订单筛选方案' },
];
const same = (first, second) =>
  first.taskId === second.taskId &&
  first.planId === second.planId &&
  first.revision === second.revision;
export function StartableProbe() {
  const [session, setSession] = useState(0);
  const [, setEvents] = useState(0);
  const formal = new URL(location.href).searchParams.has('formal');
  const control = useMemo(() => {
    const data = {
      calls: [],
      plans: structuredClone(plans),
      nodes: [deliveryNode, reviewNode],
      events: 0,
      replyActor: 'chen',
      holdReads: window.holdStartableOnMount === true,
      holdWrites: false,
      complete(index, outcome = 'success') {
        const call = data.calls[index];
        call.settled = true;
        if (outcome === 'failure')
          call.resolve({
            ok: false,
            error: {
              code: 'not-participant',
              message: '当前账号已无权开始这项计划。',
              details: {},
            },
          });
        else if (outcome === 'reject') call.reject(Error('Fixture transport failure'));
        else {
          if (call.endpoint.endsWith('/start-plan')) {
            const plan = data.plans.find((plan) => same(plan, call.payload));
            data.plans = data.plans.filter((plan) => !same(plan, call.payload));
            data.nodes.push({
              ...deliveryNode,
              ...call.payload,
              nodeId: `work-${call.payload.planId}-${call.payload.revision}`,
              goal: `执行 ${plan?.title ?? '计划'}`,
              version: 1,
            });
          }
          call.resolve(call.response);
        }
      },
    };
    const rpc = {
      call(channel, endpoint, payload, signal) {
        const response = endpoint.endsWith('/startable')
          ? {
              ok: true,
              value: {
                actorId: data.replyActor,
                ...(payload.spaceId === undefined ? {} : { spaceId: payload.spaceId }),
                plans: structuredClone(data.plans),
              },
            }
          : endpoint.endsWith('/inbox')
            ? {
                ok: true,
                value: {
                  ...inbox(structuredClone(data.nodes)),
                  ...(payload.spaceId === undefined ? {} : { spaceId: payload.spaceId }),
                },
              }
            : { ok: true, value: { disposition: 'applied', reports: [] } };
        const entry = { channel, endpoint, payload, signal, response, settled: false };
        data.calls.push(entry);
        const held = endpoint.endsWith('/startable')
          ? data.holdReads
          : endpoint.endsWith('/start-plan') && data.holdWrites;
        // Deliberately ignore cancellation to exercise UI scope fences.
        return new Promise((resolve, reject) => {
          Object.assign(entry, { resolve, reject });
          if (!held) data.complete(data.calls.indexOf(entry));
        });
      },
    };
    data.api = createExecutionApi(rpc);
    data.fetcher = async (url, options) => {
      if (String(url).startsWith('/zhuma-id/'))
        return Response.json({
          ok: true,
          accountId: 'chen',
          principal: { kind: 'zhuma-member', memberId: 'chen' },
          peerId: 'fixture-chen',
          spaces: [{ id: 'fixture-space', kind: 'personal', name: '个人空间' }],
        });
      const request = JSON.parse(options.body);
      const result = await rpc.call('/api', request.method, request.payload, options.signal);
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result });
    };
    window.startableProbe = data;
    return data;
  }, [session]);
  return (
    <div className="zhuma">
      <nav className="zm-actions" aria-label="计划契约预览控制">
        <span>计划入口契约预览 · 无真实执行</span>
        <button onClick={() => setSession((value) => value + 1)}>更换计划API会话</button>
      </nav>
      {formal ? (
        <MemberExecutionPage fetcher={control.fetcher} />
      ) : (
        <main className="zm-page">
          <h1>我的工作</h1>
          <StartablePlansPanel
            api={control.api}
            onStarted={() => {
              control.events++;
              setEvents((value) => value + 1);
            }}
          />
        </main>
      )}
    </div>
  );
}
