import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { ExecutionService } from '../dist/execution-service.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import {
  attachEfficiencyLogFile,
  efficiencyDocument,
  noteAssistantToolCalls,
  noteExecutionFact,
  noteHumanIntervention,
  noteNativeToolCall,
  notePlanIfTerminal,
  noteRunBoundary,
  noteTaskStarted,
  readEfficiencyLog,
  resetEfficiencyLogForTests,
} from '../dist/efficiency-log.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const stamp = {
  taskId: 'task',
  planId: 'task-v1',
  revision: 1,
  nodeId: 'design',
  assigneeKind: 'human',
  occurredAt: '2026-11-05T08:00:00.000Z',
  version: 1,
};

describe('efficiency host log', { concurrency: false }, () => {
  test.beforeEach(() => {
    resetEfficiencyLogForTests();
  });

  test('maps accepted execution stamps into efficiency facts', () => {
    noteExecutionFact({ ...stamp, eventType: 'node-started', status: 'blocked' });
    noteExecutionFact({ ...stamp, eventType: 'node-started', status: 'ready' });
    noteExecutionFact({
      ...stamp,
      assigneeKind: 'expert',
      eventType: 'node-started',
      status: 'ready',
    });
    noteExecutionFact({
      ...stamp,
      eventType: 'delivery-submitted',
      status: 'in-review',
      version: 2,
      occurredAt: '2026-11-05T08:05:00.000Z',
    });
    noteExecutionFact({
      ...stamp,
      assigneeKind: 'expert',
      eventType: 'delivery-submitted',
      status: 'in-review',
      version: 2,
    });
    noteExecutionFact({
      ...stamp,
      eventType: 'ballot-recorded',
      status: 'needs-revision',
      version: 3,
      occurredAt: '2026-11-05T08:06:00.000Z',
    });
    noteExecutionFact({
      ...stamp,
      eventType: 'ballot-recorded',
      status: 'needs-revision',
      version: 3,
      occurredAt: '2026-11-05T08:07:00.000Z',
    });
    noteExecutionFact({
      ...stamp,
      eventType: 'review-settled',
      status: 'completed',
      version: 4,
      occurredAt: '2026-11-05T08:10:00.000Z',
    });
    const kinds = readEfficiencyLog().map((event) => event.kind);
    assert.deepEqual(kinds, ['node-started', 'human-intervention', 'rework', 'node-ended']);
  });

  test('counts identified tool calls once and closes a run interval', () => {
    const scope = {
      taskId: 'task',
      planId: 'task-v1',
      revision: 1,
      nodeId: 'design',
      runId: 'run-1',
    };
    const content = {
      message: {
        content: [
          { type: 'text', text: 'looking' },
          { type: 'tool-call', id: 'read-1', name: 'read' },
          { type: 'tool-call', name: 'missing-id' },
        ],
      },
    };
    assert.equal(noteAssistantToolCalls(scope, content, '2026-11-05T08:01:00.000Z'), 1);
    assert.equal(noteAssistantToolCalls(scope, content, '2026-11-05T08:02:00.000Z'), 0);
    assert.equal(
      noteNativeToolCall(scope, 'session-1', {
        seq: 4,
        type: 'tool/call',
        time: Date.parse('2026-11-05T08:03:00.000Z'),
      }),
      true,
    );
    assert.equal(
      noteNativeToolCall(scope, 'session-1', { seq: 4, type: 'tool/call', time: 1 }),
      false,
    );
    noteRunBoundary({
      phase: 'started',
      ...scope,
      occurredAt: '2026-11-05T08:00:00.000Z',
    });
    noteRunBoundary({
      phase: 'ended',
      ...scope,
      occurredAt: '2026-11-05T08:04:00.000Z',
    });
    noteHumanIntervention({
      ...scope,
      sourceId: 'takeover:1',
      occurredAt: '2026-11-05T08:05:00.000Z',
    });
    noteTaskStarted({
      taskId: 'task',
      planId: 'task-v1',
      revision: 1,
      occurredAt: '2026-11-05T08:00:00.000Z',
    });
    const document = efficiencyDocument({ format: 'json', taskIds: ['task'] });
    const json = JSON.parse(document.document);
    const duration = json.metrics.find((item) => item.metric === 'nodeDurationMs');
    const tools = json.metrics.find((item) => item.metric === 'toolCallCount');
    const humans = json.metrics.find((item) => item.metric === 'humanInterventionCount');
    assert.equal(duration.value, 4 * 60 * 1000);
    assert.equal(tools.value, 2);
    assert.equal(humans.value, 1);
    assert.equal(document.filename, 'efficiency-metrics.json');
    const csv = efficiencyDocument({ format: 'csv', taskIds: ['task'] });
    assert.equal(csv.filename, 'efficiency-metrics.csv');
    assert.match(csv.document, /toolCallCount,工具调用次数,2,count/);
    assert.equal(
      notePlanIfTerminal([{ ...stamp, command: { status: 'ready', version: 1 } }]),
      false,
    );
    assert.equal(
      notePlanIfTerminal(
        [{ ...stamp, command: { status: 'completed', version: 4 } }],
        '2026-11-05T08:10:00.000Z',
      ),
      true,
    );
  });

  test('replays an append-only file without rewriting earlier lines', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'zhuma-efficiency-'));
    const file = path.join(root, 'efficiency.jsonl');
    attachEfficiencyLogFile(file);
    noteTaskStarted({
      taskId: 'task',
      planId: 'task-v1',
      revision: 1,
      occurredAt: '2026-11-05T08:00:00.000Z',
    });
    const first = await readFile(file, 'utf8');
    resetEfficiencyLogForTests();
    attachEfficiencyLogFile(file);
    assert.equal(readEfficiencyLog().length, 1);
    assert.equal(readEfficiencyLog()[0].kind, 'task-started');
    noteTaskStarted({
      taskId: 'task',
      planId: 'task-v2',
      revision: 2,
      occurredAt: '2026-11-05T09:00:00.000Z',
    });
    const second = await readFile(file, 'utf8');
    assert.ok(second.startsWith(first.trim()));
    assert.match(second, /task-v2/);
  });

  function workflowNode(partial) {
    return {
      description: '',
      assigneeId: 'chen',
      reviewerIds: [],
      reviewRequired: false,
      dependsOn: [],
      skillIds: [],
      mcpIds: [],
      input: '',
      output: '交付说明',
      rationale: '',
      position: { x: 0, y: 0 },
      ...partial,
    };
  }

  function confirm(nodes) {
    const { state, task } = fixture();
    const ready = applyWorkbenchCommand(state, {
      type: 'save-task',
      task: {
        ...task,
        workflows: [{ ...task.workflows[0], nodes }],
        status: 'ready',
      },
    });
    const applied = ready.appliedPlans.at(-1);
    assert.ok(applied);
    return { state: ready, applied };
  }

  test('starting a human plan emits task and node facts that export keeps empty span', async () => {
    const { state, applied } = confirm([workflowNode({ id: 'design', title: '设计' })]);
    const nodes = new Map();
    const plans = new Map();
    const service = new ExecutionService(
      {
        readNode: (key) => nodes.get(key),
        writeNode: async (key, value) => {
          nodes.set(key, structuredClone(value));
        },
        listNodes: () => [...nodes.values()],
        readPlan: (key) => plans.get(key),
        writePlan: async (key, value) => {
          plans.set(key, structuredClone(value));
        },
        listPlans: () => [...plans.entries()].map(([key, receipt]) => ({ key, receipt })),
      },
      { readWorkbench: () => state },
      boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
    );
    const chen = { member: { ok: true, memberId: 'chen', spaceIds: ['project'] } };
    const started = await service.startPlan(chen, {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
      idempotencyKey: 'start-1',
    });
    assert.equal(started.ok, true, started.ok ? '' : started.error.code);
    const kinds = readEfficiencyLog().map((event) => event.kind);
    assert.ok(kinds.includes('task-started'));
    assert.ok(kinds.includes('node-started'));
    const exported = await service.exportEfficiency(chen, { format: 'json' });
    assert.equal(exported.ok, true);
    const json = JSON.parse(exported.value.document);
    const span = json.metrics.find((item) => item.metric === 'taskSpanMs');
    assert.equal(span.value, null);
    assert.equal(span.taskId, applied.taskId);
    assert.equal(exported.value.filename, 'efficiency-metrics.json');
    const hidden = await service.exportEfficiency(
      { member: { ok: true, memberId: 'outside', spaceIds: ['project'] } },
      { format: 'csv', taskId: applied.taskId },
    );
    assert.equal(hidden.ok, false);
    assert.equal(hidden.error.code, 'not-found');
    const outsider = await service.exportEfficiency(
      { member: { ok: true, memberId: 'outside', spaceIds: ['project'] } },
      { format: 'csv' },
    );
    assert.equal(outsider.ok, true);
    assert.equal(outsider.value.metricCount, 0);
    const actor = await service.exportEfficiency(chen, { format: 'json', actorId: 'chen' });
    assert.equal(actor.ok, false);
    assert.equal(actor.error.code, 'actor-from-body');
  });
});
