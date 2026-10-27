import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { checked, refused } from './execution-service-run-fixture.mjs';

// Original Service/JSON admission and close tracking. Native physical IO/drain
// below are explicit port contracts, not an SDK or model proof.
test('review cleanup: eight held result requests cannot starve the original revoked cleanup that drains them', async (t) => {
  const h = await nativeReviewHost(t);
  const releases = [];
  h.hooks.read = () =>
    new Promise((resolve) => {
      releases.push(resolve);
    });
  const pending = Array.from({ length: 8 }, () =>
    h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
  );
  try {
    while (releases.length < 8) await setImmediate();
    refused(
      await h.service.submitNativeFixedReview(h.request, h.command, h.drive.grant),
      'native-result-capacity',
    );
    assert.equal(
      h.calls.read,
      8,
      'the reserved cleanup admission never increases result-read capacity',
    );
    h.members.clear();
    h.member.abort();
    const originalRetire = h.ports.retireForCleanup;
    // Install was once-only: keep its original function identity. The original
    // fixture hook below represents physical retirement unblocking held IO.
    h.hooks.retire = (authority) => {
      assert.equal(h.ports.retireForCleanup, originalRetire);
      for (const release of releases) release();
      return {
        status: 'retired',
        binding: h.binding,
        drain: {
          basis: 'flushed-and-closed',
          signal: new AbortController().signal,
          assertCurrent() {
            h.service.assertExpertReviewCleanupAuthority(authority);
          },
        },
      };
    };
    const result = checked(await h.service.retireExpertReviewForCleanup(h.drive.cleanup));
    assert.equal(result.status, 'settled');
    await Promise.all(pending);
    assert.equal(h.read().rounds[0].ballots.length, 0);
    assert.equal(h.calls.retire, 1);
  } finally {
    for (const release of releases) release();
    await Promise.allSettled(pending);
  }
});

test('review cleanup: reserved control admission is bounded and original domain close waits for all physical retirements', async (t) => {
  const h = await nativeReviewHost(t);
  const releases = [];
  h.hooks.retire = (authority) =>
    new Promise((resolve) => {
      releases.push(() =>
        resolve({
          status: 'retired',
          binding: h.binding,
          drain: {
            basis: 'flushed-and-closed',
            signal: new AbortController().signal,
            assertCurrent() {
              h.service.assertExpertReviewCleanupAuthority(authority);
            },
          },
        }),
      );
    });
  const pending = Array.from({ length: 8 }, () =>
    h.service.retireExpertReviewForCleanup(h.drive.cleanup),
  );
  let closing;
  try {
    while (releases.length < 8) await setImmediate();
    refused(
      await h.service.retireExpertReviewForCleanup(h.drive.cleanup),
      'native-result-capacity',
    );
    assert.equal(h.calls.retire, 8);
    let closed = false;
    closing = h.service.closeRuns().then(() => {
      closed = true;
    });
    await setImmediate();
    assert.equal(closed, false, 'domain close cannot treat pending native cleanup as drained');
    for (const release of releases) release();
    for (const result of await Promise.all(pending))
      assert.equal(checked(result).status, 'settled');
    await closing;
    assert.equal(closed, true);
    assert.equal(h.read().rounds[0].ballots.length, 0);
    refused(
      await h.service.retireExpertReviewForCleanup(h.drive.cleanup),
      'run-authority-unavailable',
    );
  } finally {
    for (const release of releases) release();
    await Promise.allSettled([...pending, ...(closing ? [closing] : [])]);
  }
});
