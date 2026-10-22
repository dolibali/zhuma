import {
  validateExecutionConfig,
  executionTodoHint,
  isTerminalRunStatus,
  type ExecutionDeskSnapshot,
  type InterventionPhase,
  type InterventionRecord,
  type NodeStatus,
} from '@zhuma/agent-core';

const NODE_LABELS: Record<NodeStatus, string> = {
  draft: '草稿',
  blocked: '等待前置',
  ready: '待处理',
  running: '执行中',
  'waiting-for-input': '等待输入',
  'child-workflow': '子工作流处理中',
  'in-review': '待评审',
  'needs-revision': '需修改',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const RUN_LABELS = {
  requested: '已请求，等待执行器回执',
  running: '执行中',
  'waiting-for-input': '等待输入',
  completed: '运行已结束',
  failed: '运行失败',
  cancelled: '已取消',
} as const;

const PHASES: readonly InterventionPhase[] = ['sent', 'received', 'pending', 'applied'];
const PHASE_LABELS: Record<InterventionPhase, string> = {
  sent: '已发送',
  received: '已接收',
  pending: '待生效',
  applied: '已应用',
};

const BLOCK_LABELS: Record<string, string> = {
  'missing-file': '文件不存在',
  'unreadable-file': '文件不可读',
  'permission-denied': '没有权限',
  'path-rejected': '路径被拒绝',
  'missing-required': '缺少必需内容',
};

export interface AgentWorkspaceView {
  readonly pageTitle: string;
  readonly backHref: string;
  readonly backLabel: string;
  readonly taskCrumb: string;
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly nodeGoal: string;
  readonly nodeStatus: NodeStatus;
  readonly nodeStatusLabel: string;
  readonly nodeStatusText: string;
  readonly assigneeNote: string;
  readonly simulated: boolean;
  readonly banner: string | null;
  readonly resumeNote: string | null;
  readonly nextAction: string;
  readonly run: {
    readonly id: string;
    readonly attempt: number;
    readonly generation: number;
    readonly label: string;
    readonly simulated: boolean;
  } | null;
  readonly runs: readonly {
    readonly id: string;
    readonly attempt: number;
    readonly label: string;
    readonly simulated: boolean;
  }[];
  readonly primary: {
    readonly label: string;
    readonly enabled: boolean;
    readonly disabledReason: string | null;
  };
  readonly stop: {
    readonly visible: boolean;
    readonly enabled: boolean;
    readonly disabledReason: string | null;
  };
  readonly retry: {
    readonly visible: boolean;
    readonly label: string;
    readonly enabled: boolean;
    readonly disabledReason: string | null;
  };
  readonly reassignEnabled: boolean;
  readonly humanTakeoverEnabled: boolean;
  readonly verifyAbandoned: boolean;
  readonly turns: readonly {
    readonly id: string;
    readonly role: string;
    readonly roleLabel: string;
    readonly body: string;
    readonly expertVersionId: string;
    readonly simulated: boolean;
    readonly attachmentIds: readonly string[];
  }[];
  readonly activities: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly simulated: boolean;
    readonly succeeded: boolean;
  }[];
  readonly interventions: readonly {
    readonly id: string;
    readonly notice: string | null;
    readonly phases: readonly {
      readonly id: InterventionPhase;
      readonly label: string;
      readonly reached: boolean;
      readonly current: boolean;
    }[];
  }[];
  readonly lateRecords: readonly {
    readonly id: string;
    readonly summary: string;
    readonly reason: string;
  }[];
  readonly faults: readonly {
    readonly id: string;
    readonly objectLabel: string;
    readonly reason: string;
    readonly nextStep: string;
  }[];
  readonly error: {
    readonly objectLabel: string;
    readonly reason: string;
    readonly nextStep: string;
  } | null;
  readonly contextItems: readonly {
    readonly id: string;
    readonly summary: string;
    readonly version: string;
    readonly included: boolean;
    readonly required: boolean;
    readonly fileState: string | null;
    readonly blockText: string | null;
  }[];
  readonly citations: readonly {
    readonly reference: string;
    readonly summary: string;
    readonly version: string;
  }[];
  readonly blocks: readonly { readonly sourceId: string; readonly text: string }[];
  readonly attachments: readonly {
    readonly id: string;
    readonly name: string;
    readonly reference: string;
  }[];
  readonly drafts: readonly {
    readonly text: string;
    readonly note: string;
    readonly roundId: string;
  }[];
  readonly downstreamText: string;
  readonly delivered: false;
  readonly poll: boolean;
  readonly experts: readonly {
    readonly id: string;
    readonly label: string;
    readonly summary: string;
    readonly enabled: boolean;
    readonly reason: string | null;
    readonly selected: boolean;
  }[];
  readonly executors: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly simulated: boolean;
    readonly reason: string | null;
    readonly selected: boolean;
  }[];
  readonly skills: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly reason: string | null;
    readonly selected: boolean;
    readonly origin: string | null;
  }[];
  readonly mcp: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly reason: string | null;
    readonly selected: boolean;
    readonly origin: string | null;
  }[];
  readonly modelText: string;
  readonly modelSource: string;
  readonly mcpNote: string;
}

