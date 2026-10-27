/** Real pinned, patched SDK/JSONL/Skill/MCP; model output, grants, deployment
 * contributions and Host resource leases are explicit synthetic contracts.
 * The isolated qualification runner supplies the product fixture bundle.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt, {
  renderPrompt,
  renderContextSnapshot,
  joinContextSections,
} from '@deepseek-ai/dsh-system-prompt';
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
  workingDirectory = () => ({ kind: 'text-only' }),
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
      workingDirectory,
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

for (const directoryKind of ['text-only', 'local']) {
  test(`native prompt scope: original scoped Skill loader and selected MCP instructions/results remain usable (${directoryKind})`, async (t) => {
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
    let released = 0,
      adopted;
    const adapter = new ScriptedAdapter([
      toolResponse({ name: 'selected-skill' }, 'load-method', 'skill'),
      toolResponse({}, 'read-docs', 'mcp__docs__ping'),
      'Work draft returned.',
    ]);
    const h = await boot(
      root,
      adapter,
      async (ctx, binding, received) => {
        adopted = await registerExecutionRunResources(ctx, snapshot, binding, received, {
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
      },
      (_binding, original) =>
        directoryKind === 'text-only'
          ? { kind: 'text-only' }
          : {
              kind: 'local',
              scope: original.scope,
              cwd: root,
              signal: original.signal,
              assertCurrent() {
                original.assertCurrent('send');
              },
            },
    );
    t.onTestFinished(async () => {
      await adopted?.dispose();
      await h.close();
    });
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
      assert.equal(
        containsDirectory(request.messages, root),
        directoryKind === 'local',
        'only an authorized local node presents its cwd',
      );
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
    await adopted.dispose();
    assert.equal(released, 1, 'the resource owner drains the original SDK connection lease');
  });
}

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
  let published;
  t.onTestFinished(
    h.ctx.on(
      'agent/created',
      ({ agent }) => {
        published = agent;
      },
      { global: true },
    ),
  );
  t.onTestFinished(
    h.review.onReviewReady((actual) => {
      if (actual === reviewer.grant) ready.resolve();
    }),
  );
  h.adapter.script.push(toolResponse({ name: 'selected-review' }, 'review-method', 'skill'));
  h.planReview(reviewer);
  await h.start(reviewer);
  await ready.promise;
  assert(published, 'capture the original Agent before accepted review retires its registry entry');
  assert.equal(published.id, h.service.open(reviewer.grant).binding.nativeSessionId);
  await published.whenIdle();
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

async function workingDirectory(h, root) {
  await h.ctx.plugin(FsLocal, { cwd: root });
  await h.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
}
function noPrivateDirectory(request, root) {
  assert(
    !containsDirectory(request.messages, root),
    'Host private cwd must not reach any model-visible message',
  );
}
function containsDirectory(value, root) {
  if (typeof value === 'string')
    return value.includes(root) || value.includes(JSON.stringify(root));
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some((item) => containsDirectory(item, root))
  );
}

test('native task context: fresh text-only requests omit the real Host default while the original service and ordinary Agent retain it', async (t) => {
  const root = await home(t),
    h = await boot(root, new ScriptedAdapter(['done']));
  t.onTestFinished(() => h.close());
  await workingDirectory(h, root);
  const ordinary = await h.ctx.agents.create({
    sessionId: SessionId('ordinary-directory-control'),
    agentOptions: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
  });
  t.onTestFinished(() => ordinary.dispose());
  const ordinaryContext = await h.ctx.systemPrompt.assemble({
    scope: scopeOf(ordinary.agent.ctx),
    agent: ordinary.agent,
  });
  assert(containsDirectory(ordinaryContext.contexts, root));
  const current = grant();
  await h.service.send(
    current,
    message('fresh-private-directory', 'Use only the fixed task materials.'),
  );
  const agent = await idle(h, current);
  assert.equal(h.adapter.requests.length, 1);
  noPrivateDirectory(h.adapter.requests[0], root);
  isolated(h.adapter.requests[0]);
  assert.equal(
    h.ctx.workingDirectory.get(agent.session),
    root,
    'do not invent a neutral directory or replace the original service',
  );
  assert.equal(h.ctx.workingDirectory.get(ordinary.agent.session), root);
});

function legacyContext(cwd, variant, version) {
  let sections = [
    { name: 'fixed-input', text: `LEGACY_FIXED_REF_${version}` },
    {
      name: 'working-directory:current',
      text: `Current working directory: ${JSON.stringify(cwd)}.`,
    },
    {
      name: 'security-policy',
      text: `LEGACY_POLICY_${version}`,
      attribution: `LEGACY_POLICY_SOURCE_${version}`,
    },
  ];
  if (variant === 'duplicate-directory') sections.push(sections[1]);
  if (variant === 'duplicate-other') sections.push(sections[0]);
  if (variant === 'directory-only') sections = [sections[1]];
  const source = {
    kind: 'runtime-context',
    form: 'snapshot',
    sections,
    provenance: `LEGACY_SOURCE_${version}`,
  };
  if (variant === 'undeclared') delete source.form;
  const text =
    joinContextSections(sections) + (variant === 'mismatch' ? 'UNATTRIBUTED_SUFFIX' : '');
  return createUserMessage({ content: [{ type: 'text', text }], source });
}

async function historyFiles(root) {
  const files = new Map();
  async function walk(path, name = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = join(name, entry.name),
        full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full, key);
      else if (entry.name.endsWith('.jsonl')) files.set(key, await readFile(full));
    }
  }
  await walk(join(root, 'sessions'));
  assert(files.size > 0, 'retain evidence from the original JSONL event files');
  return files;
}
async function unchangedPrefix(root, before) {
  const after = await historyFiles(root);
  for (const [name, bytes] of before) {
    assert(after.has(name), 'original JSONL file remains present');
    assert.deepEqual(
      after.get(name).subarray(0, bytes.length),
      bytes,
      'original event bytes remain an unchanged prefix',
    );
  }
}

async function oldSession(t, variants) {
  const root = await home(t),
    current = grant();
  const h = await boot(
    root,
    new ScriptedAdapter(['ORIGINAL_COMPLETED_REPLY']),
    undefined,
    (_binding, original) => ({
      kind: 'local',
      scope: original.scope,
      cwd: root,
      signal: original.signal,
      assertCurrent() {
        original.assertCurrent('send');
      },
    }),
  );
  try {
    await workingDirectory(h, root);
    await h.service.send(current, message('legacy-seed', 'Original permitted local work.'));
    const originalAgent = await idle(h, current);
    const binding = h.service.open(current).binding;
    // Original native execution supplies a real binding/JSONL/header.cwd.
    // These additional historical source records are explicit synthetic inputs.
    const session = originalAgent.session;
    const originalUser = session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'ORIGINAL_USER_MATERIAL' }],
      }),
      { surfaceOp: 'append' },
    );
    variants.forEach((variant, index) =>
      session.append('user/message', legacyContext(root, variant, index), {
        surfaceOp: 'append',
        sourceEventSeqs: [originalUser.seq],
      }),
    );
    const visible = new Set(session.surface.nodes);
    const snapshots = session
      .snapshotEvents()
      .filter(
        (event) =>
          event.type === 'user/message' &&
          event.data.source.kind === 'runtime-context' &&
          visible.has(event.seq),
      );
    const prefix = session.snapshotEvents();
    assert.equal(h.adapter.requests.length, 1, 'only the declared scripted seed turn ran');
    assert.equal((await h.service.stop(current)).status, 'stopped');
    await h.close();
    return { root, current, binding, prefix, snapshots, bytes: await historyFiles(root) };
  } finally {
    await h.close();
  }
}

test('native task context: cold legacy snapshots use original model-only replacements with unchanged human history, identities and repeat-prepare idempotency', async (t) => {
  const old = await oldSession(t, ['valid', 'valid', 'directory-only']);
  let h = await boot(old.root, new ScriptedAdapter(['continued']));
  t.onTestFinished(() => h.close());
  await workingDirectory(h, old.root);
  assert.deepEqual(h.service.open(old.current).binding, old.binding);
  await h.service.history(old.current);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.ctx.agents.list().length, 0);
  assert.deepEqual(
    await historyFiles(old.root),
    old.bytes,
    'open/history reads cannot write cleanup',
  );
  await h.service.send(
    old.current,
    message('resume-legacy-context', 'Resume the fixed work explicitly.'),
  );
  let agent = await idle(h, old.current);
  noPrivateDirectory(h.adapter.requests[0], old.root);
  const input = JSON.stringify(h.adapter.requests[0].messages);
  for (const text of [
    'ORIGINAL_USER_MATERIAL',
    'LEGACY_FIXED_REF_0',
    'LEGACY_FIXED_REF_1',
    'LEGACY_POLICY_0',
    'LEGACY_POLICY_1',
  ])
    assert(input.includes(text), text);
  assert.equal(agent.session.header.cwd, old.root, 'keep the original directory metadata locally');
  assert.deepEqual(agent.session.snapshotEvents().slice(0, old.prefix.length), old.prefix);
  const replacements = () =>
    agent.session
      .snapshotEvents()
      .filter((event) => event.type === 'user/message' && typeof event.surfaceOp === 'object');
  assert.equal(replacements().length, old.snapshots.length);
  for (const [index, replacement] of replacements().entries()) {
    const original = old.snapshots[index];
    assert.deepEqual(replacement.surfaceOp, {
      op: 'replace',
      startSeq: original.seq,
      endSeq: original.seq,
    });
    assert.deepEqual(replacement.sourceEventSeqs, [
      ...(original.sourceEventSeqs ?? []),
      original.seq,
    ]);
    assert.equal(replacement.data.source.provenance, original.data.source.provenance);
    assert.deepEqual(
      replacement.data.source.sections,
      original.data.source.sections.filter(
        (section) => section.name !== 'working-directory:current',
      ),
    );
  }
  assert.equal((await h.service.stop(old.current)).status, 'stopped');
  await h.close();
  await unchangedPrefix(old.root, old.bytes);
  h = await boot(old.root, new ScriptedAdapter(['continued again']));
  await workingDirectory(h, old.root);
  await h.service.send(
    old.current,
    message('resume-legacy-again', 'Continue explicitly once more.'),
  );
  agent = await idle(h, old.current);
  const { receipts: _newReceipts, ...reopenedIdentity } = h.service.open(old.current).binding;
  const { receipts: _seedReceipts, ...originalIdentity } = old.binding;
  assert.deepEqual(
    reopenedIdentity,
    originalIdentity,
    'explicit sends only extend delivery receipts, not identity or configuration',
  );
  noPrivateDirectory(h.adapter.requests[0], old.root);
  assert.equal(
    replacements().length,
    old.snapshots.length,
    'a new prepare cannot append the same cleanup twice',
  );
  await h.close();
  await unchangedPrefix(old.root, old.bytes);
});

for (const variant of ['undeclared', 'mismatch', 'duplicate-directory', 'duplicate-other']) {
  test(`native task context: ${variant} legacy context rejects the provider before any partial cleanup`, async (t) => {
    const old = await oldSession(t, ['valid', variant]);
    const h = await boot(old.root, new ScriptedAdapter(['MUST_NOT_BE_REQUESTED']));
    t.onTestFinished(() => h.close());
    await workingDirectory(h, old.root);
    const replacements = [];
    t.onTestFinished(
      h.ctx.on(
        'session/event',
        (session, event) => {
          if (
            session.id === old.binding.nativeSessionId &&
            event.type === 'user/message' &&
            typeof event.surfaceOp === 'object'
          )
            replacements.push(event);
        },
        { global: true },
      ),
    );
    await assert.rejects(
      h.service.send(old.current, message(`reject-${variant}`, 'Resume explicitly.')),
      { code: 'unavailable' },
    );
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(
      replacements.length,
      0,
      'validate the entire batch before appending any replacement',
    );
    assert.equal(h.ctx.agents.list().length, 0);
    await h.service.history(old.current);
    await h.close();
    await unchangedPrefix(old.root, old.bytes);
  });
}

for (const interruption of ['revoke', 'stop']) {
  test(`native task context: ${interruption} during asynchronous resume cannot clean history or request a provider`, async (t) => {
    const old = await oldSession(t, ['valid']),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    t.onTestFinished(() => release.resolve());
    const h = await boot(old.root, new ScriptedAdapter(['MUST_NOT_BE_REQUESTED']), async () => {
      entered.resolve();
      await release.promise;
      return { context: 'Fixed permitted task.', toolAllowlist: [] };
    });
    t.onTestFinished(() => h.close());
    await workingDirectory(h, old.root);
    const replacements = [];
    t.onTestFinished(
      h.ctx.on(
        'session/event',
        (session, event) => {
          if (
            session.id === old.binding.nativeSessionId &&
            event.type === 'user/message' &&
            typeof event.surfaceOp === 'object'
          )
            replacements.push(event);
        },
        { global: true },
      ),
    );
    const rejected = assert.rejects(
      h.service.send(old.current, message('revoke-during-resume', 'Resume explicitly.')),
    );
    await entered.promise;
    let stopped;
    if (interruption === 'revoke') old.current.revoke();
    else {
      stopped = h.service.stop(old.current);
      await setImmediate();
    }
    release.resolve();
    await rejected;
    if (stopped) assert.equal((await stopped).status, 'stopped');
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(replacements.length, 0);
    await h.close();
    await unchangedPrefix(old.root, old.bytes);
  });
}
