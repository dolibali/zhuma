import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { ToolExecution, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { canonicalPayload } from '@zhuma/agent-core';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import type { ExecutionService } from './execution-service.js';
import { readExecutionRunComposition } from './execution-run-composition.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkRuntime,
  NativeMigrationDrain,
} from './native-work-session-contract.js';
import {
  NATIVE_RESULT_TOOL,
  NATIVE_RESULT_TOOL_VERSION,
  NATIVE_RESULT_LIMITS,
  NATIVE_RESULT_ERRORS,
  NativeResultError,
  nativeResultContentSchema,
  type NativeResultErrorCode,
  type NativeFixedResultRef,
  type NativeFixedResultSource,
  type NativeFixedResultLease,
  type NativeFixedResultPreparation,
  type NativeResultIntent,
} from './native-work-session-result-contract.js';
import { describeNativeResultTool } from './native-work-session-result-tool.js';
import {
  nativeResultAck,
  nativeResultAckSchema,
  nativeResultDigest,
  assertNativeResultDeclaration,
  qualifyNativeFixedResult,
} from './native-work-session-result-source.js';

type Authority = Pick<ExecutionRunAuthorities, 'assertGrant'>;
const address = (grant: NativeWorkGrant) => canonicalPayload(grant.scope);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const blocks = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
const owners = new WeakMap<NativeWorkSessionService, NativeResultOwner>();

