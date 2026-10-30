import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_OPERATIONS,
  REMOTE_WORKFLOW_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  REMOTE_RUN_PROTOCOL_VERSION,
  remoteDeviceSigningInput,
  remoteRunRequestSchema,
  remoteRunResponseSchema,
  remoteTeamAssetFileReadRequestSchema,
  type MemberAssetReference,
  type RemoteTeamAssetFileReadRequest,
  type RemoteAcceptRequest,
  type RemoteAcceptValue,
  type RemoteDeviceRequest,
  type RemoteRunErrorCode,
  type RemoteRunOperation,
  type RemoteRunOperationValue,
  type RemoteRunRequest,
  type RemoteRunView,
  type RemoteWorkflowView,
  type RemoteWorkflowCandidate,
  type RemoteReviewScope,
} from '@zhuma/agent-core';
import {
  MemberLocalExecutionClient,
  type MemberLocalClientOptions,
  type MemberLocalSourceOptions,
} from './member-local-execution-client.js';
import {
  MemberLocalExecutionSecrets,
  type MemberLocalAcceptSecrets,
  type MemberLocalDeviceIdentity,
} from './member-local-execution-secrets.js';
import {
  readExecutionRunComposition,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import type { NativeSessionBinding } from './native-work-session-contract.js';
import type {
  MemberLocalTeamAssetFileRead,
  MemberLocalTeamAssetFileValue,
  MemberLocalTrackedOperation,
} from './member-local-execution-team-assets.js';

type Unsigned<Request extends RemoteDeviceRequest = RemoteDeviceRequest> =
  Request extends RemoteDeviceRequest ? Omit<Request, 'proof'> : never;
type WorkflowOperation = (typeof REMOTE_WORKFLOW_OPERATIONS)[number];
export type MemberLocalWorkflowInput<Operation extends WorkflowOperation> = Extract<
  RemoteRunRequest,
  { operation: Operation }
>['payload'];
type RunRequest = Exclude<
  RemoteDeviceRequest,
  { operation: 'register-device' | 'accept' | 'reconcile' | WorkflowOperation }
>;
/** A projection of D's canonical request union, not another wire model. */
type RunCommand<Request extends RunRequest = RunRequest> = Request extends RunRequest
  ? {
      readonly operation: Request['operation'];
      readonly requestId?: string;
      readonly payload: Omit<Request['payload'], 'scope' | 'permit'>;
    }
  : never;
export type MemberLocalAcceptInput = Omit<RemoteAcceptRequest['payload'], 'credentials'>;
export interface MemberLocalProtocolOptions {
  readonly origin: string;
  /** A supplies actual compiled Host mount names, never a renderer/model URL. */
  readonly methods: Readonly<Record<RemoteRunOperation, string>>;
  readonly authentication: MemberLocalClientOptions['authentication'];
  readonly secrets: MemberLocalExecutionSecrets;
  readonly expectedActorId: string;
}
export class MemberLocalProtocolError extends Error {
  readonly outcome = 'unknown' as const;
  constructor(readonly code: RemoteRunErrorCode | 'local-closed' | 'local-mismatch') {
    super('成员本机执行尚未确认。');
  }
}
export interface MemberLocalReadHandle {
  readonly value: RemoteRunView;
}
export interface MemberLocalRunHandle extends MemberLocalReadHandle {
  readonly value: RemoteRunView & Pick<RemoteAcceptValue, 'selection' | 'shared'>;
  readonly composition: FrozenExecutionRunComposition;
}
export interface MemberLocalAcceptedRun extends MemberLocalRunHandle {
  readonly value: RemoteAcceptValue;
}
type ReconcilePayload = Extract<RemoteRunRequest, { operation: 'reconcile' }>['payload'];
export type MemberLocalRecoveryInput = Omit<
  Extract<ReconcilePayload, { target: unknown }>,
  'permit'
>;
type StopRequest = Extract<RemoteRunRequest, { operation: 'stop' }>;
export type MemberLocalStopInput = Pick<StopRequest, 'requestId'> &
  Omit<StopRequest['payload'], 'scope'>;
type PublishRequest = Extract<RemoteRunRequest, { operation: 'publish-file' }>;
type PublishInput = Omit<
  Extract<PublishRequest['payload'], { mode: 'publish' }>,
  'scope' | 'permit'
>;
export interface MemberLocalPreparedAccept {
  readonly requestId: string;
  /** Retry explicitly with this same durable intent; never rotate credentials on lost ACK. */
  send(signal?: AbortSignal): Promise<MemberLocalAcceptedRun>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Private outgoing Local Host protocol, not a backend authority or a native
 * grant. Only verified responses from this connection enter the private map. */
export class MemberLocalExecutionProtocol {
  private readonly transport: MemberLocalExecutionClient;
  private readonly accepted = new WeakMap<MemberLocalReadHandle, MemberLocalAcceptSecrets>();
  private readonly histories = new WeakSet<MemberLocalReadHandle>();
  private readonly stopped = new WeakSet<MemberLocalReadHandle>();
  private readonly teamAssetReads = new WeakMap<MemberLocalReadHandle, AbortController>();
  private readonly bindings = new WeakMap<
    MemberLocalReadHandle,
    { configurationId: string; selectionFingerprint: string }
  >();
  private readonly starts = new WeakSet<MemberLocalReadHandle>();
  private readonly lifetime = new AbortController();
  private device?: MemberLocalDeviceIdentity;
  private clock?: { readonly serverTime: number; readonly sampledAt: number };
  private operations = new Set<RemoteRunOperation>();
  private independentReviews = false;
  private workflowReady = false;
  private workflowNegotiation?: Promise<boolean>;
  private activities = 0;
  private readonly uncertainAccepts = new Set<string>();
  canSwitchBackend(): boolean {
    return (
      !this.lifetime.signal.aborted &&
      this.device !== undefined &&
      this.activities === 0 &&
      this.uncertainAccepts.size === 0 &&
      !this.transport.hasPendingWork
    );
  }
  private async activity<T>(operation: () => Promise<T>): Promise<T> {
    this.activities++;
    try {
      return await operation();
    } finally {
      this.activities--;
    }
  }

  private constructor(private readonly options: MemberLocalProtocolOptions) {
    this.transport = new MemberLocalExecutionClient({
      origin: options.origin,
      methods: REMOTE_RUN_OPERATIONS.map((operation) => options.methods[operation]),
      privateHeaderNames: [REMOTE_RUN_PERMIT_HEADER],
      authentication: options.authentication,
      timeoutMs: REMOTE_RUN_LIMITS.httpTimeoutMs,
    });
  }
  static async open(
    options: MemberLocalProtocolOptions,
    signal?: AbortSignal,
  ): Promise<MemberLocalExecutionProtocol> {
    const owner = new MemberLocalExecutionProtocol(options);
    try {
      await owner.connect(signal);
      return owner;
    } catch (error) {
      await owner.close();
      throw error;
    }
  }
  get backendId(): string {
    return this.identity().backendId;
  }
  get actorId(): string {
    return this.identity().actorId;
  }
  get deviceId(): string {
    return this.identity().deviceId;
  }
  get supportsFilePublishing(): boolean {
    this.identity();
    return ['publish-file', 'file-status', 'abandon-file'].every((operation) =>
      this.operations.has(operation as RemoteRunOperation),
    );
  }
  get supportsIndependentReviews(): boolean {
    this.identity();
    return this.independentReviews;
  }
  /** Capability only, never an arm/drive grant. Old connect() still sends {}. */
  get supportsAutomaticWorkflow(): boolean {
    this.identity();
    return this.workflowReady;
  }
  negotiateWorkflow(signal?: AbortSignal): Promise<boolean> {
    if (this.workflowReady) return Promise.resolve(true);
    if (this.workflowNegotiation) return this.workflowNegotiation;
    const work = this.activity(async () => {
      const device = this.identity();
      const info = await this.call(
        {
          protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
          operation: 'info',
          requestId: randomUUID(),
          payload: { workflow: 'zhuma-remote-workflow@1' },
        },
        undefined,
        signal,
      );
      if (info.backendId !== device.backendId || info.actorId !== device.actorId)
        throw new MemberLocalProtocolError('local-mismatch');
      this.workflowReady = REMOTE_WORKFLOW_OPERATIONS.every((operation) =>
        info.operations.includes(operation),
      );
      if (this.workflowReady)
        for (const operation of REMOTE_WORKFLOW_OPERATIONS) this.operations.add(operation);
      return this.workflowReady;
    });
    this.workflowNegotiation = work;
    void work
      .finally(() => {
        if (this.workflowNegotiation === work) delete this.workflowNegotiation;
      })
      .catch(() => undefined);
    return work;
  }
  workflowStart(
    requestId: string,
    input: MemberLocalWorkflowInput<'workflow-start'>,
    signal?: AbortSignal,
  ) {
    return this.workflowCommand('workflow-start', requestId, input, signal);
  }
  workflowStatus(input: MemberLocalWorkflowInput<'workflow-status'>, signal?: AbortSignal) {
    return this.workflowCommand('workflow-status', randomUUID(), input, signal);
  }
  rememberWorkflowAccept(
    requestId: string,
    candidate: RemoteWorkflowCandidate,
    signal?: AbortSignal,
  ) {
    return this.activity(() =>
      this.options.secrets.rememberWorkflowAccept(this.identity(), requestId, candidate, signal),
    );
  }
  pendingWorkflowAccept(input: MemberLocalWorkflowInput<'workflow-next'>, signal?: AbortSignal) {
    return this.activity(async () => {
      const entry = await this.options.secrets.pendingWorkflowAccept(
        this.identity(),
        input.target,
        input.workflow,
        signal,
      );
      if (entry) this.uncertainAccepts.add(entry.requestId);
      return entry;
    });
  }
  forgetWorkflowAccept(
    candidate: RemoteWorkflowCandidate,
    scope: RemoteRunView['scope'] | RemoteReviewScope,
    signal?: AbortSignal,
  ) {
    return this.activity(async () => {
      const entry = await this.options.secrets.pendingWorkflowAccept(
        this.identity(),
        candidate.target,
        candidate.workflow,
        signal,
      );
      await this.options.secrets.forgetWorkflowAccept(this.identity(), candidate, scope, signal);
      if (entry) this.uncertainAccepts.delete(entry.requestId);
    });
  }
  workflowNext(input: MemberLocalWorkflowInput<'workflow-next'>, signal?: AbortSignal) {
    return this.workflowCommand('workflow-next', randomUUID(), input, signal);
  }
  workflowResume(
    requestId: string,
    input: MemberLocalWorkflowInput<'workflow-resume'>,
    signal?: AbortSignal,
  ) {
    return this.workflowCommand('workflow-resume', requestId, input, signal);
  }
  workflowStop(
    requestId: string,
    input: MemberLocalWorkflowInput<'workflow-stop'>,
    signal?: AbortSignal,
  ) {
    return this.workflowCommand('workflow-stop', requestId, input, signal);
  }
  private workflowCommand<Operation extends WorkflowOperation>(
    operation: Operation,
    requestId: string,
    input: MemberLocalWorkflowInput<Operation>,
    signal?: AbortSignal,
  ): Promise<RemoteWorkflowView> {
    return this.activity(async () => {
      if (!(await this.negotiateWorkflow(signal)))
        throw new MemberLocalProtocolError('remote-protocol-unsupported');
      const parsed = remoteRunRequestSchema.parse({
        ...this.header(requestId),
        operation,
        payload: structuredClone(input),
        proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
      });
      if (
        !REMOTE_WORKFLOW_OPERATIONS.some((item) => item === parsed.operation) ||
        !('proof' in parsed)
      )
        throw new MemberLocalProtocolError('local-mismatch');
      const { proof: _proof, ...unsigned } = parsed;
      const value = await this.signed(
        unsigned as Unsigned<Extract<RemoteDeviceRequest, { operation: WorkflowOperation }>>,
        undefined,
        signal,
      );
      const scope = value.scope,
        target = input.target;
      if (
        scope.actorId !== this.actorId ||
        scope.deviceId !== this.deviceId ||
        scope.spaceId !== target.spaceId ||
        scope.taskId !== target.taskId ||
        scope.planId !== target.planId ||
        scope.revision !== target.revision
      )
        throw new MemberLocalProtocolError('local-mismatch');
      const ref = 'workflow' in input ? input.workflow : undefined;
      if (
        ref &&
        (!value.intent ||
          value.intent.intentId !== ref.intentId ||
          value.intent.generation !== ref.generation + (operation === 'workflow-resume' ? 1 : 0))
      )
        throw new MemberLocalProtocolError('local-mismatch');
      if (operation !== 'workflow-status' && !value.intent)
        throw new MemberLocalProtocolError('local-mismatch');
      return value;
    });
  }
  /** Monotonic estimate sampled from this backend; never a new authority. */
  get serverTime(): number {
    this.identity();
    return this.now();
  }
  assertReadHandle(run: MemberLocalReadHandle): void {
    this.identity();
    if (!this.accepted.has(run)) throw new MemberLocalProtocolError('local-mismatch');
  }
  private identity(): MemberLocalDeviceIdentity {
    if (this.lifetime.signal.aborted || !this.device)
      throw new MemberLocalProtocolError('local-closed');
    return this.device;
  }
  private now(): number {
    if (!this.clock) throw new MemberLocalProtocolError('local-closed');
    return Math.floor(this.clock.serverTime + performance.now() - this.clock.sampledAt);
  }
  private async connect(signal?: AbortSignal): Promise<void> {
    const info = await this.call(
      {
        protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
        operation: 'info',
        requestId: randomUUID(),
        payload: {},
      },
      undefined,
      signal,
    );
    if (
      info.actorId !== this.options.expectedActorId ||
      !info.purposes.includes('work') ||
      !(
        [
          'info',
          'register-device',
          'accept',
          'status',
          'renew',
          'event',
          'cleanup',
          'reconcile',
          'submit-result',
          'result-status',
        ] satisfies RemoteRunOperation[]
      ).every((operation) => info.operations.includes(operation))
    )
      throw new MemberLocalProtocolError('local-mismatch');
    this.clock = { serverTime: info.serverTime, sampledAt: performance.now() };
    this.operations = new Set(info.operations);
    this.independentReviews = info.purposes.includes('review');
    this.device = await this.options.secrets.device(info.backendId, info.actorId, signal);
    const registered = await this.signed(
      {
        ...this.header(),
        operation: 'register-device',
        payload: { publicKey: this.device.publicKey },
      },
      undefined,
      signal,
    );
    if (registered.actorId !== info.actorId || registered.deviceId !== this.device.deviceId)
      throw new MemberLocalProtocolError('local-mismatch');
    const pending = await this.options.secrets.pendingWorkflowAcceptForDevice(this.device, signal);
    if (pending) this.uncertainAccepts.add(pending.requestId);
  }
  private header(requestId: string = randomUUID()) {
    const device = this.identity();
    return {
      protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
      backendId: device.backendId,
      deviceId: device.deviceId,
      requestId,
    };
  }
  private signed<Request extends Unsigned>(
    request: Request,
    secret?: string,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<RemoteRunOperationValue<Request['operation']>>;
  private async signed(
    request: Unsigned,
    secret?: string,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<unknown> {
    const device = this.identity(),
      parsed = remoteRunRequestSchema.parse({
        ...request,
        proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
      });
    if (parsed.operation === 'info' || parsed.operation === 'stop')
      throw new MemberLocalProtocolError('local-mismatch');
    const signature = device.sign(
      Buffer.from(canonicalPayload(remoteDeviceSigningInput(parsed)), 'utf8'),
    );
    return this.call(
      remoteRunRequestSchema.parse({ ...parsed, proof: { ...parsed.proof, signature } }),
      secret,
      signal,
      options,
    );
  }
  private call<Request extends RemoteRunRequest>(
    request: Request,
    secret?: string,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<RemoteRunOperationValue<Request['operation']>>;
  private async call(
    request: RemoteRunRequest,
    secret?: string,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<unknown> {
    if (this.lifetime.signal.aborted) throw new MemberLocalProtocolError('local-closed');
    const parsed = remoteRunRequestSchema.parse(request),
      operation = parsed.operation;
    if (operation !== 'info' && !this.operations.has(operation))
      throw new MemberLocalProtocolError('remote-protocol-unsupported');
    const response = await this.transport.invoke(
      this.options.methods[parsed.operation],
      parsed,
      (raw) => remoteRunResponseSchema(parsed.operation).parse(raw),
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      secret === undefined ? undefined : { [REMOTE_RUN_PERMIT_HEADER]: secret },
      options,
    );
    if (!response.ok) throw new MemberLocalProtocolError(response.error.code);
    return response.value;
  }
  prepareAccept(
    requestId: string,
    input: MemberLocalAcceptInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalPreparedAccept> {
    return this.activity(() => this.prepareAcceptNow(requestId, input, signal));
  }
  private async prepareAcceptNow(
    requestId: string,
    input: MemberLocalAcceptInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalPreparedAccept> {
    const device = this.identity(),
      payload = structuredClone(input),
      fingerprint = hash({ ...this.header(requestId), actorId: device.actorId, payload });
    if (Buffer.byteLength(canonicalPayload(payload)) > REMOTE_RUN_LIMITS.requestBytes)
      throw new MemberLocalProtocolError('remote-validation');
    const secrets = await this.options.secrets.accept(device, requestId, fingerprint, signal);
    // Validate before exposing a send handle. Private tokens are already durable,
    // and only their public IDs/hashes enter this request or the accepted metadata.
    const parsed = remoteRunRequestSchema.parse({
      ...this.header(requestId),
      operation: 'accept',
      payload: { ...payload, credentials: { drive: secrets.drive, cleanup: secrets.cleanup } },
      proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
    });
    if (parsed.operation !== 'accept') throw new MemberLocalProtocolError('local-mismatch');
    const { proof: _proof, ...unsigned } = parsed;
    let qualified:
      { value: RemoteAcceptValue; composition: FrozenExecutionRunComposition } | undefined;
    return Object.freeze({
      requestId,
      send: (wait?: AbortSignal) =>
        this.activity(async () => {
          // A failed/unknown accept or durable pointer write must not look
          // quiescent merely because no local Agent/handle was exposed yet.
          this.uncertainAccepts.add(requestId);
          if (!qualified) {
            const value = await this.signed(unsigned, undefined, wait);
            qualified = {
              value: freeze(structuredClone(value)),
              composition: this.qualifyAccept(value, parsed, secrets),
            };
          }
          const { value, composition } = qualified;
          // A known accepted response whose local pointer write was interrupted
          // remains the same obligation. Retry that exact private write, never
          // automatically accept a second Run or replay the network command.
          await this.options.secrets.rememberRun(
            this.identity(),
            secrets,
            value.scope,
            value.selection.configurationId,
            hash(value.selection),
            wait,
          );
          const handle = Object.freeze({ value: freeze(structuredClone(value)), composition });
          this.accepted.set(handle, secrets);
          this.bindings.set(handle, {
            configurationId: value.selection.configurationId,
            selectionFingerprint: hash(value.selection),
          });
          this.starts.add(handle);
          this.uncertainAccepts.delete(requestId);
          return handle;
        }),
    });
  }
  private qualifyAccept(
    value: RemoteAcceptValue,
    request: RemoteAcceptRequest,
    secrets: MemberLocalAcceptSecrets,
  ): FrozenExecutionRunComposition {
    const composition = this.qualifyShared(value, request.payload.target, secrets),
      { configurationId: _configurationId, ...model } = value.selection;
    if (
      canonicalPayload(model) !== canonicalPayload(request.payload.model) ||
      composition.payload.executor.kind !== request.payload.executor.kind ||
      (composition.payload.executor.kind === 'plan-expert' &&
        (request.payload.executor.kind !== 'plan-expert' ||
          canonicalPayload(composition.payload.executor.ref) !==
            canonicalPayload(request.payload.executor.ref)))
    )
      throw new MemberLocalProtocolError('local-mismatch');
    const capabilities = request.payload.capabilities,
      extended = composition.schemaVersion === 2 ? composition.payload : undefined,
      tools = composition.payload.tools,
      localTools =
        tools.kind === 'local-tools'
          ? [...tools.definitions, ...(tools.shell ? [tools.shell] : [])]
          : [],
      acceptedInput =
        tools.kind === 'accepted-input-reader' ||
        (tools.kind === 'local-tools' && tools.acceptedInputReader !== undefined);
    if (
      extended?.resultIntentTool?.sourceVersion !== capabilities.resultIntent ||
      Boolean(extended?.acceptedFileReader) !== Boolean(capabilities.acceptedFile) ||
      Boolean(extended?.outputFilePublisherTool) !== Boolean(capabilities.outputFile) ||
      acceptedInput !== Boolean(capabilities.acceptedInput) ||
      Boolean(extended?.teamAssets) !== Boolean(capabilities.teamAssets) ||
      (extended?.resources && capabilities.resources !== extended.resources.sourceVersion) ||
      canonicalPayload(localTools) !== canonicalPayload(capabilities.localTools) ||
      (request.payload.workspace.kind === 'text-only' && tools.kind === 'local-tools')
    )
      throw new MemberLocalProtocolError('local-mismatch');
    return composition;
  }
  private qualifyShared(
    value: MemberLocalRunHandle['value'],
    target: RemoteAcceptRequest['payload']['target'],
    secrets: MemberLocalAcceptSecrets,
  ): FrozenExecutionRunComposition {
    const device = this.identity(),
      { backendId, ...scope } = value.scope,
      { configurationId, ...model } = value.selection;
    if (
      backendId !== device.backendId ||
      scope.actorId !== device.actorId ||
      value.deviceId !== device.deviceId ||
      Object.entries(target).some(([key, expected]) => Reflect.get(scope, key) !== expected) ||
      value.permit.id !== secrets.drive.id ||
      value.cleanup.id !== secrets.cleanup.id ||
      configurationId !== value.shared.configurationId
    )
      throw new MemberLocalProtocolError('local-mismatch');
    const composition = readExecutionRunComposition(value.shared.composition);
    if (
      composition.configurationId !== configurationId ||
      canonicalPayload(composition.payload.scope) !== canonicalPayload(scope) ||
      canonicalPayload(composition.payload.model) !== canonicalPayload(model) ||
      canonicalPayload(composition.payload.handoff) !== canonicalPayload(value.shared.handoff) ||
      composition.payload.context !== value.shared.context
    )
      throw new MemberLocalProtocolError('local-mismatch');
    return composition;
  }
  /** Explicit result/cleanup recovery. D's reconcile may update recovery state;
   * pure history MUST use history() instead. This never grants a fresh drive. */
  recover(input: MemberLocalRecoveryInput, signal?: AbortSignal): Promise<MemberLocalRunHandle> {
    return this.activity(() => this.recoverNow(input, signal));
  }
  private async recoverNow(
    input: MemberLocalRecoveryInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalRunHandle> {
    const recovery = structuredClone(input),
      secrets = await this.options.secrets.recoverAccept(
        this.identity(),
        recovery.acceptRequestId,
        signal,
      );
    if (!secrets) throw new MemberLocalProtocolError('remote-recovery-required');
    const value = await secrets.withDriveSecret((secret) =>
      this.signed(
        {
          ...this.header(),
          operation: 'reconcile',
          payload: { ...recovery, permit: secrets.drive },
        },
        secret,
        signal,
      ),
    );
    const composition = this.qualifyShared(value, recovery.target, secrets);
    await this.options.secrets.rememberRun(
      this.identity(),
      secrets,
      value.scope,
      value.selection.configurationId,
      hash(value.selection),
      signal,
    );
    const handle = Object.freeze({ value: freeze(structuredClone(value)), composition });
    this.accepted.set(handle, secrets);
    this.bindings.set(handle, {
      configurationId: value.selection.configurationId,
      selectionFingerprint: hash(value.selection),
    });
    this.uncertainAccepts.delete(recovery.acceptRequestId);
    return handle;
  }
  /** Fresh signed status + exact local locator. No reconcile, token generation,
   * accept, renew or business write occurs when selecting a cold conversation. */
  history(scope: RemoteRunView['scope'], signal?: AbortSignal): Promise<MemberLocalReadHandle> {
    return this.activity(() => this.historyNow(scope, signal));
  }
  private async historyNow(
    scope: RemoteRunView['scope'],
    signal?: AbortSignal,
  ): Promise<MemberLocalReadHandle> {
    const saved = await this.options.secrets.historyIntent(this.identity(), scope, signal);
    if (!saved) throw new MemberLocalProtocolError('remote-recovery-required');
    const value = await saved.intent.withDriveSecret((secret) =>
      this.signed(
        {
          ...this.header(),
          operation: 'status',
          payload: { scope, permit: saved.intent.drive },
        },
        secret,
        signal,
      ),
    );
    const handle = Object.freeze({ value: freeze(structuredClone(value)) });
    if (
      canonicalPayload(scope) !== canonicalPayload(value.scope) ||
      value.deviceId !== this.identity().deviceId ||
      value.permit.id !== saved.intent.drive.id ||
      value.cleanup.id !== saved.intent.cleanup.id
    )
      throw new MemberLocalProtocolError('local-mismatch');
    this.accepted.set(handle, saved.intent);
    this.histories.add(handle);
    this.bindings.set(handle, {
      configurationId: saved.configurationId,
      selectionFingerprint: saved.selectionFingerprint,
    });
    return handle;
  }
  /** Host-only original binding validation; a copied handle/index is no grant. */
  assertReadBinding(run: MemberLocalReadHandle, binding: NativeSessionBinding): void {
    this.identity();
    const saved = this.bindings.get(run),
      { backendId: _backendId, ...scope } = run.value.scope;
    if (
      !this.accepted.has(run) ||
      !saved ||
      canonicalPayload(scope) !== canonicalPayload(binding.scope) ||
      binding.selection.configurationId !== saved.configurationId ||
      hash(binding.selection) !== saved.selectionFingerprint ||
      (run.value.result &&
        (run.value.result.source.nativeSessionId !== binding.nativeSessionId ||
          run.value.result.source.nativeAgentId !== binding.nativeAgentId))
    )
      throw new MemberLocalProtocolError('local-mismatch');
  }
  /** Explicit original member stop, not a device drive command. Same caller key
   * and target versions are retained for retry after an unknown HTTP outcome. */
  async stop(run: MemberLocalReadHandle, input: MemberLocalStopInput, signal?: AbortSignal) {
    const device = this.identity();
    if (!this.accepted.has(run)) throw new MemberLocalProtocolError('local-mismatch');
    this.stopped.add(run);
    this.teamAssetReads.get(run)?.abort();
    const value = await this.call(
      {
        protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
        backendId: device.backendId,
        requestId: input.requestId,
        operation: 'stop',
        payload: {
          scope: run.value.scope,
          expectedNodeVersion: input.expectedNodeVersion,
          expectedRunVersion: input.expectedRunVersion,
        },
      },
      undefined,
      signal,
    );
    this.qualifyView(run, value);
    return value;
  }
  assertStartHandle(run: MemberLocalAcceptedRun): void {
    if (!this.starts.has(run)) throw new MemberLocalProtocolError('remote-recovery-required');
  }
  /** Same canonical signed command and private drive header. Only its byte
   * carrier differs; JSON never carries native file bodies. */
  publishFile(
    run: MemberLocalRunHandle,
    payload: PublishInput,
    data: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ) {
    return this.command(run, { operation: 'publish-file', payload }, signal, {
      waitForSourceSettlement: true,
      upload: data,
    });
  }
  /** Local synchronous fence only. The backend must still revalidate each
   * signed read/check. An identical DTO or a recovered/history handle cannot
   * acquire a fresh read capability. */
  assertTeamAssetFile(run: MemberLocalRunHandle, reference: MemberAssetReference): void {
    this.teamAssetFileValue(run, reference);
  }
  private teamAssetFileValue(
    run: MemberLocalRunHandle,
    reference: MemberAssetReference,
  ): MemberLocalTeamAssetFileValue {
    this.identity();
    if (!this.accepted.has(run)) throw new MemberLocalProtocolError('local-mismatch');
    if (!this.starts.has(run) || this.histories.has(run) || this.stopped.has(run))
      throw new MemberLocalProtocolError('remote-recovery-required');
    if (run.composition.schemaVersion !== 2) throw new MemberLocalProtocolError('local-mismatch');
    const payload = run.composition.payload,
      row = payload.teamAssets?.files.find(
        (file) => canonicalPayload(file.reference) === canonicalPayload(reference),
      );
    if (!payload.teamAssetTool || !row) throw new MemberLocalProtocolError('local-mismatch');
    return { scope: run.value.scope, reference: row.reference, file: row.file };
  }
  openTeamAssetFile(
    run: MemberLocalRunHandle,
    reference: MemberAssetReference,
    signal: AbortSignal,
  ): MemberLocalTrackedOperation<MemberLocalTeamAssetFileRead> {
    return this.teamAssetFile(run, reference, 'read', signal);
  }
  checkTeamAssetFile(
    run: MemberLocalRunHandle,
    reference: MemberAssetReference,
    signal: AbortSignal,
  ): MemberLocalTrackedOperation<MemberLocalTeamAssetFileValue> {
    return this.teamAssetFile(run, reference, 'check', signal);
  }
  private teamAssetFile<Mode extends 'read' | 'check'>(
    run: MemberLocalRunHandle,
    reference: MemberAssetReference,
    mode: Mode,
    signal: AbortSignal,
  ): MemberLocalTrackedOperation<
    Mode extends 'read' ? MemberLocalTeamAssetFileRead : MemberLocalTeamAssetFileValue
  > {
    const expected = this.teamAssetFileValue(run, reference),
      secrets = this.accepted.get(run)!;
    let owner = this.teamAssetReads.get(run);
    if (!owner) this.teamAssetReads.set(run, (owner = new AbortController()));
    const bounded = AbortSignal.any([signal, owner.signal, this.lifetime.signal]),
      request = remoteTeamAssetFileReadRequestSchema.parse({
        ...this.header(),
        operation: 'team-asset-file',
        payload: {
          scope: expected.scope,
          permit: secrets.drive,
          mode,
          reference: expected.reference,
        },
        proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
      });
    const signature = this.identity().sign(
        Buffer.from(canonicalPayload(remoteDeviceSigningInput(request)), 'utf8'),
      ),
      signed = remoteTeamAssetFileReadRequestSchema.parse({
        ...request,
        proof: { ...request.proof, signature },
      }) as RemoteTeamAssetFileReadRequest & { payload: { mode: Mode } },
      operation = secrets.withDriveSecret((secret) =>
        this.transport.openTeamAssetFile(signed, expected, secret, bounded),
      );
    this.activities++;
    const drain = operation.drain.then(() => {
      this.activities--;
    });
    const result = operation.result.then((response) => {
      if (!response.ok) throw new MemberLocalProtocolError(response.error.code);
      this.assertTeamAssetFile(run, expected.reference);
      bounded.throwIfAborted();
      freeze(response.value.scope);
      freeze(response.value.reference);
      freeze(response.value.file);
      Object.freeze(response.value);
      return response.value;
    });
    return Object.freeze({ result, drain });
  }
  /** The connection's own issued handle is required; matching JSON is rejected.
   * This performs a fresh server request, not a cached local ACL decision. */
  async status(run: MemberLocalReadHandle, signal?: AbortSignal) {
    const value = await this.command(run, { operation: 'status', payload: {} }, signal);
    this.qualifyView(run, value);
    return value;
  }
  private qualifyView(run: MemberLocalReadHandle, value: RemoteRunView): void {
    if (
      canonicalPayload(run.value.scope) !== canonicalPayload(value.scope) ||
      value.deviceId !== this.identity().deviceId ||
      value.permit.id !== run.value.permit.id ||
      value.cleanup.id !== run.value.cleanup.id
    )
      throw new MemberLocalProtocolError('local-mismatch');
  }
  /** Private Local Host callers only. This bridge does not turn an event body
   * into native evidence: the native owner must collect its original SDK facts. */
  command<Command extends RunCommand>(
    run: MemberLocalReadHandle,
    command: Command,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<RemoteRunOperationValue<Command['operation']>>;
  async command(
    run: MemberLocalReadHandle,
    command: RunCommand,
    signal?: AbortSignal,
    options?: MemberLocalSourceOptions,
  ): Promise<unknown> {
    return this.activity(async () => {
      const secrets = this.accepted.get(run);
      if (!secrets) throw new MemberLocalProtocolError('local-mismatch');
      if (
        this.histories.has(run) &&
        command.operation !== 'status' &&
        !(command.operation === 'cleanup' && this.stopped.has(run))
      )
        throw new MemberLocalProtocolError('remote-recovery-required');
      if (
        !this.starts.has(run) &&
        ![
          'status',
          'cleanup',
          'result-status',
          ...(run.value.authority === 'commit-only' ? ['submit-result', 'file-status'] : []),
        ].includes(command.operation)
      )
        throw new MemberLocalProtocolError('remote-recovery-required');
      const cleanup = command.operation === 'cleanup',
        request = remoteRunRequestSchema.parse({
          ...this.header(command.requestId),
          operation: command.operation,
          payload: {
            ...structuredClone(command.payload),
            scope: run.value.scope,
            permit: cleanup ? secrets.cleanup : secrets.drive,
          },
          proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
        });
      if (request.operation === 'info' || request.operation === 'stop')
        throw new MemberLocalProtocolError('local-mismatch');
      const { proof: _proof, ...unsigned } = request,
        send = (secret: string) => this.signed(unsigned, secret, signal, options),
        value = await (cleanup ? secrets.withCleanupSecret(send) : secrets.withDriveSecret(send));
      if ('scope' in value && canonicalPayload(value.scope) !== canonicalPayload(run.value.scope))
        throw new MemberLocalProtocolError('local-mismatch');
      return value;
    });
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return this.transport.close();
  }
}
