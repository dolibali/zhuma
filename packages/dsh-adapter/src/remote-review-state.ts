import { z } from 'zod';
import {
  canonicalPayload,
  remotePermitDeclarationSchema,
  remoteReviewResultDeclarationSchema,
  remoteWorkflowBindingSchema,
} from '@zhuma/agent-core';
import type { ExecutionReviewAttempt } from './execution-review-contract.js';

const positive = z.number().int().positive().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const permit = remotePermitDeclarationSchema.extend({ epoch: z.uuid(), expiresAt: positive });
/** Metadata in the original independent-review attempt, never a second review fact store. */
export const remoteReviewBindingSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    workflow: remoteWorkflowBindingSchema.optional(),
    backendId: z.uuid(),
    deviceId: z.uuid(),
    publicKey: z.string().min(40).max(128),
    keyEpoch: positive,
    acceptRequestId: z.uuid(),
    acceptFingerprint: digest,
    memberSessionHash: digest,
    drive: permit,
    cleanup: permit,
    stopRequested: z.boolean(),
    result: remoteReviewResultDeclarationSchema.optional(),
    lastWireEvent: z.strictObject({ sequence: positive, fingerprint: digest }).optional(),
    lastObservation: z.enum(['stop-received', 'retiring', 'unknown', 'drained']).optional(),
    controls: z
      .array(
        z.strictObject({
          requestId: z.uuid(),
          fingerprint: digest,
          operation: z.enum(['stop', 'renew']),
        }),
      )
      .max(4096),
  })
  .refine(
    (value) =>
      value.drive.id !== value.cleanup.id &&
      value.drive.sha256 !== value.cleanup.sha256 &&
      new Set(value.controls.map((item) => item.requestId)).size === value.controls.length,
  );
export type RemoteReviewBinding = z.infer<typeof remoteReviewBindingSchema>;

/** The original record reader calls this after validating its original composition/receipt. */
export function remoteReviewBindingMatches(attempt: ExecutionReviewAttempt): boolean {
  if (!('remote' in attempt) || !attempt.remote) return true;
  const remote = attempt.remote,
    result = remote.result;
  if (!result) return attempt.result === undefined;
  const { review, ...scope } = attempt.scope;
  const source = result.source;
  return (
    attempt.status !== 'requested' &&
    canonicalPayload(source.context.scope) === canonicalPayload(scope) &&
    canonicalPayload(source.context.review) === canonicalPayload(review) &&
    source.nativeSessionId === attempt.nativeSessionId &&
    source.nativeAgentId === attempt.nativeAgentId &&
    source.configurationId === attempt.configurationId
  );
}
