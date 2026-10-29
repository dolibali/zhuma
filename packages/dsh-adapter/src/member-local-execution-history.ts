import type { RemoteRunView } from '@zhuma/agent-core';
import {
  NativeWorkError,
  type NativeWorkGrant,
  type NativeWorkAction,
  type NativeSessionBinding,
} from './native-work-session-contract.js';
import type { openNativeWorkSessions } from './native-work-session-storage.js';
import type { MemberLocalReadHandle } from './member-local-execution-protocol.js';

type NativeOwner = Awaited<ReturnType<typeof openNativeWorkSessions>>;
interface HistoryView {
  readonly scope: RemoteRunView['scope'];
  readonly result?:
    | { readonly source: { readonly nativeSessionId: string; readonly nativeAgentId: string } }
    | undefined;
}
type HistoryHandle = { readonly value: HistoryView };
export interface NativeHistoryGrantAccess<Run extends HistoryHandle> {
  readonly run: Run;
  readonly signal: AbortSignal;
  view(): Run['value'];
  assertCurrent(action: NativeWorkAction): undefined;
}
interface Reading<Run extends HistoryHandle> {
  readonly run: Run;
  readonly abort: AbortController;
  readonly signal: AbortSignal;
  grant?: NativeWorkGrant;
  view: Run['value'];
  deadline: number;
  binding?: NativeSessionBinding;
  refreshing?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  end?: () => Promise<unknown>;
}
const MAX_READERS = 8,
  REFRESH_MS = 5000,
  FRESH_MS = 10000;

/** Read-only capabilities over the original SDK logs and native binding table.
 * Separate from expired drive/result grants. No method can create/resume/send,
 * renew a drive, write a binding or reconcile business state. */
