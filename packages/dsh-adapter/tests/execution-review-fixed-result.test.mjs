import assert from 'node:assert/strict';
import test from 'node:test';
import { castBallot, canonicalPayload } from '@zhuma/agent-core';
import { createHash } from 'node:crypto';
import {
  commitExecutionReviewFixedResult,
  readExecutionReviewFixedReceipt,
} from '../dist/execution-review-fixed-result.js';
import {
  readExecutionReviewState,
  prepareExecutionReview,
} from '../dist/execution-review-state.js';
import { nativeReviewContentDigest } from '../dist/native-work-session-review-contract.js';
import { runningReview, fixedReviewFacts } from './execution-review-fixed-fixture.mjs';

// Pure atomic/domain contracts only. Hashes and these fixture values are NOT
// genuine C SDK reads, issuer refs, cut or physical cleanup certificates.
test('fixed review result: completion, named expert ballot, fixed comment and receipt change in one candidate, leaving native resources held', () => {
  const f = runningReview(),
    proof = fixedReviewFacts(f),
    before = JSON.stringify(f.record);
  const result = commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', proof);
  assert.equal(JSON.stringify(f.record), before);
  assert.equal(result.record.command.status, 'completed');
  assert.equal(result.record.acceptedArtifactVersionId, f.scope.review.target.artifactVersionId);
  const attempt = readExecutionReviewState(result.record).attempts[0];
  assert.equal(attempt.status, 'completed');
  assert.equal(attempt.resources, 'held');
  assert.equal(result.record.rounds[0].ballots[0].reviewerId, 'qa');
  assert.equal(result.record.rounds[0].ballots[0].action, 'approve');
  assert.equal(result.record.comments[0].authorId, 'qa');
  assert.equal(result.record.comments[0].versionId, f.scope.review.target.artifactVersionId);
  assert.equal(result.record.comments[0].body, proof.content.rationale);
  assert.deepEqual(readExecutionReviewFixedReceipt(result.record, attempt), result.receipt);
  assert.equal(
    Object.hasOwn(result.receipt, 'rationale'),
    false,
    'no second rationale content store',
  );
  const replay = commitExecutionReviewFixedResult(
    result.record,
    f.scope,
    'fixed-review-submit',
    proof,
  );
  assert.equal(replay.disposition, 'replayed');
  assert.equal(replay.record, result.record);
  assert.throws(
    () => commitExecutionReviewFixedResult(result.record, f.scope, 'different-key', proof),
    { code: 'review-result-conflict' },
  );
});

test('fixed review result: request-changes creates the original obligation, comment stays pending and neither unlocks delivery', () => {
  for (const conclusion of ['request-changes', 'comment']) {
    const f = runningReview(),
      proof = fixedReviewFacts(f, { conclusion, ranges: [[0, 3]] });
    const result = commitExecutionReviewFixedResult(
      f.record,
      f.scope,
      'fixed-review-submit',
      proof,
    );
    assert.equal(
      result.record.command.status,
      conclusion === 'comment' ? 'in-review' : 'needs-revision',
    );
    assert.equal(result.record.acceptedArtifactVersionId, undefined);
    assert.equal(result.record.comments[0].status, 'open');
    assert.equal(readExecutionReviewState(result.record).attempts.length, 1);
    if (conclusion === 'comment')
      assert.throws(
        () =>
          prepareExecutionReview(result.record, f.applied, {
            requestId: 'silent-retry',
            expectedReviewVersion: readExecutionReviewState(result.record).version,
            target: f.scope.review.target,
            reviewerId: 'qa',
            controllerMemberId: 'chen',
            configurationId: 'new',
            newRunId: 'silent-retry-run',
            newSegmentId: 'silent-retry-segment',
          }),
        { code: 'review-attempt-budget' },
      );
  }
});

