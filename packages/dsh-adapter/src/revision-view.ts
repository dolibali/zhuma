import type {
  ArtifactVersion,
  ExecutionNodeRecord,
  ReviewBallot,
  ReviewRound,
} from '@zhuma/agent-core';

/** File metadata only. This read never carries bytes. */
export interface RevisionFile {
  readonly id: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface RevisionContent {
  readonly id: string;
  readonly version: number;
  readonly text?: string;
  readonly links: readonly string[];
  readonly files: readonly RevisionFile[];
}

/** One request-changes ballot. `body` is that reviewer's overall comment. */
export interface RevisionNote {
  readonly id: string;
  readonly reviewerId: string;
  readonly body: string;
  readonly artifactVersionId: string;
  readonly citedCommentIds: readonly string[];
}

export interface RevisionView {
  readonly reviewed?: RevisionContent;
  readonly previous?: RevisionContent;
  readonly notes: readonly RevisionNote[];
}

export type RevisionRead =
  | { readonly ok: true; readonly view: RevisionView }
  | { readonly ok: false; readonly code: 'not-revision-reader' | 'not-returned' };

function content(artifact: ArtifactVersion): RevisionContent {
  const text = artifact.text?.trim() ?? '';
  return {
    id: artifact.id,
    version: artifact.version,
    ...(text === '' ? {} : { text }),
    links: [...artifact.links],
    files: artifact.files.map((file) => ({
      id: file.id,
      mediaType: file.mediaType,
      byteSize: file.byteSize,
    })),
  };
}

function returnedRound(record: ExecutionNodeRecord): ReviewRound | undefined {
  const current = record.currentRoundId
    ? record.rounds.find((round) => round.id === record.currentRoundId)
    : undefined;
  if (current?.status === 'changes-requested') return current;
  for (let index = record.rounds.length - 1; index >= 0; index -= 1) {
    const round = record.rounds[index];
    if (round?.status === 'changes-requested') return round;
  }
  return undefined;
}

function citedIds(
  ballot: ReviewBallot,
  artifactVersionId: string,
  record: ExecutionNodeRecord,
): string[] {
  const found: string[] = [];
  for (const raw of ballot.unresolvedCommentIds ?? []) {
    const id = raw.trim();
    if (id === '' || found.includes(id)) continue;
    const comment = record.comments.find((item) => item.id === id && item.status === 'open');
    if (!comment) continue;
    if (comment.versionId !== undefined && comment.versionId !== artifactVersionId) continue;
    if (comment.targetId !== undefined && comment.targetId !== artifactVersionId) continue;
    found.push(id);
  }
  return found;
}

/**
 * Read the return the assignee is answering.
 * A current reviewer is still on both the returned round and the live roster.
 */
export function readRevisionView(record: ExecutionNodeRecord, actorId: string): RevisionRead {
  if (!Array.isArray(record.rounds) || !Array.isArray(record.artifactVersions)) {
    return { ok: false, code: 'not-returned' };
  }
  if (!Array.isArray(record.comments)) return { ok: false, code: 'not-returned' };
  const round = returnedRound(record);
  if (!round) return { ok: false, code: 'not-returned' };
  const assignee = record.handoff.assignee;
  const isAssignee = assignee.kind === 'human' && assignee.id === actorId;
  const currentReviewer =
    record.handoff.reviewerIds.includes(actorId) && round.reviewerIds.includes(actorId);
  if (!isAssignee && !currentReviewer) return { ok: false, code: 'not-revision-reader' };
  const reviewedArtifact = record.artifactVersions.find(
    (item) => item.id === round.artifactVersionId,
  );
  const reviewed = reviewedArtifact ? content(reviewedArtifact) : undefined;
  const previousArtifact =
    reviewed === undefined
      ? undefined
      : record.artifactVersions.find((item) => item.version === reviewed.version - 1);
  const notes = round.ballots
    .filter((ballot) => ballot.action === 'request-changes')
    .map((ballot) => ({
      id: `return-${round.id}-${ballot.reviewerId}`,
      reviewerId: ballot.reviewerId,
      body: ballot.comment?.trim() ?? '',
      artifactVersionId: round.artifactVersionId,
      citedCommentIds: citedIds(ballot, round.artifactVersionId, record),
    }));
  return {
    ok: true,
    view: {
      ...(reviewed === undefined ? {} : { reviewed }),
      ...(previousArtifact === undefined ? {} : { previous: content(previousArtifact) }),
      notes,
    },
  };
}
