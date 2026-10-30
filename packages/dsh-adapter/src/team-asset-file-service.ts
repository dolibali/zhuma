import type { MemberRequest } from './member-session.js';
import type {
  MemberAssetFileAuthority,
  MemberAssetFileRead,
  MemberAssetFileReceipt,
  MemberAssetFileReserve,
  MemberAssetFileTicket,
} from './member-asset-file-contract.js';
import {
  TeamAssetFileBytes,
  TeamAssetFileError,
  type TeamAssetFileAuthority,
} from './team-asset-file.js';

/** Thin composition over D's one authoritative asset record and E's original
 * attachment byte carrier. It stores only live cleanup promises, never assets,
 * receipts, versions, permissions or an independent upload retry index. */
export class TeamAssetFileService {
  private readonly lifetime = new AbortController();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly cleanups = new Set<Promise<void>>();
  private cleanupFailed = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly bytes: TeamAssetFileBytes,
    private readonly authority: MemberAssetFileAuthority,
  ) {}
  private current(signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw new TeamAssetFileError('cancelled');
  }
  private narrow(grant: TeamAssetFileAuthority, signal: AbortSignal): TeamAssetFileAuthority {
    return {
      signal: AbortSignal.any([grant.signal, signal]),
      assertCurrent: () => grant.assertCurrent(),
    };
  }
  private request<T>(
    signal: AbortSignal,
    operation: (active: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.current(signal);
    const task = operation(AbortSignal.any([signal, this.lifetime.signal]));
    this.requests.add(task);
    void task.then(
      () => this.requests.delete(task),
      () => this.requests.delete(task),
    );
    return task;
  }
  private cleanup(drain: Promise<void>, release: () => void | Promise<void>): void {
    const job = drain.then(release);
    this.cleanups.add(job);
    void job.then(
      () => this.cleanups.delete(job),
      () => {
        this.cleanupFailed = true;
        this.cleanups.delete(job);
      },
    );
  }
  private release(ticket: MemberAssetFileTicket, drain: Promise<void>) {
    this.cleanup(drain, () => this.authority.abortFile(ticket));
  }
  upload(
    request: MemberRequest,
    raw: MemberAssetFileReserve,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<MemberAssetFileReceipt> {
    return this.request(signal, (active) => this.uploadInner(request, raw, source, active));
  }
  private async uploadInner(
    request: MemberRequest,
    raw: MemberAssetFileReserve,
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<MemberAssetFileReceipt> {
    this.current(signal);
    const input = structuredClone(raw);
    // D authenticates and durably reserves before any source/attachment I/O.
    const reserved = await this.authority.reserveFile(request, input, signal);
    let drain = Promise.resolve();
    try {
      this.current(signal);
      reserved.grant.assertCurrent();
      if (reserved.kind === 'replayed') {
        const operation = this.bytes.verifyReplay(
          input.declare,
          source,
          this.narrow(reserved.grant, signal),
        );
        drain = operation.drain;
        await operation.result;
        this.current(signal);
        reserved.grant.assertCurrent();
        return structuredClone(reserved.receipt);
      }
      const operation = this.bytes.saveTracked(
        input.declare,
        source,
        this.narrow(reserved.grant, signal),
      );
      drain = operation.drain;
      const blob = await operation.result;
      this.current(signal);
      reserved.grant.assertCurrent();
      // Only D may publish the logical upload fact, with final reauthorization,
      // original-row CAS and exact same-key/body replay checks in its queue.
      return await this.authority.commitFile(reserved.ticket, blob);
    } finally {
      // Caller cancellation can return while physical cleanup remains owned.
      // Never release another request's slot or infer abort == settled.
      this.release(reserved.ticket, drain);
    }
  }
  read(request: MemberRequest, input: MemberAssetFileRead, signal: AbortSignal) {
    return this.request(signal, (active) => this.readInner(request, input, active));
  }
  private async readInner(request: MemberRequest, input: MemberAssetFileRead, signal: AbortSignal) {
    this.current(signal);
    const opened = await this.authority.readFile(request, structuredClone(input), signal);
    let drain = Promise.resolve();
    try {
      this.current(signal);
      opened.grant.assertCurrent();
      const operation = this.bytes.readTracked(opened.blob, this.narrow(opened.grant, signal));
      drain = operation.drain;
      const data = await operation.result;
      this.current(signal);
      opened.grant.assertCurrent();
      const { attachmentId: _attachmentId, ...file } = opened.blob;
      return { file, bytes: data };
    } finally {
      this.cleanup(drain, () => opened.release());
    }
  }
  text(
    request: MemberRequest,
    input: MemberAssetFileRead,
    range: { offset: number; length: number },
    signal: AbortSignal,
  ) {
    return this.request(signal, (active) => this.textInner(request, input, range, active));
  }
  private async textInner(
    request: MemberRequest,
    input: MemberAssetFileRead,
    range: { offset: number; length: number },
    signal: AbortSignal,
  ) {
    this.current(signal);
    const opened = await this.authority.readFile(request, structuredClone(input), signal);
    let drain = Promise.resolve();
    try {
      this.current(signal);
      opened.grant.assertCurrent();
      const operation = this.bytes.textTracked(
        opened.blob,
        range,
        this.narrow(opened.grant, signal),
      );
      drain = operation.drain;
      const value = await operation.result;
      this.current(signal);
      opened.grant.assertCurrent();
      return value;
    } finally {
      this.cleanup(drain, () => opened.release());
    }
  }
  async idle(): Promise<void> {
    while (this.cleanups.size) await Promise.allSettled([...this.cleanups]);
    if (this.cleanupFailed) throw new TeamAssetFileError('unavailable');
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.lifetime.abort();
      const settled = await Promise.allSettled([
        this.bytes.close(),
        (async () => {
          while (this.requests.size) await Promise.allSettled([...this.requests]);
        })(),
      ]);
      await this.idle();
      if (settled.some((result) => result.status === 'rejected'))
        throw new TeamAssetFileError('unavailable');
    })());
  }
}
