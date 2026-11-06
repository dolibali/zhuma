import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const userMcpSource = readFileSync(new URL('../src/user-mcp.ts', import.meta.url), 'utf8');
const summaryNodes = Number(/const SUMMARY_NODES = (\d+);/.exec(userMcpSource)?.[1]);
const summaryDepth = Number(/const SUMMARY_DEPTH = (\d+);/.exec(userMcpSource)?.[1]);
if (!Number.isInteger(summaryNodes) || summaryNodes < 1) {
  throw new Error('SUMMARY_NODES 未能从 user-mcp.ts 读出');
}
if (!Number.isInteger(summaryDepth) || summaryDepth < 2) {
  throw new Error('SUMMARY_DEPTH 未能从 user-mcp.ts 读出');
}

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

test(
  '大平面对象和大原始值数组的摘要访问不超过节点预算，成功、失败和拒绝仍遮住嵌套敏感值',
  { timeout: 30_000 },
  async () => {
    const nestedSecret = 'synthetic-budget-secret-a';
    const headerSecret = 'synthetic-budget-secret-b';
    const tailSentinel = 'synthetic-budget-tail';
    const hugeTail = 'synthetic-budget-huge-tail';
    const width = 10_000;

    function stats() {
      return { n: 0, secretReads: 0, tailReads: 0, maxIndex: -1 };
    }

    function tracked(kind) {
      const generations = [];
      const args = { text: 'pong' };
      Object.defineProperty(args, 'payload', {
        enumerable: true,
        get() {
          const current = stats();
          generations.push(current);
          return kind === 'flat' ? flatPayload(current) : arrayPayload(current);
        },
      });
      return { args, generations };
    }

    function field(target, key, current, produce) {
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          current.n += 1;
          return produce();
        },
      });
    }

    function flatPayload(current) {
      const payload = {};
      field(payload, 'apiKey', current, () => {
        current.secretReads += 1;
        return nestedSecret;
      });
      field(payload, 'credentials', current, () => ({ apiKey: nestedSecret, region: 'local' }));
      field(payload, 'headers', current, () => [{ name: 'Accept', Authorization: headerSecret }]);
      field(payload, 'marker', current, () => 'kept-marker');
      field(payload, 'blob', current, () => `${'a'.repeat(80_000)}${hugeTail}`);
      for (let index = 0; index < width; index += 1) {
        field(payload, `f${index}`, current, () => index);
      }
      field(payload, 'tail', current, () => {
        current.tailReads += 1;
        return tailSentinel;
      });
      return payload;
    }

    function arrayPayload(current) {
      const batch = [];
      const setIndex = (index, produce) => {
        Object.defineProperty(batch, index, {
          enumerable: true,
          get() {
            current.n += 1;
            current.maxIndex = Math.max(current.maxIndex, index);
            return produce();
          },
        });
      };
      setIndex(0, () => ({
        credentials: { apiKey: nestedSecret, region: 'local' },
        headers: [{ Authorization: headerSecret }],
        label: 'kept-item',
      }));
      setIndex(1, () => null);
      setIndex(2, () => false);
      for (let index = 3; index < width - 1; index += 1) setIndex(index, () => index);
      setIndex(width - 1, () => {
        current.tailReads += 1;
        return tailSentinel;
      });
      return batch;
    }

    function assertBounded(label, record, generations, kind, invoked) {
      assert.equal(generations.length, invoked ? 2 : 1, label);
      const summary = generations.at(-1);
      assert.equal(
        summary.n <= summaryNodes,
        true,
        `${label} 摘要访问 ${summary.n}，节点预算 ${summaryNodes}`,
      );
      assert.equal(summary.secretReads, 0, label);
      assert.equal(summary.tailReads, 0, label);
      if (kind === 'array') {
        assert.equal(
          summary.maxIndex >= 0 && summary.maxIndex < summaryNodes,
          true,
          `${label} 数组下标 ${summary.maxIndex}`,
        );
      }
      if (invoked) {
        assert.equal(
          generations[0].n > summaryNodes,
          true,
          `${label} 传输读取 ${generations[0].n}，计数器未覆盖大结构`,
        );
      }
      assert.equal(record.argsSummary.includes(nestedSecret), false, label);
      assert.equal(record.argsSummary.includes(headerSecret), false, label);
      assert.equal(record.argsSummary.includes(tailSentinel), false, label);
      assert.equal(record.argsSummary.includes(hugeTail), false, label);
      assert.equal(record.argsSummary.includes('[redacted]'), true, label);
      assert.equal(
        record.argsSummary.includes(kind === 'flat' ? 'kept-marker' : 'kept-item'),
        true,
        label,
      );
      assert.equal(record.argsSummary.length <= 240, true, label);
    }

    const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
    const callsFile = join(root, 'calls.txt');
    try {
      const opened = await openUserMcp({
        option: option({ args: [fixture, callsFile] }),
        selection: selection(),
      });
      assert.equal(opened.ok, true);
      const plan = [
        ['echo', 'flat'],
        ['fail', 'flat'],
        ['missing', 'flat'],
        ['echo', 'array'],
        ['fail', 'array'],
        ['missing', 'array'],
      ];
      const seen = [];
      for (const [toolName, kind] of plan) {
        const made = tracked(kind);
        const result = await opened.session.call(toolName, made.args);
        seen.push({ toolName, kind, result, generations: made.generations });
      }
      await opened.session.close();
      const records = readMcpCalls(opened.session.log);
      assert.equal(records.length, plan.length);
      for (let index = 0; index < plan.length; index += 1) {
        const [toolName, kind] = plan[index];
        const record = records[index];
        const item = seen[index];
        const invoked = toolName !== 'missing';
        assert.equal(record.toolName, toolName);
        assert.equal(record.outcome, toolName === 'echo' ? 'ok' : 'fail');
        if (toolName === 'echo') {
          assert.equal(item.result.ok, true);
          assert.equal(item.result.text, 'pong');
        } else if (toolName === 'fail') {
          assert.equal(item.result.ok, false);
          assert.equal(item.result.code, 'mcp-call-failed');
          assert.equal(record.errorCode, 'mcp-call-failed');
        } else {
          assert.equal(item.result.ok, false);
          assert.equal(item.result.code, 'mcp-tool-unknown');
          assert.equal(record.errorCode, 'mcp-tool-unknown');
        }
        assertBounded(`${kind}/${toolName}`, record, item.generations, kind, invoked);
      }
      const calls = await readFile(callsFile, 'utf8');
      assert.equal(calls, 'echo\nfail\necho\nfail\n');

      const refused = await openUserMcp({
        option: option({ args: [fixture, callsFile] }),
        selection: selection({ toolsAuthorized: false, explicitToolGrant: false }),
      });
      assert.equal(refused.ok, true);
      for (const kind of ['flat', 'array']) {
        const made = tracked(kind);
        const result = await refused.session.call('echo', made.args);
        assert.equal(result.ok, false);
        assert.equal(result.code, 'mcp-not-authorized');
        const record = readMcpCalls(refused.session.log).at(-1);
        assert.equal(record.outcome, 'fail');
        assert.equal(record.errorCode, 'mcp-not-authorized');
        assertBounded(`${kind}/拒绝`, record, made.generations, kind, false);
      }
      await refused.session.close();
      assert.equal(await readFile(callsFile, 'utf8'), calls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  '深度边界上的大数组、重复引用和循环在节点预算用尽后停止读取',
  { timeout: 30_000 },
  async () => {
    const width = 10_000;
    const depthTail = 'synthetic-depth-tail';
    const cycleTail = 'synthetic-cycle-tail';
    const nestedSecret = 'synthetic-cycle-secret';
    // 根对象加从第 1 层到数组本身：数组位于 SUMMARY_DEPTH，子元素在更深一层。
    const depthArrayNodes = summaryDepth + 1;
    const depthElementReads = summaryNodes - depthArrayNodes;
    // 根、叶子、敏感占位、note、循环对象、自引用、再次引用叶子、副本数组。
    const cycleNodesBeforeCopies = 8;
    const cycleElementReads = summaryNodes - cycleNodesBeforeCopies;
    assert.equal(depthElementReads > 0 && depthElementReads < width, true);
    assert.equal(cycleElementReads > 0 && cycleElementReads < width, true);

    function countedArray(onIndex) {
      const batch = [];
      for (let index = 0; index < width; index += 1) {
        Object.defineProperty(batch, index, {
          enumerable: true,
          get() {
            return onIndex(index);
          },
        });
      }
      return batch;
    }

    const depthReads = { elements: 0, maxIndex: -1, tail: 0, inner: 0 };
    const depthBatch = countedArray((index) => {
      depthReads.elements += 1;
      depthReads.maxIndex = index;
      if (index === width - 1) depthReads.tail += 1;
      const item = {};
      Object.defineProperty(item, 'nested', {
        enumerable: true,
        get() {
          depthReads.inner += 1;
          return depthTail;
        },
      });
      return item;
    });
    const depthParent = {};
    Object.defineProperty(depthParent, 'down', { enumerable: true, value: depthBatch });
    Object.defineProperty(depthParent, 'tail', {
      enumerable: true,
      get() {
        depthReads.tail += 1;
        return depthTail;
      },
    });
    let depthValue = depthParent;
    for (let level = summaryDepth - 1; level > 1; level -= 1) {
      depthValue = { down: depthValue };
    }
    const depthArgs = { payload: depthValue };

    const cycleReads = {
      elements: 0,
      maxIndex: -1,
      tail: 0,
      secret: 0,
      note: 0,
      self: 0,
      again: 0,
    };
    const leaf = {};
    Object.defineProperty(leaf, 'apiKey', {
      enumerable: true,
      get() {
        cycleReads.secret += 1;
        return nestedSecret;
      },
    });
    Object.defineProperty(leaf, 'note', {
      enumerable: true,
      get() {
        cycleReads.note += 1;
        return 'leaf-note';
      },
    });
    const cycle = {};
    Object.defineProperty(cycle, 'self', {
      enumerable: true,
      get() {
        cycleReads.self += 1;
        return cycle;
      },
    });
    Object.defineProperty(cycle, 'again', {
      enumerable: true,
      get() {
        cycleReads.again += 1;
        return leaf;
      },
    });
    const copies = countedArray((index) => {
      cycleReads.elements += 1;
      cycleReads.maxIndex = index;
      if (index === width - 1) cycleReads.tail += 1;
      return index % 2 === 0 ? cycle : leaf;
    });
    Object.defineProperty(cycle, 'copies', { enumerable: true, value: copies });
    Object.defineProperty(cycle, 'tail', {
      enumerable: true,
      get() {
        cycleReads.tail += 1;
        return cycleTail;
      },
    });
    const cycleArgs = { leaf, cycle };

    const root = await mkdtemp(join(tmpdir(), 'zhuma-user-mcp-'));
    try {
      const refused = await openUserMcp({
        option: option({ args: [fixture] }),
        selection: selection({ toolsAuthorized: false, explicitToolGrant: false }),
      });
      assert.equal(refused.ok, true);
      const depthResult = await refused.session.call('echo', depthArgs);
      const cycleResult = await refused.session.call('echo', cycleArgs);
      assert.equal(depthResult.ok, false);
      assert.equal(depthResult.code, 'mcp-not-authorized');
      assert.equal(cycleResult.ok, false);
      assert.equal(cycleResult.code, 'mcp-not-authorized');
      const records = readMcpCalls(refused.session.log);
      assert.equal(records.length, 2);
      const depthSummary = records[0].argsSummary;
      const cycleSummary = records[1].argsSummary;

      assert.equal(depthReads.elements, depthElementReads);
      assert.equal(depthReads.maxIndex, depthElementReads - 1);
      assert.equal(depthReads.tail, 0);
      assert.equal(depthReads.inner, 0);
      assert.equal(depthSummary.includes(depthTail), false);
      assert.equal(depthSummary.includes('[truncated]'), true);
      assert.equal(depthSummary.length <= 240, true);

      assert.equal(cycleReads.elements, cycleElementReads);
      assert.equal(cycleReads.maxIndex, cycleElementReads - 1);
      assert.equal(cycleReads.tail, 0);
      assert.equal(cycleReads.secret, 0);
      assert.equal(cycleReads.note, 1);
      assert.equal(cycleReads.self, 1);
      assert.equal(cycleReads.again, 1);
      assert.equal(cycleSummary.includes(nestedSecret), false);
      assert.equal(cycleSummary.includes(cycleTail), false);
      assert.equal(cycleSummary.includes('[redacted]'), true);
      assert.equal(cycleSummary.includes('leaf-note'), true);
      assert.equal(cycleSummary.includes('[truncated]'), true);
      assert.equal(cycleSummary.length <= 240, true);
      await refused.session.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
