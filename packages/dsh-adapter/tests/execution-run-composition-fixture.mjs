/** Host identity/model/tool producer facts are contracts; plan/node mapping is real core. */
import {
  canonicalPayload,
  applyWorkbenchCommand,
  startAppliedPlan,
  submitDelivery,
  unlockDownstream,
} from '@zhuma/agent-core';
import { createHash } from 'node:crypto';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { upstreamInputsFor } from '../dist/upstream-inputs.js';
import { ACCEPTED_INPUT_TOOL } from '../dist/native-work-session-input-tool.js';

// Deliberately synthetic definition to test composition contracts, not C's real tool declaration.
export const reader = {
  kind: 'accepted-input-reader',
  definition: {
    name: ACCEPTED_INPUT_TOOL,
    description: 'Contract input reader definition',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { contractOnly: { type: 'string' } },
    },
    outputSchema: { type: 'object', properties: { contractResult: { type: 'string' } } },
    sourceVersion: 'contract-1',
  },
};
export function compositionFacts({ upstream = false, expert = false } = {}) {
  const { state, task, node } = fixture();
  state.participants.find((person) => person.id === 'qa').instructions =
    '依据固定需求核对边界，返回可审查的说明。';
  const workbench = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'qa'],
      status: 'ready',
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            { ...node, id: 'produce', skillIds: [], reviewerIds: [], reviewRequired: false },
            {
              ...node,
              id: 'consume',
              skillIds: [],
              assigneeId: expert ? 'qa' : 'chen',
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: ['produce'],
            },
          ],
        },
      ],
    },
  });
  const plan = workbench.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: task.id, planId: plan.id, revision: plan.revision },
    applied: plan,
    actorId: 'chen',
    existing: [],
  });
  if (!started.ok) throw Error(started.code);
  let [produce, consume] = started.records;
  if (upstream) {
    const submitted = submitDelivery({
      record: produce,
      actorId: 'chen',
      idempotencyKey: 'source-submit',
      expectedVersion: produce.command.version,
      draft: { text: 'PRIVATE_SOURCE_BODY_NOT_IN_PROMPT', files: [], links: [] },
      artifactId: 'artifact-1',
      roundId: 'unused-round',
    });
    if (!submitted.ok) throw Error(submitted.code);
    produce = submitted.record;
    const unlocked = unlockDownstream({
      record: consume,
      dependencies: [produce],
      actorId: 'chen',
      idempotencyKey: 'unlock',
      expectedVersion: consume.command.version,
    });
    if (!unlocked.ok) throw Error(unlocked.code);
    consume = unlocked.record;
  }
  const target = upstream || expert ? consume : produce;
  const scope = {
    actorId: 'chen',
    spaceId: 'north',
    taskId: task.id,
    planId: plan.id,
    revision: plan.revision,
    nodeId: target.nodeId,
    runId: 'run-1',
    generation: 1,
    segmentId: 'segment-1',
  };
  return {
    workbench,
    node: target,
    scope,
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    executor: expert
      ? { kind: 'plan-expert', ref: { id: 'qa', version: plan.id } }
      : { kind: 'builtin' },
    inputs: {
      actorId: scope.actorId,
      spaceId: scope.spaceId,
      taskId: scope.taskId,
      planId: scope.planId,
      revision: scope.revision,
      nodeId: scope.nodeId,
      items: upstreamInputsFor(target, [produce, consume]),
    },
    tools: upstream ? structuredClone(reader) : { kind: 'text-only' },
  };
}

// Historical message recipe from bf147. Existing JSON fixtures/golden hashes
// retain their versions; a new freeze may use newer completion guidance.
export function legacyCompletionText(payload) {
  return `执行当前节点：${payload.handoff.goal}\n预期产物：${payload.handoff.expectedOutput}\n节点输入说明：${payload.handoff.inputNote}\n按固定输入清单处理，返回产物草稿与必要说明。${payload.returnedRevision ? '\n按固定的本轮退回意见修改并提交新版本，保留旧产物和评审记录。' : ''}`;
}
export function legacyCompletionFixture(snapshot) {
  const saved = structuredClone(snapshot);
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  saved.payload.firstMessage.text = legacyCompletionText(saved.payload);
  saved.payload.firstMessage.inputFingerprint = sha(
    JSON.stringify(['followup', saved.payload.firstMessage.text]),
  );
  saved.configurationId = `composition_${sha(canonicalPayload(saved.payload))}`;
  return saved;
}
