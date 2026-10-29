import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type { BeginRunRequest } from './execution-service.js';
import type { HostReviewPreparationRequest } from './host-run-skill-policy.js';
import type { HostReviewResourceQualification } from './host-run-resource-source.js';
import type { ExecutionReviewPreparation } from './execution-review-composition.js';
import { executionReviewScopeSchema } from './execution-review-contract.js';
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
export interface ExecutionInitialResourceQualification {
  readonly actorId: string;
  readonly catalog: ExecutionRunResourceCatalog;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  release(): void;
}
export type ExecutionInitialResourceLocator = {
  readonly spaceId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
};
/** Supplied only by the original installed Host. No browser representation exists. */
export interface ExecutionRunResourceCatalogHost {
  readonly signal: AbortSignal;
  /** The original passive fixed-review qualification; never a provisional Run or native grant. */
  prepareReviewResourceCatalog?(
    originalRequest: MemberRequest,
    query: HostReviewPreparationRequest,
    wait?: AbortSignal,
  ): Promise<HostReviewResourceQualification>;
  prepareResourceCatalog?(
    originalRequest: MemberRequest,
    command: BeginRunRequest,
  ): Promise<ExecutionRunResourceQualification>;
  /** Original member/package qualification BEFORE a composition exists. Queue-external only. */
  prepareInitialResourceCatalog?(
    originalRequest: MemberRequest,
    locator: ExecutionInitialResourceLocator,
    wait?: AbortSignal,
  ): Promise<ExecutionInitialResourceQualification>;
}
/** The queue receives data and a current-source check, not metadata release/signal. */
export interface ExecutionRunResourceVerification {
  readonly catalog: ExecutionRunResourceCatalog;
  assertCurrent(): undefined;
}
export interface ExecutionInitialResourceVerification extends ExecutionRunResourceVerification {
  readonly actorId: string;
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

/** Same original catalog/qualification rules, without inventing a provisional composition.
 * The caller owns this whole Promise, including a late provider and actual release. */
export async function withExecutionInitialResourceQualification<T>(
  input: {
    readonly host: ExecutionRunResourceCatalogHost;
    readonly ownerSignal: AbortSignal;
    readonly originalRequest: MemberRequest;
    readonly locator: ExecutionInitialResourceLocator;
  },
  work: (verified: ExecutionInitialResourceVerification) => Promise<T>,
): Promise<T> {
  const { host, ownerSignal, originalRequest, locator } = input;
  const prepare = host.prepareInitialResourceCatalog;
  const hostSignal = host.signal;
  const fingerprint = canonicalPayload(locator);
  const active = () => {
    if (
      !(hostSignal instanceof AbortSignal) ||
      !(ownerSignal instanceof AbortSignal) ||
      host.signal !== hostSignal ||
      host.prepareInitialResourceCatalog !== prepare ||
      hostSignal.aborted ||
      ownerSignal.aborted ||
      canonicalPayload(locator) !== fingerprint
    )
      unavailable();
  };
  active();
  if (typeof prepare !== 'function') unavailable();
  let qualification: ExecutionInitialResourceQualification;
  try {
    qualification = await prepare.call(
      host,
      originalRequest,
      locator,
      AbortSignal.any([ownerSignal, hostSignal]),
    );
  } catch {
    return unavailable();
  }
  const release = qualification?.release;
  const assertions: Promise<unknown>[] = [];
  try {
    const signal = qualification?.signal,
      check = qualification?.assertCurrent,
      actorId = qualification?.actorId,
      originalCatalog = qualification?.catalog;
    if (
      !(signal instanceof AbortSignal) ||
      typeof check !== 'function' ||
      typeof release !== 'function' ||
      typeof actorId !== 'string' ||
      !actorId ||
      actorId.length > 200
    )
      unavailable();
    const parsed = catalogSchema.safeParse(originalCatalog);
    if (!parsed.success) unavailable();
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
      active();
      if (
        qualification.signal !== signal ||
        signal.aborted ||
        qualification.actorId !== actorId ||
        qualification.assertCurrent !== check ||
        qualification.release !== release ||
        qualification.catalog !== originalCatalog ||
        canonicalPayload(originalCatalog) !== catalogFingerprint
      )
        unavailable();
      const result: unknown = check.call(qualification);
      if (result !== undefined) {
        const pending = Promise.resolve(result);
        void pending.catch(() => undefined);
        assertions.push(pending);
        unavailable();
      }
      return undefined;
    };
    current();
    const result = await work(Object.freeze({ actorId, catalog, assertCurrent: current }));
    current();
    return result;
  } finally {
    await Promise.allSettled(assertions);
    if (typeof release !== 'function') throw new ExecutionRunResourceQualificationCloseError();
    try {
      const result: unknown = release.call(qualification);
      if (result !== undefined) {
        await Promise.resolve(result);
        throw new ExecutionRunResourceQualificationCloseError();
      }
    } catch {
      throw new ExecutionRunResourceQualificationCloseError();
    }
  }
}

