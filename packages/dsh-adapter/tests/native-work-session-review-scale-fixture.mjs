// Synthetic validation-load fixture. Historical native events and settled labels
// are contract data only, never physical drain/permission evidence. Only the
// current review is driven by the original SDK in the separate spec.
import { nodeRecordKey, createExecutionHandoff } from '@zhuma/agent-core';
import {
  beginExecutionRun,
  recordExecutionRunEvent,
  readExecutionRunState,
} from '../dist/execution-run-state.js';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import {
  prepareExecutionReview,
  executionReviewTarget,
  readExecutionReviewState,
} from '../dist/execution-review-state.js';
import { freezeExecutionReviewComposition } from '../dist/execution-review-composition.js';
import {
  admitExecutionReview,
  recordExecutionReviewEvent,
} from '../dist/execution-review-lifecycle.js';
import { enableExecutionReviewWriter } from '../dist/execution-run-protocol.js';
import { describeNativeReviewReadTool } from '../dist/native-work-session-review-read.js';
import { describeNativeReviewTool } from '../dist/native-work-session-review-tool.js';
export async function seedScaledReviewMetadata(d) {
  d.setWorkbench((w) => ({
    ...w,
    tasks: w.tasks.map((t) => ({ ...t, goal: 'N'.repeat(3773) })),
    appliedPlans: w.appliedPlans.map((p) => ({
      ...p,
      task: { ...p.task, goal: 'N'.repeat(3773) },
    })),
  }));
  const original = d.read(),
    workbench = d.readWorkbench();
  let row = {
    ...original,
    command: { ...original.command, status: 'ready', entryStatus: 'ready' },
  };
  for (let i = 1; i <= 3; i++) {
    const scope = {
      actorId: 'chen',
      spaceId: 'north',
      taskId: row.taskId,
      planId: row.planId,
      revision: row.revision,
      nodeId: row.nodeId,
      runId: `scale-author-${i}`,
      generation: i,
      segmentId: `scale-author-segment-${i}`,
    };
    const tools = {
      kind: 'local-tools',
      definitions: [
        {
          name: 'read',
          description: 'Neutral historical tool metadata only; never registered or executed.',
          parameters: {
            type: 'object',
            properties: { reference: { type: 'string', description: '' } },
          },
          outputSchema: { type: 'object' },
          sourceVersion: 'scale-contract@1',
        },
      ],
    };
    const facts = {
      workbench,
      node: row,
      scope,
      model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
      executor: { kind: 'builtin' },
      inputs: { ...scope, items: [] },
      tools,
    };
    let composition = freezeExecutionRunComposition(facts);
    const target = [21187, 23080, 23500][i - 1],
      missing = target - Buffer.byteLength(JSON.stringify(composition));
    if (missing < 0) throw Error('Synthetic author calibration exceeds target');
    tools.definitions[0].parameters.properties.reference.description = 'M'.repeat(missing);
    composition = freezeExecutionRunComposition(facts);
    const { firstMessage, ...projection } = executionRunCompositionRequest(composition);
    row = beginExecutionRun(
      row,
      {
        requestId: `scale-author-begin-${i}`,
        actorId: 'chen',
        spaceId: 'north',
        expectedNodeVersion: row.command.version,
        expectedRunVersion: row.nativeExecution?.version ?? 0,
        mode: i === 1 ? 'begin' : 'retry',
        newRunId: scope.runId,
        newSegmentId: scope.segmentId,
        ...projection,
        selection: projection.selection,
        composition,
        workspace: { kind: 'text-only' },
      },
      [row],
      {
        expertEnabled: true,
        executorConnected: true,
        writerState: { schemaVersion: 1, nativeExecutionWriter: 1 },
      },
    ).record;
    let run = readExecutionRunState(row).runs.at(-1);
    row = recordExecutionRunEvent(row, {
      runId: scope.runId,
      generation: i,
      segmentId: scope.segmentId,
      sequence: 1,
      kind: 'accepted',
      nativeSessionId: `scale-author-native-${i}`,
      executorRunId: `scale-author-native-${i}`,
    }).record;
    row = recordExecutionRunEvent(row, {
      runId: scope.runId,
      generation: i,
      segmentId: scope.segmentId,
      sequence: 2,
      kind: 'failed',
      resourcesSettled: true,
    }).record;
  }
  row = { ...original, nativeExecution: row.nativeExecution };
  const applied = createExecutionHandoff(original, workbench),
    stopped = new Set();
  for (let i = 1; i <= 3; i++) {
    const input = {
      requestId: `scale-review-${i}`,
      expectedReviewVersion: readExecutionReviewState(row)?.version ?? 0,
      target: executionReviewTarget(row, 'north'),
      reviewerId: 'qa',
      controllerMemberId: 'chen',
      configurationId: 'scale-only',
      newRunId: `scale-review-run-${i}`,
      newSegmentId: `scale-review-segment-${i}`,
    };
    const provisional = prepareExecutionReview(row, applied, input, stopped);
    const composition = freezeExecutionReviewComposition({
      scope: provisional.attempt.scope,
      node: row,
      applied,
      model: { provider: 'contract', model: 'contract-model', maxTokens: 3000 },
      tools: {
        readTarget: describeNativeReviewReadTool(),
        completeReview: describeNativeReviewTool(),
      },
    });
    const prepared = prepareExecutionReview(
      row,
      applied,
      { ...input, configurationId: composition.configurationId },
      stopped,
    );
    row = prepared.record;
    if (i !== 2) {
      row = admitExecutionReview(row, {
        scope: prepared.attempt.scope,
        expectedAttemptVersion: 1,
        composition,
      }).record;
      let seq = 0;
      for (const kind of ['accepted', 'stop-requested', 'stopped', 'cleanup'])
        row = recordExecutionReviewEvent(row, {
          scope: prepared.attempt.scope,
          sequence: ++seq,
          kind,
          ...(kind === 'accepted'
            ? {
                nativeSessionId: `scale-review-native-${i}`,
                nativeAgentId: `scale-review-native-${i}`,
              }
            : {}),
        }).record;
    }
    stopped.add(prepared.attempt.scope.runId);
  }
  const oldRound = row.rounds.at(-1),
    oldArtifact = row.artifactVersions.at(-1);
  const round = {
    ...oldRound,
    id: 'scale-current-round',
    artifactVersionId: 'scale-current-artifact',
    ballots: [],
  };
  const artifact = { ...oldArtifact, id: round.artifactVersionId };
  row = {
    ...row,
    currentRoundId: round.id,
    rounds: [...row.rounds.slice(0, -1), { ...oldRound, status: 'changes-requested' }, round],
    artifactVersions: [...row.artifactVersions, artifact],
  };
  readExecutionRunState(row);
  readExecutionReviewState(row);
  const padding = {
    version: 1,
    idempotencyKey: 'scale-unsent-draft',
    fingerprint: 'scale-only',
    text: '',
    files: [],
    links: [],
  };
  row = { ...row, deliveryDraft: padding };
  // Fourth review is created normally later; leave its calibrated envelope budget.
  padding.text = 'P'.repeat(Math.max(0, 169485 - 21000 - Buffer.byteLength(JSON.stringify(row))));
  await enableExecutionReviewWriter(
    () => d.domain.global.get(),
    (value) => d.domain.global.set(value),
    [original],
  );
  await d.domain.table('nodes').put(nodeRecordKey(row), row);
  return {
    author: readExecutionRunState(row).runs.length,
    review: readExecutionReviewState(row).attempts.length,
    nodeBytes: Buffer.byteLength(JSON.stringify(row)),
    authorBytes: row.nativeExecution.runs.map((r) =>
      Buffer.byteLength(JSON.stringify(r.composition)),
    ),
    reviewBytes: row.nativeExecution.review.attempts.map((r) =>
      r.composition ? Buffer.byteLength(JSON.stringify(r.composition)) : null,
    ),
  };
}
