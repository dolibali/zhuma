/** C's exact descriptor; Host readiness, issuer and actual file reads are NOT proved by these contracts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalPayload } from '@zhuma/agent-core';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import {
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

const fileReader = JSON.parse(
  readFileSync(new URL('./fixtures/accepted-file-descriptor-v2.json', import.meta.url), 'utf8'),
);
// Saved by the unmodified PR146 composition, before this independent increment.
const legacy = JSON.parse(
  readFileSync(new URL('./fixtures/composition-pre-file-snapshots.json', import.meta.url), 'utf8'),
);
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
function facts() {
  return {
    ...compositionFacts({ upstream: true }),
    acceptedFileReader: structuredClone(fileReader),
  };
}
test('accepted-file composition contract: exact C SDK-supported v2 descriptor is a separate frozen capability', () => {
  const input = facts(),
    saved = freezeExecutionRunComposition(input);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.payload.resources, undefined);
  assert.deepEqual(saved.payload.tools, reader);
  assert.deepEqual(saved.payload.toolAllowlist, ['read_accepted_input', 'read_accepted_file']);
  assert.deepEqual(saved.payload.acceptedFileReader, fileReader);
  assert.equal(
    hash(fileReader),
    '6e676da0e4023d3daf24872e7598f9f7f382978cdbec746c13613efb7bdd96f9',
  );
  assert.equal(saved.payload.acceptedFileReader.parameters.type, 'object');
  assert.equal(saved.payload.acceptedFileReader.parameters.anyOf, undefined);
  const parameters = saved.payload.acceptedFileReader.parameters;
  assert.equal(parameters.oneOf, undefined);
  assert.deepEqual(parameters.required, ['inputRef', 'part']);
  assert.deepEqual(parameters.properties.part.enum, ['files', 'file']);
  assert.equal(parameters.properties.offset.default, 0);
  assert.equal(parameters.properties.length.default, 4096);
  assert(parameters.properties.fileId.description.includes('Required only for part=file'));
  assert(parameters.properties.length.description.includes('8192'));
  assert(Object.isFrozen(parameters.properties));
  assert(!saved.payload.context.includes(fileReader.description));
  assert(!JSON.stringify(saved).includes('PRIVATE_SOURCE_BODY_NOT_IN_PROMPT'));
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
});

test('accepted-file declaration: official rc2 JSON validators accept the exact v2 input and output', () => {
  assert.doesNotThrow(() => assertObjectJsonSchema(fileReader.parameters));
  assert.doesNotThrow(() => assertSupportedJsonSchema(fileReader.outputSchema));
  assert.equal(fileReader.parameters.$schema, undefined);
  assert.equal(fileReader.outputSchema.anyOf, undefined);
  assert.equal(fileReader.outputSchema.$schema, undefined);
  assert.equal(fileReader.outputSchema.oneOf.length, 3);
});

test('accepted-file composition contract: local/shell, text reader and selected Skill/MCP retain independent slots', () => {
  const input = facts(),
    plan = input.workbench.appliedPlans[0],
    node = plan.task.workflows[0].nodes.find((item) => item.id === input.scope.nodeId);
  input.tools = {
    kind: 'local-tools',
    definitions: ['read', 'write', 'edit'].map((name) => ({ ...reader.definition, name })),
    shell: {
      ...reader.definition,
      name: 'bash',
      budget: { defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxAttempts: 2 },
    },
    acceptedInputReader: structuredClone(reader.definition),
  };
  plan.assets = [
    {
      id: 'file-method',
      name: 'Method',
      kind: 'skill',
      description: 'Contract',
      content: 'METHOD',
      available: true,
    },
    {
      id: 'docs',
      name: 'Docs',
      kind: 'mcp',
      description: 'Contract',
      content: 'NOT_A_CONNECTION',
      available: true,
    },
  ];
  node.skillIds = ['file-method'];
  node.mcpIds = ['docs'];
  input.node.handoff.skillRefs = [{ id: 'file-method', version: plan.id }];
  input.node.handoff.mcpRefs = [{ id: 'docs', version: plan.id }];
  input.resourceCatalog = {
    sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
    mcp: [
      {
        ref: input.node.handoff.mcpRefs[0],
        definitionDigest: executionResourceDigest(plan.assets[1]),
        connectionRef: { id: 'contract-config', version: '1' },
        serverName: 'docs',
        tools: [
          {
            name: 'mcp__docs__ping',
            description: 'Contract',
            parameters: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        ],
      },
    ],
  };
  const saved = freezeExecutionRunComposition(input);
  assert.deepEqual(saved.payload.toolAllowlist, [
    'read',
    'write',
    'edit',
    'bash',
    'read_accepted_input',
    'read_accepted_file',
    'skill',
    'mcp__docs__ping',
  ]);
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
});

for (const [name, change] of [
  [
    'different name',
    (d) => {
      d.name = 'read_accepted_input';
    },
  ],
  [
    'unknown source',
    (d) => {
      d.sourceVersion = 'zhuma-accepted-files@1';
    },
  ],
  [
    'unsupported parameter combinator',
    (d) => {
      d.parameters.oneOf = [{ type: 'object' }];
    },
  ],
  [
    'forced required offset',
    (d) => {
      d.parameters.required.push('offset');
    },
  ],
  [
    'changed default',
    (d) => {
      d.parameters.properties.length.default = 8192;
    },
  ],
  [
    'expanded byte range',
    (d) => {
      d.parameters.properties.length.description = 'Byte length from 1 to 16384';
    },
  ],
  [
    'expanded output',
    (d) => {
      d.outputSchema.oneOf[2].properties.encoding.const = 'utf-16';
    },
  ],
  [
    'extra availability claim',
    (d) => {
      d.available = true;
    },
  ],
])
  test(`accepted-file composition contract: ${name} cannot masquerade as C v2`, () => {
    const input = facts();
    change(input.acceptedFileReader);
    assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  });

for (const descriptor of [null, false])
  test(`accepted-file composition contract: explicit ${descriptor} is not silently treated as omitted`, () => {
    assert.throws(
      () => freezeExecutionRunComposition({ ...facts(), acceptedFileReader: descriptor }),
      { code: 'composition-invalid' },
    );
  });

test('accepted-file composition contract: no fixed inputs and missing original text reader refuse', () => {
  assert.throws(
    () => freezeExecutionRunComposition({ ...compositionFacts(), acceptedFileReader: fileReader }),
    { code: 'composition-input-unavailable' },
  );
  const input = facts();
  input.tools = { kind: 'text-only' };
  assert.throws(() => freezeExecutionRunComposition(input), {
    code: 'composition-input-reader-required',
  });
});

test('accepted-file composition contract: schema1 and resource schema2 reopen byte-identically without new capability', () => {
  for (const saved of Object.values(legacy)) {
    const wire = JSON.stringify(saved);
    const reopened = readExecutionRunComposition(JSON.parse(wire));
    assert.equal(JSON.stringify(reopened), wire);
    assert(!Object.hasOwn(reopened.payload, 'acceptedFileReader'));
    assert(!reopened.payload.toolAllowlist.includes('read_accepted_file'));
  }
  const original = compositionFacts({ upstream: true });
  assert.deepEqual(freezeExecutionRunComposition(original), legacy.schema1);
  const request = executionRunCompositionRequest(legacy.schema1);
  assert.equal(assertExecutionRunComposition(legacy.schema1, original, request), undefined);
  assert.throws(() => assertExecutionRunComposition(legacy.schema1, facts(), request), {
    code: 'composition-mismatch',
  });
});

test('accepted-file composition contract: schema downgrade, empty schema2 and rehashed descriptor tampering refuse', () => {
  const saved = freezeExecutionRunComposition(facts());
  for (const change of [
    (s) => {
      s.schemaVersion = 1;
    },
    (s) => {
      delete s.payload.acceptedFileReader;
      s.payload.toolAllowlist = ['read_accepted_input'];
    },
    (s) => {
      s.payload.acceptedFileReader.parameters.properties.length.default = 65536;
    },
    (s) => {
      s.payload.acceptedFileReader.sourceVersion = 'zhuma-accepted-files@1';
    },
  ]) {
    const copy = structuredClone(saved);
    change(copy);
    copy.configurationId = `composition_${hash(copy.payload)}`;
    assert.throws(() => readExecutionRunComposition(copy));
  }
});
