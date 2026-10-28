import { z } from 'zod';
import { readNodeHandoff, type NodeHandoff, type NodeHandoffInput } from './handoff.js';
import { validateDeliveryContent } from './delivery.js';

/** Portable data only. A decoded object is never member, device or native authority. */
export const REMOTE_RUN_PROTOCOL_VERSION = 1 as const;
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
  acceptedInput: z.literal('1').optional(),
  acceptedFile: z.literal('zhuma-accepted-files@2').optional(),
  resultIntent: z.enum(['zhuma-native-result-intent@1', 'zhuma-native-result-intent@2']),
  outputFile: z.literal('zhuma-native-output-file@1').optional(),
  localTools: z.array(localTool).max(4),
});
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
export const remoteResultDeclarationSchema = z
  .strictObject({
    requestId: z.uuid(),
    /** The actual C native lease's digest. Never reinterpret it as a file-reference digest. */
    digest,
    /** Hash of remoteResultDigestInput after real backend upload refs are known. */
    artifactDigest: digest,
    source: remoteResultSourceSchema,
    /** Ordered original v2 selectors, attested by the registered local native owner. */
    publications: z
      .array(
        z.strictObject({
          publicationId: id,
          sha256: digest,
          byteSize: natural.max(20 * 1024 * 1024),
        }),
      )
      .max(20)
      .optional(),
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
const info = z.strictObject({ ...header, operation: z.literal('info'), payload: empty });
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
  payload: z.strictObject({
    ...authorized,
    idempotencyKey: id,
    declare: z.strictObject({
      name: z.string().min(1).max(255),
      mediaType: z.string().min(1).max(200),
      byteSize: natural.max(20 * 1024 * 1024),
      sha256: digest,
    }),
  }),
});
const fileStatus = z.strictObject({
  ...deviceHeader,
  operation: z.literal('file-status'),
  payload: z.strictObject({ ...authorized, idempotencyKey: id }),
});
const abandonFile = z.strictObject({
  ...deviceHeader,
  operation: z.literal('abandon-file'),
  payload: z.strictObject({ ...authorized, uploadId: id }),
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
]);
export type RemoteRunRequest = z.infer<typeof remoteRunRequestSchema>;
export type RemoteDeviceRequest = Exclude<RemoteRunRequest, { operation: 'info' | 'stop' }>;
export type RemoteAcceptRequest = Extract<RemoteRunRequest, { operation: 'accept' }>;
/** Sign exactly this parsed value; method/body substitution cannot borrow a proof. */
export function remoteDeviceSigningInput(
  request: Omit<RemoteDeviceRequest, 'proof'> & {
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
  readonly purposes: readonly 'work'[];
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
export interface RemoteRunView {
  readonly scope: RemoteRunScope;
  readonly deviceId: string;
  readonly serverTime: number;
  readonly authority: 'drive' | 'commit-only' | 'cleanup-only' | 'recovery-required';
  readonly permit: z.infer<typeof remotePermitViewSchema>;
  readonly cleanup: z.infer<typeof remotePermitViewSchema>;
  readonly nodeVersion: number;
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
export interface RemoteFileValue {
  readonly scope: RemoteRunScope;
  readonly uploadId: string;
  readonly idempotencyKey: string;
  readonly status: 'pending' | 'completed' | 'abandoned';
  readonly file?: z.infer<typeof artifactFile> | undefined;
}
export interface RemoteRunOperationValues {
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
  readonly 'publish-file': RemoteFileValue;
  readonly 'file-status': RemoteFileValue;
  readonly 'abandon-file': RemoteFileValue;
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
  purposes: z.array(z.literal('work')).max(1),
  operations: z.array(z.enum(REMOTE_RUN_OPERATIONS)).max(16),
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
  shared: remoteRunSharedSnapshotSchema,
  selection: remoteAcceptValueSchema.shape.selection,
});
const changedView = remoteRunViewSchema.safeExtend({
  disposition: z.enum(['applied', 'replayed']),
});
export const remoteFileValueSchema = z.strictObject({
  scope: remoteRunScopeSchema,
  uploadId: id,
  idempotencyKey: id,
  status: z.enum(['pending', 'completed', 'abandoned']),
  file: artifactFile.optional(),
});
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
export const remoteRunValueSchemas = Object.freeze({
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
  'publish-file': remoteFileValueSchema,
  'file-status': remoteFileValueSchema,
  'abandon-file': remoteFileValueSchema,
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
