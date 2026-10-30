import { z } from 'zod';
import { readNodeHandoff, type NodeHandoff, type NodeHandoffInput } from './handoff.js';
import { validateDeliveryContent } from './delivery.js';
import { canonicalPayload } from './concurrency.js';
import { REVIEW_ACTIONS } from './review.js';
import { NODE_STATUSES } from './node-status.js';
import { MemberAssetReferenceSchema } from './member-asset-contract.js';

/** Portable data only. A decoded object is never member, device or native authority. */
export const REMOTE_RUN_PROTOCOL_VERSION = 1 as const;
export const REMOTE_RUN_RESOURCE_SOURCE_VERSION = 'zhuma-run-resources@1/dsh@0.2.1-rc.2' as const;
export const REMOTE_RUN_LIMITS = Object.freeze({
  driveTtlMs: 60_000,
  renewAfterMs: 20_000,
  httpTimeoutMs: 5_000,
  proofWindowMs: 30_000,
  cleanupTtlMs: 12 * 60 * 60 * 1000,
  requestBytes: 256 * 1024,
  snapshotBytes: 65_536,
  inputChunkBytes: 65_536,
  inputs: 100,
  devicesPerMember: 5,
  devices: 100,
  activeAuthorities: 128,
  inFlightPerDevice: 8,
  resultCharacters: 100_000,
});
const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const secret = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const version = z.literal(REMOTE_RUN_PROTOCOL_VERSION);
export const remoteNodeTargetSchema = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
});
export const remoteRunScopeSchema = remoteNodeTargetSchema.extend({
  backendId: z.uuid(),
  actorId: id,
  runId: id,
  generation: positive,
  segmentId: id,
});
export type RemoteRunScope = z.infer<typeof remoteRunScopeSchema>;
export const remoteWorkflowTargetSchema = remoteNodeTargetSchema.omit({ nodeId: true });
export type RemoteWorkflowTarget = z.infer<typeof remoteWorkflowTargetSchema>;
export const remoteWorkflowRefSchema = z.strictObject({ intentId: z.uuid(), generation: positive });
export type RemoteWorkflowRef = z.infer<typeof remoteWorkflowRefSchema>;
export const remoteWorkflowBindingSchema = remoteWorkflowRefSchema.extend({
  repairIndex: natural.max(2),
});
export type RemoteWorkflowBinding = z.infer<typeof remoteWorkflowBindingSchema>;
export const remoteWorkflowScopeSchema = remoteWorkflowTargetSchema.extend({
  actorId: id,
  deviceId: z.uuid(),
  ...remoteWorkflowRefSchema.shape,
});
export const remoteDeviceProofSchema = z.strictObject({
  issuedAt: natural,
  nonce: z.uuid(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
});
export const remotePermitDeclarationSchema = z.strictObject({ id: z.uuid(), sha256: digest });
/** Private Local Host credentials storage only. NEVER embed this value in a wire JSON body. */
export const remotePrivatePermitSchema = z.strictObject({ id: z.uuid(), secret });
export const REMOTE_RUN_PERMIT_HEADER = 'x-zhuma-remote-permit' as const;
/** SHA-256 must hash these 32 DECODED bytes, not the base64url text. */
export function remotePermitHashInput(raw: unknown): Uint8Array {
  const value = secret.parse(raw),
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(32);
  let buffer = 0,
    bits = 0,
    index = 0;
  for (const char of value) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}
export const REMOTE_RUN_PERMIT_HASH_VECTORS = Object.freeze([
  Object.freeze({
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    sha256: '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925',
  }),
  Object.freeze({
    secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    sha256: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  }),
]);
export const remotePermitViewSchema = z.strictObject({
  id: z.uuid(),
  epoch: z.uuid(),
  expiresAt: positive,
});
export const remoteModelSelectionSchema = z.strictObject({
  provider: id,
  model: id,
  reasoningEffort: id.optional(),
  maxTokens: positive.max(65_536),
});
export const remoteWorkspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({
    kind: z.literal('local'),
    rootId: id,
    grantId: id,
    generation: positive,
    access: z.enum(['read', 'write']),
  }),
]);
const reference = z.strictObject({ id, version: id });
const jsonObject = z.record(z.string(), z.json());
const localTool = z.strictObject({
  name: z.enum(['read', 'write', 'edit', 'bash']),
  description: z.string().min(1).max(4000),
  parameters: jsonObject,
  outputSchema: jsonObject,
  sourceVersion: id,
  budget: z
    .strictObject({ defaultTimeoutMs: positive, maxTimeoutMs: positive, maxAttempts: positive })
    .optional(),
});
export const remoteLocalCapabilitiesSchema = z.strictObject({
  resources: z.literal(REMOTE_RUN_RESOURCE_SOURCE_VERSION).optional(),
  acceptedInput: z.literal('1').optional(),
  acceptedFile: z.literal('zhuma-accepted-files@2').optional(),
  resultIntent: z.enum(['zhuma-native-result-intent@1', 'zhuma-native-result-intent@2']),
  outputFile: z.literal('zhuma-native-output-file@1').optional(),
  knowledge: z.literal('zhuma-native-knowledge@1').optional(),
  teamAssets: z.literal('zhuma-native-team-assets@1').optional(),
  localTools: z.array(localTool).max(4),
});
export const REMOTE_WORKFLOW_LIMITS = Object.freeze({
  intentsPerPlan: 32,
  receipts: 128,
  nodes: 512,
  bytes: 65_536,
  armTtlMs: 60_000,
  concurrent: 4,
});
const workflowPublishRange = z.strictObject({
  kind: z.enum(['file', 'directory']),
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !/[\\\u0000-\u001f\u007f]/u.test(value) &&
        !/^[a-z]:/iu.test(value) &&
        !value.includes('://') &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    ),
});
const workflowPublishRanges = z
  .array(workflowPublishRange)
  .max(16)
  .refine(
    (value) =>
      new Set(value.map((item) => `${item.kind}:${item.path}`)).size === value.length &&
      remoteJsonBytes(value) <= 4096,
  );
export const remoteWorkflowWorkspaceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text-only') }),
  z.strictObject({
    kind: z.literal('local'),
    rootId: id,
    access: z.enum(['read', 'write']),
    // Absence preserves existing signed intents; only explicit choices freeze ranges.
    publish: workflowPublishRanges.optional(),
  }),
]);
export const remoteWorkflowDefaultsSchema = z.strictObject({
  model: remoteModelSelectionSchema,
  workspace: remoteWorkflowWorkspaceSchema,
  capabilities: remoteLocalCapabilitiesSchema,
});
export const remoteWorkflowBudgetSchema = z.strictObject({
  concurrent: positive.max(REMOTE_WORKFLOW_LIMITS.concurrent).default(1),
  automaticRevisions: natural.max(2).default(2),
});
export const remoteWorkflowIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    intentId: z.uuid(),
    actorId: id,
    spaceId: id,
    deviceId: z.uuid(),
    keyEpoch: positive,
    generation: positive,
    version: positive,
    status: z.enum(['running', 'stopping']),
    defaults: remoteWorkflowDefaultsSchema,
    budget: remoteWorkflowBudgetSchema,
    nodeIds: z.array(id).min(1).max(REMOTE_WORKFLOW_LIMITS.nodes),
    commandReceipts: z
      .array(
        z.strictObject({
          requestId: z.uuid(),
          kind: z.enum(['start', 'resume', 'stop']),
          fingerprint: digest,
          generation: positive,
        }),
      )
      .min(1)
      .max(REMOTE_WORKFLOW_LIMITS.receipts),
  })
  .refine(
    (value) =>
      new Set(value.nodeIds).size === value.nodeIds.length &&
      new Set(value.commandReceipts.map((item) => item.requestId)).size ===
        value.commandReceipts.length &&
      value.commandReceipts.every((item) => item.generation <= value.generation) &&
      remoteJsonBytes(value) <= REMOTE_WORKFLOW_LIMITS.bytes,
  );
export type RemoteWorkflowIntent = z.infer<typeof remoteWorkflowIntentSchema>;
export const REMOTE_WORKFLOW_OPERATIONS = [
  'workflow-start',
  'workflow-status',
  'workflow-next',
  'workflow-resume',
  'workflow-stop',
] as const;
const cut = z
  .strictObject({ callSeq: natural, resultSeq: natural, turnEndSeq: natural, asOfSeq: natural })
  .refine(
    (value) =>
      value.callSeq < value.resultSeq &&
      value.resultSeq < value.turnEndSeq &&
      value.turnEndSeq <= value.asOfSeq,
  );
export const remoteResultSourceSchema = z
  .strictObject({
    scope: remoteRunScopeSchema.omit({ backendId: true }),
    nativeSessionId: id,
    nativeAgentId: id,
    configurationId: id,
    intentId: id,
    callId: id,
    toolVersion: z.enum(['zhuma-native-result-intent@1', 'zhuma-native-result-intent@2']),
    cut,
    manifestDigest: digest.optional(),
    expertVersionId: id.optional(),
  })
  .superRefine((value, context) => {
    const v2 = value.toolVersion === 'zhuma-native-result-intent@2';
    if (
      v2
        ? !value.manifestDigest || !value.expertVersionId
        : value.manifestDigest !== undefined || value.expertVersionId !== undefined
    )
      context.addIssue({ code: 'custom', message: 'Native result source version mismatch.' });
  });
