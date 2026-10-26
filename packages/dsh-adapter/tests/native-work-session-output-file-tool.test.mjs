/** Descriptor/SDK contracts only; this never publishes, runs a model or authorizes files. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import {
  describeNativeOutputFileTool,
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
} from '../dist/native-work-session-output-file-tool.js';

test('output-file descriptor contract: the pinned SDK accepts path/name only and bounded publication metadata', () => {
  const value = describeNativeOutputFileTool();
  assert.equal(value.name, NATIVE_OUTPUT_FILE_TOOL);
  assert.equal(value.sourceVersion, NATIVE_OUTPUT_FILE_VERSION);
  assert.deepEqual(Object.keys(value.parameters.properties), ['path', 'name']);
  assert.deepEqual(value.parameters.required, ['path']);
  assert.equal(value.parameters.additionalProperties, false);
  assert.doesNotThrow(() => assertObjectJsonSchema(value.parameters));
  assert.doesNotThrow(() => assertSupportedJsonSchema(value.outputSchema));
  const success = value.outputSchema.oneOf[1];
  assert.equal(success.properties.phase.const, 'published');
  assert.equal(success.properties.source.properties.toolVersion.const, NATIVE_OUTPUT_FILE_VERSION);
  assert.equal(Object.hasOwn(success.properties, 'path'), false);
  assert.equal(Object.hasOwn(success.properties, 'data'), false);
});

test('output-file descriptor contract: consumer mutation cannot change the registered definition candidate', () => {
  const original = describeNativeOutputFileTool();
  const changed = describeNativeOutputFileTool();
  changed.parameters.required.push('actorId');
  changed.outputSchema.oneOf[1].properties.phase.const = 'completed';
  assert.deepEqual(describeNativeOutputFileTool(), original);
});
