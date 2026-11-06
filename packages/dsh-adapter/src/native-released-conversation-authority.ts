import { z } from 'zod';
import { canonicalPayload, type ExecutionNodeRecord } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type {
  ExecutionMemberLease,
  ExecutionRunLocator,
  ExecutionRunAuthoritySource,
} from './execution-run-authority.js';
import { requireExecutionRunWriter } from './execution-run-protocol.js';
import { executionRunScope, readExecutionRunState } from './execution-run-state.js';
import {
  NativeWorkError,
  type NativeBindingReference,
  type NativeSessionBinding,
  type NativeWorkScope,
} from './native-work-session-contract.js';
import { nativeWorkSessionBindingSchema } from './native-work-session-record.js';

const id = z.string().min(1).max(200);
const locatorSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
  runId: id,
});
const grantBrand = Symbol('released-conversation-grant');
const readGrantBrand = Symbol('released-conversation-read-grant');
export type NativeReleasedConversationAction = 'read' | 'send' | 'stop';
export type NativeReleasedConversationStop = 'pending' | 'stopped';

/** A verified Host binding, never a backend URL supplied by a message. */
export interface NativeReleasedConversationBackend {
  readonly id: string;
  readonly identity: object;
}

/** The native owner's reservation. Metadata is not native readiness evidence:
 * assertEpoch checks its issuer, actual binding, inbox, drain and writer.
 * This is not a Run and must not be written into ExecutionRunState.
 */
export interface NativeReleasedConversationEpoch {
  readonly kind: 'chat-only';
  readonly chatEpoch: number;
  readonly actorId: string;
  readonly backendId: string;
  readonly binding: NativeSessionBinding;
  readonly signal: AbortSignal;
}
export interface NativeReleasedConversationEpochRequest {
  readonly origin: NativeWorkScope;
  readonly actorId: string;
  readonly backend: NativeReleasedConversationBackend;
  readonly signal: AbortSignal;
  /** Recheck before observing an existing epoch or reserving a writing epoch. */
  assertCurrent(): undefined;
}

/** An existing mapping/epoch observation, never a native writer reservation.
 * Unknown/preparing/tombstoned sessions must not be materialized to issue it.
 * Epoch 0 represents a known original Session with no chat epoch yet.
 */
export interface NativeReleasedConversationReadEpoch {
  readonly kind: 'chat-history';
  readonly chatEpoch: number;
  readonly actorId: string;
  readonly backendId: string;
  readonly binding: NativeSessionBinding;
  readonly signal: AbortSignal;
  /** Idempotent read-listener release only, including after revocation. */
  release(): void;
}

/** These are NEW Host-only ports, not existing/wired NativeWorkSession APIs.
 * The Host supplies its original member issuer and current directory checks;
 * the same native owner/domain implements the epoch ports.
 * Shared-backend facts must come from authenticated current HTTP facts, never
 * an in-process grant transported across Hosts or a browser's claimed member.
 */
export interface NativeReleasedConversationAuthoritySource extends Pick<
  ExecutionRunAuthoritySource,
  'assertWorkspace'
