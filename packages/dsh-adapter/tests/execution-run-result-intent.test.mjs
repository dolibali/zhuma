/** C's exact declaration candidate; contract snapshots are not completion/submission proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import {
  EXECUTION_COMPOSITION_LIMITS,
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  executionRunCompositionRequest,
  assertExecutionRunComposition,
} from '../dist/execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  executionResourceDigest,
} from '../dist/execution-run-resource-snapshot.js';
import { compositionFacts, reader } from './execution-run-composition-fixture.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const intent = load('result-intent-descriptor-v1.json');
const fileReader = load('accepted-file-descriptor-v2.json');
// Saved before this increment, from unchanged PR146 and exact eb9a respectively.
const old = {
  ...load('composition-pre-file-snapshots.json'),
  ...load('composition-pre-result-snapshots.json'),
};
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const facts = () => ({ ...compositionFacts(), resultIntentTool: structuredClone(intent) });

test('result-intent composition contract: an explicit standalone descriptor gets its own schema2 slot and fingerprint', () => {
  const input = facts();
  const saved = freezeExecutionRunComposition(input);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.payload.tools, { kind: 'text-only' });
  assert.equal(saved.payload.resources, undefined);
  assert.equal(saved.payload.acceptedFileReader, undefined);
  assert.deepEqual(saved.payload.resultIntentTool, intent);
  assert.deepEqual(saved.payload.toolAllowlist, ['complete_work']);
  assert.equal(hash(intent), 'fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386');
  assert(Object.isFrozen(saved.payload.resultIntentTool.parameters.properties));
  assert(!saved.payload.context.includes(intent.description));
  assert(!saved.payload.firstMessage.text.includes(intent.description));
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
  assert.notEqual(
    saved.configurationId,
    freezeExecutionRunComposition(compositionFacts()).configurationId,
  );
  input.resultIntentTool.parameters.properties.text.description = 'MUTATED_AFTER_FREEZE';
  assert.deepEqual(saved.payload.resultIntentTool, intent);
});

test('result-intent declaration candidate: official rc2 JSON validators accept the same input/output subset', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(intent.parameters));
  assert.doesNotThrow(() => assertSupportedJsonSchema(intent.outputSchema));
  assert.deepEqual(intent.parameters.required, ['links']);
  assert.equal(intent.parameters.additionalProperties, false);
  assert.equal(intent.parameters.$schema, undefined);
  assert.equal(intent.outputSchema.anyOf, undefined);
  assert.equal(intent.outputSchema.oneOf.length, 2);
  // These descriptions are not substitutes for C's strict invocation parser.
  assert(intent.parameters.properties.text.description.includes('100000'));
  assert(intent.parameters.properties.links.description.includes('20'));
});

function combined() {
  const input = {
    ...compositionFacts({ upstream: true }),
    acceptedFileReader: fileReader,
    resultIntentTool: intent,
  };
  input.tools = {
    kind: 'local-tools',
    definitions: ['read', 'write', 'edit'].map((name) => ({ ...reader.definition, name })),
    shell: {
      ...reader.definition,
      name: 'bash',
      budget: { defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxAttempts: 2 },
    },
    acceptedInputReader: reader.definition,
  };
  const plan = input.workbench.appliedPlans[0];
  const step = plan.task.workflows[0].nodes.find((item) => item.id === input.node.nodeId);
  const skill = {
    id: 'method',
    name: 'Method',
    kind: 'skill',
    description: 'Contract method',
    content: 'METHOD_BODY',
    available: true,
  };
  const servers = Array.from({ length: 4 }, (_, i) => ({
    id: `docs-${i}`,
    name: `Docs ${i}`,
    kind: 'mcp',
    description: 'Contract connection metadata',
    content: 'NOT_AN_EXECUTABLE_CONNECTION',
    available: true,
  }));
  plan.assets = [skill, ...servers];
  step.skillIds = [skill.id];
  step.mcpIds = servers.map((item) => item.id);
  input.node.handoff.skillRefs = [{ id: skill.id, version: plan.id }];
  input.node.handoff.mcpRefs = servers.map((item) => ({ id: item.id, version: plan.id }));
  input.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: servers.map((asset, i) => ({
      ref: { id: asset.id, version: plan.id },
      definitionDigest: executionResourceDigest(asset),
      connectionRef: { id: `connection-${i}`, version: '1' },
      serverName: `docs${i}`,
      tools: Array.from({ length: 8 }, (_, j) => ({
        name: `mcp__docs${i}__read${j}`,
        description: 'Contract',
        parameters: { type: 'object' },
        outputSchema: { type: 'object' },
      })),
    })),
  };
  return input;
}

test('result-intent composition contract: all independent tools coexist within the original 40-tool limit', () => {
  const saved = freezeExecutionRunComposition(combined());
  assert.deepEqual(saved.payload.toolAllowlist.slice(0, 8), [
    'read',
    'write',
    'edit',
    'bash',
    'read_accepted_input',
    'read_accepted_file',
    'complete_work',
    'skill',
  ]);
  assert.equal(saved.payload.toolAllowlist.length, 40);
  assert.equal(new Set(saved.payload.toolAllowlist).size, 40);
  assert.deepEqual(saved.payload.resultIntentTool, intent);
  assert.deepEqual(saved.payload.acceptedFileReader, fileReader);
  assert.equal(saved.payload.resources.mcp.length, 4);
  const copy = structuredClone(saved);
  copy.payload.toolAllowlist.push('extra');
  copy.configurationId = `composition_${hash(copy.payload)}`;
  assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
});

for (const [name, change] of [
  [
    'name',
    (d) => {
      d.name = 'finish_work';
    },
  ],
  [
    'version',
    (d) => {
      d.sourceVersion = 'zhuma-native-result-intent@2';
    },
  ],
  [
    'description',
    (d) => {
      d.description += ' changed';
    },
  ],
  [
    'parameters',
    (d) => {
      d.parameters.required = [];
    },
  ],
  [
    'output',
    (d) => {
      d.outputSchema.oneOf[1].properties.phase.const = 'submitted';
    },
  ],
  [
    'extra field',
    (d) => {
      d.authorized = true;
    },
  ],
])
  test(`result-intent composition contract: ${name} cannot masquerade as C's exact declaration`, () => {
    const input = facts();
    change(input.resultIntentTool);
    assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  });

for (const invalid of [null, false])
  test(`result-intent composition contract: explicit ${invalid} is rejected rather than omitted`, () => {
    assert.throws(
      () => freezeExecutionRunComposition({ ...compositionFacts(), resultIntentTool: invalid }),
      { code: 'composition-invalid' },
    );
  });

test('result-intent composition contract: original tools variants never accept complete_work as a text reader', () => {
  assert.throws(
    () =>
      freezeExecutionRunComposition({
        ...compositionFacts({ upstream: true }),
        tools: { kind: 'accepted-input-reader', definition: intent },
      }),
    { code: 'composition-invalid' },
  );
});

test('result-intent composition contract: downgrade, empty schema2, descriptor and allowlist tampering fail even when rehashed', () => {
  const saved = freezeExecutionRunComposition(facts());
  for (const change of [
    (s) => {
      s.schemaVersion = 1;
    },
    (s) => {
      delete s.payload.resultIntentTool;
      s.payload.toolAllowlist = [];
    },
    (s) => {
      s.payload.resultIntentTool = null;
    },
    (s) => {
      s.payload.resultIntentTool.sourceVersion = 'unknown';
    },
    (s) => {
      s.payload.resultIntentTool.parameters.additionalProperties = true;
    },
    (s) => {
      s.payload.toolAllowlist = [];
    },
    (s) => {
      s.payload.toolAllowlist.push('complete_work');
    },
  ]) {
    const copy = structuredClone(saved);
    change(copy);
    copy.configurationId = `composition_${hash(copy.payload)}`;
    assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
  }
});

test('result-intent composition contract: original schema1, resource and file schema2 JSON/IDs stay byte-identical', () => {
  for (const saved of Object.values(old)) {
    const wire = JSON.stringify(saved);
    const reopened = readExecutionRunComposition(JSON.parse(wire));
    assert.equal(JSON.stringify(reopened), wire);
    assert.equal(reopened.configurationId, saved.configurationId);
    assert(!Object.hasOwn(reopened.payload, 'resultIntentTool'));
    assert(!reopened.payload.toolAllowlist.includes('complete_work'));
  }
  const original = compositionFacts({ upstream: true });
  assert.deepEqual(freezeExecutionRunComposition(original), old.schema1);
  assert.deepEqual(
    freezeExecutionRunComposition({ ...original, resultIntentTool: undefined }),
    old.schema1,
  );
  assert.deepEqual(
    freezeExecutionRunComposition({ ...original, acceptedFileReader: fileReader }),
    old.fileSchema2,
  );
  const request = executionRunCompositionRequest(old.fileSchema2);
  assert.equal(
    assertExecutionRunComposition(
      old.fileSchema2,
      { ...original, acceptedFileReader: fileReader },
      request,
    ),
    undefined,
  );
  assert.throws(
    () =>
      assertExecutionRunComposition(
        old.fileSchema2,
        { ...original, acceptedFileReader: fileReader, resultIntentTool: intent },
        request,
      ),
    { code: 'composition-mismatch' },
  );
});

test('result-intent composition contract: descriptor bytes use the original snapshot budget without truncation', () => {
  const input = compositionFacts();
  const tool = {
    ...reader.definition,
    name: 'read',
    parameters: { type: 'object', contractPadding: '' },
  };
  input.tools = { kind: 'local-tools', definitions: [tool] };
  const size = Buffer.byteLength(canonicalPayload(freezeExecutionRunComposition(input)));
  tool.parameters.contractPadding = 'x'.repeat(
    EXECUTION_COMPOSITION_LIMITS.snapshotBytes - size - 100,
  );
  const saved = freezeExecutionRunComposition(input);
  assert.equal(
    Buffer.byteLength(canonicalPayload(saved)),
    EXECUTION_COMPOSITION_LIMITS.snapshotBytes - 100,
  );
  assert.throws(() => freezeExecutionRunComposition({ ...input, resultIntentTool: intent }), {
    code: 'composition-budget',
  });
  assert(!('resultIntentTool' in saved.payload));
});
