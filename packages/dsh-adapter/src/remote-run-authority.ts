import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import {
  canonicalPayload,
  isTerminalRunStatus,
  requestRunStop,
  REMOTE_RUN_LIMITS,
  remoteDeviceSigningInput,
  remotePermitHashInput,
  remoteRunRequestSchema,
  remoteRunResponseSchema,
  remoteRunSharedSnapshotSchema,
  remoteResultDigestInput,
  submitDelivery,
  submitExpertDelivery,
  type ExecutionNodeRecord,
  type RemoteRunRequest,
  type RemoteDeviceRequest,
  type RemoteRunOperation,
  type RemoteRunResponse,
  type RemoteRunView,
  type RemoteAcceptValue,
  type RemoteRunScope,
  type RemoteRunErrorCode,
  type RemoteInputDescriptor,
} from '@zhuma/agent-core';
import type { UpstreamContentValue } from './execution-service.js';
import { memberSessionId, type MemberRequest } from './member-session.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import {
  executionRunGlobalSchema,
  prepareExecutionRunWriter,
  type ExecutionWriterGlobal,
} from './execution-run-protocol.js';
import {
  beginExecutionRun,
  executionRunScope,
  readExecutionRunState,
  recordExecutionRunEvent,
  requestExecutionRunStop,
  withExecutionRunState,
  ExecutionRunError,
  type ExecutionRun,
  type ExecutionRunState,
} from './execution-run-state.js';
import type { RemoteRunBinding, RemoteBackendRegistry } from './remote-run-authority-state.js';
import type { FrozenExecutionRunComposition } from './execution-run-composition.js';
import { executionRunCompositionRequest } from './execution-run-composition.js';
import { nativeResultDigest } from './native-work-session-result-source.js';

type Accept = Extract<RemoteRunRequest, { operation: 'accept' }>;
type Target = Accept['payload']['target'];
type Loaded = {
  node: ExecutionNodeRecord;
  run: ExecutionRun;
  state: ExecutionRunState;
  remote: RemoteRunBinding;
};
const supported = [
  'info',
  'register-device',
  'accept',
  'status',
  'renew',
  'event',
  'stop',
  'cleanup',
  'reconcile',
  'submit-result',
  'result-status',
  'input-list',
  'input-read',
] satisfies RemoteRunOperation[];
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const same = (left: unknown, right: unknown) => canonicalPayload(left) === canonicalPayload(right);
const privateHash = (raw: unknown) =>
  createHash('sha256').update(remotePermitHashInput(raw)).digest('hex');
const safeEqual = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export class RemoteRunError extends Error {
  constructor(readonly code: RemoteRunErrorCode) {
    super('远程运行操作未完成。');
    this.name = 'RemoteRunError';
  }
}
function deny(code: RemoteRunErrorCode): never {
  throw new RemoteRunError(code);
}

/** Private original-service ports. A wire DTO never supplies any of these assertions. */
export interface RemoteRunAuthoritySource {
  readonly signal: AbortSignal;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  memberLease(request: MemberRequest): Promise<ExecutionMemberLease>;
  readGlobal(): unknown;
  writeGlobal(next: ExecutionWriterGlobal): Promise<void>;
  readNode(target: Target): ExecutionNodeRecord | undefined;
  listNodes(): readonly ExecutionNodeRecord[];
  writeNode(next: ExecutionNodeRecord): Promise<void>;
  readInput(
    actorId: string,
    spaceId: string,
    downstream: ExecutionNodeRecord,
    sourceNodeId: string,
    artifactVersionId: string,
  ): UpstreamContentValue | undefined;
  prepareDelivery(record: ExecutionNodeRecord, actorId: string): ExecutionNodeRecord;
  afterDelivery(record: ExecutionNodeRecord): Promise<void>;
  /** Current membership/project/assignment AND the unique latest applied plan. */
  assertTarget(actorId: string, target: Target, node: ExecutionNodeRecord): void;
  compose(
    actorId: string,
    request: Accept,
    node: ExecutionNodeRecord,
    scope: Omit<RemoteRunScope, 'backendId'>,
  ): FrozenExecutionRunComposition;
  now?(): number;
}

