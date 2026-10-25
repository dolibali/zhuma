/** Contract inputs only: supplied identities, availability, workspace capabilities and native facts. */
import { applyWorkbenchCommand, startAppliedPlan } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import {
  beginExecutionRun,
  currentExecutionRun,
  recordExecutionRunEvent,
} from '../dist/execution-run-state.js';

export const available = Object.freeze({
  expertEnabled: true,
  executorConnected: true,
  writerState: Object.freeze({ schemaVersion: 1, nativeExecutionWriter: 1 }),
});
export const localWorkspace = Object.freeze({
  kind: 'local',
  deviceId: 'device-test',
  rootId: 'root-test',
  grantId: 'host-selected-grant',
  generation: 1,
  access: 'write',
});
export function records() {
  const { state, task, node } = fixture();
  const ready = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      status: 'ready',
      participantIds: ['chen', 'outside', 'qa'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            { ...node, id: 'produce', reviewerIds: ['outside'] },
            { ...node, id: 'consume', dependsOn: [], reviewerIds: [], reviewRequired: false },
          ],
        },
      ],
    },
  });
  const plan = ready.appliedPlans.at(-1);
  const started = startAppliedPlan({
    requested: { taskId: plan.taskId, planId: plan.id, revision: plan.revision },
    applied: plan,
    actorId: 'chen',
    existing: [],
  });
  if (!started.ok) throw Error(started.code);
  return structuredClone(started.records);
}
export function command(record, patch = {}) {
  return {
    requestId: 'begin-1',
    actorId: 'chen',
    spaceId: 'north',
    expectedNodeVersion: record.command.version,
    expectedRunVersion: record.nativeExecution?.version ?? 0,
    mode: 'begin',
    newRunId: 'run-1',
    newSegmentId: 'segment-1',
    inputFingerprint: 'a'.repeat(64),
    selection: {
      provider: 'contract',
      model: 'contract-model',
      maxTokens: 1000,
      configurationId: 'configuration-1',
    },
    expertVersionId: 'expert-1',
    contextRefs: [],
    workspace: { kind: 'text-only' },
    ...patch,
  };
}
export function begin(
  record = records()[0],
  patch = {},
  peers = [record],
  availability = available,
) {
  return beginExecutionRun(record, command(record, patch), peers, availability);
}
export function event(record, kind, patch = {}) {
  const run = currentExecutionRun(record);
  return {
    kind,
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    sequence: run.attempt.lastEventSequence + 1,
    ...patch,
  };
}
export function applyEvent(record, kind, patch = {}) {
  return recordExecutionRunEvent(record, event(record, kind, patch));
}
export function accepted(record = begin().record) {
  const generation = currentExecutionRun(record).attempt.generation;
  return applyEvent(record, 'accepted', {
    nativeSessionId: `native-session-${generation}`,
    executorRunId: `native-executor-${generation}`,
  }).record;
}
export const stable = Object.freeze({ idle: true, flushed: true, resourcesSettled: true });
export function stopCommand(record, patch = {}) {
  const run = currentExecutionRun(record);
  return {
    requestId: 'stop-1',
    actorId: 'chen',
    runId: run.attempt.id,
    generation: run.attempt.generation,
    segmentId: run.segmentId,
    expectedNodeVersion: record.command.version,
    expectedRunVersion: record.nativeExecution.version,
    ...patch,
  };
}
export function locator(record) {
  return {
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    nodeId: record.nodeId,
    runId: currentExecutionRun(record).attempt.id,
  };
}
