/** Fixed source SDK with actual local HTTP. No model, credentials, profile or external service. */
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const results = [];
const gate = () => Promise.withResolvers();
async function within(promise, label, ms = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`deadline: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function setup(t) {
  const entered = gate(),
    remoteRelease = gate(),
    remoteFinished = gate(),
    httpClosed = gate();
  const stats = {
    httpOpened: 0,
    httpClosed: 0,
    calls: [],
    remoteActive: 0,
    remoteFinished: 0,
    remoteAbort: 0,
  };
  const active = new Map();
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'close-verification', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      'ping',
      { description: 'Return the fixed local pong.', inputSchema: z.object({}) },
      async () => {
        stats.calls.push('ping');
        return { content: [{ type: 'text', text: 'pong' }] };
      },
    );
    server.registerTool(
      'hold',
      {
        description: 'Hold a real HTTP tool call for cancellation proof.',
        inputSchema: z.object({}),
      },
      async (_args, extra) => {
        stats.calls.push('hold');
        stats.remoteActive++;
        extra?.signal?.addEventListener(
          'abort',
          () => {
            stats.remoteAbort++;
          },
          { once: true },
        );
        entered.resolve();
        await remoteRelease.promise;
        stats.remoteActive--;
        stats.remoteFinished++;
        remoteFinished.resolve();
        return {
          content: [
            { type: 'text', text: 'held operation finished after explicit server release' },
          ],
        };
      },
    );
    return server;
  });
  const handle = toNodeHandler(handler);
  const http = createServer((request, response) => {
    const row = { method: request.method, rpc: undefined, tool: undefined };
    active.set(response, row);
    stats.httpOpened++;
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        const value = JSON.parse(body);
        row.rpc = value.method;
        row.tool = value.params?.name;
      } catch {}
    });
    response.once('close', () => {
      active.delete(response);
      stats.httpClosed++;
      if (row.rpc === 'tools/call' && row.tool === 'hold') httpClosed.resolve();
    });
    void handle(request, response).catch(() => {
      if (!response.destroyed) response.writeHead(500).end('fixture failure');
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const ctx = new Context();
  const logs = [];
  ctx.logger.error = (value) => {
    logs.push(String(value));
  };
  const clients = [];
  const originalConnect = Client.prototype.connect;
  const passThrough = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (...args) {
    clients.push({ client: this, transport: args[0] });
    return originalConnect.apply(this, args);
  });
  await ctx.plugin(Prompt);
  await ctx.plugin(Tools, { mode: 'native' });
  const fiber = ctx.plugin(Mcp, {
    transport: 'streamable-http',
    serverName: 'close_check',
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: {},
    failOnStartupError: true,
    reconnect: { enabled: false },
    toolCallTimeoutMs: 30000,
  });
  await fiber;
  assert.equal(clients.length, 1, 'observe the actual original SDK Client, not a replacement');
  const { client, transport } = clients[0];
  const explicitClose = Mcp.captureMcpClientClose(fiber.ctx);
  assert.equal(Mcp.captureMcpClientClose(fiber.ctx), explicitClose);
  assert.ok(Object.isFrozen(explicitClose));
  const originalClose = transport.close.bind(transport);
  let clientClosed = 0;
  const onclose = client.onclose;
  client.onclose = () => {
    clientClosed++;
    onclose?.();
  };
  const closeEntered = gate(),
    closeEnded = gate();
  const instrumentClose = (override) => {
    transport.close = async () => {
      closeEntered.resolve();
      if (override) await override();
      else await originalClose();
      closeEnded.resolve();
    };
  };
  instrumentClose();
  const pending = [];
  function call(name, signal = new AbortController().signal) {
    const definition = ctx.tools.get(`mcp__close_check__${name}`);
    assert.ok(definition);
    const promise = Promise.resolve(
      definition.execute({}, { callId: `poc-${pending.length}`, signal }),
    );
    // Consume rejection immediately without substituting a completed-call proof.
    void promise.catch(() => undefined);
    pending.push(promise);
    return promise;
  }
  const heldActive = () =>
    [...active.values()].filter((row) => row.rpc === 'tools/call' && row.tool === 'hold').length;
  let closed = false;
  t.onTestFinished(async () => {
    passThrough.mockRestore();
    transport.close = originalClose;
    // Restore the real transport and release only this fixture's remote handler.
    await originalClose();
    remoteRelease.resolve();
    await Promise.allSettled(pending);
    await fiber.dispose();
    await ctx.fiber.dispose();
    await handler.close();
    http.closeAllConnections();
    await new Promise((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    await writeFile(process.env.ZHUMA_MCP_CLOSE_OBSERVATIONS, JSON.stringify(results, null, 2));
  });
  return {
    ctx,
    fiber,
    explicitClose,
    stats,
    logs,
    active,
    call,
    entered,
    remoteRelease,
    remoteFinished,
    httpClosed,
    client,
    transport,
    originalClose,
    instrumentClose,
    closeEntered,
    closeEnded,
    heldActive,
    clientClosed: () => clientClosed,
    dispose() {
      const result = explicitClose.close().then(() => fiber.dispose());
      void result.then(
        () => {
          closed = true;
        },
        () => {},
      );
      return result;
    },
    disposed: () => closed,
  };
}

test('actual HTTP SDK: successful fixed list/call and normal close abort actual transport ownership', async (t) => {
  const h = await setup(t);
  const names = ['mcp__close_check__hold', 'mcp__close_check__ping'].filter((name) =>
    h.ctx.tools.get(name),
  );
  assert.deepEqual(names, ['mcp__close_check__hold', 'mcp__close_check__ping']);
  const value = await h.call('ping');
  assert.ok(JSON.stringify(value).includes('pong'));
  assert.deepEqual(h.stats.calls, ['ping']);
  await h.dispose();
  await within(h.closeEnded.promise, 'real transport close');
  assert.equal(h.clientClosed(), 1);
  assert.equal(h.ctx.tools.get('mcp__close_check__ping'), undefined);
  results.push({
    case: 'normal',
    fault: 'none',
    list: names,
    serverCalls: h.stats.calls,
    clientCloseObserved: h.clientClosed(),
    disposeResolved: h.disposed(),
    remoteActive: h.stats.remoteActive,
  });
});

test('fixed HTTP SDK: explicit close rejects when Cordis disposal would report success with a real call held', async (t) => {
  const h = await setup(t);
  // Fault injection at this actual transport instance only: return from close
  // without aborting the real fetch or emitting onclose. No source/module mocks.
  h.instrumentClose(async () => undefined);
  const pending = h.call('hold');
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await within(h.entered.promise, 'real call before false close');
  const started = performance.now();
  await assert.rejects(h.explicitClose.close(), { code: 'mcp-close-unconfirmed' });
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed >= 4900,
    'the unmodified real supervisor 5000ms close-confirmation timeout ran',
  );
  assert.equal(h.clientClosed(), 0);
  assert.equal(settled, false);
  assert.equal(
    h.heldActive(),
    1,
    'server still holds the actual HTTP response after reported fiber completion',
  );
  assert.equal(h.stats.remoteActive, 1);
  await h.fiber.dispose();
  const observation = {
    case: 'close-confirmation-timeout',
    fault: 'actual transport instance close no-op; real connect/list/call unchanged',
    elapsedMs: Math.round(elapsed),
    explicitCloseRejected: true,
    cordisFiberDisposeResolved: true,
    clientCloseObserved: h.clientClosed(),
    clientCallSettled: settled,
    httpHeld: h.heldActive(),
    remoteActive: h.stats.remoteActive,
    loggedIncompleteClose: h.logs.some((line) => line.includes('closure')),
  };
  assert.equal(observation.explicitCloseRejected, true);
  await assert.rejects(h.explicitClose.close(), { code: 'mcp-close-unconfirmed' });
  // Safety cleanup is a separately measured actual close, not proof by a log.
  h.transport.close = h.originalClose;
  await h.originalClose();
  await within(Promise.allSettled([pending]), 'real cleanup settles faulted client call');
  await within(h.httpClosed.promise, 'real cleanup closes faulted HTTP response');
  assert.equal(h.clientClosed(), 1);
  assert.equal(h.heldActive(), 0);
  results.push({
    ...observation,
    afterExplicitRealClose: {
      clientCloseObserved: h.clientClosed(),
      clientCallSettled: settled,
      httpHeld: h.heldActive(),
    },
    conclusion:
      'explicit original supervisor close rejects; resource owner must not settle even when Cordis fiber resolves',
  });
}, 15000);

test('fixed HTTP SDK: parent, sibling, inherited and JSON contexts cannot capture another original owner', async (t) => {
  const h = await setup(t);
  for (const context of [h.ctx, h.ctx.extend(), Object.create(h.fiber.ctx), JSON.parse('{}')])
    assert.throws(() => Mcp.captureMcpClientClose(context), { code: 'mcp-close-unavailable' });
  const close = h.explicitClose;
  const first = close.close(),
    second = close.close();
  assert.equal(first, second, 'concurrent close shares the one original supervisor promise');
  await first;
  await h.fiber.dispose();
  assert.equal(h.clientClosed(), 1);
  assert.equal(
    Mcp.captureMcpClientClose(h.fiber.ctx),
    close,
    'retained original owner does not fall back after unload',
  );
  await close.close();
  results.push({
    case: 'exact-context-owner',
    allForeignContextsRejected: true,
    samePromise: true,
    clientCloseObserved: h.clientClosed(),
  });
});
