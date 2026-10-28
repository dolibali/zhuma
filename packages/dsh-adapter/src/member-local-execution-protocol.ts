import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  REMOTE_RUN_OPERATIONS,
  REMOTE_RUN_PERMIT_HEADER,
  REMOTE_RUN_PROTOCOL_VERSION,
  remoteDeviceSigningInput,
  remoteRunRequestSchema,
  remoteRunResponseSchema,
  type RemoteAcceptRequest,
  type RemoteAcceptValue,
  type RemoteDeviceRequest,
  type RemoteRunErrorCode,
  type RemoteRunOperation,
  type RemoteRunOperationValue,
  type RemoteRunRequest,
  type RemoteRunView,
} from '@zhuma/agent-core';
import { MemberLocalExecutionClient } from './member-local-execution-client.js';
import {
  MemberLocalExecutionSecrets,
  type MemberLocalAcceptSecrets,
  type MemberLocalDeviceIdentity,
} from './member-local-execution-secrets.js';
import {
  readExecutionRunComposition,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';

type Unsigned<Request extends RemoteDeviceRequest = RemoteDeviceRequest> =
  Request extends RemoteDeviceRequest ? Omit<Request, 'proof'> : never;
type RunRequest = Exclude<
  RemoteDeviceRequest,
  { operation: 'register-device' | 'accept' | 'reconcile' }
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
  readonly authentication: (signal: AbortSignal) => HeadersInit | Promise<HeadersInit>;
  readonly secrets: MemberLocalExecutionSecrets;
  readonly expectedActorId: string;
}
export class MemberLocalProtocolError extends Error {
  readonly outcome = 'unknown' as const;
  constructor(readonly code: RemoteRunErrorCode | 'local-closed' | 'local-mismatch') {
    super('成员本机执行尚未确认。');
  }
}
export interface MemberLocalAcceptedRun {
  readonly value: RemoteAcceptValue;
  readonly composition: FrozenExecutionRunComposition;
}
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
  private readonly accepted = new WeakMap<MemberLocalAcceptedRun, MemberLocalAcceptSecrets>();
  private readonly lifetime = new AbortController();
  private device?: MemberLocalDeviceIdentity;
  private clock?: { readonly serverTime: number; readonly sampledAt: number };
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
      !REMOTE_RUN_OPERATIONS.every((operation) => info.operations.includes(operation))
    )
      throw new MemberLocalProtocolError('local-mismatch');
    this.clock = { serverTime: info.serverTime, sampledAt: performance.now() };
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
  ): Promise<RemoteRunOperationValue<Request['operation']>>;
  private async signed(request: Unsigned, secret?: string, signal?: AbortSignal): Promise<unknown> {
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
    );
  }
  private call<Request extends RemoteRunRequest>(
    request: Request,
    secret?: string,
    signal?: AbortSignal,
  ): Promise<RemoteRunOperationValue<Request['operation']>>;
  private async call(
    request: RemoteRunRequest,
    secret?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.lifetime.signal.aborted) throw new MemberLocalProtocolError('local-closed');
    const parsed = remoteRunRequestSchema.parse(request),
      response = await this.transport.invoke(
        this.options.methods[parsed.operation],
        parsed,
        (raw) => remoteRunResponseSchema(parsed.operation).parse(raw),
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
        secret === undefined ? undefined : { [REMOTE_RUN_PERMIT_HEADER]: secret },
      );
    if (!response.ok) throw new MemberLocalProtocolError(response.error.code);
    return response.value;
  }
  async prepareAccept(
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
    return Object.freeze({
      requestId,
      send: async (wait?: AbortSignal) => {
        const value = await this.signed(unsigned, undefined, wait),
          composition = this.qualifyAccept(value, parsed, secrets),
          handle = Object.freeze({ value: freeze(structuredClone(value)), composition });
        this.accepted.set(handle, secrets);
        return handle;
      },
    });
  }
  private qualifyAccept(
    value: RemoteAcceptValue,
    request: RemoteAcceptRequest,
    secrets: MemberLocalAcceptSecrets,
  ): FrozenExecutionRunComposition {
    const device = this.identity(),
      { backendId, ...scope } = value.scope,
      { configurationId, ...model } = value.selection,
      target = request.payload.target;
    if (
      backendId !== device.backendId ||
      scope.actorId !== device.actorId ||
      value.deviceId !== device.deviceId ||
      Object.entries(target).some(([key, expected]) => Reflect.get(scope, key) !== expected) ||
      value.permit.id !== secrets.drive.id ||
      value.cleanup.id !== secrets.cleanup.id ||
      configurationId !== value.shared.configurationId ||
      canonicalPayload(model) !== canonicalPayload(request.payload.model)
    )
      throw new MemberLocalProtocolError('local-mismatch');
    const composition = readExecutionRunComposition(value.shared.composition);
    if (
      composition.configurationId !== configurationId ||
      canonicalPayload(composition.payload.scope) !== canonicalPayload(scope) ||
      canonicalPayload(composition.payload.model) !== canonicalPayload(model) ||
      canonicalPayload(composition.payload.handoff) !== canonicalPayload(value.shared.handoff) ||
      composition.payload.context !== value.shared.context ||
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
      canonicalPayload(localTools) !== canonicalPayload(capabilities.localTools) ||
      (request.payload.workspace.kind === 'text-only' && tools.kind === 'local-tools')
    )
      throw new MemberLocalProtocolError('local-mismatch');
    return composition;
  }
  /** The connection's own issued handle is required; matching JSON is rejected.
   * This performs a fresh server request, not a cached local ACL decision. */
  async status(run: MemberLocalAcceptedRun, signal?: AbortSignal) {
    const value = await this.command(run, { operation: 'status', payload: {} }, signal);
    this.qualifyView(run, value);
    return value;
  }
  private qualifyView(run: MemberLocalAcceptedRun, value: RemoteRunView): void {
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
    run: MemberLocalAcceptedRun,
    command: Command,
    signal?: AbortSignal,
  ): Promise<RemoteRunOperationValue<Command['operation']>>;
  async command(
    run: MemberLocalAcceptedRun,
    command: RunCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const secrets = this.accepted.get(run);
    if (!secrets) throw new MemberLocalProtocolError('local-mismatch');
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
      send = (secret: string) => this.signed(unsigned, secret, signal),
      value = await (cleanup ? secrets.withCleanupSecret(send) : secrets.withDriveSecret(send));
    if ('scope' in value && canonicalPayload(value.scope) !== canonicalPayload(run.value.scope))
      throw new MemberLocalProtocolError('local-mismatch');
    return value;
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return this.transport.close();
  }
}
