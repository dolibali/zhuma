import { createHash, randomUUID } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import type {
  NativeReleasedConversationAction,
  NativeReleasedConversationEpoch,
  NativeReleasedConversationEpochRequest,
  NativeReleasedConversationGrant,
  NativeReleasedConversationReadEpoch,
  NativeReleasedConversationReadGrant,
  NativeReleasedConversationStop,
} from './native-released-conversation-authority.js';
import {
  NativeWorkError,
  type NativeBindingReference,
  type NativeMessageReceipt,
  type NativeSessionBinding,
  type NativeWorkRuntime,
  type NativeWorkSessionRecord,
} from './native-work-session-contract.js';
import {
  bindingForScope,
  nativeScopeKey,
  nativeScopeSchema,
  nativeConversationSession,
} from './native-work-session-record.js';
import {
  nativeConversationRuntimeGrant,
  type NativeConversationIssuerPorts,
  type NativeConversationMappingPorts,
  type NativeConversationReadSource,
  type NativeConversationSession,
} from './native-work-session-conversation-contract.js';
import { NativeConversationProjection } from './native-work-session-view.js';

const CAPACITY = 256;
const READERS = 128;
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const reference = (binding: NativeBindingReference): NativeBindingReference => ({
  scope: { ...binding.scope },
  nativeSessionId: binding.nativeSessionId,
  nativeAgentId: binding.nativeAgentId,
  selection: { ...binding.selection },
});
const same = (a: NativeBindingReference, b: NativeBindingReference) =>
  canonicalPayload(reference(a)) === canonicalPayload(reference(b));
function fail(code: ConstructorParameters<typeof NativeWorkError>[0]): never {
  throw new NativeWorkError(code);
}
function synchronousAssertion(result: unknown): void {
  if (result === undefined) return;
  // TypeScript's void permits an async adapter. Never let its deferred failure
  // authorize I/O, and observe its rejection without waiting for permission.
  void Promise.resolve(result).catch(() => undefined);
  fail('scope-mismatch');
}
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
interface OwnedEpoch {
  readonly ticket: NativeReleasedConversationEpoch;
  readonly request: NativeReleasedConversationEpochRequest;
  readonly binding: NativeSessionBinding;
  readonly control: AbortController;
  readonly settled: ReturnType<typeof deferred>;
  readonly revoke: () => void;
  lease: ReturnType<typeof nativeConversationRuntimeGrant> | undefined;
  opening: boolean;
  done: boolean;
  cleanup: Promise<void> | undefined;
}
interface OwnedRead {
  readonly ticket: NativeReleasedConversationReadEpoch;
  readonly request: NativeReleasedConversationEpochRequest;
  readonly source: NativeConversationReadSource;
  readonly control: AbortController;
  released: boolean;
}

/** Facade on the existing Managed native owner, mapping queue and SDK runtime.
 * No transcript, independent Agent factory or execution state is owned here. */
