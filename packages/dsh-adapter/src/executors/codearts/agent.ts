import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  Agent,
  AgentSideConnection,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { CodeArtsSessionEvent } from './http.js';
import { codeArtsPromptText, createCodeArtsMcpPolicy, type CodeArtsMcpPolicy } from './policy.js';
import { startCodeArtsServer, type CodeArtsServer } from './server.js';
import { deferred } from './deferred.js';
import { describeCodeArtsRoutingCapability } from './routing-metadata.js';

type Model = { readonly providerID: string; readonly modelID: string };
type Binding = {
  readonly id: string;
  readonly cwd: string;
  readonly policy: CodeArtsMcpPolicy;
  readonly server: CodeArtsServer;
  model?: Model;
};
type Part = {
  readonly messageId: string;
  readonly type: 'text' | 'reasoning';
  text: string;
  emitted: string;
};
type Turn = {
  readonly binding: Binding;
  readonly streamAbort: AbortController;
  readonly terminal: {
    readonly promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
  };
  readonly done: { readonly promise: Promise<void>; resolve(): void };
  readonly roles: Map<string, string>;
  readonly parts: Map<string, Part>;
  sent: boolean;
  busy: boolean;
  cancelled: boolean;
  outputCharacters: number;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const failure = (): RequestError =>
  new RequestError(
    -32000,
    'CodeArts operation failed; inspect the current session before continuing',
  );
const discoveryPrefix = 'zhuma-codearts-metadata-';
const route = describeCodeArtsRoutingCapability();
const configOptions = (): SessionConfigOption[] => [
  {
    id: 'model',
    name: 'CodeArts 配置来源',
    description:
      'Adapter routing capability only; provider/model and authentication are not discovered or verified.',
    category: 'model',
    type: 'select',
    currentValue: route.id,
    options: [{ value: route.id, name: route.name }],
  },
];
const sessionOptions = () => ({
  configOptions: configOptions(),
  models: {
    currentModelId: route.id,
    availableModels: [{ modelId: route.id, name: route.name }],
  },
});

/** Original CodeArts owns its transcript; the adapter keeps only live connection state. */
export class CodeArtsAcpAgent implements Agent {
  readonly #connection: Pick<AgentSideConnection, 'sessionUpdate'>;
  readonly #command: string;
  readonly #signal: AbortSignal;
  readonly #start: typeof startCodeArtsServer;
  #binding: Binding | undefined;
  #turn: Turn | undefined;
  #opening = false;
  #poisoned = false;
  /** Ephemeral ACP discovery IDs, never CodeArts SIDs or task bindings. */
  readonly #discovery = new Set<string>();

  constructor(input: {
    readonly command: string;
    readonly signal: AbortSignal;
    readonly connection: Pick<AgentSideConnection, 'sessionUpdate'>;
    readonly startServer?: typeof startCodeArtsServer;
  }) {
    this.#command = input.command;
    this.#signal = input.signal;
    this.#connection = input.connection;
    this.#start = input.startServer ?? startCodeArtsServer;
  }
  initialize(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'zhuma-codearts', version: '1' },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        sessionCapabilities: { resume: {}, close: {} },
      },
    };
  }
  authenticate(): never {
    throw RequestError.authRequired(
      undefined,
      'Use the normal CodeArts CLI login and workspace trust flow',
    );
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers.length === 0) {
      // The original ACP catalogue probe uses session/new with no tools. It
      // learns only this adapter's existing routing strategy. Nothing here
      // starts CodeArts, reads its config/auth, or creates a provider session.
      if (
        this.#poisoned ||
        this.#signal.aborted ||
        !isAbsolute(params.cwd) ||
        params.additionalDirectories?.length ||
        this.#discovery.size >= 8
      )
        throw RequestError.invalidParams();
      await realpath(params.cwd);
      if (this.#poisoned || this.#signal.aborted || this.#discovery.size >= 8)
        throw RequestError.invalidParams();
      const sessionId = `${discoveryPrefix}${randomUUID()}`;
      this.#discovery.add(sessionId);
      return {
        sessionId,
        ...sessionOptions(),
        _meta: {
          'zhuma.dev/session-kind': 'metadata-only',
          'zhuma.dev/model-source': route.kind,
          'zhuma.dev/backend-verified': route.backendVerified,
        },
      };
    }
    const binding = await this.#open(params);
    return { sessionId: binding.id, ...sessionOptions() };
  }
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    await this.#open(params, params.sessionId);
    return sessionOptions();
  }
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const binding = await this.#open(params, params.sessionId);
    const rows = await binding.server.client.messages(binding.id, binding.server.signal);
    const updates: SessionUpdate[] = [];
    for (const row of rows) {
      const message = record(row);
      const info = record(message?.info);
      if (!info || !Array.isArray(message?.parts)) throw failure();
      for (const raw of message.parts) {
        const part = record(raw);
        if (!part) throw failure();
        if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
          if (info.role !== 'user' && info.role !== 'assistant') throw failure();
          updates.push({
            sessionUpdate:
              info.role === 'user'
                ? 'user_message_chunk'
                : part.type === 'reasoning'
                  ? 'agent_thought_chunk'
                  : 'agent_message_chunk',
            content: { type: 'text', text: part.text },
          });
        } else if (part.type === 'tool') {
          const state = record(part.state);
          if (!state || typeof part.callID !== 'string' || typeof part.tool !== 'string')
            throw failure();
          updates.push({
            sessionUpdate: 'tool_call',
            toolCallId: part.callID,
            title: part.tool,
            kind: 'other',
            status:
              state.status === 'error'
                ? 'failed'
                : state.status === 'completed'
                  ? 'completed'
                  : 'pending',
            rawInput: state.input,
            ...(typeof state.output === 'string'
              ? { content: [{ type: 'content', content: { type: 'text', text: state.output } }] }
              : {}),
          });
        } else if (part.type === 'file') {
          // Never open historical paths or silently omit visible unsupported content.
          throw new RequestError(
            -32000,
            'CodeArts history contains unsupported file content; use resume to preserve its original context',
          );
        }
      }
    }
    for (const update of updates) await this.#notify(binding, update);
    return sessionOptions();
  }
  async closeSession(params: { readonly sessionId: string }): Promise<void> {
    if (this.#discovery.delete(params.sessionId)) return;
    this.#require(params.sessionId);
    await this.cancel({ sessionId: params.sessionId });
    await this.dispose();
  }
  setSessionConfigOption(params: SetSessionConfigOptionRequest): SetSessionConfigOptionResponse {
    this.#require(params.sessionId);
    if (params.configId !== 'model' || params.value !== route.id)
      throw RequestError.invalidParams();
    return { configOptions: configOptions() };
  }
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const binding = this.#require(params.sessionId);
    if (this.#turn || this.#poisoned) throw failure();
    let text: string;
    try {
      text = codeArtsPromptText(params.prompt);
    } catch {
      throw RequestError.invalidParams(
        undefined,
        'CodeArts accepts bounded text and inline text resources',
      );
    }
    const turn: Turn = {
      binding,
      streamAbort: new AbortController(),
      terminal: deferred<void>(),
      done: deferred<void>(),
      roles: new Map(),
      parts: new Map(),
      sent: false,
      busy: false,
      cancelled: false,
      outputCharacters: 0,
    };
    // Observe terminal failures immediately, even while stream readiness is pending.
    void turn.terminal.promise.catch(() => undefined);
    this.#turn = turn;
    const opened = deferred<void>();
    const streamSignal = AbortSignal.any([binding.server.signal, turn.streamAbort.signal]);
    const reading = (async () => {
      for await (const event of binding.server.client.events(binding.id, streamSignal, () =>
        opened.resolve(),
      ))
        await this.#event(turn, event);
      if (!turn.streamAbort.signal.aborted) throw failure();
    })();
    void reading.catch((error) => turn.terminal.reject(error));
    try {
      await Promise.race([
        opened.promise,
        reading.then(() => {
          throw failure();
        }),
      ]);
      if (turn.cancelled) return { stopReason: 'cancelled' };
      turn.sent = true;
      await binding.server.client.sendPrompt(
        binding.id,
        binding.policy,
        text,
        binding.server.signal,
        binding.model,
      );
      await turn.terminal.promise;
      return { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' };
    } catch {
      if (turn.cancelled && !turn.sent) return { stopReason: 'cancelled' };
      this.#poisoned = true;
      await binding.server.close();
      throw failure();
    } finally {
      turn.streamAbort.abort();
      await reading.catch(() => undefined);
      if (this.#turn === turn) this.#turn = undefined;
      turn.done.resolve();
    }
  }
  async cancel(params: CancelNotification): Promise<void> {
    const binding = this.#require(params.sessionId);
    const turn = this.#turn;
    if (!turn || turn.binding !== binding) return;
    turn.cancelled = true;
    if (!turn.sent) {
      turn.streamAbort.abort();
      return;
    }
    // An in-flight POST may not yet have entered the provider loop. Retire
    // this owned backend rather than let a late POST start after an idle ACK.
    if (!turn.busy) {
      this.#poisoned = true;
      turn.terminal.reject(failure());
      await binding.server.close();
      return;
    }
    try {
      await binding.server.client.abort(
        binding.id,
        AbortSignal.any([binding.server.signal, AbortSignal.timeout(5000)]),
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        const deadline = AbortSignal.timeout(5000);
        deadline.addEventListener('abort', () => reject(failure()), { once: true });
      });
      await Promise.race([turn.done.promise, timeout]);
    } catch {
      this.#poisoned = true;
      turn.terminal.reject(failure());
      await binding.server.close();
    }
  }
  async dispose(): Promise<void> {
    this.#poisoned = true;
    this.#discovery.clear();
    this.#turn?.terminal.reject(failure());
    await this.#binding?.server.close();
    this.#binding = undefined;
  }
  async #open(
    params:
      | Pick<NewSessionRequest, 'cwd' | 'mcpServers' | 'additionalDirectories'>
      | ResumeSessionRequest,
    id?: string,
  ): Promise<Binding> {
    if (this.#opening || this.#binding)
      throw new RequestError(
        -32000,
        'CodeArts connection is busy; use a separate connection for another session',
      );
    if (
      this.#poisoned ||
      !isAbsolute(params.cwd) ||
      params.additionalDirectories?.length ||
      id?.startsWith(discoveryPrefix)
    )
      throw RequestError.invalidParams();
    this.#opening = true;
    let server: CodeArtsServer | undefined;
    try {
      const cwd = await realpath(params.cwd);
      const policy = createCodeArtsMcpPolicy(params.mcpServers ?? []);
      server = await this.#start({
        command: this.#command,
        directory: cwd,
        policy,
        signal: this.#signal,
      });
      const session = id
        ? await server.client.resumeSession(id, server.signal)
        : await server.client.createSession({
            title: 'Zhuma task',
            permission: policy.rules,
            signal: server.signal,
          });
      const binding: Binding = { id: session.id, cwd, policy, server };
      if (id) {
        const history = await server.client.messages(id, server.signal);
        for (const row of history) this.#rememberModel(binding, record(record(row)?.info), true);
      }
      this.#binding = binding;
      return binding;
    } catch {
      this.#poisoned = true;
      await server?.close();
      throw failure();
    } finally {
      this.#opening = false;
    }
  }
  #require(id: string): Binding {
    if (
      id.startsWith(discoveryPrefix) ||
      !this.#binding ||
      this.#binding.id !== id ||
      this.#signal.aborted
    )
      throw RequestError.invalidParams();
    return this.#binding;
  }
  #rememberModel(
    binding: Binding,
    info: Record<string, unknown> | undefined,
    restoring = false,
  ): void {
    if (info?.role !== 'user') return;
    const model = record(info.model);
    if (typeof model?.providerID === 'string' && typeof model.modelID === 'string') {
      if (
        !restoring &&
        binding.model &&
        (binding.model.providerID !== model.providerID || binding.model.modelID !== model.modelID)
      )
        throw failure();
      binding.model = { providerID: model.providerID, modelID: model.modelID };
    }
  }
  async #event(turn: Turn, event: CodeArtsSessionEvent): Promise<void> {
    const props = event.properties;
    if (event.type === 'session.error') throw failure();
    if (event.type === 'permission.asked') {
      await turn.binding.server.client.rejectPermission(
        turn.binding.id,
        String(props.id),
        turn.binding.server.signal,
      );
      return;
    }
    if (event.type === 'session.status') {
      const state = record(props.status)?.type;
      if (state === 'busy' || state === 'retry') turn.busy = true;
      if (state === 'idle' && turn.sent && turn.busy) turn.terminal.resolve();
      return;
    }
    if (event.type === 'message.updated') {
      const info = record(props.info);
      if (typeof info?.id === 'string' && typeof info.role === 'string') {
        if (turn.roles.size >= 256 && !turn.roles.has(info.id)) throw failure();
        turn.roles.set(info.id, info.role);
        this.#rememberModel(turn.binding, info);
        for (const part of turn.parts.values())
          if (part.messageId === info.id) await this.#emitPart(turn, part);
      }
      return;
    }
    if (event.type === 'message.part.updated') {
      const part = record(props.part);
      if (
        typeof part?.id !== 'string' ||
        typeof part.messageID !== 'string' ||
        (part.type !== 'text' && part.type !== 'reasoning') ||
        typeof part.text !== 'string'
      )
        return;
      const previous = turn.parts.get(part.id);
      if (!previous && turn.parts.size >= 256) throw failure();
      const current: Part = {
        messageId: part.messageID,
        type: part.type,
        text: part.text,
        emitted: previous?.emitted ?? '',
      };
      turn.parts.set(part.id, current);
      await this.#emitPart(turn, current);
    } else if (event.type === 'message.part.delta') {
      if (typeof props.partID !== 'string' || typeof props.delta !== 'string') return;
      const part = turn.parts.get(props.partID);
      if (!part) throw failure();
      part.text += props.delta;
      await this.#emitPart(turn, part);
    }
  }
  async #emitPart(turn: Turn, part: Part): Promise<void> {
    if (turn.roles.get(part.messageId) !== 'assistant') return;
    if (!part.text.startsWith(part.emitted)) throw failure();
    const delta = part.text.slice(part.emitted.length);
    if (!delta) return;
    turn.outputCharacters += delta.length;
    if (turn.outputCharacters > 4 * 1024 * 1024) throw failure();
    part.emitted = part.text;
    await this.#notify(turn.binding, {
      sessionUpdate: part.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
      content: { type: 'text', text: delta },
    });
  }
  #notify(binding: Binding, update: SessionUpdate): Promise<void> {
    return this.#connection.sessionUpdate({ sessionId: binding.id, update });
  }
}
