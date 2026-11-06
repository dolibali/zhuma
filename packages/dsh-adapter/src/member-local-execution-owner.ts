import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import {
  canonicalPayload,
  REMOTE_RUN_LIMITS,
  remoteResultDeclarationSchema,
  remoteResultDigestInput,
  type RemoteRunEvent,
  type RemoteRunView,
  type RemoteResultReceipt,
  type RemoteResultDeclaration,
  type RemoteResultDraft,
} from '@zhuma/agent-core';
import {
  MemberLocalExecutionProtocol,
  MemberLocalProtocolError,
  type MemberLocalAcceptedRun,
  type MemberLocalRunHandle,
  type MemberLocalReadHandle,
  type MemberLocalStopInput,
} from './member-local-execution-protocol.js';
import { openNativeWorkSessions } from './native-work-session-storage.js';
import {
  NativeWorkError,
  type NativeWorkAction,
  type NativeWorkGrant,
  type NativeWorkScope,
  type NativeSessionBinding,
  type NativeSessionSelection,
} from './native-work-session-contract.js';
import type { NativeDshOptions } from './native-work-session-dsh.js';
import {
  createNativeFixedResultIssuer,
  createNativeFixedResultPublicationsIssuer,
  type NativeFixedResultIssuer,
  type NativeFixedResultPublicationsIssuer,
} from './native-work-session-result.js';
import type { NativeFixedResultRef } from './native-work-session-result-contract.js';
import type { NativeFixedResultLease } from './native-work-session-result-contract.js';
import type { NativeFixedResultPublicationsLease } from './native-work-session-result-publications-contract.js';
import {
  createNativeOutputFileIssuer,
  type NativeOutputFileIssuer,
} from './native-work-session-output-file.js';
import type { NativeOutputFileByteProducer } from './native-work-session-output-file-source.js';
import { NATIVE_OUTPUT_FILE_VERSION } from './native-work-session-output-file-tool.js';
import { createMemberLocalOutputFiles } from './member-local-execution-files.js';
import {
  executionRunCompositionRequest,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import {
  registerExecutionRunResources,
  EXECUTION_RESOURCE_SOURCE_VERSION,
  type ExecutionRunResourceAdoption,
  type ExecutionMcpConnectionLease,
  type FrozenMcpResource,
} from './execution-run-resources.js';
import { observeHostNativeRun } from './host-run-observation.js';
import { registerMemberLocalAcceptedInputs } from './member-local-execution-inputs.js';
import { registerMemberLocalAcceptedFiles } from './member-local-execution-accepted-files.js';
import { NATIVE_ACCEPTED_FILE_TOOL_VERSION } from './native-work-session-files-tool.js';
import { MemberLocalExecutionHistory } from './member-local-execution-history.js';
import { RemoteRunMigrationAuthorities } from './remote-run-migration-authority.js';
import { MemberLocalExecutionReview } from './member-local-execution-review.js';
import {
  describeMemberKnowledgeTool,
  registerMemberKnowledgeTool,
  type MemberKnowledgeToolPorts,
} from './member-knowledge-tool.js';
import {
  describeTeamAssetFileTool,
  registerTeamAssetFileTool,
  type TeamAssetFileToolPorts,
} from './team-asset-file-tool.js';
import type {
  MemberLocalReviewProtocol,
  MemberLocalAcceptedReview,
  MemberLocalReviewReadHandle,
  MemberLocalReviewStopInput,
} from './member-local-review-protocol.js';
import type { ExecutionService } from './execution-service.js';

export interface MemberLocalOwnerOptions {
  readonly protocol: MemberLocalExecutionProtocol;
  readonly review?: { readonly protocol: MemberLocalReviewProtocol };
  /** A freezes the selected library and default-off draft consent privately
   * for this exact accepted Run. Factory construction/registration must do no IO. */
  readonly knowledge?: {
    create(binding: NativeSessionBinding, grant: NativeWorkGrant): MemberKnowledgeToolPorts;
  };
  /** Pure construction for this original issued Run. Actual check/read IO is
   * admitted only when the original Agent invokes the registered tool. */
  readonly teamAssets?: {
    create(
      binding: NativeSessionBinding,
      grant: NativeWorkGrant,
      run: MemberLocalRunHandle,
    ): TeamAssetFileToolPorts;
  };
  /** Normal local model owner; this does not copy provider credentials. */
  assertModel(selection: NativeSessionSelection, signal: AbortSignal): void | Promise<void>;
  /** Actual original local tool/workspace adapters, when those tools were selected. */
  readonly native?: NativeDshOptions;
  /** Original Host-qualified FS/workspace/publication capability. Absence keeps
   * file publication and v2 completion unavailable, including after recovery. */
  readonly outputFiles?: {
    resolveBytes(
      binding: NativeSessionBinding,
      grant: NativeWorkGrant,
    ): NativeOutputFileByteProducer;
  };
  /** Original private MCP configuration owner, required for selected MCP entries. */
  openMcp?(resource: FrozenMcpResource, signal: AbortSignal): Promise<ExecutionMcpConnectionLease>;
}
type Phase =
  'dispatching' | 'working' | 'fixed' | 'submitted' | 'retiring' | 'retired' | 'recovery-required';
type Observation = ReturnType<typeof observeHostNativeRun>;
type NativeOwner = Awaited<ReturnType<typeof openNativeWorkSessions>>;
interface Owned {
  readonly run: MemberLocalReadHandle;
  readonly workRun?: MemberLocalRunHandle;
  readonly role: 'drive' | 'result-only' | 'cleanup-only';
  readonly scope: NativeWorkScope;
  readonly abort: AbortController;
  readonly grant: NativeWorkGrant;
  view: RemoteRunView;
  deadline: number;
  cleanupDeadline: number;
  phase: Phase;
  sequence: number;
  queue: Promise<unknown>;
  dispatch?: Promise<void>;
  collecting?: Promise<void>;
  retirement?: Promise<void>;
  observation?: Observation;
  resources?: ExecutionRunResourceAdoption;
  received: boolean;
  accepted: boolean;
  firstMessageId?: string;
  timer?: ReturnType<typeof setTimeout>;
  receipt?: RemoteResultReceipt;
  binding?: NativeSessionBinding;
}
export interface MemberLocalOwnerView {
  readonly phase: Phase;
  readonly remote: RemoteRunView;
  readonly native: ReturnType<NativeOwner['service']['open']> | undefined;
  readonly receipt?: RemoteResultReceipt;
}
const address = (scope: NativeWorkScope) => canonicalPayload(scope);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

/** One thin owner over the ORIGINAL local SDK/factory, native table and result
 * issuer. No backend ExecutionService, second transcript or Agent loop lives here. */
export class MemberLocalExecutionOwner {
  private readonly states = new Map<string, Owned>();
  private readonly handles = new WeakMap<MemberLocalReadHandle, Owned>();
  private readonly grants = new WeakMap<NativeWorkGrant, Owned>();
  private readonly starts = new WeakMap<NativeWorkGrant, MemberLocalAcceptedRun>();
  private readonly lifetime = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private native!: NativeOwner;
  private results!: NativeFixedResultIssuer;
  private publicationResults?: NativeFixedResultPublicationsIssuer;
  private publications?: NativeOutputFileIssuer;
  private historyReader!: MemberLocalExecutionHistory;
  private migrations!: RemoteRunMigrationAuthorities;
  private reviews?: MemberLocalExecutionReview;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private constructor(private readonly options: MemberLocalOwnerOptions) {}
  /** Pure observation only. A must first fence new admissions in its own
   * transition epoch, then actually close/drain/dispose before replacing us. */
  canSwitchBackend(): boolean {
    return (
      !!this.native &&
      !!this.historyReader &&
      !this.lifetime.signal.aborted &&
      !this.closing &&
      this.jobs.size === 0 &&
      this.options.protocol.canSwitchBackend() &&
      (!this.reviews || this.reviews.canSwitchBackend()) &&
      this.historyReader.canSwitchBackend() &&
      [...this.states.values()].every((state) => !this.active(state))
    );
  }
  /** Advertise only after the real original publisher and remote file operations
   * were opened. This is not a grant to any local path or selected Run. */
  get outputFileSource(): typeof NATIVE_OUTPUT_FILE_VERSION | undefined {
    return this.publications && this.options.protocol.supportsFilePublishing
      ? NATIVE_OUTPUT_FILE_VERSION
      : undefined;
  }
  /** Local original-reader support only. The backend must separately accept
   * this capability and freeze its exact file slots before any model starts. */
  get acceptedFileSource(): typeof NATIVE_ACCEPTED_FILE_TOOL_VERSION | undefined {
    return this.lifetime.signal.aborted ? undefined : NATIVE_ACCEPTED_FILE_TOOL_VERSION;
  }
  /** Local registration availability only; A separately qualifies the actual
   * per-Run library/private port before advertising the signed capability. */
  get knowledgeSource():
    ReturnType<typeof describeMemberKnowledgeTool>['sourceVersion'] | undefined {
    return !this.lifetime.signal.aborted && typeof this.options.knowledge?.create === 'function'
      ? describeMemberKnowledgeTool().sourceVersion
      : undefined;
  }
  /** Local registration availability only, never a selected file read grant. */
  get teamAssetSource(): ReturnType<typeof describeTeamAssetFileTool>['sourceVersion'] | undefined {
    return !this.lifetime.signal.aborted && typeof this.options.teamAssets?.create === 'function'
      ? describeTeamAssetFileTool().sourceVersion
      : undefined;
  }
  /** Read-only local SDK availability for the accept capability declaration.
   * Actual frozen resources are still adopted and checked in the unpublished
   * Agent scope, before its first model request. No catalog/body is loaded here. */
  static resourceSource(ctx: Context): typeof EXECUTION_RESOURCE_SOURCE_VERSION | undefined {
    try {
      const tools = ctx.get('tools');
      return tools &&
        ctx.get('workingDirectory') &&
        typeof SkillRegistry === 'function' &&
        typeof Reflect.get(tools, 'getRegistered') === 'function' &&
        typeof Reflect.get(ToolSkill, 'bindSkillRegistry') === 'function'
        ? EXECUTION_RESOURCE_SOURCE_VERSION
        : undefined;
    } catch {
      return undefined;
    }
  }
  static async open(ctx: Context, options: MemberLocalOwnerOptions) {
    const owner = new MemberLocalExecutionOwner(options);
    await owner.initialize(ctx);
    ctx.effect(() => () => owner.close());
    return owner;
  }
  private state(grant: NativeWorkGrant): Owned {
    const state = this.grants.get(grant);
    if (!state || this.states.get(address(state.scope)) !== state)
      throw new NativeWorkError('scope-mismatch');
    return state;
  }
  private owned(run: MemberLocalReadHandle): Owned | undefined {
    const state = this.handles.get(run);
    return state && this.states.get(address(state.scope)) === state ? state : undefined;
  }
  private workRun(state: Owned): MemberLocalRunHandle {
    if (!state.workRun || state.role === 'cleanup-only')
      throw new NativeWorkError('configuration-mismatch');
    return state.workRun;
  }
  private composition(state: Owned): FrozenExecutionRunComposition {
    return this.workRun(state).composition;
  }
  private active(state: Owned): boolean {
    return !(
      ['submitted', 'retired'].includes(state.phase) &&
      state.view.resources === 'settled' &&
      !state.collecting &&
      !state.retirement
    );
  }
  private trim(): void {
    const settled = [...this.states].filter(([, state]) => !this.active(state));
    for (const [key, state] of settled.slice(
      0,
      Math.max(0, settled.length - REMOTE_RUN_LIMITS.activeAuthorities),
    )) {
      if (state.timer) clearTimeout(state.timer);
      state.observation?.close();
      state.abort.abort();
      this.states.delete(key);
    }
  }
  private check(state: Owned, action: NativeWorkAction): void {
    if (
      this.lifetime.signal.aborted ||
      state.abort.signal.aborted ||
      performance.now() >= state.deadline ||
      state.view.stopRequested ||
      state.role === 'cleanup-only' ||
      (state.role === 'drive'
        ? state.view.authority !== 'drive'
        : state.view.authority !== 'commit-only' || !['open', 'history'].includes(action)) ||
      (state.phase !== 'working' &&
        state.phase !== 'dispatching' &&
        !['open', 'history', 'follow'].includes(action))
    )
      throw new NativeWorkError('cancelled');
  }
  private checkResult(grant: NativeWorkGrant): void {
    const state = this.state(grant);
    this.check(state, 'history');
    if (!['working', 'dispatching', 'fixed'].includes(state.phase))
      throw new NativeWorkError('cancelled');
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private enqueue<T>(state: Owned, task: () => Promise<T>): Promise<T> {
    const job = state.queue.then(task);
    state.queue = job.catch(() => undefined);
    return this.track(job);
  }
  private async initialize(ctx: Context): Promise<void> {
    if (this.options.review) {
      if (
        this.options.review.protocol.backendId !== this.options.protocol.backendId ||
        this.options.review.protocol.actorId !== this.options.protocol.actorId ||
        this.options.review.protocol.deviceId !== this.options.protocol.deviceId
      )
        throw new NativeWorkError('scope-mismatch');
      this.reviews = new MemberLocalExecutionReview({
        protocol: this.options.review.protocol,
        assertModel: this.options.assertModel,
        ...(this.options.openMcp ? { openMcp: this.options.openMcp } : {}),
      });
    }
    this.native = await openNativeWorkSessions(
      ctx,
      {
        workingDirectory: async (binding, grant) => {
          if (this.reviews?.owns(grant)) return { kind: 'text-only' };
          const state = this.state(grant);
          this.check(state, 'send');
          if (!this.options.native) {
            if (this.composition(state).payload.tools.kind === 'local-tools')
              throw new NativeWorkError('configuration-mismatch');
            return { kind: 'text-only' };
          }
          const directory = await this.options.native.workingDirectory(binding, grant);
          this.check(state, 'send');
          return directory;
        },
        compose: async (agentCtx, binding, grant) => {
          if (this.reviews?.owns(grant)) return this.reviews.compose(agentCtx, binding, grant);
          const state = this.state(grant),
            snapshot = this.composition(state);
          this.check(state, 'send');
          const input = await registerMemberLocalAcceptedInputs(
            agentCtx,
            binding,
            grant,
            this.native.service,
            this.options.protocol,
            this.workRun(state),
          );
          this.check(state, 'send');
          const files = await registerMemberLocalAcceptedFiles(
            agentCtx,
            binding,
            grant,
            this.native.service,
            this.options.protocol,
            this.workRun(state),
            (grant) => this.admission(grant),
          );
          this.check(state, 'send');
          await this.options.assertModel(binding.selection, grant.signal);
          this.check(state, 'send');
          const extra = this.options.native
            ? await this.options.native.compose(agentCtx, binding, grant)
            : { context: '', toolAllowlist: [] };
          this.check(state, 'send');
          const result = this.results.registerNativeResultTool(agentCtx, binding, grant);
          const output =
            snapshot.schemaVersion === 2 && snapshot.payload.outputFilePublisherTool
              ? this.publications?.registerNativeOutputFileTool(agentCtx, binding, grant)
              : { context: '', toolAllowlist: [] };
          if (!output) throw new NativeWorkError('configuration-mismatch');
          const knowledge =
            snapshot.schemaVersion === 2 && snapshot.payload.knowledgeTool
              ? this.registerKnowledge(agentCtx, state, binding, grant)
              : { context: '', toolAllowlist: [] };
          const teamAssets =
            snapshot.schemaVersion === 2 &&
            (snapshot.payload.teamAssets || snapshot.payload.teamAssetTool)
              ? this.registerTeamAssets(agentCtx, state, binding, grant)
              : undefined;
          state.resources = await registerExecutionRunResources(
            agentCtx,
            snapshot,
            binding,
            grant,
            {
              sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
              signal: grant.signal,
              assertCurrent: (saved, actual, permission) => {
                this.check(state, 'send');
                if (
                  permission !== grant ||
                  canonicalPayload(saved) !== canonicalPayload(snapshot) ||
                  canonicalPayload(actual) !== canonicalPayload(binding)
                )
                  throw new NativeWorkError('configuration-mismatch');
                return undefined;
              },
              openMcp: async (resource, signal) => {
                this.check(state, 'send');
                if (!this.options.openMcp) throw new NativeWorkError('configuration-mismatch');
                // The original adopter records even a late lease before its
                // current() recheck, so revocation cannot strand that resource.
                return this.options.openMcp(resource, signal);
              },
            },
          );
          await state.resources.ready;
          this.check(state, 'send');
          teamAssets?.assertCurrent();
          if (
            canonicalPayload([
              ...extra.toolAllowlist,
              ...input.toolAllowlist,
              ...files.toolAllowlist,
              ...output.toolAllowlist,
              ...result.toolAllowlist,
              ...knowledge.toolAllowlist,
              ...(teamAssets?.toolAllowlist ?? []),
              ...state.resources.toolAllowlist,
            ]) !== canonicalPayload(snapshot.payload.toolAllowlist)
          )
            throw new NativeWorkError('configuration-mismatch');
          state.observation = observeHostNativeRun(agentCtx, binding, grant);
          state.observation.onClaim(() => {
            if (state.received) void this.acceptClaim(state).catch(() => this.fence(state));
          });
          state.observation.onFault(() => {
            // Actual result preparation retires this same original Agent. Its
            // disposal is a wakeup, never a fabricated failed/completed event.
            this.wake(state);
          });
          state.resources.signal.addEventListener('abort', () => this.wake(state), { once: true });
          return {
            context: [snapshot.payload.context, knowledge.context, teamAssets?.context]
              .filter(Boolean)
              .join('\n'),
            toolAllowlist: snapshot.payload.toolAllowlist,
          };
        },
      },
      this.reviews?.reviewPorts,
      this.options.protocol.backendId,
    );
    this.migrations = new RemoteRunMigrationAuthorities({
      signal: this.lifetime.signal,
      assertGrant: (grant) => {
        const state = this.state(grant),
          accepted = this.starts.get(grant);
        if (!accepted || state.run !== accepted || state.role !== 'drive')
          throw new NativeWorkError('scope-mismatch');
        this.options.protocol.assertStartHandle(accepted);
        this.check(state, 'send');
        return undefined;
      },
      current: (grant) => {
        const state = this.state(grant);
        return {
          view: state.view,
          selection: executionRunCompositionRequest(this.composition(state)).selection,
        };
      },
      migrationOrigin: (query) => this.native.service.migrationOrigin(query),
      migrationDrain: (scope) => {
        try {
          return this.native.service.migrationDrain(scope);
        } catch (error) {
          if (error instanceof NativeWorkError && error.code === 'migration-not-ready')
            return undefined;
          throw error;
        }
      },
    });
    const authority = { assertGrant: (grant: NativeWorkGrant) => this.checkResult(grant) },
      execution: Pick<ExecutionService, 'readRunComposition'> = {
        readRunComposition: (locator) => {
          const state = [...this.states.values()].find((candidate) =>
            (['taskId', 'planId', 'revision', 'nodeId', 'runId'] as const).every(
              (field) => candidate.scope[field] === locator[field],
            ),
          );
          if (!state) throw new NativeWorkError('scope-mismatch');
          this.checkResult(state.grant);
          return this.composition(state);
        },
      };
    if (this.options.outputFiles) {
      this.publications = createNativeOutputFileIssuer(
        ctx,
        this.native.service,
        authority,
        {
          ...execution,
          createRunOutputFiles: (_authority, source) => {
            if (_authority !== authority) throw new NativeWorkError('configuration-mismatch');
            return createMemberLocalOutputFiles(
              this.options.protocol,
              source,
              (grant) => this.workRun(this.state(grant)),
              (grant) => this.admission(grant),
            );
          },
        },
        this.options.outputFiles.resolveBytes,
      );
      this.publicationResults = createNativeFixedResultPublicationsIssuer(
        ctx,
        this.native.service,
        this.native.runtime,
        authority,
        execution,
        this.publications,
      );
      this.results = this.publicationResults.v1Issuer;
    } else {
      this.results = createNativeFixedResultIssuer(
        ctx,
        this.native.service,
        this.native.runtime,
        authority,
        execution,
      );
    }
    this.historyReader = new MemberLocalExecutionHistory(this.native, this.options.protocol);
    this.reviews?.bindNative(this.native);
    this.results.onReady((grant, ref) => {
      const state = this.grants.get(grant);
      if (state)
        void (
          state.role === 'result-only' ? this.continueFixed(state, ref) : this.collect(state, ref)
        ).catch(() => this.fence(state));
    });
    this.heartbeat = setInterval(() => {
      for (const state of this.states.values()) {
        if (['working', 'dispatching'].includes(state.phase))
          void this.refresh(state.run).catch(() => this.fence(state));
      }
    }, REMOTE_RUN_LIMITS.renewAfterMs);
    this.heartbeat.unref();
  }
  private registerKnowledge(
    ctx: Context,
    state: Owned,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ) {
    const factory = this.options.knowledge,
      create = factory?.create,
      snapshot = this.composition(state);
    if (
      !factory ||
      !create ||
      snapshot.schemaVersion !== 2 ||
      canonicalPayload(snapshot.payload.knowledgeTool) !==
        canonicalPayload(describeMemberKnowledgeTool())
    )
      throw new NativeWorkError('configuration-mismatch');
    this.check(state, 'send');
    const ports = create.call(factory, binding, grant);
    if (!ports || typeof ports.assertCurrent !== 'function' || typeof ports.invoke !== 'function')
      throw new NativeWorkError('configuration-mismatch');
    const assert = ports.assertCurrent,
      invoke = ports.invoke;
    const identity = () => {
      this.check(state, 'send');
      if (
        this.options.knowledge !== factory ||
        factory.create !== create ||
        ports.assertCurrent !== assert ||
        ports.invoke !== invoke
      )
        throw new NativeWorkError('configuration-mismatch');
    };
    return registerMemberKnowledgeTool(
      ctx,
      binding,
      grant,
      this.native.service,
      {
        catalog: ports.catalog,
        allowDrafts: ports.allowDrafts,
        assertCurrent: async (signal) => {
          // Called only by the actual tool invocation. Waiting during original
          // unpublished compose would deadlock the same SDK admission.
          await this.admission(grant);
          signal.throwIfAborted();
          identity();
          await assert.call(ports, signal);
          identity();
        },
        invoke: (request, signal) => {
          identity();
          return invoke.call(ports, request, signal);
        },
      },
      snapshot.payload.projectKnowledge?.links
        .filter((link) => link.required)
        .map((link) => link.reference),
    );
  }
  private registerTeamAssets(
    ctx: Context,
    state: Owned,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ) {
    const factory = this.options.teamAssets,
      create = factory?.create,
      run = this.starts.get(grant),
      snapshot = this.composition(state),
      bindingIdentity = canonicalPayload(binding);
    if (
      !factory ||
      !create ||
      !run ||
      run !== this.workRun(state) ||
      snapshot.schemaVersion !== 2 ||
      !snapshot.payload.teamAssets ||
      canonicalPayload(snapshot.payload.teamAssetTool) !==
        canonicalPayload(describeTeamAssetFileTool())
    )
      throw new NativeWorkError('configuration-mismatch');
    const filesIdentity = canonicalPayload(snapshot.payload.teamAssets.files);
    this.check(state, 'send');
    this.options.protocol.assertReadBinding(run, binding);
    const ports = create.call(factory, binding, grant, run);
    if (
      !ports ||
      !ports.signal ||
      typeof ports.assertCurrent !== 'function' ||
      typeof ports.openFile !== 'function'
    )
      throw new NativeWorkError('configuration-mismatch');
    const catalog = ports.catalog,
      signal = ports.signal,
      assert = ports.assertCurrent,
      openFile = ports.openFile;
    const identity = () => {
      this.check(state, 'send');
      if (
        this.state(grant) !== state ||
        this.starts.get(grant) !== run ||
        this.workRun(state) !== run ||
        this.options.teamAssets !== factory ||
        factory.create !== create ||
        ports.catalog !== catalog ||
        ports.signal !== signal ||
        ports.assertCurrent !== assert ||
        ports.openFile !== openFile ||
        signal.aborted ||
        canonicalPayload(binding) !== bindingIdentity ||
        canonicalPayload(grant.scope) !== canonicalPayload(binding.scope) ||
        canonicalPayload(catalog?.scope) !== canonicalPayload(snapshot.payload.scope) ||
        canonicalPayload(catalog?.files) !== filesIdentity
      )
        throw new NativeWorkError('configuration-mismatch');
      this.options.protocol.assertStartHandle(run);
      this.options.protocol.assertReadBinding(run, binding);
    };
    identity();
    const registered = registerTeamAssetFileTool(ctx, binding, grant, this.native.service, {
      catalog,
      signal,
      assertCurrent: async (operationSignal, reference) => {
        // Actual invocation only: awaiting this in unpublished compose would
        // deadlock the same original SDK admission that must publish us first.
        await this.admission(grant);
        operationSignal.throwIfAborted();
        identity();
        await assert.call(ports, operationSignal, reference);
        identity();
      },
      openFile: (reference, operationSignal) => {
        identity();
        const reading = openFile.call(ports, reference, operationSignal);
        return {
          result: reading.result.then((handle) => {
            const check = handle.check,
              release = handle.release;
            const guarded = {
              file: handle.file,
              signal: handle.signal,
              check: () => {
                identity();
                if (handle.check !== check || handle.release !== release)
                  throw new NativeWorkError('configuration-mismatch');
                check.call(handle);
                identity();
              },
              release: () => release.call(handle),
            };
            // Do not reject/discard a late handle here: the original tool must
            // own it through actual drain, then release it on cancellation.
            return handle.carrier !== undefined
              ? { ...guarded, carrier: handle.carrier }
              : { ...guarded, bytes: handle.bytes };
          }),
          // Preserve the original physical operation, without an early race.
          drain: reading.drain,
        };
      },
    });
    return { ...registered, assertCurrent: identity };
  }
  private update(state: Owned, view: RemoteRunView, before: number): void {
    if (
      canonicalPayload(view.scope) !== canonicalPayload(state.run.value.scope) ||
      view.deviceId !== this.options.protocol.deviceId ||
      view.permit.id !== state.run.value.permit.id ||
      view.permit.epoch !== state.run.value.permit.epoch ||
      view.cleanup.id !== state.run.value.cleanup.id ||
      view.cleanup.epoch !== state.run.value.cleanup.epoch ||
      view.nextSequence < state.sequence
    )
      throw new MemberLocalProtocolError('local-mismatch');
    state.view = structuredClone(view);
    state.sequence = view.nextSequence;
    const ttl = view.permit.expiresAt - view.serverTime,
      cleanupTtl = view.cleanup.expiresAt - view.serverTime;
    state.deadline = before + Math.min(ttl, REMOTE_RUN_LIMITS.driveTtlMs);
    state.cleanupDeadline = before + Math.min(cleanupTtl, REMOTE_RUN_LIMITS.cleanupTtlMs);
    if (state.timer) clearTimeout(state.timer);
    const granted =
      state.role === 'drive' ? view.authority === 'drive' : view.authority === 'commit-only';
    if (!granted || view.stopRequested || ttl <= 0) {
      if (state.phase !== 'fixed' && state.phase !== 'submitted') this.fence(state);
    } else {
      state.timer = setTimeout(
        () => this.fence(state),
        Math.max(1, state.deadline - performance.now()),
      );
      state.timer.unref();
    }
  }
  private wake(state: Owned): void {
    setImmediate(() => {
      if (!['working', 'dispatching'].includes(state.phase)) return;
      try {
        const binding = this.native.service.open(state.grant)?.binding;
        if (binding?.resultIntent) void this.collect(state).catch(() => this.fence(state));
        else this.fence(state);
      } catch {
        this.fence(state);
      }
    });
  }
  /** Requires this protocol's private accepted handle and a fresh backend status.
   * Opening old persisted native work never silently resumes or creates an Agent. */
  async start(run: MemberLocalAcceptedRun): Promise<MemberLocalOwnerView> {
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    this.options.protocol.assertStartHandle(run);
    const before = performance.now(),
      view = await this.options.protocol.status(run),
      { backendId: _backendId, ...scope } = view.scope,
      existing = this.states.get(address(scope));
    if (existing) {
      if (
        !existing.workRun ||
        existing.role === 'cleanup-only' ||
        canonicalPayload(existing.workRun?.composition) !== canonicalPayload(run.composition) ||
        existing.run.value.permit.id !== run.value.permit.id ||
        existing.run.value.cleanup.id !== run.value.cleanup.id
      )
        throw new NativeWorkError('scope-mismatch');
      this.handles.set(run, existing);
      return this.read(run);
    }
    this.trim();
    const snapshot = run.composition;
    if (
      [...this.states.values()].filter((state) => this.active(state)).length >=
        REMOTE_RUN_LIMITS.activeAuthorities ||
      view.authority !== 'drive' ||
      view.resources !== 'held' ||
      view.runStatus !== 'requested' ||
      view.stopRequested ||
      snapshot.schemaVersion !== 2 ||
      !['zhuma-native-result-intent@1', 'zhuma-native-result-intent@2'].includes(
        snapshot.payload.resultIntentTool?.sourceVersion ?? '',
      ) ||
      (snapshot.payload.resultIntentTool?.sourceVersion === 'zhuma-native-result-intent@2' &&
        !this.publicationResults) ||
      (snapshot.payload.outputFilePublisherTool && !this.outputFileSource) ||
      (snapshot.payload.knowledgeTool && !this.knowledgeSource) ||
      (snapshot.payload.teamAssetTool && !this.teamAssetSource) ||
      (snapshot.payload.tools.kind === 'local-tools' && !this.options.native) ||
      (snapshot.payload.resources?.mcp.length && !this.options.openMcp)
    )
      throw new NativeWorkError('configuration-mismatch');
    const state = this.retain(run, view, before, 'drive', run);
    this.starts.set(state.grant, run);
    try {
      this.check(state, 'open');
      state.dispatch = this.track(this.dispatch(state));
      await state.dispatch;
    } catch (error) {
      this.fence(state);
      throw error;
    }
    return this.read(run);
  }
  private retain(
    run: MemberLocalReadHandle,
    view: RemoteRunView,
    before: number,
    role: Owned['role'],
    workRun?: MemberLocalRunHandle,
  ): Owned {
    const { backendId: _backendId, ...scope } = view.scope,
      abort = new AbortController(),
      grant: NativeWorkGrant = Object.freeze({
        scope: Object.freeze(structuredClone(scope)),
        signal: abort.signal,
        assertCurrent: (action: NativeWorkAction) => this.check(this.state(grant), action),
      }),
      state: Owned = {
        run,
        ...(workRun ? { workRun } : {}),
        role,
        scope: grant.scope,
        abort,
        grant,
        view,
        deadline: before,
        cleanupDeadline: before,
        phase:
          role === 'drive' ? 'dispatching' : role === 'result-only' ? 'fixed' : 'recovery-required',
        sequence: view.nextSequence,
        queue: Promise.resolve(),
        received: false,
        accepted: false,
      };
    const previous = this.states.get(address(scope));
    if (previous) {
      if (previous.timer) clearTimeout(previous.timer);
      previous.abort.abort();
      previous.observation?.close();
    }
    this.states.set(address(scope), state);
    this.handles.set(run, state);
    this.grants.set(grant, state);
    this.update(state, view, before);
    return state;
  }
  private async dispatch(state: Owned): Promise<void> {
    await this.prepareStart(state);
    const { firstMessage, selection } = executionRunCompositionRequest(this.composition(state));
    await this.options.assertModel(selection, state.grant.signal);
    this.check(state, 'send');
    const receipt = await this.native.service.send(state.grant, {
        requestId: randomUUID(),
        text: firstMessage.text,
        mode: firstMessage.mode,
        selection,
      }),
      binding = this.native.service.open(state.grant)?.binding;
    if (!binding || !['received', 'claimed'].includes(receipt.status))
      throw new NativeWorkError('unavailable');
    state.binding = binding;
    state.firstMessageId = receipt.messageId;
    await this.emit(state, {
      kind: 'received',
      sequence: state.sequence,
      nativeSessionId: binding.nativeSessionId,
    });
    state.received = true;
    state.phase = 'working';
    await this.acceptClaim(state);
  }
  private async prepareStart(state: Owned): Promise<void> {
    let current;
    try {
      current = this.native.service.open(state.grant);
    } catch (error) {
      // A known old binding is retained under the original node key. Only D's
      // accepted new Run lineage plus the original SDK drain may replace it.
      if (
        !(error instanceof NativeWorkError) ||
        error.code !== 'scope-mismatch' ||
        !state.view.migration
      )
        throw error;
      const opened = this.migrations.open(state.grant);
      try {
        const prepared = await this.native.service.prepareMigration(opened.grant);
        if (prepared.status !== 'prepared') throw new NativeWorkError('migration-not-ready');
        const migrated = await this.native.service.migrate(opened.grant);
        if (migrated.status === 'pending') throw new NativeWorkError('migration-not-ready');
        this.check(state, 'send');
      } finally {
        opened.dispose();
      }
      return;
    }
    // An already-present binding for this same new scope requires explicit
    // recovery; a fresh accepted handle is never permission to replay its send.
    if (current) throw new NativeWorkError('scope-mismatch');
  }
  private acceptClaim(state: Owned): Promise<void> {
    return this.enqueue(state, async () => {
      if (state.accepted || !state.received || !state.firstMessageId) return;
      const claim = state.observation?.claimFor(state.firstMessageId);
      if (!claim) return;
      const before = performance.now(),
        view = await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: {
            event: {
              kind: 'accepted',
              sequence: state.sequence,
              nativeSessionId: claim.nativeSessionId,
              executorRunId: claim.nativeAgentId,
            },
          },
        });
      this.update(state, view, before);
      state.accepted = true;
    });
  }
  private async admission(grant: NativeWorkGrant): Promise<void> {
    const state = this.state(grant);
    await state.dispatch;
    await this.acceptClaim(state);
    this.check(state, 'send');
    if (!state.accepted) throw new NativeWorkError('unavailable');
  }
  private emit(state: Owned, event: RemoteRunEvent): Promise<void> {
    return this.enqueue(state, async () => {
      const before = performance.now(),
        view = await this.options.protocol.command(state.run, {
          operation: 'event',
          payload: { event: { ...event, sequence: state.sequence } },
        });
      this.update(state, view, before);
    });
  }
  private collect(state: Owned, ref?: NativeFixedResultRef): Promise<void> {
    if (state.collecting) return state.collecting;
    if (!['dispatching', 'working'].includes(state.phase)) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      await state.dispatch;
      await state.queue;
      if (!state.accepted) return;
      const prepared = ref
        ? { status: 'ready' as const, ref }
        : await this.results.prepareFixedResult(state.grant, state.grant.signal);
      if (prepared.status !== 'ready') return;
      const lease = await this.fixedLease(state, prepared.ref);
      try {
        await state.resources?.drain();
        lease.check();
        const draft = remoteResultDigestInput({
            ...lease.content,
            files: 'manifest' in lease ? lease.content.files : [],
          }),
          result = remoteResultDeclarationSchema.parse({
            requestId: lease.source.intentId,
            digest: lease.digest,
            artifactDigest: hash(draft),
            source: lease.source,
            ...('manifest' in lease
              ? { publications: lease.manifest.map((entry) => entry.evidence) }
              : {}),
          });
        state.phase = 'fixed';
        await this.emit(state, {
          kind: 'completed',
          sequence: state.sequence,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result,
        });
        await this.commit(state, result, draft);
      } finally {
        lease.release();
      }
    });
    state.collecting = this.track(
      work.finally(() => {
        delete state.collecting;
        this.trim();
      }),
    );
    return state.collecting;
  }
  private async commit(
    state: Owned,
    result: RemoteResultDeclaration,
    draft: RemoteResultDraft,
  ): Promise<void> {
    const submitted = await this.enqueue(state, () =>
      this.options.protocol.command(state.run, {
        operation: 'submit-result',
        requestId: result.requestId,
        payload: { expectedNodeVersion: state.view.nodeVersion, result, draft },
      }),
    );
    if (
      submitted.receipt.requestId !== result.requestId ||
      submitted.receipt.digest !== result.digest ||
      submitted.receipt.artifactDigest !== result.artifactDigest
    )
      throw new MemberLocalProtocolError('local-mismatch');
    state.receipt = Object.freeze(structuredClone(submitted.receipt));
    state.phase = 'submitted';
    if (state.timer) clearTimeout(state.timer);
  }
  private fixedLease(
    state: Owned,
    ref: NativeFixedResultRef,
  ): Promise<NativeFixedResultLease | NativeFixedResultPublicationsLease> {
    const snapshot = this.composition(state);
    if (
      snapshot.schemaVersion === 2 &&
      snapshot.payload.resultIntentTool?.sourceVersion === 'zhuma-native-result-intent@2'
    ) {
      if (!this.publicationResults) throw new NativeWorkError('configuration-mismatch');
      return this.publicationResults.readFixedResult(state.grant, ref, state.grant.signal);
    }
    return this.results.readFixedResult(state.grant, ref, state.grant.signal);
  }
  /** Explicit same-result continuation. It cannot call send, factory create/
   * resume, register tools or issue a new completion declaration. */
  async continueResult(run: MemberLocalRunHandle): Promise<MemberLocalOwnerView> {
    if (this.lifetime.signal.aborted) throw new NativeWorkError('unavailable');
    const before = performance.now(),
      view = await this.options.protocol.status(run),
      { backendId: _backendId, ...scope } = view.scope,
      prior = this.states.get(address(scope));
    if (
      view.authority !== 'commit-only' ||
      view.runStatus !== 'completed' ||
      view.resources !== 'settled' ||
      view.stopRequested ||
      !view.result ||
      !['zhuma-native-result-intent@1', 'zhuma-native-result-intent@2'].includes(
        view.result.source.toolVersion,
      ) ||
      (view.result.source.toolVersion === 'zhuma-native-result-intent@2' &&
        !this.publicationResults)
    )
      throw new MemberLocalProtocolError('remote-recovery-required');
    if (prior?.collecting || (prior && !prior.abort.signal.aborted && prior.phase !== 'fixed'))
      throw new NativeWorkError('unavailable');
    if (prior?.retirement) await prior.retirement;
    const state = this.retain(run, view, before, 'result-only', run);
    try {
      await this.continueFixed(state);
    } catch (error) {
      this.fence(state);
      throw error;
    }
    return this.read(run);
  }
  private continueFixed(state: Owned, ref?: NativeFixedResultRef): Promise<void> {
    if (state.collecting) return state.collecting;
    if (state.role !== 'result-only' || state.phase !== 'fixed') return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      this.checkResult(state.grant);
      const declared = state.view.result;
      if (!declared) throw new NativeWorkError('scope-mismatch');
      const prepared = ref
        ? { status: 'ready' as const, ref }
        : await this.results.prepareFixedResult(state.grant, state.grant.signal);
      if (prepared.status !== 'ready') return;
      const lease = await this.fixedLease(state, prepared.ref);
      try {
        lease.check();
        const draft = remoteResultDigestInput({
          ...lease.content,
          files: 'manifest' in lease ? lease.content.files : [],
        });
        if (
          canonicalPayload(lease.source) !== canonicalPayload(declared.source) ||
          lease.digest !== declared.digest ||
          hash(draft) !== declared.artifactDigest ||
          ('manifest' in lease &&
            canonicalPayload(lease.manifest.map((entry) => entry.evidence)) !==
              canonicalPayload(declared.publications))
        )
          throw new MemberLocalProtocolError('local-mismatch');
        await this.commit(state, declared, draft);
      } finally {
        lease.release();
      }
    });
    state.collecting = this.track(
      work.finally(() => {
        delete state.collecting;
        this.trim();
      }),
    );
    return state.collecting;
  }
  private fence(state: Owned): void {
    if (state.phase === 'submitted' || state.phase === 'retired' || state.retirement) return;
    state.phase = 'recovery-required';
    state.abort.abort();
    if (state.timer) clearTimeout(state.timer);
    // Leave the SDK callback stack before joining native disposal/persistence.
    const work = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
      this.retire(state),
    );
    state.retirement = this.track(
      work.finally(() => {
        delete state.retirement;
        this.trim();
      }),
    );
    void work.catch(() => undefined);
  }
  private async retire(state: Owned): Promise<void> {
    state.phase = 'retiring';
    try {
      const retired = await this.native.service.retireForCleanup(
        {
          scope: state.scope,
          assertCurrent: () => {
            if (performance.now() >= state.cleanupDeadline) throw new NativeWorkError('cancelled');
            return undefined;
          },
        },
        AbortSignal.timeout(Math.max(1, Math.ceil(state.cleanupDeadline - performance.now()))),
      );
      if (retired.status !== 'retired') return;
      await state.resources?.drain();
      retired.drain.assertCurrent();
      const evidence =
        retired.drain.basis === 'absent-unadmitted'
          ? { basis: 'absent-unadmitted' as const }
          : retired.binding
            ? {
                basis: 'flushed-and-closed' as const,
                nativeSessionId: retired.binding.nativeSessionId,
                nativeAgentId: retired.binding.nativeAgentId,
              }
            : undefined;
      if (!evidence) throw new NativeWorkError('unavailable');
      const before = performance.now(),
        view = await this.enqueue(state, () =>
          this.options.protocol.command(state.run, {
            operation: 'cleanup',
            payload: { observation: { kind: 'drained', sequence: state.sequence, evidence } },
          }),
        );
      this.update(state, view, before);
      state.phase = view.resources === 'settled' ? 'retired' : 'recovery-required';
    } finally {
      if (state.phase === 'retiring') state.phase = 'recovery-required';
    }
  }
  read(run: MemberLocalReadHandle): MemberLocalOwnerView {
    const state = this.owned(run);
    if (!state) throw new NativeWorkError('scope-mismatch');
    let native: MemberLocalOwnerView['native'];
    if (
      !state.abort.signal.aborted &&
      performance.now() < state.deadline &&
      !['fixed', 'submitted'].includes(state.phase)
    ) {
      native = this.native.service.open(state.grant);
      if (native) state.binding = native.binding;
    } else if (state.binding)
      native = { binding: structuredClone(state.binding), status: 'detached' };
    return {
      phase: state.phase,
      remote: structuredClone(state.view),
      native,
      ...(state.receipt ? { receipt: state.receipt } : {}),
    };
  }
  /** Host routing only. A still checks current member/space/Run before read/send. */
  lookupNativeSession(nativeSessionId: string) {
    return this.native.lookupNativeSession(nativeSessionId);
  }
  /** Fresh authorized navigation. Unlike read(), this is the UI's initial read.
   * It never activates a drive, factory, model, input or resource registration. */
  async open(run: MemberLocalReadHandle, signal?: AbortSignal): Promise<MemberLocalOwnerView> {
    const value = await this.historyReader.open(run, signal),
      { backendId: _backendId, ...scope } = value.remote.scope,
      state = this.states.get(address(scope));
    if (state && value.native) state.binding = value.native.binding;
    const localPhase =
      state &&
      ['working', 'dispatching'].includes(state.phase) &&
      (state.abort.signal.aborted || performance.now() >= state.deadline)
        ? 'recovery-required'
        : state?.phase;
    const phase: Phase =
      localPhase ??
      (value.remote.receipt
        ? 'submitted'
        : value.remote.resources === 'settled'
          ? value.remote.runStatus === 'completed'
            ? 'fixed'
            : 'retired'
          : 'recovery-required');
    return { ...value, phase, ...(value.remote.receipt ? { receipt: value.remote.receipt } : {}) };
  }
  async openScope(scope: RemoteRunView['scope'], signal?: AbortSignal) {
    const run = await this.options.protocol.history(scope, signal);
    return { run, view: await this.open(run, signal) };
  }
  async openSession(nativeSessionId: string, signal?: AbortSignal) {
    const found = this.native.lookupNativeSession(nativeSessionId);
    if (!found || found.role !== 'work' || found.backendId !== this.options.protocol.backendId)
      throw new NativeWorkError('scope-mismatch');
    const opened = await this.openScope(
      { backendId: found.backendId, ...found.binding.scope },
      signal,
    );
    if (opened.view.native?.binding.nativeSessionId !== nativeSessionId)
      throw new NativeWorkError('scope-mismatch');
    return opened;
  }
  /** Read-only UI history over the fixed native presentation whitelist. */
  history(run: MemberLocalReadHandle, after = -1, limit = 100, signal?: AbortSignal) {
    return this.historyReader.history(run, after, limit, signal);
  }
  readInbox(run: MemberLocalReadHandle, signal?: AbortSignal) {
    return this.historyReader.readInbox(run, signal);
  }
  async updateQueue(
    run: MemberLocalReadHandle,
    update: Parameters<NativeOwner['service']['updateQueue']>[1],
  ) {
    const state = await this.liveDrive(run);
    this.check(state, 'queue');
    return this.track(this.native.service.updateQueue(state.grant, update));
  }
  observe(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    return this.historyReader.observe(run, after, signal);
  }
  /** Host-internal raw frames; never mount this directly in Client transport. */
  follow(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    return this.historyReader.follow(run, after, signal);
  }
  async stop(
    run: MemberLocalReadHandle,
    input: MemberLocalStopInput,
    signal?: AbortSignal,
  ): Promise<MemberLocalOwnerView> {
    this.options.protocol.assertReadHandle(run);
    const { backendId: _backendId, ...scope } = run.value.scope;
    let state = this.states.get(address(scope));
    if (!state && run.value.resources === 'held') {
      // Do not extend an old cleanup deadline by treating cached serverTime as
      // a fresh sample. Actual cleanup still verifies its backend capability.
      const sampledAt =
        performance.now() - Math.max(0, this.options.protocol.serverTime - run.value.serverTime);
      state = this.retain(run, run.value, sampledAt, 'cleanup-only');
    }
    // No history read/renew gates a local stop: revoked member access may deny
    // the business command while the old independent cleanup must still drain.
    // Dispatch the explicit original stop first. The physical local retirement
    // is independent of the HTTP wait; unknown is never a stopped/drained ACK.
    const stopping = this.track(this.options.protocol.stop(run, input, signal));
    if (state) this.fence(state);
    await stopping;
    return this.open(run, signal);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.lifetime.abort();
      await this.historyReader.close();
      await this.reviews?.close();
      for (const state of this.states.values()) this.fence(state);
      // A first joins every already-sent accept and hands late issued handles
      // to stop(). Drain tasks may themselves enqueue their original events.
      while (this.jobs.size) await Promise.allSettled([...this.jobs]);
      await this.results.close();
      await this.publications?.close();
      await this.native.close();
    })());
  }
  startReview(run: MemberLocalAcceptedReview) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.start(run);
  }
  lookupSession(nativeSessionId: string) {
    return this.native.lookupNativeSession(nativeSessionId);
  }
  openReviewSession(nativeSessionId: string, signal?: AbortSignal) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.openSession(nativeSessionId, signal);
  }
  historyReview(run: MemberLocalReviewReadHandle, after = -1, limit = 100, signal?: AbortSignal) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.historyOf(run, after, limit, signal);
  }
  recoverReview(run: MemberLocalReviewReadHandle, signal?: AbortSignal) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.recover(run, signal);
  }
  observeReview(run: MemberLocalReviewReadHandle, after = -1, signal?: AbortSignal) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.observe(run, after, signal);
  }
  readReview(run: MemberLocalReviewReadHandle) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.read(run);
  }
  stopReview(
    run: MemberLocalAcceptedReview,
    input: MemberLocalReviewStopInput,
    signal?: AbortSignal,
  ) {
    if (!this.reviews) throw new NativeWorkError('unavailable');
    return this.reviews.stop(run, input, signal);
  }
  async refresh(run: MemberLocalReadHandle): Promise<MemberLocalOwnerView> {
    const state = this.owned(run);
    if (!state) throw new NativeWorkError('scope-mismatch');
    await this.enqueue(state, async () => {
      this.check(state, 'open');
      const before = performance.now(),
        view = await this.options.protocol.command(run, { operation: 'renew', payload: {} });
      this.update(state, view, before);
    }).catch((error: unknown) => {
      this.fence(state);
      throw error;
    });
    return this.read(run);
  }
  /** Explicit interaction may use this process's still-live original drive.
   * A history handle never mints/resumes one, and an expired drive stays expired. */
  private async liveDrive(run: MemberLocalReadHandle): Promise<Owned> {
    const opened = await this.open(run),
      { backendId: _backendId, ...scope } = opened.remote.scope,
      state = this.states.get(address(scope));
    if (!state || state.role !== 'drive' || state.phase !== 'working' || !state.workRun)
      throw new NativeWorkError('cancelled');
    await this.refresh(state.workRun);
    this.check(state, 'send');
    return state;
  }
  async send(
    run: MemberLocalReadHandle,
    input: Omit<Parameters<NativeOwner['service']['send']>[1], 'selection'>,
  ) {
    const state = await this.liveDrive(run);
    this.check(state, 'send');
    return this.track(
      this.native.service.send(state.grant, {
        ...input,
        selection: this.workRun(state).value.selection,
      }),
    );
  }
}