/** Queue-external qualification of the original independent review preparation.
 * It retains the original provider until actual release, including late assertions. */
export async function withExecutionReviewResourceQualification<T>(
  input: {
    readonly host: ExecutionRunResourceCatalogHost;
    readonly ownerSignal: AbortSignal;
    readonly originalRequest: MemberRequest;
    readonly query: HostReviewPreparationRequest;
  },
  work: (
    verified: ExecutionRunResourceVerification & {
      readonly preparation: ExecutionReviewPreparation;
    },
  ) => Promise<T>,
): Promise<T> {
  const { host, ownerSignal, originalRequest, query } = input;
  const prepare = host.prepareReviewResourceCatalog;
  const hostSignal = host.signal;
  const fingerprint = canonicalPayload(query);
  const active = () => {
    if (
      !(hostSignal instanceof AbortSignal) ||
      !(ownerSignal instanceof AbortSignal) ||
      host.signal !== hostSignal ||
      host.prepareReviewResourceCatalog !== prepare ||
      hostSignal.aborted ||
      ownerSignal.aborted ||
      canonicalPayload(query) !== fingerprint
    )
      unavailable();
  };
  active();
  if (typeof prepare !== 'function') unavailable();
  let qualification: HostReviewResourceQualification;
  try {
    qualification = await prepare.call(
      host,
      originalRequest,
      query,
      AbortSignal.any([ownerSignal, hostSignal]),
    );
  } catch {
    return unavailable();
  }
  const release = qualification?.release;
  const assertions: Promise<unknown>[] = [];
  try {
    const signal = qualification?.signal,
      check = qualification?.assertCurrent,
      originalCatalog = qualification?.catalog,
      originalPreparation = qualification?.preparation;
    if (
      !(signal instanceof AbortSignal) ||
      typeof check !== 'function' ||
      typeof release !== 'function'
    )
      unavailable();
    const scope = executionReviewScopeSchema.safeParse(originalPreparation?.scope);
    if (
      !scope.success ||
      canonicalPayload(scope.data.review.target) !== canonicalPayload(query.target) ||
      scope.data.review.principal.reviewerRef.id !== query.reviewerRef.id ||
      scope.data.review.principal.reviewerRef.version !== query.reviewerRef.version
    )
      unavailable();
    const parsed = catalogSchema.safeParse(originalCatalog);
    if (!parsed.success) unavailable();
    readExecutionRunResources({
      sourceVersion: parsed.data.sourceVersion,
      skills: [],
      mcp: parsed.data.mcp,
    });
    const catalogFingerprint = canonicalPayload(originalCatalog),
      preparationFingerprint = canonicalPayload(originalPreparation);
    const preparation = freeze(structuredClone(originalPreparation));
    const catalog: ExecutionRunResourceCatalog = freeze({
      sourceVersion: parsed.data.sourceVersion,
      mcp: parsed.data.mcp,
      ...(parsed.data.skills === undefined ? {} : { skills: parsed.data.skills }),
    });
    const current = (): undefined => {
      active();
      if (
        qualification.signal !== signal ||
        signal.aborted ||
        qualification.assertCurrent !== check ||
        qualification.release !== release ||
        qualification.catalog !== originalCatalog ||
        qualification.preparation !== originalPreparation ||
        canonicalPayload(originalCatalog) !== catalogFingerprint ||
        canonicalPayload(originalPreparation) !== preparationFingerprint
      )
        unavailable();
      const result: unknown = check.call(qualification);
      if (result !== undefined) {
        const pending = Promise.resolve(result);
        void pending.catch(() => undefined);
        assertions.push(pending);
        unavailable();
      }
      return undefined;
    };
    current();
    const result = await work(Object.freeze({ catalog, preparation, assertCurrent: current }));
    current();
    return result;
  } finally {
    await Promise.allSettled(assertions);
    if (typeof release !== 'function') throw new ExecutionRunResourceQualificationCloseError();
    try {
      const result: unknown = release.call(qualification);
      if (result !== undefined) {
        await Promise.resolve(result);
        throw new ExecutionRunResourceQualificationCloseError();
      }
    } catch {
      throw new ExecutionRunResourceQualificationCloseError();
    }
  }
}
