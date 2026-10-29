import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { z } from 'zod';
import {
  remotePrivatePermitSchema,
  remotePermitHashInput,
  remoteRunScopeSchema,
  remoteReviewScopeSchema,
  remoteWorkflowCandidateSchema,
  remoteWorkflowTargetSchema,
  remoteWorkflowRefSchema,
  canonicalPayload,
  type RemoteRunScope,
  type RemoteReviewScope,
  type RemoteWorkflowCandidate,
  type RemoteWorkflowTarget,
  type RemoteWorkflowRef,
} from '@zhuma/agent-core';

/** A adapts this to its ORIGINAL private credentials owner. Implementations
 * must not create a separate ordinary metadata/JSON/renderer secrets store. */
export interface MemberLocalPrivateStore {
  read(key: string): Promise<unknown>;
  /** Atomic per-key update; resolves with the durably stored value. */
  modify(key: string, update: (current: unknown) => unknown): Promise<unknown>;
}
export class MemberLocalSecretError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'unavailable' | 'cancelled') {
    super('本机执行凭据未就绪。');
  }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const deviceRecord = z.strictObject({
  version: z.literal(1),
  backendId: remoteRunScopeSchema.shape.backendId,
  actorId: remoteRunScopeSchema.shape.actorId,
  deviceId: z.uuid(),
  publicKey: z.string().min(1).max(256),
  privateKey: z.string().min(1).max(256),
});
type DeviceRecord = z.infer<typeof deviceRecord>;
const intentRecord = z.strictObject({
  version: z.literal(1),
  backendId: remoteRunScopeSchema.shape.backendId,
  actorId: remoteRunScopeSchema.shape.actorId,
  deviceId: z.uuid(),
  requestId: z.uuid(),
  intentFingerprint: digest,
  drive: remotePrivatePermitSchema,
  cleanup: remotePrivatePermitSchema,
});
type IntentRecord = z.infer<typeof intentRecord>;
const workflowAcceptPointer = z.strictObject({
  version: z.literal(1),
  backendId: remoteRunScopeSchema.shape.backendId,
  actorId: remoteRunScopeSchema.shape.actorId,
  deviceId: z.uuid(),
  requestId: z.uuid(),
  intentFingerprint: digest,
  candidate: remoteWorkflowCandidateSchema,
});
// The original credentials provider treats modify(undefined) as no change.
// Clear this exact locator with a durable value in the same private slot.
const clearedWorkflowPointer = z.strictObject({ version: z.literal(1), cleared: z.literal(true) });
const historyPointer = z
  .strictObject({
    version: z.literal(1),
    scopeFingerprint: digest,
    requestId: z.uuid(),
    configurationId: z.string().min(1).max(200),
    selectionFingerprint: digest,
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 1024);
export interface MemberLocalDeviceIdentity {
  readonly backendId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly publicKey: string;
  /** Signs bytes provided by D's single canonical proof builder. No wire DTO here. */
  sign(bytes: Uint8Array): string;
}
export interface MemberLocalSecretReference {
  readonly id: string;
  readonly sha256: string;
}
export interface MemberLocalAcceptSecrets {
  readonly requestId: string;
  readonly intentFingerprint: string;
  readonly drive: MemberLocalSecretReference;
  readonly cleanup: MemberLocalSecretReference;
  /** Host-only access; caller must follow D's authenticated permit protocol. */
  withDriveSecret<T>(work: (base64url: string) => T): T;
  withCleanupSecret<T>(work: (base64url: string) => T): T;
}
const key = (kind: string, parts: readonly string[]) =>
  `zhuma.member-local.${kind}.${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MemberLocalSecretError('cancelled');
}
function privateKeyFor(record: DeviceRecord) {
  const privateKey = createPrivateKey({
    key: Buffer.from(record.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') !==
      record.publicKey
  )
    throw new MemberLocalSecretError('unavailable');
  return privateKey;
}
function publicToken(value: z.infer<typeof remotePrivatePermitSchema>): MemberLocalSecretReference {
  const bytes = remotePermitHashInput(value.secret);
  return Object.freeze({ id: value.id, sha256: createHash('sha256').update(bytes).digest('hex') });
}

/** Private local identity/accept intent only. Keys and secret possession never
 * authorize a Run; the backend must validate actor/device/current full scope. */
export class MemberLocalExecutionSecrets {
  private readonly issued = new WeakMap<object, DeviceRecord>();
  private readonly intents = new WeakMap<MemberLocalAcceptSecrets, IntentRecord>();
  constructor(private readonly store: MemberLocalPrivateStore) {}
  async device(
    backendId: string,
    actorId: string,
    signal?: AbortSignal,
  ): Promise<MemberLocalDeviceIdentity> {
    try {
      checkSignal(signal);
      remoteRunScopeSchema.shape.backendId.parse(backendId);
      remoteRunScopeSchema.shape.actorId.parse(actorId);
      const slot = key('device', [backendId, actorId]);
      let raw = await this.store.read(slot);
      checkSignal(signal);
      if (raw === undefined) {
        const pair = generateKeyPairSync('ed25519');
        const candidate: DeviceRecord = {
          version: 1,
          backendId,
          actorId,
          deviceId: randomUUID(),
          publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
          privateKey: pair.privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64url'),
        };
        raw = await this.store.modify(slot, (current) =>
          current === undefined ? candidate : current,
        );
      }
      checkSignal(signal);
      const record = deviceRecord.parse(raw);
      if (record.backendId !== backendId || record.actorId !== actorId)
        throw new MemberLocalSecretError('conflict');
      const privateKey = privateKeyFor(record);
      const handle: MemberLocalDeviceIdentity = Object.freeze({
        backendId,
        actorId,
        deviceId: record.deviceId,
        publicKey: record.publicKey,
        sign: (bytes: Uint8Array) => sign(null, bytes, privateKey).toString('base64url'),
      });
      this.issued.set(handle, record);
      return handle;
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** Must resolve before the first accept HTTP request. Retrying the same
   * intent after a lost response reuses its exact IDs and random secret bytes. */
  async accept(
    device: MemberLocalDeviceIdentity,
    requestId: string,
    intentFingerprint: string,
    signal?: AbortSignal,
  ): Promise<MemberLocalAcceptSecrets> {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device);
      if (!owner) throw new MemberLocalSecretError('invalid');
      digest.parse(intentFingerprint);
      z.uuid().parse(requestId);
      const slot = key('accept', [owner.backendId, owner.actorId, owner.deviceId, requestId]);
      let raw = await this.store.read(slot);
      checkSignal(signal);
      if (raw === undefined) {
        const candidate: IntentRecord = {
          version: 1,
          backendId: owner.backendId,
          actorId: owner.actorId,
          deviceId: owner.deviceId,
          requestId,
          intentFingerprint,
          drive: { id: randomUUID(), secret: randomBytes(32).toString('base64url') },
          cleanup: { id: randomUUID(), secret: randomBytes(32).toString('base64url') },
        };
        raw = await this.store.modify(slot, (current) =>
          current === undefined ? candidate : current,
        );
      }
      checkSignal(signal);
      const record = intentRecord.parse(raw);
      if (
        record.backendId !== owner.backendId ||
        record.actorId !== owner.actorId ||
        record.deviceId !== owner.deviceId ||
        record.requestId !== requestId ||
        record.intentFingerprint !== intentFingerprint
      )
        throw new MemberLocalSecretError('conflict');
      return this.intentHandle(record);
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** Exact-key cold lookup only: no enumeration, new intent, secret rotation or
   * accept/network command. An absent local record never authorizes recovery. */
  async recoverAccept(
    device: MemberLocalDeviceIdentity,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<MemberLocalAcceptSecrets | undefined> {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device);
      if (!owner) throw new MemberLocalSecretError('invalid');
      z.uuid().parse(requestId);
      const raw = await this.store.read(
        key('accept', [owner.backendId, owner.actorId, owner.deviceId, requestId]),
      );
      checkSignal(signal);
      if (raw === undefined) return undefined;
      const record = intentRecord.parse(raw);
      if (
        record.backendId !== owner.backendId ||
        record.actorId !== owner.actorId ||
        record.deviceId !== owner.deviceId ||
        record.requestId !== requestId
      )
        throw new MemberLocalSecretError('conflict');
      return this.intentHandle(record);
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** One exact pending-admission locator, in the ORIGINAL private pointer
   * namespace. No permit/body copy, domain state, enumeration or work queue. */
  async rememberWorkflowAccept(
    device: MemberLocalDeviceIdentity,
    requestId: string,
    rawCandidate: RemoteWorkflowCandidate,
    signal?: AbortSignal,
  ): Promise<void> {
    const candidate = remoteWorkflowCandidateSchema.parse(rawCandidate),
      intent = await this.recoverAccept(device, requestId, signal);
    if (!intent) throw new MemberLocalSecretError('unavailable');
    const entry = workflowAcceptPointer.parse({
      version: 1,
      backendId: device.backendId,
      actorId: device.actorId,
      deviceId: device.deviceId,
      requestId,
      intentFingerprint: intent.intentFingerprint,
      candidate,
    });
    const slot = this.workflowDeviceSlot(device);
    const saved = await this.store.modify(slot, (raw) => {
      if (raw === undefined || clearedWorkflowPointer.safeParse(raw).success) return entry;
      if (canonicalPayload(workflowAcceptPointer.parse(raw)) !== canonicalPayload(entry))
        throw new MemberLocalSecretError('conflict');
      return raw;
    });
    checkSignal(signal);
    if (canonicalPayload(saved) !== canonicalPayload(entry))
      throw new MemberLocalSecretError('unavailable');
  }
  /** Pure exact-key lookup. The candidate/request ID is a locator only; the
   * original signed reconcile must still prove actor/device/current scope. */
  async pendingWorkflowAccept(
    device: MemberLocalDeviceIdentity,
    target: RemoteWorkflowTarget,
    workflow: RemoteWorkflowRef,
    signal?: AbortSignal,
  ) {
    remoteWorkflowRefSchema.parse(workflow);
    const entry = await this.pendingWorkflowAcceptForDevice(device, signal);
    if (!entry) return undefined;
    const { nodeId: _node, ...located } = entry.candidate.target,
      wanted = remoteWorkflowTargetSchema.parse({
        spaceId: target.spaceId,
        taskId: target.taskId,
        planId: target.planId,
        revision: target.revision,
      });
    if (
      !Object.entries(wanted).every(([k, v]) => Reflect.get(located, k) === v) ||
      entry.candidate.workflow.intentId !== workflow.intentId
    )
      return undefined;
    if (canonicalPayload(entry.candidate.workflow) !== canonicalPayload(workflow))
      throw new MemberLocalSecretError('conflict');
    return entry;
  }
  /** Original Owner admits at most one local source. Retain that one pending
   * request at device scope so cold backend switching cannot miss an unopened
   * task. This is one exact read, never an enumerable task/Run index. */
  async pendingWorkflowAcceptForDevice(device: MemberLocalDeviceIdentity, signal?: AbortSignal) {
    checkSignal(signal);
    if (!this.issued.has(device)) throw new MemberLocalSecretError('invalid');
    const raw = await this.store.read(this.workflowDeviceSlot(device));
    checkSignal(signal);
    if (raw === undefined || clearedWorkflowPointer.safeParse(raw).success) return undefined;
    const entry = workflowAcceptPointer.parse(raw);
    if (
      entry.backendId !== device.backendId ||
      entry.actorId !== device.actorId ||
      entry.deviceId !== device.deviceId
    )
      throw new MemberLocalSecretError('conflict');
    const intent = await this.recoverAccept(device, entry.requestId, signal);
    if (!intent || intent.intentFingerprint !== entry.intentFingerprint)
      throw new MemberLocalSecretError('conflict');
    return Object.freeze(structuredClone(entry));
  }
  /** Caller clears only after original Owner cleanup/result settlement. The
   * original qualified Run pointer must still match; no permit is deleted. */
  async forgetWorkflowAccept(
    device: MemberLocalDeviceIdentity,
    candidate: RemoteWorkflowCandidate,
    scope: RemoteRunScope | RemoteReviewScope,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = await this.pendingWorkflowAccept(
      device,
      candidate.target,
      candidate.workflow,
      signal,
    );
    if (!entry) return;
    const saved =
      candidate.kind === 'work'
        ? await this.historyIntent(device, remoteRunScopeSchema.parse(scope), signal)
        : await this.loadReviewRun(device, remoteReviewScopeSchema.parse(scope), signal);
    if (
      !saved ||
      saved.intent.requestId !== entry.requestId ||
      saved.intent.intentFingerprint !== entry.intentFingerprint ||
      canonicalPayload(candidate) !== canonicalPayload(entry.candidate)
    )
      throw new MemberLocalSecretError('conflict');
    const slot = this.workflowDeviceSlot(device);
    const cleared = { version: 1, cleared: true } as const;
    const stored = await this.store.modify(slot, (raw) => {
      if (raw === undefined || clearedWorkflowPointer.safeParse(raw).success) return cleared;
      if (canonicalPayload(workflowAcceptPointer.parse(raw)) !== canonicalPayload(entry))
        throw new MemberLocalSecretError('conflict');
      return cleared;
    });
    checkSignal(signal);
    if (!clearedWorkflowPointer.safeParse(stored).success)
      throw new MemberLocalSecretError('unavailable');
  }
  private workflowDeviceSlot(device: MemberLocalDeviceIdentity): string {
    if (!this.issued.has(device)) throw new MemberLocalSecretError('invalid');
    return key('run-pointer', [
      device.backendId,
      device.actorId,
      device.deviceId,
      'pending-workflow-accept',
    ]);
  }
  /** One bounded exact-key locator per original Run, with the same lifetime as
   * its private accept intent. No list, scan, rotation or history eviction. */
  async rememberRun(
    device: MemberLocalDeviceIdentity,
    intent: MemberLocalAcceptSecrets,
    rawScope: RemoteRunScope,
    configurationId: string,
    selectionFingerprint: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device),
        record = this.intents.get(intent),
        scope = remoteRunScopeSchema.parse(rawScope);
      if (
        !owner ||
        !record ||
        owner.backendId !== scope.backendId ||
        owner.actorId !== scope.actorId ||
        record.backendId !== owner.backendId ||
        record.actorId !== owner.actorId ||
        record.deviceId !== owner.deviceId
      )
        throw new MemberLocalSecretError('invalid');
      const entry = historyPointer.parse({
        version: 1,
        scopeFingerprint: this.scopeFingerprint(scope),
        requestId: record.requestId,
        configurationId,
        selectionFingerprint,
      });
      const slot = key('run-pointer', [
        owner.backendId,
        owner.actorId,
        owner.deviceId,
        entry.scopeFingerprint,
      ]);
      const same = (raw: unknown) => {
        const prior = historyPointer.parse(raw);
        if (canonicalPayload(prior) !== canonicalPayload(entry))
          throw new MemberLocalSecretError('conflict');
        return prior;
      };
      const current = await this.store.read(slot);
      checkSignal(signal);
      if (current !== undefined) {
        same(current);
        return;
      }
      const saved = await this.store.modify(slot, (raw) => (raw === undefined ? entry : same(raw)));
      checkSignal(signal);
      same(saved);
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** Pure cold navigation: exact pointer + exact intent reads, no scan or write.
   * A missing locator is unknown; possession never supplies authority. */
  async historyIntent(
    device: MemberLocalDeviceIdentity,
    rawScope: RemoteRunScope,
    signal?: AbortSignal,
  ) {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device),
        scope = remoteRunScopeSchema.parse(rawScope);
      if (!owner || owner.backendId !== scope.backendId || owner.actorId !== scope.actorId)
        throw new MemberLocalSecretError('invalid');
      const fingerprint = this.scopeFingerprint(scope);
      const raw = await this.store.read(
        key('run-pointer', [owner.backendId, owner.actorId, owner.deviceId, fingerprint]),
      );
      checkSignal(signal);
      if (raw === undefined) return undefined;
      const entry = historyPointer.parse(raw);
      if (entry.scopeFingerprint !== fingerprint) throw new MemberLocalSecretError('conflict');
      const intent = await this.recoverAccept(device, entry.requestId, signal);
      if (!intent) return undefined;
      return Object.freeze({
        intent,
        configurationId: entry.configurationId,
        selectionFingerprint: entry.selectionFingerprint,
      });
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** Review navigation uses its full strict target/principal scope and the
   * original private store. This never creates or rotates an accept intent. */
  async rememberReviewRun(
    device: MemberLocalDeviceIdentity,
    intent: MemberLocalAcceptSecrets,
    rawScope: RemoteReviewScope,
    configurationId: string,
    selectionFingerprint: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device),
        record = this.intents.get(intent),
        scope = remoteReviewScopeSchema.parse(rawScope);
      if (
        !owner ||
        !record ||
        owner.backendId !== scope.backendId ||
        owner.actorId !== scope.actorId ||
        record.backendId !== owner.backendId ||
        record.actorId !== owner.actorId ||
        record.deviceId !== owner.deviceId
      )
        throw new MemberLocalSecretError('invalid');
      const entry = historyPointer.parse({
        version: 1,
        scopeFingerprint: this.scopeFingerprint(scope),
        requestId: record.requestId,
        configurationId,
        selectionFingerprint,
      });
      const slot = key('run-pointer', [
        owner.backendId,
        owner.actorId,
        owner.deviceId,
        entry.scopeFingerprint,
      ]);
      const same = (raw: unknown) => {
        const prior = historyPointer.parse(raw);
        if (canonicalPayload(prior) !== canonicalPayload(entry))
          throw new MemberLocalSecretError('conflict');
        return prior;
      };
      const current = await this.store.read(slot);
      checkSignal(signal);
      if (current !== undefined) {
        same(current);
        return;
      }
      const saved = await this.store.modify(slot, (raw) => (raw === undefined ? entry : same(raw)));
      checkSignal(signal);
      same(saved);
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  /** Exact-key read only. A work pointer or a different review is never reused. */
  async loadReviewRun(
    device: MemberLocalDeviceIdentity,
    rawScope: RemoteReviewScope,
    signal?: AbortSignal,
  ) {
    try {
      checkSignal(signal);
      const owner = this.issued.get(device),
        scope = remoteReviewScopeSchema.parse(rawScope);
      if (!owner || owner.backendId !== scope.backendId || owner.actorId !== scope.actorId)
        throw new MemberLocalSecretError('invalid');
      const fingerprint = this.scopeFingerprint(scope);
      const raw = await this.store.read(
        key('run-pointer', [owner.backendId, owner.actorId, owner.deviceId, fingerprint]),
      );
      checkSignal(signal);
      if (raw === undefined) return undefined;
      const entry = historyPointer.parse(raw);
      if (entry.scopeFingerprint !== fingerprint) throw new MemberLocalSecretError('conflict');
      const intent = await this.recoverAccept(device, entry.requestId, signal);
      return intent
        ? Object.freeze({
            intent,
            configurationId: entry.configurationId,
            selectionFingerprint: entry.selectionFingerprint,
          })
        : undefined;
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
  private scopeFingerprint(scope: RemoteRunScope): string {
    return createHash('sha256').update(canonicalPayload(scope)).digest('hex');
  }
  private intentHandle(record: IntentRecord): MemberLocalAcceptSecrets {
    const drive = publicToken(record.drive),
      cleanup = publicToken(record.cleanup);
    if (drive.id === cleanup.id || drive.sha256 === cleanup.sha256)
      throw new MemberLocalSecretError('unavailable');
    const handle: MemberLocalAcceptSecrets = Object.freeze({
      requestId: record.requestId,
      intentFingerprint: record.intentFingerprint,
      drive,
      cleanup,
      withDriveSecret: <T>(work: (secret: string) => T) => work(record.drive.secret),
      withCleanupSecret: <T>(work: (secret: string) => T) => work(record.cleanup.secret),
    });
    this.intents.set(handle, record);
    return handle;
  }
}