test('fixed review result: a peers same-round progress does not stale the fixed proof or bypass all reviewers', () => {
  const f = runningReview({ peer: true }),
    proof = fixedReviewFacts(f);
  const first = commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', proof);
  assert.equal(first.record.command.status, 'in-review');
  assert.equal(first.record.acceptedArtifactVersionId, undefined);
  const peer = castBallot({
    record: f.record,
    actorId: 'outside',
    idempotencyKey: 'peer-review',
    expectedVersion: f.record.command.version,
    ballot: {
      reviewerId: 'outside',
      roundId: f.scope.review.target.roundId,
      artifactVersionId: f.scope.review.target.artifactVersionId,
      action: 'approve',
    },
  });
  assert.equal(peer.ok, true);
  const final = commitExecutionReviewFixedResult(
    peer.record,
    f.scope,
    'fixed-review-submit',
    proof,
  );
  assert.equal(final.record.command.status, 'completed');
  assert.equal(final.record.rounds[0].ballots.length, 2);
});

test('fixed review result: first page and duplicate overlapping partial pages cannot approve unread bytes', () => {
  const f = runningReview(),
    before = JSON.stringify(f.record);
  for (const ranges of [
    [[0, 5]],
    [
      [0, 5],
      [0, 5],
    ],
    [
      [0, 3],
      [5, 3],
    ],
  ]) {
    const proof = fixedReviewFacts(f, { ranges });
    assert.throws(
      () => commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', proof),
      (error) => {
        assert.equal(error.code, 'review-read-required');
        assert.deepEqual(error.resourceRefs, ['review_text']);
        return true;
      },
    );
    assert.equal(JSON.stringify(f.record), before);
  }
});

test('fixed review result: real byte-range union can include overlap but must reach the complete UTF8 byte count', () => {
  const f = runningReview({ text: '中文字符验证' }),
    total = Buffer.byteLength(f.record.artifactVersions[0].text);
  const partial = fixedReviewFacts(f, { ranges: [[0, f.record.artifactVersions[0].text.length]] });
  assert.throws(
    () => commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', partial),
    { code: 'review-read-required' },
  );
  const full = fixedReviewFacts(f, {
    ranges: [
      [0, 6],
      [3, total - 3],
    ],
  });
  assert.equal(
    commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', full).receipt.action,
    'approve',
  );
});

test('fixed review result: consistent public hashes with the wrong fixed target still cannot change the node', () => {
  const f = runningReview(),
    wrong = structuredClone(f.scope);
  wrong.review.target.roundId = 'different-round';
  const proof = fixedReviewFacts(f, { proofScope: wrong });
  assert.throws(
    () => commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', proof),
    { code: 'review-result-invalid' },
  );
  assert.equal(f.record.rounds[0].ballots.length, 0);
});

test('fixed review result: invisible rationale and changed persisted metadata/ballot are rejected', () => {
  const f = runningReview(),
    proof = fixedReviewFacts(f);
  const invisible = structuredClone(proof);
  invisible.content.rationale = '\u200b\u00ad';
  invisible.digest = nativeReviewContentDigest(invisible.content, invisible.readManifestDigest);
  invisible.provenanceFingerprint = createHash('sha256')
    .update(
      canonicalPayload({
        source: invisible.source,
        digest: invisible.digest,
        readManifestDigest: invisible.readManifestDigest,
      }),
    )
    .digest('hex');
  assert.throws(
    () => commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', invisible),
    { code: 'review-result-invalid' },
  );
  const result = commitExecutionReviewFixedResult(f.record, f.scope, 'fixed-review-submit', proof);
  for (const mutate of [
    (record) => {
      record.nativeExecution.review.attempts[0].result.digest = 'a'.repeat(64);
    },
    (record) => {
      record.rounds[0].ballots[0].comment += ' altered';
    },
    (record) => {
      record.nativeExecution.review.attempts[0].result.source.context.review.target.roundId =
        'other';
    },
  ]) {
    const changed = structuredClone(result.record);
    mutate(changed);
    assert.throws(() => readExecutionReviewState(changed), { code: 'review-state-invalid' });
  }
});
