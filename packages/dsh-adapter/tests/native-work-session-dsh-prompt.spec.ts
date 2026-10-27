/** Real pinned, patched SDK/JSONL/Skill/MCP; model output, grants, deployment
 * contributions and Host resource leases are explicit synthetic contracts.
 * The isolated qualification runner supplies the product fixture bundle.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt, { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import {
  openNativeWorkSessions,
  grant,
  message,
  ScriptedAdapter,
  toolResponse,
  compositionFacts,
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
  registerExecutionRunResources,
  describeExecutionResourceTool,
  executionResourceDigest,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  bootNativeReviews,
} from './zhuma-native-work-dsh-prompt-bundle.ts';

const coding = 'SYNTHETIC_CODING_PERSONA';
const development = [
  'SYNTHETIC_INSPECT_HARNESS_USE_PWD',
  'SYNTHETIC_REBUILD_THIS_GUI',
  'SYNTHETIC_HARNESS_CHECKOUT',
  'SYNTHETIC_HARNESS_GUI_URL',
];
const retained = [
  'SYNTHETIC_SUFFIX_POLICY',
  'SYNTHETIC_WORKING_DIRECTORY',
  'SYNTHETIC_SANDBOX_POLICY',
  'SYNTHETIC_APPROVAL_POLICY',
  'SYNTHETIC_REQUIRED_CONTEXT',
];

function deployment(ctx) {
  for (const [index, name, order] of [
    [0, 'harness:source', 'HARNESS_SOURCE'],
    [1, 'app:web-surface', 'WEB_SURFACE'],
  ]) {
    ctx.systemPrompt.section({
      name,
      order: ctx.systemPrompt.getSectionOrder(order),
      text: development[index],
    });
    ctx.systemPrompt.context({
      name,
      order: ctx.systemPrompt.getContextOrder(order),
      text: development[index + 2],
    });
  }
  for (const [index, name] of ['working-directory', 'sandbox-policy', 'approval-policy'].entries())
    ctx.systemPrompt.context({ name, order: 100 + index, text: retained[index + 1] });
  ctx.systemPrompt.context({
    name: 'fixture-required',
    order: 200,
    text: retained[4],
    required: true,
  });
}

async function boot(
  root,
  adapter,
  compose = (_ctx, binding) => ({
    context: `FIXED_NODE_${binding.scope.nodeId}; SELECTED_EXPERT_INSTRUCTION; FIXED_INPUT_REF_V1`,
    toolAllowlist: [],
  }),
) {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await ctx.plugin(Prompt, { personaPrefix: coding, personaSuffix: retained[0] });
    await ctx.plugin(Tools);
    await ctx.plugin(Agents);
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Loop, { agents: [] });
    await ctx.plugin(Storage);
    await ctx.plugin(JsonStorage, { root: join(root, 'domains') });
    await ctx.plugin(Domain, { backend: 'json' });
    ctx.llm.registerAdapter(['contract'], adapter);
    deployment(ctx);
    const work = await openNativeWorkSessions(ctx, {
      workingDirectory: () => ({ kind: 'text-only' }),
      compose,
    });
    return { ctx, ...work, adapter, close: () => ctx.fiber.dispose() };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-prompt-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function idle(h, current) {
  const agent = h.ctx.agents.get(h.service.open(current).binding.nativeSessionId);
  assert(agent, 'the original factory published the actual Agent');
  await agent.whenIdle();
  return agent;
}
function isolated(request) {
  const text = JSON.stringify(request);
  for (const absent of [coding, ...development])
    assert(
      !text.includes(absent),
      `unrelated deployment contribution reached the request: ${absent}`,
    );
  for (const present of retained) assert(text.includes(present), `lost runtime policy: ${present}`);
  assert(text.includes('DeepSeek Harness'), 'retain the original Harness attribution');
  assert(text.includes('Zhuma'), 'admit the scoped work-node identity');
}

test('native prompt scope: actual requests keep fixed work and security while ordinary Agents keep deployment guidance', async (t) => {
  const h = await boot(await home(t), new ScriptedAdapter(['first', 'second']));
  t.onTestFinished(() => h.close());
  const globalBefore = await h.ctx.systemPrompt.assemble();
  const globalText = renderPrompt(globalBefore) + renderContextSnapshot(globalBefore);
  for (const present of [coding, ...development, ...retained]) assert(globalText.includes(present));
  const plain = await h.ctx.agents.create({
    sessionId: SessionId('ordinary-prompt-sibling'),
    agentOptions: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
  });
  t.onTestFinished(() => plain.dispose());
  const plainPrompt = async () => {
    const assembled = await h.ctx.systemPrompt.assemble({ scope: scopeOf(plain.agent.ctx) });
    return renderPrompt(assembled) + renderContextSnapshot(assembled);
  };
  assert.equal(await plainPrompt(), globalText);
  for (const nodeId of ['node-first', 'node-second']) {
    const current = grant({ nodeId });
    await h.service.send(current, message(`start-${nodeId}`, 'Perform this fixed node.'));
    await idle(h, current);
    const request = h.adapter.requests.at(-1);
    isolated(request);
    const text = JSON.stringify(request);
    for (const present of [
      `FIXED_NODE_${nodeId}`,
      'SELECTED_EXPERT_INSTRUCTION',
      'FIXED_INPUT_REF_V1',
    ])
      assert(text.includes(present), `lost fixed work: ${present}`);
    const other = nodeId === 'node-first' ? 'node-second' : 'node-first';
    assert(
      !text.includes(`FIXED_NODE_${other}`),
      'independent native scopes cannot share fixed work',
    );
    assert.deepEqual(request.tools ?? [], []);
    assert.equal((await h.service.stop(current)).status, 'stopped');
  }
  assert.equal(h.adapter.requests.length, 2);
  assert.equal(
    await plainPrompt(),
    globalText,
    'native disposal does not alter the ordinary Agent',
  );
  const globalAfter = await h.ctx.systemPrompt.assemble();
  assert.equal(renderPrompt(globalAfter) + renderContextSnapshot(globalAfter), globalText);
});

async function mcpServer(t) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'prompt-fixture', version: '1.0.0' },
        instructions: 'SELECTED_MCP_SERVER_INSTRUCTIONS',
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'ping',
            description: 'Check the selected fixed document service.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      calls++;
      result = { content: [{ type: 'text', text: 'ACTUAL_LOCAL_MCP_RESULT' }] };
    } else {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls: () => calls };
}

test('native prompt scope: original scoped Skill loader and selected MCP instructions/results remain usable', async (t) => {
  const peer = await mcpServer(t),
    root = await home(t);
  const config = {
    transport: 'streamable-http',
    serverName: 'docs',
    url: peer.url,
    reconnect: { enabled: false },
    failOnStartupError: true,
  };
  const qualifier = new Context();
  let descriptor;
  try {
    await qualifier.plugin(Prompt);
    await qualifier.plugin(Tools, { mode: 'native' });
    await qualifier.plugin(Mcp, config);
    descriptor = describeExecutionResourceTool(qualifier.tools.get('mcp__docs__ping'));
  } finally {
    await qualifier.fiber.dispose();
  }
  const facts = compositionFacts(),
    plan = facts.workbench.appliedPlans[0];
  const node = plan.task.workflows[0].nodes.find((item) => item.id === facts.node.nodeId);
  plan.assets = [
    {
      id: 'selected-skill',
      name: 'Selected method',
      kind: 'skill',
      description: 'Selected routing',
      content: 'SELECTED_SKILL_BODY',
      available: true,
    },
    {
      id: 'other-skill',
      name: 'Other method',
      kind: 'skill',
      description: 'Not selected',
      content: 'UNSELECTED_PRIVATE_BODY',
      available: true,
    },
    {
      id: 'docs-mcp',
      name: 'Docs',
      kind: 'mcp',
      description: 'Host connection',
      content: 'NOT_EXECUTABLE_ASSET_CONFIG',
      available: true,
    },
  ];
  node.skillIds = ['selected-skill'];
  node.mcpIds = ['docs-mcp'];
  facts.node.handoff.skillRefs = [{ id: 'selected-skill', version: plan.id }];
  facts.node.handoff.mcpRefs = [{ id: 'docs-mcp', version: plan.id }];
  facts.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: [
      {
        ref: facts.node.handoff.mcpRefs[0],
        definitionDigest: executionResourceDigest(plan.assets[2]),
        connectionRef: { id: 'fixed-docs', version: '1' },
        serverName: 'docs',
        tools: [descriptor],
      },
    ],
  };
  const snapshot = freezeExecutionRunComposition(facts),
    projected = executionRunCompositionRequest(snapshot);
  const current = grant(facts.scope),
    source = new AbortController();
  let released = 0;
  const adapter = new ScriptedAdapter([
    toolResponse({ name: 'selected-skill' }, 'load-method', 'skill'),
    toolResponse({}, 'read-docs', 'mcp__docs__ping'),
    'Work draft returned.',
  ]);
  const h = await boot(root, adapter, async (ctx, binding, received) => {
    const adopted = await registerExecutionRunResources(ctx, snapshot, binding, received, {
      sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
      signal: source.signal,
      assertCurrent(saved, actual, authority) {
        assert.deepEqual(saved, snapshot);
        assert.equal(authority, current);
        assert.equal(actual.selection.configurationId, snapshot.configurationId);
        current.assertCurrent('send');
      },
      async openMcp(resource, signal) {
        signal.throwIfAborted();
        assert.deepEqual(resource.connectionRef, { id: 'fixed-docs', version: '1' });
        return {
          connectionRef: resource.connectionRef,
          signal: source.signal,
          config,
          assertCurrent() {
            current.assertCurrent('send');
          },
          release() {
            released++;
          },
        };
      },
    });
    await adopted.ready;
    return { context: snapshot.payload.context, toolAllowlist: adopted.toolAllowlist };
  });
  t.onTestFinished(() => h.close());
  await h.ctx.plugin(FsLocal, { cwd: root });
  await h.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await h.service.send(current, {
    requestId: 'selected-resources',
    text: projected.firstMessage.text,
    mode: 'followup',
    selection: projected.selection,
  });
  await idle(h, current);
  assert.equal(adapter.requests.length, 3);
  for (const request of adapter.requests) {
    isolated(request);
    const text = JSON.stringify(request);
    assert(text.includes('SELECTED_MCP_SERVER_INSTRUCTIONS'));
    assert(!text.includes('UNSELECTED_PRIVATE_BODY'));
    assert(!text.includes('NOT_EXECUTABLE_ASSET_CONFIG'));
    assert.deepEqual((request.tools ?? []).map((tool) => tool.name).sort(), [
      'mcp__docs__ping',
      'skill',
    ]);
  }
  assert(!JSON.stringify(adapter.requests[0]).includes('SELECTED_SKILL_BODY'));
  assert(JSON.stringify(adapter.requests[1]).includes('SELECTED_SKILL_BODY'));
  assert(JSON.stringify(adapter.requests[2]).includes('ACTUAL_LOCAL_MCP_RESULT'));
  assert.equal(peer.calls(), 1);
  assert.equal((await h.service.stop(current)).status, 'stopped');
  assert.equal(released, 1, 'the original scope lifecycle releases the selected MCP lease');
});

test('native prompt scope: cold resume keeps fixed context and the original stable session without restoring development guidance', async (t) => {
  const root = await home(t),
    current = grant();
  let h = await boot(root, new ScriptedAdapter(['before reopen']));
  t.onTestFinished(() => h.close());
  await h.service.send(current, message('before', 'First fixed-node request.'));
  await idle(h, current);
  isolated(h.adapter.requests[0]);
  const before = h.service.open(current).binding;
  assert.equal((await h.service.stop(current)).status, 'stopped');
  await h.close();
  h = await boot(root, new ScriptedAdapter(['after reopen']));
  assert.equal(h.service.open(current).binding.nativeSessionId, before.nativeSessionId);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.equal(h.adapter.requests.length, 0, 'reading the binding never starts an Agent');
  await h.service.send(current, message('after', 'Explicitly resume this node.'));
  await idle(h, current);
  assert.equal(h.adapter.requests.length, 1);
  isolated(h.adapter.requests[0]);
  const text = JSON.stringify(h.adapter.requests[0]);
  assert(text.includes('First fixed-node request.'));
  assert(text.includes('before reopen'));
  assert(text.includes('FIXED_INPUT_REF_V1'));
});

test('native prompt scope: independent review retains its fixed target and real Skill with review-only end tools', async (t) => {
  const h = await bootNativeReviews(await home(t), { isolatedSkill: true });
  t.onTestFinished(() => h.close());
  deployment(h.ctx);
  // This fixture's global prefix/suffix are intentionally empty; the other
  // cases prove their replacement/preservation against a nonempty deployment.
  const reviewer = h.reviewer('prompt-reviewer'),
    ready = Promise.withResolvers<void>();
  t.onTestFinished(
    h.review.onReviewReady((actual) => {
      if (actual === reviewer.grant) ready.resolve();
    }),
  );
  h.adapter.script.push(toolResponse({ name: 'selected-review' }, 'review-method', 'skill'));
  h.planReview(reviewer);
  await h.start(reviewer);
  await ready.promise;
  await idle(h, reviewer.grant);
  assert.equal(h.adapter.requests.length, 3);
  assert(JSON.stringify(h.adapter.requests[1]).includes('SELECTED_ORIGINAL_SKILL_BODY'));
  assert.equal(h.reads.length, 1, 'the real SDK tool reads the fixed target');
  for (const request of h.adapter.requests) {
    const text = JSON.stringify(request);
    for (const absent of development) assert(!text.includes(absent), absent);
    for (const present of retained.slice(1)) assert(text.includes(present), present);
    assert.deepEqual((request.tools ?? []).map((tool) => tool.name).sort(), [
      'complete_review',
      'read_review_target',
      'skill',
    ]);
  }
});
