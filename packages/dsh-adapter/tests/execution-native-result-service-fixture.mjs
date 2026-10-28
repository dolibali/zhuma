/** Actual product Service/authority/DSH JSON. Member and C result producers are explicit contracts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { open, checked } from './execution-service-run-fixture.mjs';
import { command } from './execution-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { readExecutionRunState, executionRunScope } from '../dist/execution-run-state.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { nativeResultProvenance } from '../dist/execution-native-result-delivery.js';

export function deferred() {
  const value = Promise.withResolvers();
  return { promise: value.promise, resolve: value.resolve, reject: value.reject };
}
export async function openResultContract(
  root,
  {
    readerOnly = false,
    install = true,
    human = false,
    text = 'Fixed contract result.',
    migrationDrain,
  } = {},
) {
  const h = await open(root, {
    seed: !readerOnly,
    expertNode: human ? undefined : 'produce',
    migrationDrain,
  });
  if (readerOnly) {
    h.resetCounts();
    return h;
  }
  const node = h.read();
  const { actorId, ...raw } = command(node);
  const { configurationId: _configurationId, ...model } = raw.selection;
  const composition = freezeExecutionRunComposition({
    workbench: h.readWorkbench(),
    node,
    scope: {
      ...h.locate(),
      actorId,
      spaceId: 'north',
      runId: raw.newRunId,
      generation: 1,
      segmentId: raw.newSegmentId,
    },
    model,
    executor: human ? { kind: 'builtin' } : { kind: 'plan-expert', ref: node.handoff.expertRef },
    tools: { kind: 'text-only' },
    resultIntentTool: describeNativeResultTool(),
    inputs: { ...h.locate(), actorId, spaceId: 'north', items: [] },
  });
  const { firstMessage: _message, ...projected } = executionRunCompositionRequest(composition);
  checked(
    await h.service.startRun(h.request, { ...h.locate(), ...raw, ...projected, composition }),
  );
  const opened = await h.authorities.open(h.request, h.runLocator(), 'drive');
  checked(
    await h.native(
      'accepted',
      { grant: opened.grant },
      { nativeSessionId: 'contract-native-session', executorRunId: 'contract-native-agent' },
    ),
  );
  const counts = { prepared: 0, read: 0, checks: 0, released: 0 };
  const controls = {
    gate: undefined,
    releaseGate: undefined,
    releaseEntered: deferred(),
    releaseFailure: false,
    mutate: undefined,
    afterRead: undefined,
    privateLookup: 0,
    reenter: false,
    onPrepare: undefined,
    leaseEntered: deferred(),
    prepareEntered: deferred(),
    twoReadersEntered: deferred(),
  };
  const ref = Object.freeze({});
  const owner = new AbortController();
  const issuer = {
    async prepareFixedResult(grant, signal) {
      counts.prepared++;
      controls.prepareEntered.resolve();
      controls.onPrepare?.();
      h.authorities.assertGrant(grant, 'send');
      if (controls.reenter)
        checked(
          await h.service.readRunCompositionInputs(h.request, { ...h.locate(), spaceId: 'north' }),
        );
      await controls.gate?.promise;
      signal.throwIfAborted();
      h.authorities.assertGrant(grant, 'send');
      return { status: 'ready', ref };
    },
    assertFixedResult(grant, received) {
      h.authorities.assertGrant(grant, 'send');
      assert.equal(received, ref, 'contract result object identity');
      owner.signal.throwIfAborted();
      return undefined;
    },
    async readFixedResult(grant, received, signal) {
      this.assertFixedResult(grant, received);
      counts.read++;
      if (counts.read === 2) controls.twoReadersEntered.resolve();
      controls.privateLookup++;
      const run = readExecutionRunState(h.read()).runs.at(-1);
      const content = Object.freeze({ text, links: Object.freeze(['https://example.com/fixed']) });
      const source = {
        scope: executionRunScope(h.read(), run),
        nativeSessionId: 'contract-native-session',
        nativeAgentId: 'contract-native-agent',
        configurationId: composition.configurationId,
        toolVersion: 'zhuma-native-result-intent@1',
        intentId: 'contract-intent',
        callId: 'contract-call',
        cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
      };
      const digest = nativeResultDigest(content);
      let released = false;
      const lease = {
        source,
        content,
        digest,
        provenanceFingerprint: nativeResultProvenance(source, digest),
        signal: AbortSignal.any([signal, owner.signal, grant.signal]),
        check: () => {
          counts.checks++;
          assert.equal(released, false);
          lease.signal.throwIfAborted();
          issuer.assertFixedResult(grant, received);
        },
        release: () => {
          assert.equal(released, false);
          released = true;
          counts.released++;
          controls.releaseEntered.resolve();
          if (controls.releaseFailure) throw Error('CONTRACT_RELEASE_FAILURE');
          return controls.releaseGate?.promise;
        },
      };
      controls.mutate?.(lease);
      controls.leaseEntered.resolve();
      await controls.afterRead?.promise;
      return lease;
    },
    registerNativeResultTool() {
      throw Error('not a native SDK fixture');
    },
    onReady() {
      return () => {};
    },
    async close() {
      owner.abort();
    },
  };
  if (install) h.service.installNativeResultIssuer(issuer);
  h.resetCounts();
  return {
    ...h,
    ref,
    issuer,
    opened,
    controls,
    counts,
    submission(key = 'submit-result') {
      const current = h.read();
      const state = readExecutionRunState(current);
      const run = state.runs.at(-1);
      return {
        ...h.locate(),
        runId: run.attempt.id,
        generation: run.attempt.generation,
        segmentId: run.segmentId,
        configurationId: run.selection.configurationId,
        idempotencyKey: key,
        expectedNodeVersion: current.command.version,
        expectedRunVersion: state.version,
      };
    },
  };
}

/** Test-only loss of the response after the actual original JSON put completed. */
export function loseNextPutResponse(h) {
  const storage = h.service.storage;
  const original = storage.writeNode;
  let armed = true;
  storage.writeNode = async function (...args) {
    await original.apply(this, args);
    if (armed) {
      armed = false;
      throw Error('CONTRACT_DURABLE_PUT_RESPONSE_LOST');
    }
  };
  return () => {
    storage.writeNode = original;
  };
}

export async function businessHashes(root, prefix = '') {
  const values = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) values.push(...(await businessHashes(root, path)));
    else if (entry.isFile() && entry.name.endsWith('.json'))
      values.push([
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]);
  }
  return values;
}

export function confirmation(h, receipt) {
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
  };
}
