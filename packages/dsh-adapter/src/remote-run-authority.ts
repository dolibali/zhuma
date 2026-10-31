import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import {
  canonicalPayload,
  KnowledgeProjectSnapshotSchema,
  MemberAssetFileSnapshotValueSchema,
  MemberAssetReferenceValueSchema,
  remoteTeamAssetFileReadRequestSchema,
  type MemberAssetFileSnapshot,
  type MemberAssetFileSnapshotValue,
  type MemberAssetReference,
  type MemberAssetReferenceValue,
  type RemoteTeamAssetFileReadRequest,
  type KnowledgeProjectSnapshot,
  isTerminalRunStatus,
  requestRunStop,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_RESOURCE_SOURCE_VERSION,
  remoteDeviceSigningInput,
  remoteReviewDeviceSigningInput,
  remotePermitHashInput,
  remoteRunRequestSchema,
  remoteRunResponseSchema,
  remoteRunSharedSnapshotSchema,
  remoteRunMigrationSchema,
  remoteAcceptValueSchema,
  remoteResultDigestInput,
  submitDelivery,
  submitExpertDelivery,
  submitExpertManifestDelivery,
  type ExecutionNodeRecord,
  type RemoteRunRequest,
  type RemoteReviewDeviceRequest,
  type RemoteDeviceRequest,
  type RemoteRunOperation,
  type RemoteRunResponse,
  type RemoteRunView,
  type RemoteAcceptValue,
  type RemoteRunScope,
  type RemoteRunErrorCode,
  type RemoteInputDescriptor,
  type RemoteRunMigration,
  type RemoteReconcileValue,
  REMOTE_WORKFLOW_OPERATIONS,
} from '@zhuma/agent-core';
import {
  RemoteWorkflowIntents,
  type RemoteWorkflowIntentSource,
} from './execution-workflow-intent.js';
import {
  RemoteReviewAuthorities,
  type RemoteReviewAuthoritySource,
} from './remote-review-authority.js';
import { readExecutionReviewState } from './execution-review-state.js';
import type { UpstreamContentValue } from './execution-service.js';
import { memberSessionId, type MemberRequest } from './member-session.js';
import type { RemoteTeamAssetFileReadGrant } from './remote-team-asset-file-authority.js';
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
import {
  withExecutionInitialResourceQualification,
  ExecutionRunResourceQualificationCloseError,
  type ExecutionInitialResourceVerification,
  type ExecutionRunResourceCatalogHost,
} from './execution-run-resource-qualification.js';
import type { ExecutionRunResourceCatalog } from './execution-run-resource-snapshot.js';
import {
  RemoteRunFiles,
  type RemoteRunFileGrant,
  type RemoteRunUpload,
} from './remote-run-files.js';
import {
  ArtifactUploadError,
  artifactFileReference,
  type NativeOutputFileSource,
  type UploadFileRecord,
} from './artifact-files.js';
import type { ExecutionOutputFilePort } from './execution-output-file-port.js';
import type { ExecutionAcceptedFilePort } from './execution-accepted-file-port.js';
import type {
  NativeRunFileSource,
  NativeRunFileInfo,
} from './native-work-session-files-contract.js';
import {
  nativeResultManifestRecords,
  nativeManifestResultDigest,
  nativeResultPublicationsSourceSchema,
} from './execution-native-result-delivery.js';

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
const fileOperations = ['publish-file', 'file-status', 'abandon-file'] as const;
/** A queued admission may return work which must run outside the original writer queue. */
class RemoteFileOperation {
  constructor(readonly run: () => Promise<unknown>) {}
}
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
  readonly workflow?: Pick<RemoteWorkflowIntentSource, 'facts' | 'write' | 'reviewCandidates'>;
  readonly signal: AbortSignal;
  readonly review?: RemoteReviewAuthoritySource;
  readonly resourceHost?: ExecutionRunResourceCatalogHost;
  filesEnabled?(): boolean;
  outputFiles?(issuer: RemoteRunAuthorities): ExecutionOutputFilePort<RemoteRunFileGrant>;
  readNativeFile?(idOrKey: string): UploadFileRecord | undefined;
  acceptedFiles?(issuer: RemoteRunAuthorities): ExecutionAcceptedFilePort<RemoteRunFileGrant>;
  inputFiles?(
    scope: RemoteRunFileGrant['scope'],
    composition: FrozenExecutionRunComposition,
  ): readonly (NativeRunFileSource & { readonly files: readonly NativeRunFileInfo[] })[];
  verifyOutputFiles?(
    records: readonly UploadFileRecord[],
    signal: AbortSignal,
    check: () => undefined,
  ): Promise<void>;
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
  /** Reference-only metadata, read outside the original queue after target authorization. */
  prepareProjectKnowledge?(
    request: MemberRequest,
    target: Target,
    signal: AbortSignal,
  ): Promise<KnowledgeProjectSnapshot>;
  prepareTeamAssetFiles?(
    request: MemberRequest,
    target: Target,
    signal: AbortSignal,
  ): Promise<MemberAssetFileSnapshotValue>;
  qualifyTeamAssetFile?(
    request: MemberRequest,
    reference: MemberAssetReference,
    signal: AbortSignal,
  ): Promise<MemberAssetReferenceValue>;
  compose(
    actorId: string,
    request: Accept,
    node: ExecutionNodeRecord,
    scope: Omit<RemoteRunScope, 'backendId'>,
    resources?: ExecutionRunResourceCatalog,
    projectKnowledge?: KnowledgeProjectSnapshot,
    teamAssets?: MemberAssetFileSnapshot,
  ): FrozenExecutionRunComposition;
  now?(): number;
}

