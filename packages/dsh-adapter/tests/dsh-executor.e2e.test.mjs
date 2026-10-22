import test from 'node:test';
import { DshChatExecutor, readDshModelConfig } from '@zhuma/dsh-adapter';

test('真实执行器：缺少配置或网关不可达时跳过', async (t) => {
  const config = readDshModelConfig(process.env);
  if (!config.ok) {
    t.skip(`跳过真实执行器：${config.reason}`);
    return;
  }
  const probe = new AbortController();
  const timer = setTimeout(() => probe.abort(), 1500);
  try {
    const response = await fetch(`${config.config.baseUrl}/models`, {
      method: 'GET',
      signal: probe.signal,
      headers: { authorization: `Bearer ${config.config.apiKey}` },
    });
    if (!response.ok) {
      t.skip(`跳过真实执行器：模型网关返回 HTTP ${response.status}`);
      return;
    }
  } catch {
    t.skip('跳过真实执行器：模型网关不可达。这不是实现失败。');
    return;
  } finally {
    clearTimeout(timer);
  }
  const executor = new DshChatExecutor(process.env);
  const events = [];
  for await (const event of executor.run({
    runId: 'e2e-dsh',
    attempt: 1,
    generation: 1,
    taskId: 'task',
    nodeId: 'node',
    workflowVersionId: 'plan',
    planRevision: 1,
    contextReferences: [],
    expertVersionId: 'expert-v1',
    resourceGrants: [],
    instruction: '用一句话回复：收到。',
    attachmentIds: [],
    goal: '连通性',
    simulatedRequested: false,
    signal: AbortSignal.timeout(20000),
  })) {
    events.push(event);
  }
  assertHasTerminal(events);
});

function assertHasTerminal(events) {
  const terminal = events.some((event) => event.type === 'completed' || event.type === 'failed');
  if (!terminal) throw new Error('真实执行器没有返回完成或失败');
  const failed = events.find((event) => event.type === 'failed');
  if (failed && /https?:\/\//.test(failed.message)) {
    throw new Error('失败说明里出现了地址');
  }
}
