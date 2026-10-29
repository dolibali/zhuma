import { createHash } from 'node:crypto';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_RESOURCE_SOURCE_VERSION,
  remoteReviewRequestSchema,
  remoteReviewResponseSchema,
  remoteReviewSharedSnapshotSchema,
  type AppliedPlan,
  type ExecutionNodeRecord,
  type RemoteReviewRequest,
  type RemoteReviewAcceptRequest,
  type RemoteReviewDeviceRequest,
  type RemoteReviewScope,
  type RemoteReviewView,
  type RemoteReviewAcceptValue,
  type RemoteRunResponse,
  type RemoteRunErrorCode,
  type RemoteWorkflowBinding,
  type RemoteWorkflowRef,
} from '@zhuma/agent-core';
import { memberSessionId, type MemberRequest } from './member-session.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import type { RemoteBackendRegistry } from './remote-run-authority-state.js';
import type { ExecutionWriterGlobal } from './execution-run-protocol.js';
import {
  prepareExecutionReviewWriter,
  executionRunGlobalSchema,
} from './execution-run-protocol.js';
import { RemoteRunError } from './remote-run-authority.js';
import {
  type ExecutionReviewScope,
  type ExecutionReviewAttempt,
  ExecutionReviewError,
} from './execution-review-contract.js';
import {
  readExecutionReviewState,
  prepareExecutionReview,
  type ExecutionReviewNode,
} from './execution-review-state.js';
import { admitExecutionReview, recordExecutionReviewEvent } from './execution-review-lifecycle.js';
import {
  readExecutionReviewComposition,
  executionReviewCompositionRequest,
  type ExecutionReviewPreparation,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import {
  commitExecutionReviewFixedResult,
  readExecutionReviewFixedReceipt,
  readExecutionReviewFailure,
  recordExecutionReviewFailure,
  ExecutionReviewFixedResultError,
} from './execution-review-fixed-result.js';
import {
  withExecutionReviewResourceQualification,
  ExecutionRunResourceQualificationCloseError,
  type ExecutionRunResourceCatalogHost,
} from './execution-run-resource-qualification.js';
import type { ExecutionRunResourceCatalog } from './execution-run-resource-snapshot.js';
import type { RemoteReviewBinding } from './remote-review-state.js';
import type {
  ExecutionReviewTargetReadLease,
  ExecutionReviewResource,
} from './execution-review-target-reader.js';
import {
  nativeReviewContextFromScope,
  NATIVE_REVIEW_LIMITS,
} from './native-work-session-review-contract.js';
import { ArtifactUploadError } from './artifact-files.js';

type Attempt = Exclude<ExecutionReviewAttempt, { status: 'prepared' }>;
type Loaded = { node: ExecutionReviewNode; attempt: Attempt; remote: RemoteReviewBinding };
type Query = Pick<
  RemoteReviewAcceptRequest['payload'],
  'target' | 'expectedReviewVersion' | 'reviewerRef' | 'workflow'
> & { requestId: string };
type Prepared = {
  node: ExecutionNodeRecord;
  applied: AppliedPlan;
  prepared: ReturnType<typeof prepareExecutionReview>;
};
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const terminal = (a: Attempt) => ['completed', 'failed', 'cancelled'].includes(a.status);
function fail(code: RemoteRunErrorCode): never {
  throw new RemoteRunError(code);
}
/** Original registry/device/permit/lease owner, shared with the author Run lane. */
export interface RemoteReviewCredentials {
  readonly workflow?: {
    readonly owner: object;
    accept(
      body: RemoteReviewAcceptRequest,
      lease: ExecutionMemberLease,
      sessionHash: string,
    ): RemoteWorkflowBinding;
    preparing(
      body: RemoteReviewAcceptRequest,
      lease: ExecutionMemberLease,
      sessionHash: string,
    ): { readonly signal: AbortSignal; finish(cleanupConfirmed?: boolean): void };
    check(
      lease: ExecutionMemberLease,
      scope: RemoteReviewScope,
      ref: RemoteWorkflowRef,
      deviceId: string,
      keyEpoch: number,
    ): void;
  };
  readonly epoch: string;
  now(): number;
  registry(): RemoteBackendRegistry;
  checkDevice(body: RemoteReviewDeviceRequest, actorId: string, verifyProof?: boolean): void;
  proof(body: RemoteReviewDeviceRequest, key: string): void;
  checkPermit(
    declaration: { id: string; sha256: string },
    raw: unknown,
    expected: RemoteReviewBinding['drive'],
  ): void;
  active(runId: string): { lease: ExecutionMemberLease; sessionHash: string } | undefined;
  retain(runId: string, lease: ExecutionMemberLease, sessionHash: string, expiresAt: number): void;
  release(runId: string): void;
  renew(runId: string, expiresAt: number): void;
  takeDevice(deviceId: string): () => void;
  heldCount(): number;
}
export interface RemoteReviewTargetGrant {
  readonly scope: ExecutionReviewScope;
  readonly signal: AbortSignal;
  check(): undefined;
  cancel(): void;
}
export interface RemoteReviewTargetPort {
  list(grant: RemoteReviewTargetGrant): readonly ExecutionReviewResource[];
  read(
    grant: RemoteReviewTargetGrant,
    query: unknown,
    signal: AbortSignal,
  ): Promise<ExecutionReviewTargetReadLease & { readonly drain: Promise<void> }>;
}
/** Host-only original-service methods. No wire value implements this port. */
export interface RemoteReviewAuthoritySource {
  readonly signal: AbortSignal;
  readonly resourceHost: ExecutionRunResourceCatalogHost;
  enabled(): boolean;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  memberLease(request: MemberRequest): Promise<ExecutionMemberLease>;
  readGlobal(): unknown;
  writeGlobal(next: ExecutionWriterGlobal): Promise<void>;
  readNode(target: Query['target']): ExecutionNodeRecord | undefined;
  writeNode(next: ExecutionNodeRecord): Promise<void>;
  prepare(lease: ExecutionMemberLease, query: Query, configurationId?: string): Prepared;
  compose(
    preparation: ExecutionReviewPreparation,
    body: RemoteReviewAcceptRequest,
    catalog: ExecutionRunResourceCatalog,
  ): FrozenExecutionReviewComposition;
  assertTarget(
    actorId: string,
    scope: ExecutionReviewScope,
    node: ExecutionNodeRecord,
    current: boolean,
  ): void;
  targetPort(issuer: RemoteReviewAuthorities): RemoteReviewTargetPort;
  stampBallot(node: ExecutionNodeRecord, reviewerId: string): ExecutionNodeRecord;
  afterCommit(node: ExecutionNodeRecord): Promise<void>;
}
class OutsideQueue {
  constructor(readonly run: () => Promise<unknown>) {}
}
function mapped(error: unknown): RemoteRunError {
  if (error instanceof RemoteRunError) return error;
  const code =
    error instanceof ExecutionReviewError ||
    error instanceof ExecutionReviewFixedResultError ||
    error instanceof ArtifactUploadError
      ? error.code
      : '';
  if (code.includes('idempotency')) return new RemoteRunError('remote-idempotency-mismatch');
  if (code.includes('conflict') || code.includes('already-voted'))
    return new RemoteRunError('remote-conflict');
  if (code.includes('stale') || code.includes('target-changed'))
    return new RemoteRunError('remote-input-stale');
  if (code.includes('capacity') || code.includes('budget') || code.includes('quota'))
    return new RemoteRunError('remote-quota');
  if (code.includes('author-active') || code.includes('native-active'))
    return new RemoteRunError('remote-resource-held');
  if (
    code.includes('self-review') ||
    code.includes('not-assigned') ||
    code.includes('not-controller')
  )
    return new RemoteRunError('remote-forbidden');
  if (code.includes('unsupported-material'))
    return new RemoteRunError('remote-protocol-unsupported');
  if (code.includes('invalid') || code.includes('validation') || code === 'review-read-required')
    return new RemoteRunError('remote-validation');
  return new RemoteRunError('remote-unavailable');
}

/** Uses only original review attempts/rounds/ballots. Sealing a transport cut never votes. */
export class RemoteReviewAuthorities {
  private closed = false;
  private releaseFailed = false;
  private readonly jobs = new Set<Promise<RemoteRunResponse<unknown>>>();
  private readonly readers = new Map<string, Set<{ cancel(): void; drain: Promise<void> }>>();
  private readonly grants = new WeakMap<RemoteReviewTargetGrant, () => undefined>();
  private qualificationFailure: ExecutionRunResourceQualificationCloseError | undefined;
  constructor(
    private readonly source: RemoteReviewAuthoritySource,
    private readonly credentials: RemoteReviewCredentials,
  ) {}
  ready(): boolean {
    return (
      !this.qualificationFailure &&
      !this.closed &&
      this.source.enabled() &&
      !this.source.signal.aborted &&
      typeof this.source.resourceHost.prepareReviewResourceCatalog === 'function'
    );
  }
  cancelRun(runId: string): void {
    for (const reader of this.readers.get(runId) ?? []) reader.cancel();
  }
  fence(): void {
    this.closed = true;
    for (const id of this.readers.keys()) this.cancelRun(id);
  }
  async close(): Promise<void> {
    this.fence();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
    if (this.qualificationFailure) throw this.qualificationFailure;
    if (this.releaseFailed) throw new RemoteRunError('remote-unavailable');
  }
  assertTargetGrant(grant: RemoteReviewTargetGrant): undefined {
    const check = this.grants.get(grant);
    if (!check) fail('remote-forbidden');
    return check();
  }
  handle(
    request: MemberRequest,
    raw: unknown,
    secret?: string,
  ): Promise<RemoteRunResponse<unknown>> {
    const job = this.handleNow(request, raw, secret);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private load(scope: RemoteReviewScope): Loaded {
    if (scope.backendId !== this.credentials.registry().backendId) fail('remote-scope-mismatch');
    const node = this.source.readNode(scope.review.target);
    if (!node) fail('remote-not-found');
    const attempt = readExecutionReviewState(node)?.attempts.find(
      (a) => a.scope.runId === scope.runId,
    );
    const { backendId: _backend, ...native } = scope;
    if (
      !attempt ||
      attempt.status === 'prepared' ||
      !attempt.remote ||
      !same(attempt.scope, native) ||
      attempt.remote.backendId !== scope.backendId
    )
      fail('remote-scope-mismatch');
    return { node: node as ExecutionReviewNode, attempt, remote: attempt.remote };
  }
  private scope(value: Loaded): RemoteReviewScope {
    return { ...value.attempt.scope, backendId: value.remote.backendId };
  }
  private authorize(value: Loaded, lease: ExecutionMemberLease, current = false): void {
    if (lease.signal.aborted || lease.expiresAt <= this.credentials.now())
      fail('remote-unauthenticated');
    lease.assertCurrent(value.attempt.scope.spaceId);
    if (lease.memberId !== value.attempt.scope.actorId) fail('remote-forbidden');
    this.source.assertTarget(lease.memberId, value.attempt.scope, value.node, current);
  }
  private binding(body: RemoteReviewDeviceRequest, value: Loaded): void {
    const key = this.credentials.registry().devices.find((d) => d.deviceId === body.deviceId);
    if (
      !key ||
      body.deviceId !== value.remote.deviceId ||
      key.keyEpoch !== value.remote.keyEpoch ||
      key.publicKey !== value.remote.publicKey
    )
      fail('remote-device-mismatch');
  }
  private live(
    value: Loaded,
    lease: ExecutionMemberLease,
    sessionHash: string,
    commit = false,
  ): void {
    this.authorize(value, lease, !commit);
    if (value.remote.workflow) {
      if (!this.credentials.workflow) fail('remote-protocol-unsupported');
      this.credentials.workflow.check(
        lease,
        this.scope(value),
        value.remote.workflow,
        value.remote.deviceId,
        value.remote.keyEpoch,
      );
    }
    if (
      this.closed ||
      this.source.signal.aborted ||
      value.remote.stopRequested ||
      value.attempt.stopPhase !== 'none'
    )
      fail('remote-permit-revoked');
    if (
      value.remote.drive.epoch !== this.credentials.epoch ||
      value.remote.drive.expiresAt <= this.credentials.now()
    )
      fail('remote-permit-expired');
    if (value.remote.memberSessionHash !== sessionHash) fail('remote-permit-revoked');
    if (commit) {
      if (!value.remote.result) fail('remote-recovery-required');
      return;
    }
    const owner = this.credentials.active(value.attempt.scope.runId);
    if (
      !owner ||
      owner.sessionHash !== sessionHash ||
      owner.lease.signal.aborted ||
      owner.lease.expiresAt <= this.credentials.now()
    )
      fail('remote-recovery-required');
    owner.lease.assertCurrent(value.attempt.scope.spaceId);
    if (terminal(value.attempt) || value.attempt.resources !== 'held' || value.remote.result)
      fail('remote-permit-revoked');
  }
  private view(value: Loaded, sessionHash?: string, cleanup = false): RemoteReviewView {
    const a = value.attempt,
      remote = value.remote,
      receipt = readExecutionReviewFixedReceipt(value.node, a),
      failure = readExecutionReviewFailure(value.node, a);
    let authority: RemoteReviewView['authority'] = 'recovery-required';
    const owner = this.credentials.active(a.scope.runId);
    const allowed =
      !cleanup &&
      this.ready() &&
      !remote.stopRequested &&
      a.stopPhase === 'none' &&
      remote.drive.epoch === this.credentials.epoch &&
      remote.drive.expiresAt > this.credentials.now() &&
      remote.memberSessionHash === sessionHash;
    if (cleanup || remote.stopRequested || terminal(a)) authority = 'cleanup-only';
    if (
      allowed &&
      remote.result &&
      (a.status === 'running' || (a.status === 'completed' && a.resources === 'settled' && receipt))
    )
      authority = 'commit-only';
    else if (
      allowed &&
      !remote.result &&
      !terminal(a) &&
      owner &&
      !owner.lease.signal.aborted &&
      owner.sessionHash === sessionHash
    ) {
      try {
        this.authorize(value, owner.lease, true);
        authority = 'drive';
      } catch {
        this.credentials.release(a.scope.runId);
      }
    }
    return {
      purpose: 'review',
      scope: this.scope(value),
      deviceId: remote.deviceId,
      serverTime: this.credentials.now(),
      authority,
      permit: { id: remote.drive.id, epoch: remote.drive.epoch, expiresAt: remote.drive.expiresAt },
      cleanup: {
        id: remote.cleanup.id,
        epoch: remote.cleanup.epoch,
        expiresAt: remote.cleanup.expiresAt,
      },
      nodeVersion: value.node.command.version,
      reviewVersion: readExecutionReviewState(value.node)!.version,
      attemptVersion: a.version,
      nextSequence: (remote.lastWireEvent?.sequence ?? 0) + 1,
      stopRequested: remote.stopRequested || a.stopPhase !== 'none',
      resources: a.resources,
      runStatus: a.status,
      ...(remote.lastObservation ? { cleanupPhase: remote.lastObservation } : {}),
      ...(!cleanup && remote.result ? { result: remote.result } : {}),
      ...(!cleanup && receipt ? { receipt } : {}),
      ...(!cleanup && failure ? { failure } : {}),
    };
  }
  private snapshot(value: Loaded) {
    const composition = readExecutionReviewComposition(value.attempt.composition);
    const projected = executionReviewCompositionRequest(composition);
    return {
      selection: projected.selection,
      shared: remoteReviewSharedSnapshotSchema.parse({
        configurationId: composition.configurationId,
        composition,
        resources: composition.payload.targetResources,
      }),
    };
  }
  private async save(
    value: Loaded,
    remote: RemoteReviewBinding,
    node: ExecutionReviewNode = value.node,
  ): Promise<Loaded> {
    const state = readExecutionReviewState(node)!;
    const original = state.attempts.find((a) => a.scope.runId === value.attempt.scope.runId);
    if (!original || original.status === 'prepared') fail('remote-conflict');
    const next: ExecutionReviewNode = {
      ...node,
      nativeExecution: {
        ...node.nativeExecution,
        review: {
          ...state,
          version: state.version + 1,
          attempts: state.attempts.map((a) =>
            a.scope.runId === original.scope.runId
              ? { ...original, version: original.version + 1, remote }
              : a,
          ),
        },
      },
    };
    readExecutionReviewState(next);
    await this.source.writeNode(next);
    return this.load(this.scope(value));
  }
  private domain(
    value: Loaded,
    kind: import('./execution-review-lifecycle.js').ExecutionReviewEvent['kind'],
    extra: Record<string, unknown> = {},
  ): ExecutionReviewNode {
    return recordExecutionReviewEvent(value.node, {
      scope: value.attempt.scope,
      sequence: value.attempt.lastEventSequence + 1,
      kind,
      ...extra,
    }).record;
  }
  private sequence(value: Loaded, sequence: number, fingerprint: string): 'new' | 'replayed' {
    const last = value.remote.lastWireEvent;
    if (last?.sequence === sequence) {
      if (last.fingerprint !== fingerprint) fail('remote-idempotency-mismatch');
      return 'replayed';
    }
    if (sequence <= (last?.sequence ?? 0)) fail('remote-event-stale');
    if (sequence !== (last?.sequence ?? 0) + 1) fail('remote-sequence-gap');
    return 'new';
  }
  private async drain(runId: string): Promise<void> {
    const readers = this.readers.get(runId);
    if (!readers) return;
    for (const reader of readers) reader.cancel();
    await Promise.all([...readers].map((reader) => reader.drain));
  }
  private input(
    body: Extract<RemoteReviewRequest, { operation: 'input-read' }>,
    value: Loaded,
    lease: ExecutionMemberLease,
    sessionHash: string,
    secret: unknown,
  ): OutsideQueue {
    if (value.attempt.status !== 'running') fail('remote-resource-held');
    const owner = this.credentials.active(value.attempt.scope.runId)?.lease;
    if (!owner) fail('remote-recovery-required');
    const life = new AbortController(),
      signal = AbortSignal.any([life.signal, owner.signal, this.source.signal]);
    const grant: RemoteReviewTargetGrant = Object.freeze({
      scope: freeze(structuredClone(value.attempt.scope)),
      signal,
      cancel: () => life.abort(),
      check: () => this.assertTargetGrant(grant),
    });
    this.grants.set(grant, () => {
      if (signal.aborted) fail('remote-permit-revoked');
      const current = this.load(body.payload.scope);
      this.binding(body, current);
      this.credentials.checkPermit(body.payload.permit, secret, current.remote.drive);
      this.live(current, owner, sessionHash);
      this.authorize(current, lease, true);
      return undefined;
    });
    grant.check();
    const port = this.source.targetPort(this);
    let resolve!: () => void;
    const reader = {
      cancel: grant.cancel,
      drain: new Promise<void>((done) => {
        resolve = done;
      }),
    };
    const readers = this.readers.get(value.attempt.scope.runId) ?? new Set<typeof reader>();
    readers.add(reader);
    this.readers.set(value.attempt.scope.runId, readers);
    return new OutsideQueue(async () => {
      let page: Awaited<ReturnType<RemoteReviewTargetPort['read']>> | undefined;
      const timer = setTimeout(grant.cancel, NATIVE_REVIEW_LIMITS.readTimeoutMs);
      timer.unref();
      try {
        grant.check();
        page = await port.read(
          grant,
          {
            resourceRef: body.payload.resourceRef,
            offset: body.payload.offset,
            length: body.payload.length,
          },
          signal,
        );
        page.check();
        grant.check();
        if (
          !same(page.scope, grant.scope) ||
          page.resource.resourceRef !== body.payload.resourceRef ||
          page.range.offset !== body.payload.offset ||
          page.bytes.length !== page.range.length ||
          page.bytes.length > body.payload.length
        )
          fail('remote-input-stale');
        const response = {
          purpose: 'review',
          scope: body.payload.scope,
          source: {
            context: nativeReviewContextFromScope(grant.scope),
            nativeSessionId: value.attempt.nativeSessionId!,
            nativeAgentId: value.attempt.nativeAgentId!,
            configurationId: value.attempt.configurationId,
            resourceRef: page.resource.resourceRef,
            resourceFingerprint: page.resource.resourceFingerprint,
          },
          range: page.range,
          encoding: page.encoding,
          sha256: createHash('sha256').update(page.bytes).digest('hex'),
          base64: Buffer.from(page.bytes).toString('base64'),
        };
        page.release();
        await page.drain;
        grant.check();
        return response;
      } finally {
        clearTimeout(timer);
        page?.release();
        if (page) await page.drain;
        grant.cancel();
        readers.delete(reader);
        if (!readers.size) this.readers.delete(value.attempt.scope.runId);
        resolve();
      }
    });
  }
  private async accept(
    body: RemoteReviewAcceptRequest,
    lease: ExecutionMemberLease,
    sessionHash: string,
    verified?: {
      catalog: ExecutionRunResourceCatalog;
      preparation: ExecutionReviewPreparation;
      assertCurrent(): undefined;
    },
  ): Promise<RemoteReviewAcceptValue> {
    const node = this.source.readNode(body.payload.target);
    if (!node) fail('remote-not-found');
    const state = readExecutionReviewState(node),
      prior = state?.attempts.find(
        (a) => 'remote' in a && a.remote?.acceptRequestId === body.requestId,
      );
    const fingerprint = hash({
      actorId: lease.memberId,
      deviceId: body.deviceId,
      payload: body.payload,
    });
    if (prior && prior.status !== 'prepared' && prior.remote) {
      if (prior.remote.acceptFingerprint !== fingerprint || prior.remote.deviceId !== body.deviceId)
        fail('remote-idempotency-mismatch');
      const loaded = this.load({ ...prior.scope, backendId: body.backendId });
      this.authorize(loaded, lease);
      return {
        ...this.view(loaded, sessionHash),
        ...this.snapshot(loaded),
        disposition: 'replayed',
      };
    }
    if (!this.ready() || !verified) fail('remote-protocol-unsupported');
    const workflow = body.payload.workflow
      ? (this.credentials.workflow?.accept(body, lease, sessionHash) ??
        fail('remote-protocol-unsupported'))
      : undefined;
    if (this.credentials.heldCount() >= REMOTE_RUN_LIMITS.activeAuthorities) fail('remote-quota');
    if (
      body.payload.credentials.drive.id === body.payload.credentials.cleanup.id ||
      body.payload.credentials.drive.sha256 === body.payload.credentials.cleanup.sha256
    )
      fail('remote-validation');
    const query = {
      requestId: body.requestId,
      target: body.payload.target,
      expectedReviewVersion: body.payload.expectedReviewVersion,
      reviewerRef: body.payload.reviewerRef,
      ...(body.payload.workflow ? { workflow: body.payload.workflow } : {}),
    };
    const prepared = this.source.prepare(lease, query);
    if (prepared.prepared.disposition !== 'applied') fail('remote-conflict'); // never adopt an old local reservation
    if (
      !same(verified.preparation, {
        scope: prepared.prepared.attempt.scope,
        node: prepared.node,
        applied: prepared.applied,
      })
    )
      fail('remote-input-stale');
    const composition = this.source.compose(verified.preparation, body, verified.catalog);
    if (composition.payload.resources.mcp.length) fail('remote-protocol-unsupported');
    const final = this.source.prepare(lease, query, composition.configurationId);
    verified.assertCurrent();
    const admitted = admitExecutionReview(final.prepared.record, {
      scope: final.prepared.attempt.scope,
      expectedAttemptVersion: final.prepared.attempt.version,
      composition,
    });
    if (admitted.attempt.status === 'prepared') fail('remote-unavailable');
    const device = this.credentials.registry().devices.find((d) => d.deviceId === body.deviceId)!;
    const remote: RemoteReviewBinding = {
      protocolVersion: 1,
      ...(workflow ? { workflow } : {}),
      backendId: body.backendId,
      deviceId: body.deviceId,
      publicKey: device.publicKey,
      keyEpoch: device.keyEpoch,
      acceptRequestId: body.requestId,
      acceptFingerprint: fingerprint,
      memberSessionHash: sessionHash,
      stopRequested: false,
      controls: [],
      drive: {
        ...body.payload.credentials.drive,
        epoch: this.credentials.epoch,
        expiresAt: Math.min(lease.expiresAt, this.credentials.now() + REMOTE_RUN_LIMITS.driveTtlMs),
      },
      cleanup: {
        ...body.payload.credentials.cleanup,
        epoch: this.credentials.epoch,
        expiresAt: this.credentials.now() + REMOTE_RUN_LIMITS.cleanupTtlMs,
      },
    };
    const review = readExecutionReviewState(admitted.record)!;
    const next: ExecutionReviewNode = {
      ...admitted.record,
      nativeExecution: {
        ...admitted.record.nativeExecution,
        review: {
          ...review,
          attempts: review.attempts.map((a) =>
            a.scope.runId === admitted.attempt.scope.runId ? { ...admitted.attempt, remote } : a,
          ),
        },
      },
    };
    readExecutionReviewState(next);
    remoteReviewSharedSnapshotSchema.parse({
      configurationId: composition.configurationId,
      composition,
      resources: composition.payload.targetResources,
    });
    this.source.targetPort(this); // require the genuine original reader before any format write
    const global = prepareExecutionReviewWriter(this.source.readGlobal());
    if (global.remoteExecutionReviewWriter !== 1)
      await this.source.writeGlobal({ ...global, remoteExecutionReviewWriter: 1 });
    if (executionRunGlobalSchema.parse(this.source.readGlobal()).remoteExecutionReviewWriter !== 1)
      fail('remote-unavailable');
    const fresh = this.source.prepare(lease, query, composition.configurationId);
    if (!same(fresh.node, final.node)) fail('remote-conflict');
    verified.assertCurrent();
    if (body.payload.workflow) this.credentials.workflow!.accept(body, lease, sessionHash);
    await this.source.writeNode(next);
    verified.assertCurrent();
    const loaded = this.load({ ...admitted.attempt.scope, backendId: body.backendId });
    return { ...this.view(loaded, sessionHash), ...this.snapshot(loaded), disposition: 'accepted' };
  }
  private async cleanup(
    body: Extract<RemoteReviewRequest, { operation: 'cleanup' }>,
    secret: unknown,
    proofAdmitted = false,
  ): Promise<unknown> {
    let value = this.load(body.payload.scope);
    if (body.deviceId !== value.remote.deviceId) fail('remote-device-mismatch');
    if (!proofAdmitted) this.credentials.proof(body, value.remote.publicKey);
    this.credentials.checkPermit(body.payload.permit, secret, value.remote.cleanup);
    if (value.remote.cleanup.expiresAt <= this.credentials.now()) fail('remote-permit-expired');
    const observation = body.payload.observation,
      fingerprint = hash({ cleanup: observation });
    if (this.sequence(value, observation.sequence, fingerprint) === 'replayed')
      return { ...this.view(value, undefined, true), disposition: 'replayed' };
    if (observation.kind === 'drained') {
      const unadmitted =
        value.attempt.dispatch === 'reserved' &&
        !value.attempt.nativeSessionId &&
        !value.attempt.nativeAgentId;
      if (observation.evidence.basis === 'absent-unadmitted') {
        if (!unadmitted) fail('remote-conflict');
      } else if (
        !unadmitted &&
        (observation.evidence.nativeSessionId !== value.attempt.nativeSessionId ||
          observation.evidence.nativeAgentId !== value.attempt.nativeAgentId)
      )
        fail('remote-scope-mismatch');
      if (this.readers.has(value.attempt.scope.runId))
        return new OutsideQueue(async () => {
          await this.drain(value.attempt.scope.runId);
          return this.source.enqueue(() => this.cleanup(body, secret, true));
        });
      let node = value.node;
      if (!terminal(value.attempt)) {
        if (value.attempt.stopPhase === 'none') {
          node = this.domain(value, 'stop-requested');
          value = {
            ...value,
            node,
            attempt: readExecutionReviewState(node)!.attempts.find(
              (a) => a.scope.runId === value.attempt.scope.runId,
            ) as Attempt,
          };
        }
        node = this.domain(value, 'stopped');
        value = {
          ...value,
          node,
          attempt: readExecutionReviewState(node)!.attempts.find(
            (a) => a.scope.runId === value.attempt.scope.runId,
          ) as Attempt,
        };
      }
      const drained = this.domain(value, 'cleanup');
      const next = await this.save(
        value,
        {
          ...value.remote,
          ...(value.attempt.status === 'cancelled' ? { stopRequested: true } : {}),
          lastObservation: 'drained',
          lastWireEvent: { sequence: observation.sequence, fingerprint },
        },
        drained,
      );
      this.credentials.release(next.attempt.scope.runId);
      return { ...this.view(next, undefined, true), disposition: 'applied' };
    }
    let node = value.node;
    if (!terminal(value.attempt) && value.attempt.stopPhase === 'none')
      node = this.domain(value, 'stop-requested');
    const next = await this.save(
      value,
      {
        ...value.remote,
        stopRequested: true,
        lastObservation: observation.kind,
        lastWireEvent: { sequence: observation.sequence, fingerprint },
      },
      node,
    );
    this.credentials.release(next.attempt.scope.runId);
    return { ...this.view(next, undefined, true), disposition: 'applied' };
  }
  private async stopValue(
    value: Loaded,
    lease: ExecutionMemberLease,
    scope: RemoteReviewScope,
    requestId: string,
    expectedVersion: number,
    sessionHash?: string,
  ): Promise<RemoteReviewView & { disposition: 'applied' | 'replayed' }> {
    const fingerprint = hash({ scope: scope, actorId: lease.memberId }),
      prior = value.remote.controls.find((c) => c.requestId === requestId);
    if (prior) {
      if (prior.operation !== 'stop' || prior.fingerprint !== fingerprint)
        fail('remote-idempotency-mismatch');
      return { ...this.view(value, sessionHash), disposition: 'replayed' };
    }
    if (
      expectedVersion !== value.attempt.version ||
      value.remote.stopRequested ||
      value.remote.controls.length >= 4096 ||
      readExecutionReviewFixedReceipt(value.node, value.attempt)
    )
      fail('remote-conflict');
    const node = terminal(value.attempt) ? value.node : this.domain(value, 'stop-requested');
    const next = await this.save(
      value,
      {
        ...value.remote,
        stopRequested: true,
        controls: [
          ...value.remote.controls,
          { operation: 'stop', requestId: requestId, fingerprint },
        ],
      },
      node,
    );
    this.credentials.release(next.attempt.scope.runId);
    this.cancelRun(next.attempt.scope.runId);
    return { ...this.view(next, sessionHash), disposition: 'applied' };
  }
  workflowView(
    owner: object,
    lease: ExecutionMemberLease,
    scope: RemoteReviewScope,
    sessionHash: string,
  ): RemoteReviewView {
    if (owner !== this.credentials.workflow?.owner) fail('remote-forbidden');
    const value = this.load(scope);
    this.authorize(value, lease);
    return this.view(value, sessionHash);
  }
  async workflowStop(
    owner: object,
    lease: ExecutionMemberLease,
    scope: RemoteReviewScope,
    intentId: string,
    requestId: string,
  ): Promise<void> {
    if (owner !== this.credentials.workflow?.owner) fail('remote-forbidden');
    const value = this.load(scope);
    this.authorize(value, lease);
    if (value.remote.workflow?.intentId !== intentId) fail('remote-scope-mismatch');
    if (value.remote.stopRequested || value.attempt.resources === 'settled') return;
    if (readExecutionReviewFixedReceipt(value.node, value.attempt)) {
      this.credentials.release(value.attempt.scope.runId);
      this.cancelRun(value.attempt.scope.runId);
      return;
    }
    await this.stopValue(value, lease, scope, requestId, value.attempt.version);
  }
  private async handleNow(
    request: MemberRequest,
    raw: unknown,
    secret?: string,
  ): Promise<RemoteRunResponse<unknown>> {
    const parsed = remoteReviewRequestSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > REMOTE_RUN_LIMITS.requestBytes)
      return { ok: false, error: { code: 'remote-validation' } };
    const body = parsed.data;
    let preparation:
      { readonly signal: AbortSignal; finish(cleanupConfirmed?: boolean): void } | undefined;
    let cleanupConfirmed = true;
    let lease: ExecutionMemberLease | undefined,
      retained = false,
      proofAdmitted = false;
    let releaseDevice: (() => void) | undefined;
    try {
      if (body.operation !== 'cleanup') {
        if (!this.ready()) fail('remote-protocol-unsupported');
        try {
          lease = await this.source.memberLease(request);
        } catch {
          fail('remote-unauthenticated');
        }
        if (!lease || lease.signal.aborted || lease.expiresAt <= this.credentials.now())
          fail('remote-unauthenticated');
      }
      if ('deviceId' in body) releaseDevice = this.credentials.takeDevice(body.deviceId);
      const session = lease && memberSessionId(request.headers.cookie);
      if (lease && !session) fail('remote-unauthenticated');
      const sessionHash = session ? hash(session) : '';
      const execute = (
        verified?: Parameters<RemoteReviewAuthorities['accept']>[3],
      ): Promise<unknown> =>
        this.source.enqueue(async () => {
          try {
            if (body.backendId !== this.credentials.registry().backendId)
              fail('remote-scope-mismatch');
            if (body.operation === 'cleanup') return this.cleanup(body, secret, proofAdmitted);
            if (this.closed || this.source.signal.aborted) fail('remote-unavailable');
            if (body.operation !== 'stop') {
              this.credentials.checkDevice(body, lease!.memberId, !proofAdmitted);
              proofAdmitted = true;
            }
            if (body.operation === 'accept')
              return this.accept(body, lease!, sessionHash, verified);
            let value: Loaded;
            if (body.operation === 'reconcile' && 'target' in body.payload) {
              const payload = body.payload;
              const node = this.source.readNode(body.payload.target),
                state = node && readExecutionReviewState(node);
              const prior = state?.attempts.find(
                (a) => 'remote' in a && a.remote?.acceptRequestId === payload.acceptRequestId,
              );
              if (
                !prior ||
                prior.status === 'prepared' ||
                prior.scope.review.principal.reviewerRef.id !== body.payload.reviewerRef.id ||
                prior.scope.planId !== body.payload.reviewerRef.version ||
                !same(prior.scope.review.target, body.payload.target)
              )
                fail('remote-not-found');
              value = this.load({ ...prior.scope, backendId: body.backendId });
            } else if ('scope' in body.payload) value = this.load(body.payload.scope);
            else fail('remote-validation');
            this.authorize(value, lease!);
            if (body.operation === 'stop')
              return this.stopValue(
                value,
                lease!,
                body.payload.scope,
                body.requestId,
                body.payload.expectedAttemptVersion,
                sessionHash,
              );
            this.binding(body, value);
            this.credentials.checkPermit(body.payload.permit, secret, value.remote.drive);
            if (body.operation === 'reconcile') {
              if (
                'lastSequence' in body.payload &&
                (body.payload.lastSequence > (value.remote.lastWireEvent?.sequence ?? 0) ||
                  (body.payload.nativeSessionId &&
                    body.payload.nativeSessionId !== value.attempt.nativeSessionId) ||
                  (body.payload.nativeAgentId &&
                    body.payload.nativeAgentId !== value.attempt.nativeAgentId) ||
                  (body.payload.resultRequestId &&
                    body.payload.resultRequestId !== value.remote.result?.requestId))
              )
                fail('remote-scope-mismatch');
              if (
                value.remote.result &&
                !value.remote.stopRequested &&
                value.attempt.stopPhase === 'none' &&
                value.attempt.status === 'running' &&
                value.attempt.resources === 'held' &&
                !readExecutionReviewFixedReceipt(value.node, value.attempt)
              ) {
                this.authorize(value, lease!, true);
                value = await this.save(value, {
                  ...value.remote,
                  memberSessionHash: sessionHash,
                  drive: {
                    ...value.remote.drive,
                    epoch: this.credentials.epoch,
                    expiresAt: Math.min(
                      lease!.expiresAt,
                      this.credentials.now() + REMOTE_RUN_LIMITS.driveTtlMs,
                    ),
                  },
                });
              }
              const view = this.view(value, sessionHash);
              return {
                ...view,
                ...this.snapshot(value),
                authority: view.authority === 'drive' ? 'recovery-required' : view.authority,
              };
            }
            if (body.operation === 'status') return this.view(value, sessionHash);
            if (body.operation === 'result-status') {
              const receipt = readExecutionReviewFixedReceipt(value.node, value.attempt),
                failure = readExecutionReviewFailure(value.node, value.attempt);
              if (
                (receipt && receipt.requestId !== body.payload.resultRequestId) ||
                (failure && failure.requestId !== body.payload.resultRequestId)
              )
                fail('remote-idempotency-mismatch');
              return {
                purpose: 'review',
                scope: body.payload.scope,
                ...(receipt
                  ? { status: 'committed', receipt }
                  : failure
                    ? { status: 'needs-attention', failure }
                    : { status: 'none' }),
              };
            }
            if (body.operation === 'submit-result') {
              this.live(value, lease!, sessionHash, true);
              if (
                !same(value.remote.result, body.payload.result) ||
                body.requestId !== body.payload.result.requestId
              )
                fail('remote-idempotency-mismatch');
              let decision;
              try {
                decision = commitExecutionReviewFixedResult(
                  value.node,
                  value.attempt.scope,
                  body.requestId,
                  body.payload.fixed,
                );
              } catch (error) {
                if (
                  error instanceof ExecutionReviewFixedResultError &&
                  (error.code === 'review-read-required' ||
                    error.code === 'review-unsupported-material')
                ) {
                  const failed = recordExecutionReviewFailure(value.node, value.attempt.scope, {
                    requestId: body.requestId,
                    code: error.code,
                    resourceRefs: [...error.resourceRefs],
                  });
                  await this.source.writeNode(failed.record);
                  this.credentials.release(value.attempt.scope.runId);
                }
                throw error;
              }
              if (decision.disposition === 'applied') {
                const next = this.source.stampBallot(
                  decision.record,
                  value.attempt.scope.review.principal.reviewerRef.id,
                );
                await this.source.writeNode(next);
                await this.source.afterCommit(next);
              } else await this.source.afterCommit(decision.record);
              this.credentials.release(value.attempt.scope.runId);
              return {
                purpose: 'review',
                scope: body.payload.scope,
                status: decision.disposition === 'applied' ? 'committed' : 'confirmed',
                receipt: decision.receipt,
              };
            }
            if (
              body.operation === 'event' &&
              value.remote.lastWireEvent?.sequence === body.payload.event.sequence
            ) {
              this.sequence(value, body.payload.event.sequence, hash(body.payload.event));
              return { ...this.view(value, sessionHash), disposition: 'replayed' };
            }
            this.live(value, lease!, sessionHash);
            if (body.operation === 'renew') {
              const fingerprint = hash(body.payload),
                prior = value.remote.controls.find((c) => c.requestId === body.requestId);
              if (prior) {
                if (prior.operation !== 'renew' || prior.fingerprint !== fingerprint)
                  fail('remote-idempotency-mismatch');
                return this.view(value, sessionHash);
              }
              if (value.remote.controls.length >= 4096) fail('remote-quota');
              const owner = this.credentials.active(value.attempt.scope.runId)!;
              const expiresAt = Math.min(
                owner.lease.expiresAt,
                this.credentials.now() + REMOTE_RUN_LIMITS.driveTtlMs,
              );
              const next = await this.save(value, {
                ...value.remote,
                drive: { ...value.remote.drive, expiresAt },
                controls: [
                  ...value.remote.controls,
                  { operation: 'renew', requestId: body.requestId, fingerprint },
                ],
              });
              this.credentials.renew(value.attempt.scope.runId, expiresAt);
              return this.view(next, sessionHash);
            }
            if (body.operation === 'input-list') {
              // Same genuine identity test as byte reads; no read evidence minted here.
              const composition = readExecutionReviewComposition(value.attempt.composition);
              return {
                purpose: 'review',
                scope: body.payload.scope,
                resources: composition.payload.targetResources,
              };
            }
            if (body.operation === 'input-read')
              return this.input(body, value, lease!, sessionHash, secret);
            const event = body.payload.event,
              fingerprint = hash(event);
            if (this.sequence(value, event.sequence, fingerprint) === 'replayed')
              return { ...this.view(value, sessionHash), disposition: 'replayed' };
            let node = value.node,
              remote = {
                ...value.remote,
                lastWireEvent: { sequence: event.sequence, fingerprint },
              };
            if (event.kind === 'sealed') {
              if (
                value.attempt.status !== 'running' ||
                !same(
                  event.result.source.context,
                  nativeReviewContextFromScope(value.attempt.scope),
                ) ||
                event.result.source.nativeSessionId !== value.attempt.nativeSessionId ||
                event.result.source.configurationId !== value.attempt.configurationId
              )
                fail('remote-scope-mismatch');
              if (this.readers.has(value.attempt.scope.runId))
                return new OutsideQueue(async () => {
                  await this.drain(value.attempt.scope.runId);
                  return execute();
                });
              remote = { ...remote, result: event.result };
            } else if (event.kind === 'stop-received' || event.kind === 'retiring') {
              node = this.domain(value, 'stop-requested');
              remote = { ...remote, stopRequested: true, lastObservation: event.kind };
            } else if (event.kind === 'failed') {
              node = this.domain(value, 'failed');
              if (event.failure) {
                // Original failure needs its request key; transport failure alone is not a fixed result.
                node = recordExecutionReviewFailure(value.node, value.attempt.scope, {
                  requestId: body.requestId,
                  code: event.failure.code,
                  resourceRefs: event.failure.resourceRefs,
                }).record;
              }
            } else
              node = this.domain(
                value,
                event.kind,
                event.kind === 'received' || event.kind === 'accepted'
                  ? { nativeSessionId: event.nativeSessionId, nativeAgentId: event.nativeAgentId }
                  : {},
              );
            const next = await this.save(value, remote, node);
            if (event.kind === 'sealed' || event.kind === 'failed' || remote.stopRequested)
              this.credentials.release(value.attempt.scope.runId);
            return { ...this.view(next, sessionHash), disposition: 'applied' };
          } catch (error) {
            throw mapped(error);
          }
        });
      let result: unknown;
      if (body.operation === 'accept') {
        const replay = await this.source.enqueue(async () => {
          try {
            if (body.backendId !== this.credentials.registry().backendId)
              fail('remote-scope-mismatch');
            this.credentials.checkDevice(body, lease!.memberId);
            proofAdmitted = true;
            const node = this.source.readNode(body.payload.target);
            if (!node) fail('remote-not-found');
            if (
              readExecutionReviewState(node)?.attempts.some(
                (a) => 'remote' in a && a.remote?.acceptRequestId === body.requestId,
              )
            )
              return true;
            if (body.payload.workflow) {
              if (!this.credentials.workflow) fail('remote-protocol-unsupported');
              preparation = this.credentials.workflow.preparing(body, lease!, sessionHash);
            }
            const prepared = this.source.prepare(lease!, {
              requestId: body.requestId,
              target: body.payload.target,
              expectedReviewVersion: body.payload.expectedReviewVersion,
              reviewerRef: body.payload.reviewerRef,
              ...(body.payload.workflow ? { workflow: body.payload.workflow } : {}),
            });
            if (prepared.prepared.disposition !== 'applied') fail('remote-conflict');
            const reviewer = prepared.applied.participants.find(
              (p) => p.id === body.payload.reviewerRef.id,
            );
            if (
              (reviewer?.resourceBindings?.skillIds.length ||
                reviewer?.resourceBindings?.mcpIds.length) &&
              body.payload.capabilities.resources !== REMOTE_RUN_RESOURCE_SOURCE_VERSION
            )
              fail('remote-protocol-unsupported');
            return false;
          } catch (error) {
            throw mapped(error);
          }
        });
        if (replay) result = await execute();
        else {
          try {
            result = await withExecutionReviewResourceQualification(
              {
                host: this.source.resourceHost,
                ownerSignal: AbortSignal.any([
                  this.source.signal,
                  lease!.signal,
                  ...(preparation ? [preparation.signal] : []),
                ]),
                originalRequest: request,
                query: {
                  requestId: body.requestId,
                  expectedReviewVersion: body.payload.expectedReviewVersion,
                  target: body.payload.target,
                  reviewerRef: body.payload.reviewerRef,
                  ...(body.payload.workflow ? { workflow: body.payload.workflow } : {}),
                },
              },
              execute,
            );
          } catch (error) {
            if (error instanceof ExecutionRunResourceQualificationCloseError) {
              cleanupConfirmed = false;
              this.qualificationFailure ??= error;
            }
            throw error;
          }
        }
        const accepted = result as RemoteReviewAcceptValue;
        if (accepted.disposition === 'accepted') {
          result = await this.source.enqueue(async () => {
            const current = this.load(accepted.scope);
            this.authorize(current, lease!, true);
            if (current.remote.workflow)
              this.credentials.workflow!.check(
                lease!,
                accepted.scope,
                current.remote.workflow,
                current.remote.deviceId,
                current.remote.keyEpoch,
              );
            if (!this.ready() || current.remote.stopRequested) fail('remote-unavailable');
            this.credentials.retain(
              current.attempt.scope.runId,
              lease!,
              sessionHash,
              current.remote.drive.expiresAt,
            );
            retained = true;
            return { ...accepted, ...this.view(current, sessionHash) };
          });
        }
      } else result = await execute();
      while (result instanceof OutsideQueue) result = await result.run();
      return remoteReviewResponseSchema(body.operation).parse({ ok: true, value: result });
    } catch (error) {
      return { ok: false, error: { code: mapped(error).code } };
    } finally {
      preparation?.finish(cleanupConfirmed);
      releaseDevice?.();
      if (lease && !retained) {
        try {
          lease.release();
        } catch {
          this.releaseFailed = true;
          this.fence();
        }
      }
    }
  }
}
