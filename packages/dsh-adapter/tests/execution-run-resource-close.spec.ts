/** Actual fixed SDK/HTTP bridge; Run scope and borrowed Host leases are contracts.
 * The SDK runner supplies the same generated bundle and local HTTP fixture as
 * execution-run-resources.spec.ts. No model or default Agent factory is replaced.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import { Client } from '@modelcontextprotocol/client';
import { startHttpMcpFixture } from './zhuma-run-resource-http.js';
import {
  grant,
  boot,
  ScriptedAdapter,
  compositionFacts,
  describeExecutionResourceTool,
  executionResourceDigest,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
  registerExecutionRunResources,
} from './zhuma-run-resources-bundle.js';

async function within(promise, milliseconds = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('bridge did not settle within its test deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-resource-close-'));
  const peer = await startHttpMcpFixture();
  const source = new AbortController();
  const clients = [];
  const released = [];
  let adoption;
  let spy;
  let held;
  let h;
  let agentContext;
  let agent;
  t.onTestFinished(async () => {
    held?.release();
    spy?.mockRestore();
    for (const row of clients) {
      row.transport.close = row.close;
      await row.close();
    }
    await adoption?.dispose().catch(() => undefined);
    await h?.close();
    await peer.close();
    await rm(root, { recursive: true, force: true });
  });
  const configs = ['first', 'second'].map((serverName) => ({
    transport: 'streamable-http',
    serverName,
    url: peer.url,
    headers: {},
    failOnStartupError: true,
    reconnect: { enabled: false },
    toolCallTimeoutMs: 5000,
  }));
  const descriptors = [];
  for (const config of configs) {
    const qualifier = new Context();
    try {
      await qualifier.plugin(Prompt);
      await qualifier.plugin(Tools, { mode: 'native' });
      const fiber = qualifier.plugin(Mcp, config);
      await fiber;
      descriptors.push(
        describeExecutionResourceTool(qualifier.tools.get(`mcp__${config.serverName}__ping`)),
      );
      await Mcp.captureMcpClientClose(fiber.ctx).close();
    } finally {
      await qualifier.fiber.dispose();
    }
  }
  const facts = compositionFacts();
  const plan = facts.workbench.appliedPlans[0];
  const node = plan.task.workflows[0].nodes.find((item) => item.id === facts.node.nodeId);
  plan.assets = configs.map((config) => ({
    id: config.serverName,
    name: config.serverName,
    kind: 'mcp',
    description: 'Actual local close-bridge fixture',
    content: '',
    available: true,
  }));
  node.skillIds = [];
  node.mcpIds = configs.map((config) => config.serverName);
  facts.node.handoff.skillRefs = [];
  facts.node.handoff.mcpRefs = plan.assets.map((asset) => ({ id: asset.id, version: plan.id }));
  facts.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: plan.assets.map((asset, index) => ({
      ref: facts.node.handoff.mcpRefs[index],
      definitionDigest: executionResourceDigest(asset),
      connectionRef: { id: asset.id, version: 'close-fixture-1' },
      serverName: asset.id,
      tools: [descriptors[index]],
    })),
  };
  const snapshot = freezeExecutionRunComposition(facts);
  const authority = grant(facts.scope);
  let binding;
  const producer = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    signal: source.signal,
    assertCurrent(saved, actualBinding, actualGrant) {
      assert.deepEqual(saved, snapshot);
      assert.equal(actualBinding, binding);
      assert.equal(actualGrant, authority);
      source.signal.throwIfAborted();
      return undefined;
    },
    async openMcp(resource, signal) {
      signal.throwIfAborted();
      const config = configs.find((item) => item.serverName === resource.serverName);
      assert(config);
      return {
        connectionRef: resource.connectionRef,
        signal: source.signal,
        config,
        assertCurrent() {
          source.signal.throwIfAborted();
          return undefined;
        },
        release() {
          released.push(resource.serverName);
        },
      };
    },
  };
  const connect = Client.prototype.connect;
  spy = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (...args) {
    const transport = args[0];
    const row = { client: this, transport, close: transport.close.bind(transport), closed: 0 };
    clients.push(row);
    const onclose = this.onclose;
    this.onclose = () => {
      row.closed++;
      onclose?.();
    };
    return connect.apply(this, args);
  });
  h = await boot(root, new ScriptedAdapter(['READY']), async (ctx, actualBinding, actualGrant) => {
    agentContext = ctx;
    binding = actualBinding;
    adoption = await registerExecutionRunResources(
      ctx,
      snapshot,
      actualBinding,
      actualGrant,
      producer,
    );
    return { context: snapshot.payload.context, toolAllowlist: snapshot.payload.toolAllowlist };
  });
  await h.ctx.plugin(FsLocal, { cwd: root });
  await h.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  return {
    source,
    clients,
    released,
    peer,
    close: () => h.close(),
    holdNext() {
      held = peer.holdNext();
      return held;
    },
    async start() {
      const projection = executionRunCompositionRequest(snapshot);
      await h.service.send(authority, {
        requestId: 'close-bridge-start',
        text: projection.firstMessage.text,
        mode: 'followup',
        selection: projection.selection,
      });
      agent = h.ctx.agents.get(binding.nativeSessionId);
      assert(agent);
      await agent.whenIdle();
      return adoption;
    },
    call(name) {
      return agentContext.tools.execute({
        callId: `close-bridge:${peer.calls.length}`,
        name: `mcp__${name}__ping`,
        arguments: {},
        agent,
        signal: new AbortController().signal,
      });
    },
  };
}

test('actual resource close bridge: successful original close releases each borrowed connection once', async (t) => {
  const f = await setup(t);
  const adopted = await f.start();
  assert.equal(f.clients.length, 2);
  for (const name of ['first', 'second']) {
    assert.equal((await f.call(name)).isError, false);
  }
  assert.deepEqual(f.peer.calls, ['ping', 'ping']);
  const closing = adopted.dispose();
  assert.equal(adopted.drain(), closing);
  await closing;
  assert.deepEqual(
    f.clients.map((row) => row.closed),
    [1, 1],
  );
  assert.deepEqual([...f.released].sort(), ['first', 'second']);
  assert.equal((await f.call('first')).isError, true);
  assert.deepEqual(f.peer.calls, ['ping', 'ping']);
});

test('actual resource close bridge: false physical close stays rejected and retains only its own borrowed lease', async (t) => {
  const f = await setup(t);
  const adopted = await f.start();
  assert.equal((await f.call('first')).isError, false);
  assert.equal(f.clients.length, 2);
  // Fault only this original transport instance. Real Client/connect/list/call
  // and the other original transport remain unchanged.
  f.clients[0].transport.close = async () => undefined;
  const started = performance.now();
  const closing = adopted.dispose();
  await assert.rejects(closing, { code: 'resources-unavailable' });
  assert(performance.now() - started >= 4900, 'the real SDK 5000ms confirmation deadline ran');
  assert.equal(adopted.dispose(), closing);
  assert.equal(adopted.drain(), closing);
  await assert.rejects(adopted.drain(), { code: 'resources-unavailable' });
  assert.deepEqual(
    f.clients.map((row) => row.closed),
    [0, 1],
  );
  assert.deepEqual(f.released, ['second']);
  assert.equal((await f.call('first')).isError, true);
  assert.deepEqual(f.peer.calls, ['ping']);
  await f.clients[0].close();
  assert.equal(
    f.clients[0].closed,
    1,
    'separate actual cleanup closes the failed physical transport',
  );
  await assert.rejects(adopted.drain(), { code: 'resources-unavailable' });
  assert.deepEqual(
    f.released,
    ['second'],
    'later physical cleanup cannot rewrite the failed drain result',
  );
}, 15000);

test('actual resource close bridge: revoked unpublished startup owns and confirms its original connection before release', async (t) => {
  const f = await setup(t);
  const held = f.holdNext();
  const starting = f.start();
  void starting.catch(() => undefined);
  await held.entered;
  f.source.abort();
  try {
    await within(assert.rejects(starting, { code: 'resources-unavailable' }));
    // Send rejection precedes the native manager's owned activation drain.
    // Observe that real drain, rather than treating rejection as teardown proof.
    await within(f.close());
    assert.equal(f.clients.length, 1);
    // An initializing Client can still be unattached; the original SDK closes
    // that transport directly. Observe the actual held HTTP response closing.
    await within(held.closed);
    assert.deepEqual(f.released, ['first']);
  } finally {
    held.release();
    await Promise.allSettled([starting]);
  }
});
