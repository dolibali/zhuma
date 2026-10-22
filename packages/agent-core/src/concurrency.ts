export const COLLABORATION_OBJECT_TYPES = [
  'project',
  'task',
  'workflow-version',
  'node',
  'run',
  'artifact-version',
  'review-round',
  'comment',
  'feedback-batch',
  'inbox-item',
] as const;

export type CollaborationObjectType = (typeof COLLABORATION_OBJECT_TYPES)[number];

export interface ObjectRef {
  readonly type: CollaborationObjectType;
  readonly id: string;
}

export interface CommandEnvelope<TPayload> {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly expectedVersion: number;
  readonly payload: TPayload;
}

export interface StoredCommand<TResult> {
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly objectId: string;
  readonly version: number;
  readonly result: TResult;
}

export type CommandDecision<TResult> =
  | { readonly status: 'applied'; readonly version: number; readonly result: TResult }
  | { readonly status: 'replayed'; readonly version: number; readonly result: TResult }
  | {
      readonly status: 'conflict';
      readonly currentVersion: number;
      readonly expectedVersion: number;
      readonly reason: 'version-mismatch';
    }
  | { readonly status: 'idempotency-mismatch'; readonly idempotencyKey: string }
  | { readonly status: 'rejected'; readonly code: string; readonly version: number }
  | { readonly status: 'ignored'; readonly code: string; readonly version: number };

export type ApplyDisposition<TResult> =
  | { readonly disposition: 'accept'; readonly result: TResult }
  | { readonly disposition: 'reject'; readonly code: string }
  | { readonly disposition: 'ignore'; readonly code: string };

export interface DomainEvent<TPayload = unknown> {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly object: ObjectRef;
  readonly type: string;
  readonly payload: TPayload;
  readonly runId?: string;
}

const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Stable JSON text for idempotency comparison. Not a secret hash. */
export function canonicalPayload(value: unknown): string {
  return JSON.stringify(normalizePayload(value));
}

function normalizePayload(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers cannot be command payloads.');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined)
        throw new Error('Undefined array entries cannot be command payloads.');
      return normalizePayload(item);
    });
  }
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) normalized[key] = normalizePayload(child);
    }
    return normalized;
  }
  throw new Error('Unsupported command payload.');
}

function envelopeError(envelope: CommandEnvelope<unknown>): string | undefined {
  if (isBlank(envelope.idempotencyKey) || isBlank(envelope.actorId) || isBlank(envelope.objectId)) {
    return 'invalid-command';
  }
  if (!Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0) {
    return 'invalid-command';
  }
  return undefined;
}

/**
 * Compare-and-set plus idempotency. Only an accepted apply is stored.
 * Version conflicts are not stored, so the caller can retry the same key
 * after reloading. A stored key is not applied twice.
 */