/** Original native publisher provenance; paths and private publication grants never cross the wire. */
export const remoteNativeOutputFileSourceSchema = z.strictObject({
  scope: remoteRunScopeSchema.omit({ backendId: true }),
  nativeSessionId: id,
  nativeAgentId: id,
  configurationId: id,
  expertVersionId: id,
  toolVersion: z.literal('zhuma-native-output-file@1'),
  callId: id,
});
export const remoteNativePublicationEvidenceSchema = z
  .strictObject({
    publicationId: id,
    source: remoteNativeOutputFileSourceSchema,
    callSeq: natural,
    resultSeq: natural,
    selectorFingerprint: digest,
    name: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(200),
    byteSize: natural.max(20 * 1024 * 1024),
    sha256: digest,
  })
  .refine((value) => value.callSeq < value.resultSeq);
/** Copied only from the original private completed native-output ledger, never reconstructed by C. */
export const remoteCompletedNativeFileRecordSchema = z.strictObject({
  uploadId: id,
  attachmentId: id,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  byteSize: natural.max(20 * 1024 * 1024),
  sha256: digest,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  uploadedBy: id,
  idempotencyKey: id,
  state: z.literal('completed'),
  uploadedAt: z.string().max(1000),
  producer: z.strictObject({
    kind: z.literal('native-run-output'),
    version: z.literal(1),
    source: remoteNativeOutputFileSourceSchema,
    selectorFingerprint: digest,
  }),
});
export type RemoteCompletedNativeFileRecord = z.infer<typeof remoteCompletedNativeFileRecordSchema>;
export const remoteResultDeclarationSchema = z
  .strictObject({
    requestId: z.uuid(),
    /** The actual C native lease's digest. Never reinterpret it as a file-reference digest. */
    digest,
    /** Hash of remoteResultDigestInput after real backend upload refs are known. */
    artifactDigest: digest,
    source: remoteResultSourceSchema,
    /** Ordered original v2 selectors, attested by the registered local native owner. */
    publications: z.array(remoteNativePublicationEvidenceSchema).max(20).optional(),
  })
  .superRefine((value, context) => {
    if (
      value.source.toolVersion === 'zhuma-native-result-intent@2'
        ? !value.publications
        : value.publications !== undefined
    )
      context.addIssue({ code: 'custom', message: 'Native publication declaration mismatch.' });
    if (
      value.publications &&
      new Set(value.publications.map((item) => item.publicationId)).size !==
        value.publications.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate native publications.' });
    if (
      value.publications &&
      value.publications.reduce((sum, item) => sum + item.byteSize, 0) > 100 * 1024 * 1024
    )
      context.addIssue({ code: 'custom', message: 'Original native node file budget exceeded.' });
    if (
      value.publications?.some(
        (item) =>
          canonicalPayload(item.source.scope) !== canonicalPayload(value.source.scope) ||
          item.source.nativeSessionId !== value.source.nativeSessionId ||
          item.source.nativeAgentId !== value.source.nativeAgentId ||
          item.source.configurationId !== value.source.configurationId ||
          item.source.expertVersionId !== value.source.expertVersionId ||
          item.resultSeq >= value.source.cut.callSeq,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Publication must precede the same original fixed completion.',
      });
  });
export type RemoteResultDeclaration = z.infer<typeof remoteResultDeclarationSchema>;
const artifactFile = z.strictObject({
  id,
  mediaType: z.string().min(1).max(200),
  byteSize: natural.max(20 * 1024 * 1024),
  checksum: z.string().min(1).max(100),
  accessPolicyId: id,
  uploadComplete: z.literal(true),
});
export const remoteResultDraftSchema = z
  .strictObject({
    text: z.string().max(REMOTE_RUN_LIMITS.resultCharacters).optional(),
    links: z.array(z.string().max(2000)).max(20),
    files: z.array(artifactFile).max(20),
  })
  .superRefine((value, ctx) => {
    if (
      !validateDeliveryContent({
        files: value.files,
        links: value.links,
        ...(value.text === undefined ? {} : { text: value.text }),
      }).ok
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid fixed result.' });
  });
export type RemoteResultDraft = z.infer<typeof remoteResultDraftSchema>;
/** Hash canonicalPayload of THIS normalized value on both Hosts, using SHA-256. */
export function remoteResultDigestInput(raw: unknown): RemoteResultDraft {
  const value = remoteResultDraftSchema.parse(raw);
  return {
    ...(value.text === undefined ? {} : { text: value.text.trim() }),
    links: value.links.map((link) => link.trim()),
    files: value.files.map((file) => ({ ...file })),
  };
}
const empty = z.strictObject({});
const header = { protocolVersion: version, requestId: z.uuid() };
const deviceHeader = {
  ...header,
  backendId: z.uuid(),
  deviceId: z.uuid(),
  proof: remoteDeviceProofSchema,
};
const targetVersion = { expectedNodeVersion: natural, expectedRunVersion: natural };
/** Proof binds the public ID/hash; raw secret travels only in the private Host HTTP header. */
const authorized = { scope: remoteRunScopeSchema, permit: remotePermitDeclarationSchema };
/** Dedicated binary/check endpoint; deliberately absent from the automatic
 * generic JSON operation map. Uses the same original device signing domain. */
export const REMOTE_TEAM_ASSET_FILE_METHOD = 'zhuma-remote-run/team-asset-file' as const;
export const REMOTE_TEAM_ASSET_FILE_PATH = `/api/${REMOTE_TEAM_ASSET_FILE_METHOD}` as const;
export const remoteTeamAssetFileReadRequestSchema = z.strictObject({
  ...deviceHeader,
  operation: z.literal('team-asset-file'),
  payload: z.strictObject({
    ...authorized,
    mode: z.enum(['read', 'check']),
    reference: MemberAssetReferenceSchema.refine((value) => value.kind === 'file'),
  }),
});
export type RemoteTeamAssetFileReadRequest = z.infer<typeof remoteTeamAssetFileReadRequestSchema>;
const eventLocation = { sequence: positive };
const drained = {
  idle: z.literal(true),
  flushed: z.literal(true),
  resourcesSettled: z.literal(true),
};
export const remoteRunEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventLocation, kind: z.literal('received'), nativeSessionId: id }),
  z.strictObject({
    ...eventLocation,
    kind: z.literal('accepted'),
    nativeSessionId: id,
    executorRunId: id,
  }),
  z.strictObject({ ...eventLocation, kind: z.literal('dispatch-unknown') }),
  z.strictObject({ ...eventLocation, kind: z.literal('idle') }),
  z.strictObject({ ...eventLocation, kind: z.literal('waiting') }),
  z.strictObject({ ...eventLocation, kind: z.literal('resumed') }),
  z.strictObject({ ...eventLocation, kind: z.literal('stop-received') }),
  z.strictObject({ ...eventLocation, kind: z.literal('retiring') }),
  z.strictObject({ ...eventLocation, kind: z.literal('stopped'), ...drained }),
  z.strictObject({
    ...eventLocation,
    kind: z.literal('completed'),
    ...drained,
    result: remoteResultDeclarationSchema,
  }),
  z.strictObject({
    ...eventLocation,
    kind: z.literal('failed'),
    resourcesSettled: z.literal(false),
  }),
]);
export type RemoteRunEvent = z.infer<typeof remoteRunEventSchema>;
export const remoteCleanupObservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventLocation, kind: z.literal('stop-received') }),
  z.strictObject({ ...eventLocation, kind: z.literal('retiring') }),
  z.strictObject({ ...eventLocation, kind: z.literal('unknown') }),
  z.strictObject({
    ...eventLocation,
    kind: z.literal('drained'),
    evidence: z.discriminatedUnion('basis', [
      z.strictObject({
        basis: z.literal('flushed-and-closed'),
        nativeSessionId: id,
        nativeAgentId: id,
      }),
      z.strictObject({ basis: z.literal('absent-unadmitted') }),
    ]),
  }),
]);
const info = z.strictObject({
  ...header,
  operation: z.literal('info'),
  payload: z.strictObject({ workflow: z.literal('zhuma-remote-workflow@1').optional() }),
});
const workflowStart = z.strictObject({
  ...deviceHeader,
  operation: z.literal('workflow-start'),
  payload: z.strictObject({
    target: remoteWorkflowTargetSchema,
    defaults: remoteWorkflowDefaultsSchema,
    budget: remoteWorkflowBudgetSchema.default({ concurrent: 1, automaticRevisions: 2 }),
  }),
});
const workflowControlPayload = z.strictObject({
  target: remoteWorkflowTargetSchema,
  workflow: remoteWorkflowRefSchema,
});
const workflowStatus = z.strictObject({
  ...deviceHeader,
  operation: z.literal('workflow-status'),
  payload: workflowControlPayload.extend({ workflow: remoteWorkflowRefSchema.optional() }),
});
const workflowNext = z.strictObject({
  ...deviceHeader,
  operation: z.literal('workflow-next'),
  payload: workflowControlPayload,
});
const workflowStop = z.strictObject({
  ...deviceHeader,
  operation: z.literal('workflow-stop'),
  payload: workflowControlPayload,
});
const workflowResume = z.strictObject({
  ...deviceHeader,
  operation: z.literal('workflow-resume'),
  payload: workflowControlPayload.extend({
    expectedVersion: positive,
    defaults: remoteWorkflowDefaultsSchema.optional(),
  }),
});
const register = z.strictObject({
  ...deviceHeader,
  operation: z.literal('register-device'),
  payload: z.strictObject({
    publicKey: z
      .string()
      .min(40)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    displayName: z.string().min(1).max(80).optional(),
  }),
});
const accept = z.strictObject({
  ...deviceHeader,
  operation: z.literal('accept'),
  payload: z.strictObject({
    target: remoteNodeTargetSchema,
    ...targetVersion,
    purpose: z.literal('work'),
    mode: z.enum(['begin', 'retry', 'restart']),
    model: remoteModelSelectionSchema,
    workspace: remoteWorkspaceSchema,
    executor: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('builtin') }),
      z.strictObject({ kind: z.literal('plan-expert'), ref: reference }),
    ]),
    capabilities: remoteLocalCapabilitiesSchema,
    credentials: z.strictObject({
      drive: remotePermitDeclarationSchema,
      cleanup: remotePermitDeclarationSchema,
    }),
    workflow: remoteWorkflowRefSchema.optional(),
  }),
});
const status = z.strictObject({
  ...deviceHeader,
  operation: z.literal('status'),
  payload: z.strictObject(authorized),
});
const renew = z.strictObject({
  ...deviceHeader,
  operation: z.literal('renew'),
  payload: z.strictObject(authorized),
});
const event = z.strictObject({
  ...deviceHeader,
  operation: z.literal('event'),
  payload: z.strictObject({ ...authorized, event: remoteRunEventSchema }),
});
const stop = z.strictObject({
  ...header,
  backendId: z.uuid(),
  operation: z.literal('stop'),
  payload: z.strictObject({ scope: remoteRunScopeSchema, ...targetVersion }),
});
const cleanup = z.strictObject({
  ...deviceHeader,
  operation: z.literal('cleanup'),
  payload: z.strictObject({ ...authorized, observation: remoteCleanupObservationSchema }),
});
const reconcile = z.strictObject({
  ...deviceHeader,
  operation: z.literal('reconcile'),
  payload: z.union([
    z.strictObject({
      ...authorized,
      lastSequence: natural,
      resultRequestId: z.uuid().optional(),
      nativeSessionId: id.optional(),
      nativeAgentId: id.optional(),
    }),
    z.strictObject({
      target: remoteNodeTargetSchema,
      acceptRequestId: z.uuid(),
      permit: remotePermitDeclarationSchema,
    }),
  ]),
});
const result = z.strictObject({
  ...deviceHeader,
  operation: z.literal('submit-result'),
  payload: z.strictObject({
    ...authorized,
    expectedNodeVersion: natural,
    result: remoteResultDeclarationSchema,
    draft: remoteResultDraftSchema,
  }),
});
const resultStatus = z.strictObject({
  ...deviceHeader,
  operation: z.literal('result-status'),
  payload: z.strictObject({ ...authorized, resultRequestId: z.uuid() }),
});
const inputs = z.strictObject({
  ...deviceHeader,
  operation: z.literal('input-list'),
  payload: z.strictObject(authorized),
});
const input = z.strictObject({
  ...deviceHeader,
  operation: z.literal('input-read'),
  payload: z.strictObject({
    ...authorized,
    slotId: id,
    offset: natural,
    maximumBytes: positive.max(REMOTE_RUN_LIMITS.inputChunkBytes),
  }),
});
const publication = z.strictObject({
  ...deviceHeader,
  operation: z.literal('publish-file'),
  payload: z.discriminatedUnion('mode', [
    z.strictObject({
      ...authorized,
      mode: z.literal('lookup'),
      idempotencyKey: id,
      source: remoteNativeOutputFileSourceSchema,
      selectorFingerprint: digest,
      name: z.string().min(1).max(255),
    }),
    z.strictObject({
      ...authorized,
      mode: z.literal('reserve'),
      idempotencyKey: id,
      source: remoteNativeOutputFileSourceSchema,
      selectorFingerprint: digest,
      name: z.string().min(1).max(255),
      maximumBytes: natural.max(20 * 1024 * 1024),
    }),
    z.strictObject({
      ...authorized,
      mode: z.literal('publish'),
      reservationId: z.uuid(),
      declare: z.strictObject({
        name: z.string().min(1).max(255),
        mediaType: z.string().min(1).max(200),
        byteSize: natural.max(20 * 1024 * 1024),
        sha256: digest,
      }),
    }),
  ]),
});
const fileStatus = z.strictObject({
  ...deviceHeader,
  operation: z.literal('file-status'),
  payload: z.union([
    z.strictObject({ ...authorized, idempotencyKey: id }),
    z.strictObject({
      ...authorized,
      source: remoteNativeOutputFileSourceSchema,
      publicationId: id,
    }),
    z.strictObject({ ...authorized, reservationId: z.uuid() }),
  ]),
});
const abandonFile = z.strictObject({
  ...deviceHeader,
  operation: z.literal('abandon-file'),
  /** C sends only after its original releaseAfter drain; this does not revoke a completed ledger row. */
  payload: z.strictObject({ ...authorized, reservationId: z.uuid() }),
});
export const remoteRunRequestSchema = z.discriminatedUnion('operation', [
  info,
  register,
  accept,
  status,
  renew,
  event,
  stop,
  cleanup,
  reconcile,
  result,
  resultStatus,
  inputs,
  input,
  publication,
  fileStatus,
  abandonFile,
  workflowStart,
  workflowStatus,
  workflowNext,
  workflowResume,
  workflowStop,
]);
export type RemoteRunRequest = z.infer<typeof remoteRunRequestSchema>;
export type RemoteDeviceRequest = Exclude<RemoteRunRequest, { operation: 'info' | 'stop' }>;
export type RemoteAcceptRequest = Extract<RemoteRunRequest, { operation: 'accept' }>;
/** Sign exactly this parsed value; method/body substitution cannot borrow a proof. */
export function remoteDeviceSigningInput(
  request: Omit<RemoteDeviceRequest | RemoteTeamAssetFileReadRequest, 'proof'> & {
    readonly proof: {
      readonly issuedAt: number;
      readonly nonce: string;
      readonly signature?: string | undefined;
    };
  },
) {
  const { signature: _signature, ...proof } = request.proof;
  return { ...request, proof };
}
export const REMOTE_RUN_ERRORS = [
  'remote-validation',
  'remote-protocol-unsupported',
  'remote-unauthenticated',
  'remote-not-found',
  'remote-forbidden',
  'remote-device-unavailable',
  'remote-device-mismatch',
  'remote-proof-invalid',
  'remote-proof-expired',
  'remote-permit-expired',
  'remote-permit-revoked',
  'remote-scope-mismatch',
  'remote-stale-plan',
  'remote-conflict',
  'remote-sequence-gap',
  'remote-event-stale',
  'remote-idempotency-mismatch',
  'remote-resource-held',
  'remote-recovery-required',
  'remote-input-stale',
  'remote-quota',
  'remote-unavailable',
] as const;
export type RemoteRunErrorCode = (typeof REMOTE_RUN_ERRORS)[number];
export type RemoteRunResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: RemoteRunErrorCode } };
export interface RemoteBackendInfo {
  readonly protocolVersion: 1;
  readonly backendId: string;
  readonly serverTime: number;
  readonly actorId: string;
  readonly purposes: readonly ('work' | 'review')[];
  readonly operations: readonly RemoteRunOperation[];
}
export const remoteInputDescriptorSchema = z.strictObject({
  slotId: id,
  kind: z.enum(['text', 'file', 'resource']),
  name: z.string().max(255),
  sourceNodeId: id.optional(),
  artifactVersionId: id.optional(),
  fileId: id.optional(),
  resourceRef: reference.optional(),
  relativePath: z
    .string()
    .max(1000)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value.includes('\0') &&
        !/^[A-Za-z]:/u.test(value) &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    )
    .optional(),
  byteSize: natural,
  sha256: digest,
});
export type RemoteInputDescriptor = z.infer<typeof remoteInputDescriptorSchema>;
export const remoteRunSharedSnapshotSchema = z.strictObject({
  configurationId: id,
  /** Exact original FrozenExecutionRunComposition JSON. C MUST use its original decoder. */
  composition: z
    .record(z.string(), z.json())
    .refine((value) => remoteJsonBytes(value) <= REMOTE_RUN_LIMITS.snapshotBytes),
  context: z.string().max(REMOTE_RUN_LIMITS.snapshotBytes),
  handoff: z.custom<NodeHandoff>((value) => {
    try {
      return readNodeHandoff(value as NodeHandoffInput).ok;
    } catch {
      return false;
    }
  }),
  inputs: z.array(remoteInputDescriptorSchema).max(REMOTE_RUN_LIMITS.inputs),
});
export type RemoteRunSharedSnapshot = z.infer<typeof remoteRunSharedSnapshotSchema>;
/** Original immutable predecessor facts only; this is not native migration authority. */
export const remoteRunMigrationSchema = z
  .strictObject({
    requestId: z.uuid(),
    inputFingerprint: digest,
    predecessors: z
      .array(
        z.strictObject({
          scope: remoteRunScopeSchema,
          selection: remoteModelSelectionSchema.extend({ configurationId: id }),
          deviceId: z.uuid(),
          keyEpoch: positive,
          runStatus: z.enum(['completed', 'failed', 'cancelled']),
          resources: z.literal('settled'),
          dispatch: z.enum(['reserved', 'received', 'unknown']),
          acknowledged: z.boolean(),
          nativeSessionId: id.optional(),
          nativeAgentId: id.optional(),
          sessionDiscarded: z.literal(true).optional(),
        }),
      )
      .min(1)
      .max(63),
  })
  .refine((value) => remoteJsonBytes(value) <= REMOTE_RUN_LIMITS.snapshotBytes);
