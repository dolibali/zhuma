/**
 * Host 上的追加效率日志。业务命令失败不会因为记日志而改写；
 * 重复事实按 kind + sourceId 忽略。磁盘续写是可选的。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  appendEfficiencyEvent,
  exportEfficiencyCsv,
  exportEfficiencyJson,
  summarizeEfficiency,
  type EfficiencyEvent,
  type EfficiencyEventKind,
} from '@zhuma/context';

export const efficiencyExportSchema = z.strictObject({
  format: z.enum(['json', 'csv']),
  taskId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w-]+$/u)
    .optional(),
});

export interface EfficiencyFact {
  readonly kind: EfficiencyEventKind;
  readonly occurredAt: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly sourceId: string;
  readonly nodeId?: string;
}

export interface EfficiencyStamp {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly assigneeKind: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly status: string;
  readonly version: number;
}

export interface EfficiencyPlanNode {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly command: { readonly status: string; readonly version: number };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

let log: readonly EfficiencyEvent[] = [];
let clock = (): string => new Date().toISOString();
let attached: string | undefined;

export function efficiencyNow(): string {
  return clock();
}

/** 测试注入时钟。生产路径使用调用时刻。 */
export function setEfficiencyClockForTests(next: (() => string) | undefined): void {
  clock = next ?? (() => new Date().toISOString());
}

export function resetEfficiencyLogForTests(): void {
  log = [];
  attached = undefined;
  clock = () => new Date().toISOString();
}

export function efficiencyTaskIds(): readonly string[] {
  return [...new Set(log.map((event) => event.taskId))];
}

export function readEfficiencyLog(): readonly EfficiencyEvent[] {
  return log;
}

