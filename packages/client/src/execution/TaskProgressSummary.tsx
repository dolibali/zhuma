import type { NodeStatus } from '@zhuma/agent-core';
import type { TaskProgressState } from './useTaskProgress.js';
import type { TaskProgressRow } from './task-progress.js';

const statusLabels: Record<NodeStatus, string> = {
  draft: '未就绪',
  blocked: '等待前置',
  ready: '待处理',
  running: '执行中',
  'waiting-for-input': '待补充',
  'child-workflow': '子工作流',
  'in-review': '待评审',
  'needs-revision': '待修改',
  completed: '已完成节点',
  failed: '失败',
  cancelled: '已取消',
};
const unknownLabels = {
  'empty-plan': '计划没有节点',
  'unsupported-child-workflow': '包含尚未支持执行的子工作流',
  'node-limit': '节点数量超出当前读取范围',
  'incomplete-plan': '执行记录不完整',
  'invalid-plan': '计划数据需要核实',
  'invalid-node': '节点数据需要核实',
  'invalid-state': '节点状态需要核实',
  'invalid-accepted': '已接受版本需要核实',
};

export function taskProgressFacts(row: TaskProgressRow): string[] {
  if (row.facts === 'unknown') return [`进度未知 · ${unknownLabels[row.reason]}`];
  if (row.facts === 'not-started') return ['尚未开始'];
  const facts: string[] = [];
  if (row.delivery === 'all-accepted')
    facts.push(`产物全部已接受 ${row.acceptedNodes}/${row.expectedNodes}`);
  else {
    facts.push(`已接受 ${row.acceptedNodes}/${row.expectedNodes}`);
    if (row.delivery === 'cancelled') facts.push('全部已取消');
    else if (row.delivery === 'mixed-terminal') facts.push('已结束 · 未全部交付');
    for (const [status, label] of Object.entries(statusLabels)) {
      if (status === 'completed' || status === 'child-workflow') continue;
      const count = row.byStatus[status as NodeStatus];
      if (count) facts.push(`${label} ${count}`);
    }
  }
  if (row.reason === 'upstream-affected') facts.push('上游变更待处理');
  if (row.resources.authorHeld) facts.push(`执行资源持有 ${row.resources.authorHeld}`);
  if (row.resources.reviewHeld) facts.push(`评审资源持有 ${row.resources.reviewHeld}`);
  if (row.resources.stopRequested) facts.push(`停止待确认 ${row.resources.stopRequested}`);
  return facts;
}

/** Shared task/project/detail projection; allocation and runtime are separate facts. */
export function TaskProgressSummary({
  progress,
  confirmed = false,
  compact = false,
}: {
  progress?: TaskProgressState | undefined;
  confirmed?: boolean;
  compact?: boolean;
}) {
  if (!progress) return confirmed ? <span className="zm-muted">进度尚未接通</span> : null;
  if (progress.state === 'loading') return <span className="zm-muted">正在读取进度…</span>;
  if (progress.state === 'error')
    return (
      <span className="zm-muted" title={progress.message}>
        进度无法核实
      </span>
    );
  const row = progress.row;
  return (
    <span
      className={`zm-task-progress${compact ? ' zm-task-progress-compact' : ''}`}
      aria-label="当前确认计划进度"
      title={row.facts === 'unknown' ? unknownLabels[row.reason] : undefined}
    >
      {(compact && row.facts === 'unknown' ? ['进度未知'] : taskProgressFacts(row)).map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
      {!compact && row.facts !== 'unknown' && (
        <small>
          分配：人工 {row.assigneeCounts.human} · 专家 {row.assigneeCounts.expert}
        </small>
      )}
    </span>
  );
}