export type RemoteRunMigration = z.infer<typeof remoteRunMigrationSchema>;
export interface RemoteRunView {
  readonly scope: RemoteRunScope;
  readonly deviceId: string;
  readonly serverTime: number;
  readonly authority: 'drive' | 'commit-only' | 'cleanup-only' | 'recovery-required';
  readonly permit: z.infer<typeof remotePermitViewSchema>;
  readonly cleanup: z.infer<typeof remotePermitViewSchema>;
  readonly nodeVersion: number;
  readonly migration?: RemoteRunMigration | undefined;
  readonly runVersion: number;
  readonly nextSequence: number;
  readonly stopRequested: boolean;
  readonly cleanupPhase?: 'stop-received' | 'retiring' | 'unknown' | 'drained' | undefined;
  readonly resources: 'held' | 'settled';
  readonly runStatus:
    'requested' | 'running' | 'waiting-for-input' | 'completed' | 'failed' | 'cancelled';
  readonly result?: RemoteResultDeclaration | undefined;
  readonly receipt?: RemoteResultReceipt | undefined;
}
export interface RemoteAcceptValue extends RemoteRunView {
  readonly disposition: 'accepted' | 'replayed';
  readonly shared: RemoteRunSharedSnapshot;
  readonly selection: z.infer<typeof remoteModelSelectionSchema> & {
    readonly configurationId: string;
  };
}
/** Exact saved snapshot for recovery; this is neither a new accept nor drive permission. */
export interface RemoteReconcileValue extends RemoteRunView {
  readonly authority: 'commit-only' | 'cleanup-only' | 'recovery-required';
  readonly shared: RemoteRunSharedSnapshot;
  readonly selection: RemoteAcceptValue['selection'];
}
export interface RemoteResultReceipt {
  readonly requestId: string;
  readonly digest: string;
  readonly artifactDigest: string;
  readonly artifactVersionId: string;
  readonly roundId?: string | undefined;
}
export type RemoteRunOperation = RemoteRunRequest['operation'];
export interface RemoteDeviceValue {
  readonly deviceId: string;
  readonly actorId: string;
  readonly keyEpoch: number;
  readonly disposition: 'enrolled' | 'replayed';
  readonly serverTime: number;
}
export type RemoteFileValue = z.infer<typeof remoteFileValueSchema>;
/** Private process-owned I/O reservation, never an upload/publication receipt. */
export type RemoteFileReservationValue = z.infer<typeof remoteFileReservationValueSchema>;
export interface RemoteRunOperationValues {
  readonly 'workflow-start': RemoteWorkflowView;
  readonly 'workflow-status': RemoteWorkflowView;
  readonly 'workflow-next': RemoteWorkflowView;
  readonly 'workflow-resume': RemoteWorkflowView;
  readonly 'workflow-stop': RemoteWorkflowView;
  readonly info: RemoteBackendInfo;
  readonly 'register-device': RemoteDeviceValue;
  readonly accept: RemoteAcceptValue;
  readonly status: RemoteRunView;
  readonly renew: RemoteRunView;
  readonly event: RemoteRunView & { readonly disposition: 'applied' | 'replayed' };
  readonly stop: RemoteRunView & { readonly disposition: 'applied' | 'replayed' };
  readonly cleanup: RemoteRunView & { readonly disposition: 'applied' | 'replayed' };
  readonly reconcile: RemoteReconcileValue;
  readonly 'input-list': {
    readonly scope: RemoteRunScope;
    readonly items: readonly RemoteInputDescriptor[];
  };
  readonly 'input-read': {
    readonly scope: RemoteRunScope;
    readonly slotId: string;
    readonly offset: number;
    readonly byteSize: number;
    readonly totalBytes: number;
    readonly sha256: string;
    readonly base64: string;
    readonly eof: boolean;
  };
  readonly 'publish-file': z.infer<(typeof remoteRunValueSchemas)['publish-file']>;
  readonly 'file-status': z.infer<(typeof remoteRunValueSchemas)['file-status']>;
  readonly 'abandon-file': z.infer<(typeof remoteRunValueSchemas)['abandon-file']>;
  readonly 'submit-result': {
    readonly scope: RemoteRunScope;
    readonly disposition: 'committed' | 'replayed';
    readonly receipt: RemoteResultReceipt;
  };
  readonly 'result-status': {
    readonly scope: RemoteRunScope;
    readonly status: 'none' | 'committed';
    readonly receipt?: RemoteResultReceipt | undefined;
  };
}
export type RemoteRunOperationValue<Operation extends RemoteRunOperation> =
  RemoteRunOperationValues[Operation];
