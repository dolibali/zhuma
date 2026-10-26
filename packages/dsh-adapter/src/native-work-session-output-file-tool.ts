import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';

export const NATIVE_OUTPUT_FILE_TOOL = 'publish_output_file';
export const NATIVE_OUTPUT_FILE_VERSION = 'zhuma-native-output-file@1';
export const NATIVE_OUTPUT_FILE_ERRORS = [
  'invalid-arguments',
  'publication-denied',
  'publication-unavailable',
  'source-changed',
  'file-too-large',
  'quota-exceeded',
  'cancelled',
  'upload-timeout',
  'conflict',
  'idempotency-mismatch',
  'not-found',
  'digest-mismatch',
] as const;
const string: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const object = (
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
): JsonSchemaNode => ({ type: 'object', properties, required, additionalProperties: false });
const source = object({
  scope: object({
    actorId: string,
    spaceId: string,
    taskId: string,
    planId: string,
    revision: integer,
    nodeId: string,
    runId: string,
    generation: integer,
    segmentId: string,
  }),
  nativeSessionId: string,
  nativeAgentId: string,
  configurationId: string,
  expertVersionId: string,
  toolVersion: { type: 'string', const: NATIVE_OUTPUT_FILE_VERSION },
  callId: string,
});
const definition = {
  name: NATIVE_OUTPUT_FILE_TOOL,
  sourceVersion: NATIVE_OUTPUT_FILE_VERSION,
  description:
    'Publish the actual bytes of one existing regular file from an explicitly Host-authorized workspace path into this task space. Supply only a relative path (at most 4096 characters) and an optional display leaf name (at most 255 characters). No absolute paths, traversal or symlinks. The Host reads and verifies up to 20 MiB, records this Run as publishing/adopting those bytes, and returns an immutable publication selector. This does not complete, submit, approve or advance the task. A selector or digest is not authorization.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: { path: string, name: string },
  } as ToolDefinition['parameters'],
  outputSchema: {
    oneOf: [
      object({
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...NATIVE_OUTPUT_FILE_ERRORS] },
      }),
      object({
        ok: { type: 'boolean', const: true },
        phase: { type: 'string', const: 'published' },
        protocolVersion: { type: 'integer', const: 1 },
        publicationId: string,
        name: string,
        mediaType: string,
        bytes: integer,
        sha256: string,
        source,
      }),
    ],
  } satisfies JsonSchemaNode,
};
assertObjectJsonSchema(definition.parameters);
assertSupportedJsonSchema(definition.outputSchema);
/** The same exact descriptor must be frozen by configuration and registered by the issuer. */
export function describeNativeOutputFileTool() {
  return structuredClone(definition);
}