/** Owns no parallel task store. Durable metadata lives only in original global/Run rows. */
export class RemoteRunAuthorities {
  private workflowIntents: RemoteWorkflowIntents | undefined;
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
  private readonly operations = new Set<Promise<unknown>>();
  private readonly teamFileGrants = new WeakMap<RemoteTeamAssetFileReadGrant, () => void>();
  private teamFileOpenings = 0;
  private preparationFailure: ExecutionRunResourceQualificationCloseError | undefined;
  private releaseFailed = false;
  private files: RemoteRunFiles | undefined;
  private readonly reviews: RemoteReviewAuthorities | undefined;
  /** Ephemeral backend IO only; no permission cache or accepted-file fact store. */
  private readonly inputReads = new Map<
    string,
    Set<{ readonly runId: string; cancel(): void; drain: Promise<void> }>
  >();
  private readonly fileGrants = new WeakMap<
    RemoteRunFileGrant,
    {
      readonly action: 'send' | 'history';
      check(): undefined;
    }
  >();
  constructor(private readonly source: RemoteRunAuthoritySource) {
    this.reviews = source.review
      ? new RemoteReviewAuthorities(source.review, {
          epoch: this.epoch,
          ...(source.workflow
            ? {
                workflow: {
                  owner: this,
                  accept: (body, lease, sessionHash) =>
                    this.workflows().assertReviewAccept(
                      body,
                      lease,
                      sessionHash,
                      this.registry().devices.find((device) => device.deviceId === body.deviceId)!
                        .keyEpoch,
                    ),
                  preparing: (body, lease, sessionHash) =>
                    this.workflows().preparingReview(
                      body,
                      lease,
                      sessionHash,
                      this.registry().devices.find((device) => device.deviceId === body.deviceId)!
                        .keyEpoch,
                    ),
                  check: (lease, scope, ref, deviceId, keyEpoch) =>
                    this.workflows().assertExisting(lease, scope, ref, deviceId, keyEpoch),
                },
              }
            : {}),
          now: () => this.now(),
          registry: () => this.registry(),
          checkDevice: (body, actorId, verifyProof) => {
            this.checkDevice(body, actorId, verifyProof);
          },
          proof: (body, key) => this.proof(body, key),
          checkPermit: (...args) => this.checkPermit(...args),
          active: (runId) => this.active.get(runId),
          retain: (runId, lease, sessionHash, expiresAt) =>
            this.retain(runId, lease, sessionHash, expiresAt),
          release: (runId) => this.release(runId),
          renew: (runId, expiresAt) => {
            const owner = this.active.get(runId);
            if (!owner) deny('remote-recovery-required');
            clearTimeout(owner.timer);
            owner.timer = setTimeout(
              () => this.release(runId),
              Math.max(0, expiresAt - this.now()),
            );
            owner.timer.unref();
          },
          takeDevice: (deviceId) => {
            const count = this.inFlight.get(deviceId) ?? 0;
            if (count >= REMOTE_RUN_LIMITS.inFlightPerDevice) deny('remote-quota');
            this.inFlight.set(deviceId, count + 1);
            return () => {
              const remaining = (this.inFlight.get(deviceId) ?? 1) - 1;
              if (remaining) this.inFlight.set(deviceId, remaining);
              else this.inFlight.delete(deviceId);
            };
          },
          heldCount: () => this.heldCount(),
        })
      : undefined;
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
      if (raw.data.remoteWorkflowWriter === 1 && !this.source.workflow)
        deny('remote-protocol-unsupported');
      if (
        (raw.data.remoteExecutionFileWriter === 1 ||
          raw.data.remoteExecutionAcceptedFileWriter === 1) &&
        !this.source.filesEnabled?.()
      )
        deny('remote-protocol-unsupported');
      if (
        this.source.filesEnabled?.() &&
        (!this.source.outputFiles || !this.source.readNativeFile || !this.source.verifyOutputFiles)
      )
        deny('remote-unavailable');
      if (raw.data.remoteExecutionReviewWriter === 1 && !this.reviews?.ready())
        deny('remote-protocol-unsupported');
      if (
        raw.data.remoteExecutionTeamAssetWriter === 1 &&
        (!this.source.prepareTeamAssetFiles || !this.source.qualifyTeamAssetFile)
      )
        deny('remote-protocol-unsupported');
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
  private filesEnabled(): boolean {
    const global = executionRunGlobalSchema.safeParse(this.source.readGlobal());
    return (
      !!this.source.filesEnabled?.() &&
      global.success &&
      !!this.source.outputFiles &&
      !!this.source.readNativeFile &&
      !!this.source.verifyOutputFiles
    );
  }
  private workflows(): RemoteWorkflowIntents {
    const source = this.source.workflow;
    if (!source) deny('remote-protocol-unsupported');
    this.workflowIntents ??= new RemoteWorkflowIntents({
      ...source,
      reviewCandidates: (lease, target, intent) =>
        this.reviews?.ready() ? (source.reviewCandidates?.(lease, target, intent) ?? []) : [],
      reviewViews: (lease, target, intent, sessionHash) =>
        source
          .facts(lease, target)
          .nodes.flatMap((node) =>
            (readExecutionReviewState(node)?.attempts ?? []).flatMap((attempt) =>
              'remote' in attempt &&
              attempt.remote?.workflow?.intentId === intent.intentId &&
              attempt.remote.deviceId === intent.deviceId &&
              attempt.scope.actorId === intent.actorId
                ? [
                    this.reviews!.workflowView(
                      this,
                      lease,
                      { ...attempt.scope, backendId: attempt.remote.backendId },
                      sessionHash,
                    ),
                  ]
                : [],
            ),
          ),
      deny,
      now: () => this.now(),
      beforeWrite: async () => {
        const global = executionRunGlobalSchema.parse(this.source.readGlobal());
        if (global.remoteWorkflowWriter !== 1)
          await this.source.writeGlobal({
            ...prepareExecutionRunWriter(global),
            remoteWorkflowWriter: 1,
          });
        if (executionRunGlobalSchema.parse(this.source.readGlobal()).remoteWorkflowWriter !== 1)
          deny('remote-unavailable');
      },
      runView: (node, run) => {
        if (!run.remote) deny('remote-scope-mismatch');
        return this.view({ node, run, state: readExecutionRunState(node)!, remote: run.remote });
      },
      stop: async (lease, target, intent, requestId) => {
        for (const node of source.facts(lease, target).nodes) {
          for (const original of readExecutionRunState(node)?.runs ?? []) {
            if (
              original.remote?.workflow?.intentId !== intent.intentId ||
              original.remote.deviceId !== intent.deviceId ||
              original.actorId !== intent.actorId ||
              original.resources === 'settled' ||
              original.remote.stopRequested ||
              original.remote.receipt
            )
              continue;
            const current = this.load({
              ...executionRunScope(node, original),
              backendId: original.remote.backendId,
            });
            await this.stop(
              {
                protocolVersion: 1,
                backendId: current.remote.backendId,
                requestId,
                operation: 'stop',
                payload: {
                  scope: {
                    ...executionRunScope(current.node, current.run),
                    backendId: current.remote.backendId,
                  },
                  expectedNodeVersion: current.node.command.version,
                  expectedRunVersion: current.state.version,
                },
              },
              lease,
            );
          }
          for (const attempt of readExecutionReviewState(node)?.attempts ?? []) {
            if (
              'remote' in attempt &&
              attempt.remote?.workflow?.intentId === intent.intentId &&
              attempt.remote.deviceId === intent.deviceId &&
              attempt.scope.actorId === intent.actorId
            )
              await this.reviews!.workflowStop(
                this,
                lease,
                { ...attempt.scope, backendId: attempt.remote.backendId },
                intent.intentId,
                requestId,
              );
          }
        }
      },
    });
    return this.workflowIntents;
  }
  ownsReview(issuer: RemoteReviewAuthorities): boolean {
    return this.reviews === issuer;
  }
  private heldCount(): number {
    return this.source
      .listNodes()
      .reduce(
        (sum, node) =>
          sum +
          (readExecutionRunState(node)?.runs.filter((r) => r.remote && r.resources === 'held')
            .length ?? 0) +
          (readExecutionReviewState(node)?.attempts.filter(
            (a) => 'remote' in a && a.remote && a.resources === 'held',
          ).length ?? 0),
        0,
      );
  }
  private release(runId: string): void {
    this.reviews?.cancelRun(runId);
    for (const entries of this.inputReads.values())
      for (const entry of entries) if (entry.runId === runId) entry.cancel();
    const value = this.active.get(runId);
    if (!value) return;
    this.active.delete(runId);
    clearTimeout(value.timer);
    try {
      value.lease.release();
    } catch {
      this.releaseFailed = true;
      this.closed = true;
    }
  }
  fence(): void {
    this.closed = true;
    this.workflowIntents?.close();
    this.files?.fence();
    this.reviews?.fence();
    for (const entries of this.inputReads.values()) for (const entry of entries) entry.cancel();
    for (const id of this.active.keys()) this.release(id);
  }
  async close(): Promise<void> {
    this.fence();
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    while (this.inputReads.size)
      await Promise.allSettled(
        [...this.inputReads.values()].flatMap((entries) =>
          [...entries].map((entry) => entry.drain),
        ),
      );
    await this.reviews?.close();
    if (this.preparationFailure) throw this.preparationFailure;
    if (this.releaseFailed) throw new RemoteRunError('remote-unavailable');
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
  handle(
    request: MemberRequest,
    raw: unknown,
    privatePermit?: string,
    upload?: RemoteRunUpload,
  ): Promise<RemoteRunResponse<unknown>> {
    const operation = Promise.resolve().then(() =>
      this.handleNow(request, raw, privatePermit, upload),
    );
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  /** Dedicated binary/check admission. Shares the original queue, device/drive,
   * active owner and inputReads; it is not part of the generic JSON transport. */
  openTeamAssetFile(
    request: MemberRequest,
    raw: unknown,
    rawPermit: unknown,
    caller: AbortSignal,
  ): Promise<RemoteTeamAssetFileReadGrant> {
    const operation = Promise.resolve()
      .then(() => this.openTeamAssetFileNow(request, raw, rawPermit, caller))
      .catch((error: unknown) => {
        if (error instanceof RemoteRunError) throw error;
        throw new RemoteRunError('remote-unavailable');
      });
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async openTeamAssetFileNow(
    request: MemberRequest,
    raw: unknown,
    rawPermit: unknown,
    caller: AbortSignal,
  ): Promise<RemoteTeamAssetFileReadGrant> {
    const parsed = remoteTeamAssetFileReadRequestSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(raw), 'utf8') > 16 * 1024)
      deny('remote-validation');
    const body = parsed.data;
    if (this.teamFileOpenings >= REMOTE_RUN_LIMITS.inFlightPerDevice) deny('remote-unavailable');
    this.teamFileOpenings++;
    let lease: ExecutionMemberLease | undefined,
      deviceId: string | undefined,
      retained = false;
    try {
      const qualify = this.source.qualifyTeamAssetFile;
      if (!qualify || !this.source.prepareTeamAssetFiles) deny('remote-protocol-unsupported');
      if (this.closed || caller.aborted || this.source.signal.aborted) deny('remote-unavailable');
      try {
        lease = await this.source.memberLease(request);
      } catch {
        deny('remote-unauthenticated');
      }
      const member = lease;
      if (member.signal.aborted || member.expiresAt <= this.now()) deny('remote-unauthenticated');
      const session = memberSessionId(request.headers.cookie);
      if (!session) deny('remote-unauthenticated');
      const sessionHash = hash(session);
      const signal = AbortSignal.any([caller, this.source.signal, member.signal]);
      let proofAdmitted = false;
      const current = () => {
        if (this.closed || signal.aborted || member.expiresAt <= this.now())
          deny('remote-permit-revoked');
        if (body.backendId !== this.registry().backendId) deny('remote-scope-mismatch');
        if (
          executionRunGlobalSchema.parse(this.source.readGlobal())
            .remoteExecutionTeamAssetWriter !== 1
        )
          deny('remote-protocol-unsupported');
        member.assertCurrent(body.payload.scope.spaceId);
        this.checkDevice(body, member.memberId, !proofAdmitted);
        proofAdmitted = true;
        const value = this.load(body.payload.scope);
        this.authorize(value, member);
        this.checkBinding(body, value);
        this.checkPermit(body.payload.permit, rawPermit, value.remote.drive);
        this.checkLive(value, member, sessionHash, true);
        if (value.run.attempt.status !== 'running' || value.run.resources !== 'held')
          deny('remote-resource-held');
        const composition = value.run.composition;
        const snapshot =
          composition?.schemaVersion === 2 ? composition.payload.teamAssets : undefined;
        const tool =
          composition?.schemaVersion === 2 ? composition.payload.teamAssetTool : undefined;
        if (
          value.remote.teamAssets !== 'zhuma-native-team-assets@1' ||
          !snapshot ||
          !tool ||
          snapshot.spaceId !== value.run.spaceId
        )
          deny('remote-protocol-unsupported');
        const row = snapshot.files.find((item) => same(item.reference, body.payload.reference));
        if (!row) deny('remote-input-stale');
        return { value, row };
      };
      const selected = await this.source.enqueue(async () => {
        const selected = current();
        const pending = this.inFlight.get(body.deviceId) ?? 0;
        if (pending >= REMOTE_RUN_LIMITS.inFlightPerDevice) deny('remote-quota');
        deviceId = body.deviceId;
        this.inFlight.set(deviceId, pending + 1);
        return selected;
      });
      // A metadata producer may itself use original service reads. Never await
      // it while holding the original execution writer queue.
      const qualified = MemberAssetReferenceValueSchema.parse(
        await qualify.call(this.source, request, body.payload.reference, signal),
      );
      if (this.source.qualifyTeamAssetFile !== qualify || signal.aborted)
        deny('remote-unavailable');
      if (
        qualified.actorId !== member.memberId ||
        !same(qualified.reference, selected.row.reference) ||
        !same(qualified.file, selected.row.file)
      )
        deny('remote-input-stale');
      return await this.source.enqueue(async () => {
        const { value, row } = current();
        if (!same(row, selected.row)) deny('remote-input-stale');
        const owner = this.active.get(value.run.attempt.id);
        if (!owner || owner.sessionHash !== sessionHash) deny('remote-recovery-required');
        const controller = new AbortController();
        const activeSignal = AbortSignal.any([signal, owner.lease.signal, controller.signal]);
        const scope = Object.freeze({ ...body.payload.scope });
        const reference = Object.freeze({ ...row.reference });
        const file = Object.freeze({ ...row.file });
        const key = hash(scope);
        let finish!: () => void,
          released = false,
          cleanup: Promise<void> | undefined;
        const drain = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const entry = { runId: scope.runId, cancel: () => controller.abort(), drain };
        const entries = this.inputReads.get(key) ?? new Set<typeof entry>();
        const grant: RemoteTeamAssetFileReadGrant = Object.freeze({
          scope,
          reference,
          file,
          request: Object.freeze({ headers: Object.freeze(structuredClone(request.headers)) }),
          signal: activeSignal,
          check: () => {
            const check = this.teamFileGrants.get(grant);
            if (!check) deny('remote-forbidden');
            check();
          },
          releaseAfter: (physical: Promise<void>) =>
            (cleanup ??= (async () => {
              controller.abort();
              try {
                await physical;
              } catch {
                this.releaseFailed = true;
                throw new RemoteRunError('remote-unavailable');
              } finally {
                released = true;
                this.teamFileGrants.delete(grant);
                entries.delete(entry);
                if (!entries.size) this.inputReads.delete(key);
                const remaining = (this.inFlight.get(body.deviceId) ?? 1) - 1;
                if (remaining) this.inFlight.set(body.deviceId, remaining);
                else this.inFlight.delete(body.deviceId);
                try {
                  member.release();
                } catch {
                  this.releaseFailed = true;
                  throw new RemoteRunError('remote-unavailable');
                } finally {
                  finish();
                }
              }
            })()),
        });
        this.teamFileGrants.set(grant, () => {
          if (released || activeSignal.aborted || this.active.get(scope.runId) !== owner)
            deny('remote-permit-revoked');
          const fresh = current();
          if (!same(fresh.row, row)) deny('remote-input-stale');
        });
        entries.add(entry);
        this.inputReads.set(key, entries);
        retained = true;
        try {
          grant.check();
        } catch (error) {
          await grant.releaseAfter(Promise.resolve());
          throw error;
        }
        return grant;
      });
    } finally {
      this.teamFileOpenings--;
      if (!retained) {
        if (deviceId) {
          const remaining = (this.inFlight.get(deviceId) ?? 1) - 1;
          if (remaining) this.inFlight.set(deviceId, remaining);
          else this.inFlight.delete(deviceId);
        }
        try {
          lease?.release();
        } catch {
          this.releaseFailed = true;
          throw new RemoteRunError('remote-unavailable');
        }
      }
    }
  }
  private async handleNow(
    request: MemberRequest,
    raw: unknown,
    privatePermit?: string,
    upload?: RemoteRunUpload,
  ): Promise<RemoteRunResponse<unknown>> {
    if (raw && typeof raw === 'object' && 'purpose' in raw && raw.purpose === 'review')
      return this.reviews
        ? this.reviews.handle(request, raw, privatePermit)
        : { ok: false, error: { code: 'remote-protocol-unsupported' } };
    const parsed = remoteRunRequestSchema.safeParse(raw);
    if (
      !parsed.success ||
      Buffer.byteLength(JSON.stringify(raw), 'utf8') > REMOTE_RUN_LIMITS.requestBytes
    )
      return { ok: false, error: { code: 'remote-validation' } };
    const body = parsed.data;
    const global = executionRunGlobalSchema.safeParse(this.source.readGlobal());
    if (
      global.success &&
      global.data.remoteExecutionTeamAssetWriter === 1 &&
      (!this.source.prepareTeamAssetFiles || !this.source.qualifyTeamAssetFile) &&
      body.operation !== 'cleanup'
    )
      return { ok: false, error: { code: 'remote-protocol-unsupported' } };
    if (
      global.success &&
      (global.data.remoteExecutionFileWriter === 1 ||
        global.data.remoteExecutionAcceptedFileWriter === 1) &&
      !this.filesEnabled() &&
      body.operation !== 'cleanup'
    )
      return { ok: false, error: { code: 'remote-protocol-unsupported' } };
    if (
      global.success &&
      global.data.remoteExecutionReviewWriter === 1 &&
      !this.reviews?.ready() &&
      body.operation !== 'cleanup'
    )
      return { ok: false, error: { code: 'remote-protocol-unsupported' } };
    const operations: readonly RemoteRunOperation[] = [
      ...supported,
      ...(this.filesEnabled() ? fileOperations : []),
      ...(this.source.workflow ? REMOTE_WORKFLOW_OPERATIONS : []),
    ];
    if (!operations.includes(body.operation))
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
        if (this.closed || this.source.signal.aborted) deny('remote-unavailable');
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
      let proofAdmitted = false;
      let verifiedOutputFiles = false;
      const execute = (
        qualification?: ExecutionInitialResourceVerification,
        projectKnowledge?: KnowledgeProjectSnapshot,
        teamAssets?: MemberAssetFileSnapshot,
      ): Promise<unknown> =>
        this.source.enqueue(async () => {
          if (body.operation !== 'cleanup' && (this.closed || this.source.signal.aborted))
            deny('remote-unavailable');
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
              purposes: this.reviews?.ready() ? ['work', 'review'] : ['work'],
              operations: body.payload.workflow
                ? operations
                : operations.filter((operation) => !operation.startsWith('workflow-')),
            };
          if (body.operation === 'register-device') return this.register(body, lease!);
          if (body.operation === 'cleanup') return this.cleanup(body, privatePermit);
          if (
            body.operation === 'workflow-start' ||
            body.operation === 'workflow-status' ||
            body.operation === 'workflow-next' ||
            body.operation === 'workflow-resume' ||
            body.operation === 'workflow-stop'
          )
            return this.workflows().command(
              body,
              lease!,
              this.checkDevice(body, lease!.memberId),
              sessionHash,
            );
          if (body.operation === 'accept') {
            return this.accept(
              body,
              lease!,
              sessionHash,
              qualification,
              projectKnowledge,
              teamAssets,
            );
          }
          if (body.operation === 'stop') return this.stop(body, lease!);
          this.checkDevice(body, lease!.memberId, !proofAdmitted);
          proofAdmitted = true;
          if (body.operation === 'reconcile')
            return this.reconcile(body, lease!, privatePermit, sessionHash);
          const target = body.payload.scope;
          const loaded = this.load(target);
          this.authorize(loaded, lease!, body.operation === 'status' ? 'status' : undefined);
          this.checkBinding(body, loaded);
          this.checkPermit(body.payload.permit, privatePermit, loaded.remote.drive);
          const mutable =
            body.operation !== 'status' &&
            body.operation !== 'result-status' &&
            body.operation !== 'file-status';
          this.checkLive(loaded, lease!, sessionHash, mutable);
          if (body.operation === 'event') {
            const event = body.payload.event;
            const isNew = this.sequence(loaded, event.sequence, hash(event)) === 'new';
            if (isNew && event.kind === 'completed') this.assertCompletion(loaded, event.result);
            if (
              isNew &&
              (event.kind === 'completed' || event.kind === 'stopped') &&
              (this.files?.hasHeld(target) || this.inputReads.has(hash(target)))
            )
              return new RemoteFileOperation(async () => {
                await this.retireInputReads(target);
                await this.files?.releaseDrained(target);
                return execute();
              });
          }
          switch (body.operation) {
            case 'status':
              return this.view(loaded, false, loaded.remote.memberSessionHash === sessionHash);
            case 'renew':
              return this.renew(body, loaded);
            case 'event':
              return this.event(body, loaded);
            case 'submit-result':
              if (
                body.payload.result.source.toolVersion === 'zhuma-native-result-intent@2' &&
                !loaded.remote.receipt &&
                !verifiedOutputFiles
              ) {
                const entries = this.outputManifest(
                  loaded,
                  body.payload.result,
                  body.payload.draft,
                );
                if (!this.source.verifyOutputFiles) deny('remote-unavailable');
                const grant = this.fileGrant(
                  body,
                  loaded,
                  lease!,
                  sessionHash,
                  privatePermit,
                  'history',
                );
                return new RemoteFileOperation(async () => {
                  await this.source.verifyOutputFiles!(
                    entries.map((entry) => entry.record),
                    grant.signal,
                    grant.check,
                  );
                  grant.check();
                  verifiedOutputFiles = true;
                  return execute();
                });
              }
              return this.submit(body, loaded);
            case 'publish-file':
            case 'file-status':
            case 'abandon-file': {
              const grant = this.fileGrant(
                body,
                loaded,
                lease!,
                sessionHash,
                privatePermit,
                body.operation === 'file-status' ? 'history' : 'send',
              );
              const files = this.fileManager();
              return new RemoteFileOperation(() => files.command(grant, body, upload));
            }
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
            case 'input-read': {
              const slot = loaded.remote.inputs.find((item) => item.slotId === body.payload.slotId);
              return slot?.kind === 'file'
                ? this.readAcceptedInput(body, loaded, lease!, sessionHash, privatePermit)
                : this.readInput(body, loaded);
            }
            default:
              return deny('remote-protocol-unsupported');
          }
        });
      let response: unknown =
        body.operation === 'accept'
          ? await this.prepareAcceptResources(request, body, lease!, execute, sessionHash)
          : await execute();
      while (response instanceof RemoteFileOperation) response = await response.run();
      // Only after actual metadata release may this request acquire drive. A
      // release failure leaves a durable reserved Run, never a usable new owner.
      const projected =
        body.operation === 'accept'
          ? await this.source.enqueue(async () => {
              if (
                this.closed ||
                this.source.signal.aborted ||
                lease!.signal.aborted ||
                lease!.expiresAt <= this.now()
              )
                deny('remote-unavailable');
              const accepted = remoteAcceptValueSchema.parse(response);
              const current = this.load(accepted.scope);
              this.authorize(current, lease!);
              if (
                accepted.disposition === 'accepted' &&
                !current.remote.stopRequested &&
                current.run.attempt.stopPhase === 'none' &&
                !isTerminalRunStatus(current.run.attempt.status)
              ) {
                this.retain(
                  accepted.scope.runId,
                  lease!,
                  sessionHash,
                  current.remote.drive.expiresAt,
                );
                retained = true;
              }
              return {
                ...accepted,
                ...this.view(current, false, current.remote.memberSessionHash === sessionHash),
              };
            })
          : response;
      const result = remoteRunResponseSchema(body.operation).safeParse({
        ok: true,
        value: projected,
      });
      if (!result.success) deny('remote-unavailable');
      return result.data;
    } catch (error) {
      const code =
        error instanceof RemoteRunError
          ? error.code
          : error instanceof ArtifactUploadError
            ? error.code === 'not-found'
              ? 'remote-not-found'
              : error.code === 'quota-exceeded'
                ? 'remote-quota'
                : error.code === 'idempotency-mismatch'
                  ? 'remote-idempotency-mismatch'
                  : error.code === 'conflict'
                    ? 'remote-conflict'
                    : error.code === 'validation' ||
                        error.code === 'invalid-request' ||
                        error.code === 'digest-mismatch'
                      ? 'remote-validation'
                      : 'remote-unavailable'
            : error instanceof ExecutionRunError
              ? error.code === 'run-active' || error.code === 'run-workspace-busy'
                ? 'remote-resource-held'
                : error.code === 'run-authority-unavailable'
                  ? 'remote-unavailable'
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
          this.releaseFailed = true;
          this.fence();
        }
      }
    }
  }
  private fileManager(): RemoteRunFiles {
    if (!this.filesEnabled() || !this.source.outputFiles || !this.source.readNativeFile)
      deny('remote-protocol-unsupported');
    return (this.files ??= new RemoteRunFiles(
      this.source.outputFiles(this),
      this.source.readNativeFile,
    ));
  }
  private fileGrant(
    body: Extract<
      RemoteRunRequest,
      {
        operation: 'publish-file' | 'file-status' | 'abandon-file' | 'submit-result' | 'input-read';
      }
    >,
    value: Loaded,
    lease: ExecutionMemberLease,
    sessionHash: string,
    rawPermit: unknown,
    action: 'history' | 'send',
  ): RemoteRunFileGrant {
    if (
      body.operation === 'input-read'
        ? value.remote.acceptedFiles !== 'zhuma-accepted-files@2'
        : value.remote.files !== 'zhuma-native-output-file@1'
    )
      deny('remote-protocol-unsupported');
    const owner = action === 'send' ? this.active.get(value.run.attempt.id)?.lease : lease;
    if (!owner) deny('remote-recovery-required');
    const remoteScope = Object.freeze({ ...body.payload.scope });
    const { backendId: _backend, ...scope } = remoteScope;
    const life = new AbortController();
    const signal = AbortSignal.any([life.signal, owner.signal, this.source.signal]);
    const grant: RemoteRunFileGrant = Object.freeze({
      remoteScope,
      scope: Object.freeze(scope),
      signal,
      check: () => this.assertFileGrant(grant, action),
      cancel: () => life.abort(),
    });
    this.fileGrants.set(grant, {
      action,
      check: () => {
        if (this.closed || signal.aborted || owner.expiresAt <= this.now())
          deny('remote-unavailable');
        const current = this.load(remoteScope);
        this.authorize(current, owner);
        this.checkBinding(body, current);
        this.checkPermit(body.payload.permit, rawPermit, current.remote.drive);
        this.checkLive(current, owner, sessionHash, action === 'send');
        if (
          action === 'send' &&
          (current.run.attempt.status !== 'running' || current.run.resources !== 'held')
        )
          deny('remote-resource-held');
        return undefined;
      },
    });
    grant.check();
    return grant;
  }
  /** Original Service factory only. Copied DTOs never enter this WeakMap. */
  assertFileGrant(grant: RemoteRunFileGrant, action: 'history' | 'send'): undefined {
    const state = this.fileGrants.get(grant);
    if (!state || (action === 'send' && state.action !== 'send')) deny('remote-forbidden');
    return state.check();
  }
  assertFilePublication(
    grant: RemoteRunFileGrant,
    source: NativeOutputFileSource,
    selectorFingerprint: string,
  ): undefined {
    this.assertFileGrant(grant, 'send');
    const value = this.load(grant.remoteScope);
    if (
      !/^[a-f0-9]{64}$/u.test(selectorFingerprint) ||
      !same(source.scope, grant.scope) ||
      source.configurationId !== value.run.selection.configurationId ||
      source.expertVersionId !== value.run.attempt.expertVersionId ||
      source.nativeSessionId !== value.run.attempt.sessionId ||
      source.nativeAgentId !== value.run.attempt.executorRunId
    )
      deny('remote-scope-mismatch');
    return undefined;
  }
  private assertCompletion(
    value: Loaded,
    result: Extract<RemoteRunRequest, { operation: 'submit-result' }>['payload']['result'],
  ): void {
    const source = result.source;
    if (
      !same(source.scope, executionRunScope(value.node, value.run)) ||
      source.configurationId !== value.run.selection.configurationId ||
      source.nativeSessionId !== value.run.attempt.sessionId ||
      source.nativeAgentId !== value.run.attempt.executorRunId
    )
      deny('remote-scope-mismatch');
    const composition = value.run.composition;
    const tool =
      composition?.schemaVersion === 2 ? composition.payload.resultIntentTool : undefined;
    if (tool?.sourceVersion !== source.toolVersion) deny('remote-protocol-unsupported');
    if (source.toolVersion === 'zhuma-native-result-intent@2') {
      if (value.remote.files !== 'zhuma-native-output-file@1') deny('remote-protocol-unsupported');
      this.outputManifest(value, result);
    }
  }
  private outputManifest(
    value: Loaded,
    result: Extract<RemoteRunRequest, { operation: 'submit-result' }>['payload']['result'],
    draft?: Extract<RemoteRunRequest, { operation: 'submit-result' }>['payload']['draft'],
  ) {
    if (!this.filesEnabled() || !this.source.readNativeFile) deny('remote-protocol-unsupported');
    const parsed = nativeResultPublicationsSourceSchema.safeParse(result.source);
    if (
      !parsed.success ||
      !result.publications ||
      parsed.data.expertVersionId !== value.run.attempt.expertVersionId
    )
      deny('remote-scope-mismatch');
    const entries = nativeResultManifestRecords(
      parsed.data,
      result.publications,
      parsed.data.manifestDigest,
      this.source.readNativeFile,
    );
    if (draft) {
      const normalized = remoteResultDigestInput(draft);
      if (
        !same(
          normalized.files,
          entries.map((entry) => artifactFileReference(entry.record)),
        ) ||
        hash(normalized) !== result.artifactDigest ||
        nativeManifestResultDigest(
          {
            links: normalized.links,
            files: normalized.files,
            ...(normalized.text === undefined ? {} : { text: normalized.text }),
          },
          parsed.data.manifestDigest,
          result.publications,
        ) !== result.digest
      )
        deny('remote-idempotency-mismatch');
    }
    return entries;
  }
  private async prepareAcceptResources<T>(
    request: MemberRequest,
    body: Accept,
    lease: ExecutionMemberLease,
    work: (
      verification?: ExecutionInitialResourceVerification,
      projectKnowledge?: KnowledgeProjectSnapshot,
      teamAssets?: MemberAssetFileSnapshot,
    ) => Promise<T>,
    sessionHash: string,
  ): Promise<T> {
    let preparation:
      { readonly signal: AbortSignal; finish(cleanupConfirmed?: boolean): void } | undefined;
    let cleanupConfirmed = true;
    try {
      const needed = await this.source.enqueue(async () => {
        if (this.closed || this.source.signal.aborted) deny('remote-unavailable');
        if (body.backendId !== this.registry().backendId) deny('remote-scope-mismatch');
        const device = this.checkDevice(body, lease.memberId);
        lease.assertCurrent(body.payload.target.spaceId);
        const node = this.source.readNode(body.payload.target);
        if (!node) deny('remote-not-found');
        this.source.assertTarget(lease.memberId, body.payload.target, node);
        if (
          node.handoff.skillRefs.length &&
          body.payload.capabilities.resources !== REMOTE_RUN_RESOURCE_SOURCE_VERSION
        )
          deny('remote-protocol-unsupported');
        const prior = readExecutionRunState(node)?.runs.some(
          (run) => run.remote?.acceptRequestId === body.requestId,
        );
        if (!prior && body.payload.workflow)
          preparation = this.workflows().preparing(body, lease, sessionHash, device.keyEpoch);
        return { fresh: !prior, resources: !prior && node.handoff.skillRefs.length > 0 };
      });
      const signal = AbortSignal.any([
        this.source.signal,
        lease.signal,
        ...(preparation ? [preparation.signal] : []),
      ]);
      const projectKnowledge =
        needed.fresh && this.source.prepareProjectKnowledge
          ? KnowledgeProjectSnapshotSchema.parse(
              await this.source.prepareProjectKnowledge(request, body.payload.target, signal),
            )
          : undefined;
      let teamAssets: MemberAssetFileSnapshot | undefined;
      if (needed.fresh && body.payload.capabilities.teamAssets) {
        if (!this.source.prepareTeamAssetFiles || !this.source.qualifyTeamAssetFile)
          deny('remote-protocol-unsupported');
        const value = MemberAssetFileSnapshotValueSchema.parse(
          await this.source.prepareTeamAssetFiles(request, body.payload.target, signal),
        );
        if (
          value.actorId !== lease.memberId ||
          value.snapshot.spaceId !== body.payload.target.spaceId
        )
          deny('remote-scope-mismatch');
        teamAssets = value.snapshot;
      }
      if (signal.aborted) deny('remote-permit-revoked');
      lease.assertCurrent(body.payload.target.spaceId);
      const qualified = (verification?: ExecutionInitialResourceVerification) =>
        work(verification, projectKnowledge, teamAssets);
      if (!needed.resources) return await qualified();
      if (this.preparationFailure) deny('remote-unavailable');
      const host = this.source.resourceHost;
      if (!host) deny('remote-unavailable');
      try {
        return await withExecutionInitialResourceQualification(
          {
            host,
            ownerSignal: AbortSignal.any([
              this.source.signal,
              lease.signal,
              ...(preparation ? [preparation.signal] : []),
            ]),
            originalRequest: request,
            locator: body.payload.target,
          },
          qualified,
        );
      } catch (error) {
        if (error instanceof ExecutionRunResourceQualificationCloseError) {
          cleanupConfirmed = false;
          this.preparationFailure ??= error;
        }
        throw error;
      }
    } finally {
      preparation?.finish(cleanupConfirmed);
    }
  }
  private proof(
    body: RemoteDeviceRequest | RemoteReviewDeviceRequest | RemoteTeamAssetFileReadRequest,
    publicKey: string,
  ): void {
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
          Buffer.from(
            canonicalPayload(
              'purpose' in body
                ? remoteReviewDeviceSigningInput(body)
                : remoteDeviceSigningInput(body),
            ),
          ),
          key,
          Buffer.from(body.proof.signature, 'base64url'),
        )
      )
        deny('remote-proof-invalid');
    } catch {
      deny('remote-proof-invalid');
    }
  }
  private checkDevice(
    body: RemoteDeviceRequest | RemoteReviewDeviceRequest | RemoteTeamAssetFileReadRequest,
    actorId: string,
    verifyProof = true,
  ) {
    const device = this.registry().devices.find((item) => item.deviceId === body.deviceId);
    if (!device || device.actorId !== actorId) deny('remote-device-mismatch');
    if (verifyProof) this.proof(body, device.publicKey);
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
    if (
      run.remote.files !== undefined &&
      executionRunGlobalSchema.parse(this.source.readGlobal()).remoteExecutionFileWriter !== 1
    )
      deny('remote-unavailable');
    if (!same({ ...executionRunScope(node, run), backendId: run.remote.backendId }, scope))
      deny('remote-scope-mismatch');
    if ((run.remote.lastWireEvent?.sequence ?? 0) !== run.attempt.lastEventSequence)
      deny('remote-unavailable');
    return { node, state, run, remote: run.remote };
  }
  private authorize(value: Loaded, lease: ExecutionMemberLease, readOnly?: 'status'): void {
    if (lease.memberId !== value.run.actorId) deny('remote-forbidden');
    lease.assertCurrent(value.run.spaceId);
    this.source.assertTarget(
      lease.memberId,
      { ...executionRunScope(value.node, value.run) },
      value.node,
    );
    // Historical conversation navigation still requires every original current
    // member/device/permit check. Only status may read a settled prior Run.
    if (
      value.state.currentRunId !== value.run.attempt.id &&
      (readOnly !== 'status' ||
        !isTerminalRunStatus(value.run.attempt.status) ||
        value.run.resources !== 'settled')
    )
      deny('remote-scope-mismatch');
  }
  private checkBinding(
    body: RemoteDeviceRequest | RemoteTeamAssetFileReadRequest,
    value: Loaded,
  ): void {
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
    if (remote.workflow)
      this.workflows().assertExisting(
        lease,
        { ...executionRunScope(value.node, value.run), backendId: remote.backendId },
        remote.workflow,
        remote.deviceId,
        remote.keyEpoch,
      );
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
  private migration(value: Loaded): RemoteRunMigration | undefined {
    const { node, run, state, remote } = value;
    const index = state.runs.findIndex((item) => item.attempt.id === run.attempt.id);
    if (
      state.currentRunId !== run.attempt.id ||
      index < 1 ||
      run.attempt.status !== 'requested' ||
      run.resources !== 'held' ||
      run.dispatch !== 'reserved' ||
      run.attempt.acknowledged ||
      run.attempt.sessionId !== undefined ||
      run.attempt.executorRunId !== undefined ||
      run.attempt.stopPhase !== 'none'
    )
      return undefined;
    const predecessors = state.runs.slice(0, index);
    // Original local migrations retain their original authority. Never mix
    // device/actor/backend histories into a remote member's local session.
    if (
      predecessors.some(
        (previous) =>
          !previous.remote ||
          previous.remote.backendId !== remote.backendId ||
          previous.remote.deviceId !== remote.deviceId ||
          previous.remote.keyEpoch !== remote.keyEpoch ||
          previous.remote.publicKey !== remote.publicKey ||
          previous.actorId !== run.actorId ||
          previous.spaceId !== run.spaceId ||
          !isTerminalRunStatus(previous.attempt.status) ||
          previous.resources !== 'settled',
      )
    )
      return undefined;
    const receipt = state.receipts.find(
      (item) =>
        item.requestId === run.attempt.idempotencyKey &&
        item.actorId === run.actorId &&
        item.runId === run.attempt.id,
    );
    if (!receipt) deny('remote-unavailable');
    const parsed = remoteRunMigrationSchema.safeParse({
      requestId: receipt.requestId,
      inputFingerprint: run.attempt.payloadHash,
      predecessors: predecessors.map((previous) => ({
        scope: { ...executionRunScope(node, previous), backendId: previous.remote!.backendId },
        selection: previous.selection,
        deviceId: previous.remote!.deviceId,
        keyEpoch: previous.remote!.keyEpoch,
        runStatus: previous.attempt.status,
        resources: previous.resources,
        dispatch: previous.dispatch,
        acknowledged: previous.attempt.acknowledged,
        ...(previous.attempt.sessionId === undefined
          ? {}
          : { nativeSessionId: previous.attempt.sessionId }),
        ...(previous.attempt.executorRunId === undefined
          ? {}
          : { nativeAgentId: previous.attempt.executorRunId }),
        ...(previous.attempt.sessionDiscarded === undefined
          ? {}
          : { sessionDiscarded: previous.attempt.sessionDiscarded }),
      })),
    });
    if (!parsed.success) deny('remote-quota');
    return parsed.data;
  }
  private view(value: Loaded, cleanupOnly = false, sessionCurrent = true): RemoteRunView {
    const { node, state, run, remote } = value;
    const current = state.currentRunId === run.attempt.id;
    const original = current ? this.active.get(run.attempt.id) : undefined;
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
      current &&
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
    const migration = cleanupOnly ? undefined : this.migration(value);
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
      ...(migration ? { migration } : {}),
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
  private reconcileValue(value: Loaded, sessionCurrent = true): RemoteReconcileValue {
    const view = this.view(value, false, sessionCurrent);
    return {
      ...view,
      ...this.savedSnapshot(value),
      authority: view.authority === 'drive' ? 'recovery-required' : view.authority,
    };
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
  private inputCatalog(
    scope: RemoteRunScope,
    node: ExecutionNodeRecord,
    composition?: FrozenExecutionRunComposition,
    acceptedFiles = false,
  ) {
    const inputs = node.handoff.inputRefs.map(
      (ref) => this.inputSnapshot(scope, node, ref.sourceNodeId, ref.artifactVersionId).descriptor,
    );
    if (acceptedFiles) {
      if (
        !this.filesEnabled() ||
        !composition ||
        !this.source.inputFiles ||
        !this.source.acceptedFiles
      )
        deny('remote-protocol-unsupported');
      const { backendId: _backend, ...nativeScope } = scope;
      let sources: ReturnType<NonNullable<RemoteRunAuthoritySource['inputFiles']>>;
      try {
        sources = this.source.inputFiles(nativeScope, composition);
      } catch (error) {
        if (error instanceof ArtifactUploadError && error.code === 'not-found')
          deny('remote-input-stale');
        throw error;
      }
      for (const source of sources)
        for (const file of source.files)
          inputs.push({
            slotId: `input_${hash({ scope, inputRef: source.inputRef, fileId: file.fileId })}`,
            kind: 'file',
            name: file.name,
            sourceNodeId: source.sourceNodeId,
            artifactVersionId: source.artifactVersionId,
            resourceRef: { id: source.inputRef, version: source.artifactVersionId },
            fileId: file.fileId,
            byteSize: file.bytes,
            sha256: file.sha256,
          });
    }
    if (inputs.length > REMOTE_RUN_LIMITS.inputs) deny('remote-quota');
    return inputs;
  }
  private cancelInputReads(scope: RemoteRunScope): void {
    for (const entry of this.inputReads.get(hash(scope)) ?? []) entry.cancel();
  }
  private async retireInputReads(scope: RemoteRunScope): Promise<void> {
    const entries = this.inputReads.get(hash(scope));
    if (!entries) return;
    for (const entry of entries) entry.cancel();
    await Promise.all([...entries].map((entry) => entry.drain));
  }
  private readAcceptedInput(
    body: Extract<RemoteRunRequest, { operation: 'input-read' }>,
    value: Loaded,
    lease: ExecutionMemberLease,
    sessionHash: string,
    rawPermit: unknown,
  ): RemoteFileOperation {
    this.requireInputDrive(value);
    this.assertInputCatalog(value);
    const slot = value.remote.inputs.find((item) => item.slotId === body.payload.slotId);
    if (
      !slot ||
      slot.kind !== 'file' ||
      !slot.resourceRef ||
      !slot.fileId ||
      !this.source.acceptedFiles
    )
      deny('remote-input-stale');
    if (body.payload.offset > slot.byteSize) deny('remote-validation');
    const inputRef = slot.resourceRef.id;
    const port = this.source.acceptedFiles(this);
    const grant = this.fileGrant(body, value, lease, sessionHash, rawPermit, 'send');
    const key = hash(body.payload.scope);
    let resolveDrain!: () => void;
    const entry = {
      runId: body.payload.scope.runId,
      cancel: grant.cancel,
      drain: new Promise<void>((resolve) => {
        resolveDrain = resolve;
      }),
    };
    const entries = this.inputReads.get(key) ?? new Set<typeof entry>();
    entries.add(entry);
    this.inputReads.set(key, entries);
    return new RemoteFileOperation(async () => {
      let page: Awaited<ReturnType<typeof port.read>> | undefined;
      const timer = setTimeout(grant.cancel, 5000);
      timer.unref();
      try {
        grant.check();
        page = await port.read(
          grant,
          {
            inputRef,
            fileId: slot.fileId,
            offset: body.payload.offset,
            length: Math.min(body.payload.maximumBytes, 16_384),
          },
          grant.signal,
        );
        page.check();
        grant.check();
        this.assertInputCatalog(this.load(body.payload.scope));
        if (
          !same(page.source.scope, grant.scope) ||
          page.source.inputRef !== inputRef ||
          page.source.sourceNodeId !== slot.sourceNodeId ||
          page.source.artifactVersionId !== slot.artifactVersionId ||
          page.source.file.fileId !== slot.fileId ||
          page.source.file.sha256 !== slot.sha256 ||
          page.range.total !== slot.byteSize ||
          page.range.offset !== body.payload.offset ||
          page.bytes.byteLength !== page.range.length ||
          page.range.length > body.payload.maximumBytes
        )
          deny('remote-input-stale');
        // The original reader classifies the entire verified object, not this
        // page. Binary/invalid UTF-8 may be catalogued but cannot become model text.
        if (page.encoding !== 'utf-8') deny('remote-protocol-unsupported');
        const response = {
          scope: body.payload.scope,
          slotId: slot.slotId,
          offset: page.range.offset,
          byteSize: page.bytes.byteLength,
          totalBytes: page.range.total,
          sha256: slot.sha256,
          base64: Buffer.from(page.bytes).toString('base64'),
          eof: page.range.offset + page.bytes.byteLength === page.range.total,
        };
        // A copied page is not evidence that the SDK stream has physically drained.
        page.release();
        await page.drain;
        grant.check();
        this.assertInputCatalog(this.load(body.payload.scope));
        return response;
      } finally {
        clearTimeout(timer);
        page?.release();
        if (page) await page.drain;
        grant.cancel();
        entries.delete(entry);
        if (!entries.size) this.inputReads.delete(key);
        resolveDrain();
      }
    });
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
    if (
      !same(
        this.inputCatalog(
          scope,
          value.node,
          value.run.composition,
          value.remote.acceptedFiles !== undefined,
        ),
        value.remote.inputs,
      )
    )
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
    qualification?: ExecutionInitialResourceVerification,
    projectKnowledge?: KnowledgeProjectSnapshot,
    teamAssets?: MemberAssetFileSnapshot,
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
    const workflow = payload.workflow
      ? this.workflows().assertAccept(body, lease, sessionHash, device.keyEpoch)
      : undefined;
    if (
      this.active.size >= REMOTE_RUN_LIMITS.activeAuthorities ||
      this.heldCount() >= REMOTE_RUN_LIMITS.activeAuthorities
    )
      deny('remote-quota');
    const files = payload.capabilities.resultIntent === 'zhuma-native-result-intent@2';
    if (
      (files
        ? !this.filesEnabled() ||
          !this.source.outputFiles ||
          !this.source.readNativeFile ||
          !this.source.verifyOutputFiles ||
          payload.capabilities.outputFile !== 'zhuma-native-output-file@1' ||
          payload.workspace.kind !== 'local'
        : payload.capabilities.outputFile ||
          payload.capabilities.localTools.length ||
          payload.workspace.kind !== 'text-only') ||
      (payload.capabilities.acceptedFile &&
        (!this.filesEnabled() ||
          !this.source.acceptedFiles ||
          !this.source.inputFiles ||
          !node.handoff.inputRefs.length)) ||
      new Set(payload.capabilities.localTools.map((tool) => tool.name)).size !==
        payload.capabilities.localTools.length ||
      node.handoff.mcpRefs.length
    )
      deny('remote-protocol-unsupported');
    if (node.handoff.skillRefs.length && !qualification) deny('remote-unavailable');
    if (qualification?.actorId !== undefined && qualification.actorId !== lease.memberId)
      deny('remote-forbidden');
    qualification?.assertCurrent();
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
    const composition = this.source.compose(
      lease.memberId,
      body,
      node,
      scope,
      qualification?.catalog,
      projectKnowledge,
      teamAssets,
    );
    qualification?.assertCurrent();
    const inputs = this.inputCatalog(
      { ...scope, backendId: body.backendId },
      node,
      composition,
      payload.capabilities.acceptedFile !== undefined,
    );
    if (payload.capabilities.acceptedFile) this.source.acceptedFiles!(this);
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
        workspace:
          payload.workspace.kind === 'local'
            ? { ...payload.workspace, deviceId: body.deviceId }
            : payload.workspace,
        composition,
      },
      this.source.listNodes(),
      { expertEnabled: true, executorConnected: true, writerState: this.source.readGlobal() },
    );
    const remote: RemoteRunBinding = {
      protocolVersion: 1,
      ...(workflow ? { workflow } : {}),
      ...(files ? { files: 'zhuma-native-output-file@1' as const } : {}),
      ...(payload.capabilities.acceptedFile
        ? { acceptedFiles: payload.capabilities.acceptedFile }
        : {}),
      ...(payload.capabilities.knowledge ? { knowledge: payload.capabilities.knowledge } : {}),
      ...(payload.capabilities.teamAssets ? { teamAssets: payload.capabilities.teamAssets } : {}),
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
    this.migration({ node: next, run, state: readExecutionRunState(next)!, remote });
    lease.assertCurrent(payload.target.spaceId);
    this.source.assertTarget(lease.memberId, payload.target, this.source.readNode(payload.target)!);
    qualification?.assertCurrent();
    if (
      files ||
      payload.capabilities.acceptedFile ||
      payload.capabilities.knowledge ||
      payload.capabilities.teamAssets
    ) {
      // Qualify the actual original attachment port BEFORE changing the format.
      if (files) this.fileManager();
      const global = executionRunGlobalSchema.parse(this.source.readGlobal());
      if (
        (files && global.remoteExecutionFileWriter !== 1) ||
        (payload.capabilities.acceptedFile && global.remoteExecutionAcceptedFileWriter !== 1) ||
        (payload.capabilities.knowledge && global.remoteExecutionKnowledgeWriter !== 1) ||
        (payload.capabilities.teamAssets && global.remoteExecutionTeamAssetWriter !== 1)
      ) {
        // Original storage has no cross-row transaction. This durable barrier
        // precedes the first node put in the SAME writer queue. A failed node
        // put deliberately retains marker-only state; it grants no drive.
        await this.source.writeGlobal({
          ...prepareExecutionRunWriter(global),
          ...(files ? { remoteExecutionFileWriter: 1 as const } : {}),
          ...(payload.capabilities.acceptedFile
            ? { remoteExecutionAcceptedFileWriter: 1 as const }
            : {}),
          ...(payload.capabilities.knowledge ? { remoteExecutionKnowledgeWriter: 1 as const } : {}),
          ...(payload.capabilities.teamAssets
            ? { remoteExecutionTeamAssetWriter: 1 as const }
            : {}),
        });
      }
      const marked = executionRunGlobalSchema.parse(this.source.readGlobal());
      if (
        (files && marked.remoteExecutionFileWriter !== 1) ||
        (payload.capabilities.acceptedFile && marked.remoteExecutionAcceptedFileWriter !== 1) ||
        (payload.capabilities.knowledge && marked.remoteExecutionKnowledgeWriter !== 1) ||
        (payload.capabilities.teamAssets && marked.remoteExecutionTeamAssetWriter !== 1)
      )
        deny('remote-unavailable');
      lease.assertCurrent(payload.target.spaceId);
      this.source.assertTarget(
        lease.memberId,
        payload.target,
        this.source.readNode(payload.target)!,
      );
      if (!same(this.source.readNode(payload.target), node)) deny('remote-conflict');
      qualification?.assertCurrent();
    }
    if (payload.workflow) this.workflows().assertAccept(body, lease, sessionHash, device.keyEpoch);
    await this.source.writeNode(next);
    qualification?.assertCurrent();
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
      this.assertCompletion(value, event.result);
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
    this.cancelInputReads(body.payload.scope);
    this.release(run.attempt.id);
    return { ...this.view(next), disposition: 'applied' };
  }
  private async cleanup(
    body: Extract<RemoteRunRequest, { operation: 'cleanup' }>,
    rawPermit: unknown,
    proofAdmitted = false,
  ): Promise<unknown> {
    const value = this.load(body.payload.scope);
    if (body.deviceId !== value.remote.deviceId) deny('remote-device-mismatch');
    if (!proofAdmitted) this.proof(body, value.remote.publicKey);
    this.checkPermit(body.payload.permit, rawPermit, value.remote.cleanup);
    if (value.remote.cleanup.expiresAt <= this.now()) deny('remote-permit-expired');
    const observation = body.payload.observation;
    const fingerprint = hash({ cleanup: observation });
    if (this.sequence(value, observation.sequence, fingerprint) === 'replayed')
      return { ...this.view(value, true), disposition: 'replayed' };
    let node = value.node,
      run = value.run;
    if (observation.kind === 'drained') {
      const unadmitted =
        run.dispatch === 'reserved' &&
        !run.attempt.sessionId &&
        !run.attempt.executorRunId &&
        !run.attempt.acknowledged;
      if (observation.evidence.basis === 'absent-unadmitted') {
        if (!unadmitted) deny('remote-conflict');
      } else if (
        !unadmitted &&
        (observation.evidence.nativeSessionId !== run.attempt.sessionId ||
          (run.attempt.executorRunId &&
            observation.evidence.nativeAgentId !== run.attempt.executorRunId))
      )
        deny('remote-scope-mismatch');
      // A real local SDK scope can close before its first received ACK. Its
      // signed close report only retires that reserved scope; never adopt IDs,
      // fabricate an accepted event or grant drive from this evidence.
      if (this.files?.hasHeld(body.payload.scope) || this.inputReads.has(hash(body.payload.scope)))
        return new RemoteFileOperation(async () => {
          await this.retireInputReads(body.payload.scope);
          await this.files?.releaseDrained(body.payload.scope);
          return this.source.enqueue(() => this.cleanup(body, rawPermit, true));
        });
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
    const files = result.source.toolVersion === 'zhuma-native-result-intent@2';
    if (files) this.outputManifest(value, result, draft);
    else if (draft.files.length) deny('remote-protocol-unsupported');
    const content = {
      links: draft.links,
      ...(draft.text === undefined ? {} : { text: draft.text }),
    };
    if (
      hash(draft) !== result.artifactDigest ||
      (!files && nativeResultDigest(content) !== result.digest)
    )
      deny('remote-idempotency-mismatch');
    if (value.remote.receipt) {
      await this.source.afterDelivery(value.node);
      return { scope: body.payload.scope, disposition: 'replayed', receipt: value.remote.receipt };
    }
    const common = {
      record: value.node,
      idempotencyKey: `remote-result:${result.requestId}`,
      expectedVersion: body.payload.expectedNodeVersion,
      draft: { ...content, files: draft.files },
      artifactId: randomUUID(),
      roundId: randomUUID(),
    };
    const decision =
      value.node.handoff.assignee.kind === 'human'
        ? submitDelivery({ ...common, actorId: value.run.actorId })
        : files
          ? submitExpertManifestDelivery({
              ...common,
              expertId: value.node.handoff.assignee.id,
              producerRunId: value.run.attempt.id,
              provenanceFingerprint: hash({
                result,
                scope: body.payload.scope,
                deviceId: value.remote.deviceId,
              }),
            })
          : submitExpertDelivery({
              ...common,
              draft: { ...content, files: [] as const },
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
