/** Tool declaration contracts only; no registration, model invocation or ballot. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from '../dist/native-work-session-review-read.js';

test('review getter contract: author v1/v2 descriptor raw and canonical golden hashes are unchanged', () => {
  for (const [get, raw, canonical] of [
    [
      describeNativeResultTool,
      '241bae9b4e21db3acbf9f4a4743d10e0934e1abc473ef1c259304f6518215931',
      'fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386',
    ],
    [
      describeNativeResultPublicationsTool,
      '75ab5c8344b6100d3702ad9eba227fe73b7828a24f853f551c4465e526052a9d',
      '4ca1e6f1bdd146b16456d93b19ebff653950bdea19d39f68ad9da3386ace0eae',
    ],
  ]) {
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(get(), null, 2) + '\n')
        .digest('hex'),
      raw,
    );
    assert.equal(createHash('sha256').update(canonicalPayload(get())).digest('hex'), canonical);
  }
});

test('review getter contract: two SDK-supported strict descriptors, no model identity/target/permission selection', () => {
  const read = describeNativeReviewReadTool(),
    complete = describeNativeReviewTool();
  assert.equal(read.name, 'read_review_target');
  assert.equal(read.sourceVersion, 'zhuma-native-review-read@1');
  assert.equal(complete.name, 'complete_review');
  assert.equal(complete.sourceVersion, 'zhuma-native-review-intent@1');
  assert.deepEqual(Object.keys(read.parameters.properties), ['resourceRef', 'offset', 'length']);
  assert.deepEqual(Object.keys(complete.parameters.properties), [
    'conclusion',
    'rationale',
    'anchors',
    'evidenceRefs',
  ]);
  assert.deepEqual(complete.parameters.properties.conclusion.enum, [
    'approve',
    'request-changes',
    'comment',
  ]);
  assert.deepEqual(Object.keys(complete.parameters.properties.anchors.items.properties), [
    'resourceRef',
    'offset',
    'length',
  ]);
  for (const tool of [read, complete]) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
    assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters));
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.outputSchema));
    const source = tool.outputSchema.oneOf[1].properties.source;
    assert.equal(source.properties.context.properties.role.const, 'review');
    assert.deepEqual(Object.keys(source.properties.context.properties.scope.properties), [
      'actorId',
      'spaceId',
      'taskId',
      'planId',
      'revision',
      'nodeId',
      'runId',
      'generation',
      'segmentId',
    ]);
  }
  assert.match(read.description, /Partial pages prove only their actual ranges/);
  assert.match(
    complete.description,
    /comment records an opinion and leaves the review obligation pending/,
  );
});

test('review getter contract: detached deep copies cannot corrupt later read/completion schemas', () => {
  for (const get of [describeNativeReviewReadTool, describeNativeReviewTool]) {
    const original = JSON.stringify(get());
    const changed = get();
    changed.parameters.required.push('actorId');
    changed.outputSchema.oneOf[1].properties.source.properties.context.properties.scope.required.push(
      'review',
    );
    changed.outputSchema.oneOf[1].properties.source.properties.context.properties.review.required.push(
      'permission',
    );
    assert.equal(JSON.stringify(get()), original);
  }
});
