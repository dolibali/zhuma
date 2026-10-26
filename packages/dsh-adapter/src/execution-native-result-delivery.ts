import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  submitExpertDelivery,
  submitExpertManifestDelivery,
  validateDeliveryContent,
  type ArtifactDraft,
  type ExecutionNodeRecord,
} from '@zhuma/agent-core';
import {
  NATIVE_RESULT_TOOL_VERSION,
  nativeResultContentSchema,
  nativeResultCutSchema,
} from './native-work-session-result-contract.js';
import { nativeResultDigest } from './native-work-session-result-source.js';
import {
  NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  nativeResultPublicationsContentSchema,
  type NativePublicationManifestEntry,
} from './native-work-session-result-publications-contract.js';
import {
  nativePublicationManifestDigest,
  nativeResultPublicationsDigest,
} from './native-work-session-result-publications-source.js';
import {
  ARTIFACT_FILE_LIMITS,
  artifactFileReference,
  nativeOutputFileSourceSchema,
  type UploadFileRecord,
} from './artifact-files.js';
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
export const executionNativeResultDeliveryV1Schema = z.strictObject({
  protocolVersion: z.literal(1),
  source: sourceSchema,
  digest,
  provenanceFingerprint: digest,
  receiptKey: id,
  artifactVersionId: id,
  roundId: id.optional(),
});
export const nativeResultPublicationsSourceSchema = sourceSchema.extend({
  toolVersion: z.literal(NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION),
  manifestDigest: digest,
  expertVersionId: id,
});
const publicationEvidenceSchema = z.strictObject({
  publicationId: id,
  source: nativeOutputFileSourceSchema,
  callSeq: natural,
  resultSeq: natural,
  selectorFingerprint: digest,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: natural.max(ARTIFACT_FILE_LIMITS.maxFileBytes),
  sha256: digest,
});
const deliveryV2Schema = executionNativeResultDeliveryV1Schema
  .extend({
    protocolVersion: z.literal(2),
    source: nativeResultPublicationsSourceSchema,
    manifestDigest: digest,
    publications: z
      .array(publicationEvidenceSchema)
      .max(ARTIFACT_FILE_LIMITS.maxFilesPerSubmission),
  })
  .superRefine((value, ctx) => {
    if (
      value.manifestDigest !== value.source.manifestDigest ||
      new Set(value.publications.map((item) => item.publicationId)).size !==
        value.publications.length ||
      value.publications.reduce((sum, item) => sum + item.byteSize, 0) >
        ARTIFACT_FILE_LIMITS.maxNodeBytes ||
      value.publications.some(
        (item) =>
          canonicalPayload(item.source.scope) !== canonicalPayload(value.source.scope) ||
          item.source.nativeSessionId !== value.source.nativeSessionId ||
          item.source.nativeAgentId !== value.source.nativeAgentId ||
          item.source.configurationId !== value.source.configurationId ||
          item.source.expertVersionId !== value.source.expertVersionId ||
          !(item.callSeq < item.resultSeq && item.resultSeq < value.source.cut.callSeq),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid fixed publication references.' });
  });
export const executionNativeResultDeliverySchema = z.discriminatedUnion('protocolVersion', [
  executionNativeResultDeliveryV1Schema,
  deliveryV2Schema,
]);
export type ExecutionNativeResultDelivery = z.infer<typeof executionNativeResultDeliverySchema>;
export const nativeResultSubmitSchema = z.strictObject({
  ...runLocation,
  expectedNodeVersion: natural,
  expectedRunVersion: natural,
  idempotencyKey: id,
});
export type NativeResultSubmit = z.infer<typeof nativeResultSubmitSchema>;
const nativeResultConfirmV1Schema = z.strictObject({
  ...runLocation,
  idempotencyKey: id,
  intentId: id,
  digest,
  provenanceFingerprint: digest,
});
export const nativeResultConfirmSchema = z.union([
  nativeResultConfirmV1Schema,
  nativeResultConfirmV1Schema.extend({ protocolVersion: z.literal(2), manifestDigest: digest }),
]);
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
  readonly protocolVersion?: 2;
  readonly manifestDigest?: string;
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
export const nativeResultPublicationsProofSchema = z.strictObject({
  source: nativeResultPublicationsSourceSchema,
  digest,
  provenanceFingerprint: digest,
  manifestDigest: digest,
});
type PublicationsSource = z.infer<typeof nativeResultPublicationsSourceSchema>;
type Publications = z.infer<typeof deliveryV2Schema>['publications'];
export const nativeManifestContentSchema = z
  .strictObject({
    text: z.string().max(100_000).optional(),
    links: z.array(z.string()).max(20),
    files: z
      .array(
        z.strictObject({
          id,
          mediaType: id,
          byteSize: natural.max(ARTIFACT_FILE_LIMITS.maxFileBytes),
          checksum: digest,
          accessPolicyId: id,
          uploadComplete: z.literal(true),
        }),
      )
      .max(ARTIFACT_FILE_LIMITS.maxFilesPerSubmission),
  })
  .superRefine((content, ctx) => {
    if (
      !validateDeliveryContent({
        links: content.links,
        files: content.files,
        ...(content.text === undefined ? {} : { text: content.text }),
      }).ok
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid fixed file delivery.' });
  })
  .transform(({ text, ...content }) => ({ ...content, ...(text === undefined ? {} : { text }) }));
export function nativeManifestResultDigest(
  content: ArtifactDraft,
  manifestDigest: string,
  publications: Publications,
): string {
  const selectors = nativeResultPublicationsContentSchema.safeParse({
    ...(content.text === undefined ? {} : { text: content.text }),
    links: content.links,
    publications: publications.map(({ publicationId }) => ({ publicationId })),
  });
  if (
    !selectors.success ||
    !validateDeliveryContent(content).ok ||
    canonicalPayload(selectors.data.links) !== canonicalPayload(content.links) ||
    (content.text !== undefined && selectors.data.text !== content.text)
  )
    return invalid();
  return nativeResultPublicationsDigest(selectors.data, manifestDigest);
}
/** Rebuild from the ORIGINAL ledger only. Evidence/metadata are consistency
 * checks, never a replacement for the C owner's genuine completed-cut lease.
 */
export function nativeResultManifestRecords(
  source: PublicationsSource,
  publications: Publications,
  expectedDigest: string,
  read: (id: string) => UploadFileRecord | undefined,
): readonly NativePublicationManifestEntry[] {
  const metadata = deliveryV2Schema.safeParse({
    protocolVersion: 2,
    source,
    manifestDigest: expectedDigest,
    publications,
    digest: '0'.repeat(64),
    provenanceFingerprint: '0'.repeat(64),
    receiptKey: 'check',
    artifactVersionId: 'check',
  });
  if (!metadata.success) return invalid();
  const entries = publications.map((evidence) => {
    const record = read(evidence.publicationId);
    if (
      !record ||
      record.state !== 'completed' ||
      record.uploadId !== evidence.publicationId ||
      record.uploadedBy !== source.scope.actorId ||
      record.spaceId !== source.scope.spaceId ||
      record.taskId !== source.scope.taskId ||
      record.planId !== source.scope.planId ||
      record.revision !== source.scope.revision ||
      record.nodeId !== source.scope.nodeId ||
      record.producer?.kind !== 'native-run-output' ||
      record.producer.version !== 1 ||
      canonicalPayload(record.producer.source) !== canonicalPayload(evidence.source) ||
      record.producer.selectorFingerprint !== evidence.selectorFingerprint ||
      record.name !== evidence.name ||
      record.mediaType !== evidence.mediaType ||
      record.byteSize !== evidence.byteSize ||
      record.sha256 !== evidence.sha256 ||
      record.attachmentId !== `sha256:${record.sha256}`
    )
      return invalid();
    return { evidence: structuredClone(evidence), record: structuredClone(record) };
  });
  if (nativePublicationManifestDigest(entries) !== expectedDigest) return invalid();
  return entries;
}
/** Validate an original v2 lease's files against current original ledger rows. */
export function readNativeResultManifest(
  source: PublicationsSource,
  rawManifest: unknown,
  manifestDigest: string,
  content: ArtifactDraft,
  read: (id: string) => UploadFileRecord | undefined,
): readonly NativePublicationManifestEntry[] {
  if (
    !Array.isArray(rawManifest) ||
    rawManifest.length > ARTIFACT_FILE_LIMITS.maxFilesPerSubmission
  )
    return invalid();
  const publications = rawManifest.map((entry: unknown) => {
    const parsed = z
      .strictObject({ evidence: publicationEvidenceSchema, record: z.unknown() })
      .safeParse(entry);
    if (!parsed.success) return invalid();
    return parsed.data.evidence;
  });
  const entries = nativeResultManifestRecords(source, publications, manifestDigest, read);
  if (
    canonicalPayload(entries) !== canonicalPayload(rawManifest) ||
    canonicalPayload(entries.map((entry) => artifactFileReference(entry.record))) !==
      canonicalPayload(content.files)
  )
    return invalid();
  return entries;
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
    (value.protocolVersion === 1 && artifact.files.length > 0) ||
    (artifact.text !== undefined && (!artifact.text || artifact.text.trim() !== artifact.text))
  )
    return invalid();
  if (
    value.protocolVersion === 2 &&
    (value.source.expertVersionId !== run.attempt.expertVersionId ||
      value.source.expertVersionId !== executor.ref.version ||
      canonicalPayload(artifact.files) !==
        canonicalPayload(
          value.publications.map((item) => ({
            id: item.publicationId,
            mediaType: item.mediaType,
            byteSize: item.byteSize,
            checksum: item.sha256,
            accessPolicyId: `space:${value.source.scope.spaceId}`,
            uploadComplete: true,
          })),
        ))
  )
    return invalid();
  const bodyInput = {
    ...(artifact.text === undefined ? {} : { text: artifact.text }),
    links: artifact.links,
  };
  const body =
    value.protocolVersion === 1
      ? nativeResultContentSchema.safeParse(bodyInput)
      : nativeManifestContentSchema.safeParse({ ...bodyInput, files: artifact.files });
  if (!body.success || canonicalPayload(body.data.links) !== canonicalPayload(artifact.links))
    return invalid();
  // Core omits empty text while C's fixed content may retain an explicit "".
  // The fixed digest selects that one normalized representation, without
  // parsing a receipt fingerprint or inferring any completion/source fact.
  const candidates = [
    body.data,
    ...(artifact.text === undefined ? [{ ...body.data, text: '' }] : []),
  ];
  const content = candidates.find(
    (item) =>
      (value.protocolVersion === 1
        ? nativeResultDigest(item)
        : nativeManifestResultDigest(
            { ...item, files: artifact.files },
            value.manifestDigest,
            value.publications,
          )) === value.digest,
  );
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
  const command = {
    record,
    expertId: artifact.submittedBy,
    producerRunId: run.attempt.id,
    provenanceFingerprint: value.provenanceFingerprint,
    idempotencyKey: value.receiptKey,
    expectedVersion: record.command.version,
    artifactId: artifact.id,
    roundId: value.roundId ?? 'unused-native-result-round',
  };
  const replay =
    value.protocolVersion === 1
      ? submitExpertDelivery({ ...command, draft: { ...content, files: [] } })
      : submitExpertManifestDelivery({ ...command, draft: { ...content, files: artifact.files } });
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
    ...(value.protocolVersion === 2
      ? { protocolVersion: 2 as const, manifestDigest: value.manifestDigest }
      : {}),
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
