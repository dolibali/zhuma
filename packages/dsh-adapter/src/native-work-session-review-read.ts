import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import {
  NATIVE_REVIEW_READ_TOOL,
  NATIVE_REVIEW_READ_TOOL_VERSION,
  NATIVE_REVIEW_ERRORS,
} from './native-work-session-review-contract.js';
import { nativeReviewContextJsonSchema } from './native-work-session-review-tool.js';

const string: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const object = (properties: Record<string, JsonSchemaNode>): JsonSchemaNode => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const definition = {
  name: NATIVE_REVIEW_READ_TOOL,
  sourceVersion: NATIVE_REVIEW_READ_TOOL_VERSION,
  description:
    'Read actual fixed-target body bytes using one resource reference from the Host review catalog. The Host binds this review Run, round, artifact and configured reviewer; none is selected by these arguments. Request a nonnegative byte offset and 1–8192 bytes. At most 16 attempts and 65536 returned body bytes are allowed per Run. Only a successful UTF-8 body page can support a completion anchor/read reference; catalog, metadata, EOF, unsupported or failed reads are not body-read evidence. Partial pages prove only their actual ranges. Report unsupported required material rather than claim it was reviewed. No paths, URLs, identities, target IDs or permission claims.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['resourceRef', 'offset', 'length'],
    properties: {
      resourceRef: {
        type: 'string',
        description: 'An exact entry from this Host-bound review resource catalog.',
      },
      offset: { type: 'integer', description: 'Nonnegative byte offset, never a character index.' },
      length: {
        type: 'integer',
        description: '1–8192 requested bytes. Only actual returned bytes are evidenced.',
      },
    },
  } satisfies ToolDefinition['parameters'],
  outputSchema: {
    oneOf: [
      object({
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...NATIVE_REVIEW_ERRORS] },
      }),
      object({
        ok: { type: 'boolean', const: true },
        protocolVersion: { type: 'integer', const: 1 },
        toolVersion: { type: 'string', const: NATIVE_REVIEW_READ_TOOL_VERSION },
        callId: string,
        readRef: string,
        source: object({
          context: nativeReviewContextJsonSchema(),
          nativeSessionId: string,
          nativeAgentId: string,
          configurationId: string,
          resourceRef: string,
          resourceFingerprint: string,
        }),
        range: object({ offset: integer, length: integer, total: integer }),
        encoding: { type: 'string', const: 'utf-8' },
        sha256: string,
        text: string,
      }),
    ],
  } satisfies JsonSchemaNode,
};
assertObjectJsonSchema(definition.parameters);
assertSupportedJsonSchema(definition.outputSchema);
/** Declaration only; actual reader/SDK registration awaits the real D lane types. */
export const describeNativeReviewReadTool = () => structuredClone(definition);
