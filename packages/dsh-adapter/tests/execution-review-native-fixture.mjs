// Transaction-boundary contracts around the ORIGINAL Service and DSH JSON.
// The C issuer/read/cut/drain below are explicit ports, NOT SDK/model evidence.
import assert from 'node:assert/strict';
import { checked } from './execution-service-run-fixture.mjs';
import { host } from './execution-review-service-fixture.mjs';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { reviewDescriptors } from './execution-review-composition-fixture.mjs';
import { fixedReviewFacts } from './execution-review-fixed-fixture.mjs';

export async function nativeReviewHost(t, options = {}) {
  const h = await host(t, {
    reviewerIds: ['qa'],
    assertReviewConfiguration() {},
    ...options,
  });
  const workflowLocation = { ...h.locate(), spaceId: 'north' };
  delete workflowLocation.nodeId;
  const workflowModel = { provider: 'contract', model: 'review-contract', maxTokens: 1000 };
  const workflowView =
    options.workflow &&
    checked(
      await h.service.startWorkflowExecution(h.request, {
        ...workflowLocation,
        requestId: 'start-review-workflow',
        defaults: { model: workflowModel, tools: 'text-only', workspace: { kind: 'text-only' } },
        budget: {
          concurrent: options.workflow.concurrent ?? 1,
          automaticAttemptsPerNode: 1,
          automaticRevisions: 0,
        },
      }),
    );
  const workflowClaim =
    workflowView &&
    checked(
      await h.service.claimWorkflowExecution(h.request, {
        ...workflowLocation,
        intentId: workflowView.intent.intentId,
        generation: workflowView.intent.generation,
      }),
    );
  const target = checked(
    await h.service.readExpertReviewTarget(h.request, { ...h.locate(), spaceId: 'north' }),
  );
  const query = {
    requestId: 'prepare-fixed-review',
    expectedReviewVersion: 0,
    target,
    reviewerRef: { id: 'qa', version: target.planId },
  };
  if (workflowClaim) Object.assign(query, workflowClaim.reviewCandidates[0]);
  const preparation = checked(await h.service.readExpertReviewPreparation(h.request, query));
  const composition = freezeExecutionReviewComposition({
    ...preparation,
    model: options.model ?? workflowModel,
    tools: {
      readTarget: reviewDescriptors.readTarget,
      completeReview: reviewDescriptors.completeReview,
    },
  });
  const { attempt } = checked(
    await h.service.prepareExpertReview(
      h.request,
      {
        ...query,
        configurationId: composition.configurationId,
      },
      workflowClaim,
    ),
  );
  const locator = { ...h.locate(), spaceId: 'north', runId: attempt.scope.runId };
  if (options.prepareOnly)
    return {
      ...h,
      locator,
      query,
      attempt,
      composition,
      workflowClaim,
      workflowView,
      workflowLocation,
    };
  checked(
    await h.service.admitExpertReview(h.request, {
      ...locator,
      expectedAttemptVersion: attempt.version,
      composition,
    }),
  );
  const drive = checked(await h.service.openExpertReviewDrive(h.request, locator));
  t.after(() => drive.dispose());
  checked(
    await h.service.recordNativeReviewEvent(drive.grant, {
      scope: drive.grant.scope,
      kind: 'accepted',
      sequence: 1,
      nativeSessionId: 'native-review-contract',
      nativeAgentId: 'native-review-contract',
    }),
  );
  const hooks = {};
  const calls = { prepare: 0, assert: 0, read: 0, check: 0, release: 0, retire: 0 };
  const { review: _review, ...scope } = drive.grant.scope;
  const binding = {
    scope,
    nativeSessionId: 'native-review-contract',
    nativeAgentId: 'native-review-contract',
    selection: drive.grant.selection,
  };
  const nativeGrant = Object.freeze({
    scope,
    signal: drive.grant.signal,
    assertCurrent(action) {
      h.service.assertExpertReviewDriveGrant(drive.grant, action);
    },
  });
  const ref = Object.freeze({});
  function original(grant, reference = ref) {
    assert.equal(grant, nativeGrant);
    assert.equal(reference, ref, 'only this explicit contract issuer ref is accepted');
    nativeGrant.assertCurrent('send');
  }
  const ports = {
    grantFor(grant) {
      h.service.assertExpertReviewDriveGrant(grant, 'send');
      assert.equal(grant, drive.grant);
      return nativeGrant;
    },
    issuer: {
      registerNativeReviewTools() {
        throw Error('not part of this Service transaction contract');
      },
      async prepareFixedReview(grant, signal) {
        calls.prepare++;
        original(grant);
        await hooks.prepare?.(signal);
        return { status: 'ready', ref };
      },
      assertFixedReview(grant, reference) {
        calls.assert++;
        original(grant, reference);
        return hooks.assert?.();
      },
      async readFixedReview(grant, reference, signal) {
        calls.read++;
        original(grant, reference);
        await hooks.read?.(signal);
        const record = h.read();
        const facts = fixedReviewFacts(
          { record, scope: drive.grant.scope, attempt: record.nativeExecution.review.attempts[0] },
          hooks.facts,
        );
        hooks.mutateFacts?.(facts);
        return {
          ...facts,
          signal: new AbortController().signal,
          check() {
            calls.check++;
            original(grant, reference);
            return hooks.check?.();
          },
          release() {
            calls.release++;
            return hooks.release?.();
          },
        };
      },
    },
    async retireForCleanup(authority, signal) {
      calls.retire++;
      h.service.assertExpertReviewCleanupAuthority(authority);
      if (hooks.retire) return hooks.retire(authority, signal);
      return {
        status: 'retired',
        binding,
        drain: {
          basis: 'flushed-and-closed',
          signal: new AbortController().signal,
          assertCurrent() {
            h.service.assertExpertReviewCleanupAuthority(authority);
          },
        },
      };
    },
  };
  if (options.install !== false) h.service.installNativeReviewPorts(ports);
  h.resetCounts();
  const command = { ...locator, requestId: 'submit-fixed-review' };
  return {
    ...h,
    locator,
    command,
    composition,
    drive,
    hooks,
    calls,
    ports,
    binding,
    query,
    workflowClaim,
    workflowView,
    workflowLocation,
  };
}
