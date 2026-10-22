import { test as base, expect } from '@playwright/test';
import { applyWorkbenchCommand, emptyWorkbench } from '@zhuma/agent-core';

export function fixture() {
  const state = emptyWorkbench();
  state.projects = [{ id: 'project', name: '订单门户 · 测试数据', description: '浏览器契约测试' }];
  state.participants = [
    ['chen', '陈宁', 'human'],
    ['lin', '林可', 'human'],
    ['qa', '质量专家', 'expert'],
    ['frontend', '界面专家', 'expert'],
    ...Array.from({ length: 22 }, (_, i) => [`member-${i}`, `演示成员 ${i + 1}`, 'human']),
  ].map(([id, name, kind]) => ({
    id,
    name,
    kind,
    role: '核对订单需求和团队交付',
    capabilities: ['需求分析', '接口核对'],
    instructions: '',
    available: true,
  }));
  state.assets = Array.from({ length: 12 }, (_, i) => ({
    id: `skill-${i}`,
    kind: 'skill',
    name: `企业采购订单跨系统同步与敏感字段处理规范 · ${String(i + 1).padStart(2, '0')} 版`,
    description: '用于核对跨团队字段口径、异常记录和访问边界。',
    content: '识别输入字段和角色，返回可复核的核对记录。',
    available: true,
  }));
  state.tasks = [
    {
      id: 'task',
      projectId: 'project',
      title: '订单协作改进',
      goal: '按团队分工改进订单交付。',
      participantIds: state.participants.map((p) => p.id),
      ownerId: 'chen',
      status: 'draft',
      updatedAt: '2026-10-22T00:00:00.000Z',
      workflows: [
        {
          id: 'root',
          name: '订单工作流',
          parentNodeId: null,
          nodes: [plannedWorkflows()[0].nodes[0]],
        },
      ],
    },
  ];
  return state;
}

export function plannedWorkflows() {
  return [
    {
      id: 'root',
      name: '订单工作流',
      parentNodeId: null,
      nodes: Array.from({ length: 10 }, (_, i) => ({
        id: `node-${i}`,
        title: i === 0 ? '确认业务边界' : `订单交付工作 ${i + 1}`,
        description: '核对订单字段和处理分工。',
        assigneeId: i === 2 ? 'frontend' : 'chen',
        reviewerIds: ['qa'],
        reviewRequired: true,
        dependsOn: i ? [`node-${i - 1}`] : [],
        skillIds: ['skill-0'],
        mcpIds: [],
        input: '上一节点的交付材料',
        output: '可复核的交付记录',
        rationale: '',
        position: { x: 60 + i * 320, y: 80 },
      })),
    },
  ];
}

export const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
export function proposal(payload, workflows = plannedWorkflows(), summary = '十节点工作流草案。') {
  return {
    ok: true,
    value: {
      id: payload.requestId,
      taskId: payload.taskId,
      baseRevision: payload.expectedRevision,
      model: 'response-replay / no-model',
      result: { summary, questions: [], assumptions: [], workflows },
    },
  };
}
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const test = base.extend({
  replay: async ({ page, baseURL }, use, testInfo) => {
    const errors = [];
    const replay = { state: fixture(), requests: [], completed: [], snapshots: 0, handlers: {} };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL) {
        errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const envelope = route.request().postDataJSON();
      const endpoint = url.pathname.split('/').at(-1);
      replay.requests.push({ endpoint, ...envelope.payload });
      let result;
      if (replay.handlers[endpoint]) result = await replay.handlers[endpoint](envelope.payload);
      else if (endpoint === 'snapshot') {
        replay.snapshots++;
        result = { ok: true, value: { state: replay.state, model: 'response-replay / no-model' } };
      } else if (endpoint === 'command') {
        // Use the production pure reducer; this in-memory fixture is NOT Host persistence/auth.
        replay.state = applyWorkbenchCommand(replay.state, envelope.payload.command);
        result = { ok: true, value: replay.state };
      } else {
        errors.push(`Unexpected RPC endpoint: ${endpoint}`);
        result = failure('fixture', '未配置响应重放');
      }
      await route.fulfill({ json: { type: 'server-response', rpcId: envelope.rpcId, result } });
      replay.completed.push(envelope.payload.requestId ?? envelope.rpcId);
    });
    await use(replay);
    if (testInfo.status !== testInfo.expectedStatus || errors.length) {
      await testInfo.attach('fixture-requests', {
        body: JSON.stringify(replay.requests, null, 2),
        contentType: 'application/json',
      });
    }
    expect(errors, 'No page errors, unexpected RPC or external network access').toEqual([]);
  },
});
export { expect };