export const REMOTE_RUN_OPERATIONS: readonly RemoteRunOperation[] = Object.freeze(
  remoteRunRequestSchema.options.map((schema) => schema.shape.operation.value),
);
export const REMOTE_RUN_EVENT_KINDS: readonly RemoteRunEvent['kind'][] = Object.freeze(
  remoteRunEventSchema.options.map((schema) => schema.shape.kind.value),
);

/** Pure UTF-8 size bound; no filesystem, network or Node runtime dependency. */
function remoteJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < json.length; index++) {
    const point = json.codePointAt(index)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (point > 0xffff) index++;
  }
  return bytes;
}
export const remoteResultReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  digest,
  artifactDigest: digest,
  artifactVersionId: id,
  roundId: id.optional(),
});
export const remoteBackendInfoSchema = z.strictObject({
  protocolVersion: version,
  backendId: z.uuid(),
  actorId: id,
  serverTime: natural,
  purposes: z
    .array(z.enum(['work', 'review']))
    .max(2)
    .refine((values) => new Set(values).size === values.length),
  operations: z.array(z.enum(REMOTE_RUN_OPERATIONS)).max(32),
});
export const remoteDeviceValueSchema = z.strictObject({
  deviceId: z.uuid(),
  actorId: id,
  keyEpoch: positive,
  disposition: z.enum(['enrolled', 'replayed']),
  serverTime: natural,
});
export const remoteRunViewSchema = z
  .strictObject({
    scope: remoteRunScopeSchema,
    deviceId: z.uuid(),
    serverTime: natural,
    authority: z.enum(['drive', 'commit-only', 'cleanup-only', 'recovery-required']),
    permit: remotePermitViewSchema,
    cleanup: remotePermitViewSchema,
    nodeVersion: natural,
    migration: remoteRunMigrationSchema.optional(),
    runVersion: positive,
    nextSequence: positive,
    stopRequested: z.boolean(),
    cleanupPhase: z.enum(['stop-received', 'retiring', 'unknown', 'drained']).optional(),
    resources: z.enum(['held', 'settled']),
    runStatus: z.enum([
      'requested',
      'running',
      'waiting-for-input',
      'completed',
      'failed',
      'cancelled',
    ]),
    result: remoteResultDeclarationSchema.optional(),
    receipt: remoteResultReceiptSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.authority === 'drive' &&
      (value.stopRequested ||
        value.resources !== 'held' ||
        ['completed', 'failed', 'cancelled'].includes(value.runStatus))
    )
      context.addIssue({ code: 'custom', message: 'A terminal or fenced Run cannot drive.' });
    if (
      value.authority === 'commit-only' &&
      (value.stopRequested ||
        value.resources !== 'settled' ||
        value.runStatus !== 'completed' ||
        !value.result)
    )
      context.addIssue({
        code: 'custom',
        message: 'Result continuation requires the exact completed declaration.',
      });
  });
