import type { ArtifactFileRef, ExecutionNodeRecord } from '@zhuma/agent-core';

export interface DeliveryDraftView {
  readonly version: number;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
  /** Names come only from authorized original upload receipts, never local paths. */
  readonly fileDetails?: readonly { readonly id: string; readonly name: string }[];
}

type StoredDeliveryDraft = NonNullable<ExecutionNodeRecord['deliveryDraft']>;

/** A draft never records a caller-supplied upload as finished. */
export function draftFiles(files: readonly ArtifactFileRef[]): ArtifactFileRef[] {
  return files.map((file) => ({ ...file, uploadComplete: false }));
}

export function deliveryDraftView(
  draft: StoredDeliveryDraft | undefined,
  verifiedFiles?: readonly ArtifactFileRef[],
): DeliveryDraftView {
  if (draft === undefined) return { version: 0, text: '', links: [], files: [] };
  return {
    version: draft.version,
    text: draft.text,
    links: [...draft.links],
    files: verifiedFiles ? verifiedFiles.map((file) => ({ ...file })) : draftFiles(draft.files),
  };
}

/**
 * Clear the body and consume one draft version.
 * The draft write carries only `expectedVersion`, not a round id, so the
 * version itself is the cross-round boundary. A submit with no stored draft
 * still leaves version 1 (previous counted as 0), so a late `expectedVersion`
 * of 0 cannot become the next round's first save.
 */
export function withoutDeliveryDraft(record: ExecutionNodeRecord): ExecutionNodeRecord {
  const previous = record.deliveryDraft?.version ?? 0;
  return {
    ...record,
    deliveryDraft: {
      version: previous + 1,
      idempotencyKey: '',
      fingerprint: '',
      text: '',
      links: [],
      files: [],
    },
  };
}

/** One saved draft. The same key replays; a different body with that key mismatches; a stale version conflicts. */
export function applyDeliveryDraft(input: {
  readonly current: StoredDeliveryDraft | undefined;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
}):
  | {
      readonly ok: true;
      readonly disposition: 'applied' | 'replayed';
      readonly draft: StoredDeliveryDraft;
    }
  | { readonly ok: false; readonly code: 'conflict'; readonly currentVersion: number }
  | { readonly ok: false; readonly code: 'idempotency-mismatch' } {
  if (input.current !== undefined && input.current.idempotencyKey === input.idempotencyKey) {
    if (input.current.fingerprint !== input.fingerprint) {
      return { ok: false, code: 'idempotency-mismatch' };
    }
    return { ok: true, disposition: 'replayed', draft: input.current };
  }
  const currentVersion = input.current?.version ?? 0;
  if (input.expectedVersion !== currentVersion) {
    return { ok: false, code: 'conflict', currentVersion };
  }
  return {
    ok: true,
    disposition: 'applied',
    draft: {
      version: currentVersion + 1,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      text: input.text,
      links: input.links,
      files: draftFiles(input.files),
    },
  };
}
