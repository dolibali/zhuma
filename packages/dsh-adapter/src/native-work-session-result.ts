import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { ToolExecution, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { canonicalPayload, validateDeliveryContent } from '@zhuma/agent-core';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import type { ExecutionService } from './execution-service.js';
import {
  readExecutionRunComposition,
  executionRunCompositionRequest,
} from './execution-run-composition.js';
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
  type NativeResultContent,
  type NativeResultSnapshot,
  type NativeResultCut,
} from './native-work-session-result-contract.js';
import type { NativeWorkResultIntent } from './native-work-session-result-intent.js';
import {
  NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  nativeResultPublicationsContentSchema,
  type NativeResultPublicationsIntent,
  type NativeResultPublicationsContent,
  type NativeFixedResultPublicationsLease,
  type NativeFixedResultPublicationsSource,
  type NativePublicationManifestEntry,
} from './native-work-session-result-publications-contract.js';
import { describeNativeResultPublicationsTool } from './native-work-session-result-publications-tool.js';
import {
  nativePublicationManifestDigest,
  nativeResultPublicationsDigest,
  nativeResultPublicationsAck,
  nativeResultPublicationsDeclaration,
  qualifyNativePublicationEvidence,
  assertNativeResultPublicationsDeclaration,
  qualifyNativeFixedPublicationsResult,
  type NativePublicationEvidence,
} from './native-work-session-result-publications-source.js';
import {
  assertNativeOutputFileIssuer,
  type NativeOutputFileIssuer,
} from './native-work-session-output-file.js';
import { artifactFileReference } from './artifact-files.js';
import { describeNativeResultTool } from './native-work-session-result-tool.js';
import {
  nativeResultAck,
  nativeResultDigest,
  assertNativeResultDeclaration,
  qualifyNativeFixedResult,
} from './native-work-session-result-source.js';
import {
  NativeReviewError,
  NATIVE_REVIEW_ERRORS,
  NATIVE_REVIEW_LIMITS,
  NATIVE_REVIEW_TOOL,
  NATIVE_REVIEW_TOOL_VERSION,
  NATIVE_REVIEW_READ_TOOL_VERSION,
  nativeReviewReadRequestSchema,
  nativeReviewReadOutputSchema,
  nativeReviewReadRef,
  parseNativeReviewArguments,
  nativeReviewScopeKey,
  type NativeReviewErrorCode,
  type NativeReviewIntent,
  type NativeReviewReadLease,
  type NativeReviewReadOutput,
  type NativeFixedReviewRef,
  type NativeFixedReviewLease,
  type NativeFixedReviewPreparation,
} from './native-work-session-review-contract.js';
import { describeNativeReviewTool } from './native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from './native-work-session-review-read.js';
import {
  nativeReviewAck,
  nativeReviewRunSource,
  nativeReviewDeclaration,
  assertNativeReviewDeclaration,
  qualifyNativeFixedReview,
} from './native-work-session-review-native-source.js';

type Authority = Pick<ExecutionRunAuthorities, 'assertGrant'>;
const address = (grant: NativeWorkGrant) => canonicalPayload(grant.scope);
const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const blocks = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
function freezeFacts<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) freezeFacts(field);
    Object.freeze(value);
  }
  return value;
}
const materializedContent = (
  content: NativeResultPublicationsContent,
  entries: readonly NativePublicationManifestEntry[],
) => ({
  ...(content.text === undefined ? {} : { text: content.text }),
  links: [...content.links],
  files: entries.map((entry) => artifactFileReference(entry.record)),
});
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
export interface NativeFixedResultPublicationsIssuer extends Omit<
  NativeFixedResultIssuer,
  'readFixedResult'
