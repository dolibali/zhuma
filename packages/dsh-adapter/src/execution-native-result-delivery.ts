import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  submitExpertDelivery,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import {
  NATIVE_RESULT_TOOL_VERSION,
  nativeResultContentSchema,
  nativeResultCutSchema,
} from './native-work-session-result-contract.js';
import { nativeResultDigest } from './native-work-session-result-source.js';
import type { ExecutionRun } from './execution-run-state.js';

const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = natural.refine((n) => n > 0);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const location = { taskId: id, planId: id, revision: positive, nodeId: id };
const runLocation = {
  ...location,
  runId: id,
  generation: positive,
  segmentId: id,
  configurationId: id,
};
const sourceSchema = z.strictObject({
  scope: z.strictObject({
    actorId: id,
    spaceId: id,
    ...location,
    runId: id,
    generation: positive,
    segmentId: id,
  }),
  nativeSessionId: id,
  nativeAgentId: id,
  configurationId: id,
  toolVersion: z.literal(NATIVE_RESULT_TOOL_VERSION),
  intentId: id,
  callId: id,
  cut: nativeResultCutSchema,
});
/** Only reference metadata in the original Run; bodies remain original artifacts. */
export const executionNativeResultDeliverySchema = z.strictObject({
  protocolVersion: z.literal(1),
  source: sourceSchema,
  digest,
  provenanceFingerprint: digest,
  receiptKey: id,
  artifactVersionId: id,
  roundId: id.optional(),
});
export type ExecutionNativeResultDelivery = z.infer<typeof executionNativeResultDeliverySchema>;
export const nativeResultSubmitSchema = z.strictObject({
  ...runLocation,
  expectedNodeVersion: natural,
  expectedRunVersion: natural,
  idempotencyKey: id,
});
export type NativeResultSubmit = z.infer<typeof nativeResultSubmitSchema>;
export const nativeResultConfirmSchema = z.strictObject({
  ...runLocation,
  idempotencyKey: id,
  intentId: id,
  digest,
  provenanceFingerprint: digest,
});
export type NativeResultConfirm = z.infer<typeof nativeResultConfirmSchema>;
export interface NativeResultDeliveryReceipt {
  readonly disposition: 'applied' | 'confirmed';
  readonly producerRunId: string;
  readonly generation: number;
  readonly segmentId: string;
  readonly configurationId: string;
  readonly intentId: string;
  readonly digest: string;
  readonly provenanceFingerprint: string;
  readonly artifactVersionId: string;
  readonly artifactVersion: number;
  readonly roundId?: string;
  readonly receipt: {
    readonly idempotencyKey: string;
    readonly version: number;
    readonly disposition: 'applied' | 'ignored';
  };
  readonly cleanup?: 'failed';
  readonly downstream?: 'pending';
}
export class NativeResultDeliveryError extends Error {
  constructor(readonly code: string = 'native-result-delivery-invalid') {
    super('固定结果交付未完成。');
    this.name = 'NativeResultDeliveryError';
  }
}
export function nativeResultProvenance(source: unknown, contentDigest: string): string {
  return createHash('sha256')
    .update(canonicalPayload({ source, digest: contentDigest }))
    .digest('hex');
}
export function nativeResultArtifactIds(input: NativeResultSubmit) {
  const key = createHash('sha256')
    .update(canonicalPayload({ kind: 'native-result-delivery', ...input }))
    .digest('hex');
  return { artifactId: `artifact:result:${key}`, roundId: `round:result:${key}` };
}
function invalid(): never {
  throw new NativeResultDeliveryError();
}
/** Validate both directions against the original node facts, including historical Runs. */
export function assertNativeResultDelivery(
  record: ExecutionNodeRecord,
  run: ExecutionRun,
): ExecutionNativeResultDelivery {
  const parsed = executionNativeResultDeliverySchema.safeParse(run.resultDelivery);
  if (!parsed.success) return invalid();
  const value = parsed.data;
  const source = value.source;
  const scope = {
    actorId: run.actorId,
    spaceId: run.spaceId,
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    nodeId: record.nodeId,
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
  };
  const executor = run.composition?.payload.executor;
  if (
    canonicalPayload(source.scope) !== canonicalPayload(scope) ||
    source.nativeSessionId !== run.attempt.sessionId ||
    source.nativeAgentId !== run.attempt.executorRunId ||
    source.configurationId !== run.selection.configurationId ||
    run.composition?.configurationId !== source.configurationId ||
    run.composition?.schemaVersion !== 2 ||
    run.composition.payload.resultIntentTool?.sourceVersion !== source.toolVersion ||
    executor?.kind !== 'plan-expert' ||
    executor.ref.id !== record.handoff.assignee.id ||
    executor.ref.version !== record.planId ||
    record.handoff.assignee.kind !== 'expert' ||
    run.attempt.status !== 'completed' ||
    run.attempt.stopPhase !== 'none' ||
    run.resources !== 'settled' ||
    value.provenanceFingerprint !== nativeResultProvenance(source, value.digest)
  )
    return invalid();
  const artifacts = record.artifactVersions.filter((item) => item.id === value.artifactVersionId);
  const receipts = record.receipts.filter((item) => item.idempotencyKey === value.receiptKey);
  const artifact = artifacts[0];
  if (
    artifacts.length !== 1 ||
    receipts.length !== 1 ||
    !artifact ||
    artifact.nodeId !== record.nodeId ||
    artifact.submittedBy !== record.handoff.assignee.id ||
    artifact.producerRunId !== run.attempt.id ||
    !Number.isSafeInteger(artifact.version) ||
    artifact.version < 1 ||
    artifact.files.length ||
    (artifact.text !== undefined && (!artifact.text || artifact.text.trim() !== artifact.text))
  )
    return invalid();
  const body = nativeResultContentSchema.safeParse({
    ...(artifact.text === undefined ? {} : { text: artifact.text }),
    links: artifact.links,
  });
  if (!body.success || canonicalPayload(body.data.links) !== canonicalPayload(artifact.links))
    return invalid();
  // Core omits empty text while C's fixed content may retain an explicit "".
  // The fixed digest selects that one normalized representation, without
  // parsing a receipt fingerprint or inferring any completion/source fact.
  const candidates = [
    body.data,
    ...(artifact.text === undefined ? [{ text: '', links: body.data.links }] : []),
  ];
  const content = candidates.find((item) => nativeResultDigest(item) === value.digest);
  if (!content) return invalid();
  if (record.handoff.reviewRequired) {
    const rounds = record.rounds.filter((item) => item.id === value.roundId);
    if (
      !value.roundId ||
      rounds.length !== 1 ||
      rounds[0]!.artifactVersionId !== artifact.id ||
      canonicalPayload([...rounds[0]!.reviewerIds].sort()) !==
        canonicalPayload([...record.handoff.reviewerIds].sort())
    )
      return invalid();
  } else if (value.roundId !== undefined) return invalid();
  const replay = submitExpertDelivery({
    record,
    expertId: artifact.submittedBy,
    producerRunId: run.attempt.id,
    provenanceFingerprint: value.provenanceFingerprint,
    idempotencyKey: value.receiptKey,
    expectedVersion: record.command.version,
    draft: { ...content, files: [] },
    artifactId: artifact.id,
    roundId: value.roundId ?? 'unused-native-result-round',
  });
  if (!replay.ok || replay.disposition !== 'replayed' || replay.record !== record) return invalid();
  return value;
}
/** Small acknowledgement: no result body or body-bearing internal fingerprint. */
export function nativeResultDeliveryReceipt(
  record: ExecutionNodeRecord,
  run: ExecutionRun,
  disposition: NativeResultDeliveryReceipt['disposition'],
): NativeResultDeliveryReceipt {
  const value = assertNativeResultDelivery(record, run);
  const artifact = record.artifactVersions.find((item) => item.id === value.artifactVersionId)!;
  const receipt = record.receipts.find((item) => item.idempotencyKey === value.receiptKey)!;
  return {
    disposition,
    producerRunId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    configurationId: value.source.configurationId,
    intentId: value.source.intentId,
    digest: value.digest,
    provenanceFingerprint: value.provenanceFingerprint,
    artifactVersionId: artifact.id,
    artifactVersion: artifact.version,
    ...(value.roundId === undefined ? {} : { roundId: value.roundId }),
    receipt: {
      idempotencyKey: receipt.idempotencyKey,
      version: receipt.version,
      disposition: receipt.disposition,
    },
  };
}
