import type { ArtifactFileRef, ExecutionNodeRecord } from '@zhuma/agent-core';

export interface DeliveryDraftView {
  readonly version: number;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
}

type StoredDeliveryDraft = NonNullable<ExecutionNodeRecord['deliveryDraft']>;

export function deliveryDraftView(draft: StoredDeliveryDraft | undefined): DeliveryDraftView {
  if (draft === undefined) return { version: 0, text: '', links: [], files: [] };
  return {
    version: draft.version,
    text: draft.text,
    links: draft.links,
    files: draft.files,
  };
}

export function withoutDeliveryDraft(record: ExecutionNodeRecord): ExecutionNodeRecord {
  if (record.deliveryDraft === undefined) return record;
  const { deliveryDraft, ...rest } = record;
  void deliveryDraft;
  return rest;
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
      files: input.files,
    },
  };
}
