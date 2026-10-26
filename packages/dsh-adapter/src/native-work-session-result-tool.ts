import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import {
  NATIVE_RESULT_TOOL,
  NATIVE_RESULT_TOOL_VERSION,
  NATIVE_RESULT_ERRORS,
} from './native-work-session-result-contract.js';

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
  description:
    'Declare the current work result explicitly. Text is at most 100000 characters; at most 20 safe HTTP(S) links without userinfo. No files or paths. A declaration ends this native turn; the Host separately verifies durable facts and drains resources before any task submission. Do not request more work or tools after this declaration.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['links'],
    properties: {
      text: { type: 'string', description: 'Optional result text, at most 100000 characters.' },
      links: {
        type: 'array',
        items: string,
        description:
          'At most 20 absolute HTTP(S) URLs without userinfo. Use [] when delivering text only.',
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
        protocolVersion: { type: 'integer', const: 1 },
        toolVersion: { type: 'string', const: NATIVE_RESULT_TOOL_VERSION },
        intentId: string,
        callId: string,
        digest: string,
        source: object({
          scope,
          nativeSessionId: string,
          nativeAgentId: string,
          configurationId: string,
        }),
      }),
    ],
  } satisfies JsonSchemaNode,
  sourceVersion: NATIVE_RESULT_TOOL_VERSION,
};
assertObjectJsonSchema(definition.parameters);
assertSupportedJsonSchema(definition.outputSchema);
/** Exact owned descriptor used by registration, not a parallel schema export. */
export function describeNativeResultTool() {
  return structuredClone(definition);
}
