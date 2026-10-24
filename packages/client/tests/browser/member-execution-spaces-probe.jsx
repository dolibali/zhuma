import { useMemo } from 'react';
import { MemberExecutionPage } from '../../src/execution/MemberExecutionPage.js';
import { deliveryNode, reviewNode, inbox } from './execution-fixture.mjs';

const personal = (account) => ({ id: `personal-${account}`, kind: 'personal', name: '我的空间' });
const teamA = { id: 'team-a', kind: 'team', name: '产品研发' };
const teamB = { id: 'team-b', kind: 'team', name: '运营支持' };
const empty = { id: 'team-empty', kind: 'team', name: '新建团队' };
const nodeB = {
  ...reviewNode,
  taskId: 'task-privacy',
  planId: 'plan-privacy',
  goal: '评审导出字段脱敏方案',
};
const planA = {
  taskId: 'task-orders',
  planId: 'plan-export',
  revision: 1,
  title: '补充订单导出筛选',
};
const planB = {
  taskId: 'task-privacy',
  planId: 'plan-check',
  revision: 2,
  title: '敏感字段脱敏复核',
};

/** Response replay only. No cookies, real space authorization, durable data or agent execution. */
export function createMemberExecutionSpacesReplay() {
  const data = {
    account: 'chen',
    directory: {
      chen: [personal('chen'), teamA, teamB, empty],
      lin: [personal('lin'), teamA],
      mei: [personal('mei'), teamB],
    },
    work: {
      'team-a': { nodes: [structuredClone(deliveryNode)], plans: [planA] },
      'team-b': { nodes: [structuredClone(nodeB)], plans: [planB] },
    },
    requests: [],
    effects: [],
    holdSessions: false,
    holdMethods: [],
    badEcho: {},
    deny: {},
    complete(index, outcome = 'success') {
      const entry = data.requests[index];
      if (!entry || entry.settled) throw Error('Missing or settled replay request');
      entry.settled = true;
      if (outcome === 'reject') {
        entry.reject(Error('Replay network failure'));
        return;
      }
      if (outcome === '401') {
        entry.resolve(new Response('', { status: 401 }));
        return;
      }
      if (entry.kind === 'session') {
        entry.resolve(
          Response.json(
            outcome === 'wrong-member'
              ? {
                  ...entry.value,
                  accountId: 'other',
                  principal: { kind: 'zhuma-member', memberId: 'other' },
                }
              : entry.value,
          ),
        );
        return;
      }
      const { method, payload } = entry.request;
      const failure = outcome === 'failure' ? 'not-found' : data.deny[method];
      if (!failure && method === 'start-plan') {
        data.effects.push({ method, payload });
        const work = data.work[payload.spaceId];
        if (work)
          work.plans = work.plans.filter(
            (plan) =>
              plan.planId !== payload.planId ||
              plan.revision !== payload.revision ||
              plan.taskId !== payload.taskId,
          );
      }
      if (!failure && ['submit', 'ballot'].includes(method)) data.effects.push({ method, payload });
      entry.resolve(
        Response.json({
          type: 'server-response',
          rpcId: entry.request.rpcId,
          result: failure
            ? {
                ok: false,
                error: {
                  code: failure,
                  message: '当前请求未被接受，请刷新后重试。',
                  details: {},
                },
              }
            : { ok: true, value: entry.value },
        }),
      );
    },
  };
  const reply = (entry, held) =>
    new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject, settled: false });
      data.requests.push(entry);
      if (!held) data.complete(data.requests.length - 1);
    });
  data.fetcher = async (url, options) => {
    if (url === '/zhuma-id/login') {
      data.account = JSON.parse(options.body).accountId;
      return Response.json({ ok: true, accountId: data.account });
    }
    if (url === '/zhuma-id/logout') {
      const accountId = data.account;
      data.account = undefined;
      return Response.json({ ok: true, accountId });
    }
    if (url === '/zhuma-id/session') {
      if (!data.account) return new Response('', { status: 401 });
      const accountId = data.account;
      return reply(
        {
          kind: 'session',
          signal: options.signal,
          value: {
            ok: true,
            accountId,
            principal: { kind: 'zhuma-member', memberId: accountId },
            peerId: `request-${data.requests.length}`,
            spaces: structuredClone(data.directory[accountId] ?? []),
          },
        },
        data.holdSessions,
      );
    }
    const envelope = JSON.parse(options.body);
    const method = envelope.method.replace('zhuma-exec/', '');
    const payload = envelope.payload;
    const work = data.work[payload.spaceId] ?? { nodes: [], plans: [] };
    let echo = { spaceId: payload.spaceId };
    if (data.badEcho[method] === 'missing') echo = {};
    if (data.badEcho[method] === 'wrong') echo = { spaceId: 'wrong-space' };
    // Literal member fixtures, not an alternate authorization engine.
    const visible = data.account === 'chen' ? work : { nodes: [], plans: [] };
    const value =
      method === 'inbox'
        ? { ...inbox(structuredClone(visible.nodes)), actorId: data.account, ...echo }
        : method === 'startable'
          ? { actorId: data.account, plans: structuredClone(visible.plans), ...echo }
          : method === 'draft'
            ? { version: 0, text: '', links: [], files: [] }
            : method === 'start-plan'
              ? { disposition: 'applied', reports: [] }
              : { node: structuredClone(method === 'ballot' ? nodeB : deliveryNode) };
    return reply(
      {
        kind: 'service',
        signal: options.signal,
        request: { ...envelope, method, payload },
        value,
      },
      data.holdMethods.includes(method),
    );
  };
  window.memberExecutionSpaces = data;
  return data;
}
export function MemberExecutionSpacesProbe() {
  const control = useMemo(createMemberExecutionSpacesReplay, []);
  return <MemberExecutionPage fetcher={control.fetcher} />;
}
