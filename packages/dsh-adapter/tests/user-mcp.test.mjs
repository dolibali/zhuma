import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { readMcpCalls } from '@zhuma/context';
import { z } from 'zod';
import { invokeUserMcpTools, openUserMcp, userMcpExplicitGrant } from '../dist/user-mcp.js';

const fixture = fileURLToPath(new URL('./fixtures/user-mcp-stdio-server.mjs', import.meta.url));

function option(overrides = {}) {
  return {
    id: 'docs-mcp',
    version: '1',
    label: '文档服务',
    available: true,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    ...overrides,
  };
}

function selection(overrides = {}) {
  return {
    id: 'docs-mcp',
    version: '1',
    label: '文档服务',
    origin: 'added',
    available: true,
    toolsAuthorized: true,
    explicitToolGrant: true,
    ...overrides,
  };
}

test('非空 stdio：配置被接受，列出工具，并真调两项', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
  const callsFile = join(root, 'calls.txt');
  try {
    const result = await invokeUserMcpTools({
      option: option({ args: [fixture, callsFile] }),
      selection: selection(),
      calls: [
        { toolName: 'echo', args: { text: 'pong', token: 'hidden' } },
        { toolName: 'add', args: { a: 2, b: 3 } },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['add', 'echo', 'fail']);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].text, 'pong');
    assert.equal(result.results[0].serverId, 'docs-mcp');
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[1].text, '5');
    const records = readMcpCalls(result.log, { serverId: 'docs-mcp' });
    assert.equal(records.length, 2);
    assert.equal(records[0].toolName, 'echo');
    assert.equal(records[0].outcome, 'ok');
    assert.equal(records[0].argsSummary.includes('pong'), true);
    assert.equal(records[0].argsSummary.includes('hidden'), false);
    assert.equal(records[0].argsSummary.includes('[redacted]'), true);
    assert.equal(records[1].toolName, 'add');
    assert.equal(records[1].outcome, 'ok');
    assert.equal(
      records.every((item) => item.durationMs >= 0 && item.errorCode === undefined),
      true,
    );
    assert.equal(await readFile(callsFile, 'utf8'), 'echo\nadd\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  '真实 stdio：嵌套对象和数组里的敏感值不进日志，失败调用同样遮住',
  { timeout: 20_000 },
  async () => {
    const nestedSecret = 'synthetic-nested-field-a';
    const headerSecret = 'synthetic-nested-field-b';
    const deepSecret = 'synthetic-nested-field-c';
    const deep = (left) => (left <= 0 ? { note: deepSecret } : { note: deep(left - 1) });
    const args = {
      text: 'pong',
      region: 'local',
      credentials: { apiKey: nestedSecret, region: 'local' },
      headers: [{ name: 'Accept', value: 'text/plain' }, { Authorization: headerSecret }],
      deep: deep(12),
    };
    const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
    const callsFile = join(root, 'calls.txt');
    try {
      const result = await invokeUserMcpTools({
        option: option({ args: [fixture, callsFile] }),
        selection: selection(),
        calls: [
          { toolName: 'echo', args },
          { toolName: 'fail', args },
        ],
      });
      assert.equal(result.ok, true);
      assert.equal(result.results[0].ok, true);
      assert.equal(result.results[0].text, 'pong');
      assert.equal(result.results[1].ok, false);
      assert.equal(result.results[1].code, 'mcp-call-failed');
      const records = readMcpCalls(result.log);
      assert.deepEqual(
        records.map((item) => item.outcome),
        ['ok', 'fail'],
      );
      for (const record of records) {
        assert.equal(record.argsSummary.includes(nestedSecret), false);
        assert.equal(record.argsSummary.includes(headerSecret), false);
        assert.equal(record.argsSummary.includes(deepSecret), false);
        assert.equal(record.argsSummary.includes('[redacted]'), true);
        assert.equal(record.argsSummary.includes('credentials'), true);
        assert.equal(record.argsSummary.includes('local'), true);
      }
      assert.equal(await readFile(callsFile, 'utf8'), 'echo\nfail\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('工具返回错误时记下失败，未知工具不会打到服务器', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
  const callsFile = join(root, 'calls.txt');
  try {
    const result = await invokeUserMcpTools({
      option: option({ args: [fixture, callsFile] }),
      selection: selection(),
      calls: [{ toolName: 'fail' }, { toolName: 'missing' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].code, 'mcp-call-failed');
    assert.equal(result.results[1].ok, false);
    assert.equal(result.results[1].code, 'mcp-tool-unknown');
    const records = readMcpCalls(result.log);
    assert.deepEqual(
      records.map((item) => item.outcome),
      ['fail', 'fail'],
    );
    assert.deepEqual(
      records.map((item) => item.errorCode),
      ['mcp-call-failed', 'mcp-tool-unknown'],
    );
    assert.equal(await readFile(callsFile, 'utf8'), 'fail\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('只勾选 MCP 或缺少显式授权时，列出工具但调用失败', { timeout: 20_000 }, async () => {
  assert.equal(userMcpExplicitGrant(selection({ toolsAuthorized: false })), false);
  assert.equal(
    userMcpExplicitGrant(selection({ toolsAuthorized: true, explicitToolGrant: false })),
    false,
  );
  const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
  const callsFile = join(root, 'calls.txt');
  try {
    const opened = await openUserMcp({
      option: option({ args: [fixture, callsFile] }),
      selection: selection({ toolsAuthorized: false, explicitToolGrant: false }),
    });
    assert.equal(opened.ok, true);
    assert.equal(
      opened.session.tools.some((tool) => tool.name === 'echo'),
      true,
    );
    const refused = await opened.session.call('echo', { text: 'nope' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'mcp-not-authorized');
    await opened.session.close();
    const records = readMcpCalls(opened.session.log);
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'fail');
    assert.equal(records[0].errorCode, 'mcp-not-authorized');
    assert.equal(existsSync(callsFile), false);
    const half = await invokeUserMcpTools({
      option: option({ args: [fixture, callsFile] }),
      selection: selection({ toolsAuthorized: true, explicitToolGrant: false }),
      calls: [{ toolName: 'echo', args: { text: 'nope' } }],
    });
    assert.equal(half.ok, true);
    assert.equal(half.results[0].ok, false);
    assert.equal(half.results[0].code, 'mcp-not-authorized');
    assert.equal(existsSync(callsFile), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('非空 streamable HTTP：列出工具并真调', { timeout: 20_000 }, async () => {
  const seen = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: '回显文本', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => {
        seen.push(text);
        return { content: [{ type: 'text', text }] };
      },
    );
    return server;
  });
  const httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const response = await handler.fetch(
      new Request(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      }),
    );
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  try {
    const result = await invokeUserMcpTools({
      option: option({
        id: 'http-mcp',
        transport: 'streamable-http',
        command: undefined,
        args: undefined,
        url: `http://127.0.0.1:${address.port}/mcp`,
      }),
      selection: selection({ id: 'http-mcp' }),
      calls: [{ toolName: 'echo', args: { text: 'http-pong' } }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ['echo'],
    );
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].text, 'http-pong');
    assert.equal(readMcpCalls(result.log)[0].outcome, 'ok');
    assert.equal(readMcpCalls(result.log)[0].serverId, 'http-mcp');
    assert.deepEqual(seen, ['http-pong']);
  } finally {
    await handler.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('空 MCP 不能记成调用成功', async () => {
  const empty = await invokeUserMcpTools({
    option: option({ transport: undefined, command: undefined, args: undefined }),
    selection: selection(),
    calls: [{ toolName: 'echo', args: { text: 'nope' } }],
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'mcp-empty');
  assert.equal(
    readMcpCalls(empty.log).some((item) => item.outcome === 'ok'),
    false,
  );
  const blank = await invokeUserMcpTools({
    option: option({ command: '   ' }),
    selection: selection(),
    calls: [{ toolName: 'echo' }],
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.code, 'mcp-empty');
  const http = await invokeUserMcpTools({
    option: option({
      transport: 'streamable-http',
      command: undefined,
      args: undefined,
      url: '   ',
    }),
    selection: selection(),
    calls: [{ toolName: 'echo' }],
  });
  assert.equal(http.ok, false);
  assert.equal(http.code, 'mcp-empty');
  const down = await invokeUserMcpTools({
    option: option({ available: false, unavailableReason: '未填写连接' }),
    selection: selection(),
    calls: [{ toolName: 'echo' }],
  });
  assert.equal(down.ok, false);
  assert.equal(down.code, 'mcp-unavailable');
  assert.equal(readMcpCalls(down.log).length, 0);
});