/** 只读投影。调用它不会创建运行，也不会把发送成功写成已应用。 */
export function createAgentWorkspaceView(snapshot: ExecutionDeskSnapshot): AgentWorkspaceView {
  const active = snapshot.runs.find((run) => !isTerminalRunStatus(run.status));
  const hint = executionTodoHint({
    nodeStatus: snapshot.node.status,
    actorId: snapshot.actorId,
    assignee: snapshot.assignee,
    ...(active ? { runStatus: active.status, stopPhase: active.stopPhase } : {}),
  });
  const configIssues = validateExecutionConfig(snapshot.config);
  const issue = configIssues.ok ? undefined : configIssues.issues[0];
  const stopPending = active?.stopPhase === 'requested';
  const issueTarget =
    issue?.target === 'executor' ? '执行器' : issue?.target === 'model' ? '模型' : issue?.target;
  const sendBlocked = issue
    ? `${issueTarget}：${issue.reason}。修正后再发送，未配置时不会改用模拟执行器。`
    : stopPending
      ? '正在等待停止回执，不能再发送。'
      : !snapshot.interactionReady
        ? '正在恢复事实，恢复完成前不能发送。'
        : null;
  const nodeLabel = NODE_LABELS[snapshot.node.status];
  return {
    pageTitle: 'Agent 处理',
    backHref: `?view=task&task=${encodeURIComponent(snapshot.handoff.taskId)}`,
    backLabel: '返回任务',
    taskCrumb: snapshot.taskTitle,
    taskTitle: snapshot.taskTitle,
    taskGoal: snapshot.taskGoal,
    nodeGoal: snapshot.handoff.goal,
    nodeStatus: snapshot.node.status,
    nodeStatusLabel: nodeLabel,
    nodeStatusText: `状态：${nodeLabel}`,
    assigneeNote: `责任人仍是 ${snapshot.assignee.id}。使用 Agent 不改变责任人。`,
    simulated: snapshot.config.simulated,
    banner: snapshot.config.simulated
      ? '当前是模拟执行器。回复、工具活动和结果都是模拟，不代表模型或工具调用成功。'
      : snapshot.config.executorId === null
        ? '尚未选择执行器。未配置时不会自动改用模拟执行器。'
        : null,
    resumeNote: snapshot.resumeGap
      ? `已恢复事实：运行 ${snapshot.resumeGap.runId} 仍未结束。执行器不支持会话恢复，没有把它推断成完成。`
      : null,
    nextAction: hint.label,
    run: active
      ? {
          id: active.id,
          attempt: active.attempt,
          generation: active.generation,
          label: RUN_LABELS[active.status],
          simulated: active.simulated,
        }
      : null,
    runs: snapshot.runs.map((run) => ({
      id: run.id,
      attempt: run.attempt,
      label: RUN_LABELS[run.status],
      simulated: run.simulated,
    })),
    primary: {
      label: active ? '发送补充' : '发送',
      enabled: sendBlocked === null,
      disabledReason: sendBlocked,
    },
    stop: {
      visible: Boolean(active),
      enabled: Boolean(active) && !stopPending,
      disabledReason: stopPending ? '正在等待执行器的停止回执。关闭页面不会取消运行。' : null,
    },
    retry: {
      visible: snapshot.node.status === 'failed' || snapshot.node.status === 'cancelled',
      label: snapshot.node.status === 'cancelled' ? '重新开始' : '重试',
      enabled: snapshot.node.status === 'failed' || snapshot.node.status === 'cancelled',
      disabledReason: null,
    },
    reassignEnabled: true,
    humanTakeoverEnabled: true,
    verifyAbandoned: snapshot.resumeGap !== null,
    turns: snapshot.turns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      roleLabel: turn.role === 'user' ? '我' : turn.simulated ? '模拟执行器' : '执行器',
      body: turn.body,
      expertVersionId: turn.expertVersionId,
      simulated: turn.simulated,
      attachmentIds: turn.attachmentIds,
    })),
    activities: snapshot.activities.map((activity) => ({
      id: activity.id,
      title: activity.title,
      detail: activity.detail,
      simulated: activity.simulated,
      succeeded: activity.succeeded,
    })),
    interventions: snapshot.interventions.map((item) => ({
      id: item.id,
      notice: item.notice ?? null,
      phases: PHASES.map((phase) => ({
        id: phase,
        label: PHASE_LABELS[phase],
        reached: phaseReached(item, phase),
        current: item.phase === phase,
      })),
    })),
    lateRecords: snapshot.lateRecords.map((record) => ({
      id: record.id,
      summary: record.summary,
      reason:
        record.reason === 'terminal-run'
          ? '已结束运行的迟到结果，未推进节点'
          : record.reason === 'stale-generation'
            ? '过期世代，未推进节点'
            : record.reason === 'superseded-run'
              ? '已被新运行取代，未推进节点'
              : '取消尚未确认，未推进节点',
    })),
    faults: snapshot.faults.map((fault) => ({
      id: fault.id,
      objectLabel: fault.objectLabel,
      reason: fault.reason,
      nextStep: fault.nextStep,
    })),
    error: snapshot.lastError,
    contextItems: snapshot.contextItems.map((item) => ({
      id: item.id,
      summary: item.summary,
      version: item.version,
      included: item.included,
      required: item.required,
      fileState: item.fileState ?? null,
      blockText:
        item.fileState === 'missing' ||
        item.fileState === 'unreadable' ||
        item.fileState === 'rejected'
          ? `来源 ${item.sourceId} @ ${item.version}：${
              item.fileState === 'missing'
                ? '文件不存在'
                : item.fileState === 'unreadable'
                  ? '文件不可读'
                  : '路径被拒绝'
            }`
          : null,
    })),
    citations: snapshot.citations.map((item) => ({
      reference: item.reference,
      summary: item.summary,
      version: item.version,
    })),
    blocks: snapshot.contextBlocks.map((block) => ({
      sourceId: block.sourceId,
      text: `来源 ${block.sourceId} @ ${block.version}：${BLOCK_LABELS[block.reason] ?? block.reason}。不会传出不可访问的本机路径。`,
    })),
    attachments: snapshot.attachments.map((item) => ({
      id: item.id,
      name: item.name,
      reference: item.reference,
    })),
    drafts: snapshot.drafts.map((draft) => ({
      text: draft.text,
      roundId: draft.review.roundId,
      note: '已形成可编辑草稿，尚未交付，也没有跳过评审。正式提交属于交付流程。',
    })),
    downstreamText:
      snapshot.downstreamLaunches === 0
        ? '未触发下游'
        : `已触发下游 ${snapshot.downstreamLaunches} 次`,
    delivered: false,
    poll: Boolean(active) || snapshot.resumeGap !== null,
    experts: snapshot.catalog.experts.map((expert) => ({
      id: expert.id,
      label: expert.label,
      summary: expert.summary,
      enabled: expert.enabled,
      reason: expert.enabled ? null : (expert.unavailableReason ?? '专家已停用'),
      selected: expert.id === snapshot.config.expertId,
    })),
    executors: snapshot.catalog.executors.map((executor) => ({
      id: executor.id,
      label: executor.simulated ? `${executor.label}（模拟）` : executor.label,
      available: executor.available,
      simulated: executor.simulated,
      reason: executor.available ? null : (executor.unavailableReason ?? '执行器不可用'),
      selected: executor.id === snapshot.config.executorId,
    })),
    skills: snapshot.catalog.skills.map((skill) => {
      const selected = snapshot.config.skills.find((item) => item.id === skill.id);
      return {
        id: skill.id,
        label: skill.label,
        available: skill.available,
        reason: skill.available ? null : (skill.unavailableReason ?? '不可用'),
        selected: Boolean(selected),
        origin: selected ? (selected.origin === 'expert-preset' ? '专家预置' : '本次追加') : null,
      };
    }),
    mcp: snapshot.catalog.mcp.map((item) => {
      const selected = snapshot.config.mcp.find((entry) => entry.id === item.id);
      return {
        id: item.id,
        label: item.label,
        available: item.available,
        reason: item.available ? null : (item.unavailableReason ?? '不可用'),
        selected: Boolean(selected),
        origin: selected ? (selected.origin === 'expert-preset' ? '专家预置' : '本次追加') : null,
      };
    }),
    modelText: snapshot.config.modelLabel,
    modelSource:
      snapshot.config.modelInheritance === 'executor-managed'
        ? '继承来源：由执行器管理'
        : `继承来源：${snapshot.config.modelInheritance}`,
    mcpNote: '选择 MCP 不会自动授权全部工具。',
  };
}

export function phaseReached(
  item: Pick<InterventionRecord, 'phase' | 'kind'>,
  phase: InterventionPhase,
): boolean {
  if (item.kind === 'next-turn') {
    const order: Record<InterventionPhase, number> = {
      sent: 0,
      received: 1,
      pending: 2,
      applied: 3,
    };
    return order[phase] <= order[item.phase];
  }
  if (phase === 'pending') return false;
  if (item.phase === 'sent') return phase === 'sent';
  if (item.phase === 'received') return phase === 'sent' || phase === 'received';
  return phase === 'sent' || phase === 'received' || phase === 'applied';
}
