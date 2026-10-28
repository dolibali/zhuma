import { createHash } from 'node:crypto';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  ArtifactUploadError,
  artifactFileLeaf,
  nativeOutputFileSourceSchema,
  type UploadFileRecord,
} from './artifact-files.js';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import type { ExecutionService } from './execution-service.js';
import { executionRunCompositionRequest } from './execution-run-composition.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import type {
  NativeOutputFileSource,
  NativeOutputFileReservation,
  NativePublishedFileRef,
  NativePublishedFileLease,
  NativeRunOutputFiles,
  NativeCompletedPublicationLease,
  NativeOutputFileResourceSource,
} from './native-work-session-output-file-contract.js';
import {
  NativeOutputFileByteProducer,
  outputRelativePath,
  type NativeOutputFileRead,
} from './native-work-session-output-file-source.js';
import {
  describeNativeOutputFileTool,
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
  NATIVE_OUTPUT_FILE_ERRORS,
} from './native-work-session-output-file-tool.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
const original = (value: unknown) =>
  value && (typeof value === 'object' || typeof value === 'function')
    ? (Reflect.get(value, symbols.original) ?? value)
    : value;
const argsSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).optional(),
});
const owners = new WeakMap<NativeWorkSessionService, NativeOutputFileIssuer>();
type PublicationAck = {
  readonly ok: true;
  readonly phase: 'published';
  readonly protocolVersion: 1;
  readonly publicationId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: NativeOutputFileSource;
};
type Failure = { readonly ok: false; readonly code: (typeof NATIVE_OUTPUT_FILE_ERRORS)[number] };
const ackFor = (record: UploadFileRecord): PublicationAck => {
  if (!record.producer) throw new ArtifactUploadError('publication-unavailable');
  return {
    ok: true,
    phase: 'published',
    protocolVersion: 1,
    publicationId: record.uploadId,
    name: record.name,
    mediaType: record.mediaType,
    bytes: record.byteSize,
    sha256: record.sha256,
    source: structuredClone(record.producer.source),
  };
};
const blocks = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }];
type OutputAuthority = Pick<ExecutionRunAuthorities, 'assertGrant'>;
type Execution = Pick<ExecutionService, 'readRunComposition'> & {
  createRunOutputFiles(
    authority: OutputAuthority,
    source: NativeOutputFileResourceSource,
  ): NativeRunOutputFiles;
};
type ResolveBytes = (
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
) => NativeOutputFileByteProducer;

