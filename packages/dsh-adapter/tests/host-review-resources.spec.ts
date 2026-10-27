/** Emitted production Host, original SDK Agent/Skill and real member cookies.
 * Model responses and confirmed plan data are explicit isolated fixtures. */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
const errors = [];
beforeEach(() => {
  errors.length = 0;
});
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const row = (h, id) =>
  [...h.table.entries()].map(([, node]) => node).find((node) => node.nodeId === id);
const attempt = (h) => row(h, 'produce')?.nativeExecution?.review?.attempts.at(-1);
function observeErrors(h) {
  h.ctx.on(
    'tools/result',
    (exec, result) => {
      errors.push(['SDK_TOOL_RESULT', exec.name, result.isError ? result.error : result.value]);
    },
    { global: true },
  );
  h.ctx.on(
    'agent/error',
    ({ agent, error }) => {
      errors.push([
        'SDK_AGENT_ERROR',
        agent?.id,
        error && { name: error.name, message: error.message, code: error.code, stack: error.stack },
      ]);
    },
    { global: true },
  );
}
function diagnostics(h) {
  return {
    errors,
    native: [
      ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
    ].map(([, r]) => ({
      role: r.role,
      intent: r.reviewIntent,
      receipts: r.binding?.receipts,
      agent: r.binding && h.ctx.agents.get(r.binding.nativeAgentId)?.status,
    })),
    nodes: [...h.table.entries()].map(([, n]) => ({
      id: n.nodeId,
      status: n.command.status,
      author: n.nativeExecution?.runs.map((r) => ({
        status: r.attempt.status,
        dispatch: r.dispatch,
        acknowledged: r.attempt.acknowledged,
        resources: r.resources,
      })),
      reviews: n.nativeExecution?.review?.attempts.map((r) => ({
        status: r.status,
        dispatch: r.dispatch,
        resources: r.resources,
        failure: r.failure,
        reviewer: r.scope.review.principal.reviewerRef.id,
      })),
    })),
    calls: h.adapter.requests.map((r) => r.tools.map((t) => t.name)),
  };
}
async function wait(h, predicate) {
  if (predicate()) return;
  await new Promise((resolve, reject) => {
    const stop = h.ctx.on(
      'domain/changed',
      () => {
        if (predicate()) {
          clearTimeout(timer);
          stop();
          resolve();
        }
      },
      { global: true },
    );
    const timer = setTimeout(() => {
      stop();
      reject(new Error(JSON.stringify(diagnostics(h))));
    }, 60000);
    if (predicate()) {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
}

function tool(name, args, callId = name) {
  return function* () {
    const json = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: json },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
const nodes = (base) => [
  {
    ...base,
    id: 'produce',
    assigneeId: 'qa',
    reviewerIds: ['qa-review'],
    reviewRequired: true,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
  },
  {
    ...base,
    id: 'consume',
    assigneeId: 'qa',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: ['produce'],
    skillIds: [],
    mcpIds: [],
  },
];
const start = (h) =>
  h.rpc('workflow', 'start', {
    ...h.workflowLocation,
    requestId: 'start-independent-review',
    model: { provider: 'contract', model: 'contract-model', maxTokens: 3000 },
    workspace: { kind: 'text-only' },
    concurrent: 1,
  });

test(
  'actual Host independent review: real selected Skill and fixed read precede atomic expert ballot and downstream',
  { timeout: 120000 },
  async (t) => {
    let h;
    const body = 'Fixed API contract: retain the status field.';
    const adapter = new ScriptedAdapter([
      tool('complete_work', { text: body, links: [] }),
      (request) => {
        assert.deepEqual(request.tools.map((item) => item.name).sort(), [
          'complete_review',
          'read_review_target',
          'skill',
        ]);
        assert(!JSON.stringify(request).includes('PARENT_PRIVATE_BODY'));
        const selected = attempt(h).composition.payload.resources.skills[0];
        assert.equal(selected.policySource.kind, 'asset-package');
        return tool('skill', { name: selected.name })();
      },
      (request) => {
        assert(JSON.stringify(request).includes('SELECTED_ORIGINAL_SKILL_BODY'));
        return tool('read_review_target', {
          resourceRef: 'review_text',
          offset: 0,
          length: Buffer.byteLength(body),
        })();
      },
      (request) => {
        const evidenceRefs = [
          ...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu)),
        ];
        assert.equal(evidenceRefs.length, 1);
        assert(JSON.stringify(request).includes(body));
        return tool('complete_review', {
          conclusion: 'approve',
          rationale: 'Read the exact fixed API body using the independently loaded method.',
          anchors: [{ resourceRef: 'review_text', offset: 0, length: 8 }],
          evidenceRefs,
        })();
      },
      'Independent review declaration finished.',
      tool('complete_work', { text: 'Downstream used the reviewed contract.', links: [] }),
    ]);
    h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      reviewerSkill: true,
      parentSkill: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    observeErrors(h);
    checked(await start(h));
    await wait(
      h,
      () =>
        row(h, 'consume')?.command.status === 'completed' && attempt(h)?.resources === 'settled',
    );
    assert.equal(row(h, 'produce').rounds[0].ballots.length, 1);
    assert.equal(row(h, 'produce').rounds[0].ballots[0].reviewerId, 'qa-review');
    assert.equal(attempt(h).status, 'completed');
    assert.notEqual(
      attempt(h).nativeSessionId,
      row(h, 'produce').nativeExecution.runs[0].nativeSessionId,
    );
    assert.equal(h.counts.nativeOpened, 1);
    assert.equal(h.counts.executionOpened, 1);
    assert.deepEqual(
      attempt(h).composition.payload.resources.skills.map((item) => item.ref.id),
      ['api-skill'],
    );
    assert.equal(h.ctx.agents.get(attempt(h).nativeAgentId), undefined);
    assert.equal(adapter.script.length, 0);
  },
);

test(
  'actual Host independent review: missing fixed read is rejected without a ballot or downstream and retains its review obligation',
  { timeout: 120000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('complete_work', { text: 'Fixed output needing independent review.', links: [] }),
      tool('complete_review', {
        conclusion: 'approve',
        rationale: 'Invalid synthetic no-read proposal.',
        anchors: [],
        evidenceRefs: ['review_read_' + 'a'.repeat(64)],
      }),
      'Cannot complete without the actual required read.',
    ]);
    const h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    observeErrors(h);
    checked(await start(h));
    await wait(h, () => adapter.requests.length >= 3 && attempt(h)?.nativeAgentId);
    await h.ctx.agents.get(attempt(h).nativeAgentId)?.whenIdle();
    const view = checked(await h.rpc('workflow', 'read', h.workflowLocation));
    checked(
      await h.rpc('workflow', 'stop', {
        ...h.workflowLocation,
        requestId: 'stop-unread-review',
        intentId: view.intent.intentId,
        generation: view.intent.generation,
      }),
    );
    await wait(h, () => attempt(h)?.resources === 'settled');
    assert.equal(row(h, 'produce').rounds[0].ballots.length, 0);
    assert.equal(row(h, 'consume').command.status, 'blocked');
    assert.equal(h.ctx.agents.get(attempt(h).nativeAgentId), undefined);
    assert.equal(adapter.requests.length, 3);
  },
);

