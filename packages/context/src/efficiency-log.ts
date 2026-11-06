/**
 * 追加效率事实。本模块不读时钟、不写磁盘、不估算节省比例。
 * 未知历时保持空值，不用 0 填上。
 */

export const EFFICIENCY_EVENT_KINDS = [
  'task-started',
  'task-ended',
  'node-started',
  'node-ended',
  'human-intervention',
  'rework',
  'tool-call',
] as const;

export type EfficiencyEventKind = (typeof EFFICIENCY_EVENT_KINDS)[number];

export const EFFICIENCY_METRICS = [
  'taskSpanMs',
  'nodeDurationMs',
  'humanInterventionCount',
  'reworkCount',
  'toolCallCount',
] as const;

export type EfficiencyMetricName = (typeof EFFICIENCY_METRICS)[number];

export interface EfficiencyEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly kind: EfficiencyEventKind;
  readonly sourceId: string;
  readonly nodeId?: string;
}

export interface EfficiencyMetric {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string | null;
  readonly metric: EfficiencyMetricName;
  readonly label: string;
  readonly value: number | null;
  readonly unit: 'ms' | 'count';
}

export interface EfficiencySummary {
  readonly kind: 'efficiency-metrics';
  readonly coverage: 'recorded-events';
  /** 未知历时在指标里是 null，这里固定声明，避免把空值读成 0。 */
  readonly unknownDuration: null;
  readonly metrics: readonly EfficiencyMetric[];
  readonly events: readonly EfficiencyEvent[];
}

