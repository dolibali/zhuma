import { symbols, type Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import {
  canonicalPayload,
  createNodeHandoffs,
  isTerminalRunStatus,
  localReviewOptionsQuerySchema,
  localReviewOptionsSchema,
  type Workbench,
} from '@zhuma/agent-core';
import { z } from 'zod';
import { createHostRunConfiguration } from './host-run-configuration.js';
import { createHostRunOptions } from './host-run-options.js';
import { createHostRunSources, createHostRunRetirements } from './host-run-sources.js';
import { createHostRunResourceSource } from './host-run-resource-source.js';
import type { createHostRunSkillPolicies } from './host-run-skill-policy.js';
import {
  registerExecutionRunResources,
  type ExecutionRunResourceAdoption,
} from './execution-run-resources.js';
import {
  assertHostAbsentRetry,
  retireHostUnadmittedScope,
  retireHostSettledScope,
  hostWorkflowRecoveryBinding,
  type HostAbsentRetirement,
} from './host-run-recovery.js';
import {
  createHostRunReader,
  type HostRunModeCapability,
  type HostRunSendCapabilities,
} from './host-run-reader.js';
import { observeHostNativeRun, type HostNativeClaim } from './host-run-observation.js';
import type { HostRunOperations } from './host-run-http.js';
import type {
  ExecutionService,
  ExecutionResult,
  RunEventAuthority,
  BeginRunRequest,
} from './execution-service.js';
import type {
  ExecutionRunAuthorities,
  ExecutionRunCleanupAuthority,
  ExecutionRunLocator,
  OpenedExecutionRunAuthority,
} from './execution-run-authority.js';
import {
  ExecutionRunError,
  currentExecutionRun,
  executionRunScope,
  readExecutionRunState,
  isExecutionRunRevisionStart,
  type ExecutionRunDecision,
  type ExecutionRunEvent,
} from './execution-run-state.js';
import {
  assertExecutionRunCompositionBinding,
  executionRunCompositionRequest,
} from './execution-run-composition.js';
import { openNativeWorkSessions } from './native-work-session-storage.js';
import { createNativeReviewBridge } from './native-work-session-review-bridge.js';
import { adoptHostReviewResources } from './host-review-resources.js';
import { readExecutionReviewState } from './execution-review-state.js';
import {
  createNativeFixedResultIssuer,
  createNativeFixedResultPublicationsIssuer,
  type NativeFixedResultIssuer,
  type NativeFixedResultPublicationsIssuer,
} from './native-work-session-result.js';
import { frozenHostResultProtocol } from './host-run-result-protocol.js';
import type { NativeFixedResultRef } from './native-work-session-result-contract.js';
import type { NativeResultSubmit } from './execution-native-result-delivery.js';
import { registerNativeAcceptedInputTool } from './native-work-session-input-tool.js';
import { registerNativeAcceptedFileTool } from './native-work-session-files-tool.js';
import type { NativeRunAcceptedFiles } from './native-work-session-files-contract.js';
import { NativeWorkError, type NativeWorkScope } from './native-work-session-contract.js';
import { nativeScopeKey } from './native-work-session-record.js';
import { createHostRunWorkspaces, type HostLocalExecutionConfig } from './host-run-workspaces.js';
import { openHostWorkspaceApprovals } from './host-workspace-approvals.js';
import { createHostWorkflowOwner, type HostWorkflowOperations } from './host-workflow-owner.js';
import { adoptNativeRunLocalTools } from './native-run-local-tools.js';
import {
  createNativeOutputFileIssuer,
  type NativeOutputFileIssuer,
} from './native-work-session-output-file.js';
import { openExecutionMemberLease, resolveMember, type MemberRequest } from './member-session.js';
import {
  ExecutionWorkflowError,
  type WorkflowStartTicket,
  type WorkflowExecutionView,
} from './execution-workflow-contract.js';

const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const sendRequest = z.strictObject({
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
  generation: positive,
  segmentId: id,
  requestId: id,
  text: z
    .string()
    .min(1)
    .max(16_384)
    .refine((text) => text.trim().length > 0),
  mode: z.enum(['followup', 'steer', 'queue']),
});
export const hostRunSendRequestSchema = sendRequest;
const locatorFor = (scope: NativeWorkScope): ExecutionRunLocator => ({
  taskId: scope.taskId,
  planId: scope.planId,
  revision: scope.revision,
  nodeId: scope.nodeId,
  runId: scope.runId,
});
type EventBody<T = ExecutionRunEvent> = T extends ExecutionRunEvent
  ? Omit<T, 'runId' | 'generation' | 'segmentId' | 'sequence'>
  : never;
interface OwnedRun {
  readonly scope: NativeWorkScope;
  readonly cleanup: ExecutionRunCleanupAuthority;
  readonly request: MemberRequest;
  sequence: number;
  opened?: OpenedExecutionRunAuthority;
  observation?: ReturnType<typeof observeHostNativeRun>;
  stopObservation?: () => void;
  stopFault?: () => void;
  stopRevocation?: () => void;
  resourceAdoption?: ExecutionRunResourceAdoption;
  stopResources?: () => void;
  firstMessageId?: string;
  nativeSessionId?: string;
  nativeAgentId?: string;
  accepting?: Promise<void>;
  retirement?: Promise<'pending' | 'retired'>;
  dispatching?: Promise<'received' | 'unknown'>;
  resultWork?: Promise<void>;
  resultAgain?: boolean;
  resultRef?: NativeFixedResultRef;
  resultCommand?: NativeResultSubmit;
  resultPending?: 'draining' | 'not-durable' | 'delivery-unconfirmed';
  resultFailure?: unknown;
}
interface WorkflowAdmission {
  readonly state: OwnedRun;
  readonly ticket: WorkflowStartTicket;
  readonly wait?: AbortSignal;
}

/** One native owner consuming the already opened D execution owner. No new Run store/queue. */
export async function openHostRunOwner(
  ctx: Context,
  options: {
    readonly execution: ExecutionService;
    readonly directory: Parameters<typeof createHostRunSources>[1]['directory'];
    readonly signal: AbortSignal;
    readonly skillPolicies: ReturnType<typeof createHostRunSkillPolicies>;
    readonly localExecution?: HostLocalExecutionConfig | undefined;
    /** Shared backend owns facts/permissions only; never a native driver. */
    readonly remoteOnly?: boolean;
    readonly prepareProjectKnowledge?: Parameters<
      typeof createHostRunSources
    >[1]['prepareProjectKnowledge'];
    readonly teamAssets?: Parameters<typeof createHostRunSources>[1]['teamAssets'];
    readWorkbench(): Workbench;
  },
) {
  const execution = options.execution;
  const assertNativeDrive = () => {
    if (options.remoteOnly) throw new ExecutionRunError('run-authority-denied');
  };
  const lifetime = new AbortController();
  const owned = new Map<string, OwnedRun>();
  const admissions = new Map<string, WorkflowAdmission>();
  const absentRetirements = new Map<string, HostAbsentRetirement>();
  const commands = new Set<Promise<unknown>>();
  const events = new Set<Promise<unknown>>();
  let beginning = 0;
  let authorities: ExecutionRunAuthorities;
  let results: NativeFixedResultIssuer | undefined;
  let publications: NativeFixedResultPublicationsIssuer | undefined;
  let outputs: NativeOutputFileIssuer | undefined;
  let acceptedFiles: NativeRunAcceptedFiles | undefined;
  let workflow: ReturnType<typeof createHostWorkflowOwner> | undefined;
  let fenced = false;
  let retirementDrains: ReturnType<typeof createHostRunRetirements> | undefined;
  let closing: Promise<void> | undefined;
  // This owner chooses once. An absent legacy backend is distinct from a
  // present backend whose initialization or later lifecycle has failed.
  const original = (value: unknown): unknown =>
    value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
  // Strict lookup hides registered providers while their fiber is initializing.
  // Only actual absence permits v1; an unready provider fails before any native
  // owner or Run authority is installed and requires an explicit remount.
  const attachmentBackend = original(ctx.get('attachments', false));
  if (attachmentBackend !== undefined && original(ctx.get('attachments')) !== attachmentBackend)
    throw new ExecutionRunError('run-authority-unavailable');
  const backendOwner =
    attachmentBackend === undefined
      ? undefined
      : ctx.plugin({
          name: 'zhuma-native-result-file-backend',
          inject: ['attachments'],
          apply(backend: Context) {
            if (original(backend.get('attachments')) !== attachmentBackend)
              throw new ExecutionRunError('run-authority-unavailable');
            backend.effect(() => () => {
              execution.fenceRuns();
              lifetime.abort();
            });
          },
        });
  await backendOwner;
  const resultProtocol = (): 1 | 2 => {
    if (
      lifetime.signal.aborted ||
      (attachmentBackend !== undefined && original(ctx.get('attachments')) !== attachmentBackend)
    )
      throw new ExecutionRunError('run-authority-unavailable');
    return attachmentBackend === undefined ? 1 : 2;
  };
  const workspaceApprovals = openHostWorkspaceApprovals(ctx, {
    execution,
    signal: lifetime.signal,
  });
  const workspaces = createHostRunWorkspaces(ctx, {
    config: options.localExecution,
    approvals: workspaceApprovals.owner,
    execution,
    signal: lifetime.signal,
    readWorkbench: options.readWorkbench,
  });
  if (workspaces.dependenciesPresent()) await workspaces.ready;
  const resources = createHostRunResourceSource({
    execution,
    policies: options.skillPolicies,
    readWorkbench: options.readWorkbench,
    signal: lifetime.signal,
  });
  const configuration = createHostRunConfiguration(ctx, {
    execution,
    readWorkbench: options.readWorkbench,
    signal: lifetime.signal,
    resources,
    workspaces,
    resultProtocol,
    acceptedFilesReady() {
      return resultProtocol() === 2 && acceptedFiles !== undefined;
    },
  });
  const readOptions = createHostRunOptions(ctx, {
    execution,
    readWorkbench: options.readWorkbench,
    signal: lifetime.signal,
    resources,
    workspaces,
    ...(options.remoteOnly ? { localSelection: true } : {}),
  });
  const reviews = createNativeReviewBridge({
    execution,
    signal: lifetime.signal,
    host: {
      prepareReview: (original, input, wait) => {
        assertNativeDrive();
        // Author output limits do not configure the independent review.
        const { provider, model, reasoningEffort } = input.model;
        return configuration.prepareReview(
          original,
          { ...input, model: { provider, model, reasoningEffort } },
          wait,
        );
      },
      adoptReviewResources(agentCtx, input) {
        assertNativeDrive();
        return adoptHostReviewResources(agentCtx, input, {
          native: native.service,
          resources,
          assertModel: configuration.assertReviewConfiguration,
          readNode(scope) {
            const node = execution.readRunNode(scope);
            if (!node) throw new ExecutionRunError('run-authority-denied');
            return node;
          },
        });
      },
    },
  });
  const native: Awaited<ReturnType<typeof openNativeWorkSessions>> = await openNativeWorkSessions(
    ctx,
    {
      async workingDirectory(binding, grant) {
        if (native.service.isReviewPurpose(grant)) {
          native.service.reviewContext(grant);
          return { kind: 'text-only' };
        }
        authorities.assertGrant(grant, 'send');
        const node = execution.readRunNode(grant.scope);
        const run = node && currentExecutionRun(node);
        if (
          !run ||
          canonicalPayload(executionRunScope(node!, run)) !== canonicalPayload(binding.scope)
        )
          throw new ExecutionRunError('run-authority-denied');
        if (run.workspace.kind === 'text-only') return { kind: 'text-only' };
        return workspaces.directory(binding, grant);
      },
      async compose(agentCtx, binding, grant) {
        if (native.service.isReviewPurpose(grant)) return reviews.compose(agentCtx, binding, grant);
        authorities.assertGrant(grant, 'send');
        const state = owned.get(nativeScopeKey(grant.scope));
        if (!state || state.opened?.grant !== grant)
          throw new ExecutionRunError('run-authority-denied');
        assertAdmission(state);
        const snapshot = execution.readRunComposition(locatorFor(grant.scope));
        const projected = executionRunCompositionRequest(snapshot);
        assertExecutionRunCompositionBinding(snapshot, binding.scope, projected);
        if (canonicalPayload(binding.selection) !== canonicalPayload(projected.selection))
          throw new NativeWorkError('configuration-mismatch');
        if (snapshot.payload.tools.kind === 'local-tools')
          workspaces.bindSession(agentCtx, binding, grant);
        configuration.assertModel(snapshot);
        let baseTools: readonly string[] = [];
        if (
          snapshot.payload.tools.kind === 'accepted-input-reader' ||
          (snapshot.payload.tools.kind === 'local-tools' &&
            snapshot.payload.tools.acceptedInputReader)
        ) {
          const registered = registerNativeAcceptedInputTool(
            agentCtx,
            binding,
            grant,
            native.service,
            {
              catalog: {
                scope: grant.scope,
                inputs: snapshot.payload.inputs.map(({ sourceGoal, ...input }) => ({
                  input: { ...input, ...(sourceGoal === undefined ? {} : { sourceGoal }) },
                  required: true,
                })),
              },
              async resolveCurrentCaller(signal) {
                signal.throwIfAborted();
                authorities.assertGrant(grant, 'send');
                const member = await resolveMember(ctx, state.request);
                authorities.assertGrant(grant, 'send');
                signal.throwIfAborted();
                return { member };
              },
              reader: execution,
            },
          );
          baseTools = registered.toolAllowlist;
        }
        if (snapshot.schemaVersion === 2 && snapshot.payload.acceptedFileReader) {
          resultProtocol();
          if (!acceptedFiles) throw new NativeWorkError('configuration-mismatch');
          const registered = registerNativeAcceptedFileTool(
            agentCtx,
            binding,
            grant,
            native.service,
            authorities,
            acceptedFiles,
          );
          baseTools = [...baseTools, ...registered.toolAllowlist];
        }
        if (snapshot.payload.tools.kind === 'local-tools') {
          const local = workspaces.resolve(binding, grant);
          const adoptedLocal = await adoptNativeRunLocalTools(agentCtx, binding, grant, {
            composition: snapshot,
            producer: local.tools,
            workspace: local.workspace,
          });
          if (
            canonicalPayload(adoptedLocal.toolAllowlist) !==
            canonicalPayload(snapshot.payload.toolAllowlist)
          )
            throw new NativeWorkError('configuration-mismatch');
          baseTools = [
            ...snapshot.payload.tools.definitions.map((tool) => tool.name),
            ...baseTools,
          ];
        }
        if (snapshot.schemaVersion === 2 && snapshot.payload.outputFilePublisherTool) {
          resultProtocol();
          if (!outputs) throw new NativeWorkError('configuration-mismatch');
          const registered = outputs.registerNativeOutputFileTool(agentCtx, binding, grant);
          baseTools = [...baseTools, ...registered.toolAllowlist];
        }
        if (snapshot.schemaVersion === 2 && snapshot.payload.resultIntentTool) {
          const protocol = frozenHostResultProtocol(snapshot);
          if (
            !results ||
            !protocol ||
            (protocol === 2 && !publications) ||
            snapshot.payload.handoff.assignee.kind !== 'expert'
          )
            throw new NativeWorkError('configuration-mismatch');
          const registered = results.registerNativeResultTool(agentCtx, binding, grant);
          baseTools = [...baseTools, ...registered.toolAllowlist];
        }
        state.stopResources?.();
        await state.resourceAdoption?.dispose();
        const producer = await resources.producer(
          state.request,
          snapshot,
          binding,
          grant,
          authorities,
        );
        assertAdmission(state);
        const adopted = await registerExecutionRunResources(
          agentCtx,
          snapshot,
          binding,
          grant,
          producer,
        );
        state.resourceAdoption = adopted;
        await adopted.ready;
        assertAdmission(state);
        if (
          canonicalPayload([...baseTools, ...adopted.toolAllowlist]) !==
          canonicalPayload(snapshot.payload.toolAllowlist)
        )
          throw new NativeWorkError('configuration-mismatch');
        const revokeResources = () => {
          if (!fenced) scheduleResultOrRetirement(state);
        };
        adopted.signal.addEventListener('abort', revokeResources, { once: true });
        state.stopResources = () => adopted.signal.removeEventListener('abort', revokeResources);
        state.observation?.close();
        state.observation = observeHostNativeRun(agentCtx, binding, grant);
        state.stopObservation = state.observation.onClaim((claim) => {
          void accept(state, claim).catch(() => undefined);
        });
        state.stopFault = state.observation.onFault(() => {
          if (!fenced) scheduleResultOrRetirement(state);
        });
        // Use the stored composition exactly; registration must not append a second catalog.
        return { context: snapshot.payload.context, toolAllowlist: snapshot.payload.toolAllowlist };
      },
    },
    reviews.reviewPorts,
  ).catch(async (error: unknown) => {
    reviews.fence();
    // No native handle was published, so no Run could have been admitted.
    await workspaces.close();
    await workspaceApprovals.close();
    await backendOwner?.dispose();
    throw error;
  });
  if (options.signal.aborted) {
    await native.close();
    await workspaces.close();
    await workspaceApprovals.close();
    await backendOwner?.dispose();
    throw new DOMException('Host closed during native publication', 'AbortError');
  }
  try {
    retirementDrains = createHostRunRetirements(native.service, lifetime.signal);
    authorities = execution.installRunHost(
      createHostRunSources(ctx, {
        directory: options.directory,
        configuration,
        native: native.service,
        signal: lifetime.signal,
        resources,
        workspaces,
        retirementDrain: (scope) => retirementDrains?.read(scope),
        ...(options.teamAssets ? { teamAssets: options.teamAssets } : {}),
        ...(options.prepareProjectKnowledge
          ? { prepareProjectKnowledge: options.prepareProjectKnowledge }
          : {}),
      }),
    );
    if (resultProtocol() === 2) {
      acceptedFiles = execution.createRunAcceptedFiles(authorities, {
        signal: lifetime.signal,
        assertCurrent(attachments) {
          resultProtocol();
          if (original(attachments) !== attachmentBackend)
            throw new ExecutionRunError('run-authority-unavailable');
          return undefined;
        },
      });
      outputs = createNativeOutputFileIssuer(
        ctx,
        native.service,
        authorities,
        execution,
        workspaces.output,
      );
      publications = createNativeFixedResultPublicationsIssuer(
        ctx,
        native.service,
        native.runtime,
        authorities,
        execution,
        outputs,
      );
      results = publications.v1Issuer;
    } else {
      results = createNativeFixedResultIssuer(
        ctx,
        native.service,
        native.runtime,
        authorities,
        execution,
      );
    }
    execution.installNativeResultIssuer(results, publications);
    if (!options.remoteOnly) reviews.bindNative(native.service, native.runtime);
    workflow = createHostWorkflowOwner(ctx, {
      execution,
      remoteOnly: options.remoteOnly === true,
      runs: {
        beginWorkflowRun,
        stop: (original, payload, wait) => operations.stop(original, payload, wait),
      },
      signal: lifetime.signal,
      workspaces,
      readWorkbench: options.readWorkbench,
      prepareResume: recoverWorkflowDrains,
      consumeClaim: (original, claim) => reviews.consumeClaim(original, claim),
    });
  } catch (error) {
    workflow?.fence();
    reviews.fence();
    const reviewClose = await reviews.closeBeforeNative();
    if (reviewClose.status !== 'settled') throw new NativeWorkError('unavailable');
    await outputs?.close();
    await results?.close();
    await native.close();
    await workspaces.close();
    await workspaceApprovals.close();
    await backendOwner?.dispose();
    await workflow?.close();
    throw error;
  }
  const stopResultReady = results.onReady((grant, ref) => {
    const state = owned.get(nativeScopeKey(grant.scope));
    if (!fenced && state?.opened?.grant === grant) scheduleResultOrRetirement(state, ref);
  });
  const reader = createHostRunReader(
    execution,
    authorities,
    native.service,
    readSendCapabilities,
    (scope) => owned.get(nativeScopeKey(scope))?.resultPending,
  );

  async function readSendCapabilities(
    request: MemberRequest,
    locator: ExecutionRunLocator,
    wait?: AbortSignal,
  ): Promise<HostRunSendCapabilities> {
    let opened: OpenedExecutionRunAuthority | undefined;
    const all = (capability: HostRunModeCapability): HostRunSendCapabilities => ({
      followup: capability,
      steer: capability,
      queue: capability,
    });
    try {
      if (options.remoteOnly) return all({ kind: 'unavailable', code: 'not-permitted' });
      wait?.throwIfAborted();
      opened = await authorities.open(request, locator, 'drive');
      wait?.throwIfAborted();
      const node = execution.readRunNode(locator);
      const run = node && currentExecutionRun(node);
      if (!run || run.attempt.stopPhase !== 'none')
        return all({ kind: 'unavailable', code: 'stopping' });
      configuration.assertModel(execution.readRunComposition(locator));
      const view = native.service.open(opened.grant);
      if (view?.binding.resultIntent)
        return all({ kind: 'unavailable', code: 'completion-pending' });
      if (!view || view.status === 'detached')
        return all({ kind: 'unavailable', code: 'detached' });
      const receipt = view.binding.receipts.find(
        (item) => item.requestId === run.attempt.idempotencyKey,
      );
      if (
        !receipt ||
        receipt.fingerprint !== run.attempt.payloadHash ||
        !['received', 'claimed'].includes(receipt.status)
      )
        return all({ kind: 'unavailable', code: 'dispatch-unconfirmed' });
      authorities.assertGrant(opened.grant, 'send');
      // This owner is the actual C DSH runtime: followup wakes next-turn,
      // queue parks next-turn, and its steer branch requires a running Agent.
      return {
        followup: { kind: 'available' },
        queue: { kind: 'available' },
        steer:
          view.status === 'running'
            ? { kind: 'available' }
            : { kind: 'unavailable', code: 'not-running' },
      };
    } catch (error) {
      if (wait?.aborted) throw error;
      return all(
        error instanceof ExecutionRunError && error.code === 'run-authority-denied'
          ? { kind: 'unavailable', code: 'not-permitted' }
          : { kind: 'unknown', code: 'unavailable' },
      );
    } finally {
      opened?.dispose();
    }
  }

  function track<T>(work: Promise<T>, into: Set<Promise<unknown>>): Promise<T> {
    into.add(work);
    void work.finally(() => into.delete(work)).catch(() => undefined);
    return work;
  }
  function active() {
    if (fenced || lifetime.signal.aborted) throw new ExecutionRunError('run-authority-unavailable');
  }
  function assertAdmission(state: OwnedRun) {
    const entry = admissions.get(nativeScopeKey(state.scope));
    if (!entry) return;
    if (entry.state !== state) throw new ExecutionRunError('run-scope-mismatch');
    entry.wait?.throwIfAborted();
    entry.ticket.check();
    const location = entry.ticket.location;
    const reservation = entry.ticket.reservation;
    if (
      location.taskId !== state.scope.taskId ||
      location.planId !== state.scope.planId ||
      location.revision !== state.scope.revision ||
      location.spaceId !== state.scope.spaceId ||
      reservation.nodeId !== state.scope.nodeId ||
      reservation.newRunId !== state.scope.runId ||
      reservation.newSegmentId !== state.scope.segmentId
    )
      throw new ExecutionRunError('run-scope-mismatch');
  }
  function current(state: OwnedRun) {
    const node = execution.readRunNode(state.scope);
    const run =
      node &&
      readExecutionRunState(node)?.runs.find((item) => item.attempt.id === state.scope.runId);
    if (!node || !run) throw new ExecutionRunError('run-state-invalid');
    return { node, run };
  }
  function release(state: OwnedRun) {
    state.stopResources?.();
    state.stopRevocation?.();
    state.stopObservation?.();
    state.stopFault?.();
    state.observation?.close();
    state.opened?.dispose();
    owned.delete(nativeScopeKey(state.scope));
  }
  function scheduleResultOrRetirement(state: OwnedRun, ref?: NativeFixedResultRef): void {
    if (fenced || owned.get(nativeScopeKey(state.scope)) !== state) return;
    if (ref) state.resultRef = ref;
    state.resultAgain = true;
    if (state.resultWork) return;
    // Never wait on the C drain from an Agent disposal/resource callback stack.
    const work = (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      do {
        state.resultAgain = false;
        await state.dispatching;
        await state.accepting;
        if (fenced || owned.get(nativeScopeKey(state.scope)) !== state) return;
        const grant = state.opened?.grant;
        const { node, run } = current(state);
        if (run.resultDelivery) {
          await confirmResult(state);
          release(state);
          return;
        }
        const binding =
          grant && !grant.signal.aborted ? native.service.open(grant)?.binding : undefined;
        const snapshot = run.composition;
        const intent = binding?.resultIntent;
        if (
          !results ||
          !grant ||
          !intent ||
          node.handoff.assignee.kind !== 'expert' ||
          !snapshot ||
          !frozenHostResultProtocol(snapshot) ||
          intent.protocolVersion !== frozenHostResultProtocol(snapshot)
        ) {
          await retire(state);
          return;
        }
        const prepared = state.resultRef
          ? { status: 'ready' as const, ref: state.resultRef }
          : await results.prepareFixedResult(grant, lifetime.signal);
        if (prepared.status === 'pending') {
          // No completion is inferred. The original onReady owns any late fact;
          // Stop remains the bounded escape while the original drain is pending.
          state.resultPending = prepared.reason === 'draining' ? 'draining' : 'not-durable';
          continue;
        }
        state.resultRef = prepared.ref;
        await state.resourceAdoption?.drain();
        const fresh = current(state);
        const key = `native-result:${createHash('sha256')
          .update(
            canonicalPayload({
              scope: state.scope,
              configurationId: binding.selection.configurationId,
              intentId: intent.intentId,
            }),
          )
          .digest('hex')}`;
        if (!state.resultCommand || state.resultCommand.idempotencyKey !== key)
          state.resultCommand = Object.freeze({
            ...locatorFor(state.scope),
            generation: state.scope.generation,
            segmentId: state.scope.segmentId,
            configurationId: binding.selection.configurationId,
            expectedNodeVersion: fresh.node.command.version,
            expectedRunVersion: readExecutionRunState(fresh.node)!.version,
            idempotencyKey: key,
          });
        // Host lifetime outlives a successful terminal put's revoked drive grant.
        const submitted = await execution.submitNativeFixedResult(
          state.request,
          state.resultCommand,
          grant,
          prepared.ref,
          lifetime.signal,
        );
        if (submitted.ok || current(state).run.resultDelivery) {
          if (!submitted.ok) await confirmResult(state);
          // Business settlement is not itself a scope-drain certificate.
          // Retain the original C cleanup proof before releasing this owner.
          await retire(state);
          return;
        }
        state.resultPending = 'delivery-unconfirmed';
      } while (state.resultAgain);
    })();
    const guarded = work
      .catch(async () => {
        if (!fenced && owned.get(nativeScopeKey(state.scope)) === state) {
          if (current(state).run.resultDelivery) {
            await confirmResult(state);
            await retire(state);
          } else await retire(state);
        }
      })
      .finally(() => {
        delete state.resultWork;
        if (state.resultAgain && !fenced) scheduleResultOrRetirement(state);
      });
    state.resultWork = guarded;
    track(guarded, commands);
    void guarded.catch((error) => {
      state.resultPending = 'delivery-unconfirmed';
      state.resultFailure = error;
    });
  }
  async function confirmResult(state: OwnedRun) {
    const { run } = current(state);
    const delivered = run.resultDelivery;
    if (!delivered) throw new ExecutionRunError('run-state-invalid');
    const result = await execution.confirmNativeResultDelivery(
      state.request,
      {
        ...locatorFor(state.scope),
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        configurationId: run.selection.configurationId,
        idempotencyKey: delivered.receiptKey,
        intentId: delivered.source.intentId,
        digest: delivered.digest,
        provenanceFingerprint: delivered.provenanceFingerprint,
        ...(delivered.protocolVersion === 2
          ? { protocolVersion: 2, manifestDigest: delivered.manifestDigest }
          : {}),
      },
      lifetime.signal,
    );
    if (!result.ok) throw new ExecutionRunError('run-authority-denied');
    return result.value;
  }
  function retain(decision: ExecutionRunDecision, request: MemberRequest): OwnedRun {
    const scope = executionRunScope(decision.record, decision.run);
    const key = nativeScopeKey(scope);
    const existing = owned.get(key);
    if (existing) return existing;
    // Acquire synchronously, before the next awaited member/drive lookup.
    const cleanup = authorities.cleanupAfterCommit(locatorFor(scope));
    const state: OwnedRun = {
      scope,
      cleanup,
      request,
      sequence: decision.run.attempt.lastEventSequence,
    };
    owned.set(key, state);
    return state;
  }
  function append(state: OwnedRun, body: EventBody, authority: RunEventAuthority): Promise<void> {
    const latest = current(state).run;
    state.sequence = Math.max(state.sequence, latest.attempt.lastEventSequence) + 1;
    const work = execution
      .recordRunEvent(
        state.scope,
        {
          ...body,
          runId: state.scope.runId,
          generation: state.scope.generation,
          segmentId: state.scope.segmentId,
          sequence: state.sequence,
        },
        authority,
      )
      .then((result) => {
        if (!result.ok) throw new ExecutionRunError('run-effect-unknown');
      });
    return track(work, events);
  }
  async function accept(state: OwnedRun, claim: HostNativeClaim): Promise<void> {
    if (
      fenced ||
      !state.opened ||
      state.firstMessageId !== claim.messageId ||
      state.nativeSessionId !== claim.nativeSessionId ||
      state.nativeAgentId !== claim.nativeAgentId ||
      current(state).run.attempt.acknowledged
    )
      return;
    if (state.accepting) return state.accepting;
    const work = append(
      state,
      {
        kind: 'accepted',
        nativeSessionId: claim.nativeSessionId,
        executorRunId: claim.nativeAgentId,
      },
      { grant: state.opened.grant },
    );
    state.accepting = work;
    try {
      await work;
    } finally {
      delete state.accepting;
    }
  }
  async function recoverWorkflowDrains(
    request: MemberRequest,
    view: WorkflowExecutionView,
    wait?: AbortSignal,
  ) {
    const intent = view.intent;
    if (!intent) throw new ExecutionWorkflowError('workflow-not-found');
    const lease = await openExecutionMemberLease(ctx, request);
    const fixed = canonicalPayload(intent);
    let bound: ReturnType<typeof hostWorkflowRecoveryBinding>[] = [];
    const check = () => {
      active();
      wait?.throwIfAborted();
      lease.assertCurrent(view.location.spaceId);
      if (lease.memberId !== intent.actorId)
        throw new ExecutionWorkflowError('workflow-authority-denied');
      for (let index = 0; index < bound.length; index++) {
        const original = bound[index]!;
        const reservation = intent.starts[index]!;
        const latest = hostWorkflowRecoveryBinding(
          execution.readRunNode(original.scope),
          reservation,
          view.location,
          intent.actorId,
        );
        if (latest.control !== original.control)
          throw new ExecutionWorkflowError('workflow-conflict');
      }
    };
    const fresh = async () => {
      check();
      const current = await execution.readWorkflowExecution(request, view.location);
      check();
      if (!current.ok || canonicalPayload(current.value.intent) !== fixed)
        throw new ExecutionWorkflowError('workflow-conflict');
      for (const original of bound) {
        const allowed = await execution.readRunCompositionInputs(request, {
          ...view.location,
          nodeId: original.scope.nodeId,
        });
        check();
        if (!allowed.ok || allowed.value.actorId !== intent.actorId)
          throw new ExecutionWorkflowError('workflow-authority-denied');
      }
    };
    try {
      await fresh();
      // Resolve only original receipts. A settled historical reservation needs
      // D's dedicated cleanup capability, never the current Run's authority.
      bound = intent.starts.map((reservation) =>
        hostWorkflowRecoveryBinding(
          execution.readRunNode({ ...view.location, nodeId: reservation.nodeId }),
          reservation,
          view.location,
          intent.actorId,
        ),
      );
      const reviewScopes = (view.reviewResources ?? []).map((resource) => {
        const scope = resource.scope;
        const node = execution.readRunNode(scope);
        const attempt =
          node &&
          readExecutionReviewState(node)?.attempts.find((item) => item.scope.runId === scope.runId);
        if (
          scope.actorId !== intent.actorId ||
          scope.spaceId !== view.location.spaceId ||
          scope.taskId !== view.location.taskId ||
          scope.planId !== view.location.planId ||
          scope.revision !== view.location.revision ||
          !attempt ||
          attempt.status === 'prepared' ||
          canonicalPayload(attempt.scope) !== canonicalPayload(scope) ||
          (attempt.stopPhase !== 'requested' &&
            !['completed', 'failed', 'cancelled'].includes(attempt.status))
        )
          throw new ExecutionWorkflowError('workflow-recovery-required');
        return scope;
      });
      for (const { scope, run, currentRunId } of bound) {
        await fresh();
        if (retirementDrains?.read(scope)) continue;
        const cleanup =
          currentRunId === scope.runId
            ? authorities.cleanupAfterSettlement(locatorFor(scope))
            : authorities.cleanupSettledHistoricalReservation(locatorFor(scope), currentRunId);
        if (nativeScopeKey(cleanup.scope) !== nativeScopeKey(scope))
          throw new ExecutionWorkflowError('workflow-recovery-required');
        const assertCleanup = () => {
          check();
          authorities.assertCleanup(cleanup, 'cleanup');
          return undefined;
        };
        const result = await native.service.retireForCleanup(
          { scope, assertCurrent: assertCleanup },
          AbortSignal.any([lifetime.signal, lease.signal, ...(wait ? [wait] : [])]),
        );
        assertCleanup();
        if (
          result.status !== 'retired' ||
          !result.binding ||
          nativeScopeKey(result.binding.scope) !== nativeScopeKey(scope) ||
          result.binding.nativeSessionId !== run.attempt.sessionId ||
          result.binding.nativeAgentId !== run.attempt.executorRunId ||
          result.drain.basis !== 'flushed-and-closed'
        )
          throw new ExecutionWorkflowError('workflow-recovery-required');
        result.drain.assertCurrent();
        await owned.get(nativeScopeKey(scope))?.resourceAdoption?.drain();
        await fresh();
        assertCleanup();
        result.drain.assertCurrent();
        retirementDrains?.remember(scope, result);
      }
      for (const scope of reviewScopes) {
        await fresh();
        const outcome = await reviews.recoverStopped(
          scope,
          AbortSignal.any([lifetime.signal, lease.signal, ...(wait ? [wait] : [])]),
        );
        check();
        if (!outcome.ok || outcome.value.status !== 'settled')
          throw new ExecutionWorkflowError('workflow-recovery-required');
        execution.assertExpertReviewDrained(scope);
      }
      await fresh();
    } finally {
      lease.release();
    }
  }
  async function settle(state: OwnedRun): Promise<void> {
    await state.resourceAdoption?.drain();
    const { run } = current(state);
    if (run.resources === 'settled') return;
    const authority = { cleanup: state.cleanup };
    if (isTerminalRunStatus(run.attempt.status))
      await append(
        state,
        { kind: 'cleanup', idle: true, flushed: true, resourcesSettled: true },
        authority,
      );
    else if (run.attempt.stopPhase === 'requested')
      await append(
        state,
        { kind: 'stopped', idle: true, flushed: true, resourcesSettled: true },
        authority,
      );
    else await append(state, { kind: 'failed', resourcesSettled: true }, authority);
  }
  function retire(state: OwnedRun): Promise<'pending' | 'retired'> {
    if (state.retirement) return state.retirement;
    const work = (async () => {
      const result = await native.service.retireForCleanup(
        {
          scope: state.cleanup.scope,
          assertCurrent() {
            authorities.assertCleanup(state.cleanup, 'cleanup');
            return undefined;
          },
        },
        new AbortController().signal,
      );
      if (result.status === 'pending') return 'pending' as const;
      result.drain.assertCurrent();
      await settle(state);
      if (!fenced && !lifetime.signal.aborted) retirementDrains?.remember(state.scope, result);
      const latest = current(state).run;
      if (
        result.binding === undefined &&
        result.drain.basis === 'absent-unadmitted' &&
        latest.attempt.status === 'failed' &&
        !latest.attempt.acknowledged &&
        latest.attempt.sessionId === undefined &&
        latest.attempt.executorRunId === undefined &&
        absentRetirements.size < 256
      )
        absentRetirements.set(nativeScopeKey(state.scope), {
          owner: native.service,
          scope: state.scope,
          result,
        });
      release(state);
      return 'retired' as const;
    })();
    state.retirement = work;
    void work
      .finally(() => {
        delete state.retirement;
      })
      .catch(() => undefined);
    return track(work, commands);
  }
  async function dispatch(
    state: OwnedRun,
    previousScope?: NativeWorkScope,
  ): Promise<'received' | 'unknown'> {
    assertNativeDrive();
    try {
      assertAdmission(state);
      let absent = previousScope && absentRetirements.get(nativeScopeKey(previousScope));
      const opened = await authorities.open(state.request, locatorFor(state.scope), 'drive');
      state.opened = opened;
      try {
        assertAdmission(state);
      } catch (error) {
        opened.dispose();
        throw error;
      }
      const revoked = () => {
        if (!fenced) {
          if (current(state).run.resultDelivery) release(state);
          else scheduleResultOrRetirement(state);
        }
      };
      opened.grant.signal.addEventListener('abort', revoked, { once: true });
      state.stopRevocation = () => opened.grant.signal.removeEventListener('abort', revoked);
      if (opened.grant.signal.aborted) throw new ExecutionRunError('run-authority-denied');
      if (previousScope && !absent) {
        const snapshot = execution.readRunComposition(locatorFor(state.scope));
        const first = executionRunCompositionRequest(snapshot);
        absent = await retireHostUnadmittedScope(
          native.service,
          authorities,
          lifetime.signal,
          opened.grant,
          previousScope,
          {
            scope: state.scope,
            requestId: current(state).run.attempt.idempotencyKey,
            inputFingerprint: first.inputFingerprint,
            selection: first.selection,
          },
        );
      }
      if (previousScope && !absent) {
        const migration = await authorities.openMigration(state.request, locatorFor(state.scope));
        try {
          authorities.assertMigration(migration.grant, 'prepare');
          const prepared = await native.service.prepareMigration(migration.grant);
          if (prepared.status !== 'prepared') throw new ExecutionRunError('run-migration-pending');
          authorities.assertMigration(migration.grant, 'migrate');
          const migrated = await native.service.migrate(migration.grant);
          if (migrated.status === 'pending') throw new ExecutionRunError('run-migration-pending');
        } finally {
          migration.dispose();
        }
      }
      if (previousScope && absent) {
        authorities.assertGrant(opened.grant, 'send');
        const node = execution.readRunNode(previousScope);
        if (!node) throw new ExecutionRunError('run-recovery-unavailable');
        assertHostAbsentRetry(
          absent,
          native.service,
          lifetime.signal,
          previousScope,
          node,
          opened.grant,
        );
      }
      const snapshot = execution.readRunComposition(locatorFor(state.scope));
      const first = executionRunCompositionRequest(snapshot);
      const { run } = current(state);
      assertAdmission(state);
      const receipt = await native.service.send(opened.grant, {
        requestId: run.attempt.idempotencyKey,
        text: first.firstMessage.text,
        mode: first.firstMessage.mode,
        selection: first.selection,
      });
      const observation = native.service.open(opened.grant);
      if (!observation || receipt.fingerprint !== first.inputFingerprint)
        throw new NativeWorkError('delivery-unknown');
      state.firstMessageId = receipt.messageId;
      state.nativeSessionId = observation.binding.nativeSessionId;
      state.nativeAgentId = observation.binding.nativeAgentId;
      if (!['received', 'claimed'].includes(receipt.status))
        throw new NativeWorkError('delivery-unknown');
      if (previousScope && absent) absentRetirements.delete(nativeScopeKey(previousScope));
      await append(
        state,
        { kind: 'received', nativeSessionId: state.nativeSessionId },
        { grant: opened.grant },
      );
      const claim = state.observation?.claimFor(receipt.messageId);
      if (claim) await accept(state, claim);
      return 'received';
    } catch {
      // An error may follow native admission. It never proves absence or releases a claim.
      if (state.opened && !state.opened.grant.signal.aborted) {
        try {
          await append(state, { kind: 'dispatch-unknown' }, { grant: state.opened.grant });
        } catch {
          /* Retain unknown/held when a current event cannot be committed. */
        }
      }
      if (!fenced) void retire(state).catch(() => undefined);
      return 'unknown';
    }
  }
  function command<T>(operation: () => Promise<T>): Promise<T> {
    active();
    if (commands.size >= 256) throw new ExecutionRunError('run-capacity');
    return track(Promise.resolve().then(operation), commands);
  }
  async function recoverRevisionStartDrain(
    request: MemberRequest,
    input: BeginRunRequest,
    wait?: AbortSignal,
  ): Promise<void> {
    const initial = execution.readRunNode(input);
    if (
      input.mode !== 'begin' ||
      !initial ||
      readExecutionRunState(initial)?.receipts.some((item) => item.requestId === input.requestId) ||
      !isExecutionRunRevisionStart(initial)
    )
      return;
    const previous = currentExecutionRun(initial)!;
    const scope = executionRunScope(initial, previous);
    const fixed = canonicalPayload(initial);
    const lease = await openExecutionMemberLease(ctx, request);
    const check = () => {
      active();
      wait?.throwIfAborted();
      lease.assertCurrent(input.spaceId);
      const node = execution.readRunNode(input);
      if (
        lease.memberId !== scope.actorId ||
        input.spaceId !== scope.spaceId ||
        !node ||
        canonicalPayload(node) !== fixed ||
        !isExecutionRunRevisionStart(node) ||
        input.expectedNodeVersion !== node.command.version ||
        input.expectedRunVersion !== readExecutionRunState(node)?.version ||
        input.composition.schemaVersion !== 2 ||
        input.composition.payload.returnedRevision?.roundId !== node.currentRoundId ||
        input.composition.payload.returnedRevision?.artifactVersionId !==
          node.artifactVersions.at(-1)?.id ||
        previous.dispatch !== 'received' ||
        !previous.attempt.acknowledged ||
        !previous.attempt.sessionId ||
        !previous.attempt.executorRunId
      )
        throw new ExecutionRunError('run-recovery-unavailable');
      configuration.assertConfiguration(lease.memberId, input.spaceId, node, input);
    };
    const fresh = async () => {
      check();
      const visible = await execution.readRunCompositionInputs(request, {
        spaceId: input.spaceId,
        taskId: input.taskId,
        planId: input.planId,
        revision: input.revision,
        nodeId: input.nodeId,
      });
      check();
      if (!visible.ok || visible.value.actorId !== lease.memberId)
        throw new ExecutionRunError('run-authority-denied');
    };
    try {
      await fresh();
      if (!retirementDrains) throw new ExecutionRunError('run-authority-unavailable');
      if (retirementDrains.read(scope)) return;
      const cleanup = authorities.cleanupAfterSettlement(locatorFor(scope));
      if (nativeScopeKey(cleanup.scope) !== nativeScopeKey(scope))
        throw new ExecutionRunError('run-recovery-unavailable');
      const result = await retireHostSettledScope(
        native.service,
        {
          scope,
          assertCurrent() {
            check();
            authorities.assertCleanup(cleanup, 'cleanup');
          },
        },
        {
          nativeSessionId: previous.attempt.sessionId!,
          nativeAgentId: previous.attempt.executorRunId!,
        },
        AbortSignal.any([lifetime.signal, lease.signal, ...(wait ? [wait] : [])]),
        fresh,
        async () => {
          await owned.get(nativeScopeKey(scope))?.resourceAdoption?.drain();
        },
      );
      check();
      retirementDrains.remember(scope, result);
    } finally {
      lease.release();
    }
  }
  function startNativeRun(
    request: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
    ticket?: WorkflowStartTicket,
  ): Promise<ExecutionResult<unknown>> {
    return command(async () => {
      assertNativeDrive();
      wait?.throwIfAborted();
      if (owned.size + beginning >= 256) throw new ExecutionRunError('run-capacity');
      beginning++;
      try {
        const input = ticket
          ? await configuration.prepareWorkflow(request, ticket, wait)
          : await configuration.prepare(request, payload);
        if (!ticket) await recoverRevisionStartDrain(request, input, wait);
        ticket?.check();
        active();
        // This performs the original owner's pre/post-marker checks and whole-node put.
        const committed = await execution.startRun(request, input, ticket);
        if (!committed.ok) return committed;
        const decision = committed.value;
        if (decision.effect?.kind === 'dispatch') {
          const state = retain(decision, request);
          const admissionKey = nativeScopeKey(state.scope);
          const admission: WorkflowAdmission | undefined = ticket
            ? { state, ticket, ...(wait ? { wait } : {}) }
            : undefined;
          if (admission) {
            // The same full-scope effect is already owned. Preserve its entry
            // and do not dispatch again or discard the committed reservation.
            if (admissions.has(admissionKey))
              return {
                ok: true,
                value: {
                  disposition: decision.disposition,
                  ...locatorFor(state.scope),
                  generation: state.scope.generation,
                  segmentId: state.scope.segmentId,
                  dispatch: 'unknown',
                },
              };
            admissions.set(admissionKey, admission);
          }
          const admissionSignal = ticket
            ? wait
              ? AbortSignal.any([ticket.signal, wait])
              : ticket.signal
            : undefined;
          // Only the pending admission is requalified. Once dispatch returns,
          // removing this hook lets the original Run outlive permit disposal.
          const recheckAdmission = () => {
            if (!admission || admissions.get(admissionKey) !== admission) return;
            const opened = state.opened;
            if (opened && nativeScopeKey(opened.grant.scope) === admissionKey) opened.dispose();
          };
          admissionSignal?.addEventListener('abort', recheckAdmission, { once: true });
          let dispatchStatus: 'received' | 'unknown';
          try {
            const dispatching = dispatch(state, decision.effect.previousScope);
            state.dispatching = dispatching;
            dispatchStatus = await dispatching;
          } finally {
            admissionSignal?.removeEventListener('abort', recheckAdmission);
            delete state.dispatching;
            if (admissions.get(admissionKey) === admission) admissions.delete(admissionKey);
          }
          return {
            ok: true,
            value: {
              disposition: decision.disposition,
              ...locatorFor(state.scope),
              generation: state.scope.generation,
              segmentId: state.scope.segmentId,
              dispatch: dispatchStatus,
            },
          };
        }
        // A lost reply/cold replay returns the original owner's current
        // durable facts in the same shape; no native resume or resend.
        const scope = executionRunScope(decision.record, decision.run);
        return {
          ok: true,
          value: {
            disposition: decision.disposition,
            ...locatorFor(scope),
            generation: scope.generation,
            segmentId: scope.segmentId,
            dispatch: decision.run.dispatch,
          },
        };
      } finally {
        beginning--;
      }
    });
  }
  async function beginWorkflowRun(
    request: MemberRequest,
    ticket: WorkflowStartTicket,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>> {
    try {
      return await startNativeRun(request, undefined, wait, ticket);
    } catch (error) {
      if (error instanceof ExecutionRunError || error instanceof ExecutionWorkflowError)
        return {
          ok: false,
          error: { code: error.code, message: '工作流节点未能开始。', details: {} },
        };
      throw error;
    }
  }
  const operations: HostRunOperations = {
    options(request, payload, wait) {
      return command(async () => {
        const result = await readOptions(request, payload, wait);
        return options.remoteOnly
          ? {
              ...result,
              value: {
                ...result.value,
                start: {
                  kind: 'unavailable' as const,
                  message: '请在成员设备的 Zhuma 中开始执行。',
                },
              },
            }
          : result;
      });
    },
    begin(request, payload, wait) {
      return startNativeRun(request, payload, wait);
    },
    send(request, payload, wait) {
      return command(async () => {
        assertNativeDrive();
        wait?.throwIfAborted();
        const parsed = sendRequest.safeParse(payload);
        if (!parsed.success) throw new ExecutionRunError('run-validation');
        const { generation, segmentId, requestId, text, mode, ...locator } = parsed.data;
        const opened = await authorities.open(request, locator, 'drive');
        try {
          if (
            opened.grant.scope.generation !== generation ||
            opened.grant.scope.segmentId !== segmentId
          )
            throw new ExecutionRunError('run-scope-mismatch');
          const snapshot = execution.readRunComposition(locator);
          configuration.assertModel(snapshot);
          const first = executionRunCompositionRequest(snapshot);
          const node = execution.readRunNode(locator);
          const run = node && currentExecutionRun(node);
          const nativeView = native.service.open(opened.grant);
          const binding = nativeView?.binding;
          const receipt = binding?.receipts.find(
            (item) => item.requestId === run?.attempt.idempotencyKey,
          );
          if (
            !binding ||
            nativeView?.status === 'detached' ||
            !receipt ||
            !['received', 'claimed'].includes(receipt.status)
          )
            throw new NativeWorkError('delivery-unknown');
          const sent = await native.service.send(opened.grant, {
            requestId,
            text,
            mode,
            selection: first.selection,
          });
          return {
            ok: true,
            value: {
              ...locator,
              generation,
              segmentId,
              requestId: sent.requestId,
              messageId: sent.messageId,
              status: sent.status,
              mode: sent.mode,
            },
          };
        } finally {
          opened.dispose();
        }
      });
    },
    stop(request, payload, wait) {
      return command(async () => {
        wait?.throwIfAborted();
        const committed = await execution.stopRun(request, payload);
        if (!committed.ok) return committed;
        const decision = committed.value;
        if (decision.effect?.kind !== 'stop') {
          const scope = executionRunScope(decision.record, decision.run);
          return {
            ok: true,
            value: {
              ...locatorFor(scope),
              status:
                decision.run.resources === 'settled' &&
                decision.run.attempt.stopPhase === 'confirmed'
                  ? 'stopped'
                  : 'pending',
            },
          };
        }
        const state = retain(decision, request);
        const status = await retire(state);
        return {
          ok: true,
          value: {
            ...locatorFor(state.scope),
            status: status === 'retired' ? 'stopped' : 'pending',
          },
        };
      });
    },
    read(request, payload, wait) {
      return command(() =>
        reader.read(
          request,
          payload,
          wait ? AbortSignal.any([wait, lifetime.signal]) : lifetime.signal,
        ),
      );
    },
    inbox(request, payload, wait) {
      return command(() =>
        reader.inbox(
          request,
          payload,
          wait ? AbortSignal.any([wait, lifetime.signal]) : lifetime.signal,
        ),
      );
    },
    observe(request, payload, sink, wait) {
      return command(() =>
        reader.observe(
          request,
          payload,
          sink,
          wait ? AbortSignal.any([wait, lifetime.signal]) : lifetime.signal,
        ),
      );
    },
    history(request, payload, wait) {
      return command(() => reader.history(request, payload, wait));
    },
  };

  const workflowOperations: HostWorkflowOperations = {
    options: (...args) => command(() => workflow!.operations.options(...args)),
    read: (...args) => command(() => workflow!.operations.read(...args)),
    start: (...args) => command(() => workflow!.operations.start(...args)),
    resume: (...args) => command(() => workflow!.operations.resume(...args)),
    stop: (...args) => command(() => workflow!.operations.stop(...args)),
  };

  return {
    lookupNativeSession: native.lookupNativeSession,
    canSwitchBackend() {
      if (
        fenced ||
        closing ||
        lifetime.signal.aborted ||
        beginning ||
        commands.size ||
        events.size ||
        admissions.size ||
        owned.size ||
        absentRetirements.size ||
        (reviews as typeof reviews & { canSwitchBackend?: () => boolean }).canSwitchBackend?.() !==
          true ||
        workflow?.canSwitchBackend() !== true
      )
        return false;
      try {
        for (const plan of options.readWorkbench().appliedPlans) {
          for (const node of createNodeHandoffs(plan)) {
            const record = execution.readRunNode({
              taskId: plan.taskId,
              planId: plan.id,
              revision: plan.revision,
              nodeId: node.nodeId,
            });
            if (
              record &&
              (readExecutionRunState(record)?.runs.some(
                (run) => run.resources !== 'settled' || !isTerminalRunStatus(run.attempt.status),
              ) ||
                readExecutionReviewState(record)?.attempts.some(
                  (attempt) =>
                    attempt.resources !== 'settled' ||
                    !['completed', 'failed', 'cancelled'].includes(attempt.status),
                ))
            )
              return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    memberLocalOptions(request: MemberRequest, payload: unknown, wait?: AbortSignal) {
      if (!options.remoteOnly) throw new ExecutionRunError('run-authority-denied');
      return command(() => readOptions(request, payload, wait));
    },
    memberLocalReviewOptions(request: MemberRequest, payload: unknown, wait?: AbortSignal) {
      if (!options.remoteOnly) throw new ExecutionRunError('run-authority-denied');
      return command(async () => {
        active();
        wait?.throwIfAborted();
        const query = localReviewOptionsQuerySchema.parse(payload);
        const result = await execution.readLocalReviewOptions(request, query);
        active();
        wait?.throwIfAborted();
        return result.ok
          ? { ok: true as const, value: localReviewOptionsSchema.parse(result.value) }
          : result;
      });
    },
    operations,
    beginWorkflowRun,
    workflowOperations,
    workspaceApprovalOperations: {
      options: (...args: Parameters<typeof workspaceApprovals.operations.options>) =>
        command(() => workspaceApprovals.operations.options(...args)),
      approve: (...args: Parameters<typeof workspaceApprovals.operations.approve>) =>
        command(() => workspaceApprovals.operations.approve(...args)),
      revoke: (...args: Parameters<typeof workspaceApprovals.operations.revoke>) =>
        command(() => workspaceApprovals.operations.revoke(...args)),
    },
    close(): Promise<void> {
      if (closing) return closing;
      let resolveClose!: () => void;
      let rejectClose!: (reason: unknown) => void;
      const closed = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      closing = closed;
      workflow?.fence();
      reviews.fence();
      fenced = true;
      stopResultReady();
      absentRetirements.clear();
      retirementDrains?.clear();
      admissions.clear();
      execution.fenceRuns();
      lifetime.abort();
      void (async () => {
        // The bridge owns in-flight review collection. Keep both the result
        // owner and unsealed C reads alive until its genuine cleanup is settled.
        try {
          if ((await reviews.closeBeforeNative()).status !== 'settled')
            throw new NativeWorkError('unavailable');
        } catch (error) {
          closing = undefined;
          throw error;
        }
        const failures: unknown[] = [];
        let drained = false;
        try {
          await outputs?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await results?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await native.close();
          drained = true;
        } catch (error) {
          failures.push(error);
        }
        // Native close interrupts admitted sends/reads; await their late completions
        // before cleanup, with D's original domain and cleanup capabilities still open.
        while (commands.size || events.size) await Promise.allSettled([...commands, ...events]);
        await workspaceApprovals.close();
        for (const state of [...owned.values()]) {
          if (state.resultFailure) failures.push(state.resultFailure);
          try {
            if (drained) {
              await settle(state);
            } else await state.resourceAdoption?.drain();
          } catch (error) {
            failures.push(error);
          }
          release(state);
        }
        if (drained && !failures.length) await workspaces.close();
        if (drained && !failures.length) await backendOwner?.dispose();
        try {
          await workflow?.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(failures, 'Native Run cleanup remains unconfirmed.');
      })().then(resolveClose, rejectClose);
      return closed;
    },
  };
}
