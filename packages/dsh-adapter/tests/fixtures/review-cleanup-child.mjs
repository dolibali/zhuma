// Separate OS/original Service+DSH JSON. Persisted native facts are explicit
// contracts; this proves only zero-write cleanup authority recovery, not drain.
import assert from 'node:assert/strict';
import { open } from '../execution-service-run-fixture.mjs';
import { readExecutionReviewState } from '../../dist/execution-review-state.js';

const h = await open(process.argv[2], { seed: false, workbench: JSON.parse(process.argv[3]) });
try {
  h.members.clear();
  h.member.abort();
  const attempt = readExecutionReviewState(h.read()).attempts[0];
  const authority = h.service.reviewCleanupAfterCommit(attempt.scope);
  assert.equal(h.service.assertExpertReviewCleanupAuthority(authority), undefined);
  assert.throws(() => authority.assertCurrent('send'), { code: 'review-authority-denied' });
  assert.throws(() => h.service.assertExpertReviewDriveGrant(authority, 'send'), {
    code: 'review-authority-denied',
  });
  assert.throws(
    () => h.service.assertExpertReviewCleanupAuthority(JSON.parse(JSON.stringify(authority))),
    { code: 'review-authority-denied' },
  );
  assert.equal(Object.hasOwn(authority, 'signal'), false);
  console.log(
    JSON.stringify({
      cleanup: true,
      drive: false,
      status: attempt.status,
      resources: attempt.resources,
      nativeProof: false,
      writes: h.counters,
    }),
  );
} finally {
  await h.close();
}
