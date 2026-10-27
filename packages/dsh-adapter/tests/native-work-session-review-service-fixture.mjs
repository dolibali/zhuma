/** Real D Service/JSON/Drive/file reader -> original C SDK/issuer/retirement.
 * Member authentication and A's model qualification remain explicit fixtures.
 * This manual trusted bridge does not exercise A's automatic Host consumer. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { host } from './execution-review-service-fixture.mjs';
import { checked } from './execution-service-run-fixture.mjs';
import { boot, ScriptedAdapter } from './native-work-session-fixture.mjs';
import { toolResponse } from './native-work-session-input-fixture.mjs';
import {
  executionReviewCompositionRequest,
  freezeExecutionReviewComposition,
} from '../dist/execution-review-composition.js';
import {
  createNativeFixedResultIssuer,
  nativeFixedReviewIssuer,
} from '../dist/native-work-session-result.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from '../dist/native-work-session-review-read.js';
import { nativeReviewContextFromScope } from '../dist/native-work-session-review-contract.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
export { readExecutionReviewState };

export async function bootReviewService(root, after, options = {}) {
  let composition;
  const d = await host(
    { after },
    {
      reviewerIds: ['qa'],
      file: {
        name: 'api-contract.txt',
        mediaType: 'text/plain',
        text: '附件约定：保留旧调用方的 status 字段。',
      },
      // Explicit A-source qualification fixture; the D issuer itself is genuine.
      assertReviewConfiguration(_member, _space, _node, saved) {
        assert.deepEqual(saved, composition);
        return undefined;
      },
      ...options,
    },
  );
  const target = checked(
    await d.service.readExpertReviewTarget(d.request, { ...d.locate(), spaceId: 'north' }),
  );
  const query = {
    requestId: 'prepare-sdk-review',
    expectedReviewVersion: 0,
    target,
    reviewerRef: { id: 'qa', version: target.planId },
  };
  composition = freezeExecutionReviewComposition({
    ...checked(await d.service.readExpertReviewPreparation(d.request, query)),
    model: { provider: 'contract', model: 'contract-model', maxTokens: 3000 },
    tools: {
      readTarget: describeNativeReviewReadTool(),
      completeReview: describeNativeReviewTool(),
    },
  });
  const { attempt } = checked(
    await d.service.prepareExpertReview(d.request, {
      ...query,
      configurationId: composition.configurationId,
    }),
  );
  const locator = { ...d.locate(), spaceId: 'north', runId: attempt.scope.runId };
  checked(
    await d.service.admitExpertReview(d.request, {
      ...locator,
      expectedAttemptVersion: attempt.version,
      composition,
    }),
  );
  const drive = checked(await d.service.openExpertReviewDrive(d.request, locator));
  after(() => drive.dispose());
  let native, review, actor;
  const reads = [],
    leases = new Set(),
    adapter = new ScriptedAdapter();
  const ports = {
    authorize(original, action) {
      // Authenticate with the same D issuer before trusting any projected field.
      d.service.assertExpertReviewDriveGrant(original, action);
      return { scope: original.scope, selection: original.selection, signal: original.signal };
    },
    authorizeCleanup(original) {
      d.service.assertExpertReviewCleanupAuthority(original);
      return original.scope;
    },
    unavailableRequired(original) {
      d.service.assertExpertReviewDriveGrant(original, 'send');
      return d.service
        .listExpertReviewResources(original)
        .filter((item) => item.kind === 'external-reference' || !item.mediaType.startsWith('text/'))
        .map(({ resourceRef }) => ({ resourceRef, code: 'review-unsupported-material' }));
    },
    async readTarget(original, request, signal) {
      d.service.assertExpertReviewDriveGrant(original, 'send');
      const actual = await d.service.readExpertReviewResource(original, request, signal);
      const binding = native.service.open(native.service.reviewGrant(original)).binding;
      const source = {
        context: nativeReviewContextFromScope(actual.scope),
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
        configurationId: binding.selection.configurationId,
        resourceRef: actual.resource.resourceRef,
        resourceFingerprint: actual.resource.resourceFingerprint,
      };
      reads.push({ source, range: actual.range, bytes: Buffer.from(actual.bytes) });
      leases.add(actual);
      return {
        source,
        bytes: actual.bytes,
        range: actual.range,
        encoding: actual.encoding,
        signal: actual.signal,
        check: () => actual.check(),
        release() {
          actual.release();
          leases.delete(actual);
        },
      };
    },
  };
  native = await boot(
    join(root, 'native'),
    adapter,
    (ctx, binding, current) => {
      actor = scopeOf(ctx);
      assert.deepEqual(
        native.service.reviewContext(current),
        nativeReviewContextFromScope(drive.grant.scope),
      );
      const registered = review.registerNativeReviewTools(ctx, binding, current);
      return {
        ...registered,
        context: `${executionReviewCompositionRequest(composition).context}\n${registered.context}`,
      };
    },
    {},
    ports,
  );
  after(() => native.close());
  // Create the original result owner once, then obtain its review view.
  const owner = createNativeFixedResultIssuer(
    native.ctx,
    native.service,
    native.runtime,
    {
      assertGrant() {
        throw Error('author execution is outside this review proof');
      },
    },
    {
      readRunComposition() {
        throw Error('author composition is outside this review proof');
      },
    },
  );
  review = nativeFixedReviewIssuer(native.service, native.runtime);
  d.service.installNativeReviewPorts({
    issuer: review,
    grantFor: (original) => native.service.reviewGrant(original),
    retireForCleanup: (original, wait) => native.service.retireReviewForCleanup(original, wait),
  });
  const grant = native.service.reviewGrant(drive.grant);
  const resources = d.service.listExpertReviewResources(drive.grant);
  async function run({ omitFile = false } = {}) {
    for (const resource of resources.filter((item) => !omitFile || item.kind !== 'file'))
      adapter.script.push(
        toolResponse(
          { resourceRef: resource.resourceRef, offset: 0, length: resource.bytes },
          `read-${resource.resourceRef}`,
          'read_review_target',
        ),
      );
    adapter.script.push((request) => {
      const evidenceRefs = [
        ...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu)),
      ];
      assert.equal(
        evidenceRefs.length,
        omitFile ? 1 : resources.length,
        'actual SDK read ACKs reach the model',
      );
      return toolResponse(
        {
          conclusion: 'approve',
          rationale: '已核对正文和本轮实际读取的固定附件。',
          anchors: [{ resourceRef: 'review_text', offset: 0, length: 8 }],
          evidenceRefs,
        },
        'complete-sdk-review',
        'complete_review',
      )();
    });
    adapter.script.push('Review declaration complete.');
    const request = executionReviewCompositionRequest(composition);
    const receipt = await native.service.send(grant, {
      requestId: 'start-sdk-review',
      text: request.firstMessage.text,
      mode: 'followup',
      selection: request.selection,
    });
    const binding = native.service.open(grant).binding;
    assert.equal(receipt.status, 'received');
    checked(
      await d.service.recordNativeReviewEvent(drive.grant, {
        scope: drive.grant.scope,
        kind: 'accepted',
        sequence: 1,
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
      }),
    );
    await actor.whenIdle();
    checked(
      await d.service.recordNativeReviewEvent(drive.grant, {
        scope: drive.grant.scope,
        kind: 'idle',
        sequence: 2,
      }),
    );
    return binding;
  }
  const command = { ...locator, requestId: 'submit-sdk-review' };
  return {
    d,
    native,
    review,
    owner,
    adapter,
    ports,
    drive,
    grant,
    resources,
    reads,
    leases,
    run,
    command,
    actor: () => actor,
  };
}
