/** Real Service/DSH JSON/package importer/LLM registry, with explicit member contracts.
 * These metadata tests do not authenticate a real login or run an Agent/model/MCP. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { open, caller, checked } from './execution-service-run-fixture.mjs';
import { businessHashes } from './execution-native-result-service-fixture.mjs';
import { WorkbenchService } from '../dist/workbench-service.js';
import { createHostRunSkillPolicies } from '../dist/host-run-skill-policy.js';
import { createHostRunResourceSource } from '../dist/host-run-resource-source.js';
import { createHostRunConfiguration } from '../dist/host-run-configuration.js';
import { readHostRunModels } from '../dist/host-run-models.js';
import {
  executionReviewCompositionRequest,
  readExecutionReviewComposition,
} from '../dist/execution-review-composition.js';
import { createHostRunSources } from '../dist/host-run-sources.js';
import { executionReviewTarget } from '../dist/execution-review-state.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from '../dist/native-work-session-review-read.js';

const version = '726aa9b3-5a1e-4ca4-988e-0a8bc2f21264';
async function setup(t, { empty = false, mcp = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-host-review-producer-'));
  const f = fixture(),
    packages = new Map();
  let state = f.state;
  const importer = new WorkbenchService(
    {
      read: () => state,
      write: async (value) => {
        state = value;
      },
    },
    { get: () => undefined, put: async () => {} },
    {
      get: (key) => packages.get(key),
      put: async (value) => {
        packages.set(value.versionId, value);
      },
    },
  );
  await importer.command(
    {
      requestId: 'import-review-skill',
      expectedRevision: 0,
      command: {
        type: 'import-package',
        input: {
          versionId: version,
          files: [
            {
              path: 'review/SKILL.md',
              data: Buffer.from(
                '---\nname: review\ndescription: Review fixed content\ndisable-model-invocation: true\n---\nRead the exact target before judging.',
              ).toString('base64'),
            },
          ],
          choices: [
            {
              key: 'review/SKILL.md',
              id: 'review-skill',
              replace: false,
              name: 'Review skill',
              description: 'Independent method',
              role: '',
              capabilities: [],
              available: true,
            },
          ],
        },
      },
    },
    new AbortController().signal,
  );
  const expert = state.participants.find((item) => item.id === 'qa');
  expert.instructions = 'Review independently using only the fixed target.';
  expert.resourceBindings = {
    skillIds: empty ? [] : ['review-skill'],
    mcpIds: mcp ? ['review-mcp'] : [],
  };
  state.tasks[0].participantIds.push('outside');
  state.tasks[0].workflows[0].nodes[0].reviewerIds.push('outside');
  if (mcp)
    state.assets.push({
      id: 'review-mcp',
      name: 'Unqualified connection',
      kind: 'mcp',
      description: '',
      content: 'PRIVATE_CONNECTION_CONFIG',
      available: true,
    });
  state = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: { ...state.tasks[0], status: 'ready' },
  });
  let forwarded;
  const host = await open(root, {
    workbench: state,
    assertReviewConfiguration: (...args) => forwarded.assertReviewConfiguration(...args),
  });
  checked(
    await host.service.submit(caller(), {
      ...host.human('node-1', 'submit-fixed-target'),
      text: 'PRIVATE_FIXED_BODY_ONLY_READER_CAN_RETURN',
      files: [],
      links: [],
    }),
  );
  host.resetCounts();
  const ctx = new Context();
  const h = {
    root,
    packages,
    state,
    host,
    ctx,
    metadata: 0,
    inference: 0,
    workbenchReads: 0,
    packageReads: 0,
    models: ['review-model'],
    hold: undefined,
  };
  const runtime = ctx.plugin(LlmRuntime);
  await runtime;
  const adapter = new (class extends LlmAdapter {
    async listModels(provider) {
      h.metadata++;
      await h.hold?.();
      return h.models.map((id) => ({ provider, id, name: id }));
    }
    async *stream() {
      h.inference++;
      assert.fail('Metadata cannot call a model');
    }
  })();
  ctx.llm.registerAdapter(['contract'], adapter);
  const lifetime = new AbortController();
  const readWorkbench = () => {
    h.workbenchReads++;
    return host.readWorkbench();
  };
  const policyOptions = {
    execution: host.service,
    readWorkbench,
    readPackage: (id) => {
      h.packageReads++;
      return packages.get(id);
    },
    signal: lifetime.signal,
  };
  const policies = createHostRunSkillPolicies(policyOptions);
  const resourceOptions = {
    execution: host.service,
    policies,
    readWorkbench,
    signal: lifetime.signal,
  };
  const resources = createHostRunResourceSource(resourceOptions);
  const configurationOptions = {
    execution: host.service,
    readWorkbench,
    resources,
    signal: lifetime.signal,
  };
  const configuration = createHostRunConfiguration(ctx, configurationOptions);
  forwarded = createHostRunSources(ctx, {
    configuration,
    signal: lifetime.signal,
    directory: {},
    native: {},
  });
  const query = {
    requestId: 'independent-review',
    expectedReviewVersion: 0,
    target: executionReviewTarget(host.read('node-1'), 'north'),
    reviewerRef: { id: 'qa', version: state.appliedPlans[0].id },
  };
  const input = {
    ...query,
    model: { provider: 'contract', model: 'review-model', maxTokens: 3000 },
  };
  t.after(async () => {
    lifetime.abort();
    await runtime.dispose();
    await ctx.fiber.dispose();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  return Object.assign(h, {
    runtime,
    lifetime,
    policies,
    resources,
    configuration,
    query,
    input,
    policyOptions,
    resourceOptions,
    configurationOptions,
  });
}
const assertReview = (h, composition, current) =>
  h.configuration.assertReviewConfiguration(
    current.scope.actorId,
    current.scope.spaceId,
    current.node,
    composition,
  );

test('Host review producers: original metadata and imported reviewer Skill freeze without author tools, state writes or inference', async (t) => {
  const h = await setup(t),
    before = await businessHashes(h.root);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  assert.equal(composition.purpose, 'independent-review');
  assert.equal(composition.payload.scope.actorId, 'chen');
  assert.equal(composition.payload.reviewer.id, 'qa');
  assert.deepEqual(
    composition.payload.resources.skills.map((item) => item.ref.id),
    ['review-skill'],
  );
  assert.equal(composition.payload.resources.skills[0].invocation.modelInvocable, false);
  assert.equal(composition.payload.resources.skills[0].policySource.versionId, version);
  assert.deepEqual(composition.payload.tools, {
    readTarget: describeNativeReviewReadTool(),
    completeReview: describeNativeReviewTool(),
  });
  assert.equal(
    composition.payload.context.includes('PRIVATE_FIXED_BODY_ONLY_READER_CAN_RETURN'),
    false,
  );
  assert.equal(
    composition.payload.resources.skills.some((item) => item.ref.id === 'api-skill'),
    false,
  );
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  assert.equal(assertReview(h, composition, current), undefined);
  assert.deepEqual(await businessHashes(h.root), before);
  assert.deepEqual(h.host.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.host.read('node-1').nativeExecution, undefined);
  assert.equal(h.inference, 0);
});

test('Host review producers: review-only default freezes 16384 while explicit lower, saved review and author budgets remain unchanged', async (t) => {
  const h = await setup(t);
  const before = await businessHashes(h.root);
  const legacy = await h.configuration.prepareReview(h.host.request, {
    ...h.input,
    model: { ...h.input.model, maxTokens: 4096 },
  });
  const original = JSON.stringify(legacy);
  const catalog = await readHostRunModels(h.ctx, h.lifetime.signal);
  assert.equal(catalog.kind, 'ready');
  assert.equal(catalog.items[0].value.maxTokens, 4096);
  const { maxTokens: _authorBudget, ...identity } = catalog.items[0].value;
  const fresh = await h.configuration.prepareReview(h.host.request, {
    ...h.input,
    model: identity,
  });
  const lower = await h.configuration.prepareReview(h.host.request, h.input);
  const freshRequest = executionReviewCompositionRequest(fresh);
  assert.equal(freshRequest.selection.maxTokens, 16_384);
  assert.deepEqual(fresh.payload.model, { ...identity, maxTokens: 16_384 });
  assert.equal(freshRequest.selection.configurationId, fresh.configurationId);
  assert.notEqual(fresh.configurationId, legacy.configurationId);
  assert.notEqual(fresh.configurationId, lower.configurationId);
  assert.equal(lower.payload.model.maxTokens, 3000);
  const restored = readExecutionReviewComposition(JSON.parse(original));
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  assert.equal(assertReview(h, restored, current), undefined);
  assert.equal(executionReviewCompositionRequest(restored).selection.maxTokens, 4096);
  assert.equal(JSON.stringify(restored), original);
  assert.equal(JSON.stringify(legacy), original);
  assert.equal(catalog.items[0].value.maxTokens, 4096);
  const upper = await h.configuration.prepareReview(h.host.request, {
    ...h.input,
    model: { ...identity, maxTokens: 65_536 },
  });
  assert.equal(upper.payload.model.maxTokens, 65_536);
  for (const maxTokens of [0, 65_537, null])
    await assert.rejects(
      h.configuration.prepareReview(h.host.request, {
        ...h.input,
        model: { ...identity, maxTokens },
      }),
      { code: 'run-validation' },
    );
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(h.inference, 0);
});

test('Host review producers: an empty reviewer domain still uses original member preparation; caller authority fields never select configuration', async (t) => {
  const h = await setup(t, { empty: true });
  for (const patch of [
    { actorId: 'chen' },
    { scope: {} },
    { grant: {} },
    { configurationId: 'known' },
    { composition: {} },
    { tools: {} },
  ])
    await assert.rejects(h.configuration.prepareReview(h.host.request, { ...h.input, ...patch }), {
      code: 'run-validation',
    });
  assert.equal(h.metadata, 0);
  await assert.rejects(h.configuration.prepareReview({ headers: {} }, h.input));
  assert.equal(h.metadata, 0);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  assert.deepEqual(composition.payload.resources.skills, []);
  assert.deepEqual(composition.payload.resources.mcp, []);
  assert.equal(h.inference, 0);
});

test('Host review producers: a member revoked during actual registry metadata cannot publish a configuration', async (t) => {
  const h = await setup(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = h.configuration.prepareReview(h.host.request, h.input);
  await entered.promise;
  h.host.member.abort();
  release.resolve();
  await assert.rejects(pending);
  assert.deepEqual(h.host.counters, { global: 0, nodes: 0, plans: 0 });
  assert.equal(h.inference, 0);
});

test('Host review producers: each synchronous configuration assertion reads one fresh snapshot and package, including after an await', async (t) => {
  const h = await setup(t);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  h.workbenchReads = h.packageReads = 0;
  assert.equal(assertReview(h, composition, current), undefined);
  assert.deepEqual([h.workbenchReads, h.packageReads], [1, 1]);

  await Promise.resolve();
  assert.equal(assertReview(h, composition, current), undefined);
  assert.deepEqual([h.workbenchReads, h.packageReads], [2, 2]);
  const tampered = structuredClone(composition);
  tampered.payload.model.maxTokens++;
  assert.throws(() => assertReview(h, tampered, current));

  const original = h.packages.get(version);
  await Promise.resolve();
  h.packages.set(version, { ...original, digest: '0'.repeat(64) });
  assert.throws(() => assertReview(h, composition, current));
  h.packages.set(version, original);
  assert.equal(assertReview(h, composition, current), undefined);

  const readWorkbench = h.configurationOptions.readWorkbench;
  h.configurationOptions.readWorkbench = () => current.applied;
  assert.throws(() => assertReview(h, composition, current));
  h.configurationOptions.readWorkbench = readWorkbench;
  assert.equal(assertReview(h, composition, current), undefined);
  h.lifetime.abort();
  assert.throws(() => assertReview(h, composition, current));
  assert.equal(h.inference, 0);
});

test('Host review producers: same-call plan sharing never supplies the continuing policy assertion after an await', async (t) => {
  const h = await setup(t);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  const policy = h.policies.review(current, current.applied);
  assert.equal(policy.assertCurrent(), undefined);
  await Promise.resolve();
  h.host.setWorkbench((state) => {
    state.appliedPlans[0].participants.find((item) => item.id === 'qa').instructions +=
      ' Changed fixed reviewer instructions.';
    return state;
  });
  assert.throws(() => policy.assertCurrent());
  assert.throws(() => assertReview(h, composition, current));
  assert.equal(h.inference, 0);
});

test('Host review producers: absent model, replaced producer and owner cancellation fail closed', async (t) => {
  const h = await setup(t);
  h.models = [];
  await assert.rejects(h.configuration.prepareReview(h.host.request, h.input));
  h.models = ['review-model'];
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  const original = h.resourceOptions.policies.review;
  h.resourceOptions.policies.review = () => ({ policies: [], assertCurrent() {} });
  assert.throws(() => assertReview(h, composition, current));
  h.resourceOptions.policies.review = original;
  h.lifetime.abort();
  assert.throws(() => assertReview(h, composition, current));
  assert.equal(h.inference, 0);
});

test('Host review producers: frozen missing assets and an unqualified reviewer MCP never fall back to live definitions', async (t) => {
  const h = await setup(t);
  h.host.setWorkbench((state) => {
    state.appliedPlans[0].assets = state.appliedPlans[0].assets.filter(
      (item) => item.id !== 'review-skill',
    );
    return state;
  });
  await assert.rejects(h.configuration.prepareReview(h.host.request, h.input));
  const mcp = await setup(t, { mcp: true });
  await assert.rejects(mcp.configuration.prepareReview(mcp.host.request, mcp.input));
  assert.equal(h.inference + mcp.inference, 0);
});

test('Host review producers: package replacement invalidates a qualification and release invalidates only that metadata operation', async (t) => {
  const h = await setup(t);
  const qualification = await h.resources.prepareReviewResourceCatalog(h.host.request, h.query);
  assert.equal(qualification.assertCurrent(), undefined);
  qualification.release();
  assert.throws(() => qualification.assertCurrent());
  const fresh = await h.resources.prepareReviewResourceCatalog(h.host.request, h.query);
  const original = h.packages.get(version);
  h.packages.set(version, { ...original, digest: '0'.repeat(64) });
  assert.throws(() => fresh.assertCurrent());
  h.packages.set(version, original);
  assert.equal(h.resources.signal.aborted, false);
  assert.equal(h.inference, 0);
});

test('Host review producers: same target comments do not change configuration; a closed round or tampered target cannot reuse it', async (t) => {
  const h = await setup(t);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  checked(
    await h.host.service.ballot(caller('outside'), {
      ...h.host.human('node-1', 'comment-only'),
      roundId: h.query.target.roundId,
      artifactVersionId: h.query.target.artifactVersionId,
      action: 'comment',
      comment: 'A nondeciding comment',
    }),
  );
  const current = checked(
    await h.host.service.readExpertReviewPreparation(h.host.request, h.query),
  );
  assert.equal(assertReview(h, composition, current), undefined);
  const changed = structuredClone(current);
  changed.node.artifactVersions[0].text = 'Changed target bytes';
  assert.throws(() => assertReview(h, composition, changed));
  assert.throws(() =>
    h.configuration.assertReviewConfiguration('outside', 'north', current.node, composition),
  );
  assert.throws(() =>
    h.configuration.assertReviewConfiguration('chen', 'foreign', current.node, composition),
  );
  const tampered = structuredClone(composition);
  tampered.payload.model.model = 'another-model';
  assert.throws(() => assertReview(h, tampered, current));
  checked(
    await h.host.service.ballot(caller('outside'), {
      ...h.host.human('node-1', 'approved'),
      roundId: h.query.target.roundId,
      artifactVersionId: h.query.target.artifactVersionId,
      action: 'request-changes',
      comment: 'Revise the fixed target before another round.',
    }),
  );
  assert.throws(() => assertReview(h, composition, current));
});

test('Host review producers: the original Service adopts the exact synchronous Host port only as requested/reserved/held metadata', async (t) => {
  const h = await setup(t);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  const prepared = checked(
    await h.host.service.prepareExpertReview(h.host.request, {
      ...h.query,
      configurationId: composition.configurationId,
    }),
  );
  const command = {
    ...h.host.locate('node-1'),
    spaceId: 'north',
    runId: prepared.attempt.scope.runId,
    expectedAttemptVersion: prepared.attempt.version,
    composition,
  };
  const admitted = checked(await h.host.service.admitExpertReview(h.host.request, command));
  assert.equal(admitted.attempt.status, 'requested');
  assert.equal(admitted.attempt.dispatch, 'reserved');
  assert.equal(admitted.attempt.resources, 'held');
  const before = await businessHashes(h.root);
  const replay = checked(await h.host.service.admitExpertReview(h.host.request, command));
  assert.equal(replay.disposition, 'replayed');
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(h.host.read('node-1').rounds[0].ballots.length, 0);
  assert.equal(h.inference, 0);
});

// Actual D drive and persisted admitted composition; the NativeWorkGrant below
// is an explicit contract. SDK purpose identity is verified by separate Host proof.
async function admittedResources(t, options) {
  const h = await setup(t, options);
  const composition = await h.configuration.prepareReview(h.host.request, h.input);
  const { attempt } = checked(
    await h.host.service.prepareExpertReview(h.host.request, {
      ...h.query,
      configurationId: composition.configurationId,
    }),
  );
  const locator = { ...h.host.locate('node-1'), spaceId: 'north', runId: attempt.scope.runId };
  checked(
    await h.host.service.admitExpertReview(h.host.request, {
      ...locator,
      expectedAttemptVersion: attempt.version,
      composition,
    }),
  );
  const drive = checked(await h.host.service.openExpertReviewDrive(h.host.request, locator));
  t.after(() => drive.dispose());
  const { review: _review, ...scope } = drive.grant.scope;
  const binding = {
    scope,
    nativeSessionId: 'review-contract',
    nativeAgentId: 'review-contract',
    selection: drive.grant.selection,
  };
  const grant = Object.freeze({
    scope,
    signal: drive.grant.signal,
    assertCurrent: (action) => h.host.service.assertExpertReviewDriveGrant(drive.grant, action),
  });
  return { ...h, composition, drive, binding, grant };
}

test('Host review adoption source: admitted original drive keeps imported reviewer Skill and invocation policy without inference or writes', async (t) => {
  const h = await admittedResources(t);
  const before = await businessHashes(h.root);
  const producer = h.resources.reviewProducer(h.composition, h.binding, h.grant, h.drive.grant);
  assert.equal(producer.assertCurrent(), undefined);
  assert.equal(h.composition.payload.resources.skills[0].invocation.modelInvocable, false);
  assert.equal(h.composition.payload.resources.skills[0].policySource.kind, 'asset-package');
  assert.deepEqual(await businessHashes(h.root), before);
  assert.equal(h.inference, 0);
  await assert.rejects(producer.openMcp({}, new AbortController().signal));
});

test('Host review adoption source: a copied D drive, wrong native purpose scope or selection is refused', async (t) => {
  const h = await admittedResources(t);
  assert.throws(() =>
    h.resources.reviewProducer(h.composition, h.binding, h.grant, { ...h.drive.grant }),
  );
  assert.throws(() =>
    h.resources.reviewProducer(
      h.composition,
      {
        ...h.binding,
        scope: { ...h.binding.scope, runId: 'author-run' },
      },
      h.grant,
      h.drive.grant,
    ),
  );
  assert.throws(() =>
    h.resources.reviewProducer(
      h.composition,
      {
        ...h.binding,
        selection: { ...h.binding.selection, configurationId: 'author-composition' },
      },
      h.grant,
      h.drive.grant,
    ),
  );
  assert.equal(h.inference, 0);
});

test('Host review adoption source: live package mutation and missing original admitted attempt revoke usage', async (t) => {
  const h = await admittedResources(t);
  const producer = h.resources.reviewProducer(h.composition, h.binding, h.grant, h.drive.grant);
  const raw = h.packages.get(version);
  h.packages.set(version, { ...raw, digest: '0'.repeat(64) });
  assert.throws(() => producer.assertCurrent());
  assert.equal(h.drive.grant.signal.aborted, true, 'restoring bytes cannot revive the old drive');
  const h2 = await admittedResources(t);
  const producer2 = h2.resources.reviewProducer(
    h2.composition,
    h2.binding,
    h2.grant,
    h2.drive.grant,
  );
  const read = h2.host.service.readRunNode;
  h2.host.service.readRunNode = () => undefined;
  assert.throws(() => producer2.assertCurrent());
  h2.host.service.readRunNode = read;
});

test('Host review adoption source: expiry or Host close removes live rights without a preparation signal being borrowed', async (t) => {
  const h = await admittedResources(t, { empty: true });
  const producer = h.resources.reviewProducer(h.composition, h.binding, h.grant, h.drive.grant);
  assert.equal(producer.signal.aborted, false);
  assert.deepEqual(h.composition.payload.resources.skills, []);
  h.lifetime.abort();
  assert.equal(producer.signal.aborted, true);
  assert.throws(() => producer.assertCurrent());
});