test(
  'actual Host independent review: close retains the original owners until an actual held review stream ends',
  { timeout: 120000 },
  async (t) => {
    const entered = Promise.withResolvers(),
      cancelled = Promise.withResolvers(),
      release = Promise.withResolvers();
    const adapter = new ScriptedAdapter([
      tool('complete_work', {
        text: 'Fixed original body for a held independent review.',
        links: [],
      }),
      async function* (options) {
        entered.resolve();
        if (!options.signal.aborted)
          await new Promise((resolve) =>
            options.signal.addEventListener('abort', resolve, { once: true }),
          );
        cancelled.resolve();
        await release.promise;
        options.signal.throwIfAborted();
      },
    ]);
    const h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    observeErrors(h);
    checked(await start(h));
    await wait(h, () => adapter.requests.length >= 2);
    await entered.promise;
    t.onTestFailed(() => release.resolve());
    await wait(h, () => attempt(h)?.status === 'running');
    let closed = false;
    const closing = h.host.dispose().then(() => {
      closed = true;
    });
    try {
      await cancelled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
      assert.equal(h.counts.nativeClosed, 0);
      assert.equal(h.counts.executionClosed, 0);
      assert.equal(attempt(h).resources, 'held');
      assert.equal(row(h, 'produce').rounds[0].ballots.length, 0);
    } finally {
      release.resolve();
    }
    await closing;
    assert.equal(h.counts.nativeClosed, 1);
    assert.equal(h.counts.executionClosed, 1);
    assert.equal(h.ctx.agents.list().length, 0);
  },
);