export interface NativeOutputFileIssuer {
  registerNativeOutputFileTool(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition;
  /** Publication capability only. A later completion still verifies the original durable SDK ACK. */
  publishedFile(grant: NativeWorkGrant, publicationId: string): NativePublishedFileRef;
  readPublishedFile(grant: NativeWorkGrant, ref: NativePublishedFileRef): NativePublishedFileLease;
  /** Immutable ledger facts only; a completion must separately qualify its SDK ACK cut. */
  readCompletedPublication(
    grant: NativeWorkGrant,
    request: { readonly source: NativeOutputFileSource; readonly publicationId: string },
    signal: AbortSignal,
  ): Promise<NativeCompletedPublicationLease>;
  close(): Promise<void>;
}
/** Host-only: same original sessions/Run owner and original qualified FS, never Client factories. */
export function createNativeOutputFileIssuer(
  ctx: Context,
  sessions: NativeWorkSessionService,
  authority: OutputAuthority,
  execution: Execution,
  resolveBytes: ResolveBytes,
): NativeOutputFileIssuer {
  if (owners.has(sessions)) throw new ArtifactUploadError('publication-unavailable');
  const owner = new OutputFileOwner(ctx, sessions, authority, execution, resolveBytes);
  owners.set(sessions, owner);
  ctx.effect(() => () => owner.close());
  return owner;
}
/** Same original Run manager and sessions; a structural copy is not a publisher owner. */
export function assertNativeOutputFileIssuer(
  sessions: NativeWorkSessionService,
  authority: Pick<ExecutionRunAuthorities, 'assertGrant'>,
  issuer: NativeOutputFileIssuer,
): undefined {
  const owner = owners.get(sessions);
  if (owner !== issuer || !(owner instanceof OutputFileOwner))
    throw new ArtifactUploadError('publication-unavailable');
  return owner.assertOriginalAuthority(authority);
}
class OutputFileOwner implements NativeOutputFileIssuer {
  private readonly lifetime = new AbortController();
  private readonly sources = new Set<NativeOutputFileByteProducer>();
  private readonly jobs = new Map<
    string,
    {
      source: NativeOutputFileSource;
      selectorFingerprint: string;
      path: string;
      producer: NativeOutputFileByteProducer;
      grant: NativeWorkGrant;
    }
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly refs = new Map<string, NativePublishedFileRef>();
  private readonly issued = new WeakMap<NativePublishedFileRef, { record: UploadFileRecord }>();
  private readonly files: NativeRunOutputFiles;
  constructor(
    private readonly ctx: Context,
    private readonly sessions: NativeWorkSessionService,
    private readonly authority: OutputAuthority,
    private readonly execution: Execution,
    private readonly resolveBytes: ResolveBytes,
  ) {
    this.files = execution.createRunOutputFiles(authority, {
      signal: this.lifetime.signal,
      assertCurrent: (attachments) => {
        if (
          this.lifetime.signal.aborted ||
          original(ctx.get('attachments')) !== original(attachments)
        )
          throw new ArtifactUploadError('publication-unavailable');
        return undefined;
      },
      assertPublication: (grant, source, selectorFingerprint) => {
        const job = this.jobs.get(hash(source));
        if (
          !job ||
          job.grant !== grant ||
          job.selectorFingerprint !== selectorFingerprint ||
          canonicalPayload(job.source) !== canonicalPayload(source)
        )
          throw new ArtifactUploadError('publication-denied');
        this.binding(grant);
        return job.producer.authorize(grant, source.configurationId, job.path);
      },
    });
  }
  assertOriginalAuthority(authority: Pick<ExecutionRunAuthorities, 'assertGrant'>): undefined {
    if (
      this.authority !== authority ||
      this.lifetime.signal.aborted ||
      owners.get(this.sessions) !== this
    )
      throw new ArtifactUploadError('publication-unavailable');
    return undefined;
  }
  private binding(
    grant: NativeWorkGrant,
    access: 'send' | 'history' = 'send',
  ): NativeSessionBinding {
    this.authority.assertGrant(grant, access);
    if (this.lifetime.signal.aborted || owners.get(this.sessions) !== this)
      throw new ArtifactUploadError('cancelled');
    const binding = this.sessions.open(grant)?.binding;
    if (!binding || canonicalPayload(binding.scope) !== canonicalPayload(grant.scope))
      throw new ArtifactUploadError('publication-unavailable');
    const snapshot = this.execution.readRunComposition(grant.scope);
    const selected = Reflect.get(snapshot.payload, 'outputFilePublisherTool');
    if (
      !selected ||
      canonicalPayload(selected) !== canonicalPayload(describeNativeOutputFileTool()) ||
      !(snapshot.payload.toolAllowlist as readonly string[]).includes(NATIVE_OUTPUT_FILE_TOOL) ||
      snapshot.configurationId !== binding.selection.configurationId ||
      canonicalPayload(snapshot.payload.scope) !== canonicalPayload(binding.scope)
    )
      throw new ArtifactUploadError('publication-denied');
    return binding;
  }
  registerNativeOutputFileTool(
    ctx: Context,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): NativeDshComposition {
    const actual = this.binding(grant);
    const agent = scopeOf(ctx);
    if (
      !agent ||
      actual.nativeSessionId !== binding.nativeSessionId ||
      actual.nativeAgentId !== binding.nativeAgentId ||
      actual.selection.configurationId !== binding.selection.configurationId ||
      canonicalPayload(actual.scope) !== canonicalPayload(binding.scope)
    )
      throw new ArtifactUploadError('publication-denied');
    const producer = this.resolveBytes(binding, grant);
    if (!(producer instanceof NativeOutputFileByteProducer))
      throw new ArtifactUploadError('publication-unavailable');
    this.sources.add(producer);
    const scopeLifetime = new AbortController();
    const scopedJobs = new Set<Promise<unknown>>();
    const retainDrain = (work: Promise<void>) => {
      scopedJobs.add(work);
      this.pending.add(work);
      void work.then(
        () => {
          scopedJobs.delete(work);
          this.pending.delete(work);
        },
        () => {
          scopedJobs.delete(work);
          this.pending.delete(work);
        },
      );
    };
    ctx.effect(() => async () => {
      scopeLifetime.abort();
      await producer.close();
      while (scopedJobs.size) await Promise.allSettled([...scopedJobs]);
      this.sources.delete(producer);
    });
    const current = (exec: Readonly<ToolExecution>) => {
      const active = this.binding(grant);
      if (
        exec.signal.aborted ||
        exec.agent !== agent ||
        exec.agent?.id !== binding.nativeAgentId ||
        ctx.agents.get(exec.agent.id) !== agent ||
        active.nativeSessionId !== binding.nativeSessionId
      )
        throw new ArtifactUploadError('publication-denied');
    };
    const calls = new Map<
      ToolExecution['token'],
      { ack: PublicationAck | Failure; ref?: NativePublishedFileRef }
    >();
    ctx.on('tools/result', (exec) => {
      calls.delete(exec.token);
    });
    const descriptor = describeNativeOutputFileTool();
    ctx.tools.register({
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
      output: { schema: descriptor.outputSchema, render: (_args, value) => blocks(value) },
      execute: async (raw, exec) => {
        try {
          current(exec);
          const parsed = argsSchema.safeParse(raw);
          if (!parsed.success) throw new ArtifactUploadError('invalid-arguments');
          const path = outputRelativePath(parsed.data.path);
          const name = artifactFileLeaf(parsed.data.name ?? path.split('/').at(-1)!);
          const snapshot = this.execution.readRunComposition(grant.scope);
          const source = nativeOutputFileSourceSchema.parse({
            scope: structuredClone(grant.scope),
            nativeSessionId: binding.nativeSessionId,
            nativeAgentId: binding.nativeAgentId,
            configurationId: binding.selection.configurationId,
            expertVersionId: executionRunCompositionRequest(snapshot).expertVersionId,
            toolVersion: NATIVE_OUTPUT_FILE_VERSION,
            callId: exec.callId,
          });
          if (this.refs.size >= 4096 || this.pending.size >= 64)
            throw new ArtifactUploadError('quota-exceeded');
          const operation = this.publish(
            grant,
            source,
            path,
            name,
            producer,
            AbortSignal.any([exec.signal, scopeLifetime.signal]),
            retainDrain,
          );
          scopedJobs.add(operation);
          this.pending.add(operation);
          void operation.then(
            () => {
              scopedJobs.delete(operation);
              this.pending.delete(operation);
            },
            () => {
              scopedJobs.delete(operation);
              this.pending.delete(operation);
            },
          );
          const record = await operation;
          current(exec);
          const ref = Object.freeze({}) as NativePublishedFileRef;
          this.issued.set(ref, { record: structuredClone(record) });
          const ack = ackFor(record);
          calls.set(exec.token, { ack, ref });
          return ack;
        } catch (error) {
          const ack = this.failure(error);
          calls.set(exec.token, { ack });
          return ack;
        }
      },
      finalizeContent: (exec, result) => {
        try {
          current(exec);
          const call = calls.get(exec.token);
          if (!call || result.isError || hash(result.value) !== hash(call.ack))
            throw new ArtifactUploadError('publication-unavailable');
          if (call.ack.ok && call.ref) this.refs.set(call.ack.publicationId, call.ref);
          return blocks(call.ack);
        } catch (error) {
          return blocks(this.failure(error));
        }
      },
    } satisfies ToolDefinition);
    return { context: '', toolAllowlist: [NATIVE_OUTPUT_FILE_TOOL] };
  }
  private failure(error: unknown): Failure {
    const code = error instanceof ArtifactUploadError ? error.code : undefined;
    return {
      ok: false,
      code: NATIVE_OUTPUT_FILE_ERRORS.includes(code as Failure['code'])
        ? (code as Failure['code'])
        : 'publication-unavailable',
    };
  }
  private async publish(
    grant: NativeWorkGrant,
    source: NativeOutputFileSource,
    path: string,
    name: string,
    producer: NativeOutputFileByteProducer,
    caller: AbortSignal,
    retainDrain: (work: Promise<void>) => void,
  ): Promise<UploadFileRecord> {
    const key = hash(source),
      selectorFingerprint = hash({ path, name });
    if (this.jobs.has(key)) throw new ArtifactUploadError('conflict');
    this.jobs.set(key, { source, path, selectorFingerprint, producer, grant });
    const signal = AbortSignal.any([
      caller,
      grant.signal,
      this.lifetime.signal,
      AbortSignal.timeout(60000),
    ]);
    let permit: NativeOutputFileReservation | undefined, reading: NativeOutputFileRead | undefined;
    try {
      producer.authorize(grant, source.configurationId, path);
      try {
        permit = await this.files.reserve(
          grant,
          { mode: 'lookup', source, selectorFingerprint, name },
          signal,
        );
      } catch (error) {
        if (!(error instanceof ArtifactUploadError) || error.code !== 'not-found') throw error;
      }
      if (permit?.completed) {
        permit.check();
        return permit.completed;
      }
      reading = await producer.inspect(grant, source.configurationId, path, signal);
      permit = await this.files.reserve(
        grant,
        { mode: 'reserve', source, selectorFingerprint, name, maximumBytes: reading.maximumBytes },
        signal,
      );
      if (permit.completed) {
        permit.check();
        return permit.completed;
      }
      const content = await reading.read();
      reading.check();
      permit.check();
      const record = await permit.publish({
        mediaType: content.mediaType ?? 'application/octet-stream',
        byteSize: content.bytes.byteLength,
        sha256: content.sha256,
        data: {
          async *[Symbol.asyncIterator]() {
            yield content.bytes;
          },
        },
      });
      reading.check();
      permit.check();
      return record;
    } finally {
      reading?.close();
      const sourceDrain = reading?.drain() ?? Promise.resolve();
      permit?.releaseAfter(sourceDrain);
      retainDrain(permit?.drain ?? sourceDrain);
      this.jobs.delete(key);
    }
  }
  publishedFile(grant: NativeWorkGrant, publicationId: string): NativePublishedFileRef {
    const ref = this.refs.get(publicationId);
    if (!ref) throw new ArtifactUploadError('not-found');
    this.readPublishedFile(grant, ref).check();
    return ref;
  }
  readPublishedFile(grant: NativeWorkGrant, ref: NativePublishedFileRef): NativePublishedFileLease {
    const issued = this.issued.get(ref);
    if (!issued?.record.producer) throw new ArtifactUploadError('not-found');
    const source = issued.record.producer.source;
    const projection = { source: structuredClone(source), record: structuredClone(issued.record) };
    const fingerprint = canonicalPayload(projection);
    const check = (): undefined => {
      const binding = this.binding(grant);
      if (
        canonicalPayload(projection) !== fingerprint ||
        canonicalPayload(grant.scope) !== canonicalPayload(source.scope) ||
        binding.nativeSessionId !== source.nativeSessionId ||
        binding.nativeAgentId !== source.nativeAgentId
      )
        throw new ArtifactUploadError('publication-denied');
      // Already-published immutable metadata needs no new FS access. The later
      // completion must still qualify the original SDK ACK and fixed manifest.
      return undefined;
    };
    check();
    return Object.freeze({
      ...projection,
      signal: AbortSignal.any([grant.signal, this.lifetime.signal]),
      check,
    });
  }
  async readCompletedPublication(
    grant: NativeWorkGrant,
    request: { readonly source: NativeOutputFileSource; readonly publicationId: string },
    signal: AbortSignal,
  ): Promise<NativeCompletedPublicationLease> {
    const source = structuredClone(request.source);
    const verify = (): undefined => {
      const binding = this.binding(grant, 'history');
      if (
        canonicalPayload(binding.scope) !== canonicalPayload(source.scope) ||
        binding.nativeSessionId !== source.nativeSessionId ||
        binding.nativeAgentId !== source.nativeAgentId ||
        binding.selection.configurationId !== source.configurationId
      )
        throw new ArtifactUploadError('publication-denied');
      return undefined;
    };
    verify();
    const lease = await this.files.readCompleted(grant, { ...request, source }, signal);
    verify();
    lease.check();
    return Object.freeze({
      source: lease.source,
      record: lease.record,
      signal: lease.signal,
      check: () => {
        verify();
        return lease.check();
      },
    });
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    await Promise.all([...this.sources].map((source) => source.close()));
    this.refs.clear();
  }
}
