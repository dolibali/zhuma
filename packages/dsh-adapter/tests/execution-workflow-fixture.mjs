/** Real original plugin, plan/node JSON and Run queue. Member, configuration,
 * workspace and native events remain explicit contracts; no model or Host pump. */
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { open, checked } from './execution-service-run-fixture.mjs';
import {
  freezeExecutionRunComposition,
  executionRunCompositionRequest,
} from '../dist/execution-run-composition.js';
import { readExecutionRunState } from '../dist/execution-run-state.js';
import { command } from './execution-run-fixture.mjs';
import { describeNativeResultTool } from '../dist/native-work-session-result-tool.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
import { nativeResultProvenance } from '../dist/execution-native-result-delivery.js';
import { executionRunScope } from '../dist/execution-run-state.js';
import { EXECUTION_RESOURCE_SOURCE_VERSION } from '../dist/execution-run-resource-snapshot.js';
import { upstreamInputsFor } from '../dist/upstream-inputs.js';
import { describeAcceptedInputTool } from '../dist/native-work-session-input-tool.js';

export async function openWorkflowContract(root, { workbench, resources = false } = {}) {
  const h = await open(root, { seed: !workbench, expertNode: 'produce' });
  if (!workbench) {
    const current = h.readWorkbench(),
      task = current.tasks[0],
      base = task.workflows[0].nodes[0];
    workbench = applyWorkbenchCommand(current, {
      type: 'save-task',
      task: {
        ...task,
        id: 'workflow-task',
        status: 'ready',
        workflows: [
          {
            ...task.workflows[0],
            nodes: [
              {
                ...base,
                id: 'first',
                skillIds: resources ? ['api-skill'] : base.skillIds,
                assigneeId: 'qa',
                reviewerIds: ['outside', 'chen'],
                reviewRequired: true,
                dependsOn: [],
              },
              {
                ...base,
                id: 'second',
                assigneeId: 'qa',
                reviewerIds: [],
                reviewRequired: false,
                dependsOn: [],
              },
              {
                ...base,
                id: 'join',
                assigneeId: 'qa',
                reviewerIds: [],
                reviewRequired: false,
                dependsOn: ['first', 'second'],
              },
              {
                ...base,
                id: 'human',
                assigneeId: 'chen',
                reviewerIds: [],
                reviewRequired: false,
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });
  }
  h.setWorkbench(() => workbench);
  const plan = workbench.appliedPlans.at(-1);
  const location = {
    taskId: plan.taskId,
    planId: plan.id,
    revision: plan.revision,
    spaceId: 'north',
  };
  const locate = (nodeId) => ({
    taskId: plan.taskId,
    planId: plan.id,
    revision: plan.revision,
    nodeId,
  });
  const row = (nodeId) => h.service.readRunNode(locate(nodeId));
  const defaults = {
    model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
    tools: 'text-only',
    workspace: { kind: 'text-only' },
  };
  return {
    ...h,
    location,
    locate,
    row,
    defaults,
    startBody: (requestId = 'start-workflow', concurrent = 1) => ({
      ...location,
      requestId,
      defaults,
      budget: { concurrent, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    }),
    control: (view, requestId) => ({
      ...location,
      requestId,
      intentId: view.intent.intentId,
      generation: view.intent.generation,
    }),
    claim: (view) =>
      h.service.claimWorkflowExecution(h.request, {
        ...location,
        intentId: view.intent.intentId,
        generation: view.intent.generation,
      }),
    beginBody(ticket, overrides = {}, configuration = {}) {
      const reservation = ticket.reservation,
        node = row(reservation.nodeId);
      const state = readExecutionRunState(node);
      const prior = state?.receipts.find((receipt) => receipt.requestId === reservation.requestId);
      const previous = prior && state.runs.find((run) => run.attempt.id === prior.runId);
      const { actorId, ...input } = command(node, {
        ...reservation,
        spaceId: 'north',
        workspace: ticket.defaults.workspace,
      });
      for (const key of ['intentId', 'generation', 'nodeId', 'expertId', 'inputsFingerprint'])
        delete input[key];
      const composition = freezeExecutionRunComposition({
        workbench,
        node,
        scope: {
          ...locate(node.nodeId),
          actorId,
          spaceId: 'north',
          runId: reservation.newRunId,
          generation: previous ? previous.attempt.generation : (state?.runs.length ?? 0) + 1,
          segmentId: reservation.newSegmentId,
        },
        model: ticket.defaults.model,
        executor: { kind: 'plan-expert', ref: node.handoff.expertRef },
        tools:
          configuration.tools ??
          (ticket.defaults.tools === 'accepted-input-reader'
            ? node.handoff.inputRefs.length === 0
              ? { kind: 'text-only' }
              : { kind: 'accepted-input-reader', definition: describeAcceptedInputTool() }
            : { kind: ticket.defaults.tools }),
        ...(resources
          ? { resourceCatalog: { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, mcp: [] } }
          : {}),
        resultIntentTool: describeNativeResultTool(),
        inputs: {
          ...locate(node.nodeId),
          actorId,
          spaceId: 'north',
          items: upstreamInputsFor(
            node,
            [...h.domain.table('nodes').entries()].map(([, row]) => row),
          ),
        },
      });
      const { firstMessage: _message, ...projection } = executionRunCompositionRequest(composition);
      return { ...locate(node.nodeId), ...input, ...projection, composition, ...overrides };
    },
    async start(concurrent = 1) {
      return checked(
        await h.service.startWorkflowExecution(
          h.request,
          this.startBody('start-workflow', concurrent),
        ),
      );
    },
  };
}

/** Completion owner is an explicit contract. Original Service submit/review,
 * terminal Run and accepted downstream pointers are real product operations. */
export async function completeWorkflowTicket(h, ticket, text) {
  const nodeId = ticket.reservation.nodeId;
  const begun = checked(await h.service.startRun(h.request, h.beginBody(ticket), ticket));
  const opened = await h.authorities.open(
    h.request,
    { ...h.locate(nodeId), runId: begun.run.attempt.id },
    'drive',
  );
  try {
    checked(
      await h.service.recordRunEvent(
        h.locate(nodeId),
        {
          kind: 'accepted',
          runId: begun.run.attempt.id,
          generation: begun.run.attempt.generation,
          segmentId: begun.run.segmentId,
          sequence: begun.run.attempt.lastEventSequence + 1,
          nativeSessionId: `session-${nodeId}`,
          executorRunId: `agent-${nodeId}`,
        },
        { grant: opened.grant },
      ),
    );
    h.completionContracts ??= new Map();
    if (!h.completionPort) {
      const contracts = h.completionContracts;
      const assert = (grant, ref) => {
        h.authorities.assertGrant(grant, 'send');
        if (contracts.get(grant.scope.runId)?.ref !== ref) throw Error('CONTRACT_REF_REJECTED');
      };
      h.completionPort = {
        async prepareFixedResult(grant) {
          const result = contracts.get(grant.scope.runId);
          assert(grant, result.ref);
          return { status: 'ready', ref: result.ref };
        },
        assertFixedResult: assert,
        async readFixedResult(grant, ref, signal) {
          assert(grant, ref);
          const result = contracts.get(grant.scope.runId);
          let released = false;
          return {
            ...result.lease,
            signal,
            check() {
              if (released) throw Error('CONTRACT_RELEASED');
              assert(grant, ref);
            },
            release() {
              released = true;
            },
          };
        },
      };
      h.service.installNativeResultIssuer(h.completionPort);
    }
    const node = h.row(nodeId),
      state = readExecutionRunState(node),
      run = state.runs[0];
    const source = {
      scope: executionRunScope(node, run),
      nativeSessionId: `session-${nodeId}`,
      nativeAgentId: `agent-${nodeId}`,
      configurationId: run.selection.configurationId,
      toolVersion: 'zhuma-native-result-intent@1',
      intentId: `intent-${nodeId}`,
      callId: `complete-${nodeId}`,
      cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
    };
    const content = { text, links: [] },
      digest = nativeResultDigest(content);
    const ref = Object.freeze({});
    h.completionContracts.set(run.attempt.id, {
      ref,
      lease: {
        source,
        content,
        digest,
        provenanceFingerprint: nativeResultProvenance(source, digest),
      },
    });
    return checked(
      await h.service.submitNativeFixedResult(
        h.request,
        {
          ...h.locate(nodeId),
          runId: run.attempt.id,
          generation: run.attempt.generation,
          segmentId: run.segmentId,
          configurationId: run.selection.configurationId,
          expectedNodeVersion: node.command.version,
          expectedRunVersion: state.version,
          idempotencyKey: `submit-${nodeId}`,
        },
        opened.grant,
        ref,
      ),
    );
  } finally {
    ticket.dispose();
    opened.dispose();
  }
}