> {
  readonly signal: AbortSignal;
  writerState(): unknown;
  memberLease(request: MemberRequest): Promise<ExecutionMemberLease>;
  readNode(locator: ExecutionRunLocator): ExecutionNodeRecord | undefined;
  backend(): NativeReleasedConversationBackend;
  /** Preserve the existing current reader's full history-visibility policy.
   * Task participation alone must not replace any applicable read-source or
   * workspace fence; read-epoch adapters supplement, never widen that policy.
   */
  assertNodeAccess(
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
    action: 'history',
  ): undefined;
  /** The current assignee/owner policy, independent of terminal Run.drive. */
  assertController(memberId: string, node: ExecutionNodeRecord): undefined;
  onChange(recheck: () => void): () => void;
  /** Only explicit user Send may open this reservation. No Agent/model starts
   * here. Reject pending/missing/foreign/unknown native ownership; never create
   * a replacement Session. Rejection must not abandon an acquired resource.
   */
  openEpoch(
    request: NativeReleasedConversationEpochRequest,
  ): Promise<NativeReleasedConversationEpoch>;
  /** Synchronous same-issuer check, not a structural/JSON equality check.
   * Require an actual known Session, empty old inbox, confirmed physical old
   * drain, unchanged source and this actor's exact new chat epoch/writer.
   * Consuming the old drain at admission must not keep its signal as the new
   * epoch's lifetime: new chat activity invalidates that old certificate.
   */
  assertEpoch(
    epoch: NativeReleasedConversationEpoch,
    action: NativeReleasedConversationAction,
  ): undefined;
  /** Internal cleanup: verify original epoch ownership, but DO NOT require the
   * expired member/current backend. Retain and drain the original owner after
   * revocation, a wait cancellation, backend replacement or late admission.
   * A known already-settled epoch remains an idempotent cleanup target; it is
   * not a foreign ticket merely because its active writer has closed.
   */
  retireEpoch(epoch: NativeReleasedConversationEpoch): Promise<NativeReleasedConversationStop>;
  /** Actual native source/writer close, not an HTTP wait or persisted label.
   * Reject an unknown/failed cleanup; never resolve merely because it timed out.
   */
  whenEpochSettled(epoch: NativeReleasedConversationEpoch): Promise<void>;
  /** Passive navigation only: no Agent, new epoch, native writer or stop slot.
   * In this request assertCurrent checks existing history access, not control
   * or terminal/settled state. Missing ports leave this read purpose unavailable.
   */
  openReadEpoch?(
    request: NativeReleasedConversationEpochRequest,
  ): Promise<NativeReleasedConversationReadEpoch>;
  /** Check the opaque local issuer, exact mapping and CURRENT epoch on every
   * page/follow gate. Epoch changes revoke the old ticket; JSON is not a ticket.
   */
  assertReadEpoch?(epoch: NativeReleasedConversationReadEpoch): undefined;
}

/** This grant deliberately has NO .scope and is not a NativeWorkGrant. It
 * grants only chat read/send/stop; no tool, cwd, complete_work or publish right.
 */
export interface NativeReleasedConversationGrant {
  readonly [grantBrand]: true;
  readonly actorId: string;
  readonly spaceId: string;
  readonly backendId: string;
  readonly chatEpoch: number;
  readonly origin: NativeBindingReference;
  readonly signal: AbortSignal;
  assertCurrent(action: NativeReleasedConversationAction): void;
}
export interface OpenedNativeReleasedConversation {
  readonly grant: NativeReleasedConversationGrant;
  /** Revoke immediately, but retain internal physical-cleanup ownership.
   * The Host/native owner holds this handle, not an HTTP/view finally block.
   * A cancelled request only abandons its wait after native admission.
   */
  dispose(): void;
}

export interface NativeReleasedConversationReadGrant {
  readonly [readGrantBrand]: true;
  readonly actorId: string;
  readonly spaceId: string;
  readonly backendId: string;
  readonly chatEpoch: number;
  readonly origin: NativeBindingReference;
  readonly signal: AbortSignal;
  assertCurrent(action: 'read'): void;
}
export interface OpenedNativeReleasedConversationRead {
  readonly grant: NativeReleasedConversationReadGrant;
  /** Releases only this reader and its member lease; never retires chat. */
  dispose(): void;
}

