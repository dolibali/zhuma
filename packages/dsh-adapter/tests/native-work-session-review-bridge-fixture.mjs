/** Genuine D/JSON/claim/Drive/file reads and original SDK; model responses,
 * member source and A's empty resource adoption are explicit fixtures. No
 * manual accepted/idle events, alternate Agent factory or workflow pump. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { host } from './execution-review-service-fixture.mjs';
import { checked, open } from './execution-service-run-fixture.mjs';
import { boot, ScriptedAdapter, response } from './native-work-session-fixture.mjs';
import { toolResponse } from './native-work-session-input-fixture.mjs';
import { createNativeReviewBridge } from '../dist/native-work-session-review-bridge.js';
import { createNativeFixedResultIssuer } from '../dist/native-work-session-result.js';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from '../dist/native-work-session-review-read.js';
import { readExecutionReviewState } from '../dist/execution-review-state.js';
import { createHostRunConfiguration } from '../dist/host-run-configuration.js';
import { createHostRunSkillPolicies } from '../dist/host-run-skill-policy.js';
import { createHostRunResourceSource } from '../dist/host-run-resource-source.js';
import { seedScaledReviewMetadata } from './native-work-session-review-scale-fixture.mjs';
export { readExecutionReviewState };

export async function bootReviewBridge(root, after, options = {}) {
  const compositions = new Map(),
    changes = new Set(),
    reads = [],
    submitTrace = [];
  const hostMetrics = { checks: 0, workbenchReads: 0, elapsedMs: 0, preparations: 0 };
  let productionConfiguration,
    checkingProduction = 0;
  const d = await host(
    { after },
    {
      reviewerIds: ['qa'],
      file:
        options.file === false
          ? undefined
          : {
              name: 'fixed-api.txt',
              mediaType: 'text/plain',
              text: '固定附件：旧 status 参数必须兼容。',
            },
      assertReviewConfiguration(member, space, node, saved) {
        assert.deepEqual(saved, compositions.get(saved.configurationId));
        if (options.refuseAdmission) throw Error('SYNTHETIC_REVIEW_CONFIGURATION_REFUSAL');
        if (options.productionHost) {
          hostMetrics.checks++;
          const outer = checkingProduction++ === 0,
            start = performance.now();
          try {
            return productionConfiguration.assertReviewConfiguration(member, space, node, saved);
          } finally {
            checkingProduction--;
            if (outer) hostMetrics.elapsedMs += performance.now() - start;
          }
        }
        return undefined;
      },
    },
  );
  d.faults.afterNodeWrite = () => {
    for (const change of changes) change();
  };
  const actualSubmit = d.service.submitNativeFixedReview.bind(d.service);
  d.service.submitNativeFixedReview = async (...args) => {
    const result = await actualSubmit(...args);
    submitTrace.push(result);
    return result;
  };
  const actualRead = d.service.readExpertReviewResource.bind(d.service);
  d.service.readExpertReviewResource = async (...args) => {
    const lease = await actualRead(...args);
    reads.push({
      resourceRef: lease.resource.resourceRef,
      bytes: Buffer.from(lease.bytes),
      range: lease.range,
    });
    return lease;
  };
  const source = new AbortController(),
    adapter = new ScriptedAdapter();
  if (options.productionPrepare)
    adapter.listModels = async (provider) => [
      { provider, id: 'contract-model', name: 'Synthetic passive model catalogue' },
    ];
  const bridge = createNativeReviewBridge({
    execution: d.service,
    signal: source.signal,
    host: {
      async prepareReview(original, { model, ...query }, wait) {
        wait.throwIfAborted();
        let saved;
        if (options.productionPrepare) {
          hostMetrics.preparations++;
          const { provider, model: modelId, reasoningEffort } = model;
          saved = await productionConfiguration.prepareReview(
            original,
            { ...query, model: { provider, model: modelId, reasoningEffort } },
            wait,
          );
        } else {
          const preparation = checked(await d.service.readExpertReviewPreparation(original, query));
          saved = freezeExecutionReviewComposition({
            ...preparation,
            model,
            tools: {
              readTarget: describeNativeReviewReadTool(),
              completeReview: describeNativeReviewTool(),
            },
          });
        }
        compositions.set(saved.configurationId, saved);
        for (const resource of saved.payload.targetResources.filter(
          (item) => !options.omitFile || item.kind !== 'file',
        ))
          adapter.script.push(
            toolResponse(
              { resourceRef: resource.resourceRef, offset: 0, length: resource.bytes },
              `read-${resource.resourceRef}`,
              'read_review_target',
            ),
          );
        adapter.script.push(async (request) => {
          const evidenceRefs = [
            ...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu)),
          ];
          assert.equal(
            evidenceRefs.length,
            options.omitFile ? 1 : saved.payload.targetResources.length,
          );
          await options.beforeCompletion?.();
          if (options.finishReason)
            return response('Synthetic review response without a completion declaration.').map(
              (chunk) =>
                chunk.type === 'finish'
                  ? { ...chunk, reason: { kind: options.finishReason } }
                  : chunk,
            );
          return toolResponse(
            {
              conclusion: 'approve',
              rationale: '已读取固定正文及附件并核对接口兼容。',
              anchors: [{ resourceRef: 'review_text', offset: 0, length: 8 }],
              evidenceRefs,
            },
            'review-complete',
            'complete_review',
          )();
        });
        if (!options.finishReason) adapter.script.push('Review complete.');
        await options.afterPreparation?.(saved);
        return saved;
      },
      async adoptReviewResources(ctx, input) {
        const { drive, composition } = input;
        options.adoptionStarted?.();
        assert.equal(composition.payload.resources.skills.length, 0);
        assert.equal(composition.payload.resources.mcp.length, 0);
        return {
          scope: drive.scope,
          configurationId: composition.configurationId,
          signal: drive.signal,
          context: '',
          toolAllowlist: [],
          descriptors: [],
          ready: Promise.resolve(),
          assertCurrent() {
            d.service.assertExpertReviewDriveGrant(drive, 'send');
            return undefined;
          },
          async drain() {},
          async dispose() {},
          ...(typeof options.adoption === 'function'
            ? await options.adoption(ctx, input)
            : options.adoption),
        };
      },
    },
  });
  const native = await boot(
    join(root, 'native'),
    adapter,
    (ctx, binding, grant) => bridge.compose(ctx, binding, grant),
    {},
    bridge.reviewPorts,
  );
  after(() => native.close());
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
        throw Error('unused author composition');
      },
    },
  );
  bridge.bindNative(native.service, native.runtime);
  if (options.productionHost) {
    const lifetime = new AbortController();
    after(() => lifetime.abort());
    const source = {
      execution: d.service,
      readWorkbench() {
        hostMetrics.workbenchReads++;
        return d.readWorkbench();
      },
      signal: lifetime.signal,
    };
    // This fixture's reviewer selects no Skills/MCP. Nonempty package authority
    // remains covered by the Host importer's own fixtures.
    const policies = createHostRunSkillPolicies({ ...source, readPackage: () => undefined });
    const resources = createHostRunResourceSource({ ...source, policies });
    productionConfiguration = createHostRunConfiguration(native.ctx, { ...source, resources });
  }
  if (options.scaledHistory) await seedScaledReviewMetadata(d);
  await options.afterNative?.({ native, bridge, d, hostMetrics });
  after(() => bridge.closeBeforeNative());
  const { nodeId: _nodeId, ...location } = { ...d.locate(), spaceId: 'north' };
  const view = checked(
    await d.service.startWorkflowExecution(d.request, {
      ...location,
      requestId: 'start-automatic-review',
      defaults: {
        model: { provider: 'contract', model: 'contract-model', maxTokens: 3000 },
        tools: 'text-only',
        workspace: { kind: 'text-only' },
      },
      budget: { concurrent: 1, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    }),
  );
  const claim = checked(
    await d.service.claimWorkflowExecution(d.request, {
      ...location,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    }),
  );
  function waitFor(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        changes.delete(changed);
        reject(
          Error(
            'original Service condition not reached: ' +
              JSON.stringify({
                command: d.read().command.status,
                review: readExecutionReviewState(d.read())?.attempts.map(
                  ({ status, resources, stopPhase, lastEventSequence }) => ({
                    status,
                    resources,
                    stopPhase,
                    lastEventSequence,
                  }),
                ),
                submitTrace,
                nativeRows: [
                  ...native.ctx.storageDomain
                    .get('zhuma_native_work_sessions')
                    .table('bindings')
                    .entries(),
                ].map(([, v]) => ({
                  intent: v.binding?.reviewIntent,
                  reviewIntent: v.reviewIntent,
                  intent2: v.intent,
                  keys: Object.keys(v),
                })),
                modelCalls: adapter.requests.length,
                reads: reads.map((item) => item.resourceRef),
              }),
          ),
        );
      }, 45_000);
      const changed = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        changes.delete(changed);
        resolve();
      };
      changes.add(changed);
      changed();
    });
  }
  return {
    root,
    d,
    native,
    owner,
    bridge,
    source,
    adapter,
    claim,
    view,
    location,
    compositions,
    reads,
    submitTrace,
    hostMetrics,
    waitFor,
  };
}

/** Reopen the same genuine D JSON and native Session with fresh owners and no
 * claim consumption. No model or resource adoption is allowed in cold cleanup. */