export class NativeReleasedConversationController {
  private issuer: NativeConversationIssuerPorts | undefined;
  private pinned: NativeConversationIssuerPorts | undefined;
  private readonly lifetime = new AbortController();
  // Physical cleanup outlives caller/backend and admission revocation.
  private readonly cleanupLifetime = new AbortController();
  private readonly epochs = new WeakMap<object, OwnedEpoch>();
  private readonly active = new Map<string, OwnedEpoch>();
  private readonly sendSignals = new WeakMap<AbortSignal, OwnedEpoch>();
  private readonly opening = new Set<string>();
  private readonly reads = new Set<OwnedRead>();
  private readonly readTickets = new WeakMap<object, OwnedRead>();
  private readonly readSignals = new WeakMap<AbortSignal, OwnedRead>();
  private readonly pending = new Set<Promise<unknown>>();
  private failed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly mapping: NativeConversationMappingPorts,
    private readonly runtime: NativeWorkRuntime,
  ) {}

  /** A installs the real D issuer once, before registering its transports. */
  configure(issuer: NativeConversationIssuerPorts): void {
    if (
      this.issuer ||
      !issuer ||
      typeof issuer.assertGrant !== 'function' ||
      typeof issuer.assertReadGrant !== 'function' ||
      !issuer.backend?.identity
    )
      fail('unavailable');
    this.issuer = issuer;
    this.pinned = {
      backend: Object.freeze({ ...issuer.backend }),
      assertGrant: issuer.assertGrant,
      assertReadGrant: issuer.assertReadGrant,
    };
  }
  private current() {
    const issuer = this.issuer,
      pinned = this.pinned;
    if (
      !issuer ||
      !pinned ||
      this.lifetime.signal.aborted ||
      this.mapping.signal.aborted ||
      issuer.assertGrant !== pinned.assertGrant ||
      issuer.assertReadGrant !== pinned.assertReadGrant ||
      issuer.backend.id !== pinned.backend.id ||
      issuer.backend.identity !== pinned.backend.identity
    )
      fail('unavailable');
    return pinned;
  }
  private requestCurrent(request: NativeReleasedConversationEpochRequest): void {
    const issuer = this.current();
    if (
      !nativeScopeSchema.safeParse(request.origin).success ||
      request.signal.aborted ||
      typeof request.actorId !== 'string' ||
      !request.actorId ||
      request.actorId.length > 200 ||
      request.backend.id !== issuer.backend.id ||
      request.backend.identity !== issuer.backend.identity
    )
      fail('scope-mismatch');
    const result: unknown = request.assertCurrent();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      fail('scope-mismatch');
    }
  }
  private binding(request: NativeReleasedConversationEpochRequest) {
    const record = this.mapping.read(request.origin);
    const binding = bindingForScope(record, request.origin);
    if (!binding || nativeScopeKey(binding.scope) !== nativeScopeKey(request.origin))
      fail('scope-mismatch');
    return { record, binding };
  }
  private slot(entry: OwnedEpoch): NativeConversationSession {
    const { record, binding } = this.binding(entry.request);
    const slot = nativeConversationSession(record, binding.nativeSessionId);
    if (
      !slot ||
      slot.chatEpoch !== entry.ticket.chatEpoch ||
      !same(binding, entry.binding) ||
      slot.actorId !== entry.ticket.actorId ||
      slot.backendId !== entry.ticket.backendId
    )
      fail('scope-mismatch');
    return slot;
  }
  private async store(
    entry: OwnedEpoch,
    slot: NativeConversationSession,
    check: () => void,
  ): Promise<void> {
    check();
    const record = this.mapping.read(entry.request.origin);
    const previous = nativeConversationSession(record, entry.binding.nativeSessionId);
    if (
      previous &&
      previous.chatEpoch !== slot.chatEpoch &&
      !(
        previous.phase === 'settled' &&
        slot.phase === 'reserved' &&
        slot.chatEpoch === previous.chatEpoch + 1 &&
        canonicalPayload(previous.prefix) === canonicalPayload(slot.prefix)
      )
    )
      fail('scope-mismatch');
    const sessions = (record.conversation?.sessions ?? []).filter(
      (s) => s.origin.nativeSessionId !== entry.binding.nativeSessionId,
    );
    const next: NativeWorkSessionRecord = {
      ...record,
      conversation: { schemaVersion: 1, sessions: [...sessions, slot] },
    };
    await this.mapping.write(entry.request.origin, next, check);
    check();
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
  private invalidateReaders(sessionId: string): void {
    for (const read of [...this.reads])
      if (read.ticket.binding.nativeSessionId === sessionId) read.ticket.release();
  }

  openEpoch(
    request: NativeReleasedConversationEpochRequest,
  ): Promise<NativeReleasedConversationEpoch> {
    this.requestCurrent(request);
    return this.track(
      this.mapping.serial(
        request.origin,
        () => this.requestCurrent(request),
        async () => {
          this.requestCurrent(request);
          const { record, binding } = this.binding(request);
          const sid = binding.nativeSessionId;
          if (this.active.size + this.opening.size >= CAPACITY) fail('capacity');
          if (this.active.has(sid) || this.opening.has(sid)) fail('migration-not-ready');
          const prior = nativeConversationSession(record, sid);
          if (
            (prior && prior.phase !== 'settled') ||
            prior?.receipts.some((r) => r.status === 'reserved' || r.status === 'unknown') ||
            binding.receipts.some((r) => r.status === 'reserved' || r.status === 'unknown') ||
            (binding.resultIntent && !binding.resultIntent.cut)
          )
            fail('input-pending');
          this.opening.add(sid);
          try {
            const drain = await this.runtime.retire(sid, this.mapping.signal, false);
            this.requestCurrent(request);
            drain.assertCurrent();
            if (drain.basis !== 'flushed-and-closed' || !this.runtime.readConversationPrefix)
              fail('unavailable');
            const prefix =
              prior?.prefix ??
              (await this.runtime.readConversationPrefix(binding, request.signal, () =>
                this.requestCurrent(request),
              ));
            this.requestCurrent(request);
            drain.assertCurrent();
            // A later epoch reuses the original fence, but still verifies its bytes.
            if (prior) {
              if (!this.runtime.readPrefixSnapshot) fail('unavailable');
              const fixed = await this.runtime.readPrefixSnapshot(
                binding,
                prefix,
                request.signal,
                () => this.requestCurrent(request),
              );
              fixed.check();
              const inbox = await this.runtime.readInbox(sid, request.signal, false, () =>
                this.requestCurrent(request),
              );
              this.requestCurrent(request);
              if (inbox.items.length) fail('input-pending');
            }
            const chatEpoch = (prior?.chatEpoch ?? 0) + 1;
            if (!Number.isSafeInteger(chatEpoch)) fail('capacity');
            const control = new AbortController();
            const ticket: NativeReleasedConversationEpoch = Object.freeze({
              kind: 'chat-only',
              chatEpoch,
              actorId: request.actorId,
              backendId: request.backend.id,
              binding: structuredClone(binding),
              signal: control.signal,
            });
            let entry!: OwnedEpoch;
            const revoke = () => {
              void this.retireEpoch(ticket).catch(() => undefined);
            };
            entry = {
              ticket,
              request,
              binding: structuredClone(binding),
              control,
              settled: deferred(),
              revoke,
              lease: undefined,
              opening: false,
              done: false,
              cleanup: undefined,
            };
            this.epochs.set(ticket, entry);
            this.sendSignals.set(request.signal, entry);
            this.active.set(sid, entry);
            this.invalidateReaders(sid);
            this.mapping.admit(request.origin);
            const slot: NativeConversationSession = {
              origin: reference(binding),
              prefix,
              chatEpoch,
              actorId: request.actorId,
              backendId: request.backend.id,
              phase: 'reserved',
              receipts: prior?.receipts ?? [],
            };
            try {
              await this.store(entry, slot, () => this.requestCurrent(request));
              this.requestCurrent(request);
            } catch (error) {
              this.failed = true;
              entry.control.abort();
              entry.settled.reject(error);
              throw error;
            }
            request.signal.addEventListener('abort', revoke, { once: true });
            if (request.signal.aborted) revoke();
            this.assertEpoch(ticket, 'read');
            return ticket;
          } finally {
            this.opening.delete(sid);
          }
        },
      ),
    );
  }

  assertEpoch(
    ticket: NativeReleasedConversationEpoch,
    action: NativeReleasedConversationAction,
  ): undefined {
    if (!['read', 'send', 'stop'].includes(action)) fail('scope-mismatch');
    const entry = this.epochs.get(ticket);
    if (
      !entry ||
      entry.done ||
      entry.control.signal.aborted ||
      this.active.get(entry.binding.nativeSessionId) !== entry
    )
      fail('scope-mismatch');
    this.requestCurrent(entry.request);
    const slot = this.slot(entry);
    if (!['reserved', 'active'].includes(slot.phase)) fail('input-pending');
    return undefined;
  }
  private sendEntry(
    grant: NativeReleasedConversationGrant,
    action: NativeReleasedConversationAction,
  ): OwnedEpoch {
    const issuer = this.current();
    synchronousAssertion(issuer.assertGrant.call(this.issuer, grant, action));
    const entry = this.sendSignals.get(grant.signal);
    if (
      !entry ||
      grant.actorId !== entry.ticket.actorId ||
      grant.backendId !== entry.ticket.backendId ||
      grant.chatEpoch !== entry.ticket.chatEpoch ||
      !same(grant.origin, entry.binding)
    )
      fail('scope-mismatch');
    this.assertEpoch(entry.ticket, action);
    return entry;
  }
  send(
    grant: NativeReleasedConversationGrant,
    request: { readonly requestId: string; readonly text: string },
  ): Promise<NativeMessageReceipt> {
    const entry = this.sendEntry(grant, 'send');
    const input = { ...request };
    if (
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 16_384 ||
      typeof input.requestId !== 'string' ||
      !input.requestId ||
      input.requestId.length > 200
    )
      fail('invalid-request');
    const verify = () => {
      this.sendEntry(grant, 'send');
    };
    let attempted = false;
    return this.track(
      this.mapping.serial(entry.request.origin, verify, async () => {
        verify();
        let slot = this.slot(entry);
        const fingerprint = hash(['followup', input.text]);
        const previous = slot.receipts.find(
          (r) =>
            r.actorId === grant.actorId &&
            r.backendId === grant.backendId &&
            r.requestId === input.requestId,
        );
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('idempotency-mismatch');
          const status = await this.runtime.messageStatus(
            entry.binding.nativeSessionId,
            previous.messageId,
            grant.signal,
          );
          verify();
          const receipt = {
            ...previous,
            status: status === 'absent' ? ('unknown' as const) : status,
          };
          // Match by its immutable key: storage reads are defensive copies.
          slot = this.slot(entry);
          slot = {
            ...slot,
            // Durable reconciliation completes this epoch's admission even
            // when the existing message needs no native Agent resume.
            phase: receipt.status === 'unknown' ? 'unknown' : 'active',
            receipts: slot.receipts.map((r) =>
              r.actorId === previous.actorId &&
              r.backendId === previous.backendId &&
              r.requestId === previous.requestId
                ? receipt
                : r,
            ),
          };
          attempted = true;
          await this.store(entry, slot, verify);
          return receipt;
        }
        if (slot.receipts.length >= 256) fail('capacity');
        const receipt = {
          requestId: input.requestId,
          messageId: randomUUID(),
          fingerprint,
          mode: 'followup' as const,
          status: 'reserved' as const,
          actorId: grant.actorId,
          backendId: grant.backendId,
          chatEpoch: grant.chatEpoch,
        };
        attempted = true;
        await this.store(entry, { ...slot, receipts: [...slot.receipts, receipt] }, verify);
        verify();
        if (!this.runtime.connectConversation) fail('unavailable');
        entry.lease ??= nativeConversationRuntimeGrant({
          binding: entry.binding,
          chatEpoch: grant.chatEpoch,
          prefix: slot.prefix,
          signal: entry.control.signal,
          assertCurrent: () => {
            this.assertEpoch(entry.ticket, 'send');
          },
        });
        entry.opening = true;
        try {
          await this.runtime.connectConversation(entry.binding, entry.lease);
        } finally {
          entry.opening = false;
        }
        verify();
        this.runtime.send(
          entry.binding.nativeSessionId,
          { id: receipt.messageId, text: input.text, rpcId: input.requestId },
          'followup',
        );
        await this.runtime.flush(entry.binding.nativeSessionId);
        verify();
        const received = { ...receipt, status: 'received' as const };
        slot = this.slot(entry);
        await this.store(
          entry,
          {
            ...slot,
            phase: 'active',
            receipts: slot.receipts.map((r) => (r.messageId === receipt.messageId ? received : r)),
          },
          verify,
        );
        verify();
        return received;
      }),
    ).catch((error: unknown) => {
      // Keep the reserved receipt and original cleanup owner after an unknown
      // send outcome. Cleanup is queued after this operation, never awaited here.
      if (attempted) void this.retireEpoch(entry.ticket).catch(() => undefined);
      throw error;
    });
  }

  retireEpoch(ticket: NativeReleasedConversationEpoch): Promise<NativeReleasedConversationStop> {
    const entry = this.epochs.get(ticket);
    if (!entry) return Promise.reject(new NativeWorkError('scope-mismatch'));
    if (entry.done) return Promise.resolve('stopped');
    // Cancel the exact owned factory/flush wait before queuing behind it.
    // Metadata and physical retirement still remain in the original queue.
    entry.request.signal.removeEventListener('abort', entry.revoke);
    entry.control.abort();
    if (!entry.cleanup) {
      const cleanupCheck = () => {
        if (
          this.epochs.get(ticket) !== entry ||
          (this.active.get(entry.binding.nativeSessionId) !== entry && !entry.done)
        )
          fail('scope-mismatch');
      };
      entry.cleanup = this.mapping.serial(entry.request.origin, cleanupCheck, async () => {
        let slot = this.slot(entry);
        await this.store(entry, { ...slot, phase: 'retiring' }, cleanupCheck);
        const proof = await this.runtime.retire(
          entry.binding.nativeSessionId,
          this.cleanupLifetime.signal,
          false,
        );
        proof.assertCurrent();
        if (proof.basis !== 'flushed-and-closed') fail('unavailable');
        slot = this.slot(entry);
        const receipts = [];
        for (const receipt of slot.receipts) {
          if (receipt.status !== 'reserved' && receipt.status !== 'received') {
            receipts.push(receipt);
            continue;
          }
          const status = await this.runtime.messageStatus(
            entry.binding.nativeSessionId,
            receipt.messageId,
            this.cleanupLifetime.signal,
          );
          proof.assertCurrent();
          receipts.push({
            ...receipt,
            status: status === 'absent' ? ('unknown' as const) : status,
          });
        }
        await this.store(
          entry,
          {
            ...slot,
            phase: receipts.some((r) => r.status === 'unknown' || r.status === 'reserved')
              ? 'unknown'
              : 'settled',
            receipts,
          },
          cleanupCheck,
        );
        proof.assertCurrent();
        entry.done = true;
        if (this.active.get(entry.binding.nativeSessionId) === entry)
          this.active.delete(entry.binding.nativeSessionId);
        entry.settled.resolve();
      });
      void entry.cleanup.catch((error) => {
        this.failed = true;
        entry.settled.reject(error);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      entry.settled.promise.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 5000);
      }),
    ]).finally(() => clearTimeout(timer));
  }
  whenEpochSettled(ticket: NativeReleasedConversationEpoch): Promise<void> {
    const entry = this.epochs.get(ticket);
    return entry ? entry.settled.promise : Promise.reject(new NativeWorkError('scope-mismatch'));
  }
  stop(grant: NativeReleasedConversationGrant) {
    return this.retireEpoch(this.sendEntry(grant, 'stop').ticket);
  }

  openReadEpoch(
    request: NativeReleasedConversationEpochRequest,
  ): Promise<NativeReleasedConversationReadEpoch> {
    this.requestCurrent(request);
    if (this.reads.size >= READERS) return Promise.reject(new NativeWorkError('capacity'));
    return this.track(
      (async () => {
        const { record, binding } = this.binding(request);
        const slot = nativeConversationSession(record, binding.nativeSessionId);
        if (
          this.opening.has(binding.nativeSessionId) ||
          (slot && ['reserved', 'retiring', 'unknown'].includes(slot.phase)) ||
          (!slot && binding.receipts.some((r) => ['reserved', 'unknown'].includes(r.status)))
        )
          fail('migration-not-ready');
        const qualify = this.runtime.qualifyConversationRead,
          identity = this.runtime.conversationSourceIdentity;
        if (!qualify || !identity) fail('unavailable');
        const source = identity.call(this.runtime);
        await qualify.call(this.runtime, binding, request.signal, () =>
          this.requestCurrent(request),
        );
        this.requestCurrent(request);
        const fresh = this.binding(request);
        const latest = nativeConversationSession(fresh.record, binding.nativeSessionId);
        if (!same(binding, fresh.binding) || (latest?.chatEpoch ?? 0) !== (slot?.chatEpoch ?? 0))
          fail('scope-mismatch');
        if (this.reads.size >= READERS) fail('capacity');
        const control = new AbortController();
        let read!: OwnedRead;
        const release = () => {
          if (!read || read.released) return;
          read.released = true;
          control.abort();
          request.signal.removeEventListener('abort', release);
          this.reads.delete(read);
        };
        const ticket: NativeReleasedConversationReadEpoch = Object.freeze({
          kind: 'chat-history',
          chatEpoch: slot?.chatEpoch ?? 0,
          actorId: request.actorId,
          backendId: request.backend.id,
          binding: structuredClone(binding),
          signal: control.signal,
          release,
        });
        read = { ticket, request, source, control, released: false };
        this.reads.add(read);
        this.readTickets.set(ticket, read);
        this.readSignals.set(request.signal, read);
        request.signal.addEventListener('abort', release, { once: true });
        try {
          this.assertReadEpoch(ticket);
        } catch (error) {
          release();
          throw error;
        }
        return ticket;
      })(),
    );
  }
  assertReadEpoch(ticket: NativeReleasedConversationReadEpoch): undefined {
    const read = this.readTickets.get(ticket);
    if (!read || read.released || read.control.signal.aborted) fail('scope-mismatch');
    this.requestCurrent(read.request);
    const { record, binding } = this.binding(read.request);
    const slot = nativeConversationSession(record, binding.nativeSessionId);
    const source = this.runtime.conversationSourceIdentity?.();
    if (
      !same(binding, ticket.binding) ||
      (slot?.chatEpoch ?? 0) !== ticket.chatEpoch ||
      (slot && ['reserved', 'retiring', 'unknown'].includes(slot.phase)) ||
      !source ||
      source.persistence !== read.source.persistence ||
      source.registry !== read.source.registry ||
      source.projection !== read.source.projection
    ) {
      ticket.release();
      fail('scope-mismatch');
    }
    return undefined;
  }
  private readEntry(grant: NativeReleasedConversationReadGrant): OwnedRead {
    const issuer = this.current();
    synchronousAssertion(issuer.assertReadGrant.call(this.issuer, grant));
    const read = this.readSignals.get(grant.signal);
    if (
      !read ||
      grant.actorId !== read.ticket.actorId ||
      grant.backendId !== read.ticket.backendId ||
      grant.chatEpoch !== read.ticket.chatEpoch ||
      !same(grant.origin, read.ticket.binding)
    )
      fail('scope-mismatch');
    this.assertReadEpoch(read.ticket);
    return read;
  }
  open(grant: NativeReleasedConversationReadGrant) {
    const read = this.readEntry(grant),
      sid = read.ticket.binding.nativeSessionId;
    return {
      binding: structuredClone(read.ticket.binding),
      chatEpoch: read.ticket.chatEpoch,
      status: this.runtime.isConnected(sid) ? this.runtime.status(sid) : ('detached' as const),
    };
  }
  async conversationHistory(
    grant: NativeReleasedConversationReadGrant,
    after = -1,
    limit = 100,
    signal: AbortSignal = grant.signal,
  ) {
    const read = this.readEntry(grant);
    if (
      !Number.isSafeInteger(after) ||
      after < -1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail('invalid-request');
    if (!this.runtime.readConversationPage) fail('unavailable');
    const combined = AbortSignal.any([grant.signal, read.ticket.signal, signal]);
    const events = await this.runtime.readConversationPage(
      read.ticket.binding,
      after,
      limit,
      combined,
      () => {
        this.readEntry(grant);
      },
    );
    this.readEntry(grant);
    combined.throwIfAborted();
    return {
      binding: structuredClone(read.ticket.binding),
      events: structuredClone(events),
      chatEpoch: grant.chatEpoch,
    };
  }
  async *follow(
    grant: NativeReleasedConversationReadGrant,
    after = -1,
    signal: AbortSignal = grant.signal,
  ) {
    const read = this.readEntry(grant);
    if (!Number.isSafeInteger(after) || after < -1) fail('invalid-request');
    const combined = AbortSignal.any([grant.signal, signal, read.ticket.signal]);
    for await (const frame of this.runtime.follow(
      read.ticket.binding.nativeSessionId,
      after,
      combined,
      false,
      () => {
        this.readEntry(grant);
      },
      read.ticket.binding.scope,
      true,
    )) {
      this.readEntry(grant);
      combined.throwIfAborted();
      yield {
        scope: { ...read.ticket.binding.scope },
        nativeSessionId: read.ticket.binding.nativeSessionId,
        chatEpoch: grant.chatEpoch,
        ...frame,
      };
    }
  }
  async *observe(
    grant: NativeReleasedConversationReadGrant,
    after = -1,
    signal: AbortSignal = grant.signal,
  ) {
    const read = this.readEntry(grant);
    const projection = new NativeConversationProjection(read.ticket.binding.nativeSessionId, after);
    for await (const item of this.follow(grant, after, signal)) {
      const frame = projection.push(item);
      if (!frame) continue;
      this.readEntry(grant);
      yield {
        scope: { ...read.ticket.binding.scope },
        nativeSessionId: read.ticket.binding.nativeSessionId,
        chatEpoch: grant.chatEpoch,
        ...frame,
      };
      if (frame.type === 'gap') return;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    for (const read of [...this.reads]) read.ticket.release();
    for (const entry of this.active.values()) {
      entry.control.abort();
      void this.retireEpoch(entry.ticket).catch(() => undefined);
    }
    this.closing = (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.all(
        [...this.active.values()].map(async (entry) => {
          await this.retireEpoch(entry.ticket);
          await entry.settled.promise;
        }),
      );
      if (this.failed) fail('unavailable');
    })();
    return this.closing;
  }
}
