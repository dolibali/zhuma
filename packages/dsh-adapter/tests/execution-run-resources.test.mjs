/** Qualified Host catalogs below are synthetic contracts; actual SDK proof is separate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freezeExecutionRunComposition,
  readExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
  executionResourceToolNames,
  readExecutionRunResources,
} from '../dist/execution-run-resources.js';
import { compositionFacts } from './execution-run-composition-fixture.mjs';

const skill = (id, content) => ({
  id,
  name: id,
  kind: 'skill',
  description: 'Contract routing description',
  content,
  available: true,
});
function facts({ mcp = false, expert = false } = {}) {
  const input = compositionFacts({ expert, upstream: expert });
  const plan = input.workbench.appliedPlans[0];
  const node = plan.task.workflows.flatMap((w) => w.nodes).find((n) => n.id === input.node.nodeId);
  const a = skill('selected-skill', 'SELECTED_FROZEN_BODY');
  const b = skill('other-skill', 'UNSELECTED_PRIVATE_BODY');
  plan.assets = [a, b];
  node.skillIds = [a.id];
  input.node.handoff.skillRefs = [{ id: a.id, version: plan.id }];
  input.resourceCatalog = { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] };
  if (mcp) {
    const asset = {
      id: 'selected-mcp',
      name: 'Contract server',
      kind: 'mcp',
      description: 'Host configuration reference',
      content: 'PRIVATE_CONFIG_TEXT_NOT_AN_EXECUTABLE_CONNECTION',
      available: true,
    };
    plan.assets.push(asset);
    node.mcpIds = [asset.id];
    input.node.handoff.mcpRefs = [{ id: asset.id, version: plan.id }];
    input.resourceCatalog.mcp = [
      {
        ref: { id: asset.id, version: plan.id },
        definitionDigest: executionResourceDigest(asset),
        connectionRef: { id: 'host-config-1', version: 'host-config-version-1' },
        serverName: 'contract',
        tools: [
          {
            name: 'mcp__contract__ping',
            description: 'Contract only',
            parameters: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: { content: { type: 'array' } } },
          },
        ],
      },
    ];
  }
  return input;
}
test('resources contract: an empty isolated registry contributes no tool to a legacy frozen surface', () => {
  const empty = readExecutionRunResources({
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    skills: [],
    mcp: [],
  });
  assert.deepEqual(executionResourceToolNames(empty), []);
  const original = freezeExecutionRunComposition(compositionFacts());
  assert.deepEqual(original.payload.toolAllowlist, []);
  assert.equal(original.schemaVersion, 1);
});
test('resources contract: nonempty selected resources get explicit schema2; legacy schema1 replays unchanged', () => {
  const old = freezeExecutionRunComposition(compositionFacts());
  assert.equal(old.schemaVersion, 1);
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(old))), old);
  const input = facts(),
    saved = freezeExecutionRunComposition(input);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.payload.toolAllowlist, ['skill']);
  assert.equal(saved.payload.resources.skills[0].ref.version, input.scope.planId);
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
  assert(!saved.payload.context.includes('SELECTED_FROZEN_BODY'));
  assert(!JSON.stringify(saved).includes('UNSELECTED_PRIVATE_BODY'));
  assert(Object.isFrozen(saved.payload.resources.skills[0].definition));
  const before = JSON.stringify(saved);
  input.workbench.assets[0].content = 'CURRENT_GLOBAL_DEFINITION';
  assert.equal(JSON.stringify(freezeExecutionRunComposition(input)), before);
  input.workbench.appliedPlans[0].assets[0].content = 'CHANGED_PLAN_BODY';
  assert.notEqual(freezeExecutionRunComposition(input).configurationId, saved.configurationId);
});
test('resources contract: MCP contains only qualified connection ref and real-producer descriptor projection', () => {
  const input = facts({ mcp: true }),
    saved = freezeExecutionRunComposition(input);
  assert.deepEqual(saved.payload.toolAllowlist, ['skill', 'mcp__contract__ping']);
  assert.equal(saved.payload.resources.mcp[0].connectionRef.version, 'host-config-version-1');
  assert(!JSON.stringify(saved).includes('PRIVATE_CONFIG_TEXT'));
  assert(!saved.payload.context.includes('mcp__contract__ping'));
});
for (const [name, mutate] of [
  [
    'missing skill',
    (i) => {
      i.workbench.appliedPlans[0].assets = [];
    },
  ],
  [
    'duplicate skill',
    (i) => {
      i.workbench.appliedPlans[0].assets.push(i.workbench.appliedPlans[0].assets[0]);
    },
  ],
  [
    'disabled skill',
    (i) => {
      i.workbench.appliedPlans[0].assets[0].available = false;
    },
  ],
  [
    'foreign catalog',
    (i) => {
      i.resourceCatalog.sourceVersion = 'unqualified';
    },
  ],
  [
    'unqualified MCP',
    (i) => {
      i.resourceCatalog.mcp = [];
    },
  ],
  [
    'MCP wrong definition',
    (i) => {
      i.resourceCatalog.mcp[0].definitionDigest = 'f'.repeat(64);
    },
  ],
  [
    'MCP wrong plan',
    (i) => {
      i.resourceCatalog.mcp[0].ref.version = 'latest';
    },
  ],
  [
    'MCP wrong namespace',
    (i) => {
      i.resourceCatalog.mcp[0].tools[0].name = 'mcp__other__ping';
    },
  ],
  [
    'MCP duplicate tool',
    (i) => {
      i.resourceCatalog.mcp[0].tools.push(i.resourceCatalog.mcp[0].tools[0]);
    },
  ],
  [
    'extra unselected MCP',
    (i) => {
      i.resourceCatalog.mcp.push({
        ...i.resourceCatalog.mcp[0],
        ref: { id: 'unselected', version: i.scope.planId },
      });
    },
  ],
  [
    'skill byte budget',
    (i) => {
      i.workbench.appliedPlans[0].assets[0].content = '界'.repeat(6000);
    },
  ],
])
  test(`resources contract: ${name} refuses`, () => {
    const input = facts({ mcp: true });
    mutate(input);
    assert.throws(() => freezeExecutionRunComposition(input));
  });
test('resources contract: selected expert defaults must be explicit in the exact node handoff', () => {
  const input = facts({ expert: true });
  const expert = input.workbench.appliedPlans[0].participants.find((p) => p.id === 'qa');
  expert.resourceBindings = { skillIds: ['other-skill'], mcpIds: [] };
  assert.throws(() => freezeExecutionRunComposition(input));
  expert.resourceBindings.skillIds = ['selected-skill'];
  assert.equal(freezeExecutionRunComposition(input).schemaVersion, 2);
});
test('resources contract: resource body/digest edits, schema downgrade and old version refs cannot pass a frozen read', () => {
  const saved = freezeExecutionRunComposition(facts());
  for (const mutate of [
    (s) => {
      s.payload.resources.skills[0].definition.content = 'tampered';
    },
    (s) => {
      s.payload.resources.skills[0].ref.version = 'latest';
    },
    (s) => {
      s.schemaVersion = 1;
    },
    (s) => {
      s.payload.toolAllowlist.push('bash');
    },
    (s) => {
      delete s.payload.resources;
    },
  ]) {
    const copy = structuredClone(saved);
    mutate(copy);
    assert.throws(() => readExecutionRunComposition(copy));
  }
});
test('resources contract: qualified invocation policy is frozen; imported metadata never defaults to broader access', () => {
  const input = facts(),
    asset = input.workbench.appliedPlans[0].assets[0];
  asset.origin = {
    versionId: '12345678-1234-4234-9234-123456789abc',
    format: 'agent-skill',
    entryPath: 'selected-skill/SKILL.md',
    filePaths: ['selected-skill/SKILL.md'],
    totalBytes: 100,
    missing: [],
  };
  assert.throws(() => freezeExecutionRunComposition(input));
  input.resourceCatalog.skills = [
    {
      ref: input.node.handoff.skillRefs[0],
      definitionDigest: executionResourceDigest(asset),
      invocation: { modelInvocable: false, userInvocable: true },
      policySource: {
        kind: 'asset-package',
        versionId: asset.origin.versionId,
        digest: executionResourceDigest('contract-original-package'),
        entryPath: asset.origin.entryPath,
      },
    },
  ];
  const saved = freezeExecutionRunComposition(input);
  assert.deepEqual(saved.payload.resources.skills[0].invocation, {
    modelInvocable: false,
    userInvocable: true,
  });
  input.resourceCatalog.skills[0].invocation.modelInvocable = true;
  assert.notEqual(freezeExecutionRunComposition(input).configurationId, saved.configurationId);
  input.resourceCatalog.skills[0].ref = {
    ...input.resourceCatalog.skills[0].ref,
    version: 'latest',
  };
  assert.throws(() => freezeExecutionRunComposition(input));
});

for (const change of [
  'version',
  'entry',
  'manual',
  'digest-shape',
  'flag-type',
  'duplicate',
  'unselected',
])
  test(`resources contract: imported policy ${change} refuses`, () => {
    const input = facts(),
      asset = input.workbench.appliedPlans[0].assets[0];
    asset.origin = {
      versionId: '12345678-1234-4234-9234-123456789abc',
      format: 'agent-skill',
      entryPath: 'selected-skill/SKILL.md',
      filePaths: ['selected-skill/SKILL.md'],
      totalBytes: 100,
      missing: [],
    };
    const policy = {
      ref: input.node.handoff.skillRefs[0],
      definitionDigest: executionResourceDigest(asset),
      invocation: { modelInvocable: false, userInvocable: true },
      policySource: {
        kind: 'asset-package',
        versionId: asset.origin.versionId,
        digest: executionResourceDigest('contract-original-package'),
        entryPath: asset.origin.entryPath,
      },
    };
    input.resourceCatalog.skills = [policy];
    if (change === 'version')
      policy.policySource.versionId = '22345678-1234-4234-9234-123456789abc';
    if (change === 'entry') policy.policySource.entryPath = 'other/SKILL.md';
    if (change === 'manual') policy.policySource = { kind: 'manual-default' };
    if (change === 'digest-shape') policy.policySource.digest = 'not-a-digest';
    if (change === 'flag-type') policy.invocation.modelInvocable = 'false';
    if (change === 'duplicate') input.resourceCatalog.skills.push(structuredClone(policy));
    if (change === 'unselected') policy.ref = { ...policy.ref, id: 'unselected' };
    assert.throws(() => freezeExecutionRunComposition(input));
  });
test('resources contract: policy source digest and flags remain pinned on reopen, not re-derived from a new catalog', () => {
  const input = facts();
  const saved = freezeExecutionRunComposition(input);
  input.workbench.assets[0].content = 'CHANGED_GLOBAL';
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
  const copy = structuredClone(saved);
  copy.payload.resources.skills[0].invocation.userInvocable = false;
  assert.throws(() => readExecutionRunComposition(copy));
});

test('resource descriptor contract: a real scope loader projection never widens the MCP snapshot schema', async () => {
  const { describeExecutionResourceTool, describeExecutionScopedResourceTool } =
    await import('../dist/execution-run-resources.js');
  const { executionResourceToolSchema } =
    await import('../dist/execution-run-resource-snapshot.js');
  const definition = {
    name: 'skill',
    description: 'Explicit descriptor contract',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    output: { schema: { type: 'object' } },
  };
  const scoped = describeExecutionScopedResourceTool(definition);
  assert.equal(scoped.name, 'skill');
  assert.equal(executionResourceToolSchema.safeParse(scoped).success, false);
  assert.throws(() => describeExecutionResourceTool(definition));
  assert.throws(() =>
    describeExecutionScopedResourceTool({ ...definition, name: 'complete_review' }),
  );
  assert.equal(
    describeExecutionScopedResourceTool({ ...definition, name: 'mcp__contract__ping' }).name,
    'mcp__contract__ping',
  );
});
