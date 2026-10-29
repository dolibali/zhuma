import { NativeWorkError } from './native-work-session-contract.js';

export interface NativeWorkflowAdmission {
  /** New admission only. Aborting this is not proof that an issued request drained. */
  readonly signal: AbortSignal;
  /** Already-issued accepts and their original cleanup keep a separate lifetime. */
  readonly cleanupSignal: AbortSignal;
  assertCurrent(): void;
}

/** One explicitly armed member consumer's process-local admission fence.
 * This owns no workflow, Run, ticket, receipt or durable authorization facts. */
export class NativeWorkflowConsumerLifetime {
  private phase: 'inactive' | 'armed' | 'fenced' | 'closed' = 'inactive';
  private readonly admission = new AbortController();
  private readonly cleanup = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private failed = false;

  /** Call only after the original backend confirms the explicit user command.
   * A new/cold instance stays inert; a fenced instance cannot silently re-arm. */
  arm(): void {
    if (this.phase === 'armed') return;
    if (this.phase !== 'inactive' || this.closing) throw new NativeWorkError('cancelled');
    this.phase = 'armed';
  }
  get busy(): boolean {
    return this.jobs.size !== 0;
  }
  get armed(): boolean {
    return this.phase === 'armed' && !this.closing;
  }
  /** Default concurrency one, including genuine accepts whose reply is still
   * unknown. There is no detached queue that could dispatch after Stop. */
  run<T>(effect: (admission: NativeWorkflowAdmission) => Promise<T>): Promise<T> {
    if (!this.armed) return Promise.reject(new NativeWorkError('cancelled'));
    if (this.busy) return Promise.reject(new NativeWorkError('capacity'));
    const assertCurrent = () => {
      if (!this.armed || this.admission.signal.aborted) throw new NativeWorkError('cancelled');
    };
    const scope = Object.freeze({
      signal: this.admission.signal,
      cleanupSignal: this.cleanup.signal,
      assertCurrent,
    });
    const source = Promise.resolve().then(() => {
      assertCurrent();
      // The effect retains late genuine handles and passes them to the same
      // original owner Stop/cleanup. Never race this source against cancellation.
      return effect(scope);
    });
    this.jobs.add(source);
    void source.then(
      () => this.jobs.delete(source),
      () => this.jobs.delete(source),
    );
    return source;
  }
  /** Join actual issued effects without closing their original native owner. */
  async whenIdle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  /** Synchronous: Stop/identity revocation closes admissions before any await. */
  fence(): void {
    if (this.phase === 'closed') return;
    this.phase = 'fenced';
    this.admission.abort();
  }
  canSwitchBackend(): boolean {
    return !this.failed && !this.busy && ['inactive', 'closed'].includes(this.phase);
  }
  /** Join actual sources before closing their original cleanup owner. A failed
   * drain remains a failure and never becomes a reusable/switchable lifetime. */
  close(drain: (cleanupSignal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.fence();
    this.closing = (async () => {
      try {
        while (this.jobs.size) await Promise.allSettled([...this.jobs]);
        await drain(this.cleanup.signal);
        this.cleanup.abort();
        this.phase = 'closed';
      } catch (error) {
        this.failed = true;
        throw error;
      }
    })();
    return this.closing;
  }
}
