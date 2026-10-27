import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  type JsonSchemaNode,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import { REVIEW_ACTIONS } from '@zhuma/agent-core';
import {
  NATIVE_REVIEW_TOOL,
  NATIVE_REVIEW_TOOL_VERSION,
  NATIVE_REVIEW_ERRORS,
} from './native-work-session-review-contract.js';

const string: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const object = (
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
): JsonSchemaNode => ({ type: 'object', properties, required, additionalProperties: false });
/** A fresh JSON schema, not a role/authority extension to an author descriptor. */
export function nativeReviewContextJsonSchema(): JsonSchemaNode {
  return structuredClone(
    object({
      schemaVersion: { type: 'integer', const: 1 },
      role: { type: 'string', const: 'review' },
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
      review: object({
        target: object({
          spaceId: string,
          taskId: string,
          planId: string,
          revision: integer,
          nodeId: string,
          roundId: string,
          artifactVersionId: string,
          artifactFingerprint: string,
        }),
        principal: object({
          kind: { type: 'string', const: 'expert' },
          controllerMemberId: string,
          reviewerRef: object({ id: string, version: string, digest: string }),
        }),
      }),
    }),
  );
}
const definition = {
  name: NATIVE_REVIEW_TOOL,
  sourceVersion: NATIVE_REVIEW_TOOL_VERSION,
  description:
    'Declare one independent review of the Host-bound fixed target. Submit approve, request-changes or comment with a nonempty rationale (at most 100000 characters), at most 50 byte-range anchors and 1–16 unique read references returned by successful read_review_target calls in this review Run. The entire argument JSON is limited to 120000 UTF-8 bytes, including syntax, escaping and whitespace. Its JSON arguments field plus a 16384-byte reserved envelope must fit the unchanged 262144-byte public frame. The Host rejects over-budget declarations before intent/ACK without truncation. Anchors must be within those actual returned ranges. Do not claim the whole target was read from a partial manifest. Unsupported required material prevents a decision; comment records an opinion and leaves the review obligation pending. Supply no actor, reviewer, round, target, permission or read-proof claim. This ends the native turn, not the review round: the Host separately authenticates reads, completion cut and original writer retirement before the original Service may record an idempotent ballot. Do not issue further work or tools after declaration.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['conclusion', 'rationale', 'anchors', 'evidenceRefs'],
    properties: {
      conclusion: { type: 'string', enum: [...REVIEW_ACTIONS] },
      rationale: {
        type: 'string',
        description:
          'Nonempty review reasoning, at most 100000 characters and within the total 120000-byte UTF-8 JSON argument budget.',
      },
      anchors: {
        type: 'array',
        items: object({ resourceRef: string, offset: integer, length: integer }),
        description:
          'At most 50 positive byte ranges within actual successful read pages, never character offsets.',
      },
      evidenceRefs: {
        type: 'array',
        items: string,
        description: '1–16 unique Host read references from this same independent review Run.',
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
        phase: { type: 'string', const: 'declared' },
        protocolVersion: { type: 'integer', const: 1 },
        toolVersion: { type: 'string', const: NATIVE_REVIEW_TOOL_VERSION },
        intentId: string,
        callId: string,
        digest: string,
        readManifestDigest: string,
        source: object({
          context: nativeReviewContextJsonSchema(),
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
/** Exact getter to register later; its presence does not install a tool or mint authority. */
export const describeNativeReviewTool = () => structuredClone(definition);
