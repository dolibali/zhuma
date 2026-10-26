import type { Context } from '@deepseek-ai/cordis';
import { canonicalPayload, isTerminalRunStatus, type Workbench } from '@zhuma/agent-core';
import { z } from 'zod';
import { createHostRunConfiguration } from './host-run-configuration.js';
import { createHostRunOptions } from './host-run-options.js';
import { createHostRunSources } from './host-run-sources.js';
import {
  assertHostAbsentRetry,
  retireHostUnadmittedScope,
  type HostAbsentRetirement,
} from './host-run-recovery.js';
import {
  createHostRunReader,
  type HostRunModeCapability,
  type HostRunSendCapabilities,
} from './host-run-reader.js';
import { observeHostNativeRun, type HostNativeClaim } from './host-run-observation.js';
import type { HostRunOperations } from './host-run-http.js';
import type { ExecutionService, RunEventAuthority } from './execution-service.js';
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
  type ExecutionRunDecision,
  type ExecutionRunEvent,
} from './execution-run-state.js';
import {
  assertExecutionRunCompositionBinding,
  executionRunCompositionRequest,
} from './execution-run-composition.js';
import { openNativeWorkSessions } from './native-work-session-storage.js';
import { registerNativeAcceptedInputTool } from './native-work-session-input-tool.js';
import { NativeWorkError, type NativeWorkScope } from './native-work-session-contract.js';
import { nativeScopeKey } from './native-work-session-record.js';
import { resolveMember, type MemberRequest } from './member-session.js';

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
  firstMessageId?: string;
  nativeSessionId?: string;
  nativeAgentId?: string;
  accepting?: Promise<void>;
  retirement?: Promise<'pending' | 'retired'>;
}

