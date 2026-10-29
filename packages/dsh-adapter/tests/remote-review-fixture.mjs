/** Actual original Service/JSON/AttachmentLocal and Ed25519 transport. Member,
 * resource qualification and native read/cut reports remain explicit contracts. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, sign } from 'node:crypto';
import { canonicalPayload, remoteReviewDeviceSigningInput } from '@zhuma/agent-core';
import { fileHost, ok, no, deferred } from './remote-run-files-fixture.mjs';
import { workbench } from './execution-review-service-fixture.mjs';
import { caller } from './execution-service-run-fixture.mjs';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { fixedReviewFacts } from './execution-review-fixed-fixture.mjs';
import { EXECUTION_RESOURCE_SOURCE_VERSION } from '../dist/execution-run-resource-snapshot.js';
export { ok, no, deferred };

export async function reviewHost(
  t,
  { reviewers = ['qa'], enabled = true, root, seed = true, identity, file = false } = {},
) {
  const calls = { metadata: 0, released: 0, backendModel: 0 };
  const hooks = {};
  const configure = (base) => {
    base.service.runHost.assertReviewConfiguration = () => {
      calls.backendModel++;
      throw Error('BACKEND_MUST_NOT_RESOLVE_REVIEW_MODEL');
    };
    base.service.runHost.prepareReviewResourceCatalog = async (request, query, wait) => {
      calls.metadata++;
      const preparation = ok(await base.service.readExpertReviewPreparation(request, query));
      await hooks.metadata?.(wait);
      const life = new AbortController();
      return {
        preparation,
        catalog: { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] },
        signal: AbortSignal.any([life.signal, wait]),
        assertCurrent() {
          if (life.signal.aborted || wait.aborted) throw Error('CONTRACT_METADATA_REVOKED');
          return undefined;
        },
        release() {
          calls.released++;
          life.abort();
          return hooks.release?.();
        },
      };
    };
  };
  const h = await fileHost(t, {
    workbench: workbench({ reviewerIds: reviewers }),
    ...(root ? { root } : {}),
    seed,
    ...(identity ? { identity } : {}),
    beforeRemoteEnable: configure,
    remoteOptions: enabled ? { independentReviews: true } : {},
  });
  if (seed) {
    const authority = async () => ({
      lease: await h.service.runHost.memberLease(h.request),
      assertProjectSpace: h.service.runHost.assertProjectSpace,
    });
    const files = [];
    if (file) {
      const bytes = Buffer.from('Required file material.');
      const upload = ok(
        await h.service.uploadFile(
          caller(),
          {
            ...h.locate(),
            spaceId: 'north',
            idempotencyKey: 'review-file',
            declare: {
              name: 'review.txt',
              mediaType: 'text/plain',
              byteSize: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            data: (async function* () {
              yield bytes;
            })(),
          },
          await authority(),
        ),
      );
      files.push(upload.reference);
    }
    ok(
      await h.service.submit(
        caller(),
        {
          ...h.human('produce', 'review-fixed'),
          text: 'Review this exact fixed material.',
          files,
          links: [],
        },
        file ? authority : undefined,
      ),
    );
  }
  const send = (body, { secret = h.drive.raw, request = h.request } = {}) => {
    if ('proof' in body)
      body.proof.signature = sign(
        null,
        Buffer.from(canonicalPayload(remoteReviewDeviceSigningInput(body))),
        h.identity.keys.privateKey,
      ).toString('base64url');
    return h.service.remoteRun(request, body, secret);
  };
  const envelope = (operation, payload, requestId) => ({
    ...h.envelope(operation, payload, requestId),
    purpose: 'review',
  });
  let view;
  const accept = (reviewerId = 'qa', patch = {}) =>
    envelope('accept', {
      target: okTarget(),
      expectedReviewVersion: readExecutionReviewState(h.read())?.version ?? 0,
      reviewerRef: { id: reviewerId, version: h.read().planId },
      model: { provider: 'contract', model: 'local-review-model', maxTokens: 1000 },
      workspace: { kind: 'text-only' },
      capabilities: {
        reader: 'zhuma-native-review-read@1',
        resultIntent: 'zhuma-native-review-intent@1',
      },
      credentials: { drive: h.drive.public, cleanup: h.cleanup.public },
      ...patch,
    });
  // Exact current target is provided by the original Service's original read API.
  let target = ok(
    await h.service.readExpertReviewTarget(h.request, { ...h.locate(), spaceId: 'north' }),
  );
  function okTarget() {
    return structuredClone(target);
  }
  const scoped = (operation, fields = {}, requestId) =>
    envelope(operation, { scope: view.scope, permit: h.drive.public, ...fields }, requestId);
  const begin = async (reviewerId = 'qa', patch = {}) => {
    view = ok(await send(accept(reviewerId, patch)));
    view = ok(
      await send(
        scoped('event', {
          event: {
            sequence: view.nextSequence,
            kind: 'received',
            nativeSessionId: `native-${reviewerId}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
            nativeAgentId: `native-${reviewerId}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
          },
        }),
      ),
    );
    view = ok(
      await send(
        scoped('event', {
          event: {
            sequence: view.nextSequence,
            kind: 'accepted',
            nativeSessionId: `native-${reviewerId}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
            nativeAgentId: `native-${reviewerId}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
          },
        }),
      ),
    );
    return view;
  };
  const fixed = (options) => {
    const attempt = readExecutionReviewState(h.read()).attempts.find(
      (a) => a.scope.runId === view.scope.runId,
    );
    const facts = fixedReviewFacts({ scope: attempt.scope, record: h.read(), attempt }, options);
    const result = {
      requestId: randomUUID(),
      source: facts.source,
      digest: facts.digest,
      readManifestDigest: facts.readManifestDigest,
      provenanceFingerprint: facts.provenanceFingerprint,
    };
    return { facts, result };
  };
  const seal = async (value) => {
    const body = scoped('event', {
      event: {
        kind: 'sealed',
        sequence: view.nextSequence,
        idle: true,
        flushed: true,
        resourcesSettled: true,
        result: value.result,
      },
    });
    view = ok(await send(body));
    return view;
  };
  const submit = (value) =>
    send(
      scoped('submit-result', { result: value.result, fixed: value.facts }, value.result.requestId),
    );
  const cleanup = () =>
    send(
      envelope('cleanup', {
        scope: view.scope,
        permit: h.cleanup.public,
        observation: {
          kind: 'drained',
          sequence: view.nextSequence,
          evidence: {
            basis: 'flushed-and-closed',
            nativeSessionId: `native-${view.scope.review.principal.reviewerRef.id}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
            nativeAgentId: `native-${view.scope.review.principal.reviewerRef.id}${view.scope.generation === 1 ? '' : `-${view.scope.generation}`}`,
          },
        },
      }),
      { secret: h.cleanup.raw, request: { headers: {} } },
    );
  return {
    ...h,
    send,
    workEnvelope: h.envelope,
    envelope,
    accept,
    scoped,
    begin,
    fixed,
    seal,
    submit,
    cleanup,
    cleanupCredential: h.cleanup,
    calls,
    hooks,
    get reviewView() {
      return view;
    },
    setView(value) {
      view = value;
    },
    get target() {
      return target;
    },
    async refreshTarget() {
      target = ok(
        await h.service.readExpertReviewTarget(h.request, { ...h.locate(), spaceId: 'north' }),
      );
    },
  };
}
