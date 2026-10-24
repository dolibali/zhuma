import type { ActorRef, NodeHandoff } from './handoff.js';
import type { ReviewRound } from './review.js';
import type { NodeStatus } from './node-status.js';
import type { ExecutionEngine } from './types.js';
import type { ExecutionConfigSnapshot } from './agent-config.js';
import type {
  ActivityRecord,
  ArtifactDraftHandoff,
  ConversationTurn,
  ExecutionAttempt,
  FaultRecord,
  InterventionRecord,
  LateRecord,
  RecoveryRequest,
} from './execution.js';

export interface ExpertOption {
  readonly id: string;
  readonly versionId: string;
  readonly label: string;
  readonly summary: string;
  readonly enabled: boolean;
  readonly unavailableReason?: string;
  readonly presetSkillIds: readonly string[];
  readonly presetMcpIds: readonly string[];
  /** 内置工具白名单。缺省表示全部关闭。名字见 WP03 契约里的授权映射。 */
  readonly toolAllowlist?: readonly string[];
}

export interface SkillOption {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** 写入 SKILL.md 的说明。缺省时用 label。 */
  readonly description?: string;
  /** 写入 SKILL.md 的正文。缺省时用 label。 */
  readonly body?: string;
}

export interface McpOption {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** 只有带传输时才会插入上游 MCP 客户端。没有传输时只把身份放进提示。 */
  readonly transport?: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
}

export interface ExecutorOption {
  readonly id: ExecutionEngine;
  readonly label: string;
  readonly available: boolean;
  readonly verified: boolean;
  readonly simulated: boolean;
  readonly unavailableReason?: string;
}

export interface WorkspaceCatalog {
  readonly experts: readonly ExpertOption[];
  readonly skills: readonly SkillOption[];
  readonly mcp: readonly McpOption[];
  readonly executors: readonly ExecutorOption[];
}

export interface AttachmentFact {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly reference: string;
  readonly previewText?: string;
  /** 当前进程里还有字节时为 true。重新打开后为 false，需要重新上传。 */
  readonly contentAvailable?: boolean;
}

export interface ContextItemFact {
  readonly id: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly version: string;
  readonly summary: string;
  readonly required: boolean;
  readonly included: boolean;
  readonly permission: 'granted' | 'denied';
  readonly fileState?: 'readable' | 'missing' | 'unreadable' | 'rejected' | 'unchecked';
}

export interface ContextCitationFact {
  readonly id: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly version: string;
  readonly summary: string;
  readonly reference: string;
}

export interface ContextBlockFact {
  readonly sourceId: string;
  readonly kind: string;
  readonly version: string;
  readonly reason: string;
}

export interface CommandErrorFact {
  readonly code: string;
  readonly objectLabel: string;
  readonly reason: string;
  readonly nextStep: string;
}

export interface WorkspaceClaimFact {
  readonly workspaceId: string;
  readonly writerRunId: string;
  readonly active: boolean;
}

/** 工作区事实。界面只投影它，不在本地另造运行状态。 */
export interface ExecutionDeskSnapshot {
  readonly schema: 1;
  readonly interactionReady: boolean;
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly actorId: string;
  readonly handoff: NodeHandoff;
  readonly node: {
    readonly status: NodeStatus;
    readonly version: number;
    readonly upstreamAffected: boolean;
  };
  readonly assignee: ActorRef;
  readonly runs: readonly ExecutionAttempt[];
  readonly turns: readonly ConversationTurn[];
  readonly interventions: readonly InterventionRecord[];
  readonly lateRecords: readonly LateRecord[];
  readonly activities: readonly ActivityRecord[];
  readonly faults: readonly FaultRecord[];
  readonly attachments: readonly AttachmentFact[];
  readonly drafts: readonly ArtifactDraftHandoff[];
  readonly recoveryRequests: readonly RecoveryRequest[];
  readonly downstreamLaunches: number;
  readonly delivered: false;
  readonly resumeGap: { readonly runId: string; readonly reason: 'session-not-resumed' } | null;
  /** 下一轮是新会话，历史没有带入。新会话成功一轮或重启后消失。 */
  readonly historyNote?: string;
  readonly lastError: CommandErrorFact | null;
  readonly reviewRounds: readonly { readonly id: string; readonly status: ReviewRound['status'] }[];
  readonly activeRoundId: string | null;
  readonly config: ExecutionConfigSnapshot;
  readonly contextItems: readonly ContextItemFact[];
  readonly citations: readonly ContextCitationFact[];
  readonly contextBlocks: readonly ContextBlockFact[];
  readonly catalog: WorkspaceCatalog;
  readonly claims: readonly WorkspaceClaimFact[];
  /** 最近一次日志写入失败。成功写入后清空。不单独占一份存储。 */
  readonly persistenceFault?: CommandErrorFact | null;
}
