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
      const drive = publicToken(record.drive),
        cleanup = publicToken(record.cleanup);
      if (drive.id === cleanup.id || drive.sha256 === cleanup.sha256)
        throw new MemberLocalSecretError('unavailable');
      return Object.freeze({
        requestId,
        intentFingerprint,
        drive,
        cleanup,
        withDriveSecret: <T>(work: (secret: string) => T) => work(record.drive.secret),
        withCleanupSecret: <T>(work: (secret: string) => T) => work(record.cleanup.secret),
      });
    } catch (error) {
      if (error instanceof MemberLocalSecretError) throw error;
      throw new MemberLocalSecretError('unavailable');
    }
  }
}