export class MemberLocalExecutionHistory<Run extends HistoryHandle = MemberLocalReadHandle> {
  private readonly reads = new Set<Reading<Run>>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly native: NativeOwner,
    private readonly protocol: {
      status(run: Run, signal?: AbortSignal): Promise<Run['value']>;
      assertReadBinding(run: Run, binding: NativeSessionBinding): void;
    },
    private readonly grantFor?: (source: NativeHistoryGrantAccess<Run>) => NativeWorkGrant,
  ) {}
  canSwitchBackend(): boolean {
    return !this.lifetime.signal.aborted && this.reads.size === 0 && this.jobs.size === 0;
  }
  private check(read: Reading<Run>): void {
    if (
      this.lifetime.signal.aborted ||
      read.signal.aborted ||
      performance.now() >= read.deadline ||
      !this.reads.has(read)
    )
      throw new NativeWorkError('cancelled');
  }
  private grant(read: Reading<Run>): NativeWorkGrant {
    this.check(read);
    if (!read.grant) throw new NativeWorkError('unavailable');
    return read.grant;
  }
  private binding(read: Reading<Run>, value: NativeSessionBinding): void {
    this.check(read);
    this.protocol.assertReadBinding(read.run, value);
    if (
      read.binding &&
      (value.nativeSessionId !== read.binding.nativeSessionId ||
        value.nativeAgentId !== read.binding.nativeAgentId)
    )
      throw new NativeWorkError('scope-mismatch');
    const result = read.view.result;
    if (
      result &&
      (result.source.nativeSessionId !== value.nativeSessionId ||
        result.source.nativeAgentId !== value.nativeAgentId)
    )
      throw new NativeWorkError('scope-mismatch');
    read.binding = value;
  }
  private refresh(read: Reading<Run>): Promise<void> {
    if (read.refreshing) return read.refreshing;
    const work = (async () => {
      const before = performance.now(),
        view = await this.protocol.status(read.run, read.signal);
      read.signal.throwIfAborted();
      if (!this.reads.has(read)) throw new NativeWorkError('cancelled');
      read.view = view;
      read.deadline = before + FRESH_MS;
      if (read.binding) this.binding(read, read.binding);
    })();
    read.refreshing = work.finally(() => {
      delete read.refreshing;
    });
    return read.refreshing;
  }
  private release(read: Reading<Run>): void {
    if (!this.reads.delete(read)) return;
    if (read.timer) clearInterval(read.timer);
    read.abort.abort();
    if (read.end) void this.track(read.end()).catch(() => undefined);
  }
  private async acquire(run: Run, signal?: AbortSignal): Promise<Reading<Run>> {
    if (this.lifetime.signal.aborted || this.reads.size >= MAX_READERS)
      throw new NativeWorkError('unavailable');
    const abort = new AbortController(),
      combined = AbortSignal.any([this.lifetime.signal, abort.signal, ...(signal ? [signal] : [])]),
      { actorId, spaceId, taskId, planId, revision, nodeId, runId, generation, segmentId } =
        run.value.scope,
      scope = { actorId, spaceId, taskId, planId, revision, nodeId, runId, generation, segmentId };
    const read: Reading<Run> = {
      run,
      abort,
      signal: combined,
      view: run.value,
      deadline: 0,
    };
    this.reads.add(read);
    combined.addEventListener('abort', () => this.release(read), { once: true });
    try {
      await this.refresh(read);
      this.check(read);
      const source: NativeHistoryGrantAccess<Run> = Object.freeze({
        run,
        signal: combined,
        view: () => read.view,
        assertCurrent: (action: NativeWorkAction) => {
          if (!['open', 'history', 'follow'].includes(action))
            throw new NativeWorkError('cancelled');
          this.check(read);
          return undefined;
        },
      });
      // Purpose-specific readonly grants come from the same original owner.
      // No read handle is promoted to an admission, driving or result grant.
      read.grant = this.grantFor
        ? this.grantFor(source)
        : Object.freeze({
            scope: Object.freeze(scope),
            signal: combined,
            assertCurrent: source.assertCurrent,
          });
      if (this.grantFor) {
        const binding = this.native.service.readBinding(read.grant);
        if (!binding) throw new NativeWorkError('not-started');
        // Validate the actual original binding against the private protocol
        // pointer before a purpose-specific source can read any SDK log body.
        this.binding(read, binding);
      }
      read.timer = setInterval(() => {
        void this.refresh(read).catch(() => this.release(read));
      }, REFRESH_MS);
      read.timer.unref();
      return read;
    } catch (error) {
      this.release(read);
      throw error;
    }
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
    return job;
  }
  private withRead<T>(
    run: Run,
    signal: AbortSignal | undefined,
    action: (read: Reading<Run>) => Promise<T>,
  ): Promise<T> {
    return this.track(
      (async () => {
        const read = await this.acquire(run, signal);
        try {
          return await action(read);
        } finally {
          this.release(read);
        }
      })(),
    );
  }
  open(run: Run, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const binding = this.native.service.readBinding(this.grant(read));
      let native: ReturnType<NativeOwner['service']['open']>;
      if (binding) {
        this.binding(read, binding);
        try {
          native = this.native.service.open(this.grant(read));
        } catch (error) {
          // An old drive can expire/be retiring while a fresh read is valid.
          // Detached is navigation metadata, never a physical drain receipt.
          this.check(read);
          if (
            !(error instanceof NativeWorkError) ||
            !['cancelled', 'unavailable', 'not-started'].includes(error.code)
          )
            throw error;
          native = { binding, status: 'detached' };
        }
      }
      this.check(read);
      return { remote: structuredClone(read.view), native };
    });
  }
  /** Fixed UI history whitelist, with the original cursor and fresh read authority. */
  history(run: Run, after = -1, limit = 100, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const value = await this.native.service.conversationHistory(
        this.grant(read),
        after,
        limit,
        read.signal,
      );
      this.binding(read, value.binding);
      await this.refresh(read);
      this.check(read);
      return value;
    });
  }
  readInbox(run: Run, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const value = await this.native.service.readInbox(this.grant(read), read.signal);
      this.binding(read, value.binding);
      await this.refresh(read);
      this.check(read);
      return value;
    });
  }
  async *observe(run: Run, after = -1, signal?: AbortSignal) {
    const read = await this.acquire(run, signal);
    try {
      const binding = this.native.service.readBinding(this.grant(read));
      if (!binding) throw new NativeWorkError('not-started');
      this.binding(read, binding);
      const source = this.native.service.observe(this.grant(read), after, read.signal);
      read.end = () => source.return(undefined);
      for await (const frame of source) {
        this.check(read);
        yield frame;
      }
    } finally {
      this.release(read);
    }
  }
  /** Raw native frames remain internal to the Host. */
  async *follow(run: Run, after = -1, signal?: AbortSignal) {
    const read = await this.acquire(run, signal);
    try {
      const binding = this.native.service.readBinding(this.grant(read));
      if (!binding) throw new NativeWorkError('not-started');
      this.binding(read, binding);
      const source = this.native.service.follow(this.grant(read), after, read.signal);
      read.end = () => source.return(undefined);
      for await (const frame of source) {
        this.check(read);
        yield frame;
      }
    } finally {
      this.release(read);
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    for (const read of this.reads) this.release(read);
    await Promise.allSettled([...this.jobs]);
  }
}
