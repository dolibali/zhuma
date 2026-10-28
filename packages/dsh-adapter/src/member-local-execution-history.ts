import type { RemoteRunView } from '@zhuma/agent-core';
import {
  NativeWorkError,
  type NativeWorkGrant,
  type NativeWorkAction,
  type NativeSessionBinding,
} from './native-work-session-contract.js';
import type { openNativeWorkSessions } from './native-work-session-storage.js';
import type {
  MemberLocalExecutionProtocol,
  MemberLocalReadHandle,
} from './member-local-execution-protocol.js';

type NativeOwner = Awaited<ReturnType<typeof openNativeWorkSessions>>;
interface Reading {
  readonly run: MemberLocalReadHandle;
  readonly abort: AbortController;
  readonly signal: AbortSignal;
  readonly grant: NativeWorkGrant;
  view: RemoteRunView;
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
export class MemberLocalExecutionHistory {
  private readonly reads = new Set<Reading>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly native: NativeOwner,
    private readonly protocol: MemberLocalExecutionProtocol,
  ) {}
  private check(read: Reading): void {
    if (
      this.lifetime.signal.aborted ||
      read.signal.aborted ||
      performance.now() >= read.deadline ||
      !this.reads.has(read)
    )
      throw new NativeWorkError('cancelled');
  }
  private binding(read: Reading, value: NativeSessionBinding): void {
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
  private refresh(read: Reading): Promise<void> {
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
  private release(read: Reading): void {
    if (!this.reads.delete(read)) return;
    if (read.timer) clearInterval(read.timer);
    read.abort.abort();
    if (read.end) void this.track(read.end()).catch(() => undefined);
  }
  private async acquire(run: MemberLocalReadHandle, signal?: AbortSignal): Promise<Reading> {
    if (this.lifetime.signal.aborted || this.reads.size >= MAX_READERS)
      throw new NativeWorkError('unavailable');
    const abort = new AbortController(),
      combined = AbortSignal.any([this.lifetime.signal, abort.signal, ...(signal ? [signal] : [])]),
      { backendId: _backendId, ...scope } = run.value.scope;
    const read: Reading = {
      run,
      abort,
      signal: combined,
      view: run.value,
      deadline: 0,
      grant: Object.freeze({
        scope: Object.freeze(structuredClone(scope)),
        signal: combined,
        assertCurrent: (action: NativeWorkAction) => {
          if (!['open', 'history', 'follow'].includes(action))
            throw new NativeWorkError('cancelled');
          this.check(read);
        },
      }),
    };
    this.reads.add(read);
    combined.addEventListener('abort', () => this.release(read), { once: true });
    try {
      await this.refresh(read);
      this.check(read);
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
    run: MemberLocalReadHandle,
    signal: AbortSignal | undefined,
    action: (read: Reading) => Promise<T>,
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
  open(run: MemberLocalReadHandle, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const binding = this.native.service.readBinding(read.grant);
      let native: ReturnType<NativeOwner['service']['open']>;
      if (binding) {
        this.binding(read, binding);
        try {
          native = this.native.service.open(read.grant);
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
  /** Host-internal raw events; UI transports must expose observe() only. */
  history(run: MemberLocalReadHandle, after = -1, limit = 100, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const value = await this.native.service.history(read.grant, after, limit, read.signal);
      this.binding(read, value.binding);
      await this.refresh(read);
      this.check(read);
      return value;
    });
  }
  readInbox(run: MemberLocalReadHandle, signal?: AbortSignal) {
    return this.withRead(run, signal, async (read) => {
      const value = await this.native.service.readInbox(read.grant, read.signal);
      this.binding(read, value.binding);
      await this.refresh(read);
      this.check(read);
      return value;
    });
  }
  async *observe(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    const read = await this.acquire(run, signal);
    try {
      const binding = this.native.service.readBinding(read.grant);
      if (!binding) throw new NativeWorkError('not-started');
      this.binding(read, binding);
      const source = this.native.service.observe(read.grant, after, read.signal);
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
  async *follow(run: MemberLocalReadHandle, after = -1, signal?: AbortSignal) {
    const read = await this.acquire(run, signal);
    try {
      const binding = this.native.service.readBinding(read.grant);
      if (!binding) throw new NativeWorkError('not-started');
      this.binding(read, binding);
      const source = this.native.service.follow(read.grant, after, read.signal);
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
