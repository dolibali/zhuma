import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendEfficiencyEvent,
  exportEfficiencyCsv,
  exportEfficiencyJson,
  summarizeEfficiency,
} from '@zhuma/context';

const at = (minute) => `2026-11-05T08:${String(minute).padStart(2, '0')}:00.000Z`;

function event(partial) {
  return {
    eventId: `eff-${partial.sequence}`,
    sequence: partial.sequence,
    occurredAt: partial.occurredAt,
    taskId: 'task',
    planId: 'task-v1',
    revision: 1,
    kind: partial.kind,
    sourceId: partial.sourceId,
    ...(partial.nodeId === undefined ? {} : { nodeId: partial.nodeId }),
  };
}

function record(log, partial) {
  const appended = appendEfficiencyEvent(log, event(partial));
  assert.equal(appended.ok, true, appended.ok ? '' : appended.code);
  return appended.log;
}

test('appends facts and refuses duplicates or rewound sequences', () => {
  let log = record([], {
    sequence: 1,
    occurredAt: at(1),
    kind: 'task-started',
    sourceId: 'task-start:task:task-v1:1',
  });
  assert.equal(log[0].taskId, 'task');
  assert.equal(Object.isFrozen(log[0]), true);
  const duplicate = appendEfficiencyEvent(
    log,
    event({
      sequence: 2,
      occurredAt: at(2),
      kind: 'task-started',
      sourceId: 'task-start:task:task-v1:1',
    }),
  );
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate-event');
  const rewound = appendEfficiencyEvent(log, {
    ...event({
      sequence: 1,
      occurredAt: at(2),
      kind: 'tool-call',
      sourceId: 'tool:run:1',
      nodeId: 'design',
    }),
    eventId: 'eff-rewind',
  });
  assert.equal(rewound.code, 'non-monotonic-sequence');
  const invalid = appendEfficiencyEvent(log, {
    ...event({ sequence: 2, occurredAt: 'yesterday', kind: 'task-ended', sourceId: 'end' }),
  });
  assert.equal(invalid.code, 'invalid-event');
  assert.equal(log.length, 1);
});

test('summarizes span, duration and counts without filling unknown time as zero', () => {
  let log = [];
  log = record(log, {
    sequence: 1,
    occurredAt: at(0),
    kind: 'task-started',
    sourceId: 'task-start:task:task-v1:1',
  });
  log = record(log, {
    sequence: 2,
    occurredAt: at(1),
    kind: 'node-started',
    sourceId: 'node-start:design',
    nodeId: 'design',
  });
  log = record(log, {
    sequence: 3,
    occurredAt: at(4),
    kind: 'human-intervention',
    sourceId: 'human-submit:1',
    nodeId: 'design',
  });
  log = record(log, {
    sequence: 4,
    occurredAt: at(5),
    kind: 'rework',
    sourceId: 'rework:1',
    nodeId: 'design',
  });
  log = record(log, {
    sequence: 5,
    occurredAt: at(6),
    kind: 'tool-call',
    sourceId: 'tool:a',
    nodeId: 'design',
  });
  log = record(log, {
    sequence: 6,
    occurredAt: at(6),
    kind: 'tool-call',
    sourceId: 'tool:b',
    nodeId: 'design',
  });
  const open = summarizeEfficiency(log);
  const byName = Object.fromEntries(open.metrics.map((item) => [item.metric, item]));
  assert.equal(byName.taskSpanMs.value, null);
  assert.equal(byName.taskSpanMs.unit, 'ms');
  assert.equal(byName.nodeDurationMs.value, null);
  assert.equal(byName.nodeDurationMs.nodeId, 'design');
  assert.equal(byName.humanInterventionCount.value, 1);
  assert.equal(byName.reworkCount.value, 1);
  assert.equal(byName.toolCallCount.value, 2);
  assert.equal(open.unknownDuration, null);
  assert.equal(summarizeEfficiency([]).metrics.length, 0);

  log = record(log, {
    sequence: 7,
    occurredAt: at(11),
    kind: 'node-ended',
    sourceId: 'node-end:design',
    nodeId: 'design',
  });
  log = record(log, {
    sequence: 8,
    occurredAt: at(12),
    kind: 'task-ended',
    sourceId: 'task-end:1',
  });
  const closed = summarizeEfficiency(log);
  const closedByName = Object.fromEntries(closed.metrics.map((item) => [item.metric, item]));
  assert.equal(closedByName.taskSpanMs.value, 12 * 60 * 1000);
  assert.equal(closedByName.nodeDurationMs.value, 10 * 60 * 1000);
  assert.equal(closedByName.taskSpanMs.label, '任务跨度');
});

test('exports json and csv with an empty cell for unknown duration', () => {
  const log = record([], {
    sequence: 1,
    occurredAt: at(0),
    kind: 'task-started',
    sourceId: 'task-start:task:task-v1:1',
  });
  const summary = summarizeEfficiency(log, ['task']);
  const json = JSON.parse(exportEfficiencyJson(summary));
  assert.equal(json.kind, 'efficiency-metrics');
  assert.equal(json.coverage, 'recorded-events');
  assert.equal(json.unknownDuration, null);
  assert.equal(json.metrics[0].metric, 'taskSpanMs');
  assert.equal(json.metrics[0].value, null);
  assert.equal(json.events.length, 1);
  assert.equal(summarizeEfficiency(log, ['other']).metrics.length, 0);

  const csv = exportEfficiencyCsv(summary);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv.slice(1), /^taskId,planId,revision,nodeId,metric,label,value,unit/);
  assert.match(csv, /task,task-v1,1,,taskSpanMs,任务跨度,,ms/);
  assert.equal(csv.includes('taskSpanMs,任务跨度,0,'), false);
});