export const remoteAcceptValueSchema = remoteRunViewSchema.safeExtend({
  disposition: z.enum(['accepted', 'replayed']),
  shared: remoteRunSharedSnapshotSchema,
  selection: remoteModelSelectionSchema.extend({ configurationId: id }),
});
export const remoteReconcileValueSchema = remoteRunViewSchema.safeExtend({
  authority: z.enum(['commit-only', 'cleanup-only', 'recovery-required']),
  shared: remoteRunSharedSnapshotSchema,
  selection: remoteAcceptValueSchema.shape.selection,
});
const changedView = remoteRunViewSchema.safeExtend({
  disposition: z.enum(['applied', 'replayed']),
});
export const remoteFileValueSchema = z
  .strictObject({
    scope: remoteRunScopeSchema,
    uploadId: id,
    idempotencyKey: id,
    status: z.enum(['pending', 'completed', 'abandoned']),
    file: artifactFile.optional(),
    record: remoteCompletedNativeFileRecordSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== 'completed') {
      if (value.file || value.record)
        ctx.addIssue({
          code: 'custom',
          message: 'Only a completed upload returns a native record.',
        });
      return;
    }
    const file = value.file,
      record = value.record;
    const { backendId: _backend, ...scope } = value.scope;
    if (
      !file ||
      !record ||
      file.id !== record.uploadId ||
      value.uploadId !== record.uploadId ||
      value.idempotencyKey !== record.idempotencyKey ||
      record.attachmentId !== `sha256:${record.sha256}` ||
      record.uploadedBy !== scope.actorId ||
      record.spaceId !== scope.spaceId ||
      record.taskId !== scope.taskId ||
      record.planId !== scope.planId ||
      record.revision !== scope.revision ||
      record.nodeId !== scope.nodeId ||
      canonicalPayload(record.producer.source.scope) !== canonicalPayload(scope) ||
      file.mediaType !== record.mediaType ||
      file.byteSize !== record.byteSize ||
      file.checksum !== record.sha256 ||
      file.accessPolicyId !== `space:${scope.spaceId}`
    )
      ctx.addIssue({
        code: 'custom',
        message: 'The actual native receipt and file reference must agree.',
      });
  });
export const remoteFileReservationValueSchema = z.strictObject({
  scope: remoteRunScopeSchema,
  reservationId: z.uuid(),
  idempotencyKey: id,
  status: z.enum(['reserved', 'released']),
  maximumBytes: natural.max(20 * 1024 * 1024),
});
export const remoteFileLookupValueSchema = z.strictObject({
  scope: remoteRunScopeSchema,
  idempotencyKey: id,
  status: z.literal('absent'),
});
const publicationValue = z.union([
  remoteFileValueSchema,
  remoteFileReservationValueSchema,
  remoteFileLookupValueSchema,
]);
const resultValue = z.strictObject({
  scope: remoteRunScopeSchema,
  disposition: z.enum(['committed', 'replayed']),
  receipt: remoteResultReceiptSchema,
});
const resultStatusValue = z.strictObject({
  scope: remoteRunScopeSchema,
  status: z.enum(['none', 'committed']),
  receipt: remoteResultReceiptSchema.optional(),
});
const inputListValue = z.strictObject({
  scope: remoteRunScopeSchema,
  items: z.array(remoteInputDescriptorSchema).max(100),
});
const inputReadValue = z
  .strictObject({
    scope: remoteRunScopeSchema,
    slotId: id,
    offset: natural,
    byteSize: natural.max(REMOTE_RUN_LIMITS.inputChunkBytes),
    totalBytes: natural,
    sha256: digest,
    base64: z.string().max(4 * Math.ceil(REMOTE_RUN_LIMITS.inputChunkBytes / 3)),
    eof: z.boolean(),
  })
  .refine(
    (value) =>
      value.offset + value.byteSize <= value.totalBytes &&
      value.eof === (value.offset + value.byteSize === value.totalBytes),
  );
export const remoteWorkflowCandidateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('work'),
    target: remoteNodeTargetSchema,
    expectedNodeVersion: natural,
    expectedRunVersion: natural,
    mode: accept.shape.payload.shape.mode,
    executor: accept.shape.payload.shape.executor,
    workflow: remoteWorkflowRefSchema,
    repairIndex: natural.max(2),
  }),
  z.strictObject({
    kind: z.literal('review'),
    target: z.lazy(() => remoteReviewTargetSchema),
    expectedReviewVersion: natural,
    reviewerRef: z.lazy(() => remoteReviewPrincipalSchema.shape.reviewerRef),
    workflow: remoteWorkflowRefSchema,
  }),
]);
export type RemoteWorkflowCandidate = z.infer<typeof remoteWorkflowCandidateSchema>;
const remoteWorkflowActiveViewSchema = z
  .strictObject({
    disposition: z.enum(['applied', 'replayed', 'unchanged']),
    scope: remoteWorkflowScopeSchema,
    intent: remoteWorkflowIntentSchema,
    state: z.enum(['running', 'waiting', 'stopping', 'paused', 'requires-resume', 'completed']),
    requiresResume: z.boolean(),
    serverTime: natural,
    expiresAt: positive.optional(),
    activeWork: z.array(remoteRunViewSchema).max(REMOTE_WORKFLOW_LIMITS.nodes),
    activeReviews: z
      .array(z.lazy(() => remoteReviewRunViewSchema))
      .max(REMOTE_WORKFLOW_LIMITS.nodes),
    candidates: z.array(remoteWorkflowCandidateSchema).max(REMOTE_WORKFLOW_LIMITS.concurrent),
    attention: z.array(z.strictObject({ nodeId: id, code: id })).max(REMOTE_WORKFLOW_LIMITS.nodes),
    // Read-only original Run projection. Optional for earlier view producers;
    // used counts initiated rework attempts, never votes or successful results.
    revisions: z
      .array(
        z.strictObject({
          nodeId: id,
          used: natural.max(2),
          limit: natural.max(2),
        }),
      )
      .max(REMOTE_WORKFLOW_LIMITS.nodes)
      .optional(),
  })
  .refine((value) => {
    const sameTarget = (target: RemoteWorkflowTarget) =>
      target.spaceId === value.scope.spaceId &&
      target.taskId === value.scope.taskId &&
      target.planId === value.scope.planId &&
      target.revision === value.scope.revision;
    return (
      value.scope.actorId === value.intent.actorId &&
      value.scope.deviceId === value.intent.deviceId &&
      value.scope.spaceId === value.intent.spaceId &&
      value.scope.intentId === value.intent.intentId &&
      value.scope.generation === value.intent.generation &&
      value.requiresResume === (value.state === 'requires-resume') &&
      (value.revisions === undefined ||
        (new Set(value.revisions.map((item) => item.nodeId)).size === value.revisions.length &&
          value.revisions.every(
            (item) =>
              value.intent.nodeIds.includes(item.nodeId) &&
              item.limit === value.intent.budget.automaticRevisions &&
              item.used <= item.limit,
          ))) &&
      (!value.candidates.length ||
        (!value.requiresResume && (value.state === 'running' || value.state === 'waiting'))) &&
      value.candidates.every(
        (candidate) =>
          sameTarget(candidate.target) &&
          value.intent.nodeIds.includes(candidate.target.nodeId) &&
          candidate.workflow.intentId === value.intent.intentId &&
          candidate.workflow.generation === value.intent.generation,
      ) &&
      [...value.activeWork, ...value.activeReviews].every(
        (item) =>
          sameTarget(item.scope) &&
          item.scope.actorId === value.scope.actorId &&
          item.deviceId === value.scope.deviceId,
      )
    );
  });
export const remoteWorkflowViewSchema = z.union([
  remoteWorkflowActiveViewSchema,
  z.strictObject({
    disposition: z.literal('unchanged'),
    scope: remoteWorkflowTargetSchema.extend({ actorId: id, deviceId: z.uuid() }),
    intent: z.null(),
    state: z.literal('inactive'),
    requiresResume: z.literal(false),
    serverTime: natural,
    activeWork: z.array(remoteRunViewSchema).max(0),
    activeReviews: z.array(z.lazy(() => remoteReviewRunViewSchema)).max(0),
    candidates: z.array(remoteWorkflowCandidateSchema).max(0),
    attention: z.array(z.strictObject({ nodeId: id, code: id })).max(0),
  }),
]);
export type RemoteWorkflowView = z.infer<typeof remoteWorkflowViewSchema>;

export const remoteRunValueSchemas = Object.freeze({
  'workflow-start': remoteWorkflowViewSchema,
  'workflow-status': remoteWorkflowViewSchema,
  'workflow-next': remoteWorkflowViewSchema,
  'workflow-resume': remoteWorkflowViewSchema,
  'workflow-stop': remoteWorkflowViewSchema,
  info: remoteBackendInfoSchema,
  'register-device': remoteDeviceValueSchema,
  accept: remoteAcceptValueSchema,
  status: remoteRunViewSchema,
  renew: remoteRunViewSchema,
  event: changedView,
  stop: changedView,
  cleanup: changedView,
  reconcile: remoteReconcileValueSchema,
  'input-list': inputListValue,
  'input-read': inputReadValue,
  'publish-file': publicationValue,
  'file-status': publicationValue,
  'abandon-file': remoteFileReservationValueSchema.extend({ status: z.literal('released') }),
  'submit-result': resultValue,
  'result-status': resultStatusValue,
});
export const remoteRunErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: z.enum(REMOTE_RUN_ERRORS) }),
});
export function remoteRunResponseSchema(operation: RemoteRunOperation) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value: remoteRunValueSchemas[operation] }),
    remoteRunErrorSchema,
  ]);
}

