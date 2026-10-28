/** Metadata-only assembly contract, not a real backend Agent/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostWorkflowOwner } from '../dist/host-workflow-owner.js';

test('shared backend exposes no native workflow consumer or legacy driving controls even with configured model provider', async () => {
  let writes = 0,
    modelCalls = 0;
  const execution = new Proxy(
    {},
    {
      get() {
        writes++;
        assert.fail('metadata-only control must not access a driver or claim');
      },
    },
  );
  const ctx = {
    get(name) {
      assert.equal(name, 'llm');
      return {
        listProviders: () => [{ id: 'configured' }],
        listModels: async () => [{ id: 'real-configured-model' }],
        generate: () => {
          modelCalls++;
          assert.fail();
        },
      };
    },
  };
  const base = {
    execution,
    runs: {
      beginWorkflowRun() {
        assert.fail();
      },
      stop() {
        assert.fail();
      },
    },
    signal: new AbortController().signal,
    workspaces: {},
    readWorkbench: () => assert.fail(),
    prepareResume: () => assert.fail(),
    consumeClaim: () => assert.fail('must not register/consume an automatic native claim'),
  };
  const shared = createHostWorkflowOwner(ctx, { ...base, remoteOnly: true });
  try {
    for (const operation of ['start', 'resume', 'stop'])
      await assert.rejects(shared.operations[operation]({ headers: {} }, {}), {
        code: 'workflow-member-device-required',
      });
    assert.equal(writes, 0);
    assert.equal(modelCalls, 0);
    // C's original bridge permits only one owner per ExecutionService. A
    // metadata-only assembly must not occupy that actual consumer ownership.
    const local = createHostWorkflowOwner(ctx, base);
    await local.close();
    assert.equal(writes, 0);
    assert.equal(modelCalls, 0);
  } finally {
    await shared.close();
  }
});