function snapshotHash(nodes: readonly EfficiencyPlanNode[]): string {
  const text = nodes
    .map((node) => `${node.nodeId}:${node.command.status}:${node.command.version}`)
    .sort()
    .join('|');
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** 追加一条事实。重复或无效输入返回 false，不抛给业务命令。 */
export function emitEfficiencyFact(fact: EfficiencyFact): boolean {
  try {
    const sequence = log.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
    const event: EfficiencyEvent = {
      eventId: `eff-${sequence}`,
      sequence,
      occurredAt: fact.occurredAt,
      taskId: fact.taskId,
      planId: fact.planId,
      revision: fact.revision,
      kind: fact.kind,
      sourceId: fact.sourceId,
      ...(fact.nodeId === undefined ? {} : { nodeId: fact.nodeId }),
    };
    const appended = appendEfficiencyEvent(log, event);
    if (!appended.ok) return false;
    log = appended.log;
    if (attached) {
      try {
        appendFileSync(attached, `${JSON.stringify(event)}\n`, 'utf8');
      } catch {
        // 内存里的事实已经记下。磁盘失败不回滚，也不阻断调用方。
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 从已经接受的执行戳映射效率事实。
 * 人工节点在进入 ready 时起算，专家节点的运行历时由运行边界另记。
 */
export function noteExecutionFact(stamp: EfficiencyStamp): void {
  const base = {
    occurredAt: stamp.occurredAt,
    taskId: stamp.taskId,
    planId: stamp.planId,
    revision: stamp.revision,
    nodeId: stamp.nodeId,
  };
  const human = stamp.assigneeKind === 'human';
  if (stamp.eventType === 'node-started' && human && stamp.status === 'ready') {
    emitEfficiencyFact({
      ...base,
      kind: 'node-started',
      sourceId: `node-start:${stamp.taskId}:${stamp.planId}:${stamp.revision}:${stamp.nodeId}`,
    });
  }
  if (stamp.eventType === 'downstream-unlocked' && human && stamp.status === 'ready') {
    emitEfficiencyFact({
      ...base,
      kind: 'node-started',
      sourceId: `node-start:${stamp.taskId}:${stamp.planId}:${stamp.revision}:${stamp.nodeId}:v${stamp.version}`,
    });
  }
  if (stamp.eventType === 'delivery-submitted' && human) {
    emitEfficiencyFact({
      ...base,
      kind: 'human-intervention',
      sourceId: `human-submit:${stamp.taskId}:${stamp.nodeId}:v${stamp.version}`,
    });
  }
  if (
    (stamp.eventType === 'ballot-recorded' || stamp.eventType === 'review-settled') &&
    stamp.status === 'needs-revision'
  ) {
    emitEfficiencyFact({
      ...base,
      kind: 'rework',
      sourceId: `rework:${stamp.taskId}:${stamp.nodeId}:v${stamp.version}`,
    });
  }
  if (human && TERMINAL.has(stamp.status) && stamp.eventType !== 'node-started') {
    emitEfficiencyFact({
      ...base,
      kind: 'node-ended',
      sourceId: `node-end:${stamp.taskId}:${stamp.planId}:${stamp.revision}:${stamp.nodeId}:v${stamp.version}`,
    });
  }
}

export function noteTaskStarted(input: {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly occurredAt?: string;
}): boolean {
  return emitEfficiencyFact({
    kind: 'task-started',
    occurredAt: input.occurredAt ?? efficiencyNow(),
    taskId: input.taskId,
    planId: input.planId,
    revision: input.revision,
    sourceId: `task-start:${input.taskId}:${input.planId}:${input.revision}`,
  });
}

/** 计划里每个节点都已结束时记一次任务结束。快照不变则不重复记。 */
export function notePlanIfTerminal(
  records: readonly EfficiencyPlanNode[],
  occurredAt = efficiencyNow(),
): boolean {
  const first = records[0];
  if (!first || records.length === 0) return false;
  if (
    !records.every(
      (record) =>
        record.taskId === first.taskId &&
        record.planId === first.planId &&
        record.revision === first.revision &&
        TERMINAL.has(record.command.status),
    )
  ) {
    return false;
  }
  return emitEfficiencyFact({
    kind: 'task-ended',
    occurredAt,
    taskId: first.taskId,
    planId: first.planId,
    revision: first.revision,
    sourceId: `task-end:${first.taskId}:${first.planId}:${first.revision}:${snapshotHash(records)}`,
  });
}

export function noteRunBoundary(input: {
  readonly phase: 'started' | 'ended';
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly runId: string;
  readonly occurredAt?: string;
}): boolean {
  return emitEfficiencyFact({
    kind: input.phase === 'started' ? 'node-started' : 'node-ended',
    occurredAt: input.occurredAt ?? efficiencyNow(),
    taskId: input.taskId,
    planId: input.planId,
    revision: input.revision,
    nodeId: input.nodeId,
    sourceId: `run-${input.phase}:${input.runId}`,
  });
}

export function noteHumanIntervention(input: {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly occurredAt?: string;
}): boolean {
  return emitEfficiencyFact({
    kind: 'human-intervention',
    occurredAt: input.occurredAt ?? efficiencyNow(),
    taskId: input.taskId,
    planId: input.planId,
    revision: input.revision,
    nodeId: input.nodeId,
    sourceId: input.sourceId,
  });
}

export function noteAssistantToolCalls(
  scope: {
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
    readonly nodeId: string;
    readonly runId: string;
  },
  data: unknown,
  occurredAt = efficiencyNow(),
): number {
  const message =
    data && typeof data === 'object' && 'message' in data
      ? (data as { message?: { content?: unknown } }).message
      : undefined;
  const content = Array.isArray(data) ? data : message?.content;
  if (!Array.isArray(content)) return 0;
  let noted = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as { type?: unknown; id?: unknown; callId?: unknown };
    if (record.type !== 'tool-call') continue;
    const raw = typeof record.id === 'string' ? record.id : record.callId;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (
      emitEfficiencyFact({
        kind: 'tool-call',
        occurredAt,
        taskId: scope.taskId,
        planId: scope.planId,
        revision: scope.revision,
        nodeId: scope.nodeId,
        sourceId: `tool:${scope.runId}:${raw.trim()}`,
      })
    ) {
      noted += 1;
    }
  }
  return noted;
}

function nativeOccurredAt(time: unknown): string {
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 1_000_000_000)
    return efficiencyNow();
  const ms = time > 1_000_000_000_000 ? time : time * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? efficiencyNow() : date.toISOString();
}

export function noteNativeToolCall(
  scope: {
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
    readonly nodeId: string;
  },
  sessionId: string,
  event: { readonly seq: number; readonly type: string; readonly time?: number },
): boolean {
  if (event.type !== 'tool/call') return false;
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) return false;
  if (sessionId.trim() === '') return false;
  return emitEfficiencyFact({
    kind: 'tool-call',
    occurredAt: nativeOccurredAt(event.time),
    taskId: scope.taskId,
    planId: scope.planId,
    revision: scope.revision,
    nodeId: scope.nodeId,
    sourceId: `native-tool:${sessionId}:${event.seq}`,
  });
}

export interface EfficiencyExportFile {
  readonly format: 'json' | 'csv';
  readonly filename: string;
  readonly document: string;
  readonly metricCount: number;
}

export function efficiencyDocument(input: {
  readonly format: 'json' | 'csv';
  readonly taskIds: readonly string[];
}): EfficiencyExportFile {
  const summary = summarizeEfficiency(log, input.taskIds);
  const document =
    input.format === 'json' ? exportEfficiencyJson(summary) : exportEfficiencyCsv(summary);
  return {
    format: input.format,
    filename: input.format === 'json' ? 'efficiency-metrics.json' : 'efficiency-metrics.csv',
    document,
    metricCount: summary.metrics.length,
  };
}

/** 续写一份 JSONL。已有行按追加规则回放；坏行会拒绝绑定。 */
export function attachEfficiencyLogFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (attached === resolved) return;
  if (attached) throw new Error('效率日志已经绑定到另一个文件。');
  mkdirSync(path.dirname(resolved), { recursive: true });
  if (existsSync(resolved)) {
    const text = readFileSync(resolved, 'utf8');
    let next = log;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const event = JSON.parse(line) as EfficiencyEvent;
      const appended = appendEfficiencyEvent(next, event);
      if (!appended.ok) throw new Error(`效率日志无法续写：${appended.code}`);
      next = appended.log;
    }
    log = next;
  }
  attached = resolved;
}