/** Independent review carriers mirror the original fixed-target/reviewer/cut data.
 * Their purpose marker is signed. None can be promoted to an author grant. */
export const REMOTE_REVIEW_WIRE_LIMITS = Object.freeze({
  reads: 16,
  readBytes: 65_536,
  pageBytes: 8192,
  resources: 64,
  anchors: 50,
  argumentBytes: 120_000,
  publicFrameBytes: 262_144,
  frameEnvelopeBytes: 16_384,
});
const reviewId = id.refine((value) => value.trim() === value);
const reviewArtifactId = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => value.trim() === value);
export const remoteReviewTargetSchema = remoteNodeTargetSchema.extend({
  spaceId: reviewId,
  taskId: reviewId,
  planId: reviewId,
  nodeId: reviewId,
  roundId: reviewArtifactId,
  artifactVersionId: reviewArtifactId,
  artifactFingerprint: digest,
});
export const remoteReviewPrincipalSchema = z.strictObject({
  kind: z.literal('expert'),
  controllerMemberId: reviewId,
  reviewerRef: z.strictObject({ id: reviewId, version: reviewId, digest }),
});
export const remoteReviewBindingSchema = z.strictObject({
  target: remoteReviewTargetSchema,
  principal: remoteReviewPrincipalSchema,
});
function reviewBindingMatches(
  scope: Omit<RemoteRunScope, 'backendId'>,
  binding: z.infer<typeof remoteReviewBindingSchema>,
): boolean {
  return (
    scope.actorId === binding.principal.controllerMemberId &&
    scope.spaceId === binding.target.spaceId &&
    scope.taskId === binding.target.taskId &&
    scope.planId === binding.target.planId &&
    scope.revision === binding.target.revision &&
    scope.nodeId === binding.target.nodeId &&
    binding.principal.reviewerRef.version === scope.planId
  );
}
export const remoteReviewScopeSchema = remoteRunScopeSchema
  .extend({ review: remoteReviewBindingSchema })
  .refine((scope) => reviewBindingMatches(scope, scope.review));
export type RemoteReviewScope = z.infer<typeof remoteReviewScopeSchema>;
/** Current member discovery only. These facts are neither a reservation nor local drive authority. */
export const localReviewOptionsQuerySchema = remoteReviewTargetSchema.omit({
  artifactFingerprint: true,
});
export type LocalReviewOptionsQuery = z.infer<typeof localReviewOptionsQuerySchema>;
/** Passive fixed-round facts, including closed rounds; never review admission. */
export const reviewOutcomeQuerySchema = localReviewOptionsQuerySchema;
export type ReviewOutcomeQuery = z.infer<typeof reviewOutcomeQuerySchema>;
export const reviewOutcomeSchema = z
  .strictObject({
    controllerMemberId: reviewId,
    target: remoteReviewTargetSchema,
    nodeStatus: z.enum(NODE_STATUSES),
    artifact: z.strictObject({
      id: reviewId,
      version: positive,
      text: z.string().optional(),
      links: z.array(z.string()),
      files: z.array(z.strictObject({ id: reviewId, mediaType: z.string(), byteSize: natural })),
    }),
    round: z.strictObject({
      id: reviewId,
      artifactVersionId: reviewId,
      status: z.enum(['open', 'approved', 'changes-requested', 'voided']),
      reviewerIds: z.array(reviewId),
      ballots: z.array(
        z.strictObject({
          reviewerId: reviewId,
          reviewerName: z.string().min(1),
          roundId: reviewId,
          artifactVersionId: reviewId,
          action: z.enum(REVIEW_ACTIONS),
          comment: z.string().optional(),
          unresolvedCommentIds: z.array(reviewId).optional(),
          availability: z.enum(['active', 'unavailable', 'timed-out']).optional(),
        }),
      ),
    }),
    comments: z.array(
      z.strictObject({
        id: reviewId,
        status: z.enum(['open', 'resolved']),
        versionId: reviewId.optional(),
        targetId: reviewId.optional(),
        targetType: z.enum(['workflow-version', 'node', 'artifact-version']).optional(),
        anchor: z
          .strictObject({
            kind: z.enum(['text', 'image-region', 'pdf-page', 'file', 'original-version']),
            quote: z.string().optional(),
            locator: z.string().optional(),
          })
          .optional(),
        threadId: reviewId.optional(),
        authorId: reviewId.optional(),
        body: z.string().optional(),
      }),
    ),
  })
  .refine(
    (value) =>
      value.artifact.id === value.target.artifactVersionId &&
      value.round.id === value.target.roundId &&
      value.round.artifactVersionId === value.artifact.id &&
      value.round.ballots.every(
        (ballot) =>
          ballot.roundId === value.round.id &&
          ballot.artifactVersionId === value.artifact.id &&
          value.round.reviewerIds.includes(ballot.reviewerId),
      ) &&
      value.comments.every(
        (comment) =>
          (!comment.versionId || comment.versionId === value.artifact.id) &&
          (!comment.targetId || comment.targetId === value.artifact.id),
      ),
  );
export type ReviewOutcomeView = z.infer<typeof reviewOutcomeSchema>;
export const localReviewUnavailableReasonSchema = z.enum([
  'review-expert-unavailable',
  'review-not-assigned',
  'review-self-review',
  'review-author-active',
  'review-provenance-invalid',
  'review-already-voted',
  'review-capacity',
  'review-attempt-budget',
]);
const localReviewOptionScopeSchema = remoteRunScopeSchema
  .omit({ backendId: true })
  .extend({ review: remoteReviewBindingSchema })
  .refine((scope) => reviewBindingMatches(scope, scope.review));
export const localReviewOptionsSchema = z
  .strictObject({
    controllerMemberId: reviewId,
    target: remoteReviewTargetSchema,
    expectedReviewVersion: natural,
    reviewers: z
      .array(
        z
          .strictObject({
            name: z.string().min(1).max(200),
            reviewerRef: remoteReviewPrincipalSchema.shape.reviewerRef,
            canStart: z.boolean(),
            unavailableReason: localReviewUnavailableReasonSchema.optional(),
          })
          .refine((value) => value.canStart === (value.unavailableReason === undefined)),
      )
      .max(100),
    attempts: z
      .array(
        z.strictObject({
          scope: localReviewOptionScopeSchema,
          version: positive,
          status: z.enum(['prepared', 'requested', 'running', 'completed', 'failed', 'cancelled']),
          dispatch: z.enum(['reserved', 'received', 'unknown']),
          resources: z.enum(['held', 'settled']),
          stopPhase: z.enum(['none', 'requested', 'confirmed']).optional(),
          remoteScope: remoteReviewScopeSchema.optional(),
        }),
      )
      .max(64),
  })
  .refine(
    (value) =>
      new Set(value.reviewers.map((item) => item.reviewerRef.id)).size === value.reviewers.length &&
      value.reviewers.every((item) => item.reviewerRef.version === value.target.planId) &&
      value.attempts.every(
        (attempt) =>
          canonicalPayload(attempt.scope.review.target) === canonicalPayload(value.target) &&
          attempt.scope.actorId === value.controllerMemberId &&
          (!attempt.remoteScope ||
            canonicalPayload(attempt.remoteScope) ===
              canonicalPayload({
                ...attempt.scope,
                backendId: attempt.remoteScope.backendId,
              })),
      ),
  );
export type LocalReviewOptions = z.infer<typeof localReviewOptionsSchema>;
function reviewSourceMatches(
  scope: RemoteReviewScope,
  source: {
    context: {
      scope: Omit<RemoteRunScope, 'backendId'>;
      review: z.infer<typeof remoteReviewBindingSchema>;
    };
  },
): boolean {
  const { backendId: _backend, review, ...nativeScope } = scope;
  return (
    canonicalPayload(source.context.scope) === canonicalPayload(nativeScope) &&
    canonicalPayload(source.context.review) === canonicalPayload(review)
  );
}
export const remoteNativeReviewContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    role: z.literal('review'),
    scope: remoteRunScopeSchema.omit({ backendId: true }),
    review: remoteReviewBindingSchema,
  })
  .refine((value) => reviewBindingMatches(value.scope, value.review));
export const remoteNativeReviewRunSourceSchema = z
  .strictObject({
    context: remoteNativeReviewContextSchema,
    nativeSessionId: reviewId,
    nativeAgentId: reviewId,
    configurationId: reviewId,
  })
  .refine((source) => source.nativeSessionId === source.nativeAgentId);
export const remoteNativeReviewReadSourceSchema = remoteNativeReviewRunSourceSchema.safeExtend({
  resourceRef: reviewId,
  resourceFingerprint: digest,
});
export const remoteNativeReviewRangeSchema = z
  .strictObject({
    offset: natural,
    length: natural.max(REMOTE_REVIEW_WIRE_LIMITS.pageBytes),
    total: natural,
  })
  .refine(
    (range) =>
      range.offset <= range.total &&
      range.length <= range.total - range.offset &&
      Number.isSafeInteger(range.offset + range.length),
  );