const LABELS: Record<EfficiencyMetricName, string> = {
  taskSpanMs: '任务跨度',
  nodeDurationMs: '节点历时',
  humanInterventionCount: '人工介入次数',
  reworkCount: '返工次数',
  toolCallCount: '工具调用次数',
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ID = /^[\w.-]{1,200}$/u;
const SOURCE = /^[^\s]{1,800}$/u;

export type EfficiencyAppendResult =
  | { readonly ok: true; readonly log: readonly EfficiencyEvent[] }
  | {
      readonly ok: false;
      readonly code: 'duplicate-event' | 'non-monotonic-sequence' | 'invalid-event';
    };

function realTimestamp(value: string): boolean {
  return TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function validId(value: string): boolean {
  return ID.test(value);
}

function validSource(value: string): boolean {
  return SOURCE.test(value);
}

function eventError(event: EfficiencyEvent): 'invalid-event' | undefined {
  if (
    !validId(event.eventId) ||
    !validId(event.taskId) ||
    !validId(event.planId) ||
    !validSource(event.sourceId)
  ) {
    return 'invalid-event';
  }
  if (!EFFICIENCY_EVENT_KINDS.includes(event.kind)) return 'invalid-event';
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return 'invalid-event';
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) return 'invalid-event';
  if (!realTimestamp(event.occurredAt)) return 'invalid-event';
  if (event.nodeId !== undefined && !validId(event.nodeId)) return 'invalid-event';
  const needsNode =
    event.kind === 'node-started' || event.kind === 'node-ended' || event.kind === 'rework';
  if (needsNode && event.nodeId === undefined) return 'invalid-event';
  return undefined;
}

function freezeEvent(event: EfficiencyEvent): EfficiencyEvent {
  return Object.freeze({
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    taskId: event.taskId,
    planId: event.planId,
    revision: event.revision,
    kind: event.kind,
    sourceId: event.sourceId,
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
  });
}

/** 只追加。相同事件编号，或相同 kind + sourceId，都拒绝。 */
export function appendEfficiencyEvent(
  log: readonly EfficiencyEvent[],
  event: EfficiencyEvent,
): EfficiencyAppendResult {
  if (eventError(event)) return { ok: false, code: 'invalid-event' };
  if (
    log.some(
      (item) =>
        item.eventId === event.eventId ||
        (item.kind === event.kind && item.sourceId === event.sourceId),
    )
  ) {
    return { ok: false, code: 'duplicate-event' };
  }
  const lastSequence = log.reduce((max, item) => Math.max(max, item.sequence), 0);
  if (event.sequence <= lastSequence) return { ok: false, code: 'non-monotonic-sequence' };
  return { ok: true, log: Object.freeze([...log, freezeEvent(event)]) };
}

function planKey(event: EfficiencyEvent): string {
  return `${event.taskId}\0${event.planId}\0${event.revision}`;
}

function elapsed(start: string, end: string): number | null {
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

/** 成对的起止才有历时。缺一侧、重叠或倒序都是 null，不是 0。 */
function pairedDuration(
  events: readonly EfficiencyEvent[],
  startKind: EfficiencyEventKind,
  endKind: EfficiencyEventKind,
): number | null {
  const relevant = events.filter((event) => event.kind === startKind || event.kind === endKind);
  if (relevant.length === 0) return null;
  let open: string | undefined;
  let total = 0;
  let closed = 0;
  for (const event of relevant) {
    if (event.kind === startKind) {
      if (open !== undefined) return null;
      open = event.occurredAt;
      continue;
    }
    if (open === undefined) return null;
    const delta = elapsed(open, event.occurredAt);
    if (delta === null) return null;
    total += delta;
    closed += 1;
    open = undefined;
  }
  if (open !== undefined || closed === 0) return null;
  return total;
}

function metric(input: {
  taskId: string;
  planId: string;
  revision: number;
  nodeId: string | null;
  name: EfficiencyMetricName;
  value: number | null;
}): EfficiencyMetric {
  return {
    taskId: input.taskId,
    planId: input.planId,
    revision: input.revision,
    nodeId: input.nodeId,
    metric: input.name,
    label: LABELS[input.name],
    value: input.value,
    unit: input.name.endsWith('Count') ? 'count' : 'ms',
  };
}

/**
 * 按已记录事件汇总。没有事件的任务不出现，不会补一行全 0。
 * 次数是已追加事件的条数，0 表示这条日志里没有该类事实。
 */
export function summarizeEfficiency(
  events: readonly EfficiencyEvent[],
  taskIds?: readonly string[],
): EfficiencySummary {
  const allowed = taskIds === undefined ? undefined : new Set(taskIds);
  const selected = [...events]
    .filter((event) => allowed === undefined || allowed.has(event.taskId))
    .sort((left, right) => left.sequence - right.sequence);
  const groups = new Map<string, EfficiencyEvent[]>();
  for (const event of selected) {
    const key = planKey(event);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  const metrics: EfficiencyMetric[] = [];
  for (const group of [...groups.values()].sort((left, right) => {
    const a = left[0]!;
    const b = right[0]!;
    return (
      a.taskId.localeCompare(b.taskId) ||
      a.planId.localeCompare(b.planId) ||
      a.revision - b.revision
    );
  })) {
    const head = group[0]!;
    const starts = group.filter((event) => event.kind === 'task-started');
    const ends = group.filter((event) => event.kind === 'task-ended');
    const firstStart = starts[0];
    const lastEnd = [...ends]
      .reverse()
      .find((event) => firstStart && event.sequence > firstStart.sequence);
    const resumed =
      lastEnd !== undefined &&
      group.some((event) => event.kind === 'node-started' && event.sequence > lastEnd.sequence);
    const span =
      firstStart === undefined || lastEnd === undefined || resumed
        ? null
        : elapsed(firstStart.occurredAt, lastEnd.occurredAt);
    const base = { taskId: head.taskId, planId: head.planId, revision: head.revision };
    metrics.push(metric({ ...base, nodeId: null, name: 'taskSpanMs', value: span }));
    metrics.push(
      metric({
        ...base,
        nodeId: null,
        name: 'humanInterventionCount',
        value: group.filter((event) => event.kind === 'human-intervention').length,
      }),
    );
    metrics.push(
      metric({
        ...base,
        nodeId: null,
        name: 'reworkCount',
        value: group.filter((event) => event.kind === 'rework').length,
      }),
    );
    metrics.push(
      metric({
        ...base,
        nodeId: null,
        name: 'toolCallCount',
        value: group.filter((event) => event.kind === 'tool-call').length,
      }),
    );
    const nodeIds = [
      ...new Set(
        group.flatMap((event) =>
          event.nodeId && (event.kind === 'node-started' || event.kind === 'node-ended')
            ? [event.nodeId]
            : [],
        ),
      ),
    ].sort();
    for (const nodeId of nodeIds) {
      const nodeEvents = group.filter((event) => event.nodeId === nodeId);
      metrics.push(
        metric({
          ...base,
          nodeId,
          name: 'nodeDurationMs',
          value: pairedDuration(nodeEvents, 'node-started', 'node-ended'),
        }),
      );
    }
  }
  return {
    kind: 'efficiency-metrics',
    coverage: 'recorded-events',
    unknownDuration: null,
    metrics,
    events: selected.map((event) => freezeEvent(event)),
  };
}

export function exportEfficiencyJson(summary: EfficiencySummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 设计文档对照表。空的 value 是未知历时，不是 0。带 BOM，便于表格软件识别 UTF-8。 */
export function exportEfficiencyCsv(summary: EfficiencySummary): string {
  const lines = ['taskId,planId,revision,nodeId,metric,label,value,unit'];
  for (const item of summary.metrics) {
    lines.push(
      [
        cell(item.taskId),
        cell(item.planId),
        cell(item.revision),
        cell(item.nodeId),
        cell(item.metric),
        cell(item.label),
        cell(item.value),
        cell(item.unit),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\n')}\n`;
}
