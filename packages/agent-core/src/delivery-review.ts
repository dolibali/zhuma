import type { ReviewAction, CitedComment } from './review.js';

/** Pinned delivery text and a line diff against the previous stored version. */
export interface FixedDeliveryPreview {
  readonly artifactVersionId: string;
  readonly version: number;
  readonly text: string;
  /** Empty when this version has no predecessor or the text is unchanged. */
  readonly diff: string;
  readonly baseVersion?: number;
}

export type FixedDeliveryPreviewResult =
  | { readonly ok: true; readonly preview: FixedDeliveryPreview }
  | { readonly ok: false; readonly code: 'version-not-found' };

interface VersionText {
  readonly id: string;
  readonly version: number;
  readonly text?: string;
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;

/** Same visible-text rule as a review comment: blank and zero-width do not count. */
function substantive(value: string | undefined): string {
  return (value ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(/\u00ad/g, '')
    .trim();
}

function usableId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 200;
}

function bodyOf(version: VersionText): string {
  return version.text ?? '';
}

/**
 * One replacement hunk. Unchanged prefix and suffix lines are omitted.
 * The result is the stored-version difference, not a live workspace diff.
 */
function lineDiff(before: string, after: string): string {
  if (before === after) return '';
  const older = before.split('\n');
  const newer = after.split('\n');
  let start = 0;
  while (start < older.length && start < newer.length && older[start] === newer[start]) {
    start += 1;
  }
  let endOlder = older.length;
  let endNewer = newer.length;
  while (endOlder > start && endNewer > start && older[endOlder - 1] === newer[endNewer - 1]) {
    endOlder -= 1;
    endNewer -= 1;
  }
  const removed = older.slice(start, endOlder);
  const added = newer.slice(start, endNewer);
  const oldStart = removed.length === 0 ? Math.max(start, 1) : start + 1;
  const newStart = added.length === 0 ? Math.max(start, 1) : start + 1;
  return [
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

/**
 * Preview one stored delivery version. The id selects the version.
 * A later version in the same list is not substituted.
 */
export function previewFixedDelivery(
  versions: readonly VersionText[],
  artifactVersionId: string,
): FixedDeliveryPreviewResult {
  if (!usableId(artifactVersionId)) return { ok: false, code: 'version-not-found' };
  const matches = versions.filter((item) => item.id === artifactVersionId);
  const pinned = matches[0];
  if (
    matches.length !== 1 ||
    !pinned ||
    !Number.isSafeInteger(pinned.version) ||
    pinned.version < 1
  ) {
    return { ok: false, code: 'version-not-found' };
  }
  const predecessors = versions.filter(
    (item) =>
      item.id !== pinned.id &&
      Number.isSafeInteger(item.version) &&
      item.version === pinned.version - 1,
  );
  const base = predecessors.length === 1 ? predecessors[0] : undefined;
  const text = bodyOf(pinned);
  const hunk = base === undefined ? '' : lineDiff(bodyOf(base), text);
  const diff =
    base === undefined || hunk === ''
      ? ''
      : [`--- 第${base.version}版`, `+++ 第${pinned.version}版`, hunk].join('\n');
  return {
    ok: true,
    preview: {
      artifactVersionId: pinned.id,
      version: pinned.version,
      text,
      diff,
      ...(base === undefined ? {} : { baseVersion: base.version }),
    },
  };
}

export interface BoundReviewComment {
  /** Every comment citation checks may use, including rows from other ballots. */
  readonly comments: readonly CitedComment[];
  /** Set when a return should cite the comment pinned to this artifact version. */
  readonly citedId?: string;
  /**
   * The single comment this ballot itself creates. Absent when the ballot does
   * not bind one. A receipt fingerprint uses this row, not `comments`.
   */
  readonly owned?: CitedComment;
}

function samePinnedComment(
  comment: CitedComment,
  id: string,
  versionId: string,
  body: string,
  authorId: string,
): boolean {
  return (
    comment.id === id &&
    comment.status === 'open' &&
    comment.versionId === versionId &&
    comment.targetId === versionId &&
    comment.body === body &&
    (comment.authorId === undefined || comment.authorId === authorId)
  );
}

/**
 * Attach one reviewer comment to a fixed artifact version.
 * Approve, blank text, and an id that already names different content do not write a new row.
 */
export function bindVersionedReviewComment(input: {
  readonly existing: readonly CitedComment[];
  readonly id: string;
  readonly artifactVersionId: string;
  readonly action: ReviewAction;
  readonly comment?: string;
  readonly authorId: string;
}): BoundReviewComment {
  const text = substantive(input.comment);
  const binds =
    (input.action === 'comment' || input.action === 'request-changes') &&
    text.length > 0 &&
    usableId(input.id) &&
    usableId(input.artifactVersionId) &&
    usableId(input.authorId);
  if (!binds) return { comments: input.existing };
  const found = input.existing.find((item) => item.id === input.id);
  if (found && !samePinnedComment(found, input.id, input.artifactVersionId, text, input.authorId)) {
    return { comments: input.existing };
  }
  const owned: CitedComment = found ?? {
    id: input.id,
    status: 'open',
    versionId: input.artifactVersionId,
    targetId: input.artifactVersionId,
    body: text,
    authorId: input.authorId,
  };
  return {
    comments: found ? input.existing : [...input.existing, owned],
    owned,
    ...(input.action === 'request-changes' ? { citedId: input.id } : {}),
  };
}