const reviewReadRef = z.string().regex(/^review_read_[a-f0-9]{64}$/u);
export const remoteNativeReviewReadEvidenceSchema = z
  .strictObject({
    readRef: reviewReadRef,
    source: remoteNativeReviewReadSourceSchema,
    callId: reviewId,
    callSeq: natural,
    resultSeq: natural,
    range: remoteNativeReviewRangeSchema,
    encoding: z.literal('utf-8'),
    sha256: digest,
  })
  .refine((value) => value.callSeq < value.resultSeq && value.range.length > 0);
export const remoteNativeReviewReadManifestSchema = z
  .strictObject({
    reads: z
      .array(remoteNativeReviewReadEvidenceSchema)
      .min(1)
      .max(REMOTE_REVIEW_WIRE_LIMITS.reads),
    unavailableRequired: z
      .array(
        z.strictObject({
          resourceRef: reviewId,
          code: z.enum(['review-unsupported-material', 'review-unavailable']),
        }),
      )
      .max(REMOTE_REVIEW_WIRE_LIMITS.resources),
  })
  .superRefine((value, ctx) => {
    const origin = (source: z.infer<typeof remoteNativeReviewReadSourceSchema>) =>
      canonicalPayload({
        context: source.context,
        nativeSessionId: source.nativeSessionId,
        nativeAgentId: source.nativeAgentId,
        configurationId: source.configurationId,
      });
    const first = value.reads[0]!;
    const resources = new Map<string, string>();
    let mixed = false;
    for (const item of value.reads) {
      const identity = canonicalPayload([item.source.resourceFingerprint, item.range.total]);
      const previous = resources.get(item.source.resourceRef);
      if (previous !== undefined && previous !== identity) mixed = true;
      resources.set(item.source.resourceRef, identity);
    }
    if (
      mixed ||
      new Set(value.reads.map((item) => item.readRef)).size !== value.reads.length ||
      new Set(value.reads.map((item) => item.callId)).size !== value.reads.length ||
      value.reads.some(
        (item, index) =>
          origin(item.source) !== origin(first.source) ||
          (index > 0 && item.callSeq <= value.reads[index - 1]!.callSeq),
      ) ||
      value.reads.reduce((sum, item) => sum + item.range.length, 0) >
        REMOTE_REVIEW_WIRE_LIMITS.readBytes ||
      new Set(value.unavailableRequired.map((item) => item.resourceRef)).size !==
        value.unavailableRequired.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent original review read manifest.' });
  });
const reviewAnchor = z
  .strictObject({
    resourceRef: reviewId,
    offset: natural,
    length: positive.max(REMOTE_REVIEW_WIRE_LIMITS.readBytes),
  })
  .refine((value) => Number.isSafeInteger(value.offset + value.length));
export const remoteNativeReviewContentSchema = z.preprocess(
  (raw, ctx) => {
    try {
      const serialized = JSON.stringify(raw);
      if (
        serialized === undefined ||
        remoteJsonBytes(raw) > REMOTE_REVIEW_WIRE_LIMITS.argumentBytes ||
        remoteJsonBytes({ arguments: serialized }) + REMOTE_REVIEW_WIRE_LIMITS.frameEnvelopeBytes >
          REMOTE_REVIEW_WIRE_LIMITS.publicFrameBytes
      )
        throw new Error('budget');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Over-budget original review arguments.' });
      return z.NEVER;
    }
    return raw;
  },
  z
    .strictObject({
      conclusion: z.enum(REVIEW_ACTIONS),
      rationale: z.string().trim().min(1).max(REMOTE_RUN_LIMITS.resultCharacters),
      anchors: z.array(reviewAnchor).max(REMOTE_REVIEW_WIRE_LIMITS.anchors),
      evidenceRefs: z.array(reviewReadRef).min(1).max(REMOTE_REVIEW_WIRE_LIMITS.reads),
    })
    .refine((value) => new Set(value.evidenceRefs).size === value.evidenceRefs.length),
);
export const remoteNativeFixedReviewSourceSchema = remoteNativeReviewRunSourceSchema.safeExtend({
  toolVersion: z.literal('zhuma-native-review-intent@1'),
  intentId: reviewId,
  callId: reviewId,
  cut,
  readManifestDigest: digest,
});
export const remoteReviewResultDeclarationSchema = z
  .strictObject({
    requestId: z.uuid(),
    source: remoteNativeFixedReviewSourceSchema,
    digest,
    readManifestDigest: digest,
    provenanceFingerprint: digest,
  })
  .refine((value) => value.source.readManifestDigest === value.readManifestDigest);
export const remoteNativeFixedReviewFactsSchema = z
  .strictObject({
    source: remoteNativeFixedReviewSourceSchema,
    content: remoteNativeReviewContentSchema,
    readManifest: remoteNativeReviewReadManifestSchema,
    readManifestDigest: digest,
    digest,
    provenanceFingerprint: digest,
  })
  .superRefine((value, ctx) => {
    if (
      value.source.readManifestDigest !== value.readManifestDigest ||
      value.readManifest.reads.some(
        (read) =>
          canonicalPayload(read.source.context) !== canonicalPayload(value.source.context) ||
          read.source.nativeSessionId !== value.source.nativeSessionId ||
          read.source.nativeAgentId !== value.source.nativeAgentId ||
          read.source.configurationId !== value.source.configurationId ||
          read.resultSeq >= value.source.cut.callSeq,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Review reads must precede the same original completion cut.',
      });
  });
export type RemoteNativeFixedReviewFacts = z.infer<typeof remoteNativeFixedReviewFactsSchema>;
export const remoteReviewReceiptSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: reviewId,
  fingerprint: digest,
  source: remoteNativeFixedReviewSourceSchema,
  digest,
  provenanceFingerprint: digest,
  action: z.enum(REVIEW_ACTIONS),
  anchors: z.array(reviewAnchor).max(50),
  evidenceRefs: z.array(reviewReadRef).max(16),
  commentId: reviewId,
});
export const remoteReviewFailureSchema = z.strictObject({
  protocolVersion: z.literal(1),
  requestId: reviewId,
  code: z.enum([
    'review-read-required',
    'review-unsupported-material',
    'review-read-budget-exceeded',
    'output-too-large',
    'review-result-rejected',
  ]),
  resourceRefs: z.array(reviewId).max(64),
  fingerprint: digest,
});
export const remoteReviewResourceSchema = z.strictObject({
  resourceRef: reviewId,
  kind: z.enum(['text', 'file', 'external-reference']),
  required: z.literal(true),
  mediaType: z.string().min(1).max(200),
  bytes: natural,
  resourceFingerprint: digest,
});
const reviewDeviceHeader = { ...deviceHeader, purpose: z.literal('review') };
const reviewAuthorized = { scope: remoteReviewScopeSchema, permit: remotePermitDeclarationSchema };
const reviewLocation = { sequence: positive };
export const remoteReviewEventSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      ...reviewLocation,
      kind: z.literal('received'),
      nativeSessionId: reviewId,
      nativeAgentId: reviewId,
    })
    .refine((value) => value.nativeSessionId === value.nativeAgentId),
  z
    .strictObject({
      ...reviewLocation,
      kind: z.literal('accepted'),
      nativeSessionId: reviewId,
      nativeAgentId: reviewId,
    })
    .refine((value) => value.nativeSessionId === value.nativeAgentId),
  z.strictObject({ ...reviewLocation, kind: z.literal('dispatch-unknown') }),
  z.strictObject({ ...reviewLocation, kind: z.literal('idle') }),
  z.strictObject({ ...reviewLocation, kind: z.literal('stop-received') }),
  z.strictObject({ ...reviewLocation, kind: z.literal('retiring') }),
  // Seal is transport metadata only: the original review remains running/held
  // until commitExecutionReviewFixedResult atomically completes AND casts its ballot.
  z.strictObject({
    ...reviewLocation,
    kind: z.literal('sealed'),
    ...drained,
    result: remoteReviewResultDeclarationSchema,
  }),
  z.strictObject({
    ...reviewLocation,
    kind: z.literal('failed'),
    resourcesSettled: z.literal(false),
    failure: remoteReviewFailureSchema.pick({ code: true, resourceRefs: true }).optional(),
  }),
]);
const reviewAccept = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('accept'),
  payload: z
    .strictObject({
      target: remoteReviewTargetSchema,
      expectedReviewVersion: natural,
      workflow: remoteWorkflowRefSchema.optional(),
      reviewerRef: remoteReviewPrincipalSchema.shape.reviewerRef.omit({ digest: true }),
      model: remoteModelSelectionSchema,
      workspace: z.strictObject({ kind: z.literal('text-only') }),
      capabilities: z.strictObject({
        resources: z.literal(REMOTE_RUN_RESOURCE_SOURCE_VERSION).optional(),
        reader: z.literal('zhuma-native-review-read@1'),
        resultIntent: z.literal('zhuma-native-review-intent@1'),
      }),
      credentials: z.strictObject({
        drive: remotePermitDeclarationSchema,
        cleanup: remotePermitDeclarationSchema,
      }),
    })
    .refine((value) => value.reviewerRef.version === value.target.planId),
});
const reviewStatus = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('status'),
  payload: z.strictObject(reviewAuthorized),
});
const reviewRenew = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('renew'),
  payload: z.strictObject(reviewAuthorized),
});
const reviewEvent = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('event'),
  payload: z
    .strictObject({ ...reviewAuthorized, event: remoteReviewEventSchema })
    .refine(
      (value) =>
        value.event.kind !== 'sealed' ||
        reviewSourceMatches(value.scope, value.event.result.source),
    ),
});
const reviewStop = z.strictObject({
  ...header,
  purpose: z.literal('review'),
  backendId: z.uuid(),
  operation: z.literal('stop'),
  payload: z.strictObject({ scope: remoteReviewScopeSchema, expectedAttemptVersion: positive }),
});
const reviewCleanup = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('cleanup'),
  payload: z.strictObject({ ...reviewAuthorized, observation: remoteCleanupObservationSchema }),
});
const reviewReconcile = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('reconcile'),
  payload: z.union([
    z.strictObject({
      ...reviewAuthorized,
      lastSequence: natural,
      resultRequestId: z.uuid().optional(),
      nativeSessionId: reviewId.optional(),
      nativeAgentId: reviewId.optional(),
    }),
    z.strictObject({
      target: remoteReviewTargetSchema,
      reviewerRef: remoteReviewPrincipalSchema.shape.reviewerRef.omit({ digest: true }),
      acceptRequestId: z.uuid(),
      permit: remotePermitDeclarationSchema,
    }),
  ]),
});
const reviewInputList = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('input-list'),
  payload: z.strictObject(reviewAuthorized),
});
const reviewInputRead = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('input-read'),
  payload: z
    .strictObject({
      ...reviewAuthorized,
      resourceRef: reviewId,
      offset: natural,
      length: positive.max(REMOTE_REVIEW_WIRE_LIMITS.pageBytes),
    })
    .refine((value) => Number.isSafeInteger(value.offset + value.length)),
});
const reviewSubmit = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('submit-result'),
  payload: z
    .strictObject({
      ...reviewAuthorized,
      result: remoteReviewResultDeclarationSchema,
      fixed: remoteNativeFixedReviewFactsSchema,
    })
    .refine(
      (value) =>
        reviewSourceMatches(value.scope, value.result.source) &&
        canonicalPayload(value.result.source) === canonicalPayload(value.fixed.source) &&
        value.result.digest === value.fixed.digest &&
        value.result.readManifestDigest === value.fixed.readManifestDigest &&
        value.result.provenanceFingerprint === value.fixed.provenanceFingerprint,
    ),
});
const reviewResultStatus = z.strictObject({
  ...reviewDeviceHeader,
  operation: z.literal('result-status'),
  payload: z.strictObject({ ...reviewAuthorized, resultRequestId: z.uuid() }),
});
export const remoteReviewRequestSchema = z.discriminatedUnion('operation', [
  reviewAccept,
  reviewStatus,
  reviewRenew,
  reviewEvent,
  reviewStop,
  reviewCleanup,
  reviewReconcile,
  reviewInputList,
  reviewInputRead,
  reviewSubmit,
  reviewResultStatus,
]);
export type RemoteReviewRequest = z.infer<typeof remoteReviewRequestSchema>;
export type RemoteReviewAcceptRequest = Extract<RemoteReviewRequest, { operation: 'accept' }>;
export type RemoteReviewDeviceRequest = Exclude<RemoteReviewRequest, { operation: 'stop' }>;
export function remoteReviewDeviceSigningInput(
  request: Omit<RemoteReviewDeviceRequest, 'proof'> & {
    readonly proof: {
      readonly issuedAt: number;
      readonly nonce: string;
      readonly signature?: string | undefined;
    };
  },
) {
  const { signature: _signature, ...proof } = request.proof;
  return { ...request, proof };
}
export const remoteExecutionRequestSchema = z.union([
  remoteRunRequestSchema,
  remoteReviewRequestSchema,
]);
export const remoteReviewSharedSnapshotSchema = z.strictObject({
  configurationId: reviewId,
  /** The original FrozenExecutionReviewComposition, validated again by its original C/D decoder. */
  composition: z
    .record(z.string(), z.json())
    .refine((value) => remoteJsonBytes(value) <= REMOTE_RUN_LIMITS.snapshotBytes),
  resources: z.array(remoteReviewResourceSchema).max(REMOTE_REVIEW_WIRE_LIMITS.resources),
});
export const remoteReviewRunViewSchema = z
  .strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    deviceId: z.uuid(),
    serverTime: natural,
    authority: z.enum(['drive', 'commit-only', 'cleanup-only', 'recovery-required']),
    permit: remotePermitViewSchema,
    cleanup: remotePermitViewSchema,
    nodeVersion: natural,
    reviewVersion: positive,
    attemptVersion: positive,
    nextSequence: positive,
    stopRequested: z.boolean(),
    resources: z.enum(['held', 'settled']),
    runStatus: z.enum(['requested', 'running', 'completed', 'failed', 'cancelled']),
    cleanupPhase: z.enum(['stop-received', 'retiring', 'unknown', 'drained']).optional(),
    result: remoteReviewResultDeclarationSchema.optional(),
    receipt: remoteReviewReceiptSchema.optional(),
    failure: remoteReviewFailureSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.result && !reviewSourceMatches(value.scope, value.result.source)) ||
      (value.receipt && !reviewSourceMatches(value.scope, value.receipt.source))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Review result belongs to a different fixed target or reviewer.',
      });
    if (
      value.authority === 'drive' &&
      (value.stopRequested ||
        value.resources !== 'held' ||
        value.result ||
        !['requested', 'running'].includes(value.runStatus))
    )
      ctx.addIssue({ code: 'custom', message: 'A sealed or fenced reviewer cannot drive.' });
    if (
      value.authority === 'commit-only' &&
      (value.stopRequested ||
        !value.result ||
        !(
          (value.runStatus === 'running' && value.resources === 'held') ||
          (value.runStatus === 'completed' && value.resources === 'settled' && value.receipt)
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Review continuation commits only its original sealed cut.',
      });
  });
