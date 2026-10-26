/** Product Service/Run manager/DSH JSON are real. C completion evidence, member
 * issuer and byte provider are explicit contracts; no native SDK completion proof.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalPayload } from '@zhuma/agent-core';
import { open, checked } from './execution-service-run-fixture.mjs';
import { command } from './execution-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { readExecutionRunState, executionRunScope } from '../dist/execution-run-state.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import {
  nativePublicationManifestDigest,
  nativeResultPublicationsDigest,
} from '../dist/native-work-session-result-publications-source.js';
import { nativeResultProvenance } from '../dist/execution-native-result-delivery.js';
import { artifactFileReference } from '../dist/artifact-files.js';
export const deferred = () => Promise.withResolvers();
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');

export async function openManifestContract(
  root,
  { protocolVersion = 2, readerOnly = false, install = true } = {},
) {
  const h = await open(root, { seed: !readerOnly, expertNode: 'produce' });
  if (readerOnly) {
    h.resetCounts();
    return h;
  }
  const row = h.read();
  const { actorId, ...raw } = command(row);
  const { configurationId: _unused, ...model } = raw.selection;
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node: row,
    scope: {
      ...h.locate(),
      actorId,
      spaceId: 'north',
      runId: raw.newRunId,
      generation: 1,
      segmentId: raw.newSegmentId,
    },
    model,
    executor: { kind: 'plan-expert', ref: row.handoff.expertRef },
    tools: { kind: 'text-only' },
    resultIntentTool:
      protocolVersion === 2 ? describeNativeResultPublicationsTool() : describeNativeResultTool(),
    inputs: { ...h.locate(), actorId, spaceId: 'north', items: [] },
  });
  const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
  checked(
    await h.service.startRun(h.request, { ...h.locate(), ...raw, ...projection, composition }),
  );
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  checked(
    await h.native(
      'accepted',
      { grant: opened.grant },
      { nativeSessionId: 'manifest-session', executorRunId: 'manifest-agent' },
    ),
  );
  const run = readExecutionRunState(h.read()).runs.at(-1);
  const bytes = new TextEncoder().encode('Fixed verified publication bytes.');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const publicationSource = {
    scope: executionRunScope(h.read(), run),
    nativeSessionId: 'manifest-session',
    nativeAgentId: 'manifest-agent',
    configurationId: composition.configurationId,
    expertVersionId: run.attempt.expertVersionId,
    toolVersion: 'zhuma-native-output-file@1',
    callId: 'publish-call',
  };
  const selectorFingerprint = hash({ path: 'outputs/result.txt', name: 'result.txt' });
  const record = {
    uploadId: 'manifest-publication',
    attachmentId: `sha256:${digest}`,
    name: 'result.txt',
    mediaType: 'text/plain',
    byteSize: bytes.byteLength,
    sha256: digest,
    spaceId: 'north',
    ...h.locate(),
    uploadedBy: actorId,
    idempotencyKey: 'publication-receipt',
    state: 'completed',
    uploadedAt: '2026-10-26T00:00:00Z',
    producer: {
      kind: 'native-run-output',
      version: 1,
      source: publicationSource,
      selectorFingerprint,
    },
  };
  if (protocolVersion === 2) await h.service.fileStore.putNativePublication(record);
  const evidence = {
    publicationId: record.uploadId,
    source: publicationSource,
    callSeq: 1,
    resultSeq: 2,
    selectorFingerprint,
    name: record.name,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    sha256: record.sha256,
  };
  const manifest = [{ evidence, record }];
  const owner = new AbortController();
  const ref = Object.freeze({});
  const counts = { v1Reads: 0, v2Reads: 0, releases: 0, bytes: 0 };
  const controls = {
    mutate: undefined,
    prepare: undefined,
    afterLease: undefined,
    readGate: undefined,
    bytesOverride: undefined,
    readEntered: deferred(),
    bytesYielded: deferred(),
    leaseEntered: deferred(),
  };
  h.service.attachments = {
    async *readFileStream(input, signal) {
      counts.bytes++;
      assert.equal(input.attachmentId, record.attachmentId);
      controls.readEntered.resolve();
      signal.throwIfAborted();
      yield controls.bytesOverride ?? bytes;
      controls.bytesYielded.resolve();
      await controls.readGate?.promise;
      signal.throwIfAborted();
    },
  };
  const shared = {
    registerNativeResultTool() {
      throw Error('Contract producer is not a native SDK tool.');
    },
    async prepareFixedResult(grant, signal) {
      h.authorities.assertGrant(grant, 'send');
      await controls.prepare?.promise;
      signal.throwIfAborted();
      return { status: 'ready', ref };
    },
    assertFixedResult(grant, received) {
      assert.equal(received, ref);
      h.authorities.assertGrant(grant, 'send');
      owner.signal.throwIfAborted();
      return undefined;
    },
    onReady() {
      return () => {};
    },
    async close() {
      owner.abort();
    },
  };
  async function read(version, grant, received, signal) {
    shared.assertFixedResult(grant, received);
    counts[version === 2 ? 'v2Reads' : 'v1Reads']++;
    const content =
      version === 2
        ? { files: [artifactFileReference(record)], links: [] }
        : { text: 'legacy text', links: [] };
    const manifestDigest = nativePublicationManifestDigest(manifest);
    const source = {
      scope: structuredClone(publicationSource.scope),
      nativeSessionId: publicationSource.nativeSessionId,
      nativeAgentId: publicationSource.nativeAgentId,
      configurationId: composition.configurationId,
      toolVersion: `zhuma-native-result-intent@${version}`,
      intentId: 'manifest-intent',
      callId: 'complete-call',
      cut: { callSeq: 3, resultSeq: 4, turnEndSeq: 5, asOfSeq: 5 },
      ...(version === 2 ? { manifestDigest, expertVersionId: run.attempt.expertVersionId } : {}),
    };
    const resultDigest =
      version === 2
        ? nativeResultPublicationsDigest(
            { links: [], publications: [{ publicationId: record.uploadId }] },
            manifestDigest,
          )
        : nativeResultDigest(content);
    let released = false;
    const lease = {
      source,
      content,
      digest: resultDigest,
      provenanceFingerprint: nativeResultProvenance(source, resultDigest),
      ...(version === 2 ? { manifest: structuredClone(manifest), manifestDigest } : {}),
      signal: AbortSignal.any([signal, owner.signal, grant.signal]),
      check() {
        assert.equal(released, false);
        shared.assertFixedResult(grant, received);
        this.signal.throwIfAborted();
      },
      release() {
        assert.equal(released, false);
        released = true;
        counts.releases++;
      },
    };
    controls.mutate?.(lease);
    controls.leaseEntered.resolve();
    await controls.afterLease?.promise;
    return lease;
  }
  const v1 = {
    ...shared,
    readFixedResult: (grant, received, signal) => read(1, grant, received, signal),
  };
  const v2 = {
    ...shared,
    v1Issuer: v1,
    readFixedResult: (grant, received, signal) => read(2, grant, received, signal),
  };
  if (install) h.service.installNativeResultIssuer(v1, v2);
  h.resetCounts();
  return {
    ...h,
    bytes,
    record,
    manifest,
    opened,
    ref,
    v1,
    v2,
    controls,
    counts,
    submission(idempotencyKey = 'submit-manifest') {
      const node = h.read(),
        state = readExecutionRunState(node),
        run = state.runs.at(-1);
      return {
        ...h.locate(),
        runId: run.attempt.id,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        configurationId: composition.configurationId,
        idempotencyKey,
        expectedNodeVersion: node.command.version,
        expectedRunVersion: state.version,
      };
    },
    confirmation(receipt) {
      return {
        ...h.locate(),
        runId: receipt.producerRunId,
        generation: receipt.generation,
        segmentId: receipt.segmentId,
        configurationId: receipt.configurationId,
        idempotencyKey: receipt.receipt.idempotencyKey,
        intentId: receipt.intentId,
        digest: receipt.digest,
        provenanceFingerprint: receipt.provenanceFingerprint,
        ...(receipt.protocolVersion === 2
          ? { protocolVersion: 2, manifestDigest: receipt.manifestDigest }
          : {}),
      };
    },
  };
}