export interface NativeFixedResultIssuer {
  registerNativeResultTool(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition;
  prepareFixedResult(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeFixedResultPreparation>;
  readFixedResult(
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal,
  ): Promise<NativeFixedResultLease>;
  assertFixedResult(grant: NativeWorkGrant, ref: NativeFixedResultRef): undefined;
  onReady(listener: (grant: NativeWorkGrant, ref: NativeFixedResultRef) => void): () => void;
  close(): Promise<void>;
}
interface IssuedResult {
  readonly source: NativeFixedResultSource;
  readonly digest: string;
  readonly drain: NativeMigrationDrain;
  readonly signal: AbortSignal;
}

/** Same C owner/SDK runtime and original Run issuer only; no Client/DTO factory. */
export function createNativeFixedResultIssuer(
  ctx: Context,
  sessions: NativeWorkSessionService,
  runtime: NativeWorkRuntime,
  authority: Authority,
  execution: Pick<ExecutionService, 'readRunComposition'>,
): NativeFixedResultIssuer {
  if (owners.has(sessions) || !sessions.ownsResultRuntime(runtime))
    throw new NativeResultError('result-unavailable');
  const owner = new NativeResultOwner(sessions, runtime, authority, execution);
  owners.set(sessions, owner);
  ctx.effect(() => () => owner.close());
  return owner;
}

class NativeResultOwner implements NativeFixedResultIssuer {
  private readonly lifetime = new AbortController();
  private readonly issued = new WeakMap<NativeFixedResultRef, IssuedResult>();
  private readonly ready = new Map<string, NativeFixedResultRef>();
  private readonly jobs = new Map<string, Promise<NativeFixedResultPreparation>>();
  private readonly failures = new Map<string, NativeResultError>();
  private readonly listeners = new Set<
    (grant: NativeWorkGrant, ref: NativeFixedResultRef) => void
  >();
  private readonly leases = new Set<NativeFixedResultLease>();
  private pendingLeases = 0;
  constructor(
    private readonly sessions: NativeWorkSessionService,
    private readonly runtime: NativeWorkRuntime,
    private readonly authority: Authority,
    private readonly execution: Pick<ExecutionService, 'readRunComposition'>,
  ) {}
  private check(grant: NativeWorkGrant): void {
    this.authority.assertGrant(grant, 'send');
    if (
      this.lifetime.signal.aborted ||
      owners.get(this.sessions) !== this ||
      !this.sessions.ownsResultRuntime(this.runtime)
    )
      throw new NativeResultError('cancelled');
  }
  private binding(grant: NativeWorkGrant): NativeSessionBinding {
    this.check(grant);
    const binding = this.sessions.open(grant)?.binding;
    if (!binding || canonicalPayload(binding.scope) !== address(grant))
      throw new NativeResultError('result-unavailable');
    const snapshot = readExecutionRunComposition(this.execution.readRunComposition(grant.scope));
    this.check(grant);
    if (
      snapshot.configurationId !== binding.selection.configurationId ||
      canonicalPayload(snapshot.payload.scope) !== address(grant) ||
      !('resultIntentTool' in snapshot.payload) ||
      canonicalPayload(snapshot.payload.resultIntentTool) !==
        canonicalPayload(describeNativeResultTool())
    )
      throw new NativeResultError('result-unavailable');
    return binding;
  }
  private code(error: unknown): NativeResultErrorCode {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return NATIVE_RESULT_ERRORS.includes(code as NativeResultErrorCode)
      ? (code as NativeResultErrorCode)
      : 'result-unavailable';
  }
  onReady(listener: (grant: NativeWorkGrant, ref: NativeFixedResultRef) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  registerNativeResultTool(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition {
    const active = this.binding(grant);
    if (
      binding.nativeSessionId !== active.nativeSessionId ||
      binding.nativeAgentId !== active.nativeAgentId ||
      binding.selection.configurationId !== active.selection.configurationId
    )
      throw new NativeResultError('result-unavailable');
    const agent = scopeOf(ctx);
    if (!agent || canonicalPayload(binding.scope) !== address(grant))
      throw new NativeResultError('result-unavailable');
    const current = (exec: Readonly<ToolExecution>) => {
      this.check(grant);
      if (
        exec.signal.aborted ||
        exec.agent !== agent ||
        exec.agent?.id !== binding.nativeAgentId ||
        ctx.agents.get(exec.agent.id) !== exec.agent
      )
        throw new NativeResultError('cancelled');
    };
    const calls = new Map<
      ToolExecution['token'],
      | {
          readonly kind: 'declared';
          readonly intent: NativeResultIntent;
          readonly ackDigest: string;
        }
      | {
          readonly kind: 'rejected';
          readonly value: { readonly ok: false; readonly code: NativeResultErrorCode };
        }
    >();
    const rejected = (exec: Readonly<ToolExecution>, code: NativeResultErrorCode) => {
      const value = { ok: false as const, code };
      calls.set(exec.token, { kind: 'rejected', value });
      return value;
    };
    const kick = () => {
      void this.prepareFixedResult(grant, this.lifetime.signal).catch(() => undefined);
    };
    ctx.tools.guard(() =>
      this.binding(grant).resultIntent ? 'native-completion-pending' : undefined,
    );
    ctx.on('agent/status', ({ agent: actual, status }) => {
      if (actual === agent && status === 'idle') kick();
    });
    ctx.on('tools/result', (exec) => {
      calls.delete(exec.token);
    });
    const definition = describeNativeResultTool();
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: { schema: definition.outputSchema, render: (_args, value) => blocks(value) },
      execute: async (raw, exec) => {
        let intent: NativeResultIntent | undefined;
        try {
          current(exec);
          const parsed = nativeResultContentSchema.safeParse(raw);
          if (!parsed.success) return rejected(exec, 'invalid-arguments');
          intent = {
            protocolVersion: 1,
            toolVersion: NATIVE_RESULT_TOOL_VERSION,
            intentId: randomUUID(),
            callId: exec.callId,
            digest: nativeResultDigest(parsed.data),
          };
          await this.sessions.declareResultIntent(grant, intent, (snapshot) =>
            assertNativeResultDeclaration(snapshot, intent!),
          );
          this.failures.delete(address(grant));
          current(exec);
          const ack = nativeResultAck(binding, intent);
          calls.set(exec.token, { kind: 'declared', intent, ackDigest: hash(ack) });
          exec.concludeTurn();
          return ack;
        } catch (error) {
          if (intent)
            await this.sessions.clearResultIntent(grant, intent.intentId).catch(() => undefined);
          return rejected(exec, this.code(error));
        }
      },
      finalizeContent: (exec, result) => {
        const call = calls.get(exec.token);
        try {
          current(exec);
          if (!call || result.isError) return blocks({ ok: false, code: 'result-unavailable' });
          if (call.kind === 'rejected') {
            if (hash(result.value) !== hash(call.value))
              throw new NativeResultError('result-rejected');
            return blocks(call.value);
          }
          const ack = nativeResultAckSchema.parse(result.value);
          if (
            hash(ack) !== call.ackDigest ||
            this.binding(grant).resultIntent?.intentId !== call.intent.intentId
          )
            throw new NativeResultError('result-rejected');
          return blocks(ack);
        } catch (error) {
          if (call?.kind === 'declared') {
            this.rememberFailure(grant, new NativeResultError('result-rejected'));
            void this.sessions
              .clearResultIntent(grant, call.intent.intentId)
              .catch(() => undefined);
          }
          return blocks({ ok: false, code: this.code(error) });
        }
      },
    } satisfies ToolDefinition);
    return { context: '', toolAllowlist: [NATIVE_RESULT_TOOL] };
  }

  private rememberFailure(grant: NativeWorkGrant, error: NativeResultError): void {
    if (this.failures.size >= 4096) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(address(grant), error);
  }

  async prepareFixedResult(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeFixedResultPreparation> {
    this.check(grant);
    if (signal.aborted) throw new NativeResultError('cancelled');
    const key = address(grant);
    const failure = this.failures.get(key);
    if (failure) throw failure;
    const cached = this.ready.get(key);
    if (cached) {
      try {
        this.assertFixedResult(grant, cached);
        return { status: 'ready', ref: cached };
      } catch {
        this.ready.delete(key);
      }
    }
    const binding = this.binding(grant);
    if (!binding.resultIntent) return { status: 'pending', reason: 'not-declared' };
    if (
      this.runtime.isConnected(binding.nativeSessionId) &&
      this.runtime.status(binding.nativeSessionId) !== 'idle'
    )
      return { status: 'pending', reason: 'running' };
    let work = this.jobs.get(key);
    if (!work) {
      if (this.jobs.size >= NATIVE_RESULT_LIMITS.readers) throw new NativeResultError('capacity');
      work = this.collect(grant, binding);
      this.jobs.set(key, work);
      const owned = work;
      void owned
        .finally(() => {
          if (this.jobs.get(key) === owned) this.jobs.delete(key);
        })
        .catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    try {
      const pending = new Promise<NativeFixedResultPreparation>((resolve) => {
        stop = () => resolve({ status: 'pending', reason: 'draining' });
        signal.addEventListener('abort', stop, { once: true });
        timer = setTimeout(stop, NATIVE_RESULT_LIMITS.waitMs);
        if (signal.aborted) stop();
      });
      const result = await Promise.race([work, pending]);
      this.check(grant);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }

  private async collect(
    grant: NativeWorkGrant,
    initial: NativeSessionBinding,
  ): Promise<NativeFixedResultPreparation> {
    const intent = initial.resultIntent!;
    const signal = AbortSignal.any([grant.signal, this.lifetime.signal]);
    let retired = false;
    try {
      await this.sessions.whenInputReadsIdle(grant.scope);
      this.check(grant);
      const before = await this.sessions.readResultSnapshot(grant, signal);
      this.check(grant);
      const candidate = qualifyNativeFixedResult(before, initial, intent);
      if (!candidate) return { status: 'pending', reason: 'not-durable' };
      before.check();
      const drain = await this.runtime.retire(initial.nativeSessionId, signal);
      retired = true;
      this.check(grant);
      drain.assertCurrent();
      if (drain.basis !== 'flushed-and-closed') throw new NativeResultError('result-rejected');
      const snapshot = await this.sessions.readResultSnapshot(grant, signal);
      this.check(grant);
      drain.assertCurrent();
      const fixed = qualifyNativeFixedResult(snapshot, initial, intent);
      if (
        !fixed ||
        fixed.cut.callSeq !== candidate.cut.callSeq ||
        fixed.cut.resultSeq !== candidate.cut.resultSeq ||
        fixed.cut.turnEndSeq !== candidate.cut.turnEndSeq
      )
        throw new NativeResultError('result-rejected');
      const binding = await this.sessions.sealResultIntent(
        grant,
        intent.intentId,
        fixed.cut,
        () => {
          this.check(grant);
          snapshot.check();
          drain.assertCurrent();
          return undefined;
        },
      );
      this.check(grant);
      drain.assertCurrent();
      snapshot.check();
      const source: NativeFixedResultSource = {
        scope: structuredClone(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
        configurationId: binding.selection.configurationId,
        toolVersion: NATIVE_RESULT_TOOL_VERSION,
        intentId: intent.intentId,
        callId: intent.callId,
        cut: fixed.cut,
      };
      const ref = Object.freeze({}) as NativeFixedResultRef;
      this.issued.set(ref, {
        source,
        digest: intent.digest,
        drain,
        signal: AbortSignal.any([signal, drain.signal]),
      });
      this.assertFixedResult(grant, ref);
      this.ready.set(address(grant), ref);
      {
        const issued = this.issued.get(ref)!;
        issued.signal.addEventListener(
          'abort',
          () => {
            if (this.ready.get(address(grant)) === ref) this.ready.delete(address(grant));
          },
          { once: true },
        );
      }
      for (const listener of this.listeners) {
        try {
          void Promise.resolve(listener(grant, ref)).catch(() => undefined);
        } catch {
          /* Observation never changes the fixed fact. */
        }
      }
      return { status: 'ready', ref };
    } catch (error) {
      if (
        error instanceof NativeResultError &&
        ['input-pending', 'result-rejected'].includes(error.code)
      ) {
        this.rememberFailure(grant, error);
      }
      if (
        !retired &&
        error instanceof NativeResultError &&
        ['input-pending', 'result-rejected'].includes(error.code)
      )
        await this.sessions.clearResultIntent(grant, intent.intentId).catch(() => undefined);
      throw error;
    }
  }

  assertFixedResult(grant: NativeWorkGrant, ref: NativeFixedResultRef): undefined {
    this.check(grant);
    const issued = this.issued.get(ref);
    if (!issued) throw new NativeResultError('result-unavailable');
    if (issued.signal.aborted) throw new NativeResultError('cancelled');
    const binding = this.binding(grant);
    if (
      canonicalPayload(binding.scope) !== canonicalPayload(issued.source.scope) ||
      binding.nativeSessionId !== issued.source.nativeSessionId ||
      binding.nativeAgentId !== issued.source.nativeAgentId ||
      binding.selection.configurationId !== issued.source.configurationId ||
      binding.resultIntent?.intentId !== issued.source.intentId ||
      binding.resultIntent.digest !== issued.digest ||
      canonicalPayload(binding.resultIntent.cut) !== canonicalPayload(issued.source.cut)
    )
      throw new NativeResultError('result-rejected');
    issued.drain.assertCurrent();
    return undefined;
  }

  async readFixedResult(
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal,
  ): Promise<NativeFixedResultLease> {
    this.assertFixedResult(grant, ref);
    if (signal.aborted) throw new NativeResultError('cancelled');
    if (this.leases.size + this.pendingLeases >= NATIVE_RESULT_LIMITS.readers)
      throw new NativeResultError('capacity');
    this.pendingLeases++;
    let pending = true;
    try {
      const issued = this.issued.get(ref)!;
      const combined = AbortSignal.any([signal, issued.signal]);
      const snapshot = await this.sessions.readResultSnapshot(grant, combined);
      this.assertFixedResult(grant, ref);
      const binding = this.binding(grant);
      const fixed = qualifyNativeFixedResult(snapshot, binding, binding.resultIntent!);
      if (!fixed || nativeResultDigest(fixed.content) !== issued.digest)
        throw new NativeResultError('result-rejected');
      let released = false;
      const content = Object.freeze({
        ...fixed.content,
        links: Object.freeze([...fixed.content.links]),
      });
      const source = Object.freeze({
        ...structuredClone(issued.source),
        scope: Object.freeze({ ...issued.source.scope }),
        cut: Object.freeze({ ...issued.source.cut }),
      });
      const release = () => {
        if (released) return;
        released = true;
        combined.removeEventListener('abort', release);
        this.leases.delete(lease);
      };
      const lease: NativeFixedResultLease = {
        source,
        content,
        digest: issued.digest,
        provenanceFingerprint: hash({ source, digest: issued.digest }),
        signal: combined,
        check: () => {
          if (released || combined.aborted) throw new NativeResultError('cancelled');
          this.assertFixedResult(grant, ref);
          snapshot.check();
        },
        release,
      };
      this.pendingLeases--;
      pending = false;
      this.leases.add(lease);
      combined.addEventListener('abort', release, { once: true });
      try {
        lease.check();
      } catch (error) {
        lease.release();
        throw error;
      }
      return lease;
    } finally {
      if (pending) this.pendingLeases--;
    }
  }
  async close() {
    this.lifetime.abort();
    if (owners.get(this.sessions) === this) owners.delete(this.sessions);
    for (const lease of this.leases) lease.release();
    this.listeners.clear();
    this.ready.clear();
    this.failures.clear();
    await Promise.allSettled(this.jobs.values());
  }
}
