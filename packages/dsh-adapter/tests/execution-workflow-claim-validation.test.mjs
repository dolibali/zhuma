import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeReviewHost } from './execution-review-native-fixture.mjs';
import { checked } from './execution-service-run-fixture.mjs';

// Real original Service/domain/queue. Member/model/SDK issuers remain explicit
// contracts; no actual model or C automatic runner is exercised here.
test('workflow claim: synchronous original owner check rejects copies/foreign requests before a caller reserves work', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true }),
    copy = { ...h.workflowClaim };
  assert.equal(copy.check(), undefined, 'a borrowed closure alone is not original identity');
  const before = h.read();
  h.resetCounts();
  assert.equal(h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), undefined);
  for (const forged of [copy, {}, undefined, structuredClone(h.workflowClaim.view)])
    assert.throws(() => h.service.assertWorkflowExecutionClaim(h.request, forged), {
      code: 'workflow-authority-denied',
    });
  const other = Object.freeze({ headers: {} });
  h.members.set(other, 'chen');
  assert.throws(() => h.service.assertWorkflowExecutionClaim(other, h.workflowClaim), {
    code: 'workflow-authority-denied',
  });
  assert.equal(h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), undefined);
  assert.deepEqual(h.read(), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('workflow claim: another original Service and stopped/fenced arms cannot pass the synchronous view', async (t) => {
  const h = await nativeReviewHost(t, { workflow: {}, prepareOnly: true }),
    other = await nativeReviewHost(t, { workflow: {}, prepareOnly: true });
  assert.throws(() => other.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim), {
    code: 'workflow-authority-denied',
  });
  checked(
    await h.service.stopWorkflowExecution(h.request, {
      ...h.workflowLocation,
      requestId: 'claim-contract-stop',
      intentId: h.workflowView.intent.intentId,
      generation: h.workflowView.intent.generation,
    }),
  );
  h.resetCounts();
  assert.throws(() => h.service.assertWorkflowExecutionClaim(h.request, h.workflowClaim));
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  other.service.fenceRuns();
  assert.throws(() =>
    other.service.assertWorkflowExecutionClaim(other.request, other.workflowClaim),
  );
});
