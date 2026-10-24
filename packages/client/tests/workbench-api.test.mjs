import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchApi } from '../dist/workbench/api.js';
import { PlanRequestSchema } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

test('planning RPC contract: adjustment sends only a proposal reference, with instruction and cancellation unchanged', async () => {
  const proposal = {
    id: crypto.randomUUID(),
    taskId: 'task',
    baseRevision: 0,
    model: 'contract-fixture',
    result: {
      summary: '草案',
      questions: [],
      assumptions: [],
      workflows: fixture().task.workflows,
    },
  };
  const requests = [];
  const controller = new AbortController();
  const api = createWorkbenchApi({
    call: async (path, method, payload, signal) => {
      assert.equal(path, '/api');
      assert.equal(method, 'zhuma/plan');
      assert.equal(signal, controller.signal);
      requests.push(PlanRequestSchema.parse(payload));
      return { ok: true, value: proposal };
    },
  });
  await api.plan('task', 0, '', controller.signal);
  await api.plan('task', 0, '第三步换陈宁，其余不变。', controller.signal, proposal.id, {
    nodeId: 'node-1',
    fields: ['assigneeId', 'rationale'],
  });
  assert.equal(requests[0].baseProposalId, undefined);
  assert.equal(requests[1].baseProposalId, proposal.id);
  assert.equal(requests[1].instruction, '第三步换陈宁，其余不变。');
  assert.equal(requests[1].adjustment.nodeId, 'node-1');
  assert.equal(requests[0].adjustment, undefined);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.ok(!('workflows' in requests[1]));
});