/** Owns no parallel task store. Durable metadata lives only in original global/Run rows. */
export class RemoteRunAuthorities {
  private readonly epoch = randomUUID();
  private readonly active = new Map<
    string,
    {
      lease: ExecutionMemberLease;
      sessionHash: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly inFlight = new Map<string, number>();
  private closed = false;
  constructor(private readonly source: RemoteRunAuthoritySource) {
    source.signal.addEventListener('abort', () => this.fence(), { once: true });
  }
  private now(): number {
    return this.source.now?.() ?? Date.now();
  }
  /** Explicit Host setup only. Info/status/reopen never install or repair a writer. */
  enable(): Promise<void> {
    return this.source.enqueue(async () => {
      if (this.closed || this.source.signal.aborted) deny('remote-unavailable');
      const raw = executionRunGlobalSchema.safeParse(this.source.readGlobal());
      if (!raw.success) deny('remote-unavailable');
      if (raw.data.remoteExecution) return;
      await this.source.writeGlobal({
        ...prepareExecutionRunWriter(raw.data),
        remoteExecutionWriter: 1,
        remoteExecution: { schemaVersion: 1, backendId: randomUUID(), devices: [] },
      });
      this.registry();
    });
  }
  private registry(): RemoteBackendRegistry {
    const value = executionRunGlobalSchema.safeParse(this.source.readGlobal());
    if (!value.success || !value.data.remoteExecution) deny('remote-unavailable');
    return value.data.remoteExecution;
  }
  private release(runId: string): void {
    const value = this.active.get(runId);
    if (!value) return;
    this.active.delete(runId);
    clearTimeout(value.timer);
    try {
      value.lease.release();
    } catch {
      this.closed = true;
    }
  }
  fence(): void {
    this.closed = true;
    for (const id of this.active.keys()) this.release(id);
  }
  private retain(
    runId: string,
    lease: ExecutionMemberLease,
    sessionHash: string,
    expiresAt: number,
  ): void {
    this.release(runId);
    const timer = setTimeout(() => this.release(runId), Math.max(0, expiresAt - this.now()));
    timer.unref();
    this.active.set(runId, { lease, sessionHash, timer });
  }
  async handle(
    request: MemberRequest,
    raw: unknown,
    privatePermit?: string,
  ): Promise<RemoteRunResponse<unknown>> {
    const parsed = remoteRunRequestSchema.safeParse(raw);
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(raw), 'utf8') > REMOTE_RUN_LIMITS.requestBytes
    )
      return { ok: false, error: { code: 'remote-validation' } };
    const body = parsed.data;
    if (!supported.includes(body.operation as (typeof supported)[number]))
      return { ok: false, error: { code: 'remote-protocol-unsupported' } };
    let lease: ExecutionMemberLease | undefined;
    let retained = false;
    let device: string | undefined;
    try {
      // Cleanup is the sole no-current-cookie operation; exact persisted old-scope proof below.
      if (body.operation !== 'cleanup') {
        if (this.closed || this.source.signal.aborted) deny('remote-unavailable');
        try {
          lease = await this.source.memberLease(request);
        } catch {
          deny('remote-unauthenticated');
        }
        if (lease.signal.aborted || lease.expiresAt <= this.now()) deny('remote-unauthenticated');
      }
      if ('deviceId' in body) {
        const pending = this.inFlight.get(body.deviceId) ?? 0;
        if (pending >= REMOTE_RUN_LIMITS.inFlightPerDevice) deny('remote-quota');
        device = body.deviceId;
        this.inFlight.set(device, pending + 1);
      }
      const session = lease && memberSessionId(request.headers.cookie);
      if (lease && !session) deny('remote-unauthenticated');
      const sessionHash = session ? hash(session) : '';
      const response = await this.source.enqueue(async () => {
        const registry = this.registry();
        if (body.operation !== 'info' && body.backendId !== registry.backendId)
          deny('remote-scope-mismatch');
        if (lease && (lease.signal.aborted || lease.expiresAt <= this.now()))
          deny('remote-unauthenticated');
        if (body.operation === 'info')
          return {
            protocolVersion: 1,
            backendId: registry.backendId,
            actorId: lease!.memberId,
            serverTime: this.now(),
            purposes: ['work'],
            operations: supported,
          };
        if (body.operation === 'register-device') return this.register(body, lease!);
        if (body.operation === 'cleanup') return this.cleanup(body, privatePermit);
        if (body.operation === 'accept') {
          const value = await this.accept(body, lease!, sessionHash);
          if (value.disposition === 'accepted') {
            this.retain(value.scope.runId, lease!, sessionHash, value.permit.expiresAt);
            retained = true;
            return { ...value, ...this.view(this.load(value.scope)) };
          }
          return value;
        }
        if (body.operation === 'stop') return this.stop(body, lease!);
        this.checkDevice(body, lease!.memberId);
        if (body.operation === 'reconcile')
          return this.reconcile(body, lease!, privatePermit, sessionHash);
        const target = body.payload.scope;
        const loaded = this.load(target);
        this.authorize(loaded, lease!);
        this.checkBinding(body, loaded);
        this.checkPermit(body.payload.permit, privatePermit, loaded.remote.drive);
        const mutable = body.operation !== 'status' && body.operation !== 'result-status';
        this.checkLive(loaded, lease!, sessionHash, mutable);
        switch (body.operation) {
          case 'status':
            return this.view(loaded, false, loaded.remote.memberSessionHash === sessionHash);
          case 'renew':
            return this.renew(body, loaded);
          case 'event':
            return this.event(body, loaded);
          case 'submit-result':
            return this.submit(body, loaded);
          case 'result-status': {
            const receipt = loaded.remote.receipt;
            if (receipt && receipt.requestId !== body.payload.resultRequestId)
              deny('remote-idempotency-mismatch');
            return {
              scope: target,
              status: receipt ? 'committed' : 'none',
              ...(receipt ? { receipt } : {}),
            };
          }
          case 'input-list':
            this.requireInputDrive(loaded);
            this.assertInputCatalog(loaded);
            return { scope: target, items: loaded.remote.inputs };
          case 'input-read':
            return this.readInput(body, loaded);
          default:
            return deny('remote-protocol-unsupported');
        }
      });
      const result = remoteRunResponseSchema(body.operation).safeParse({
        ok: true,
        value: response,
      });
      if (!result.success) deny('remote-unavailable');
      return result.data;
    } catch (error) {
      const code =
        error instanceof RemoteRunError
          ? error.code
          : error instanceof ExecutionRunError
            ? error.code === 'run-active' || error.code === 'run-workspace-busy'
              ? 'remote-resource-held'
              : error.code === 'run-conflict'
                ? 'remote-conflict'
                : 'remote-forbidden'
            : 'remote-unavailable';
      return { ok: false, error: { code } };
    } finally {
      if (device) {
        const pending = (this.inFlight.get(device) ?? 1) - 1;
        if (pending) this.inFlight.set(device, pending);
        else this.inFlight.delete(device);
      }
      if (lease && !retained) {
        try {
          lease.release();
        } catch {
          this.fence();
        }
      }
    }
  }
  private proof(body: RemoteDeviceRequest, publicKey: string): void {
    if (Math.abs(this.now() - body.proof.issuedAt) > REMOTE_RUN_LIMITS.proofWindowMs)
      deny('remote-proof-expired');
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      if (
        key.asymmetricKeyType !== 'ed25519' ||
        key.export({ format: 'der', type: 'spki' }).toString('base64url') !== publicKey ||
        !verify(
          null,
          Buffer.from(canonicalPayload(remoteDeviceSigningInput(body))),
          key,
          Buffer.from(body.proof.signature, 'base64url'),
        )
      )
        deny('remote-proof-invalid');
    } catch {
      deny('remote-proof-invalid');
    }
  }
  private checkDevice(body: RemoteDeviceRequest, actorId: string) {
    const device = this.registry().devices.find((item) => item.deviceId === body.deviceId);
    if (!device || device.actorId !== actorId) deny('remote-device-mismatch');
    this.proof(body, device.publicKey);
    return device;
  }
  private async register(
    body: Extract<RemoteRunRequest, { operation: 'register-device' }>,
    lease: ExecutionMemberLease,
  ) {
    this.proof(body, body.payload.publicKey);
    const registry = this.registry();
    const fingerprint = hash({ deviceId: body.deviceId, actorId: lease.memberId, ...body.payload });
    const prior = registry.devices.find(
      (item) => item.deviceId === body.deviceId || item.requestId === body.requestId,
    );
    if (prior) {
      if (
        prior.actorId !== lease.memberId ||
        prior.deviceId !== body.deviceId ||
        prior.fingerprint !== fingerprint
      )
        deny('remote-idempotency-mismatch');
      return {
        deviceId: prior.deviceId,
        actorId: prior.actorId,
        keyEpoch: prior.keyEpoch,
        disposition: 'replayed',
        serverTime: this.now(),
      };
    }
    if (
      registry.devices.length >= REMOTE_RUN_LIMITS.devices ||
      registry.devices.filter((item) => item.actorId === lease.memberId).length >=
        REMOTE_RUN_LIMITS.devicesPerMember
    )
      deny('remote-quota');
    const device = {
      deviceId: body.deviceId,
      actorId: lease.memberId,
      publicKey: body.payload.publicKey,
      keyEpoch: 1,
      requestId: body.requestId,
      fingerprint,
      ...(body.payload.displayName ? { displayName: body.payload.displayName } : {}),
    };
    await this.source.writeGlobal({
      ...prepareExecutionRunWriter(this.source.readGlobal()),
      remoteExecutionWriter: 1,
      remoteExecution: { ...registry, devices: [...registry.devices, device] },
    });
    return {
      deviceId: device.deviceId,
      actorId: device.actorId,
      keyEpoch: 1,
      disposition: 'enrolled',
      serverTime: this.now(),
    };
  }
  private load(scope: RemoteRunScope): Loaded {
    const node = this.source.readNode(scope);
    const state = node && readExecutionRunState(node);
    const run = state?.runs.find((item) => item.attempt.id === scope.runId);
    if (!node || !state || !run?.remote) deny('remote-not-found');
    if (!same({ ...executionRunScope(node, run), backendId: run.remote.backendId }, scope))
      deny('remote-scope-mismatch');
    if ((run.remote.lastWireEvent?.sequence ?? 0) !== run.attempt.lastEventSequence)
      deny('remote-unavailable');
    return { node, state, run, remote: run.remote };
  }
  private authorize(value: Loaded, lease: ExecutionMemberLease): void {
    if (lease.memberId !== value.run.actorId) deny('remote-forbidden');
    lease.assertCurrent(value.run.spaceId);
    this.source.assertTarget(
      lease.memberId,
      { ...executionRunScope(value.node, value.run) },
      value.node,
    );
    if (value.state.currentRunId !== value.run.attempt.id) deny('remote-scope-mismatch');
  }
  private checkBinding(body: RemoteDeviceRequest, value: Loaded): void {
    if (value.remote.deviceId !== body.deviceId) deny('remote-device-mismatch');
    const current = this.registry().devices.find((device) => device.deviceId === body.deviceId);
    if (
      !current ||
      current.keyEpoch !== value.remote.keyEpoch ||
      current.publicKey !== value.remote.publicKey
    )
      deny('remote-device-mismatch');
  }
  private checkPermit(
    declaration: { id: string; sha256: string },
    raw: unknown,
    expected: RemoteRunBinding['drive'],
  ): void {
    let actual: string;
    try {
      actual = privateHash(raw);
    } catch {
      deny('remote-permit-revoked');
    }
    if (
      declaration.id !== expected.id ||
      !safeEqual(declaration.sha256, expected.sha256) ||
      !safeEqual(actual, expected.sha256)
    )
      deny('remote-permit-revoked');
  }
  private checkLive(
    value: Loaded,
    lease: ExecutionMemberLease,
    sessionHash: string,
    mutation: boolean,
  ): void {
    const remote = value.remote;
    if (!mutation) return;
    if (remote.stopRequested || value.run.attempt.stopPhase !== 'none')
      deny('remote-permit-revoked');
    if (remote.drive.epoch !== this.epoch || remote.drive.expiresAt <= this.now())
      deny('remote-permit-expired');
    if (remote.memberSessionHash !== sessionHash) deny('remote-permit-revoked');
    if (isTerminalRunStatus(value.run.attempt.status)) {
      if (
        value.run.attempt.status !== 'completed' ||
        value.run.resources !== 'settled' ||
        !remote.result
      )
        deny('remote-permit-revoked');
      return;
    }
    const original = this.active.get(value.run.attempt.id);
    if (!original || original.sessionHash !== sessionHash || original.lease.signal.aborted)
      deny('remote-recovery-required');
    original.lease.assertCurrent(value.run.spaceId);
    lease.assertCurrent(value.run.spaceId);
  }
  private view(value: Loaded, cleanupOnly = false, sessionCurrent = true): RemoteRunView {
    const { node, state, run, remote } = value;
    const original = this.active.get(run.attempt.id);
    let originalCurrent = false;
    if (original && !original.lease.signal.aborted && original.lease.expiresAt > this.now()) {
      try {
        original.lease.assertCurrent(run.spaceId);
        originalCurrent = true;
      } catch {
        this.release(run.attempt.id);
      }
    }
    const live =
      sessionCurrent &&
      !cleanupOnly &&
      !this.closed &&
      !this.source.signal.aborted &&
      remote.drive.epoch === this.epoch &&
      remote.drive.expiresAt > this.now() &&
      !remote.stopRequested &&
      run.attempt.stopPhase === 'none';
    const authority =
      live && run.attempt.status === 'completed' && run.resources === 'settled' && remote.result
        ? 'commit-only'
        : live && !isTerminalRunStatus(run.attempt.status) && originalCurrent
          ? 'drive'
          : cleanupOnly || remote.stopRequested
            ? 'cleanup-only'
            : 'recovery-required';
    const { id: driveId, epoch: driveEpoch, expiresAt: driveExpiry } = remote.drive;
    const { id: cleanupId, epoch: cleanupEpoch, expiresAt: cleanupExpiry } = remote.cleanup;
    return {
      scope: { ...executionRunScope(node, run), backendId: remote.backendId },
      deviceId: remote.deviceId,
      serverTime: this.now(),
      authority,
      permit: { id: driveId, epoch: driveEpoch, expiresAt: driveExpiry },
      cleanup: { id: cleanupId, epoch: cleanupEpoch, expiresAt: cleanupExpiry },
      nodeVersion: node.command.version,
      runVersion: state.version,
      nextSequence: run.attempt.lastEventSequence + 1,
      stopRequested: remote.stopRequested || run.attempt.stopPhase !== 'none',
      resources: run.resources,
      runStatus: run.attempt.status,
      ...(remote.lastObservation ? { cleanupPhase: remote.lastObservation } : {}),
      ...(!cleanupOnly && remote.result ? { result: remote.result } : {}),
      ...(!cleanupOnly && remote.receipt ? { receipt: remote.receipt } : {}),
    };
  }
  private async save(value: Loaded, run: ExecutionRun, node = value.node): Promise<Loaded> {
    const state = readExecutionRunState(node)!;
    const next = withExecutionRunState(node, {
      ...state,
      version: Math.max(state.version, value.state.version + 1),
      runs: state.runs.map((item) => (item.attempt.id === run.attempt.id ? run : item)),
    });
    await this.source.writeNode(next);
    return this.load({ ...executionRunScope(next, run), backendId: run.remote!.backendId });
  }
  private savedSnapshot(value: Loaded) {
    const composition = value.run.composition;
    if (!composition) deny('remote-unavailable');
    const shared = remoteRunSharedSnapshotSchema.parse({
      configurationId: composition.configurationId,
      composition,
      context: composition.payload.context,
      handoff: composition.payload.handoff,
      inputs: value.remote.inputs,
    });
    return { selection: value.run.selection, shared };
  }
  private acceptValue(
    value: Loaded,
    disposition: 'accepted' | 'replayed',
    sessionCurrent = true,
  ): RemoteAcceptValue {
    return {
      ...this.view(value, false, sessionCurrent),
      ...this.savedSnapshot(value),
      disposition,
    };
  }
  private reconcileValue(value: Loaded, sessionCurrent = true) {
    return { ...this.view(value, false, sessionCurrent), ...this.savedSnapshot(value) };
  }
  private inputSnapshot(
    scope: RemoteRunScope,
    node: ExecutionNodeRecord,
    sourceNodeId: string,
    artifactVersionId: string,
  ) {
    const content = this.source.readInput(
      scope.actorId,
      scope.spaceId,
      node,
      sourceNodeId,
      artifactVersionId,
    );
    if (!content) deny('remote-input-stale');
    const data = Buffer.from(canonicalPayload(content), 'utf8');
    // Original bounded accepted text/links JSON, never a transcript, link fetch or file body.
    if (data.byteLength > 1024 * 1024) deny('remote-quota');
    const descriptor: RemoteInputDescriptor = {
      slotId: `input_${hash({ scope, sourceNodeId, artifactVersionId })}`,
      kind: 'text',
      name: `${sourceNodeId} · 第 ${content.version.version} 版`,
      sourceNodeId,
      artifactVersionId,
      byteSize: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
    return { descriptor, data };
  }
  private inputCatalog(scope: RemoteRunScope, node: ExecutionNodeRecord) {
    return node.handoff.inputRefs.map(
      (ref) => this.inputSnapshot(scope, node, ref.sourceNodeId, ref.artifactVersionId).descriptor,
    );
  }
  private requireInputDrive(value: Loaded): void {
    if (isTerminalRunStatus(value.run.attempt.status) || value.run.resources !== 'held')
      deny('remote-permit-revoked');
  }
  private assertInputCatalog(value: Loaded): void {
    const scope = {
      ...executionRunScope(value.node, value.run),
      backendId: value.remote.backendId,
    };
    if (!same(this.inputCatalog(scope, value.node), value.remote.inputs))
      deny('remote-input-stale');
  }
  private readInput(body: Extract<RemoteRunRequest, { operation: 'input-read' }>, value: Loaded) {
    this.requireInputDrive(value);
    const slot = value.remote.inputs.find((item) => item.slotId === body.payload.slotId);
    if (!slot?.sourceNodeId || !slot.artifactVersionId || slot.kind !== 'text')
      deny('remote-input-stale');
    const current = this.inputSnapshot(
      body.payload.scope,
      value.node,
      slot.sourceNodeId,
      slot.artifactVersionId,
    );
    if (!same(current.descriptor, slot)) deny('remote-input-stale');
    const offset = body.payload.offset;
    if (offset > current.data.byteLength) deny('remote-validation');
    const chunk = current.data.subarray(offset, offset + body.payload.maximumBytes);
    return {
      scope: body.payload.scope,
      slotId: slot.slotId,
      offset,
      byteSize: chunk.byteLength,
      totalBytes: current.data.byteLength,
      sha256: slot.sha256,
      base64: chunk.toString('base64'),
      eof: offset + chunk.byteLength === current.data.byteLength,
    };
  }
  private async accept(
    body: Accept,
    lease: ExecutionMemberLease,
    sessionHash: string,
  ): Promise<RemoteAcceptValue> {
    const device = this.checkDevice(body, lease.memberId);
    const payload = body.payload;
    lease.assertCurrent(payload.target.spaceId);
    const node = this.source.readNode(payload.target);
    if (!node) deny('remote-not-found');
    this.source.assertTarget(lease.memberId, payload.target, node);
    const state = readExecutionRunState(node);
    const fingerprint = hash({ actorId: lease.memberId, deviceId: device.deviceId, payload });
    const previous = state?.runs.find((item) => item.remote?.acceptRequestId === body.requestId);
    if (previous?.remote) {
      if (
        previous.remote.acceptFingerprint !== fingerprint ||
        previous.remote.deviceId !== body.deviceId ||
        previous.actorId !== lease.memberId
      )
        deny('remote-idempotency-mismatch');
      const loaded = this.load({ ...executionRunScope(node, previous), backendId: body.backendId });
      this.authorize(loaded, lease);
      return this.acceptValue(loaded, 'replayed', loaded.remote.memberSessionHash === sessionHash);
    }
    if (
      this.active.size >= REMOTE_RUN_LIMITS.activeAuthorities ||
      this.source
        .listNodes()
        .flatMap((record) => readExecutionRunState(record)?.runs ?? [])
        .filter((run) => run.remote && run.resources === 'held').length >=
        REMOTE_RUN_LIMITS.activeAuthorities
    )
      deny('remote-quota');
    // First interoperable slice is original text completion. Unsupported source ports refuse explicitly.
    if (
      payload.capabilities.resultIntent !== 'zhuma-native-result-intent@1' ||
      payload.capabilities.outputFile ||
      payload.capabilities.acceptedFile ||
      payload.capabilities.localTools.length ||
      payload.workspace.kind !== 'text-only' ||
      node.handoff.skillRefs.length ||
      node.handoff.mcpRefs.length
    )
      deny('remote-protocol-unsupported');
    if (node.handoff.inputRefs.length && payload.capabilities.acceptedInput !== '1')
      deny('remote-protocol-unsupported');
    if (
      payload.credentials.drive.id === payload.credentials.cleanup.id ||
      payload.credentials.drive.sha256 === payload.credentials.cleanup.sha256
    )
      deny('remote-validation');
    const scope = {
      actorId: lease.memberId,
      ...payload.target,
      runId: randomUUID(),
      generation: (state?.runs.length ?? 0) + 1,
      segmentId: randomUUID(),
    };
    const composition = this.source.compose(lease.memberId, body, node, scope);
    const inputs = this.inputCatalog({ ...scope, backendId: body.backendId }, node);
    const projected = executionRunCompositionRequest(composition);
    const decision = beginExecutionRun(
      node,
      {
        requestId: body.requestId,
        actorId: lease.memberId,
        spaceId: payload.target.spaceId,
        expectedNodeVersion: payload.expectedNodeVersion,
        expectedRunVersion: payload.expectedRunVersion,
        mode: payload.mode,
        newRunId: scope.runId,
        newSegmentId: scope.segmentId,
        inputFingerprint: projected.inputFingerprint,
        selection: projected.selection,
        expertVersionId: projected.expertVersionId,
        contextRefs: projected.contextRefs,
        workspace: payload.workspace,
        composition,
      },
      this.source.listNodes(),
      { expertEnabled: true, executorConnected: true, writerState: this.source.readGlobal() },
    );
    const remote: RemoteRunBinding = {
      protocolVersion: 1,
      backendId: body.backendId,
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      keyEpoch: device.keyEpoch,
      acceptRequestId: body.requestId,
      acceptFingerprint: fingerprint,
      memberSessionHash: sessionHash,
      stopRequested: false,
      inputs,
      controls: [],
      drive: {
        ...payload.credentials.drive,
        epoch: this.epoch,
        expiresAt: this.now() + REMOTE_RUN_LIMITS.driveTtlMs,
      },
      cleanup: {
        ...payload.credentials.cleanup,
        epoch: this.epoch,
        expiresAt: this.now() + REMOTE_RUN_LIMITS.cleanupTtlMs,
      },
    };
    const run = { ...decision.run, remote };
    const next = withExecutionRunState(decision.record, {
      ...readExecutionRunState(decision.record)!,
      runs: [...(state?.runs ?? []), run],
    });
    lease.assertCurrent(payload.target.spaceId);
    this.source.assertTarget(lease.memberId, payload.target, this.source.readNode(payload.target)!);
    await this.source.writeNode(next);
    return this.acceptValue(this.load({ ...scope, backendId: body.backendId }), 'accepted');
  }
  private async renew(body: Extract<RemoteRunRequest, { operation: 'renew' }>, value: Loaded) {
    if (isTerminalRunStatus(value.run.attempt.status)) deny('remote-permit-revoked');
    const fingerprint = hash(body.payload);
    const prior = value.remote.controls.find((item) => item.requestId === body.requestId);
    if (prior) {
      if (prior.operation !== 'renew' || prior.fingerprint !== fingerprint)
        deny('remote-idempotency-mismatch');
      return this.view(value);
    }
    // Reserve a final control slot for Stop even if a device floods renewals.
    if (value.remote.controls.length >= 4095) deny('remote-quota');
    const expiresAt = Math.min(
      this.now() + REMOTE_RUN_LIMITS.driveTtlMs,
      value.remote.cleanup.expiresAt,
    );
    if (expiresAt <= this.now()) deny('remote-permit-expired');
    const next = await this.save(value, {
      ...value.run,
      remote: {
        ...value.remote,
        drive: { ...value.remote.drive, expiresAt },
        controls: [
          ...value.remote.controls,
          { operation: 'renew', requestId: body.requestId, fingerprint },
        ],
      },
    });
    const original = this.active.get(value.run.attempt.id);
    if (original) {
      clearTimeout(original.timer);
      original.timer = setTimeout(
        () => this.release(value.run.attempt.id),
        Math.max(0, expiresAt - this.now()),
      );
      original.timer.unref();
    }
    return this.view(next);
  }
  private sequence(value: Loaded, sequence: number, fingerprint: string): 'new' | 'replayed' {
    const prior = value.remote.lastWireEvent;
    if (sequence === prior?.sequence) {
      if (prior.fingerprint !== fingerprint) deny('remote-idempotency-mismatch');
      return 'replayed';
    }
    if (sequence <= value.run.attempt.lastEventSequence) deny('remote-event-stale');
    if (sequence !== value.run.attempt.lastEventSequence + 1) deny('remote-sequence-gap');
    return 'new';
  }
  private async event(body: Extract<RemoteRunRequest, { operation: 'event' }>, value: Loaded) {
    const event = body.payload.event;
    const fingerprint = hash(event);
    if (this.sequence(value, event.sequence, fingerprint) === 'replayed')
      return { ...this.view(value), disposition: 'replayed' };
    if (isTerminalRunStatus(value.run.attempt.status)) deny('remote-permit-revoked');
    if (event.kind === 'completed') {
      const source = event.result.source;
      if (
        source.toolVersion !== 'zhuma-native-result-intent@1' ||
        !same(source.scope, executionRunScope(value.node, value.run)) ||
        source.configurationId !== value.run.selection.configurationId ||
        source.nativeSessionId !== value.run.attempt.sessionId ||
        source.nativeAgentId !== value.run.attempt.executorRunId
      )
        deny('remote-scope-mismatch');
    }
    const control = event.kind === 'stop-received' || event.kind === 'retiring';
    const native = control
      ? { kind: 'idle' as const, sequence: event.sequence }
      : event.kind === 'completed'
        ? {
            kind: event.kind,
            sequence: event.sequence,
            idle: event.idle,
            flushed: event.flushed,
            resourcesSettled: event.resourcesSettled,
          }
        : event;
    const decision = recordExecutionRunEvent(value.node, {
      runId: value.run.attempt.id,
      generation: value.run.attempt.generation,
      segmentId: value.run.segmentId,
      ...native,
    });
    if (decision.disposition !== 'applied') deny('remote-conflict');
    const run: ExecutionRun = {
      ...decision.run,
      remote: {
        ...value.remote,
        lastWireEvent: { sequence: event.sequence, fingerprint },
        ...(control ? { lastObservation: event.kind as 'stop-received' | 'retiring' } : {}),
        ...(control ? { stopRequested: true } : {}),
        ...(event.kind === 'completed'
          ? { result: event.result, lastObservation: 'drained' as const }
          : {}),
        ...(event.kind === 'stopped' ? { lastObservation: 'drained' as const } : {}),
      },
    };
    const next = await this.save(value, run, decision.record);
    if (control || isTerminalRunStatus(run.attempt.status)) this.release(run.attempt.id);
    return { ...this.view(next), disposition: 'applied' };
  }
  private async stop(
    body: Extract<RemoteRunRequest, { operation: 'stop' }>,
    lease: ExecutionMemberLease,
  ) {
    const value = this.load(body.payload.scope);
    this.authorize(value, lease);
    const fingerprint = hash({ scope: body.payload.scope, actorId: lease.memberId });
    const prior = value.remote.controls.find((item) => item.requestId === body.requestId);
    if (prior) {
      if (prior.operation !== 'stop' || prior.fingerprint !== fingerprint)
        deny('remote-idempotency-mismatch');
      return { ...this.view(value), disposition: 'replayed' };
    }
    if (value.remote.controls.length >= 4096 || value.remote.stopRequested) deny('remote-conflict');
    if (value.remote.receipt) deny('remote-conflict');
    if (
      body.payload.expectedNodeVersion !== value.node.command.version ||
      body.payload.expectedRunVersion !== value.state.version
    )
      deny('remote-conflict');
    let run = value.run,
      node = value.node;
    if (!isTerminalRunStatus(run.attempt.status)) {
      const decision = requestExecutionRunStop(node, {
        runId: run.attempt.id,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        requestId: body.requestId,
        actorId: lease.memberId,
        expectedNodeVersion: body.payload.expectedNodeVersion,
        expectedRunVersion: body.payload.expectedRunVersion,
      });
      run = decision.run;
      node = decision.record;
    }
    const next = await this.save(
      value,
      {
        ...run,
        remote: {
          ...value.remote,
          stopRequested: true,
          controls: [
            ...value.remote.controls,
            { operation: 'stop', requestId: body.requestId, fingerprint },
          ],
        },
      },
      node,
    );
    this.release(run.attempt.id);
    return { ...this.view(next), disposition: 'applied' };
  }
  private async cleanup(
    body: Extract<RemoteRunRequest, { operation: 'cleanup' }>,
    rawPermit: unknown,
  ) {
    const value = this.load(body.payload.scope);
    if (body.deviceId !== value.remote.deviceId) deny('remote-device-mismatch');
    this.proof(body, value.remote.publicKey);
    this.checkPermit(body.payload.permit, rawPermit, value.remote.cleanup);
    if (value.remote.cleanup.expiresAt <= this.now()) deny('remote-permit-expired');
    const observation = body.payload.observation;
    const fingerprint = hash({ cleanup: observation });
    if (this.sequence(value, observation.sequence, fingerprint) === 'replayed')
      return { ...this.view(value, true), disposition: 'replayed' };
    let node = value.node,
      run = value.run;
    if (observation.kind === 'drained') {
      if (observation.evidence.basis === 'absent-unadmitted') {
        if (run.dispatch !== 'reserved' || run.attempt.sessionId || run.attempt.acknowledged)
          deny('remote-conflict');
      } else if (
        observation.evidence.nativeSessionId !== run.attempt.sessionId ||
        (run.attempt.executorRunId &&
          observation.evidence.nativeAgentId !== run.attempt.executorRunId)
      )
        deny('remote-scope-mismatch');
      if (!isTerminalRunStatus(run.attempt.status)) {
        const stopped = requestRunStop(run.attempt);
        if (!stopped.ok) deny('remote-conflict');
        run = { ...run, attempt: stopped.attempt as ExecutionRun['attempt'] };
        node = withExecutionRunState(node, {
          ...value.state,
          runs: value.state.runs.map((item) => (item.attempt.id === run.attempt.id ? run : item)),
        });
      }
      const decision = recordExecutionRunEvent(node, {
        runId: run.attempt.id,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        sequence: observation.sequence,
        kind: isTerminalRunStatus(run.attempt.status) ? 'cleanup' : 'stopped',
        idle: true,
        flushed: true,
        resourcesSettled: true,
      });
      node = decision.record;
      run = decision.run;
    } else {
      // Control receipts consume sequence without certifying physical drain or terminal state.
      if (isTerminalRunStatus(run.attempt.status)) {
        // A failed-but-held Run may still report progress, without pretending to settle it.
        run = {
          ...run,
          attempt: { ...run.attempt, lastEventSequence: observation.sequence },
          lastEvent: { sequence: observation.sequence, fingerprint },
        };
      } else {
        const decision = recordExecutionRunEvent(node, {
          runId: run.attempt.id,
          generation: run.attempt.generation,
          segmentId: run.segmentId,
          sequence: observation.sequence,
          kind: 'idle',
        });
        if (decision.disposition !== 'applied') deny('remote-conflict');
        node = decision.record;
        run = decision.run;
      }
    }
    const next = await this.save(
      value,
      {
        ...run,
        remote: {
          ...value.remote,
          stopRequested: true,
          lastObservation:
            value.remote.lastObservation === 'drained' ? 'drained' : observation.kind,
          lastWireEvent: { sequence: observation.sequence, fingerprint },
        },
      },
      node,
    );
    this.release(run.attempt.id);
    return { ...this.view(next, true), disposition: 'applied' };
  }
  private async reconcile(
    body: Extract<RemoteRunRequest, { operation: 'reconcile' }>,
    lease: ExecutionMemberLease,
    rawPermit: unknown,
    sessionHash: string,
  ) {
    let scope: RemoteRunScope;
    if ('target' in body.payload) {
      const node = this.source.readNode(body.payload.target);
      if (!node) deny('remote-not-found');
      lease.assertCurrent(body.payload.target.spaceId);
      this.source.assertTarget(lease.memberId, body.payload.target, node);
      const id = body.payload.acceptRequestId;
      const run = readExecutionRunState(node)?.runs.find(
        (item) => item.remote?.acceptRequestId === id,
      );
      if (!run) deny('remote-not-found');
      scope = { ...executionRunScope(node, run), backendId: body.backendId };
    } else scope = body.payload.scope;
    const value = this.load(scope);
    this.authorize(value, lease);
    this.checkBinding(body, value);
    this.checkPermit(body.payload.permit, rawPermit, value.remote.drive);
    if ('lastSequence' in body.payload) {
      if (
        body.payload.lastSequence > value.run.attempt.lastEventSequence ||
        (body.payload.nativeSessionId &&
          body.payload.nativeSessionId !== value.run.attempt.sessionId) ||
        (body.payload.nativeAgentId &&
          body.payload.nativeAgentId !== value.run.attempt.executorRunId) ||
        (body.payload.resultRequestId &&
          body.payload.resultRequestId !== value.remote.result?.requestId)
      )
        deny('remote-scope-mismatch');
    }
    // Cold recovery may only reauthorize the already sealed exact result. Never a new drive.
    if (
      value.run.attempt.status === 'completed' &&
      value.run.resources === 'settled' &&
      value.remote.result &&
      !value.remote.receipt &&
      !value.remote.stopRequested &&
      value.run.attempt.stopPhase === 'none'
    ) {
      const next = await this.save(value, {
        ...value.run,
        remote: {
          ...value.remote,
          memberSessionHash: sessionHash,
          drive: {
            ...value.remote.drive,
            epoch: this.epoch,
            expiresAt: this.now() + REMOTE_RUN_LIMITS.driveTtlMs,
          },
        },
      });
      return this.reconcileValue(next);
    }
    return this.reconcileValue(value, value.remote.memberSessionHash === sessionHash);
  }
  private async submit(
    body: Extract<RemoteRunRequest, { operation: 'submit-result' }>,
    value: Loaded,
  ) {
    const result = body.payload.result;
    if (
      body.requestId !== result.requestId ||
      !value.remote.result ||
      !same(value.remote.result, result)
    )
      deny('remote-idempotency-mismatch');
    if (value.run.attempt.status !== 'completed' || value.run.resources !== 'settled')
      deny('remote-resource-held');
    const draft = remoteResultDigestInput(body.payload.draft);
    if (draft.files.length || result.source.toolVersion !== 'zhuma-native-result-intent@1')
      deny('remote-protocol-unsupported');
    const content = {
      links: draft.links,
      ...(draft.text === undefined ? {} : { text: draft.text }),
    };
    if (hash(draft) !== result.artifactDigest || nativeResultDigest(content) !== result.digest)
      deny('remote-idempotency-mismatch');
    if (value.remote.receipt) {
      await this.source.afterDelivery(value.node);
      return { scope: body.payload.scope, disposition: 'replayed', receipt: value.remote.receipt };
    }
    const common = {
      record: value.node,
      idempotencyKey: `remote-result:${result.requestId}`,
      expectedVersion: body.payload.expectedNodeVersion,
      draft: { ...content, files: [] as const },
      artifactId: randomUUID(),
      roundId: randomUUID(),
    };
    const decision =
      value.node.handoff.assignee.kind === 'human'
        ? submitDelivery({ ...common, actorId: value.run.actorId })
        : submitExpertDelivery({
            ...common,
            expertId: value.node.handoff.assignee.id,
            producerRunId: value.run.attempt.id,
            provenanceFingerprint: hash({
              result,
              scope: body.payload.scope,
              deviceId: value.remote.deviceId,
            }),
          });
    if (!decision.ok || (decision.disposition !== 'applied' && decision.disposition !== 'replayed'))
      deny('remote-conflict');
    const artifact = decision.record.artifactVersions.at(-1);
    if (!artifact) deny('remote-unavailable');
    const receipt = {
      requestId: result.requestId,
      digest: result.digest,
      artifactDigest: result.artifactDigest,
      artifactVersionId: artifact.id,
      ...(decision.record.currentRoundId ? { roundId: decision.record.currentRoundId } : {}),
    };
    const saved = await this.save(
      value,
      { ...value.run, remote: { ...value.remote, receipt } },
      this.source.prepareDelivery(decision.record, value.run.actorId),
    );
    await this.source.afterDelivery(saved.node);
    return {
      scope: body.payload.scope,
      disposition: decision.disposition === 'applied' ? 'committed' : 'replayed',
      receipt,
    };
  }
}
