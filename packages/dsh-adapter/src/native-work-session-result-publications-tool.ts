import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import { NATIVE_RESULT_TOOL, NATIVE_RESULT_ERRORS } from './native-work-session-result-contract.js';
import { NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION } from './native-work-session-result-publications-contract.js';

const string: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const object = (
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
): JsonSchemaNode => ({ type: 'object', properties, required, additionalProperties: false });
const scope = object({
  actorId: string,
  spaceId: string,
  taskId: string,
  planId: string,
  revision: integer,
  nodeId: string,
  runId: string,
  generation: integer,
  segmentId: string,
});
const definition = {
  name: NATIVE_RESULT_TOOL,
  sourceVersion: NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  description:
    'Declare the current work result using text, links and immutable publication selectors. Text is at most 100000 characters; links are at most 20 safe HTTP(S) URLs without userinfo; publications are at most 20 unique publicationId selectors returned by successful publish_output_file calls in this same native Run. At least one nonempty part is required. Supply no file paths, bytes, hashes, metadata or identity claims. This declaration ends the native turn; the Host independently verifies the original durable publication calls, acknowledgements and fixed file manifest, then drains resources before task submission. Do not request more work or tools after declaration.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['links', 'publications'],
    properties: {
      text: { type: 'string', description: 'Optional result text, at most 100000 characters.' },
      links: {
        type: 'array',
        items: string,
        description: 'At most 20 safe HTTP(S) URLs. Use [] when there are no links.',
      },
      publications: {
        type: 'array',
        items: object({ publicationId: string }),
        description:
          'At most 20 unique successful publication selectors from this Run. Use [] for text/link-only results.',
      },
    },
  } as ToolDefinition['parameters'],
  outputSchema: {
    oneOf: [
      object({
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...NATIVE_RESULT_ERRORS] },
      }),
      object({
        ok: { type: 'boolean', const: true },
        phase: { type: 'string', const: 'declared' },
        protocolVersion: { type: 'integer', const: 2 },
        toolVersion: { type: 'string', const: NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION },
        intentId: string,
        callId: string,
        digest: string,
        manifestDigest: string,
        source: object({
          scope,
          nativeSessionId: string,
          nativeAgentId: string,
          configurationId: string,
        }),
      }),
    ],
  } satisfies JsonSchemaNode,
};
assertObjectJsonSchema(definition.parameters);
assertSupportedJsonSchema(definition.outputSchema);
/** Explicit new opt-in descriptor; the v1 getter and old snapshots are unchanged. */
export function describeNativeResultPublicationsTool() {
  return structuredClone(definition);
}
