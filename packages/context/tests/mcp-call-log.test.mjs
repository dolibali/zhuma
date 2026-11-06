import assert from 'node:assert/strict';
import test from 'node:test';
import { appendMcpCall, createMcpCallLog, readMcpCalls } from '@zhuma/context';

test('契约：MCP 调用日志只追加，并能按服务器读回', () => {
  const empty = createMcpCallLog();
  const first = appendMcpCall(empty, {
    serverId: 'docs',
    toolName: 'echo',
    argsSummary: '{"text":"a"}',
    outcome: 'ok',
    durationMs: 4,
  });
  const second = appendMcpCall(first, {
    serverId: 'other',
    toolName: 'add',
    argsSummary: '{}',
    outcome: 'fail',
    durationMs: 2,
    errorCode: 'mcp-call-failed',
  });
  assert.equal(empty.records.length, 0);
  assert.equal(first.records.length, 1);
  assert.equal(readMcpCalls(second).length, 2);
  assert.equal(readMcpCalls(second, { serverId: 'docs' })[0]?.toolName, 'echo');
  assert.throws(() => first.records.push({}));
  assert.throws(() =>
    appendMcpCall(empty, {
      serverId: ' ',
      toolName: 'echo',
      argsSummary: '{}',
      outcome: 'ok',
      durationMs: 0,
    }),
  );
  assert.throws(() =>
    appendMcpCall(empty, {
      serverId: 'docs',
      toolName: 'echo',
      argsSummary: '{}',
      outcome: 'ok',
      durationMs: 1,
      errorCode: 'mcp-call-failed',
    }),
  );
  assert.throws(() =>
    appendMcpCall(empty, {
      serverId: 'docs',
      toolName: 'echo',
      argsSummary: '{}',
      outcome: 'fail',
      durationMs: 1,
    }),
  );
});
