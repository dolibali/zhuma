/** Parser/descriptor contracts only, not publication, durable ACK or delivery proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import {
  NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  nativeResultPublicationsContentSchema as content,
} from '../dist/native-work-session-result-publications-contract.js';

test('native result v2 descriptor contract: explicit selectors and SDK-supported schema retain v1 bytes', () => {
  const legacy = describeNativeResultTool();
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(legacy, null, 2) + '\n')
      .digest('hex'),
    '241bae9b4e21db3acbf9f4a4743d10e0934e1abc473ef1c259304f6518215931',
  );
  assert.equal(
    createHash('sha256').update(canonicalPayload(legacy)).digest('hex'),
    'fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386',
  );
  const value = describeNativeResultPublicationsTool();
  assert.equal(value.name, 'complete_work');
  assert.equal(value.sourceVersion, NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION);
  assert.deepEqual(value.parameters.required, ['links', 'publications']);
  assert.deepEqual(Object.keys(value.parameters.properties), ['text', 'links', 'publications']);
  assert.deepEqual(Object.keys(value.parameters.properties.publications.items.properties), [
    'publicationId',
  ]);
  assert.doesNotThrow(() => assertObjectJsonSchema(value.parameters));
  assert.doesNotThrow(() => assertSupportedJsonSchema(value.outputSchema));
  assert.equal(value.outputSchema.oneOf[1].properties.protocolVersion.const, 2);
  assert.equal(value.outputSchema.oneOf[1].properties.manifestDigest.type, 'string');
  value.parameters.required.push('files');
  assert.deepEqual(describeNativeResultPublicationsTool().parameters.required, [
    'links',
    'publications',
  ]);
});

test('native result v2 input contract: files-only selectors, normalized text/links and exactly twenty unique selectors', () => {
  const publications = Array.from({ length: 20 }, (_, i) => ({
    publicationId: `publication-${i}`,
  }));
  assert.equal(content.parse({ links: [], publications }).publications.length, 20);
  assert.deepEqual(
    content.parse({
      text: '  result  ',
      links: [' https://example.test/result '],
      publications: [],
    }),
    { text: 'result', links: ['https://example.test/result'], publications: [] },
  );
  const value = content.parse({ links: [], publications: [{ publicationId: 'publication' }] });
  assert.equal(Object.isFrozen(value.publications), true);
  assert.equal(Object.isFrozen(value.publications[0]), true);
});

test('native result v2 input contract: no empty/duplicate/oversized selectors or model file/identity claims', () => {
  const selectors = [{ publicationId: 'publication' }];
  for (const raw of [
    { links: [], publications: [] },
    { text: '  ', links: [], publications: [] },
    { links: [], publications: [...selectors, ...selectors] },
    {
      links: [],
      publications: Array.from({ length: 21 }, (_, i) => ({ publicationId: `publication-${i}` })),
    },
    { links: [], publications: [{ publicationId: 'publication', sha256: 'a'.repeat(64) }] },
    { links: [], publications: [{ path: 'outputs/result.bin' }] },
    { links: [], publications: selectors, files: [] },
    { links: [], publications: selectors, actorId: 'foreign' },
    { links: [], publications: [{ publicationId: '../foreign' }] },
    { links: [], publications: [{ publicationId: 'x'.repeat(101) }] },
    { links: [], publications: selectors, text: 'x'.repeat(100001) },
    { links: ['https://user:secret@example.test'], publications: selectors },
    { links: ['javascript:alert(1)'], publications: selectors },
    { text: 'legacy args', links: [] },
  ])
    assert.equal(content.safeParse(raw).success, false);
});
