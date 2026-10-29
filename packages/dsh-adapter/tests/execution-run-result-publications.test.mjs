/** Exact descriptor/configuration contracts only; no completed cut, file receipt or execution proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  assertExecutionRunComposition,
  executionRunCompositionRequest,
  EXECUTION_COMPOSITION_LIMITS,
} from '../dist/execution-run-composition.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeOutputFileTool } from '../dist/native-work-session-output-file-tool.js';
import { compositionFacts, legacyCompletionFixture } from './execution-run-composition-fixture.mjs';
import { combinedPublisherFacts } from './execution-run-output-file-fixture.mjs';

const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const wireHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const descriptor = () => describeNativeResultPublicationsTool();
const facts = () => ({ ...compositionFacts(), resultIntentTool: descriptor() });
const combined = (maximal = false) => ({
  ...combinedPublisherFacts({ maximal, publisher: describeNativeOutputFileTool() }),
  resultIntentTool: descriptor(),
});

test('result v2 composition: explicit exact C getter selects one new protocol without granting publication or completion', () => {
  const definition = descriptor();
  assert.equal(
    hash(definition),
    '4ca1e6f1bdd146b16456d93b19ebff653950bdea19d39f68ad9da3386ace0eae',
  );
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(definition, null, 2) + '\n')
      .digest('hex'),
    '75ab5c8344b6100d3702ad9eba227fe73b7828a24f853f551c4465e526052a9d',
  );
  const input = facts();
  const saved = freezeExecutionRunComposition(input);
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.payload.resultIntentTool, definition);
  assert.deepEqual(saved.payload.toolAllowlist, ['complete_work']);
  assert.equal(saved.payload.outputFilePublisherTool, undefined);
  assert.equal(saved.payload.resources, undefined);
  assert.equal(saved.payload.tools.kind, 'text-only');
  assert(!Object.hasOwn(saved.payload, 'workspace'));
  assert(!Object.hasOwn(saved.payload, 'publishAuthority'));
  assert(!Object.hasOwn(saved.payload, 'manifest'));
  assert(Object.isFrozen(saved.payload.resultIntentTool.parameters.properties.publications));
  assert.deepEqual(readExecutionRunComposition(JSON.parse(JSON.stringify(saved))), saved);
  assertExecutionRunComposition(saved, input, executionRunCompositionRequest(saved));
  input.resultIntentTool.parameters.required.pop();
  assert.deepEqual(saved.payload.resultIntentTool, definition);
  assert.notEqual(
    saved.configurationId,
    freezeExecutionRunComposition({
      ...compositionFacts(),
      resultIntentTool: describeNativeResultTool(),
    }).configurationId,
  );
});

test('result v2 composition: publisher precedes completion and real frozen readers/resources retain their order', () => {
  const input = combined();
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
  assert.equal(saved.payload.resultIntentTool.sourceVersion, 'zhuma-native-result-intent@2');
  assert.deepEqual(saved.payload.outputFilePublisherTool, describeNativeOutputFileTool());
  const request = executionRunCompositionRequest(saved);
  assert.equal(request.selection.configurationId, saved.configurationId);
  assert(!request.firstMessage.text.includes(descriptor().description));
  assert(!saved.payload.context.includes(descriptor().description));
  assertExecutionRunComposition(saved, input, request);
});

for (const [name, change] of [
  [
    'name',
    (value) => {
      value.name = 'finish_work';
    },
  ],
  [
    'v1 relabel',
    (value) => {
      value.sourceVersion = 'zhuma-native-result-intent@1';
    },
  ],
  [
    'future version',
    (value) => {
      value.sourceVersion = 'zhuma-native-result-intent@3';
    },
  ],
  [
    'description',
    (value) => {
      value.description += ' changed';
    },
  ],
  [
    'required selectors',
    (value) => {
      value.parameters.required = ['links'];
    },
  ],
  [
    'selector file claims',
    (value) => {
      value.parameters.properties.publications.items.properties.sha256 = { type: 'string' };
    },
  ],
  [
    'manifest digest',
    (value) => {
      delete value.outputSchema.oneOf[1].properties.manifestDigest;
    },
  ],
  [
    'v1 acknowledgement',
    (value) => {
      value.outputSchema.oneOf[1].properties.protocolVersion.const = 1;
    },
  ],
  [
    'extra authority',
    (value) => {
      value.authorized = true;
    },
  ],
])
  test(`result v2 composition: changed ${name} cannot pass the exact getter gate`, () => {
    const input = facts();
    change(input.resultIntentTool);
    assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  });

test('result v2 composition: rehashed protocol substitution, descriptor tampering and reordered allowlist refuse', () => {
  const saved = freezeExecutionRunComposition(combined());
  for (const mutate of [
    (value) => {
      value.schemaVersion = 1;
    },
    (value) => {
      value.payload.resultIntentTool.sourceVersion = 'zhuma-native-result-intent@1';
    },
    (value) => {
      value.payload.resultIntentTool.parameters.additionalProperties = true;
    },
    (value) => {
      value.payload.toolAllowlist.push('complete_work');
    },
    (value) => {
      const list = value.payload.toolAllowlist;
      [list[6], list[7]] = [list[7], list[6]];
    },
  ]) {
    const copy = structuredClone(saved);
    mutate(copy);
    copy.configurationId = `composition_${hash(copy.payload)}`;
    assert.throws(() => readExecutionRunComposition(copy), { code: 'composition-invalid' });
  }
  assert.throws(
    () =>
      assertExecutionRunComposition(
        saved,
        {
          ...combined(),
          resultIntentTool: describeNativeResultTool(),
        },
        executionRunCompositionRequest(saved),
      ),
    { code: 'composition-mismatch' },
  );
});

test('result v2 composition: original 40-tool and snapshot-byte limits remain in force without truncation', () => {
  const input = combined(true);
  assert.throws(() => freezeExecutionRunComposition(input), { code: 'composition-invalid' });
  input.resourceCatalog.mcp.at(-1).tools.pop();
  const saved = freezeExecutionRunComposition(input);
  assert.equal(saved.payload.toolAllowlist.length, 40);
  assert.equal(new Set(saved.payload.toolAllowlist).size, 40);
  assert.equal(EXECUTION_COMPOSITION_LIMITS.snapshotBytes, 65536);
  assert(Buffer.byteLength(JSON.stringify(saved)) <= EXECUTION_COMPOSITION_LIMITS.snapshotBytes);
  assert.equal(saved.payload.resultIntentTool.sourceVersion, 'zhuma-native-result-intent@2');
});

test('result v2 composition: absent and v1 old wire bytes and configuration IDs remain exact', () => {
  const samples = [
    [
      compositionFacts(),
      'composition_94d1cd31afa40587d68854cc72cbbba1b27ca1941697ad5e1dca2e89564d948b',
      '505084118cc3aca659775e692f63abc36d4fa4180acec14eef3093944de9b21c',
    ],
    [
      { ...compositionFacts(), resultIntentTool: describeNativeResultTool() },
      'composition_2b465af92881b2e69bcc0a69e3779793890b67e88e40573f621e3a658a6b0563',
      '5d9bb8b1d3c0d3d363862039504f03c6f415e6d5065fb89c7bc85e67885b209e',
    ],
    [
      combinedPublisherFacts({ publisher: describeNativeOutputFileTool() }),
      'composition_654e42967fbc58ce4da1c854da703d5f13c96ccec80538a8888d209efd5e7e30',
      '25962e12be7a1790b9c4dea94c270f0bd6b649319c159168a6a0bf00802a7f61',
    ],
  ];
  for (const [input, configurationId, bytes] of samples) {
    const saved = readExecutionRunComposition(
      legacyCompletionFixture(freezeExecutionRunComposition(input)),
    );
    assert.equal(saved.configurationId, configurationId);
    assert.equal(wireHash(saved), bytes);
    const reopened = readExecutionRunComposition(JSON.parse(JSON.stringify(saved)));
    assert.equal(wireHash(reopened), bytes);
    assert.equal(reopened.configurationId, configurationId);
    if (saved.payload.resultIntentTool) {
      assert.equal(saved.payload.resultIntentTool.sourceVersion, 'zhuma-native-result-intent@1');
      assert.equal(saved.payload.resultIntentTool.parameters.properties.publications, undefined);
    }
  }
});
