import type { ExecutionBallotWire } from './ExecutionApi.js';

/** Shared read-only presentation for persisted review ballots. */
export function ReviewBallots({
  ballots,
  names,
}: {
  ballots: readonly ExecutionBallotWire[];
  names?: Readonly<Record<string, string>> | undefined;
}) {
  if (!ballots.length) return null;
  return (
    <div className="zm-execution-ballots" aria-label="本轮意见">
      {ballots.map((ballot, index) => (
        <p key={index}>
          <strong>{names?.[ballot.reviewerId] || ballot.reviewerId}</strong> ·{' '}
          {ballot.action === 'approve'
            ? '通过'
            : ballot.action === 'request-changes'
              ? '退回修改'
              : '评论'}
          {ballot.comment && <span className="zm-execution-text">{ballot.comment}</span>}
        </p>
      ))}
    </div>
  );
}
