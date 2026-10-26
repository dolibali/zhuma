import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type { BeginRunRequest } from './execution-service.js';
import {
  assertExecutionRunCompositionBinding,
  readExecutionRunComposition,
} from './execution-run-composition.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  EXECUTION_RESOURCE_LIMITS,
  executionRunResourcesSchema,
  readExecutionRunResources,
  type ExecutionRunResourceCatalog,
} from './execution-run-resource-snapshot.js';
import { ExecutionRunError } from './execution-run-state.js';

/** Operation-scoped Host metadata, never a Run grant or an Agent resource lifetime. */
export interface ExecutionRunResourceQualification {
  readonly catalog: ExecutionRunResourceCatalog;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  release(): undefined;
}
/** Supplied only by the original installed Host. No browser representation exists. */
export interface ExecutionRunResourceCatalogHost {
  readonly signal: AbortSignal;
  prepareResourceCatalog?(
    originalRequest: MemberRequest,
    command: BeginRunRequest,
  ): Promise<ExecutionRunResourceQualification>;
}
/** The queue receives data and a current-source check, not metadata release/signal. */
export interface ExecutionRunResourceVerification {
  readonly catalog: ExecutionRunResourceCatalog;
  assertCurrent(): undefined;
}
/** An owner must retain this failed cleanup when deciding whether close drained. */
export class ExecutionRunResourceQualificationCloseError extends ExecutionRunError {
  readonly cleanupFailed = true;
  constructor() {
    super('run-authority-unavailable');
  }
}
const catalogSchema = z.strictObject({
  sourceVersion: z.literal(EXECUTION_RESOURCE_SOURCE_VERSION),
  mcp: executionRunResourcesSchema.shape.mcp,
  skills: z
    .array(
      executionRunResourcesSchema.shape.skills.element.pick({
        ref: true,
        definitionDigest: true,
        invocation: true,
        policySource: true,
      }),
    )
    .max(EXECUTION_RESOURCE_LIMITS.skills)
    .optional(),
});
function unavailable(): never {
  throw new ExecutionRunError('run-authority-unavailable');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Invoke BEFORE entering the original write queue: 145's provider itself reads
 * through that queue. The callback retains all existing member/composition/
 * workspace gates and checks this source before and after each awaited verify.
 * Source permissions and full scope are the real Host provider's responsibility;
 * these identity/shape checks do not turn metadata into authorization.
 * The owner must track this whole Promise, including late qualification release.
 */
export async function withExecutionRunResourceQualification<T>(
  input: {
    readonly host: ExecutionRunResourceCatalogHost;
    readonly ownerSignal: AbortSignal;
    readonly originalRequest: MemberRequest;
    readonly command: BeginRunRequest;
  },
  work: (verification: ExecutionRunResourceVerification | undefined) => Promise<T>,
): Promise<T> {
  const { host, ownerSignal, originalRequest, command } = input;
  const hostSignal = host.signal;
  const prepare = host.prepareResourceCatalog;
  const active = () => {
    if (
      !(hostSignal instanceof AbortSignal) ||
      !(ownerSignal instanceof AbortSignal) ||
      host.signal !== hostSignal ||
      hostSignal.aborted ||
      ownerSignal.aborted
    )
      unavailable();
  };
  active();
  const saved = readExecutionRunComposition(command.composition);
  assertExecutionRunCompositionBinding(
    saved,
    {
      ...saved.payload.scope,
      spaceId: command.spaceId,
      taskId: command.taskId,
      planId: command.planId,
      revision: command.revision,
      nodeId: command.nodeId,
      runId: command.newRunId,
      segmentId: command.newSegmentId,
    },
    command,
  );
  // Legacy / file-only Runs do not ask private package or connection sources.
  if (saved.schemaVersion !== 2 || !saved.payload.resources) {
    const result = await work(undefined);
    active();
    return result;
  }
  if (typeof prepare !== 'function') unavailable();
  const commandFingerprint = canonicalPayload(command);
  let qualification: ExecutionRunResourceQualification;
  try {
    qualification = await prepare.call(host, originalRequest, command);
  } catch {
    return unavailable();
  }
  const release = qualification?.release;
  const pendingAssertions: Promise<unknown>[] = [];
  const synchronous = (value: unknown) => {
    if (value === undefined) return;
    const pending = Promise.resolve(value);
    void pending.catch(() => undefined);
    pendingAssertions.push(pending);
    unavailable();
  };
  try {
    const signal = qualification?.signal;
    const check = qualification?.assertCurrent;
    const originalCatalog = qualification?.catalog;
    if (
      !(signal instanceof AbortSignal) ||
      typeof check !== 'function' ||
      typeof release !== 'function'
    )
      unavailable();
    const parsed = catalogSchema.safeParse(originalCatalog);
    if (!parsed.success) unavailable();
    // Apply the shared MCP uniqueness/namespace/budget rules as well as shape.
    readExecutionRunResources({
      sourceVersion: parsed.data.sourceVersion,
      skills: [],
      mcp: parsed.data.mcp,
    });
    const catalogFingerprint = canonicalPayload(originalCatalog);
    const catalog: ExecutionRunResourceCatalog = freeze({
      sourceVersion: parsed.data.sourceVersion,
      mcp: parsed.data.mcp,
      ...(parsed.data.skills === undefined ? {} : { skills: parsed.data.skills }),
    });
    const current = (): undefined => {
      try {
        active();
        if (
          host.prepareResourceCatalog !== prepare ||
          qualification.signal !== signal ||
          qualification.assertCurrent !== check ||
          qualification.release !== release ||
          qualification.catalog !== originalCatalog ||
          signal.aborted ||
          canonicalPayload(command) !== commandFingerprint ||
          canonicalPayload(originalCatalog) !== catalogFingerprint
        )
          unavailable();
        synchronous(check.call(qualification));
        return undefined;
      } catch {
        return unavailable();
      }
    };
    current();
    const result = await work(Object.freeze({ catalog, assertCurrent: current }));
    current();
    return result;
  } catch {
    return unavailable();
  } finally {
    // Invalid asynchronous assertions never authorize; still own their real end.
    await Promise.allSettled(pendingAssertions);
    if (typeof release === 'function') {
      try {
        const result: unknown = release.call(qualification);
        if (result !== undefined) {
          await Promise.resolve(result);
          throw new ExecutionRunResourceQualificationCloseError();
        }
      } catch {
        throw new ExecutionRunResourceQualificationCloseError();
      }
    } else throw new ExecutionRunResourceQualificationCloseError();
  }
}