> {
  readonly v1Issuer: NativeFixedResultIssuer;
  readFixedResult(
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal,
  ): Promise<NativeFixedResultPublicationsLease>;
}
type AnyLease = NativeFixedResultLease | NativeFixedResultPublicationsLease;
export interface NativeFixedReviewIssuer {
  /** Wakeup only, never adoption, completion or ballot authority. Optional for
   * old transaction-only adapters; the automatic bridge requires this view. */
  onReviewReady?(listener: (grant: NativeWorkGrant, ref: NativeFixedReviewRef) => void): () => void;
  registerNativeReviewTools(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    beforeRetire?: () => undefined,
  ): NativeDshComposition;
  /** Actual original collection state; preparing/idle alone is not draining. */
  reviewCollectionPhase?(grant: NativeWorkGrant): 'unstarted' | 'draining' | 'ready';
  prepareFixedReview(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeFixedReviewPreparation>;
  assertFixedReview(grant: NativeWorkGrant, ref: NativeFixedReviewRef): undefined;
  readFixedReview(
    grant: NativeWorkGrant,
    ref: NativeFixedReviewRef,
    signal: AbortSignal,
  ): Promise<NativeFixedReviewLease>;
}
interface IssuedReview {
  readonly source: NativeFixedReviewLease['source'];
  readonly digest: string;
  readonly readManifestDigest: string;
  readonly drain: NativeMigrationDrain;
  readonly signal: AbortSignal;
}
/** View of the existing original owner. It never constructs a second owner or
 * creates authority; the service must already have a real review-purpose port. */
export function nativeFixedReviewIssuer(
  sessions: NativeWorkSessionService,
  runtime: NativeWorkRuntime,
): NativeFixedReviewIssuer {
  const owner = owners.get(sessions);
  if (!owner || !sessions.ownsResultRuntime(runtime))
    throw new NativeReviewError('review-unavailable');
  return {
    onReviewReady: owner.onReviewReady.bind(owner),
    registerNativeReviewTools: owner.registerNativeReviewTools.bind(owner),
    reviewCollectionPhase: owner.reviewCollectionPhase.bind(owner),
    prepareFixedReview: owner.prepareFixedReview.bind(owner),
    assertFixedReview: owner.assertFixedReview.bind(owner),
    readFixedReview: owner.readFixedReview.bind(owner),
  };
}
interface Manifest {
  readonly entries: readonly NativePublicationManifestEntry[];
  readonly digest: string;
  readonly signal: AbortSignal;
  check(): undefined;
}
type Qualified =
  | {
      readonly protocolVersion: 1;
      readonly content: NativeResultContent;
      readonly cut: NativeResultCut;
    }
  | {
      readonly protocolVersion: 2;
      readonly content: NativeResultPublicationsContent;
      readonly cut: NativeResultCut;
      readonly manifest: Manifest;
    };
interface IssuedResult {
  readonly source: NativeFixedResultSource | NativeFixedResultPublicationsSource;
  readonly digest: string;
  readonly drain: NativeMigrationDrain;
  readonly signal: AbortSignal;
  readonly manifest?: Manifest;
}

/** Same C owner/SDK runtime and original Run issuer only; no Client/DTO factory. */
export function createNativeFixedResultIssuer(
  ctx: Context,
  sessions: NativeWorkSessionService,
  runtime: NativeWorkRuntime,
  authority: Authority,
  execution: Pick<ExecutionService, 'readRunComposition'>,
): NativeFixedResultIssuer {
  const owner = createOwner(ctx, sessions, runtime, authority, execution);
  return legacyView(owner, ownerView(owner));
}
function legacyView(
  owner: NativeResultOwner,
  shared: Omit<NativeFixedResultIssuer, 'readFixedResult'>,
): NativeFixedResultIssuer {
  return {
    ...shared,
    readFixedResult: async (...args) => {
      const lease = await owner.readFixedResult(...args);
      if ('manifest' in lease) {
        lease.release();
        throw new NativeResultError('result-rejected');
      }
      return lease;
    },
  };
}
/** Explicit v2 only, sharing the original lifecycle owner and original publication issuer. */
export function createNativeFixedResultPublicationsIssuer(
  ctx: Context,
  sessions: NativeWorkSessionService,
  runtime: NativeWorkRuntime,
  authority: Authority,
  execution: Pick<ExecutionService, 'readRunComposition'>,
  publications: NativeOutputFileIssuer,
): NativeFixedResultPublicationsIssuer {
  try {
    assertNativeOutputFileIssuer(sessions, authority, publications);
  } catch {
    throw new NativeResultError('result-unavailable');
  }
  const owner = createOwner(ctx, sessions, runtime, authority, execution, publications);
  const shared = ownerView(owner);
  return {
    ...shared,
    v1Issuer: legacyView(owner, shared),
    readFixedResult: async (...args) => {
      const lease = await owner.readFixedResult(...args);
      if (!('manifest' in lease)) {
        lease.release();
        throw new NativeResultError('result-rejected');
      }
      return lease;
    },
  };
}
function ownerView(owner: NativeResultOwner): Omit<NativeFixedResultIssuer, 'readFixedResult'> {
  return {
    registerNativeResultTool: owner.registerNativeResultTool.bind(owner),
    prepareFixedResult: owner.prepareFixedResult.bind(owner),
    assertFixedResult: owner.assertFixedResult.bind(owner),
    onReady: owner.onReady.bind(owner),
    close: owner.close.bind(owner),
  };
}
function createOwner(
  ctx: Context,
  sessions: NativeWorkSessionService,
  runtime: NativeWorkRuntime,
  authority: Authority,
  execution: Pick<ExecutionService, 'readRunComposition'>,
  publications?: NativeOutputFileIssuer,
): NativeResultOwner {
  if (owners.has(sessions) || !sessions.ownsResultRuntime(runtime))
    throw new NativeResultError('result-unavailable');
  const owner = new NativeResultOwner(sessions, runtime, authority, execution, publications);
  owners.set(sessions, owner);
  ctx.effect(() => () => owner.close());
  return owner;
}

class NativeResultOwner {
  private readonly reviewListeners = new Set<
    (grant: NativeWorkGrant, ref: NativeFixedReviewRef) => void
  >();
  private readonly lifetime = new AbortController();
  private readonly issued = new WeakMap<NativeFixedResultRef, IssuedResult>();
  private readonly ready = new Map<string, NativeFixedResultRef>();
  private readonly jobs = new Map<string, Promise<NativeFixedResultPreparation>>();
  private readonly failures = new Map<string, NativeResultError>();
  private readonly listeners = new Set<
    (grant: NativeWorkGrant, ref: NativeFixedResultRef) => void
  >();
  private readonly leases = new Set<AnyLease | NativeFixedReviewLease>();
  private readonly reviewIssued = new WeakMap<NativeFixedReviewRef, IssuedReview>();
  private readonly reviewReady = new Map<string, NativeFixedReviewRef>();
  private readonly reviewJobs = new Map<string, Promise<NativeFixedReviewPreparation>>();
  private readonly reviewRetirements = new WeakMap<
    NativeWorkGrant,
    Promise<NativeMigrationDrain>
  >();
  private readonly reviewBeforeRetire = new WeakMap<NativeWorkGrant, () => undefined>();
  private readonly reviewFailures = new Map<string, NativeReviewError>();
  private pendingLeases = 0;
  constructor(
    private readonly sessions: NativeWorkSessionService,
    private readonly runtime: NativeWorkRuntime,
    private readonly authority: Authority,
    private readonly execution: Pick<ExecutionService, 'readRunComposition'>,
    private readonly publications?: NativeOutputFileIssuer,
  ) {}
  private check(grant: NativeWorkGrant): void {
    if (this.sessions.isReviewPurpose(grant)) throw new NativeResultError('result-unavailable');
    this.authority.assertGrant(grant, 'send');
    if (
      this.lifetime.signal.aborted ||
      owners.get(this.sessions) !== this ||
      !this.sessions.ownsResultRuntime(this.runtime)
    )
      throw new NativeResultError('cancelled');
  }
  private reviewCheck(grant: NativeWorkGrant) {
    if (
      this.lifetime.signal.aborted ||
      owners.get(this.sessions) !== this ||
      !this.sessions.ownsResultRuntime(this.runtime)
    )
      throw new NativeReviewError('cancelled');
    const access = this.sessions.reviewAccess(grant),
      binding = access.binding;
    const failure = this.reviewFailures.get(nativeReviewScopeKey(access.context));
    if (failure) throw failure;
    if (
      !binding ||
      binding.resultIntent ||
      canonicalPayload(binding.scope) !== canonicalPayload(access.context.scope) ||
      canonicalPayload(binding.selection) !== canonicalPayload(access.selection)
    )
      throw new NativeReviewError('review-result-rejected');
    return { ...access, binding };
  }
  private reviewCode(error: unknown): NativeReviewErrorCode {
    return error instanceof NativeReviewError ? error.code : 'review-unavailable';
  }
  registerNativeReviewTools(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
    beforeRetire?: () => undefined,
  ): NativeDshComposition {
    const active = this.reviewCheck(grant),
      agent = scopeOf(ctx);
    if (
      !agent ||
      binding.nativeSessionId !== active.binding.nativeSessionId ||
      binding.nativeAgentId !== active.binding.nativeAgentId ||
      binding.selection.configurationId !== active.binding.selection.configurationId
    )
      throw new NativeReviewError('review-result-rejected');
    if (beforeRetire) {
      if (
        typeof beforeRetire !== 'function' ||
        (this.reviewBeforeRetire.has(grant) && this.reviewBeforeRetire.get(grant) !== beforeRetire)
      )
        throw new NativeReviewError('review-unavailable');
      this.reviewBeforeRetire.set(grant, beforeRetire);
    }
    const current = (exec: Readonly<ToolExecution>) => {
      this.reviewCheck(grant);
      if (
        exec.signal.aborted ||
        exec.agent !== agent ||
        exec.agent.id !== binding.nativeAgentId ||
        ctx.agents.get(exec.agent.id) !== exec.agent
      )
        throw new NativeReviewError('cancelled');
    };
    type Reservation = Awaited<ReturnType<NativeWorkSessionService['reserveReviewRead']>>;
    const reads = new Map<
      ToolExecution['token'],
      {
        execution: Readonly<ToolExecution>;
        value: NativeReviewReadOutput;
        lease?: NativeReviewReadLease;
        reservation?: Reservation;
      }
    >();
    const completions = new Map<
      ToolExecution['token'],
      { execution: Readonly<ToolExecution>; value: unknown; intent?: NativeReviewIntent }
    >();
    const releaseRead = (token: ToolExecution['token']) => {
      const read = reads.get(token);
      reads.delete(token);
      try {
        read?.lease?.release();
      } catch {
        this.reviewFailures.set(
          nativeReviewScopeKey(active.context),
          new NativeReviewError('review-unavailable'),
        );
      } finally {
        read?.reservation?.release();
      }
    };
    ctx.effect(() => () => {
      for (const token of reads.keys()) releaseRead(token);
    });
    ctx.on(
      'tools/result',
      (exec) => {
        // Resource plugins can isolate service routing after registration.
        // Only this Agent's original SDK execution may settle its reservation;
        // a copied event borrowing an opaque token is not that execution.
        if (exec.agent !== agent || exec.agent.id !== binding.nativeAgentId) return;
        if (reads.get(exec.token)?.execution === exec) releaseRead(exec.token);
        if (completions.get(exec.token)?.execution === exec) completions.delete(exec.token);
      },
      { global: true },
    );
    ctx.on(
      'session/event',
      (session, event) => {
        const actual = ctx.agents.get(session.id);
        if (
          !actual ||
          actual !== agent ||
          session !== actual.session ||
          actual.id !== binding.nativeAgentId ||
          actual.session.id !== binding.nativeSessionId ||
          event.type !== 'turn/end' ||
          !['max-tokens', 'error'].includes(event.data.reason.kind)
        )
          return;
        try {
          // Only this live review's actual failed turn can reject its result.
          // Ordinary idle and explicit Stop/revocation keep their original paths.
          this.reviewCheck(grant);
          this.reviewFailures.set(
            nativeReviewScopeKey(active.context),
            new NativeReviewError('review-result-rejected'),
          );
        } catch {
          // A revoked/stopping review cannot publish a new failure observation.
        }
      },
      { global: true },
    );
    ctx.on(
      'agent/status',
      ({ agent: actual, status }) => {
        if (
          actual === agent &&
          actual.id === binding.nativeAgentId &&
          actual.session.id === binding.nativeSessionId &&
          ctx.agents.get(actual.id) === actual &&
          status === 'idle'
        )
          void this.prepareFixedReview(grant, this.lifetime.signal).catch(() => undefined);
      },
      { global: true },
    );
    ctx.tools.guard(() =>
      this.sessions.reviewIntent(grant) ? 'native-completion-pending' : undefined,
    );
    const readDefinition = describeNativeReviewReadTool();
    ctx.tools.register({
      name: readDefinition.name,
      description: readDefinition.description,
      parameters: readDefinition.parameters,
      output: { schema: readDefinition.outputSchema, render: (_args, value) => blocks(value) },
      execute: async (raw, exec) => {
        const failure = (code: NativeReviewErrorCode): NativeReviewReadOutput => ({
          ok: false,
          code,
        });
        let value: NativeReviewReadOutput;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), NATIVE_REVIEW_LIMITS.readTimeoutMs);
        const signal = AbortSignal.any([
          exec.signal,
          grant.signal,
          timeout.signal,
          this.lifetime.signal,
        ]);
        try {
          current(exec);
          const query = nativeReviewReadRequestSchema.safeParse(raw);
          if (!query.success) throw new NativeReviewError('invalid-arguments');
          const reservation = await this.sessions.reserveReviewRead(grant, query.data.length);
          let abandoned = false;
          const operation = (async (): Promise<NativeReviewReadOutput> => {
            let lease: NativeReviewReadLease | undefined,
              retained = false;
            try {
              signal.throwIfAborted();
              current(exec);
              const access = this.reviewCheck(grant);
              lease = await access.ports.readTarget(access.original, query.data, signal);
              signal.throwIfAborted();
              current(exec);
              reservation.check();
              lease.check();
              if (
                canonicalPayload({
                  context: lease.source.context,
                  nativeSessionId: lease.source.nativeSessionId,
                  nativeAgentId: lease.source.nativeAgentId,
                  configurationId: lease.source.configurationId,
                }) !== canonicalPayload(nativeReviewRunSource(binding, access.context)) ||
                lease.source.resourceRef !== query.data.resourceRef ||
                lease.range.offset !== query.data.offset ||
                lease.range.length > query.data.length ||
                lease.range.length !== lease.bytes.byteLength
              )
                throw new NativeReviewError('review-read-mismatch');
              if (lease.encoding !== 'utf-8')
                throw new NativeReviewError('review-unsupported-material');
              const sourceBytes = Buffer.from(lease.bytes);
              if (sourceBytes.length && query.data.offset > 0 && (sourceBytes[0]! & 0xc0) === 0x80)
                throw new NativeReviewError('review-range-invalid');
              let text: string;
              try {
                text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                  sourceBytes,
                  { stream: lease.range.offset + lease.range.length < lease.range.total },
                );
              } catch {
                throw new NativeReviewError('review-unsupported-material');
              }
              // A byte page may end inside a multi-byte character. Only expose
              // the complete decoded prefix, retaining the actual byte offset.
              const bytes = Buffer.from(text, 'utf8');
              if (sourceBytes.length && !bytes.length)
                throw new NativeReviewError('review-range-invalid');
              if (!bytes.equals(sourceBytes.subarray(0, bytes.length)))
                throw new NativeReviewError('review-read-mismatch');
              const range = { ...lease.range, length: bytes.length };
              const sha256 = createHash('sha256').update(bytes).digest('hex');
              const page = {
                ok: true,
                protocolVersion: 1,
                toolVersion: NATIVE_REVIEW_READ_TOOL_VERSION,
                callId: exec.callId,
                source: lease.source,
                range,
                encoding: 'utf-8',
                sha256,
                text,
                readRef: nativeReviewReadRef(lease.source, exec.callId, range, sha256),
              };
              if (Buffer.byteLength(JSON.stringify(page)) > NATIVE_REVIEW_LIMITS.outputBytes)
                throw new NativeReviewError('output-too-large');
              const parsed = nativeReviewReadOutputSchema.parse(page);
              signal.throwIfAborted();
              lease.check();
              current(exec);
              reservation.check();
              if (abandoned) throw new NativeReviewError('cancelled');
              reads.set(exec.token, { execution: exec, value: parsed, lease, reservation });
              retained = true;
              return parsed;
            } finally {
              if (!retained) {
                try {
                  lease?.release();
                } finally {
                  reservation.release();
                }
              }
            }
          })();
          value = await new Promise<NativeReviewReadOutput>((resolve) => {
            const abort = () => {
              abandoned = true;
              signal.removeEventListener('abort', abort);
              resolve(failure(timeout.signal.aborted ? 'read-timeout' : 'cancelled'));
            };
            signal.addEventListener('abort', abort, { once: true });
            void operation.then(
              (page) => {
                signal.removeEventListener('abort', abort);
                if (!abandoned) resolve(page);
              },
              (error: unknown) => {
                signal.removeEventListener('abort', abort);
                if (!abandoned) resolve(failure(this.reviewCode(error)));
              },
            );
            if (signal.aborted) abort();
          });
        } catch (error) {
          value = failure(
            signal.aborted
              ? timeout.signal.aborted
                ? 'read-timeout'
                : 'cancelled'
              : this.reviewCode(error),
          );
        } finally {
          clearTimeout(timer);
        }
        if (!reads.has(exec.token)) reads.set(exec.token, { execution: exec, value });
        return value;
      },
      finalizeContent: (exec, result) => {
        try {
          current(exec);
          const read = reads.get(exec.token);
          if (!read || result.isError || hash(read.value) !== hash(result.value))
            throw new NativeReviewError('review-read-mismatch');
          if (read.value.ok) {
            if (!read.lease || !read.reservation)
              throw new NativeReviewError('review-read-mismatch');
            read.lease.check();
            read.reservation.check();
            if (
              read.value.range.offset !== read.lease.range.offset ||
              read.value.range.total !== read.lease.range.total ||
              read.value.range.length > read.lease.bytes.byteLength ||
              createHash('sha256')
                .update(read.lease.bytes.subarray(0, read.value.range.length))
                .digest('hex') !== read.value.sha256 ||
              canonicalPayload(read.lease.source) !== canonicalPayload(read.value.source)
            )
              throw new NativeReviewError('review-read-mismatch');
          }
          return blocks(read.value);
        } catch (error) {
          return blocks({ ok: false, code: this.reviewCode(error) });
        }
      },
    } satisfies ToolDefinition);
    const complete = describeNativeReviewTool();
    ctx.tools.register({
      name: complete.name,
      description: complete.description,
      parameters: complete.parameters,
      output: { schema: complete.outputSchema, render: (_args, value) => blocks(value) },
      execute: async (raw, exec) => {
        let intent: NativeReviewIntent | undefined;
        try {
          current(exec);
          const requested = parseNativeReviewArguments(raw);
          const access = this.reviewCheck(grant),
            limitations = [...access.ports.unavailableRequired(access.original)];
          const snapshot = await this.sessions.readReviewSnapshot(grant, exec.signal);
          current(exec);
          if (
            snapshot.sourceBytes + NATIVE_REVIEW_LIMITS.publicFrameBytes >
            NATIVE_REVIEW_LIMITS.scanBytes
          )
            throw new NativeReviewError('output-too-large');
          const found = nativeReviewDeclaration(
            snapshot,
            binding,
            access.context,
            exec.callId,
            limitations,
          );
          if (!found || canonicalPayload(found.content) !== canonicalPayload(requested))
            throw new NativeReviewError('review-result-rejected');
          intent = {
            protocolVersion: 1,
            toolVersion: NATIVE_REVIEW_TOOL_VERSION,
            intentId: randomUUID(),
            callId: exec.callId,
            digest: found.digest,
            readManifestDigest: found.readManifestDigest,
          };
          const declaring = intent;
          await this.sessions.declareReviewIntent(grant, declaring, (currentSnapshot) => {
            if (
              !('sourceBytes' in currentSnapshot) ||
              typeof currentSnapshot.sourceBytes !== 'number' ||
              currentSnapshot.sourceBytes + NATIVE_REVIEW_LIMITS.publicFrameBytes >
                NATIVE_REVIEW_LIMITS.scanBytes
            )
              throw new NativeReviewError('output-too-large');
            return assertNativeReviewDeclaration(
              currentSnapshot,
              binding,
              access.context,
              declaring,
              [...this.reviewCheck(grant).ports.unavailableRequired(access.original)],
            );
          });
          current(exec);
          const value = nativeReviewAck(binding, access.context, intent);
          completions.set(exec.token, { execution: exec, value, intent });
          exec.concludeTurn();
          return value;
        } catch (error) {
          if (intent)
            await this.sessions.clearReviewIntent(grant, intent.intentId).catch(() => undefined);
          const value = { ok: false, code: this.reviewCode(error) };
          completions.set(exec.token, { execution: exec, value });
          return value;
        }
      },
      finalizeContent: (exec, result) => {
        const call = completions.get(exec.token);
        try {
          current(exec);
          if (!call || result.isError || hash(call.value) !== hash(result.value))
            throw new NativeReviewError('review-result-rejected');
          if (call.intent && this.sessions.reviewIntent(grant)?.intentId !== call.intent.intentId)
            throw new NativeReviewError('review-result-rejected');
          return blocks(call.value);
        } catch (error) {
          if (call?.intent)
            void this.sessions
              .clearReviewIntent(grant, call.intent.intentId)
              .catch(() => undefined);
          return blocks({ ok: false, code: this.reviewCode(error) });
        }
      },
    } satisfies ToolDefinition);
    return { context: '', toolAllowlist: [readDefinition.name, complete.name] };
  }

  reviewCollectionPhase(grant: NativeWorkGrant): 'unstarted' | 'draining' | 'ready' {
    const access = this.reviewCheck(grant);
    if (this.reviewReady.has(nativeReviewScopeKey(access.context))) return 'ready';
    return this.reviewRetirements.has(grant) ? 'draining' : 'unstarted';
  }
  async prepareFixedReview(
    grant: NativeWorkGrant,
    signal: AbortSignal,
  ): Promise<NativeFixedReviewPreparation> {
    const access = this.reviewCheck(grant),
      key = nativeReviewScopeKey(access.context);
    if (signal.aborted) throw new NativeReviewError('cancelled');
    const cached = this.reviewReady.get(key);
    if (cached) {
      this.assertFixedReview(grant, cached);
      return { status: 'ready', ref: cached };
    }
    const intent = this.sessions.reviewIntent(grant);
    if (!intent) return { status: 'pending', reason: 'not-declared' };
    if (
      this.runtime.isConnected(access.binding.nativeSessionId) &&
      this.runtime.status(access.binding.nativeSessionId) !== 'idle'
    )
      return { status: 'pending', reason: 'running' };
    let work = this.reviewJobs.get(key);
    if (!work) {
      if (
        this.jobs.size + this.reviewJobs.size >= NATIVE_RESULT_LIMITS.readers ||
        this.ready.size + this.reviewReady.size >= 4096
      )
        throw new NativeReviewError('review-capacity');
      work = this.collectReview(grant, access.binding, intent);
      this.reviewJobs.set(key, work);
      const owned = work;
      void owned
        .finally(() => {
          if (this.reviewJobs.get(key) === owned) this.reviewJobs.delete(key);
        })
        .catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      const pending = new Promise<NativeFixedReviewPreparation>((resolve) => {
        abort = () => resolve({ status: 'pending', reason: 'draining' });
        timer = setTimeout(abort, NATIVE_REVIEW_LIMITS.waitMs);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([work, pending]);
      this.reviewCheck(grant);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  private async collectReview(
    grant: NativeWorkGrant,
    binding: NativeSessionBinding,
    intent: NativeReviewIntent,
  ): Promise<NativeFixedReviewPreparation> {
    const access = this.reviewCheck(grant),
      signal = AbortSignal.any([grant.signal, this.lifetime.signal]);
    await this.sessions.whenInputReadsIdle(grant.scope);
    this.reviewCheck(grant);
    const before = await this.sessions.readReviewSnapshot(grant, signal);
    const limitations = () => {
      const fresh = this.reviewCheck(grant);
      return [...fresh.ports.unavailableRequired(fresh.original)];
    };
    const candidate = qualifyNativeFixedReview(
      before,
      binding,
      access.context,
      intent,
      limitations(),
    );
    if (!candidate) return { status: 'pending', reason: 'not-durable' };
    before.check();
    const check = this.reviewBeforeRetire.get(grant);
    if (check) {
      const result: unknown = check();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new NativeReviewError('review-unavailable');
      }
    }
    this.reviewCheck(grant);
    const retiring = this.runtime.retire(binding.nativeSessionId, signal);
    this.reviewRetirements.set(grant, retiring);
    const drain = await retiring;
    this.reviewCheck(grant);
    drain.assertCurrent();
    if (drain.basis !== 'flushed-and-closed') throw new NativeReviewError('review-result-rejected');
    const snapshot = await this.sessions.readReviewSnapshot(grant, signal);
    const fixed = qualifyNativeFixedReview(
      snapshot,
      binding,
      access.context,
      intent,
      limitations(),
    );
    if (
      !fixed ||
      fixed.digest !== candidate.digest ||
      fixed.readManifestDigest !== candidate.readManifestDigest ||
      fixed.cut.callSeq !== candidate.cut.callSeq ||
      fixed.cut.resultSeq !== candidate.cut.resultSeq ||
      fixed.cut.turnEndSeq !== candidate.cut.turnEndSeq
    )
      throw new NativeReviewError('review-result-rejected');
    await this.sessions.sealReviewIntent(grant, intent.intentId, fixed.cut, () => {
      this.reviewCheck(grant);
      drain.assertCurrent();
      snapshot.check();
      return undefined;
    });
    this.reviewCheck(grant);
    drain.assertCurrent();
    snapshot.check();
    const source = freezeFacts({
      ...nativeReviewRunSource(binding, access.context),
      toolVersion: NATIVE_REVIEW_TOOL_VERSION,
      intentId: intent.intentId,
      callId: intent.callId,
      cut: fixed.cut,
      readManifestDigest: intent.readManifestDigest,
    } satisfies NativeFixedReviewLease['source']);
    // This cast only brands an object actually inserted into this original
    // owner's WeakMap. No parsed/serialized object can pass the lookup.
    const ref = Object.freeze({}) as NativeFixedReviewRef;
    const issued = {
      source,
      digest: intent.digest,
      readManifestDigest: intent.readManifestDigest,
      drain,
      signal: AbortSignal.any([signal, drain.signal]),
    };
    this.reviewIssued.set(ref, issued);
    this.assertFixedReview(grant, ref);
    const key = nativeReviewScopeKey(access.context);
    this.reviewReady.set(key, ref);
    issued.signal.addEventListener(
      'abort',
      () => {
        if (this.reviewReady.get(key) === ref) this.reviewReady.delete(key);
      },
      { once: true },
    );
    for (const listener of this.reviewListeners) {
      try {
        const pending: unknown = listener(grant, ref);
        void Promise.resolve(pending).catch(() => undefined);
      } catch {
        // This is only a wakeup. It cannot change the fixed owner/ref or ballot.
      }
    }
    return { status: 'ready', ref };
  }
  onReviewReady(listener: (grant: NativeWorkGrant, ref: NativeFixedReviewRef) => void) {
    if (this.lifetime.signal.aborted || this.reviewListeners.size >= 64)
      throw new NativeReviewError('review-unavailable');
    this.reviewListeners.add(listener);
    return () => {
      this.reviewListeners.delete(listener);
    };
  }
  assertFixedReview(grant: NativeWorkGrant, ref: NativeFixedReviewRef): undefined {
    const access = this.reviewCheck(grant),
      issued = this.reviewIssued.get(ref);
    if (!issued) throw new NativeReviewError('review-result-rejected');
    if (issued.signal.aborted) throw new NativeReviewError('cancelled');
    const intent = this.sessions.reviewIntent(grant);
    if (
      canonicalPayload(nativeReviewRunSource(access.binding, access.context)) !==
        canonicalPayload({
          context: issued.source.context,
          nativeSessionId: issued.source.nativeSessionId,
          nativeAgentId: issued.source.nativeAgentId,
          configurationId: issued.source.configurationId,
        }) ||
      intent?.intentId !== issued.source.intentId ||
      intent.callId !== issued.source.callId ||
      intent.digest !== issued.digest ||
      intent.readManifestDigest !== issued.readManifestDigest ||
      canonicalPayload(intent.cut) !== canonicalPayload(issued.source.cut)
    )
      throw new NativeReviewError('review-result-rejected');
    issued.drain.assertCurrent();
    return undefined;
  }
  async readFixedReview(
    grant: NativeWorkGrant,
    ref: NativeFixedReviewRef,
    signal: AbortSignal,
  ): Promise<NativeFixedReviewLease> {
    this.assertFixedReview(grant, ref);
    if (signal.aborted) throw new NativeReviewError('cancelled');
    if (this.leases.size + this.pendingLeases >= NATIVE_RESULT_LIMITS.readers)
      throw new NativeReviewError('review-capacity');
    this.pendingLeases++;
    try {
      const issued = this.reviewIssued.get(ref)!,
        combined = AbortSignal.any([signal, issued.signal]);
      const access = this.reviewCheck(grant),
        snapshot = await this.sessions.readReviewSnapshot(grant, combined);
      this.assertFixedReview(grant, ref);
      const fixed = qualifyNativeFixedReview(
        snapshot,
        access.binding,
        access.context,
        this.sessions.reviewIntent(grant)!,
        [...access.ports.unavailableRequired(access.original)],
      );
      if (
        !fixed ||
        fixed.digest !== issued.digest ||
        fixed.readManifestDigest !== issued.readManifestDigest
      )
        throw new NativeReviewError('review-result-rejected');
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        combined.removeEventListener('abort', release);
        this.leases.delete(lease);
      };
      const source = freezeFacts(structuredClone(issued.source));
      const lease: NativeFixedReviewLease = Object.freeze({
        source,
        content: freezeFacts(fixed.content),
        readManifest: freezeFacts(fixed.readManifest),
        digest: issued.digest,
        readManifestDigest: issued.readManifestDigest,
        provenanceFingerprint: hash({
          source,
          digest: issued.digest,
          readManifestDigest: issued.readManifestDigest,
        }),
        signal: combined,
        release,
        check: () => {
          if (released || combined.aborted) throw new NativeReviewError('cancelled');
          this.assertFixedReview(grant, ref);
          snapshot.check();
        },
      });
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
      this.pendingLeases--;
    }
  }
  private binding(
    grant: NativeWorkGrant,
  ): NativeSessionBinding & { readonly resultProtocol: 1 | 2 } {
    this.check(grant);
    const binding = this.sessions.open(grant)?.binding;
    if (!binding || canonicalPayload(binding.scope) !== address(grant))
      throw new NativeResultError('result-unavailable');
    const snapshot = readExecutionRunComposition(this.execution.readRunComposition(grant.scope));
    this.check(grant);
    const descriptor =
      'resultIntentTool' in snapshot.payload
        ? canonicalPayload(snapshot.payload.resultIntentTool)
        : undefined;
    const resultProtocol =
      descriptor === canonicalPayload(describeNativeResultTool())
        ? 1
        : this.publications &&
            descriptor === canonicalPayload(describeNativeResultPublicationsTool())
          ? 2
          : undefined;
    if (
      snapshot.configurationId !== binding.selection.configurationId ||
      canonicalPayload(snapshot.payload.scope) !== address(grant) ||
      resultProtocol === undefined ||
      (binding.resultIntent !== undefined &&
        binding.resultIntent.protocolVersion !== resultProtocol)
    )
      throw new NativeResultError('result-unavailable');
    if (resultProtocol === 2) {
      try {
        assertNativeOutputFileIssuer(this.sessions, this.authority, this.publications!);
      } catch {
        throw new NativeResultError('result-unavailable');
      }
    }
    return { ...binding, resultProtocol };
  }
  private code(error: unknown): NativeResultErrorCode {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return NATIVE_RESULT_ERRORS.includes(code as NativeResultErrorCode)
      ? (code as NativeResultErrorCode)
      : 'result-unavailable';
  }
  private ack(binding: NativeSessionBinding, intent: NativeWorkResultIntent) {
    return intent.protocolVersion === 1
      ? nativeResultAck(binding, intent)
      : nativeResultPublicationsAck(binding, intent);
  }
  private async manifest(
    grant: NativeWorkGrant,
    evidence: readonly NativePublicationEvidence[],
    signal: AbortSignal,
  ): Promise<Manifest> {
    if (!this.publications) throw new NativeResultError('result-unavailable');
    this.check(grant);
    const leases = await Promise.all(
      evidence.map((item) =>
        this.publications!.readCompletedPublication(
          grant,
          { source: item.source, publicationId: item.publicationId },
          signal,
        ),
      ),
    );
    const entries = evidence.map((item, index): NativePublicationManifestEntry => {
      const lease = leases[index]!;
      lease.check();
      const record = lease.record;
      if (
        !record.producer ||
        record.state !== 'completed' ||
        record.uploadId !== item.publicationId ||
        record.name !== item.name ||
        record.mediaType !== item.mediaType ||
        record.byteSize !== item.byteSize ||
        record.sha256 !== item.sha256 ||
        canonicalPayload(record.producer.source) !== canonicalPayload(item.source) ||
        record.producer.selectorFingerprint !== item.selectorFingerprint
      )
        throw new NativeResultError('result-rejected');
      return { evidence: structuredClone(item), record: structuredClone(record) };
    });
    const fingerprint = canonicalPayload(entries);
    const combined = AbortSignal.any([signal, ...leases.map((lease) => lease.signal)]);
    const check = (): undefined => {
      this.check(grant);
      if (combined.aborted) throw new NativeResultError('cancelled');
      for (const lease of leases) lease.check();
      if (canonicalPayload(entries) !== fingerprint) throw new NativeResultError('result-rejected');
      return undefined;
    };
    check();
    return { entries, digest: nativePublicationManifestDigest(entries), signal: combined, check };
  }
  private async declaration(
    grant: NativeWorkGrant,
    binding: NativeSessionBinding,
    raw: unknown,
    callId: string,
    signal: AbortSignal,
  ): Promise<{
    intent: NativeWorkResultIntent;
    validate(snapshot: NativeResultSnapshot): undefined;
  }> {
    if (this.binding(grant).resultProtocol === 1) {
      const parsed = nativeResultContentSchema.safeParse(raw);
      if (!parsed.success) throw new NativeResultError('invalid-arguments');
      const intent: NativeResultIntent = {
        protocolVersion: 1,
        toolVersion: NATIVE_RESULT_TOOL_VERSION,
        intentId: randomUUID(),
        callId,
        digest: nativeResultDigest(parsed.data),
      };
      return { intent, validate: (snapshot) => assertNativeResultDeclaration(snapshot, intent) };
    }
    const parsed = nativeResultPublicationsContentSchema.safeParse(raw);
    if (!parsed.success) throw new NativeResultError('invalid-arguments');
    const snapshot = await this.sessions.readResultSnapshot(grant, signal);
    this.check(grant);
    const found = nativeResultPublicationsDeclaration(snapshot, callId);
    if (!found || canonicalPayload(found.content) !== canonicalPayload(parsed.data))
      throw new NativeResultError('result-rejected');
    if (snapshot.hasPending) throw new NativeResultError('input-pending');
    const expert = executionRunCompositionRequest(
      this.execution.readRunComposition(grant.scope),
    ).expertVersionId;
    const evidence = qualifyNativePublicationEvidence(
      snapshot,
      binding,
      found.content,
      found.call.seq,
      expert,
    );
    const manifest = await this.manifest(grant, evidence, signal);
    snapshot.check();
    manifest.check();
    if (!validateDeliveryContent(materializedContent(parsed.data, manifest.entries)).ok)
      throw new NativeResultError('invalid-arguments');
    const intent: NativeResultPublicationsIntent = {
      protocolVersion: 2,
      toolVersion: NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
      intentId: randomUUID(),
      callId,
      manifestDigest: manifest.digest,
      digest: nativeResultPublicationsDigest(parsed.data, manifest.digest),
    };
    return {
      intent,
      validate: (current) => {
        assertNativeResultPublicationsDeclaration(current, intent);
        const declaration = nativeResultPublicationsDeclaration(current, callId)!;
        const actual = qualifyNativePublicationEvidence(
          current,
          this.binding(grant),
          declaration.content,
          declaration.call.seq,
          expert,
        );
        if (canonicalPayload(actual) !== canonicalPayload(evidence))
          throw new NativeResultError('result-rejected');
        manifest.check();
        current.check();
        return undefined;
      },
    };
  }
  private async qualify(
    grant: NativeWorkGrant,
    snapshot: NativeResultSnapshot,
    binding: NativeSessionBinding,
    intent: NativeWorkResultIntent,
    signal: AbortSignal,
  ): Promise<Qualified | undefined> {
    if (intent.protocolVersion === 1) {
      const fixed = qualifyNativeFixedResult(snapshot, binding, intent);
      return fixed ? { protocolVersion: 1, ...fixed } : undefined;
    }
    const expert = executionRunCompositionRequest(
      this.execution.readRunComposition(grant.scope),
    ).expertVersionId;
    const fixed = qualifyNativeFixedPublicationsResult(snapshot, binding, intent, expert);
    if (!fixed) return undefined;
    const manifest = await this.manifest(grant, fixed.evidence, signal);
    if (manifest.digest !== intent.manifestDigest) throw new NativeResultError('result-rejected');
    if (!validateDeliveryContent(materializedContent(fixed.content, manifest.entries)).ok)
      throw new NativeResultError('result-rejected');
    return { protocolVersion: 2, content: fixed.content, cut: fixed.cut, manifest };
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
          readonly intent: NativeWorkResultIntent;
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
    const definition =
      active.resultProtocol === 2
        ? describeNativeResultPublicationsTool()
        : describeNativeResultTool();
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: { schema: definition.outputSchema, render: (_args, value) => blocks(value) },
      execute: async (raw, exec) => {
        let intent: NativeWorkResultIntent | undefined;
        try {
          current(exec);
          const declaration = await this.declaration(grant, binding, raw, exec.callId, exec.signal);
          intent = declaration.intent;
          await this.sessions.declareResultIntent(grant, intent, declaration.validate);
          this.failures.delete(address(grant));
          current(exec);
          const ack = this.ack(binding, intent);
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
          const ack = this.ack(binding, call.intent);
          if (
            hash(ack) !== call.ackDigest ||
            hash(result.value) !== call.ackDigest ||
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
      if (this.jobs.size + this.reviewJobs.size >= NATIVE_RESULT_LIMITS.readers)
        throw new NativeResultError('capacity');
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
      const candidate = await this.qualify(grant, before, initial, intent, signal);
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
      const fixed = await this.qualify(grant, snapshot, initial, intent, signal);
      if (
        !fixed ||
        fixed.protocolVersion !== candidate.protocolVersion ||
        fixed.cut.callSeq !== candidate.cut.callSeq ||
        fixed.cut.resultSeq !== candidate.cut.resultSeq ||
        fixed.cut.turnEndSeq !== candidate.cut.turnEndSeq
      )
        throw new NativeResultError('result-rejected');
      const assertSource = () => {
        this.check(grant);
        snapshot.check();
        drain.assertCurrent();
        return undefined;
      };
      const binding = initial.resultIntent?.cut
        ? await this.sessions.readSealedResultIntent(
            grant,
            intent.intentId,
            fixed.cut,
            assertSource,
          )
        : await this.sessions.sealResultIntent(grant, intent.intentId, fixed.cut, assertSource);
      this.check(grant);
      drain.assertCurrent();
      snapshot.check();
      const base = {
        scope: structuredClone(binding.scope),
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
        configurationId: binding.selection.configurationId,
      };
      const tail = { intentId: intent.intentId, callId: intent.callId, cut: fixed.cut };
      const source: NativeFixedResultSource | NativeFixedResultPublicationsSource =
        intent.protocolVersion === 1
          ? { ...base, toolVersion: NATIVE_RESULT_TOOL_VERSION, ...tail }
          : {
              ...base,
              toolVersion: NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
              ...tail,
              manifestDigest: intent.manifestDigest,
              expertVersionId: executionRunCompositionRequest(
                this.execution.readRunComposition(grant.scope),
              ).expertVersionId,
            };
      const ref = Object.freeze({}) as NativeFixedResultRef;
      this.issued.set(ref, {
        source,
        digest: intent.digest,
        drain,
        signal: AbortSignal.any([
          signal,
          drain.signal,
          ...(fixed.protocolVersion === 2 ? [fixed.manifest.signal] : []),
        ]),
        ...(fixed.protocolVersion === 2 ? { manifest: fixed.manifest } : {}),
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
    if (issued.source.toolVersion === NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION) {
      if (
        binding.resultIntent.protocolVersion !== 2 ||
        binding.resultIntent.manifestDigest !== issued.source.manifestDigest ||
        issued.manifest?.digest !== issued.source.manifestDigest ||
        issued.source.expertVersionId !==
          executionRunCompositionRequest(this.execution.readRunComposition(grant.scope))
            .expertVersionId
      )
        throw new NativeResultError('result-rejected');
      issued.manifest.check();
    } else if (binding.resultIntent.protocolVersion !== 1 || issued.manifest)
      throw new NativeResultError('result-rejected');
    issued.drain.assertCurrent();
    return undefined;
  }

  async readFixedResult(
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal,
  ): Promise<AnyLease> {
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
      const fixed = await this.qualify(grant, snapshot, binding, binding.resultIntent!, combined);
      if (
        !fixed ||
        (fixed.protocolVersion === 1
          ? nativeResultDigest(fixed.content)
          : nativeResultPublicationsDigest(fixed.content, fixed.manifest.digest)) !== issued.digest
      )
        throw new NativeResultError('result-rejected');
      let released = false;
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
      const shared = {
        digest: issued.digest,
        provenanceFingerprint: hash({ source, digest: issued.digest }),
        signal: combined,
        check: () => {
          if (released || combined.aborted) throw new NativeResultError('cancelled');
          this.assertFixedResult(grant, ref);
          snapshot.check();
          if (fixed.protocolVersion === 2) fixed.manifest.check();
        },
        release,
      };
      let lease: AnyLease;
      if (fixed.protocolVersion === 1 && source.toolVersion === NATIVE_RESULT_TOOL_VERSION) {
        lease = {
          source,
          content: Object.freeze({
            ...fixed.content,
            links: Object.freeze([...fixed.content.links]),
          }),
          ...shared,
        };
      } else if (
        fixed.protocolVersion === 2 &&
        source.toolVersion === NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION
      ) {
        if (fixed.manifest.digest !== source.manifestDigest)
          throw new NativeResultError('result-rejected');
        lease = Object.freeze({
          ...shared,
          source,
          content: freezeFacts(materializedContent(fixed.content, fixed.manifest.entries)),
          manifest: freezeFacts(structuredClone(fixed.manifest.entries)),
          manifestDigest: fixed.manifest.digest,
        });
      } else throw new NativeResultError('result-rejected');
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
    this.reviewListeners.clear();
    this.ready.clear();
    this.failures.clear();
    this.reviewReady.clear();
    this.reviewFailures.clear();
    await Promise.allSettled([...this.jobs.values(), ...this.reviewJobs.values()]);
  }
}