export class NativeReleasedConversationAuthorityError extends Error {
  constructor(
    readonly code:
      | 'conversation-authority-validation'
      | 'conversation-authority-denied'
      | 'conversation-authority-unavailable'
      | 'conversation-authority-pending'
      | 'conversation-authority-capacity',
  ) {
    super('会话操作未完成。');
    this.name = 'NativeReleasedConversationAuthorityError';
  }
}
function deny(): never {
  throw new NativeReleasedConversationAuthorityError('conversation-authority-denied');
}
function sync<T>(value: T): T {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    return deny();
  }
  return value;
}
function assertion(value: unknown): void {
  if (sync(value) !== undefined) deny();
}
function failure(error: unknown): NativeReleasedConversationAuthorityError {
  if (error instanceof NativeReleasedConversationAuthorityError) return error;
  if (error instanceof NativeWorkError) {
    if (['migration-not-ready', 'input-pending', 'input-read-busy'].includes(error.code))
      return new NativeReleasedConversationAuthorityError('conversation-authority-pending');
    if (error.code === 'capacity')
      return new NativeReleasedConversationAuthorityError('conversation-authority-capacity');
  }
  return new NativeReleasedConversationAuthorityError('conversation-authority-denied');
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const methods = [
  'writerState',
  'memberLease',
  'readNode',
  'backend',
  'assertNodeAccess',
  'assertController',
  'assertWorkspace',
  'onChange',
  'openEpoch',
  'assertEpoch',
  'retireEpoch',
  'whenEpochSettled',
] as const;
const readMethods = ['openReadEpoch', 'assertReadEpoch'] as const;
interface ObservedAuthority {
  readonly drain: Promise<void>;
  check(action: NativeReleasedConversationAction): void;
  revoke(): void;
}
interface Owned extends ObservedAuthority {
  stop(): Promise<NativeReleasedConversationStop>;
}

/** Capability/lifetime leaf only. No transcript, Run writes, model calls, HTTP
 * registration or native factory. Normal history must use the passive reader,
 * not open(). The original native owner separately enforces chat-only setup.
 */
export class NativeReleasedConversationAuthorities {
  private readonly grants = new WeakMap<object, Owned>();
  private readonly readGrants = new WeakMap<object, ObservedAuthority>();
  private readonly owned = new Set<ObservedAuthority>();
  private readonly sessions = new Map<string, Owned>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly ports: NativeReleasedConversationAuthoritySource;
  private readonly sourceSignal: AbortSignal;
  private readonly unsubscribe: () => void;
  private fenced = false;
  private failed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly source: NativeReleasedConversationAuthoritySource) {
    if (
      !source ||
      !(source.signal instanceof AbortSignal) ||
      methods.some((name) => typeof source[name] !== 'function')
    )
      throw new NativeReleasedConversationAuthorityError('conversation-authority-unavailable');
    this.sourceSignal = source.signal;
    this.ports = {
      signal: source.signal,
      writerState: source.writerState,
      memberLease: source.memberLease,
      readNode: source.readNode,
      backend: source.backend,
      assertNodeAccess: source.assertNodeAccess,
      assertController: source.assertController,
      assertWorkspace: source.assertWorkspace,
      onChange: source.onChange,
      openEpoch: source.openEpoch,
      assertEpoch: source.assertEpoch,
      retireEpoch: source.retireEpoch,
      whenEpochSettled: source.whenEpochSettled,
      ...(source.openReadEpoch === undefined ? {} : { openReadEpoch: source.openReadEpoch }),
      ...(source.assertReadEpoch === undefined ? {} : { assertReadEpoch: source.assertReadEpoch }),
    };
    try {
      const stop = sync(this.ports.onChange.call(source, () => this.recheck()));
      if (typeof stop !== 'function') throw Error();
      this.unsubscribe = stop;
    } catch {
      throw new NativeReleasedConversationAuthorityError('conversation-authority-unavailable');
    }
    this.sourceSignal.addEventListener('abort', this.onAbort, { once: true });
    if (this.sourceSignal.aborted) this.fence();
  }
  private readonly onAbort = () => this.fence();

  private current(): void {
    if (
      this.fenced ||
      this.sourceSignal.aborted ||
      this.source.signal !== this.sourceSignal ||
      methods.some((name) => this.source[name] !== this.ports[name]) ||
      readMethods.some((name) => this.source[name] !== this.ports[name])
    )
      deny();
  }
  private observe(
    locator: ExecutionRunLocator,
    lease: ExecutionMemberLease,
    purpose: 'send' | 'read' = 'send',
  ) {
    this.current();
    requireExecutionRunWriter(sync(this.ports.writerState.call(this.source)));
    const backend = sync(this.ports.backend.call(this.source));
    if (
      !backend ||
      !id.safeParse(backend.id).success ||
      !backend.identity ||
      typeof backend.identity !== 'object'
    )
      return deny();
    const node = sync(this.ports.readNode.call(this.source, locator));
    if (
      !node ||
      node.taskId !== locator.taskId ||
      node.planId !== locator.planId ||
      node.revision !== locator.revision ||
      node.nodeId !== locator.nodeId
    )
      return deny();
    const run = readExecutionRunState(node)?.runs.find((item) => item.attempt.id === locator.runId);
    if (!run || run.remote) return deny();
    if (
      purpose === 'send' &&
      (run.resources !== 'settled' ||
        !run.attempt.acknowledged ||
        !run.attempt.sessionId ||
        !run.attempt.executorRunId ||
        run.dispatch !== 'received' ||
        (run.attempt.status !== 'cancelled' && run.attempt.status !== 'completed') ||
        (run.attempt.status === 'cancelled' && run.attempt.stopPhase !== 'confirmed') ||
        (run.attempt.status === 'completed' && !run.resultDelivery))
    )
      return deny();
    const origin = executionRunScope(node, run);
    assertion(lease.assertCurrent(origin.spaceId));
    assertion(
      this.ports.assertNodeAccess.call(
        this.source,
        lease.memberId,
        origin.spaceId,
        node,
        'history',
      ),
    );
    assertion(
      this.ports.assertWorkspace.call(
        this.source,
        lease.memberId,
        origin.spaceId,
        run.workspace,
        'read',
        run.selection.configurationId,
      ),
    );
    if (purpose === 'send')
      assertion(this.ports.assertController.call(this.source, lease.memberId, node));
    this.current();
    return {
      backend: { id: backend.id, identity: backend.identity },
      origin,
      run,
      // Normal Run progress is not a read-identity replacement. C separately
      // fences old work history and qualifies the current continuation epoch.
      fingerprint: canonicalPayload(
        purpose === 'send'
          ? run
          : {
              origin,
              selection: run.selection,
              workspace: run.workspace,
              inputFingerprint: run.attempt.payloadHash,
              contextRefs: run.attempt.contextRefs,
              expertVersionId: run.attempt.expertVersionId,
              entryNodeStatus: run.attempt.entryNodeStatus,
            },
      ),
    };
  }

  /** Current passive conversation visibility only. Never call open() for
   * navigation and never promote an old Run.read grant to this purpose.
   */
  openRead(
    request: MemberRequest,
    rawLocator: unknown,
  ): Promise<OpenedNativeReleasedConversationRead> {
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success)
      return Promise.reject(
        new NativeReleasedConversationAuthorityError('conversation-authority-validation'),
      );
    if (
      typeof this.ports.openReadEpoch !== 'function' ||
      typeof this.ports.assertReadEpoch !== 'function'
    )
      return Promise.reject(
        new NativeReleasedConversationAuthorityError('conversation-authority-unavailable'),
      );
    try {
      this.current();
    } catch (error) {
      return Promise.reject(failure(error));
    }
    if (this.pending.size + this.owned.size >= 256)
      return Promise.reject(
        new NativeReleasedConversationAuthorityError('conversation-authority-capacity'),
      );
    const work = Promise.resolve().then(() => this.openReadNow(request, parsed.data));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }

  private async openReadNow(
    request: MemberRequest,
    locator: ExecutionRunLocator,
  ): Promise<OpenedNativeReleasedConversationRead> {
    let lease: ExecutionMemberLease | undefined;
    let releaseMember: (() => void) | undefined;
    let memberReleased = false;
    let owned: ObservedAuthority | undefined;
    const release = () => {
      if (memberReleased || !lease) return;
      memberReleased = true;
      try {
        if (!releaseMember) throw Error();
        releaseMember();
      } catch {
        this.failed = true;
      }
    };
    try {
      this.current();
      const openReadEpoch = this.ports.openReadEpoch;
      const assertReadEpoch = this.ports.assertReadEpoch;
      if (!openReadEpoch || !assertReadEpoch)
        throw new NativeReleasedConversationAuthorityError('conversation-authority-unavailable');
      lease = await this.ports.memberLease.call(this.source, request);
      if (lease && typeof lease.release === 'function') releaseMember = lease.release.bind(lease);
      if (
        !lease ||
        !id.safeParse(lease.memberId).success ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        !(lease.signal instanceof AbortSignal) ||
        lease.signal.aborted ||
        typeof lease.assertCurrent !== 'function' ||
        typeof lease.release !== 'function'
      )
        return deny();
      const member = lease;
      const memberId = member.memberId,
        expiresAt = member.expiresAt,
        memberSignal = member.signal;
      const memberAssert = member.assertCurrent,
        memberRelease = member.release;
      const initial = this.observe(locator, member, 'read');
      const controller = new AbortController(),
        drain = deferred();
      let revoked = false,
        done = false,
        readerReleased = false;
      let epoch: NativeReleasedConversationReadEpoch | undefined;
      let epochSignal: AbortSignal | undefined;
      let epochRelease: (() => void) | undefined;
      let releaseMethod: NativeReleasedConversationReadEpoch['release'] | undefined;
      let binding: NativeSessionBinding | undefined;
      let epochIdentity: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reference = (value: NativeSessionBinding): NativeBindingReference => ({
        scope: value.scope,
        nativeSessionId: value.nativeSessionId,
        nativeAgentId: value.nativeAgentId,
        selection: value.selection,
      });
      const identity = (value: NativeReleasedConversationReadEpoch) =>
        canonicalPayload({
          kind: value.kind,
          chatEpoch: value.chatEpoch,
          actorId: value.actorId,
          backendId: value.backendId,
          binding: reference(value.binding),
        });
      const finish = () => {
        if (!done || readerReleased) return;
        readerReleased = true;
        try {
          if (epoch) {
            if (!epochRelease) throw Error();
            assertion(epochRelease());
          }
          this.owned.delete(owned!);
          drain.resolve();
        } catch {
          this.failed = true;
          drain.reject(
            new NativeReleasedConversationAuthorityError('conversation-authority-unavailable'),
          );
        }
      };
      const revoke = () => {
        if (!revoked) {
          revoked = true;
          controller.abort();
          clearTimeout(timer);
          memberSignal.removeEventListener('abort', revoke);
          epochSignal?.removeEventListener('abort', revoke);
          release();
        }
        finish();
      };
      const verify = (): undefined => {
        if (
          revoked ||
          controller.signal.aborted ||
          memberSignal.aborted ||
          Date.now() >= expiresAt ||
          member.memberId !== memberId ||
          member.expiresAt !== expiresAt ||
          member.signal !== memberSignal ||
          member.assertCurrent !== memberAssert ||
          member.release !== memberRelease
        )
          return deny();
        const fresh = this.observe(locator, member, 'read');
        if (
          fresh.backend.id !== initial.backend.id ||
          fresh.backend.identity !== initial.backend.identity ||
          fresh.fingerprint !== initial.fingerprint ||
          canonicalPayload(fresh.origin) !== canonicalPayload(initial.origin) ||
          (initial.run.attempt.sessionId !== undefined &&
            fresh.run.attempt.sessionId !== initial.run.attempt.sessionId) ||
          (initial.run.attempt.executorRunId !== undefined &&
            fresh.run.attempt.executorRunId !== initial.run.attempt.executorRunId) ||
          (binding &&
            ((fresh.run.attempt.sessionId !== undefined &&
              fresh.run.attempt.sessionId !== binding.nativeSessionId) ||
              (fresh.run.attempt.executorRunId !== undefined &&
                fresh.run.attempt.executorRunId !== binding.nativeAgentId)))
        )
          return deny();
        return undefined;
      };
      const check = (action: NativeReleasedConversationAction) => {
        try {
          if (action !== 'read') return deny();
          verify();
          if (!done) return;
          if (
            !epoch ||
            epoch.signal !== epochSignal ||
            epochSignal?.aborted ||
            epoch.release !== releaseMethod ||
            identity(epoch) !== epochIdentity
          )
            return deny();
          assertion(assertReadEpoch.call(this.source, epoch));
          verify();
        } catch {
          revoke();
          return deny();
        }
      };
      owned = { drain: drain.promise, revoke, check };
      this.owned.add(owned);
      memberSignal.addEventListener('abort', revoke, { once: true });
      const expire = () => {
        const left = expiresAt - Date.now();
        if (left <= 0) revoke();
        else {
          timer = setTimeout(expire, Math.min(left, 2_147_483_647));
          timer.unref();
        }
      };
      expire();
      try {
        verify();
        epoch = await openReadEpoch.call(
          this.source,
          Object.freeze({
            origin: initial.origin,
            actorId: memberId,
            backend: Object.freeze(initial.backend),
            signal: controller.signal,
            assertCurrent: verify,
          }),
        );
        done = true;
        if (epoch && typeof epoch.release === 'function') {
          releaseMethod = epoch.release;
          epochRelease = epoch.release.bind(epoch);
        }
        verify();
        if (
          !epoch ||
          epoch.kind !== 'chat-history' ||
          !Number.isSafeInteger(epoch.chatEpoch) ||
          epoch.chatEpoch < 0 ||
          epoch.actorId !== memberId ||
          epoch.backendId !== initial.backend.id ||
          !(epoch.signal instanceof AbortSignal) ||
          !epochRelease
        )
          return deny();
        epochSignal = epoch.signal;
        binding = nativeWorkSessionBindingSchema.parse(epoch.binding);
        if (
          canonicalPayload(binding.scope) !== canonicalPayload(initial.origin) ||
          canonicalPayload(binding.selection) !== canonicalPayload(initial.run.selection)
        )
          return deny();
        epochIdentity = identity(epoch);
        epochSignal.addEventListener('abort', revoke, { once: true });
        check('read');
        const origin = Object.freeze({
          scope: Object.freeze({ ...binding.scope }),
          nativeSessionId: binding.nativeSessionId,
          nativeAgentId: binding.nativeAgentId,
          selection: Object.freeze({ ...binding.selection }),
        });
        const grant: NativeReleasedConversationReadGrant = Object.freeze({
          [readGrantBrand]: true as const,
          actorId: memberId,
          spaceId: initial.origin.spaceId,
          backendId: initial.backend.id,
          chatEpoch: epoch.chatEpoch,
          origin,
          signal: controller.signal,
          assertCurrent: check,
        });
        this.readGrants.set(grant, owned);
        return Object.freeze({ grant, dispose: revoke });
      } catch (error) {
        done = true;
        revoke();
        throw error;
      }
    } catch (error) {
      if (owned) owned.revoke();
      else release();
      throw failure(error);
    }
  }

  assertReadGrant(grant: NativeReleasedConversationReadGrant): void {
    const owned = grant && this.readGrants.get(grant);
    if (!owned) return deny();
    owned.check('read');
  }

  /** Explicit Send admission only. There is no caller-provided actor/backend,
   * grant or Run mutation, and no request-abort signal becomes its lifetime.
   */
  open(request: MemberRequest, rawLocator: unknown): Promise<OpenedNativeReleasedConversation> {
    const parsed = locatorSchema.safeParse(rawLocator);
    if (!parsed.success)
      return Promise.reject(
        new NativeReleasedConversationAuthorityError('conversation-authority-validation'),
      );
    try {
      this.current();
    } catch (error) {
      return Promise.reject(failure(error));
    }
    if (this.pending.size + this.owned.size >= 256)
      return Promise.reject(
        new NativeReleasedConversationAuthorityError('conversation-authority-capacity'),
      );
    const work = Promise.resolve().then(() => this.openNow(request, parsed.data));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }

  private async openNow(
    request: MemberRequest,
    locator: ExecutionRunLocator,
  ): Promise<OpenedNativeReleasedConversation> {
    let lease: ExecutionMemberLease | undefined;
    let releaseLease: (() => void) | undefined;
    let released = false;
    let owned: Owned | undefined;
    const release = () => {
      if (released || !lease) return;
      released = true;
      try {
        if (!releaseLease) throw Error();
        releaseLease();
      } catch {
        this.failed = true;
      }
    };
    try {
      this.current();
      lease = await this.ports.memberLease.call(this.source, request);
      if (lease && typeof lease.release === 'function') releaseLease = lease.release.bind(lease);
      if (
        !lease ||
        !id.safeParse(lease.memberId).success ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        !(lease.signal instanceof AbortSignal) ||
        lease.signal.aborted ||
        typeof lease.assertCurrent !== 'function' ||
        typeof lease.release !== 'function'
      )
        return deny();
      const member = lease;
      const memberId = member.memberId;
      const memberExpires = member.expiresAt;
      const memberSignal = member.signal;
      const memberAssert = member.assertCurrent;
      const memberRelease = member.release;
      const initial = this.observe(locator, member);
      // SDK writer identity is the native Session, even across a backend switch.
      const key = initial.run.attempt.sessionId!;
      if (this.sessions.has(key))
        throw new NativeReleasedConversationAuthorityError('conversation-authority-pending');
      const controller = new AbortController();
      const drain = deferred();
      let epoch: NativeReleasedConversationEpoch | undefined;
      let epochFingerprint: string | undefined;
      let epochSignal: AbortSignal | undefined;
      let admissionDone = false;
      let revoked = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanup: Promise<NativeReleasedConversationStop> | undefined;
      const finish = (success: boolean) => {
        if (!success) {
          this.failed = true;
          // Unknown physical ownership remains reserved and never becomes ready.
          drain.reject(
            new NativeReleasedConversationAuthorityError('conversation-authority-unavailable'),
          );
          return;
        }
        this.owned.delete(owned!);
        if (this.sessions.get(key) === owned) this.sessions.delete(key);
        drain.resolve();
      };
      const retire = (): Promise<NativeReleasedConversationStop> => {
        if (cleanup) return cleanup;
        if (!admissionDone) return Promise.resolve('pending');
        if (!epoch) {
          finish(true);
          return Promise.resolve('stopped');
        }
        const reserved = epoch;
        cleanup = Promise.resolve().then(async () => {
          // Captured ports survive fresh-source/member revocation; cleanup
          // still verifies the opaque epoch's ORIGINAL native issuer.
          const status = await this.ports.retireEpoch.call(this.source, reserved);
          if (status !== 'stopped' && status !== 'pending') throw Error();
          const settled = Promise.resolve().then(() =>
            this.ports.whenEpochSettled.call(this.source, reserved),
          );
          void settled.then(
            () => finish(true),
            () => finish(false),
          );
          if (status === 'stopped') await settled;
          return status;
        });
        void cleanup.catch(() => finish(false));
        return cleanup;
      };
      const revoke = () => {
        if (!revoked) {
          revoked = true;
          controller.abort();
          clearTimeout(timer);
          memberSignal.removeEventListener('abort', revoke);
          epochSignal?.removeEventListener('abort', revoke);
          release();
        }
        if (admissionDone) void retire().catch(() => undefined);
      };
      const verify = (): undefined => {
        if (
          revoked ||
          controller.signal.aborted ||
          memberSignal.aborted ||
          Date.now() >= memberExpires ||
          member.memberId !== memberId ||
          member.expiresAt !== memberExpires ||
          member.signal !== memberSignal ||
          member.assertCurrent !== memberAssert ||
          member.release !== memberRelease
        )
          return deny();
        const fresh = this.observe(locator, member);
        if (
          fresh.backend.id !== initial.backend.id ||
          fresh.backend.identity !== initial.backend.identity ||
          fresh.fingerprint !== initial.fingerprint ||
          canonicalPayload(fresh.origin) !== canonicalPayload(initial.origin)
        )
          return deny();
        return undefined;
      };
      const epochText = (value: NativeReleasedConversationEpoch) =>
        canonicalPayload({
          kind: value.kind,
          chatEpoch: value.chatEpoch,
          actorId: value.actorId,
          backendId: value.backendId,
          binding: value.binding,
        });
      const check = (action: NativeReleasedConversationAction) => {
        try {
          if (!['read', 'send', 'stop'].includes(action)) return deny();
          verify();
          // Durable source notifications can arrive during reservation. They
          // must recheck eligibility without inventing an already-issued epoch.
          if (!admissionDone && action === 'read') return;
          if (
            !epoch ||
            epoch.signal !== epochSignal ||
            epochSignal?.aborted ||
            epochText(epoch) !== epochFingerprint
          )
            return deny();
          assertion(this.ports.assertEpoch.call(this.source, epoch, action));
          verify();
        } catch {
          revoke();
          return deny();
        }
      };
      owned = { drain: drain.promise, check, revoke, stop: retire };
      this.owned.add(owned);
      this.sessions.set(key, owned);
      memberSignal.addEventListener('abort', revoke, { once: true });
      const expire = () => {
        const left = memberExpires - Date.now();
        if (left <= 0) revoke();
        else {
          timer = setTimeout(expire, Math.min(left, 2_147_483_647));
          timer.unref();
        }
      };
      expire();
      try {
        verify();
        epoch = await this.ports.openEpoch.call(
          this.source,
          Object.freeze({
            origin: initial.origin,
            actorId: memberId,
            backend: Object.freeze(initial.backend),
            signal: controller.signal,
            assertCurrent: verify,
          }),
        );
        admissionDone = true;
        verify();
        if (
          !epoch ||
          epoch.kind !== 'chat-only' ||
          !Number.isSafeInteger(epoch.chatEpoch) ||
          epoch.chatEpoch < 1 ||
          epoch.actorId !== memberId ||
          epoch.backendId !== initial.backend.id ||
          !(epoch.signal instanceof AbortSignal)
        )
          return deny();
        epochSignal = epoch.signal;
        const binding = nativeWorkSessionBindingSchema.parse(epoch.binding);
        if (
          canonicalPayload(binding.scope) !== canonicalPayload(initial.origin) ||
          binding.nativeSessionId !== initial.run.attempt.sessionId ||
          binding.nativeAgentId !== initial.run.attempt.executorRunId ||
          canonicalPayload(binding.selection) !== canonicalPayload(initial.run.selection)
        )
          return deny();
        if (
          binding.receipts.some(
            (item) => item.status === 'reserved' || item.status === 'unknown',
          ) ||
          (binding.resultIntent && !binding.resultIntent.cut)
        )
          throw new NativeReleasedConversationAuthorityError('conversation-authority-pending');
        const delivered = initial.run.resultDelivery;
        if (
          delivered &&
          (!binding.resultIntent ||
            binding.resultIntent.intentId !== delivered.source.intentId ||
            binding.resultIntent.callId !== delivered.source.callId ||
            binding.resultIntent.digest !== delivered.digest ||
            canonicalPayload(binding.resultIntent.cut) !== canonicalPayload(delivered.source.cut) ||
            binding.resultIntent.toolVersion !== delivered.source.toolVersion ||
            (delivered.protocolVersion === 2 &&
              (binding.resultIntent.protocolVersion !== 2 ||
                binding.resultIntent.manifestDigest !== delivered.manifestDigest)))
        )
          return deny();
        epochFingerprint = epochText(epoch);
        epochSignal.addEventListener('abort', revoke, { once: true });
        check('read');
        const origin = Object.freeze({
          scope: Object.freeze({ ...binding.scope }),
          nativeSessionId: binding.nativeSessionId,
          nativeAgentId: binding.nativeAgentId,
          selection: Object.freeze({ ...binding.selection }),
        });
        const grant: NativeReleasedConversationGrant = Object.freeze({
          [grantBrand]: true as const,
          actorId: memberId,
          spaceId: initial.origin.spaceId,
          backendId: initial.backend.id,
          chatEpoch: epoch.chatEpoch,
          origin,
          signal: controller.signal,
          assertCurrent: check,
        });
        this.grants.set(grant, owned);
        return Object.freeze({ grant, dispose: revoke });
      } catch (error) {
        admissionDone = true;
        revoke();
        throw error;
      }
    } catch (error) {
      if (owned) owned.revoke();
      else release();
      throw failure(error);
    }
  }

  assertGrant(
    grant: NativeReleasedConversationGrant,
    action: NativeReleasedConversationAction,
  ): void {
    const owned = grant && this.grants.get(grant);
    if (!owned) return deny();
    owned.check(action);
  }
  stop(grant: NativeReleasedConversationGrant): Promise<NativeReleasedConversationStop> {
    this.assertGrant(grant, 'stop');
    const owned = this.grants.get(grant)!;
    owned.revoke();
    return owned.stop().catch(() => {
      throw new NativeReleasedConversationAuthorityError('conversation-authority-unavailable');
    });
  }
  private recheck(): void {
    for (const owned of [...this.owned]) {
      try {
        owned.check('read');
      } catch {
        owned.revoke();
      }
    }
  }
  fence(): void {
    this.fenced = true;
    for (const owned of [...this.owned]) owned.revoke();
  }
  /** Fence first, then await late reservations AND actual cleanup. The Host must not
   * close the original native mapping domain before this promise resolves.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closed = deferred();
    this.closing = closed.promise;
    this.fence();
    this.sourceSignal.removeEventListener('abort', this.onAbort);
    try {
      this.unsubscribe();
    } catch {
      this.failed = true;
    }
    void (async () => {
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.owned].map((owned) => owned.drain));
      if (this.failed || results.some((result) => result.status === 'rejected'))
        throw new NativeReleasedConversationAuthorityError('conversation-authority-unavailable');
    })().then(closed.resolve, closed.reject);
    return this.closing;
  }
}