export function decideCommand<TResult>(input: {
  readonly envelope: CommandEnvelope<unknown>;
  readonly currentVersion: number;
  readonly stored: readonly StoredCommand<TResult>[];
  readonly apply: (nextVersion: number) => ApplyDisposition<TResult>;
}): {
  readonly decision: CommandDecision<TResult>;
  readonly stored: readonly StoredCommand<TResult>[];
  readonly version: number;
} {
  const invalid = envelopeError(input.envelope);
  if (invalid) {
    return {
      decision: { status: 'rejected', code: invalid, version: input.currentVersion },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  const fingerprint = canonicalPayload(input.envelope.payload);
  const existing = input.stored.find(
    (item) => item.idempotencyKey === input.envelope.idempotencyKey,
  );
  if (existing) {
    if (
      existing.objectId !== input.envelope.objectId ||
      existing.payloadFingerprint !== fingerprint
    ) {
      return {
        decision: {
          status: 'idempotency-mismatch',
          idempotencyKey: input.envelope.idempotencyKey,
        },
        stored: input.stored,
        version: input.currentVersion,
      };
    }
    return {
      decision: { status: 'replayed', version: existing.version, result: existing.result },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  if (input.envelope.expectedVersion !== input.currentVersion) {
    return {
      decision: {
        status: 'conflict',
        currentVersion: input.currentVersion,
        expectedVersion: input.envelope.expectedVersion,
        reason: 'version-mismatch',
      },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  if (!Number.isSafeInteger(input.currentVersion + 1)) {
    return {
      decision: { status: 'rejected', code: 'version-overflow', version: input.currentVersion },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  const nextVersion = input.currentVersion + 1;
  const applied = input.apply(nextVersion);
  if (applied.disposition === 'reject') {
    return {
      decision: { status: 'rejected', code: applied.code, version: input.currentVersion },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  if (applied.disposition === 'ignore') {
    return {
      decision: { status: 'ignored', code: applied.code, version: input.currentVersion },
      stored: input.stored,
      version: input.currentVersion,
    };
  }
  const record: StoredCommand<TResult> = {
    idempotencyKey: input.envelope.idempotencyKey,
    payloadFingerprint: fingerprint,
    objectId: input.envelope.objectId,
    version: nextVersion,
    result: applied.result,
  };
  return {
    decision: { status: 'applied', version: nextVersion, result: applied.result },
    stored: [...input.stored, record],
    version: nextVersion,
  };
}

export type EventAppendResult<TPayload> =
  | { readonly ok: true; readonly log: readonly DomainEvent<TPayload>[] }
  | {
      readonly ok: false;
      readonly code: 'duplicate-event' | 'non-monotonic-sequence' | 'invalid-event';
    };

function eventError<TPayload>(event: DomainEvent<TPayload>): 'invalid-event' | undefined {
  if (
    isBlank(event.eventId) ||
    isBlank(event.actorId) ||
    isBlank(event.type) ||
    isBlank(event.object.id) ||
    !COLLABORATION_OBJECT_TYPES.includes(event.object.type)
  ) {
    return 'invalid-event';
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return 'invalid-event';
  if (!TIMESTAMP_PREFIX.test(event.occurredAt)) return 'invalid-event';
  if (event.runId !== undefined && isBlank(event.runId)) return 'invalid-event';
  return undefined;
}

/** Append one fact. Duplicate ids and rewound sequences are refused. */
export function appendDomainEvent<TPayload>(
  log: readonly DomainEvent<TPayload>[],
  event: DomainEvent<TPayload>,
): EventAppendResult<TPayload> {
  if (eventError(event)) return { ok: false, code: 'invalid-event' };
  if (log.some((item) => item.eventId === event.eventId))
    return { ok: false, code: 'duplicate-event' };
  const lastSequence = log.reduce((max, item) => Math.max(max, item.sequence), 0);
  if (event.sequence <= lastSequence) return { ok: false, code: 'non-monotonic-sequence' };
  return { ok: true, log: [...log, event] };
}

/**
 * A command emits a domain event only when it is accepted.
 * Replays, conflicts, and rejections keep the log unchanged.
 */
export function recordCommandEvent<TPayload>(input: {
  readonly decisionStatus: CommandDecision<unknown>['status'];
  readonly log: readonly DomainEvent<TPayload>[];
  readonly event: DomainEvent<TPayload>;
}): EventAppendResult<TPayload> & { readonly emitted: boolean } {
  if (input.decisionStatus !== 'applied') return { ok: true, log: input.log, emitted: false };
  const appended = appendDomainEvent(input.log, input.event);
  if (!appended.ok) return { ...appended, emitted: false };
  return { ok: true, log: appended.log, emitted: true };
}

/** Events strictly after a cursor, skipping ids the caller has already applied. */
export function eventsAfter<TPayload>(
  log: readonly DomainEvent<TPayload>[],
  cursor: { readonly sequence: number; readonly seenEventIds: readonly string[] },
): readonly DomainEvent<TPayload>[] {
  const seen = new Set(cursor.seenEventIds);
  return [...log]
    .filter((event) => event.sequence > cursor.sequence && !seen.has(event.eventId))
    .sort((left, right) => left.sequence - right.sequence);
}
