/** Exact C descriptor / pure configuration contracts, not publication or Agent execution proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  assertExecutionRunComposition,
  executionRunCompositionRequest,
  EXECUTION_COMPOSITION_LIMITS,
} from '../dist/execution-run-composition.js';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import {
  compositionFacts,
  reader,
  legacyCompletionFixture,
} from './execution-run-composition-fixture.mjs';
import { combinedPublisherFacts } from './execution-run-output-file-fixture.mjs';

const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const wireHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const descriptor = () => describeNativeOutputFileTool();
const facts = () => ({ ...compositionFacts(), outputFilePublisherTool: descriptor() });
const old = Object.assign(
  {},
  ...['composition-pre-file-snapshots.json', 'composition-pre-result-snapshots.json'].map((name) =>
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')),
  ),
);

test('output publisher contract: the original C getter full descriptor has the exact frozen identity', () => {
  const actual = descriptor();
  assert.equal(hash(actual), '9396477fb52178087d78975767bf745c6d57d9061f2b3bc7aeaf8ea5d25a9edd');
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(actual, null, 2) + '\n')
      .digest('hex'),
    '05b8afb17725bffd3a5d778fe449d453bfd085dc3ef308f041ee9cb58c28e63b',
  );
  assert.equal(actual.name, 'publish_output_file');
  assert.equal(actual.sourceVersion, 'zhuma-native-output-file@1');
  assert.deepEqual(actual.parameters.required, ['path']);
  assert.deepEqual(Object.keys(actual.parameters.properties).sort(), ['name', 'path']);
  assert.equal(actual.outputSchema.oneOf[1].properties.phase.const, 'published');
  assert.equal(
    actual.outputSchema.oneOf[1].properties.source.properties.toolVersion.const,
    actual.sourceVersion,
  );
});

test('output publisher contract: explicit new-Run metadata gets its own schema2 slot and content hash', () => {
  const input = facts();
  const saved = freezeExecutionRunComposition(input);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.payload.outputFilePublisherTool, descriptor());
  assert.deepEqual(saved.payload.toolAllowlist, ['publish_output_file']);
  assert.deepEqual(saved.payload.tools, { kind: 'text-only' });
  assert.equal(saved.payload.resultIntentTool, undefined);
  assert.equal(saved.payload.acceptedFileReader, undefined);
  assert.equal(saved.payload.resources, undefined);
  assert(!Object.hasOwn(saved.payload, 'workspace'));
  assert(!Object.hasOwn(saved.payload, 'publishAuthority'));
  assert(!saved.payload.context.includes(descriptor().description));
  assert(!saved.payload.firstMessage.text.includes(descriptor().description));
  assert(Object.isFrozen(saved.payload.outputFilePublisherTool.outputSchema.oneOf));
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
  assert.notEqual(
    saved.configurationId,
    freezeExecutionRunComposition(compositionFacts()).configurationId,
  );
  input.outputFilePublisherTool.parameters.required = [];
  assert.deepEqual(saved.payload.outputFilePublisherTool, descriptor());
});

test('output publisher contract: new tool is inserted before complete_work, with all old reader/resource ordering intact', () => {
  const input = combinedPublisherFacts({ publisher: descriptor() });
  const saved = freezeExecutionRunComposition(input);
  assert.deepEqual(saved.payload.toolAllowlist, [
    'read',
    'write',
    'edit',
    'bash',
    'read_accepted_input',
    'read_accepted_file',
    'publish_output_file',
    'complete_work',
    'skill',
    'mcp__docs0__read0',
  ]);
  assert.deepEqual(saved.payload.resultIntentTool, describeNativeResultTool());
  assert.equal(saved.payload.resultIntentTool.sourceVersion, 'zhuma-native-result-intent@1');
  assert.deepEqual(saved.payload.resultIntentTool.parameters.required, ['links']);
  assert.equal(saved.payload.resultIntentTool.parameters.properties.files, undefined);
  const absent = freezeExecutionRunComposition(combinedPublisherFacts());
  assert.deepEqual(
    absent.payload.toolAllowlist,
    saved.payload.toolAllowlist.filter((name) => name !== 'publish_output_file'),
  );
  assert.equal(
    wireHash(readExecutionRunComposition(legacyCompletionFixture(absent))),
    '86fcc547cf46451c03eaeeab9c0d0ed8e6a2a4b8544bc48732c4032dfea5bec8',
  );
  assert.equal(
    readExecutionRunComposition(legacyCompletionFixture(absent)).configurationId,
    'composition_928eb3f3d43f7b645bea34fd85db8d8cd03186cfa9332afb13099d8b53a4fc66',
  );
});

for (const [name, change] of [
  [
    'name',
    (d) => {
      d.name = 'upload_file';
    },
  ],
  [
    'source version',
    (d) => {
      d.sourceVersion = 'zhuma-native-output-file@2';
    },
  ],
  [
    'description',
    (d) => {
      d.description += ' changed';
    },
  ],
  [
    'required path',
    (d) => {
      d.parameters.required = [];
    },
  ],
  [
    'extra input authority',
    (d) => {
      d.parameters.properties.publishAuthority = { type: 'string' };
    },
  ],
  [
    'phase',
    (d) => {
      d.outputSchema.oneOf[1].properties.phase.const = 'submitted';
    },
  ],
  [
    'source scope',
    (d) => {
      delete d.outputSchema.oneOf[1].properties.source.properties.scope;
    },
  ],
  [
    'extra field',
    (d) => {
      d.authorized = true;
    },
  ],
])
  test(`output publisher contract: changed ${name} cannot masquerade as the original getter`, () => {
    const input = facts();
    change(input.outputFilePublisherTool);
    assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  });

for (const invalid of [null, false])
  test(`output publisher contract: explicit ${invalid} is refused instead of omitted`, () => {
    assert.throws(
      () =>
        freezeExecutionRunComposition({ ...compositionFacts(), outputFilePublisherTool: invalid }),
      { code: 'composition-invalid' },
    );
  });

test('output publisher contract: rehashed downgrade, missing descriptor, widened/reordered/duplicated allowlist are refused', () => {
  const saved = freezeExecutionRunComposition(facts());
  for (const change of [
    (s) => {
      s.schemaVersion = 1;
    },
    (s) => {
      delete s.payload.outputFilePublisherTool;
      s.payload.toolAllowlist = [];
    },
    (s) => {
      s.payload.outputFilePublisherTool = null;
    },
    (s) => {
      s.payload.outputFilePublisherTool.parameters.additionalProperties = true;
    },
    (s) => {
      s.payload.toolAllowlist = [];
    },
    (s) => {
      s.payload.toolAllowlist.push('publish_output_file');
    },
    (s) => {
      s.payload.toolAllowlist.push('write');
    },
  ]) {
    const copy = structuredClone(saved);
    change(copy);
    copy.configurationId = `composition_${hash(copy.payload)}`;
    assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
  }
  const copy = structuredClone(
    freezeExecutionRunComposition(combinedPublisherFacts({ publisher: descriptor() })),
  );
  const list = copy.payload.toolAllowlist;
  [list[6], list[7]] = [list[7], list[6]];
  copy.configurationId = `composition_${hash(copy.payload)}`;
  assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
});

test('output publisher contract: slot-absent old schema1/file/resource/result JSON and configuration IDs never gain publication', () => {
  for (const saved of Object.values(old)) {
    const wire = JSON.stringify(saved),
      reopened = readExecutionRunComposition(JSON.parse(wire));
    assert.equal(JSON.stringify(reopened), wire);
    assert.equal(reopened.configurationId, saved.configurationId);
    assert(!Object.hasOwn(reopened.payload, 'outputFilePublisherTool'));
    assert(!reopened.payload.toolAllowlist.includes('publish_output_file'));
  }
  const input = { ...compositionFacts(), resultIntentTool: describeNativeResultTool() };
  const current = freezeExecutionRunComposition(input);
  const saved = readExecutionRunComposition(legacyCompletionFixture(current));
  assert.equal(wireHash(saved), '5d9bb8b1d3c0d3d363862039504f03c6f415e6d5065fb89c7bc85e67885b209e');
  assert.equal(
    saved.configurationId,
    'composition_2b465af92881b2e69bcc0a69e3779793890b67e88e40573f621e3a658a6b0563',
  );
  assert.deepEqual(
    freezeExecutionRunComposition({ ...input, outputFilePublisherTool: undefined }),
    current,
  );
  const request = executionRunCompositionRequest(saved);
  assert.equal(assertExecutionRunComposition(saved, input, request), undefined);
  assert.throws(
    () =>
      assertExecutionRunComposition(
        saved,
        { ...input, outputFilePublisherTool: descriptor() },
        request,
      ),
    { code: 'composition-mismatch' },
  );
  assert.throws(
    () =>
      freezeExecutionRunComposition({
        ...compositionFacts({ upstream: true }),
        tools: { kind: 'accepted-input-reader', definition: descriptor() },
      }),
    { code: 'composition-invalid' },
  );
});

test('output publisher contract: the original 40-tool budget still rejects a 41st publisher without dropping another tool', () => {
  const input = combinedPublisherFacts({ maximal: true });
  assert.equal(freezeExecutionRunComposition(input).payload.toolAllowlist.length, 40);
  input.outputFilePublisherTool = descriptor();
  assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  input.resourceCatalog.mcp.at(-1).tools.pop();
  const saved = freezeExecutionRunComposition(input);
  assert.equal(saved.payload.toolAllowlist.length, 40);
  assert.equal(new Set(saved.payload.toolAllowlist).size, 40);
  assert.deepEqual(saved.payload.toolAllowlist.slice(5, 10), [
    'read_accepted_file',
    'publish_output_file',
    'complete_work',
    'skill',
    'mcp__docs0__read0',
  ]);
});

test('output publisher contract: descriptor bytes count against the original 65536 snapshot budget', () => {
  const input = compositionFacts(),
    tool = {
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
  assert.equal(Buffer.byteLength(canonicalPayload(saved)), 65536 - 100);
  assert.throws(
    () => freezeExecutionRunComposition({ ...input, outputFilePublisherTool: descriptor() }),
    { code: 'composition-budget' },
  );
  assert(!Object.hasOwn(saved.payload, 'outputFilePublisherTool'));
});
