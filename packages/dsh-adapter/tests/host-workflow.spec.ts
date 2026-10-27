/** Actual emitted Host + original workflow Service/bridge/Agent factory.
 * Real member Cookies and JSON/JSONL; scripted local model and SDK source aliases.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';
import { once } from 'node:events';

function completion(text = 'Fixed original workflow output') {
  return function* () {
    const args = JSON.stringify({ text, links: [] });
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: 'finish',
      name: 'complete_work',
      argumentsDelta: args,
    };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'finish', name: 'complete_work', arguments: args },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
const row = (h, nodeId) =>
  [...h.table.entries()].map(([, value]) => value).find((node) => node.nodeId === nodeId);
const run = (h, nodeId = 'node-1') => row(h, nodeId)?.nativeExecution?.runs.at(-1);
const start = (h, concurrent = 1) =>
  h.rpc('workflow', 'start', {
    ...h.workflowLocation,
    requestId: 'start-workflow',
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    workspace: { kind: 'text-only' },
    concurrent,
  });
const control = (h, view) => ({
  ...h.workflowLocation,
  requestId: 'stop-workflow',
  intentId: view.intent.intentId,
  generation: view.intent.generation,
});
const intent = (h) =>
  [...h.ctx.storageDomain.get('zhuma_execution').table('plans').entries()][0]?.[1]
    .workflowExecution;

test(
  'actual Host workflow: passive options/read create no node or Run and reject browser authority fields',
  { timeout: 20000 },
  async (t) => {
    const h = await boot(t, { expert: true, startPlan: false });
    const before = JSON.stringify([...h.table.entries()]);
    for (const endpoint of ['options', 'read']) {
      const view = checked(await h.rpc('workflow', endpoint, h.workflowLocation));
      assert.equal(view.planStarted, false);
      assert.equal(view.state, 'inactive');
      assert.equal(view.intent, null);
      assert.equal(view.selection, null);
      assert.equal('defaults' in view, false);
      assert.equal('actorId' in view, false);
    }
    assert.equal(
      (await h.rpc('workflow', 'read', { ...h.workflowLocation, actorId: 'chen' })).result.ok,
      false,
    );
    assert.equal(
      (await h.rpc('workflow', 'read', { ...h.workflowLocation, spaceId: 'foreign' })).result.ok,
      false,
    );
    assert.equal(JSON.stringify([...h.table.entries()]), before);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
  },
);

test(
  'actual Host workflow: parallel original Runs wait for review before the join and never execute the human node',
  { timeout: 30000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      completion('Parallel branch'),
      completion('Parallel branch'),
      completion('Joined result'),
    ]);
    const h = await boot(t, {
      expert: true,
      startPlan: false,
      adapter,
      workflowNodes: (base) => [
        {
          ...base,
          id: 'first',
          assigneeId: 'qa',
          reviewerIds: ['chen'],
          reviewRequired: true,
          dependsOn: [],
          skillIds: [],
          mcpIds: [],
        },
        {
          ...base,
          id: 'second',
          assigneeId: 'qa',
          reviewerIds: [],
          reviewRequired: false,
          dependsOn: [],
          skillIds: [],
          mcpIds: [],
        },
        {
          ...base,
          id: 'join',
          assigneeId: 'qa',
          reviewerIds: [],
          reviewRequired: false,
          dependsOn: ['first', 'second'],
          skillIds: [],
          mcpIds: [],
        },
        {
          ...base,
          id: 'human',
          assigneeId: 'chen',
          reviewerIds: [],
          reviewRequired: false,
          dependsOn: [],
          skillIds: [],
          mcpIds: [],
        },
      ],
    });
    const started = checked(await start(h, 2));
    await waitFor(
      h.ctx,
      () =>
        row(h, 'first')?.command.status === 'in-review' &&
        row(h, 'second')?.command.status === 'completed',
    );
    assert.equal(adapter.requests.length, 2);
    assert.equal(row(h, 'join').command.status, 'blocked');
    assert.equal(run(h, 'join'), undefined);
    assert.equal(run(h, 'human'), undefined);
    checked(await h.rpc('workflow', 'stop', control(h, started)));
    const paused = checked(await h.rpc('workflow', 'read', h.workflowLocation));
    assert.equal(paused.state, 'paused');
    const resumed = checked(
      await h.rpc('workflow', 'resume', {
        ...control(h, paused),
        requestId: 'resume-workflow',
        expectedVersion: paused.intent.version,
      }),
    );
    assert.equal(resumed.intent.generation, 2);
    assert.equal(adapter.requests.length, 2, 'Resume must not restart the completed branches');
    const first = row(h, 'first');
    const round = first.rounds.at(-1);
    checked(
      await h.rpc('exec', 'ballot', {
        ...h.locator,
        nodeId: 'first',
        expectedVersion: first.command.version,
        idempotencyKey: 'review-first',
        roundId: round.id,
        artifactVersionId: round.artifactVersionId,
        action: 'approve',
      }),
    );
    await waitFor(h.ctx, () => row(h, 'join').command.status === 'completed');
    assert.equal(adapter.requests.length, 3);
    assert.equal(
      run(h, 'join').attempt.generation,
      1,
      'Native generation is distinct from workflow generation',
    );
    assert.equal(row(h, 'join').handoff.inputRefs.length, 2);
    assert.equal(run(h, 'human'), undefined);
    assert.equal(row(h, 'human').command.status, 'ready');
    for (const id of ['first', 'second', 'join']) {
      assert.equal(row(h, id).nativeExecution.runs.length, 1);
      assert.equal(run(h, id).resources, 'settled');
    }
    checked(
      await h.rpc('exec', 'submit', {
        ...h.locator,
        nodeId: 'human',
        expectedVersion: row(h, 'human').command.version,
        idempotencyKey: 'human-submission',
        text: 'Original human delivery',
        links: [],
      }),
    );
    const completed = checked(await h.rpc('workflow', 'read', h.workflowLocation));
    assert.equal(completed.state, 'completed');
    assert.equal(completed.activeRunCount, 0);
    assert.equal(adapter.requests.length, 3);
  },
);

for (const stage of ['metadata', 'agent-created'])
  test(
    `actual Host workflow: Stop during original ${stage} retains the committed Run and prevents the first model request`,
    { timeout: 20000 },
    async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const adapter = new ScriptedAdapter([]);
      if (stage === 'metadata') {
        const resolveModel = adapter.resolveModel.bind(adapter);
        adapter.resolveModel = async (...args) => {
          entered.resolve();
          await release.promise;
          return resolveModel(...args);
        };
      }
      const h = await boot(t, { expert: true, startPlan: false, adapter });
      if (stage === 'agent-created')
        h.ctx.on(
          'agent/created',
          async () => {
            entered.resolve();
            await release.promise;
          },
          { global: true },
        );
      try {
        const view = checked(await start(h));
        await entered.promise;
        const committed = run(h).attempt.id;
        assert.equal(adapter.requests.length, 0);
        let settled = false;
        const stopping = h.rpc('workflow', 'stop', control(h, view)).then((value) => {
          settled = true;
          return value;
        });
        await waitFor(h.ctx, () => intent(h)?.status === 'stopping');
        assert.equal(settled, false);
        assert.equal(run(h).attempt.id, committed);
        assert.equal(run(h).resources, 'held');
        release.resolve();
        const stopped = checked(await stopping);
        assert.ok(['stopping', 'paused'].includes(stopped.state));
        await waitFor(h.ctx, () => run(h).resources === 'settled');
        const final = checked(await h.rpc('workflow', 'read', h.workflowLocation));
        assert.equal(
          final.state,
          'paused',
          JSON.stringify({
            state: final.state,
            active: final.activeRunCount,
            resources: run(h).resources,
            stopPhase: run(h).attempt.stopPhase,
          }),
        );
        assert.equal(run(h).attempt.id, committed);
        assert.equal(run(h).resources, 'settled');
        assert.equal(adapter.requests.length, 0);
        assert.equal(h.ctx.agents.list().length, 0);
        assert.equal(row(h, 'node-1').artifactVersions.length, 0);
      } finally {
        release.resolve();
      }
    },
  );

test(
  'actual Host workflow: successful admission keeps the original Run alive until explicit Stop',
  { timeout: 20000 },
  async (t) => {
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let signal;
    const adapter = new ScriptedAdapter([
      async function* (options) {
        signal = options.signal;
        entered.resolve();
        await release.promise;
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    ]);
    const h = await boot(t, { expert: true, startPlan: false, adapter });
    try {
      const view = checked(await start(h));
      await entered.promise;
      await waitFor(h.ctx, () => run(h)?.attempt.acknowledged === true);
      const currentRun = run(h);
      const read = checked(
        await h.rpc('run', 'read', {
          ...h.locator,
          nodeId: 'node-1',
          runId: currentRun.attempt.id,
        }),
      );
      assert.equal(read.dispatch, 'received');
      assert.equal(checked(await h.rpc('workflow', 'read', h.workflowLocation)).activeRunCount, 1);
      assert.equal(signal.aborted, false);
      assert.equal(currentRun.resources, 'held');
      let stopped = false;
      const stopping = h.rpc('workflow', 'stop', control(h, view)).then((value) => {
        stopped = true;
        return value;
      });
      if (!signal.aborted) await once(signal, 'abort', { signal: AbortSignal.timeout(5000) });
      assert.equal(stopped, false);
      assert.equal(run(h).resources, 'held');
      release.resolve();
      assert.ok(['stopping', 'paused'].includes(checked(await stopping).state));
      await waitFor(h.ctx, () => run(h).resources === 'settled');
      assert.equal(checked(await h.rpc('workflow', 'read', h.workflowLocation)).state, 'paused');
      assert.equal(run(h).resources, 'settled');
      assert.equal(adapter.requests.length, 1);
      assert.equal(h.ctx.agents.list().length, 0);
      assert.equal(row(h, 'node-1').artifactVersions.length, 0);
      await h.remountHost();
      const freshCookie = await h.login();
      const fresh = checked(await h.rpc('workflow', 'read', h.workflowLocation, freshCookie));
      assert.equal(
        fresh.state,
        'stopping',
        'A fresh Host owner cannot infer a retired certificate from settled labels',
      );
      assert.equal(fresh.activeRunCount, 0);
      assert.equal(adapter.requests.length, 1);
      assert.equal(h.ctx.agents.list().length, 0);
    } finally {
      release.resolve();
    }
  },
);
