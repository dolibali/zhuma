import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_PERMIT_HEADER,
  REMOTE_RUN_PROTOCOL_VERSION,
  remoteReviewDeviceSigningInput,
  remoteReviewRequestSchema,
  remoteReviewResponseSchema,
  remoteReviewScopeSchema,
  remoteRunResponseSchema,
  remoteBackendInfoSchema,
  remoteDeviceValueSchema,
  remoteDeviceSigningInput,
  remoteRunRequestSchema,
  type RemoteDeviceRequest,
  type RemoteReviewAcceptRequest,
  type RemoteReviewAcceptValue,
  type RemoteReviewDeviceRequest,
  type RemoteReviewOperation,
  type RemoteReviewOperationValue,
  type RemoteReviewRequest,
  type RemoteReviewScope,
  type RemoteReviewView,
} from '@zhuma/agent-core';
import {
  MemberLocalExecutionClient,
  type MemberLocalSourceOptions,
} from './member-local-execution-client.js';
import {
  MemberLocalProtocolError,
  type MemberLocalProtocolOptions,
} from './member-local-execution-protocol.js';
import type {
  MemberLocalAcceptSecrets,
  MemberLocalDeviceIdentity,
} from './member-local-execution-secrets.js';
import {
  readExecutionReviewComposition,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import type { NativeSessionBinding } from './native-work-session-contract.js';

type Unsigned<R extends RemoteReviewDeviceRequest = RemoteReviewDeviceRequest> =
  R extends RemoteReviewDeviceRequest ? Omit<R, 'proof'> : never;
type Scoped = Exclude<RemoteReviewDeviceRequest, { operation: 'accept' | 'reconcile' }>;
type Command<R extends Scoped = Scoped> = R extends Scoped
  ? {
      readonly operation: R['operation'];
      readonly requestId?: string;
      readonly payload: Omit<R['payload'], 'scope' | 'permit'>;
    }
  : never;
type Reconcile = Extract<RemoteReviewRequest, { operation: 'reconcile' }>['payload'];
export type MemberLocalReviewAcceptInput = Omit<
  RemoteReviewAcceptRequest['payload'],
  'credentials'
>;
export type MemberLocalReviewRecoveryInput = Omit<
  Extract<Reconcile, { target: unknown }>,
  'permit'
>;
export type MemberLocalReviewReconcileInput = Omit<
  Extract<Reconcile, { scope: unknown }>,
  'scope' | 'permit'
>;
export type MemberLocalReviewStopInput = Pick<
  Extract<RemoteReviewRequest, { operation: 'stop' }>,
  'requestId'
> & { readonly expectedAttemptVersion: number };
export interface MemberLocalReviewReadHandle {
  readonly value: RemoteReviewView;
}
export interface MemberLocalReviewRunHandle extends MemberLocalReviewReadHandle {
  readonly value: RemoteReviewView & Pick<RemoteReviewAcceptValue, 'selection' | 'shared'>;
  readonly composition: FrozenExecutionReviewComposition;
}
export interface MemberLocalAcceptedReview extends MemberLocalReviewRunHandle {
  readonly value: RemoteReviewAcceptValue;
}
export interface MemberLocalPreparedReviewAccept {
  readonly requestId: string;
  /** Unknown HTTP outcome retries this exact durable intent, never a new Run/key. */
  send(signal?: AbortSignal): Promise<MemberLocalAcceptedReview>;
}
const operations: readonly RemoteReviewOperation[] = [
  'accept',
  'status',
  'renew',
  'event',
  'stop',
  'cleanup',
  'reconcile',
  'input-list',
  'input-read',
  'submit-result',
  'result-status',
];
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface Binding {
  readonly configurationId: string;
  readonly selectionFingerprint: string;
  readonly composition?: FrozenExecutionReviewComposition;
  nativeSessionId?: string;
}

/** Outgoing review carrier only. C's single native owner remains responsible
 * for genuine SDK reads/cuts/drain and the original fixed-result submission. */
export class MemberLocalReviewProtocol {
  private readonly transport: MemberLocalExecutionClient;
  private readonly accepted = new WeakMap<MemberLocalReviewReadHandle, MemberLocalAcceptSecrets>();
  private readonly bindings = new WeakMap<MemberLocalReviewReadHandle, Binding>();
  private readonly starts = new WeakSet<MemberLocalReviewReadHandle>();
  private readonly histories = new WeakSet<MemberLocalReviewReadHandle>();
  private readonly stopped = new WeakSet<MemberLocalReviewReadHandle>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unknownAccepts = new Set<string>();
  private device?: MemberLocalDeviceIdentity;
  private clock?: { serverTime: number; sampledAt: number };
  private closing?: Promise<void>;
  private constructor(private readonly options: MemberLocalProtocolOptions) {
    this.transport = new MemberLocalExecutionClient({
      origin: options.origin,
      methods: [...operations, 'info', 'register-device'].map(
        (op) => options.methods[op as keyof typeof options.methods],
      ),
      authentication: options.authentication,
      privateHeaderNames: [REMOTE_RUN_PERMIT_HEADER],
      timeoutMs: REMOTE_RUN_LIMITS.httpTimeoutMs,
    });
  }
  static async open(
    options: MemberLocalProtocolOptions,
    signal?: AbortSignal,
  ): Promise<MemberLocalReviewProtocol> {
    const owner = new MemberLocalReviewProtocol(options);
    try {
      await owner.activity((wait) => owner.connect(wait), signal);
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
  get serverTime(): number {
    this.identity();
    return this.now();
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
  private activity<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(new MemberLocalProtocolError('local-closed'));
    const wait = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => {
      wait.throwIfAborted();
      return work(wait);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }
  private async connect(signal: AbortSignal): Promise<void> {
    const response = await this.transport.invoke(
      this.options.methods.info,
      {
        protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
        operation: 'info',
        requestId: randomUUID(),
        payload: {},
      },
      (raw) => remoteRunResponseSchema('info').parse(raw),
      signal,
    );
    if (!response.ok) throw new MemberLocalProtocolError(response.error.code);
    const info = remoteBackendInfoSchema.parse(response.value);
    if (
      info.actorId !== this.options.expectedActorId ||
      !info.purposes.includes('review') ||
      ![...operations, 'info', 'register-device'].every((op) =>
        info.operations.includes(op as keyof typeof this.options.methods),
      )
    )
      throw new MemberLocalProtocolError('local-mismatch');
    this.clock = { serverTime: info.serverTime, sampledAt: performance.now() };
    this.device = await this.options.secrets.device(info.backendId, info.actorId, signal);
    signal.throwIfAborted();
    const body = remoteRunRequestSchema.parse({
      protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
      backendId: this.backendId,
      deviceId: this.deviceId,
      operation: 'register-device',
      requestId: randomUUID(),
      payload: { publicKey: this.identity().publicKey },
      proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
    });
    if (body.operation !== 'register-device') throw new MemberLocalProtocolError('local-mismatch');
    const signature = this.identity().sign(
      Buffer.from(canonicalPayload(remoteDeviceSigningInput(body))),
    );
    const registration = await this.transport.invoke(
      this.options.methods['register-device'],
      { ...body, proof: { ...body.proof, signature } },
      (raw) => remoteRunResponseSchema('register-device').parse(raw),
      signal,
    );
    if (!registration.ok) throw new MemberLocalProtocolError(registration.error.code);
    const registered = remoteDeviceValueSchema.parse(registration.value);
    if (registered.actorId !== this.actorId || registered.deviceId !== this.deviceId)
      throw new MemberLocalProtocolError('local-mismatch');
  }
  private header(requestId: string = randomUUID()) {
    return {
      protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
      purpose: 'review' as const,
      backendId: this.backendId,
      deviceId: this.deviceId,
      requestId,
    };
  }
  private signed<R extends Unsigned>(
    request: R,
    secret?: string,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<RemoteReviewOperationValue<R['operation']>>;
  private async signed(
    request: Unsigned,
    secret?: string,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<unknown> {
    const parsed = remoteReviewRequestSchema.parse({
      ...request,
      proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
    });
    if (parsed.operation === 'stop') throw new MemberLocalProtocolError('local-mismatch');
    const signature = this.identity().sign(
      Buffer.from(canonicalPayload(remoteReviewDeviceSigningInput(parsed))),
    );
    return this.call({ ...parsed, proof: { ...parsed.proof, signature } }, secret, signal, source);
  }
  private call<R extends RemoteReviewRequest>(
    request: R,
    secret?: string,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<RemoteReviewOperationValue<R['operation']>>;
  private async call(
    request: RemoteReviewRequest,
    secret?: string,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<unknown> {
    this.identity();
    const parsed = remoteReviewRequestSchema.parse(request);
    const reply = await this.transport.invoke(
      this.options.methods[parsed.operation],
      parsed,
      (raw) => remoteReviewResponseSchema(parsed.operation).parse(raw),
      signal,
      secret === undefined ? undefined : { [REMOTE_RUN_PERMIT_HEADER]: secret },
      parsed.operation === 'input-read' ? { waitForSourceSettlement: true } : source,
    );
    if (!reply.ok) throw new MemberLocalProtocolError(reply.error.code);
    return reply.value;
  }
  prepareAccept(
    requestId: string,
    input: MemberLocalReviewAcceptInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalPreparedReviewAccept> {
    return this.activity(async (wait) => {
      const payload = structuredClone(input),
        fingerprint = hash({ ...this.header(requestId), actorId: this.actorId, payload });
      if (Buffer.byteLength(canonicalPayload(payload)) > REMOTE_RUN_LIMITS.requestBytes)
        throw new MemberLocalProtocolError('remote-validation');
      const secrets = await this.options.secrets.accept(
        this.identity(),
        requestId,
        fingerprint,
        wait,
      );
      const parsed = remoteReviewRequestSchema.parse({
        ...this.header(requestId),
        operation: 'accept',
        payload: { ...payload, credentials: { drive: secrets.drive, cleanup: secrets.cleanup } },
        proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
      });
      if (parsed.operation !== 'accept') throw new MemberLocalProtocolError('local-mismatch');
      const { proof: _proof, ...unsigned } = parsed;
      let known:
        | { value: RemoteReviewAcceptValue; composition: FrozenExecutionReviewComposition }
        | undefined;
      return Object.freeze({
        requestId,
        send: (signal?: AbortSignal) =>
          this.activity(async (wait): Promise<MemberLocalAcceptedReview> => {
            if (!known) {
              this.unknownAccepts.add(requestId);
              const value = await this.signed(unsigned, undefined, wait);
              known = {
                value: freeze(structuredClone(value)),
                composition: this.qualifyShared(value, parsed.payload.target, secrets),
              };
              const { configurationId: _id, ...model } = value.selection;
              if (
                !same(model, parsed.payload.model) ||
                value.scope.review.principal.reviewerRef.id !== parsed.payload.reviewerRef.id ||
                value.scope.review.principal.reviewerRef.version !==
                  parsed.payload.reviewerRef.version
              ) {
                known = undefined;
                throw new MemberLocalProtocolError('local-mismatch');
              }
            }
            const { value, composition } = known;
            await this.options.secrets.rememberReviewRun(
              this.identity(),
              secrets,
              value.scope,
              value.selection.configurationId,
              hash(value.selection),
              wait,
            );
            const handle = freeze({ value: structuredClone(value), composition });
            this.remember(handle, secrets, {
              configurationId: value.selection.configurationId,
              selectionFingerprint: hash(value.selection),
              composition,
            });
            this.unknownAccepts.delete(requestId);
            if (value.authority === 'drive') this.starts.add(handle);
            return handle;
          }, signal),
      });
    }, signal);
  }
  private qualifyShared(
    value: MemberLocalReviewRunHandle['value'],
    target: RemoteReviewAcceptRequest['payload']['target'],
    secrets: MemberLocalAcceptSecrets,
  ): FrozenExecutionReviewComposition {
    const { backendId, ...scope } = value.scope,
      { configurationId, ...model } = value.selection;
    const composition = readExecutionReviewComposition(value.shared.composition);
    if (
      backendId !== this.backendId ||
      scope.actorId !== this.actorId ||
      value.deviceId !== this.deviceId ||
      !same(scope.review.target, target) ||
      value.permit.id !== secrets.drive.id ||
      value.cleanup.id !== secrets.cleanup.id ||
      configurationId !== value.shared.configurationId ||
      configurationId !== composition.configurationId ||
      !same(composition.payload.scope, scope) ||
      !same(composition.payload.model, model) ||
      !same(composition.payload.targetResources, value.shared.resources) ||
      (value.result && value.result.source.configurationId !== configurationId) ||
      (value.receipt && value.receipt.source.configurationId !== configurationId)
    )
      throw new MemberLocalProtocolError('local-mismatch');
    return composition;
  }
  private remember<T extends MemberLocalReviewReadHandle>(
    handle: T,
    intent: MemberLocalAcceptSecrets,
    binding: Binding,
  ): T {
    this.identity();
    this.accepted.set(handle, intent);
    this.bindings.set(handle, binding);
    return handle;
  }
  openScope(scope: RemoteReviewScope, signal?: AbortSignal): Promise<MemberLocalReviewReadHandle> {
    return this.activity(async (wait) => {
      const requested = remoteReviewScopeSchema.parse(scope);
      const saved = await this.options.secrets.loadReviewRun(this.identity(), requested, wait);
      if (!saved) throw new MemberLocalProtocolError('remote-recovery-required');
      const value = await saved.intent.withDriveSecret((secret) =>
        this.signed(
          {
            ...this.header(),
            operation: 'status',
            payload: { scope: requested, permit: saved.intent.drive },
          },
          secret,
          wait,
        ),
      );
      if (
        !same(requested, value.scope) ||
        value.deviceId !== this.deviceId ||
        value.permit.id !== saved.intent.drive.id ||
        value.cleanup.id !== saved.intent.cleanup.id
      )
        throw new MemberLocalProtocolError('local-mismatch');
      const handle = this.remember(freeze({ value: structuredClone(value) }), saved.intent, {
        configurationId: saved.configurationId,
        selectionFingerprint: saved.selectionFingerprint,
      });
      this.histories.add(handle);
      return handle;
    }, signal);
  }
  history(scope: RemoteReviewScope, signal?: AbortSignal) {
    return this.openScope(scope, signal);
  }
  recover(
    input: MemberLocalReviewRecoveryInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalReviewRunHandle> {
    return this.activity(async (wait) => {
      const recovery = structuredClone(input),
        intent = await this.options.secrets.recoverAccept(
          this.identity(),
          recovery.acceptRequestId,
          wait,
        );
      if (!intent) throw new MemberLocalProtocolError('remote-recovery-required');
      const value = await intent.withDriveSecret((secret) =>
        this.signed(
          {
            ...this.header(),
            operation: 'reconcile',
            payload: { ...recovery, permit: intent.drive },
          },
          secret,
          wait,
        ),
      );
      const composition = this.qualifyShared(value, recovery.target, intent);
      if (
        value.scope.review.principal.reviewerRef.id !== recovery.reviewerRef.id ||
        value.scope.review.principal.reviewerRef.version !== recovery.reviewerRef.version
      )
        throw new MemberLocalProtocolError('local-mismatch');
      await this.options.secrets.rememberReviewRun(
        this.identity(),
        intent,
        value.scope,
        value.selection.configurationId,
        hash(value.selection),
        wait,
      );
      this.unknownAccepts.delete(recovery.acceptRequestId);
      return this.remember(freeze({ value: structuredClone(value), composition }), intent, {
        configurationId: value.selection.configurationId,
        selectionFingerprint: hash(value.selection),
        composition,
      });
    }, signal);
  }
  reconcile(
    run: MemberLocalReviewReadHandle,
    input: MemberLocalReviewReconcileInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalReviewRunHandle> {
    return this.activity(async (wait) => {
      this.assertReadHandle(run);
      const intent = this.accepted.get(run)!;
      const value = await intent.withDriveSecret((secret) =>
        this.signed(
          {
            ...this.header(),
            operation: 'reconcile',
            payload: { ...structuredClone(input), scope: run.value.scope, permit: intent.drive },
          },
          secret,
          wait,
        ),
      );
      this.qualifyView(run, value);
      const composition = this.qualifyShared(value, run.value.scope.review.target, intent),
        binding = this.bindings.get(run)!;
      if (
        binding.configurationId !== value.selection.configurationId ||
        binding.selectionFingerprint !== hash(value.selection)
      )
        throw new MemberLocalProtocolError('local-mismatch');
      return this.remember(freeze({ value: structuredClone(value), composition }), intent, {
        ...binding,
        composition,
      });
    }, signal);
  }
  assertReadHandle(run: MemberLocalReviewReadHandle): void {
    this.identity();
    if (!this.accepted.has(run)) throw new MemberLocalProtocolError('local-mismatch');
  }
  assertStartHandle(run: MemberLocalAcceptedReview): void {
    this.assertReadHandle(run);
    if (!this.starts.has(run) || this.stopped.has(run) || run.value.authority !== 'drive')
      throw new MemberLocalProtocolError('remote-recovery-required');
  }
  assertReadBinding(run: MemberLocalReviewReadHandle, binding: NativeSessionBinding): void {
    this.assertReadHandle(run);
    const saved = this.bindings.get(run)!,
      { backendId: _backend, review: _review, ...scope } = run.value.scope;
    const source = run.value.result?.source ?? run.value.receipt?.source;
    if (
      !same(scope, binding.scope) ||
      saved.configurationId !== binding.selection.configurationId ||
      saved.selectionFingerprint !== hash(binding.selection) ||
      (saved.nativeSessionId && saved.nativeSessionId !== binding.nativeSessionId) ||
      binding.nativeSessionId !== binding.nativeAgentId ||
      (source &&
        (source.nativeSessionId !== binding.nativeSessionId ||
          source.nativeAgentId !== binding.nativeAgentId))
    )
      throw new MemberLocalProtocolError('local-mismatch');
  }
  private qualifyView(run: MemberLocalReviewReadHandle, value: RemoteReviewView): void {
    const intent = this.accepted.get(run);
    if (
      !intent ||
      !same(run.value.scope, value.scope) ||
      value.deviceId !== this.deviceId ||
      value.permit.id !== intent.drive.id ||
      value.cleanup.id !== intent.cleanup.id
    )
      throw new MemberLocalProtocolError('local-mismatch');
    if (value.result) this.assertSource(run, value.result.source);
    if (value.receipt) this.assertSource(run, value.receipt.source);
  }
  private assertSource(
    run: MemberLocalReviewReadHandle,
    source:
      | NonNullable<RemoteReviewView['result']>['source']
      | RemoteReviewOperationValue<'input-read'>['source'],
  ): void {
    const binding = this.bindings.get(run)!,
      { backendId: _backend, review, ...scope } = run.value.scope;
    if (
      !same(source.context.scope, scope) ||
      !same(source.context.review, review) ||
      source.configurationId !== binding.configurationId ||
      (binding.nativeSessionId && source.nativeSessionId !== binding.nativeSessionId)
    )
      throw new MemberLocalProtocolError('local-mismatch');
  }
  status(run: MemberLocalReviewReadHandle, signal?: AbortSignal) {
    return this.command(run, { operation: 'status', payload: {} }, signal);
  }
  stop(run: MemberLocalReviewReadHandle, input: MemberLocalReviewStopInput, signal?: AbortSignal) {
    return this.activity(async (wait) => {
      this.assertReadHandle(run);
      this.stopped.add(run);
      const value = await this.call(
        {
          protocolVersion: REMOTE_RUN_PROTOCOL_VERSION,
          purpose: 'review',
          backendId: this.backendId,
          operation: 'stop',
          requestId: input.requestId,
          payload: { scope: run.value.scope, expectedAttemptVersion: input.expectedAttemptVersion },
        },
        undefined,
        wait,
      );
      this.qualifyView(run, value);
      return value;
    }, signal);
  }
  command<C extends Command>(
    run: MemberLocalReviewReadHandle,
    command: C,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<RemoteReviewOperationValue<C['operation']>>;
  command(
    run: MemberLocalReviewReadHandle,
    command: Command,
    signal?: AbortSignal,
    source?: Pick<MemberLocalSourceOptions, 'waitForSourceSettlement'>,
  ): Promise<unknown> {
    return this.activity(async (wait) => {
      this.assertReadHandle(run);
      const intent = this.accepted.get(run)!,
        readOnly = command.operation === 'status' || command.operation === 'result-status';
      if (
        (this.histories.has(run) &&
          !readOnly &&
          !(command.operation === 'cleanup' && this.stopped.has(run))) ||
        (this.stopped.has(run) && !readOnly && command.operation !== 'cleanup') ||
        (!this.starts.has(run) &&
          !readOnly &&
          command.operation !== 'cleanup' &&
          !(command.operation === 'submit-result' && run.value.authority === 'commit-only'))
      )
        throw new MemberLocalProtocolError('remote-recovery-required');
      const cleanup = command.operation === 'cleanup';
      const parsed = remoteReviewRequestSchema.parse({
        ...this.header(command.requestId),
        operation: command.operation,
        payload: {
          ...structuredClone(command.payload),
          scope: run.value.scope,
          permit: cleanup ? intent.cleanup : intent.drive,
        },
        proof: { issuedAt: this.now(), nonce: randomUUID(), signature: 'A'.repeat(86) },
      });
      if (
        parsed.operation === 'stop' ||
        parsed.operation === 'accept' ||
        parsed.operation === 'reconcile'
      )
        throw new MemberLocalProtocolError('local-mismatch');
      const { proof: _proof, ...unsigned } = parsed;
      const send = (secret: string) => this.signed(unsigned, secret, wait, source);
      const value = await (cleanup ? intent.withCleanupSecret(send) : intent.withDriveSecret(send));
      if (!same(value.scope, run.value.scope)) throw new MemberLocalProtocolError('local-mismatch');
      if ('authority' in value) this.qualifyView(run, value);
      const binding = this.bindings.get(run)!;
      if (
        command.operation === 'event' &&
        (command.payload.event.kind === 'received' || command.payload.event.kind === 'accepted')
      ) {
        const id = command.payload.event.nativeSessionId;
        if (binding.nativeSessionId && binding.nativeSessionId !== id)
          throw new MemberLocalProtocolError('local-mismatch');
        binding.nativeSessionId = id;
      }
      if ('source' in value) {
        this.assertSource(run, value.source);
        const resource = binding.composition?.payload.targetResources.find(
          (r) => r.resourceRef === value.source.resourceRef,
        );
        const bytes = Buffer.from(value.base64, 'base64');
        if (
          command.operation !== 'input-read' ||
          !resource ||
          value.source.resourceRef !== command.payload.resourceRef ||
          value.source.resourceFingerprint !== resource.resourceFingerprint ||
          value.range.offset !== command.payload.offset ||
          value.range.length > command.payload.length ||
          value.range.total !== resource.bytes ||
          bytes.length !== value.range.length ||
          bytes.toString('base64') !== value.base64 ||
          createHash('sha256').update(bytes).digest('hex') !== value.sha256
        )
          throw new MemberLocalProtocolError('local-mismatch');
      }
      if ('receipt' in value && value.receipt) {
        this.assertSource(run, value.receipt.source);
        if (
          command.operation === 'submit-result' &&
          (value.receipt.requestId !== parsed.requestId ||
            value.receipt.digest !== command.payload.result.digest ||
            value.receipt.provenanceFingerprint !== command.payload.result.provenanceFingerprint ||
            !same(value.receipt.source, command.payload.result.source))
        )
          throw new MemberLocalProtocolError('local-mismatch');
        if (
          command.operation === 'result-status' &&
          value.receipt.requestId !== command.payload.resultRequestId
        )
          throw new MemberLocalProtocolError('local-mismatch');
      }
      if (
        'failure' in value &&
        value.failure &&
        command.operation === 'result-status' &&
        value.failure.requestId !== command.payload.resultRequestId
      )
        throw new MemberLocalProtocolError('local-mismatch');
      if (
        'resources' in value &&
        Array.isArray(value.resources) &&
        !same(value.resources, binding.composition?.payload.targetResources)
      )
        throw new MemberLocalProtocolError('local-mismatch');
      return value;
    }, signal);
  }
  /** Pure quiescence only; the NativeOwner also checks its real SDK/Run resources.
   * Older Clients without the original getter fail closed, never inspect private state. */
  canSwitchBackend(): boolean {
    try {
      return (
        !this.lifetime.signal.aborted &&
        this.pending.size === 0 &&
        this.unknownAccepts.size === 0 &&
        Reflect.get(this.transport, 'hasPendingWork') === false
      );
    } catch {
      return false;
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.transport.close();
      while (this.pending.size) await Promise.allSettled([...this.pending]);
    })());
  }
}