export async function reopenStoppedReviewBridge(warm, after) {
  assert.equal((await warm.bridge.closeBeforeNative()).status, 'settled');
  await warm.owner.close();
  await warm.native.close();
  await warm.d.close();
  const d = await open(warm.d.root, { seed: false, workbench: warm.d.snapshot });
  after(() => d.close());
  const source = new AbortController(),
    adapter = new ScriptedAdapter(),
    bridge = createNativeReviewBridge({
      execution: d.service,
      signal: source.signal,
      host: {
        async prepareReview() {
          throw Error('Cold cleanup must never prepare another review.');
        },
        async adoptReviewResources() {
          throw Error('Cold cleanup must never adopt another resource scope.');
        },
      },
    });
  const native = await boot(
    join(warm.root, 'native'),
    adapter,
    () => {
      throw Error('Cold cleanup must never create or resume an Agent.');
    },
    {},
    bridge.reviewPorts,
  );
  after(() => native.close());
  createNativeFixedResultIssuer(
    native.ctx,
    native.service,
    native.runtime,
    {
      assertGrant() {
        throw Error('Cold cleanup cannot drive an author.');
      },
    },
    {
      readRunComposition() {
        throw Error('Cold cleanup cannot read author composition.');
      },
    },
  );
  bridge.bindNative(native.service, native.runtime);
  after(() => bridge.closeBeforeNative());
  return { d, native, bridge, source, adapter };
}