export const remoteReviewAcceptValueSchema = remoteReviewRunViewSchema.safeExtend({
  disposition: z.enum(['accepted', 'replayed']),
  shared: remoteReviewSharedSnapshotSchema,
  selection: remoteAcceptValueSchema.shape.selection,
});
export const remoteReviewReconcileValueSchema = remoteReviewRunViewSchema.safeExtend({
  authority: z.enum(['commit-only', 'cleanup-only', 'recovery-required']),
  shared: remoteReviewSharedSnapshotSchema,
  selection: remoteAcceptValueSchema.shape.selection,
});
export type RemoteReviewView = z.infer<typeof remoteReviewRunViewSchema>;
export type RemoteReviewAcceptValue = z.infer<typeof remoteReviewAcceptValueSchema>;
export type RemoteReviewReconcileValue = z.infer<typeof remoteReviewReconcileValueSchema>;
const reviewChanged = remoteReviewRunViewSchema.safeExtend({
  disposition: z.enum(['applied', 'replayed']),
});
const reviewResultValue = z.strictObject({
  purpose: z.literal('review'),
  scope: remoteReviewScopeSchema,
  status: z.enum(['committed', 'confirmed']),
  receipt: remoteReviewReceiptSchema,
});
const reviewResultStatusValue = z.discriminatedUnion('status', [
  z.strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    status: z.literal('none'),
  }),
  z.strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    status: z.literal('committed'),
    receipt: remoteReviewReceiptSchema,
  }),
  z.strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    status: z.literal('needs-attention'),
    failure: remoteReviewFailureSchema,
  }),
]);
export const remoteReviewValueSchemas = Object.freeze({
  accept: remoteReviewAcceptValueSchema,
  status: remoteReviewRunViewSchema,
  renew: remoteReviewRunViewSchema,
  event: reviewChanged,
  stop: reviewChanged,
  cleanup: reviewChanged.refine((value) => !value.result && !value.receipt && !value.failure),
  reconcile: remoteReviewReconcileValueSchema,
  'input-list': z.strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    resources: z.array(remoteReviewResourceSchema).max(REMOTE_REVIEW_WIRE_LIMITS.resources),
  }),
  'input-read': z.strictObject({
    purpose: z.literal('review'),
    scope: remoteReviewScopeSchema,
    source: remoteNativeReviewReadSourceSchema,
    range: remoteNativeReviewRangeSchema,
    encoding: z.enum(['utf-8', 'binary']),
    sha256: digest,
    base64: z.string().max(4 * Math.ceil(REMOTE_REVIEW_WIRE_LIMITS.pageBytes / 3)),
  }),
  'submit-result': reviewResultValue,
  'result-status': reviewResultStatusValue,
});
export type RemoteReviewOperation = RemoteReviewRequest['operation'];
export type RemoteReviewOperationValue<Operation extends RemoteReviewOperation> = z.infer<
  (typeof remoteReviewValueSchemas)[Operation]
>;
export function remoteReviewResponseSchema(operation: RemoteReviewOperation) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value: remoteReviewValueSchemas[operation] }),
    remoteRunErrorSchema,
  ]);
}
