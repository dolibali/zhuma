/** Fixed patched source SDK, actual Agent/Skill/MCP HTTP. Run/Host producers and
 * model responses are explicit contracts, not member login or product UI proof.
 * The SDK qualification runner supplies these two generated fixture modules.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { startHttpMcpFixture } from './zhuma-run-resource-http.js';
import {
  boot,
  grant,
  ScriptedAdapter,
  compositionFacts,
  registerExecutionRunResources,
  describeExecutionResourceTool,
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
  describeAcceptedInputTool,
  acceptedFileDescriptor,
  resultIntentDescriptor,
} from './zhuma-run-resources-bundle.js';

async function setup(
  t,
  {
    mcp = true,
    wrongSchema = false,
    wrongVersion = false,
    asyncSource = false,
    holdLease = false,
    parentGlobal = true,
    empty = false,
    invocation,
    surface,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-run-resources-'));
  const fixture = await startHttpMcpFixture();
  const closeFixture = fixture.close;
  let fixtureClosing;
  fixture.close = () => (fixtureClosing ??= closeFixture());
  const privateCanary = 'SYNTHETIC_PRIVATE_CONNECTION_CANARY';
  const config = {
    transport: 'streamable-http',
    serverName: 'docs',
    url: fixture.url,
    headers: { authorization: privateCanary },
    toolCallTimeoutMs: 5000,
    failOnStartupError: true,
    reconnect: { enabled: false },
  };
  const qualifier = new Context();
  let h;
  t.onTestFinished(async () => {
    await qualifier.fiber.dispose();
    await h?.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  await qualifier.plugin(Prompt);
  await qualifier.plugin(Tools, { mode: 'native' });
  // Explicit HOST catalog qualification, separate from begin/compose. No invented schema.
  let descriptor;
  if (mcp) {
    await qualifier.plugin(Mcp, config);
    descriptor = describeExecutionResourceTool(qualifier.tools.get('mcp__docs__ping'));
    assert(qualifier.tools.get('mcp__docs__hidden'), 'the peer really has an unselected tool');
  }
  await qualifier.fiber.dispose();
  const facts = compositionFacts({ upstream: surface === 'reader' || surface?.includes('file') }),
    plan = facts.workbench.appliedPlans[0];
  const independentDescriptors = [];
  if (surface === 'reader' || surface?.includes('file')) {
    const definition = describeAcceptedInputTool();
    facts.tools = { kind: 'accepted-input-reader', definition };
    independentDescriptors.push(definition);
  }
  if (surface?.includes('file')) {
    facts.acceptedFileReader = acceptedFileDescriptor;
    independentDescriptors.push(acceptedFileDescriptor);
  }
  if (surface?.includes('result')) {
    facts.resultIntentTool = resultIntentDescriptor;
    independentDescriptors.push(resultIntentDescriptor);
  }
  const node = plan.task.workflows[0].nodes.find((item) => item.id === facts.node.nodeId);
  plan.assets = [
    {
      id: 'selected-skill',
      name: 'Selected Skill',
      kind: 'skill',
      description: 'Selected routing',
      content: 'SELECTED_FROZEN_SKILL_BODY',
      available: true,
    },
    {
      id: 'other-skill',
      name: 'Other Skill',
      kind: 'skill',
      description: 'Unselected routing',
      content: 'UNSELECTED_SKILL_BODY',
      available: true,
    },
    {
      id: 'docs-mcp',
      name: 'Docs server',
      kind: 'mcp',
      description: 'Explicit Host connection',
      content: 'PRIVATE_ASSET_CONFIG_MUST_NOT_EXECUTE',
      available: true,
    },
  ];
  node.skillIds = empty ? [] : ['selected-skill'];
  facts.node.handoff.skillRefs = empty ? [] : [{ id: 'selected-skill', version: plan.id }];
  node.mcpIds = mcp ? ['docs-mcp'] : [];
  facts.node.handoff.mcpRefs = mcp ? [{ id: 'docs-mcp', version: plan.id }] : [];
  facts.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: mcp
      ? [
          {
            ref: { id: 'docs-mcp', version: plan.id },
            definitionDigest: executionResourceDigest(plan.assets[2]),
            connectionRef: { id: 'configured-docs', version: 'qualified-1' },
            serverName: 'docs',
            tools: [
              wrongSchema ? { ...descriptor, description: 'WRONG_FROZEN_SCHEMA' } : descriptor,
            ],
          },
        ]
      : [],
  };
  if (invocation)
    plan.assets[0].origin = {
      versionId: '12345678-1234-4234-9234-123456789abc',
      format: 'agent-skill',
      entryPath: 'selected-skill/SKILL.md',
      filePaths: ['selected-skill/SKILL.md'],
      totalBytes: 100,
      missing: [],
    };
  if (invocation)
    facts.resourceCatalog.skills = [
      {
        ref: facts.node.handoff.skillRefs[0],
        definitionDigest: executionResourceDigest(plan.assets[0]),
        invocation,
        policySource: {
          kind: 'asset-package',
          versionId: plan.assets[0].origin.versionId,
          digest: executionResourceDigest('contract-original-package'),
          entryPath: plan.assets[0].origin.entryPath,
        },
      },
    ];
  const snapshot = freezeExecutionRunComposition(facts),
    projection = executionRunCompositionRequest(snapshot);
  const authority = grant(facts.scope),
    source = new AbortController();
  const leaseEntered = Promise.withResolvers<void>(),
    leaseRelease = Promise.withResolvers<void>();
  let adopted,
    agentContext,
    released = 0,
    opened = 0,
    allowed = true;
  const formations = [];
  const producer = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    signal: source.signal,
    assertCurrent(saved, binding, current) {
      if (asyncSource) return Promise.reject(Error('PRIVATE_ASYNC_SOURCE'));
      assert.deepEqual(saved, snapshot);
      assert.equal(current, authority);
      assert.equal(allowed, true);
      assert.equal(binding.selection.configurationId, snapshot.configurationId);
      return undefined;
    },
    async openMcp(resource, signal) {
      signal.throwIfAborted();
      opened++;
      leaseEntered.resolve();
      if (holdLease) await leaseRelease.promise;
      assert.equal(resource.connectionRef.id, 'configured-docs');
      return {
        connectionRef: {
          id: 'configured-docs',
          version: wrongVersion ? 'different-version' : 'qualified-1',
        },
        signal: source.signal,
        config,
        assertCurrent() {
          assert.equal(allowed, true);
          source.signal.throwIfAborted();
          return undefined;
        },
        release() {
          released++;
        },
      };
    },
  };
  h = await boot(
    root,
    new ScriptedAdapter(['READY', 'EXPLICIT', 'BOUNDARY']),
    async (ctx, binding, current) => {
      agentContext = ctx;
      ctx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        formations.push(decision.messages ?? []);
        return decision;
      });
      // Surface-only contracts for independent C tools: real SDK registrations
      // use their exact declarations, but do not claim file IO/result authority.
      for (const definition of independentDescriptors)
        ctx.tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: { schema: definition.outputSchema, render: () => [] },
          async execute() {
            assert.fail('surface-only contract must not execute an independent C tool');
          },
        });
      adopted = await registerExecutionRunResources(ctx, snapshot, binding, current, producer);
      assert.deepEqual(
        [...adopted.toolAllowlist].sort(),
        snapshot.payload.toolAllowlist
          .filter((name) => name === 'skill' || name.startsWith('mcp__'))
          .sort(),
      );
      return {
        context: snapshot.payload.context,
        toolAllowlist: snapshot.payload.toolAllowlist,
      };
    },
  );
  await h.ctx.plugin(FsLocal, { cwd: root });
  await h.ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await h.ctx.plugin(Skills);
  h.ctx.skills.register({
    name: 'parent-private-skill',
    description: 'Parent global routing',
    content: 'PARENT_PRIVATE_BODY',
    source: 'contract',
  });
  if (parentGlobal) await h.ctx.plugin(ToolSkill);
  const sibling = createScope(h.ctx, {});
  await sibling.ctx.fiber;
  await sibling.ctx.plugin(ToolSkill);
  sibling.ctx.get('skills').register({
    name: 'sibling-skill',
    description: 'Other scope routing',
    content: 'SIBLING_PRIVATE_BODY',
    source: 'contract',
  });
  const start = async () => {
    await h.service.send(authority, {
      requestId: 'first',
      text: projection.firstMessage.text,
      mode: 'followup',
      selection: projection.selection,
    });
    const binding = h.service.open(authority).binding;
    const agent = h.ctx.agents.get(binding.nativeSessionId);
    assert(agent);
    await agent.whenIdle();
    assert.deepEqual(
      h.ctx.tools
        .schemas(agent)
        .map((tool) => tool.name)
        .sort(),
      [...snapshot.payload.toolAllowlist].sort(),
    );
    assert.deepEqual(
      (h.adapter.requests[0].tools ?? []).map((tool) => tool.name).sort(),
      [...snapshot.payload.toolAllowlist].sort(),
    );
    return agent;
  };
  let callId = 0;
  return {
    h,
    snapshot,
    formations,
    source,
    fixture,
    privateCanary,
    start,
    authority,
    leaseGate: { entered: leaseEntered.promise, release: () => leaseRelease.resolve() },
    revoke() {
      allowed = false;
      source.abort();
    },
    get adopted() {
      return adopted;
    },
    get agentContext() {
      return agentContext;
    },
    get released() {
      return released;
    },
    get opened() {
      return opened;
    },
    call(agent, name, args) {
      return agentContext.tools.execute({
        callId: `resource-${++callId}`,
        name,
        arguments: args,
        agent,
        signal: new AbortController().signal,
      });
    },
  };
}
test('actual resources SDK: a non-undefined public binding result refuses before Agent execution', async (t) => {
  const fault = vi
    .spyOn(
      ToolSkill as unknown as { bindSkillRegistry(...args: unknown[]): unknown },
      'bindSkillRegistry',
    )
    .mockReturnValue(false);
  try {
    const f = await setup(t, { mcp: false, empty: true });
    await assert.rejects(f.start);
    assert.equal(f.adopted, undefined);
    assert.equal(f.h.adapter.requests.length, 0);
  } finally {
    fault.mockRestore();
  }
});

test('actual resources SDK: an asynchronous public binding result refuses and drains its true completion', async (t) => {
  const entered = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<void>();
  const fault = vi
    .spyOn(
      ToolSkill as unknown as { bindSkillRegistry(...args: unknown[]): unknown },
      'bindSkillRegistry',
    )
    .mockImplementation(() => {
      entered.resolve();
      return finished.promise;
    });
  let starting;
  try {
    const f = await setup(t, { mcp: false, empty: true });
    starting = f.start();
    void starting.catch(() => undefined);
    await entered.promise;
    assert.equal(f.h.adapter.requests.length, 0);
    let settled = false;
    void starting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finished.resolve();
    await assert.rejects(starting);
    assert.equal(f.adopted, undefined);
    assert.equal(f.h.adapter.requests.length, 0);
  } finally {
    finished.resolve();
    await starting?.catch(() => undefined);
    fault.mockRestore();
  }
});

test('actual resources SDK: isolated official skill catalog and loader expose exactly one of two plan skills', async (t) => {
  const f = await setup(t, { mcp: false }),
    agent = await f.start();
  assert.equal(f.h.adapter.requests.length, 1);
  const request = JSON.stringify(f.h.adapter.requests[0]);
  assert(request.includes('selected-skill'));
  for (const text of [
    'SELECTED_FROZEN_SKILL_BODY',
    'other-skill',
    'UNSELECTED_SKILL_BODY',
    'parent-private-skill',
    'PARENT_PRIVATE_BODY',
    'sibling-skill',
    'SIBLING_PRIVATE_BODY',
  ])
    assert(!request.includes(text), text);
  const load = await f.call(agent, 'skill', { name: 'selected-skill' });
  assert.equal(load.isError, false, JSON.stringify(load));
  assert(JSON.stringify(load).includes('SELECTED_FROZEN_SKILL_BODY'));
  for (const name of ['other-skill', 'parent-private-skill', 'sibling-skill']) {
    const hidden = await f.call(agent, 'skill', { name });
    assert.equal(hidden.isError, true);
    assert(!JSON.stringify(hidden).includes('PRIVATE_BODY'));
  }
  assert.equal(f.opened, 0, 'virtual Skill loading does not connect a server');
  assert.equal(f.h.ctx.skills.get === undefined, false);
  const events = agent.session.snapshotEvents().filter((event) => event.type === 'user/message');
  assert(events.some((event) => event.data.source.kind === 'skill-catalog'));
  await f.h.service.send(f.authority, {
    requestId: 'explicit-skill',
    text: '/selected-skill\nApply the selected method.',
    mode: 'followup',
    selection: executionRunCompositionRequest(f.snapshot).selection,
  });
  await agent.whenIdle();
  assert.equal(f.h.adapter.requests.length, 2);
  assert(
    f.formations
      .flat()
      .some(
        (message) =>
          message.source?.kind === 'skill-invocation' &&
          message.source.name === 'selected-skill' &&
          message.source.form === 'instructions',
      ),
  );
  assert(JSON.stringify(f.h.adapter.requests[1]).includes('SELECTED_FROZEN_SKILL_BODY'));
  assert(!JSON.stringify(f.h.adapter.requests[1]).includes('SIBLING_PRIVATE_BODY'));
  await f.h.service.send(f.authority, {
    requestId: 'unselected-explicit',
    text: '/parent-private-skill\nTry an unselected method.',
    mode: 'followup',
    selection: executionRunCompositionRequest(f.snapshot).selection,
  });
  await agent.whenIdle();
  assert(!JSON.stringify(f.h.adapter.requests[2]).includes('PARENT_PRIVATE_BODY'));
  await f.adopted.dispose();
  await f.adopted.drain();
});
test('actual resources SDK: official MCP true list/call, exact selected schema and no private config in Run or output', async (t) => {
  const f = await setup(t),
    agent = await f.start();
  const names = f.h.adapter.requests[0].tools.map((tool) => tool.name);
  assert(names.includes('skill'));
  assert(names.includes('mcp__docs__ping'));
  assert(!names.includes('mcp__docs__hidden'));
  assert(JSON.stringify(f.h.adapter.requests[0]).includes('SELECTED_SERVER_INSTRUCTIONS'));
  assert(!JSON.stringify(f.snapshot).includes(f.privateCanary));
  assert(!JSON.stringify(f.snapshot).includes('PRIVATE_ASSET_CONFIG'));
  const result = await f.call(agent, 'mcp__docs__ping', {});
  assert.equal(result.isError, false, JSON.stringify(result));
  assert(JSON.stringify(result).includes('pong'));
  assert.deepEqual(f.fixture.calls, ['ping']);
  const hidden = await f.call(agent, 'mcp__docs__hidden', {});
  assert.equal(hidden.isError, true);
  assert.deepEqual(f.fixture.calls, ['ping']);
  assert(!JSON.stringify(result).includes(f.privateCanary));
  assert(f.fixture.authorization.some((value) => value === f.privateCanary));
  const closing = f.adopted.dispose();
  assert.equal(f.adopted.dispose(), closing);
  await closing;
  assert.equal(f.released, 1);
});
for (const option of ['wrongSchema', 'wrongVersion'])
  test(`actual resources SDK: ${option} refuses before Agent publication`, async (t) => {
    const f = await setup(t, { [option]: true });
    await assert.rejects(f.start());
    assert.equal(f.h.ctx.agents.list().length, 0);
    assert.equal(f.h.adapter.requests.length, 0);
    assert.deepEqual(f.fixture.calls, []);
    assert.equal(f.released, 1);
  });
test('actual resources SDK: source revocation disposes selected real capabilities and drains once', async (t) => {
  const f = await setup(t),
    agent = await f.start();
  f.revoke();
  await f.adopted.drain();
  assert.equal(f.adopted.signal.aborted, true);
  assert.equal(f.released, 1);
  const denied = await f.call(agent, 'mcp__docs__ping', {});
  assert.equal(denied.isError, true);
  assert.deepEqual(f.fixture.calls, []);
});
test('actual resources SDK: an asynchronous authority assertion refuses before publication', async (t) => {
  const f = await setup(t, { mcp: false, asyncSource: true });
  await assert.rejects(f.start());
  assert.equal(f.h.adapter.requests.length, 0);
  assert.equal(f.h.ctx.agents.list().length, 0);
  assert.equal(f.opened, 0);
});
test('actual resources SDK: server disconnect cannot dispatch another real tool or expose connection details', async (t) => {
  const f = await setup(t),
    agent = await f.start();
  await f.fixture.close();
  const result = await f.call(agent, 'mcp__docs__ping', {});
  assert.equal(result.isError, true);
  assert(!JSON.stringify(result).includes(f.privateCanary));
  assert.deepEqual(f.fixture.calls, []);
  await f.adopted.drain();
  assert.equal(f.released, 1);
});
test('actual resources SDK: revoke during a real HTTP initialize wait closes unpublished activation before peer release', async (t) => {
  const f = await setup(t);
  const gate = f.fixture.holdNext();
  const starting = f.start();
  try {
    await gate.entered;
    f.revoke();
    let timer;
    try {
      await Promise.race([
        assert.rejects(starting),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Cancellation did not close actual SDK startup before release')),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(f.h.ctx.agents.list().length, 0);
    assert.equal(f.h.adapter.requests.length, 0);
    assert.equal(f.released, 1);
  } finally {
    gate.release();
    await Promise.allSettled([starting]);
  }
});
test('actual resources SDK: final close owns a late Host lease and releases it after actual source completion', async (t) => {
  const f = await setup(t, { holdLease: true }),
    starting = f.start();
  await f.leaseGate.entered;
  f.revoke();
  let closed = false;
  const closing = f.h.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.equal(f.released, 0);
  } finally {
    f.leaseGate.release();
  }
  await assert.rejects(starting);
  await closing;
  assert.equal(f.released, 1);
  assert.equal(f.h.adapter.requests.length, 0);
  assert.deepEqual(f.fixture.calls, []);
});

for (const parentGlobal of [true, false])
  test(`actual resources SDK: ${parentGlobal ? 'global-first' : 'local-first'} official loaders keep the actual Run owner`, async (t) => {
    const f = await setup(t, { mcp: false, parentGlobal }),
      agent = await f.start();
    if (!parentGlobal) await f.h.ctx.plugin(ToolSkill);
    const selected = await f.call(agent, 'skill', { name: 'selected-skill' });
    assert.equal(selected.isError, false);
    assert(JSON.stringify(selected).includes('SELECTED_FROZEN_SKILL_BODY'));
    await f.h.service.send(f.authority, {
      requestId: 'normal-profile-unselected',
      text: '/parent-private-skill\nThis is not selected for this Run.',
      mode: 'followup',
      selection: executionRunCompositionRequest(f.snapshot).selection,
    });
    await agent.whenIdle();
    assert.equal(f.h.adapter.requests.length, 2);
    assert(!JSON.stringify(f.h.adapter.requests).includes('PARENT_PRIVATE_BODY'));
    assert.equal(f.adopted.signal.aborted, false);
    const catalog = f.formations
      .flat()
      .flatMap((message) =>
        message.source?.kind === 'skill-catalog' ? message.source.entries : [],
      );
    assert(catalog.some((entry) => entry.name === 'selected-skill'));
    assert(!catalog.some((entry) => entry.name === 'parent-private-skill'));
  });
test('actual resources SDK: late global ToolSkill and disposed resources never fall back to parent private loading', async (t) => {
  const f = await setup(t, { mcp: false, parentGlobal: false }),
    agent = await f.start();
  await f.h.ctx.plugin(ToolSkill);
  const denied = await f.call(agent, 'skill', { name: 'parent-private-skill' });
  assert.equal(denied.isError, true);
  assert.equal(f.adopted.signal.aborted, false);
  await f.adopted.drain();
  assert.equal(f.adopted.signal.aborted, true);
  await f.h.service.send(f.authority, {
    requestId: 'after-dispose',
    text: '/parent-private-skill\nTry a removed capability.',
    mode: 'followup',
    selection: executionRunCompositionRequest(f.snapshot).selection,
  });
  await agent.whenIdle();
  assert.equal(f.h.adapter.requests.length, 1);
});

for (const mcp of [false, true])
  test(`actual resources SDK: ${mcp ? 'MCP-only' : 'legacy schema1 empty'} has an actual empty isolated Skill domain`, async (t) => {
    const f = await setup(t, { mcp, empty: true }),
      agent = await f.start();
    assert.equal(f.snapshot.schemaVersion, mcp ? 2 : 1);
    const request = JSON.stringify(f.h.adapter.requests[0]);
    assert(!request.includes('parent-private-skill'));
    assert(!request.includes('PARENT_PRIVATE_BODY'));
    for (const name of ['selected-skill', 'parent-private-skill', 'sibling-skill']) {
      const result = await f.call(agent, 'skill', { name });
      assert.equal(result.isError, true);
      assert(!JSON.stringify(result).includes('PRIVATE_BODY'));
    }
    if (mcp) {
      const result = await f.call(agent, 'mcp__docs__ping', {});
      assert.equal(result.isError, false);
      assert.deepEqual(f.fixture.calls, ['ping']);
    }
    await f.h.service.send(f.authority, {
      requestId: 'empty-explicit',
      text: '/parent-private-skill\nAn unselected parent method must not load.',
      mode: 'followup',
      selection: executionRunCompositionRequest(f.snapshot).selection,
    });
    await agent.whenIdle();
    assert(!JSON.stringify(f.h.adapter.requests).includes('PARENT_PRIVATE_BODY'));
  });
for (const surface of ['legacy', 'reader', 'file', 'result', 'file-result'])
  for (const parentGlobal of [true, false])
    test(`actual resources SDK: exact frozen ${surface} surface with ${parentGlobal ? 'existing' : 'late'} global loader`, async (t) => {
      const f = await setup(t, { mcp: false, empty: true, surface, parentGlobal }),
        agent = await f.start();
      assert.deepEqual(f.adopted.toolAllowlist, []);
      assert(!f.snapshot.payload.toolAllowlist.includes('skill'));
      assert.equal(f.opened, 0);
      if (!parentGlobal) await f.h.ctx.plugin(ToolSkill);
      for (const name of ['parent-private-skill', 'sibling-skill']) {
        const denied = await f.call(agent, 'skill', { name });
        assert.equal(denied.isError, true);
      }
      await f.h.service.send(f.authority, {
        requestId: 'surface-explicit',
        text: '/parent-private-skill\nNo resource was selected for this Run.',
        mode: 'followup',
        selection: executionRunCompositionRequest(f.snapshot).selection,
      });
      await agent.whenIdle();
      assert.equal(f.h.adapter.requests.length, 2);
      assert(!JSON.stringify(f.h.adapter.requests).includes('PARENT_PRIVATE_BODY'));
      assert.deepEqual(
        f.h.ctx.tools
          .schemas(agent)
          .map((tool) => tool.name)
          .sort(),
        [...f.snapshot.payload.toolAllowlist].sort(),
      );
      assert(!f.formations.flat().some((message) => message.source?.kind === 'skill-invocation'));
    });
for (const [name, modelInvocable, userInvocable] of [
  ['user-only', false, true],
  ['model-only', true, false],
  ['neither', false, false],
])
  test(`actual resources SDK: ${name} policy follows official load and user provenance`, async (t) => {
    const f = await setup(t, {
        mcp: false,
        invocation: { modelInvocable, userInvocable },
      }),
      agent = await f.start();
    const catalog = f.formations
      .flat()
      .flatMap((message) =>
        message.source?.kind === 'skill-catalog' ? message.source.entries : [],
      );
    assert.equal(
      catalog.some((item) => item.name === 'selected-skill'),
      modelInvocable,
    );
    const result = await f.call(agent, 'skill', { name: 'selected-skill' });
    assert.equal(result.isError, !modelInvocable);
    await f.h.service.send(f.authority, {
      requestId: 'policy-explicit',
      text: '/selected-skill\nExplicit user method.',
      mode: 'followup',
      selection: executionRunCompositionRequest(f.snapshot).selection,
    });
    await agent.whenIdle();
    assert.equal(
      f.formations
        .flat()
        .some(
          (message) =>
            message.source?.kind === 'skill-invocation' && message.source.name === 'selected-skill',
        ),
      userInvocable,
    );
  });

test('actual resources SDK: replacing the scoped loader cannot dispatch a foreign same-name handler', async (t) => {
  const f = await setup(t, { mcp: false }),
    agent = await f.start();
  const original = f.agentContext.tools.get('skill', agent);
  const loader = [...f.agentContext.registry.get(ToolSkill).fibers].find(
    (fiber) => scopeOf(fiber.ctx) === agent,
  );
  assert(loader);
  await loader.dispose();
  let executed = 0;
  const remove = f.agentContext.tools.register({
    ...original,
    execute() {
      executed++;
      return { content: [{ type: 'text', text: 'FOREIGN_SAME_NAME_BODY' }] };
    },
  });
  t.onTestFinished(remove);
  const result = await f.call(agent, 'skill', { name: 'selected-skill' });
  assert.equal(result.isError, true);
  assert.equal(executed, 0);
  assert(!JSON.stringify(result).includes('FOREIGN_SAME_NAME_BODY'));
  assert.equal(f.adopted.signal.aborted, true);
  await f.adopted.drain();
});

test('actual resources SDK: a closed controlled Run does not suppress another ordinary Agent global Skill use', async (t) => {
  const f = await setup(t, { mcp: false });
  await f.start();
  await f.adopted.dispose();
  const ordinary = await f.h.ctx.agents.create({
    sessionId: SessionId('ordinary-resource-scope'),
    agentOptions: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
  });
  t.onTestFinished(() => ordinary.dispose());
  ordinary.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: '/parent-private-skill\nUse my ordinary personal Skill.' }],
      source: { kind: 'user' },
    }),
  );
  await ordinary.agent.whenIdle();
  assert.equal(f.h.adapter.requests.length, 2);
  assert(JSON.stringify(f.h.adapter.requests[1]).includes('PARENT_PRIVATE_BODY'));
  assert(!JSON.stringify(f.h.adapter.requests[1]).includes('SELECTED_FROZEN_SKILL_BODY'));
  assert(
    ordinary.agent.session
      .snapshotEvents()
      .some(
        (event) =>
          event.type === 'user/message' &&
          event.data.source.kind === 'skill-invocation' &&
          event.data.source.name === 'parent-private-skill',
      ),
  );
});
