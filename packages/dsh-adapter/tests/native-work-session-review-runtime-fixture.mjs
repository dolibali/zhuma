/** Actual SDK/JSON/byte I/O; model responses and authorization are explicit fixtures.
 * This is not D member authentication, a production target reader or a ballot. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { canonicalPayload } from '@zhuma/agent-core';
import { boot, grant, scope, selection, ScriptedAdapter } from './native-work-session-fixture.mjs';
import { toolResponse } from './native-work-session-input-fixture.mjs';
import {
  createNativeFixedResultIssuer,
  nativeFixedReviewIssuer,
} from '../dist/native-work-session-result.js';
import { nativeReviewContextFromScope } from '../dist/native-work-session-review-contract.js';
export { toolResponse };
export { bootNativeResults } from './native-work-session-result-fixture.mjs';
export { NATIVE_REVIEW_LIMITS } from '../dist/native-work-session-review-contract.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function bootNativeReviews(root, options = {}) {
  const file = join(root, 'fixed-review-target.txt');
  const text = options.text ?? 'Fixed target: API status filtering preserves legacy callers.\n';
  await writeFile(file, text);
  const fingerprint = hash(Buffer.from(text));
  const artifactFingerprint = hash(canonicalPayload({ id: 'fixture-artifact', text, files: [] }));
  const authority = new WeakMap(),
    actors = new Map(),
    leases = new Set(),
    reads = [];
  const author = grant(),
    adapter = new ScriptedAdapter();
  let host, review;
  const ports = {
    authorize(original) {
      const record = authority.get(original);
      if (!record || record.abort.signal.aborted) throw Error('fixture-review-not-authorized');
      return { scope: record.scope, selection: record.selection, signal: record.abort.signal };
    },
    unavailableRequired(original) {
      ports.authorize(original);
      return options.unavailableRequired ?? [];
    },
    async readTarget(original, query, signal) {
      const record = ports.authorize(original);
      if (query.resourceRef !== 'fixed-body') throw Error('fixture-target-not-listed');
      await options.beforeRead?.({ original, query, signal });
      const bytes = await readFile(file);
      if (hash(bytes) !== fingerprint) throw Error('fixture-target-changed');
      ports.authorize(original);
      if (query.offset > bytes.length) throw Error('fixture-range-invalid');
      const data = bytes.subarray(query.offset, query.offset + query.length);
      const wrapper = host.service.reviewGrant(original),
        binding = host.service.open(wrapper).binding;
      const source = {
        context: nativeReviewContextFromScope(record.scope),
        nativeSessionId: binding.nativeSessionId,
        nativeAgentId: binding.nativeAgentId,
        configurationId: binding.selection.configurationId,
        resourceRef: query.resourceRef,
        resourceFingerprint: fingerprint,
      };
      const combined = AbortSignal.any([record.signal, signal]);
      let released = false;
      const lease = {
        source,
        bytes: data,
        range: { offset: query.offset, length: data.length, total: bytes.length },
        encoding: 'utf-8',
        signal: combined,
        check() {
          ports.authorize(original);
          if (released || combined.aborted) throw Error('fixture-read-revoked');
        },
        release() {
          if (released) return;
          released = true;
          leases.delete(lease);
        },
      };
      leases.add(lease);
      reads.push({ source, range: lease.range, sha256: hash(data) });
      return lease;
    },
  };
  host = await boot(
    root,
    adapter,
    (ctx, binding, current) => {
      const context = host.service.reviewContext(current);
      actors.set(context?.review.principal.reviewerRef.id ?? 'author', scopeOf(ctx));
      return context
        ? review.registerNativeReviewTools(ctx, binding, current)
        : { context: 'Author fixture context only.', toolAllowlist: [] };
    },
    {},
    ports,
  );
  const owner = createNativeFixedResultIssuer(
    host.ctx,
    host.service,
    host.runtime,
    {
      assertGrant(current) {
        if (current !== author) throw Error('fixture-author-only');
        author.assertCurrent('send');
      },
    },
    {
      readRunComposition() {
        throw Error('unused fixture author composition');
      },
    },
  );
  review = nativeFixedReviewIssuer(host.service, host.runtime);
  function reviewer(id = 'reviewer-a', overrides = {}) {
    const original = Object.freeze({}),
      abort = new AbortController();
    const reviewScope = {
      ...scope,
      runId: `run-${id}`,
      segmentId: `segment-${id}`,
      review: {
        target: {
          spaceId: scope.spaceId,
          taskId: scope.taskId,
          planId: scope.planId,
          revision: scope.revision,
          nodeId: scope.nodeId,
          roundId: 'fixture-round',
          artifactVersionId: 'fixture-artifact',
          artifactFingerprint,
        },
        principal: {
          kind: 'expert',
          controllerMemberId: scope.actorId,
          reviewerRef: { id, version: scope.planId, digest: hash(`fixture-expert-${id}`) },
        },
      },
      ...overrides,
    };
    const chosen = { ...selection, configurationId: `review-config-${id}` };
    authority.set(original, { scope: reviewScope, selection: chosen, abort });
    return {
      original,
      grant: host.service.reviewGrant(original),
      selection: chosen,
      scope: reviewScope,
      revoke: () => abort.abort(),
      actor: () => actors.get(id),
    };
  }
  function planReview(
    current,
    conclusion = 'approve',
    rationale = 'Checked the actual returned fixed body.',
  ) {
    adapter.script.push(
      toolResponse(
        { resourceRef: 'fixed-body', offset: 0, length: 32 },
        `read-${current.scope.runId}`,
        'read_review_target',
      ),
    );
    adapter.script.push((request) => {
      const ref = JSON.stringify(request).match(/review_read_[a-f0-9]{64}/u)?.[0];
      if (!ref) throw Error('SDK model request did not contain an actual read ACK');
      return toolResponse(
        {
          conclusion,
          rationale,
          anchors: [{ resourceRef: 'fixed-body', offset: 0, length: 8 }],
          evidenceRefs: [ref],
        },
        `complete-${current.scope.runId}`,
        'complete_review',
      )();
    });
  }
  const start = (current, requestId = 'start-review') =>
    host.service.send(current.grant, {
      requestId,
      text: 'Read the fixed target and review the returned content.',
      mode: 'followup',
      selection: current.selection,
    });
  return {
    ...host,
    owner,
    review,
    author,
    reviewer,
    planReview,
    start,
    actors,
    reads,
    leases,
    text,
    file,
    authorMessage: {
      requestId: 'author-start',
      text: 'Author private context.',
      mode: 'followup',
      selection,
    },
  };
}