/** One native owner consuming the already opened D execution owner. No new Run store/queue. */
export async function openHostRunOwner(
  ctx: Context,
  options: {
    readonly execution: ExecutionService;
    readonly directory: Parameters<typeof createHostRunSources>[1]['directory'];
    readonly signal: AbortSignal;
    readWorkbench(): Workbench;
  },
) {
  const execution = options.execution;
  const lifetime = new AbortController();
  const owned = new Map<string, OwnedRun>();
  const absentRetirements = new Map<string, HostAbsentRetirement>();
  const commands = new Set<Promise<unknown>>();
  const events = new Set<Promise<unknown>>();
  let beginning = 0;
  let authorities: ExecutionRunAuthorities;
  let fenced = false;
  let closing: Promise<void> | undefined;
  const configuration = createHostRunConfiguration(ctx, {
    execution,
    readWorkbench: options.readWorkbench,
    signal: lifetime.signal,
  });
  const readOptions = createHostRunOptions(ctx, {
    execution,
    readWorkbench: options.readWorkbench,
    signal: lifetime.signal,
  });
  const native = await openNativeWorkSessions(ctx, {
    workingDirectory(binding, grant) {
      authorities.assertGrant(grant, 'send');
      const node = execution.readRunNode(grant.scope);
      const run = node && currentExecutionRun(node);
      if (
        !run ||
        canonicalPayload(executionRunScope(node!, run)) !== canonicalPayload(binding.scope) ||
        run.workspace.kind !== 'text-only'
      )
        throw new ExecutionRunError('run-authority-denied');
      return { kind: 'text-only' };
    },
    async compose(agentCtx, binding, grant) {
      authorities.assertGrant(grant, 'send');
      const state = owned.get(nativeScopeKey(grant.scope));
      if (!state || state.opened?.grant !== grant)
        throw new ExecutionRunError('run-authority-denied');
      const snapshot = execution.readRunComposition(locatorFor(grant.scope));
      const projected = executionRunCompositionRequest(snapshot);
      assertExecutionRunCompositionBinding(snapshot, binding.scope, projected);
      if (canonicalPayload(binding.selection) !== canonicalPayload(projected.selection))
        throw new NativeWorkError('configuration-mismatch');
      configuration.assertModel(snapshot);
      if (snapshot.payload.tools.kind === 'accepted-input-reader') {
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
        if (
          canonicalPayload(registered.toolAllowlist) !==
          canonicalPayload(snapshot.payload.toolAllowlist)
        )
          throw new NativeWorkError('configuration-mismatch');
      }
      state.observation?.close();
      state.observation = observeHostNativeRun(agentCtx, binding, grant);
      state.stopObservation = state.observation.onClaim((claim) => {
        void accept(state, claim).catch(() => undefined);
      });
      state.stopFault = state.observation.onFault(() => {
        if (!fenced) void retire(state).catch(() => undefined);
      });
      // Use the stored composition exactly; registration must not append a second catalog.
      return { context: snapshot.payload.context, toolAllowlist: snapshot.payload.toolAllowlist };
    },
  });
  if (options.signal.aborted) {
    await native.close();
    throw new DOMException('Host closed during native publication', 'AbortError');
  }
  try {
    authorities = execution.installRunHost(
      createHostRunSources(ctx, {
        directory: options.directory,
        configuration,
        native: native.service,
        signal: lifetime.signal,
      }),
    );
  } catch (error) {
    await native.close();
    throw error;
  }
  const reader = createHostRunReader(execution, authorities, native.service, readSendCapabilities);

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
      wait?.throwIfAborted();
      opened = await authorities.open(request, locator, 'drive');
      wait?.throwIfAborted();
      const node = execution.readRunNode(locator);
      const run = node && currentExecutionRun(node);
      if (!run || run.attempt.stopPhase !== 'none')
        return all({ kind: 'unavailable', code: 'stopping' });
      configuration.assertModel(execution.readRunComposition(locator));
      const view = native.service.open(opened.grant);
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
  function current(state: OwnedRun) {
    const node = execution.readRunNode(state.scope);
    const run =
      node &&
      readExecutionRunState(node)?.runs.find((item) => item.attempt.id === state.scope.runId);
    if (!node || !run) throw new ExecutionRunError('run-state-invalid');
    return { node, run };
  }
  function release(state: OwnedRun) {
    state.stopRevocation?.();
    state.stopObservation?.();
    state.stopFault?.();
    state.observation?.close();
    state.opened?.dispose();
    owned.delete(nativeScopeKey(state.scope));
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
  async function settle(state: OwnedRun): Promise<void> {
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
    try {
      let absent = previousScope && absentRetirements.get(nativeScopeKey(previousScope));
      const opened = await authorities.open(state.request, locatorFor(state.scope), 'drive');
      state.opened = opened;
      const revoked = () => {
        if (!fenced) void retire(state).catch(() => undefined);
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
  const operations: HostRunOperations = {
    options(request, payload, wait) {
      return command(() => readOptions(request, payload, wait));
    },
    begin(request, payload, wait) {
      return command(async () => {
        wait?.throwIfAborted();
        if (owned.size + beginning >= 256) throw new ExecutionRunError('run-capacity');
        beginning++;
        try {
          const input = await configuration.prepare(request, payload);
          active();
          // This performs the original owner's pre/post-marker checks and whole-node put.
          const committed = await execution.startRun(request, input);
          if (!committed.ok) return committed;
          const decision = committed.value;
          if (decision.effect?.kind === 'dispatch') {
            const state = retain(decision, request);
            const dispatchStatus = await dispatch(state, decision.effect.previousScope);
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
    },
    send(request, payload, wait) {
      return command(async () => {
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
      return command(() => reader.read(request, payload, wait));
    },
    history(request, payload, wait) {
      return command(() => reader.history(request, payload, wait));
    },
  };

  return {
    operations,
    close(): Promise<void> {
      if (closing) return closing;
      let resolveClose!: () => void;
      let rejectClose!: (reason: unknown) => void;
      const closed = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      closing = closed;
      fenced = true;
      absentRetirements.clear();
      execution.fenceRuns();
      lifetime.abort();
      void (async () => {
        const failures: unknown[] = [];
        let drained = false;
        try {
          await native.close();
          drained = true;
        } catch (error) {
          failures.push(error);
        }
        // Native close interrupts admitted sends/reads; await their late completions
        // before cleanup, with D's original domain and cleanup capabilities still open.
        while (commands.size || events.size) await Promise.allSettled([...commands, ...events]);
        for (const state of [...owned.values()]) {
          if (drained) {
            try {
              await settle(state);
            } catch (error) {
              failures.push(error);
            }
          }
          release(state);
        }
        if (failures.length)
          throw new AggregateError(failures, 'Native Run cleanup remains unconfirmed.');
      })().then(resolveClose, rejectClose);
      return closed;
    },
  };
}
