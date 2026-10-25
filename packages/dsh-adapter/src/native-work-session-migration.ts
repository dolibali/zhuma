import { randomUUID } from 'node:crypto';
import {
  NativeWorkError,
  type NativeBindingReference,
  type NativeRunMigrationGrant,
  type NativeRunMigrationResult,
  type NativeSessionBinding,
  type NativeSessionLineage,
  type NativeWorkSessionRecord,
  type NativeMigrationOriginRequest,
  type NativeMigrationOrigin,
} from './native-work-session-contract.js';
import {
  currentBinding,
  previousBindings,
  nativeScopeKey,
  migrationFingerprint,
  validMigrationPair,
  NATIVE_LINEAGE_LIMITS,
  nativeWorkSessionRecordSchema,
} from './native-work-session-record.js';

type MigrationData = Pick<
  NativeRunMigrationGrant,
  'requestId' | 'inputFingerprint' | 'previousScope' | 'scope' | 'selection'
>;
export const nativeBindingReference = (binding: NativeSessionBinding): NativeBindingReference =>
  structuredClone({
    scope: binding.scope,
    nativeSessionId: binding.nativeSessionId,
    nativeAgentId: binding.nativeAgentId,
    selection: binding.selection,
  });

/** Exact persisted origin, including replay after the current pointer committed.
 * No native ID, receipts, body, permission, I/O or new Run facts are returned.
 */
export function nativeMigrationOrigin(
  record: NativeWorkSessionRecord,
  data: NativeMigrationOriginRequest,
): NativeMigrationOrigin {
  const previous =
    previousBindings(record).find((entry) => entry.migration.requestId === data.requestId)
      ?.binding ?? currentBinding(record);
  inspectNativeMigration(record, { ...data, previousScope: previous.scope });
  return structuredClone({ scope: previous.scope, selection: previous.selection });
}

/** Pure metadata validation; performs no native creation, drive or persistence. */
export function inspectNativeMigration(
  record: NativeWorkSessionRecord,
  data: MigrationData,
): Extract<NativeRunMigrationResult, { status: 'migrated' | 'replayed' }> | undefined {
  if (!validMigrationPair(data.previousScope, data.scope))
    throw new NativeWorkError('scope-mismatch');
  const prior = previousBindings(record);
  const current = currentBinding(record);
  const index = prior.findIndex((entry) => entry.migration.requestId === data.requestId);
  if (index !== -1) {
    const entry = prior[index]!;
    if (
      entry.migration.fingerprint !==
      migrationFingerprint(data.previousScope, data.scope, data.selection, data.inputFingerprint)
    )
      throw new NativeWorkError('idempotency-mismatch');
    if (nativeScopeKey(current.scope) !== nativeScopeKey(data.scope))
      throw new NativeWorkError('migration-conflict');
    return {
      status: 'replayed',
      previous: nativeBindingReference(entry.binding),
      next: nativeBindingReference(current),
    };
  }
  if (nativeScopeKey(current.scope) !== nativeScopeKey(data.previousScope))
    throw new NativeWorkError('scope-mismatch');
  if (prior.length + 1 >= NATIVE_LINEAGE_LIMITS.segments) throw new NativeWorkError('capacity');
  if (
    [...prior.map((entry) => entry.binding), current].some(
      (binding) =>
        binding.scope.runId === data.scope.runId ||
        binding.scope.segmentId === data.scope.segmentId,
    )
  )
    throw new NativeWorkError('migration-conflict');
  return undefined;
}

export function appendNativeMigration(
  record: NativeWorkSessionRecord,
  data: MigrationData,
): {
  readonly record: NativeSessionLineage;
  readonly result: Extract<NativeRunMigrationResult, { status: 'migrated' | 'replayed' }>;
} {
  if (inspectNativeMigration(record, data)) throw new NativeWorkError('migration-conflict');
  const previous = currentBinding(record);
  const nativeId = `zhuma-work-${randomUUID()}`;
  const next: NativeSessionBinding = {
    schemaVersion: 1,
    scope: structuredClone(data.scope),
    nativeSessionId: nativeId,
    nativeAgentId: nativeId,
    selection: structuredClone(data.selection),
    receipts: [],
  };
  const candidate: NativeSessionLineage = {
    schemaVersion: 2,
    version: previousBindings(record).length + 2,
    current: next,
    prior: [
      ...previousBindings(record),
      {
        binding: previous,
        migration: {
          requestId: data.requestId,
          inputFingerprint: data.inputFingerprint,
          fingerprint: migrationFingerprint(
            data.previousScope,
            data.scope,
            data.selection,
            data.inputFingerprint,
          ),
        },
      },
    ],
  };
  if (Buffer.byteLength(JSON.stringify(candidate)) > NATIVE_LINEAGE_LIMITS.bytes)
    throw new NativeWorkError('capacity');
  if (!nativeWorkSessionRecordSchema.safeParse(candidate).success)
    throw new NativeWorkError('binding-state-invalid');
  return {
    record: candidate,
    result: {
      status: 'migrated',
      previous: nativeBindingReference(previous),
      next: nativeBindingReference(next),
    },
  };
}
