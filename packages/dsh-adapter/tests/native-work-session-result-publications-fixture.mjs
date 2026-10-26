/** Actual member/Run/SDK fixture; model replies and Host path grants are explicit contracts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootOutputFiles } from './native-work-session-output-file-fixture.mjs';
import { toolResponse } from './native-work-session-input-fixture.mjs';
import {
  createNativeFixedResultIssuer,
  createNativeFixedResultPublicationsIssuer,
} from '../dist/native-work-session-result.js';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from '../dist/native-work-session-result-publications-tool.js';
export { bootOutputFiles, createNativeFixedResultPublicationsIssuer };
export { qualifyNativePublicationEvidence } from '../dist/native-work-session-result-publications-source.js';
export {
  nativeResultPublicationsDigest,
  nativePublicationManifestDigest,
} from '../dist/native-work-session-result-publications-source.js';

export async function bootPublicationResults(
  root,
  {
    first = true,
    activate = true,
    version = 2,
    ownerVersion = version,
    extraExpertNode = false,
  } = {},
) {
  let owner, results;
  const h = await bootOutputFiles(root, {
    first,
    activate,
    extraExpertNode,
    resultIntentTool:
      version === 2 ? describeNativeResultPublicationsTool() : describeNativeResultTool(),
    configureResults(host) {
      const args = [
        host.ctx,
        host.native.service,
        host.native.runtime,
        host.issuer,
        host.execution,
      ];
      owner =
        ownerVersion === 2
          ? createNativeFixedResultPublicationsIssuer(...args, host.outputIssuer)
          : createNativeFixedResultIssuer(...args);
      results = version === 1 && ownerVersion === 2 ? owner.v1Issuer : owner;
    },
    composeResults(ctx, binding, grant) {
      return owner.registerNativeResultTool(ctx, binding, grant);
    },
  });
  function scope(opened, binding, view) {
    const message = () => h.firstMessage(h.execution.readRunComposition(opened.grant.scope));
    return {
      opened,
      binding,
      results: view,
      async admit() {
        const actual = h.native.service.open(opened.grant).binding;
        assert.equal(actual.nativeAgentId, binding.nativeAgentId);
        assert.equal(actual.nativeSessionId, binding.nativeSessionId);
        assert.ok(
          actual.receipts.some((receipt) => ['received', 'claimed'].includes(receipt.status)),
        );
        const agent = h.ctx.agents.get(binding.nativeAgentId);
        assert.ok(agent);
        assert.equal(agent.id, binding.nativeAgentId);
        assert.equal(agent.session.id, binding.nativeSessionId);
        const node = h.row(binding.scope.nodeId),
          run = node.nativeExecution.runs.find((item) => item.attempt.id === binding.scope.runId);
        // Original Host bridge operation, populated only from actual SDK receipt/Agent IDs.
        const accepted = await h.execution.recordRunEvent(
          h.locate(binding.scope.nodeId),
          {
            kind: 'accepted',
            runId: binding.scope.runId,
            generation: binding.scope.generation,
            segmentId: binding.scope.segmentId,
            sequence: run.attempt.lastEventSequence + 1,
            nativeSessionId: binding.nativeSessionId,
            executorRunId: binding.nativeAgentId,
          },
          { grant: opened.grant },
        );
        assert.equal(accepted.ok, true, JSON.stringify(accepted));
      },
      async declare(content, { callId = randomUUID(), rejected = false } = {}) {
        const agent = h.ctx.agents.get(binding.nativeAgentId);
        assert.ok(agent);
        h.adapter.script.push(toolResponse(content, callId, 'complete_work'));
        if (rejected)
          h.adapter.script.push('The requested result was rejected; work remains incomplete.');
        await h.native.service.send(opened.grant, {
          ...message(),
          requestId: randomUUID(),
          text: 'Declare the current work result.',
        });
        await agent.whenIdle();
        return view.prepareFixedResult(opened.grant, new AbortController().signal);
      },
      async ready() {
        for (let i = 0; i < 8; i++) {
          const prepared = await view.prepareFixedResult(
            opened.grant,
            new AbortController().signal,
          );
          if (prepared.status === 'ready' || prepared.reason === 'not-declared') return prepared;
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw Error('The original fixed-result owner did not reach a ready cut.');
      },
      async publish(args, callId = randomUUID()) {
        const agent = h.ctx.agents.get(binding.nativeAgentId);
        assert.ok(agent);
        h.adapter.script.push(
          toolResponse(args, callId, 'publish_output_file'),
          'Publication returned.',
        );
        await h.native.service.send(opened.grant, {
          ...message(),
          requestId: randomUUID(),
          text: 'Publish the requested output.',
        });
        await agent.whenIdle();
        const events = [];
        let cursor = -1;
        for (;;) {
          const page = await h.native.service.history(opened.grant, cursor, 20);
          events.push(...page.events);
          cursor = page.events.at(-1)?.seq ?? cursor;
          if (page.events.length < 20) break;
        }
        const result = events
          .filter((e) => e.type === 'tool/result' && e.data.message.toolCallId === callId)
          .at(-1);
        assert.ok(result);
        return JSON.parse(result.data.message.content[0].text);
      },
    };
  }
  return {
    ...h,
    ...scope(h.opened, h.binding, results),
    resultOwner: owner,
    async startSibling() {
      const opened = await h.begin(undefined, {
        nodeId: 'expert-other',
        runId: 'file-run-other',
        segmentId: 'file-segment-other',
        resultIntentTool: describeNativeResultPublicationsTool(),
      });
      const snapshot = h.execution.readRunComposition(opened.grant.scope);
      h.adapter.script.push('The second native Run is in progress.');
      await h.native.service.send(opened.grant, {
        ...h.firstMessage(snapshot),
        requestId: randomUUID(),
      });
      const binding = h.native.service.open(opened.grant).binding;
      await h.ctx.agents.get(binding.nativeAgentId).whenIdle();
      return scope(opened, binding, owner);
    },
  };
}
