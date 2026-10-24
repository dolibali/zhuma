import type { ExecutionEngine } from './types.js';

export const MODEL_INHERITANCE = [
  'node-override',
  'expert-preference',
  'project-default',
  'executor-managed',
] as const;

export type ModelInheritance = (typeof MODEL_INHERITANCE)[number];

export const RESOURCE_ORIGINS = ['expert-preset', 'added'] as const;
export type ResourceOrigin = (typeof RESOURCE_ORIGINS)[number];

export interface SkillSelection {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly origin: ResourceOrigin;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface McpSelection {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly origin: ResourceOrigin;
  readonly available: boolean;
  /** 勾选 MCP 不会自动变成 true。只有单独的工具授权才能打开。 */
  readonly toolsAuthorized: boolean;
  readonly explicitToolGrant: boolean;
  readonly unavailableReason?: string;
}

/** 一次运行实际生效的配置快照。界面和消息都引用这份快照，不另存一套。 */
export interface ExecutionConfigSnapshot {
  readonly id: string;
  readonly expertId: string;
  readonly expertVersionId: string;
  readonly expertLabel: string;
  readonly expertSummary: string;
  readonly expertEnabled: boolean;
  readonly expertUnavailableReason?: string;
  readonly executorId: ExecutionEngine | null;
  readonly executorLabel: string;
  readonly executorAvailable: boolean;
  readonly executorVerified: boolean;
  readonly executorUnavailableReason?: string;
  readonly simulated: boolean;
  readonly modelLabel: string;
  readonly modelInheritance: ModelInheritance;
  readonly modelCompatible: boolean;
  readonly modelUnavailableReason?: string;
  readonly modelId?: string;
  readonly skills: readonly SkillSelection[];
  readonly mcp: readonly McpSelection[];
  readonly attachmentIds: readonly string[];
  readonly contextSummaries: readonly {
    readonly sourceId: string;
    readonly version: string;
    readonly summary: string;
  }[];
}

export type ConfigIssueCode =
  | 'expert-disabled'
  | 'executor-not-selected'
  | 'executor-unavailable'
  | 'executor-unverified'
  | 'simulated-mismatch'
  | 'model-incompatible'
  | 'model-claims-real-success'
  | 'resource-unavailable'
  | 'mcp-not-auto-authorized'
  | 'duplicate-resource';

export interface ConfigIssue {
  readonly code: ConfigIssueCode;
  readonly target: string;
  readonly reason: string;
}

function blank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

/** 选择 MCP 本身不授权全部工具。 */
export function mcpSelectionAuthorizesAllTools(): false {
  return false;
}

/**
 * 校验表 8 的生效配置。
 * 模拟执行器必须显式选择，并且不能带上一个看似真实调用成功的模型名。
 */
export function validateExecutionConfig(
  config: ExecutionConfigSnapshot,
): { readonly ok: true } | { readonly ok: false; readonly issues: readonly ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  if (!config.expertEnabled) {
    issues.push({
      code: 'expert-disabled',
      target: config.expertId || 'expert',
      reason: config.expertUnavailableReason?.trim() || '专家已停用',
    });
  }
  if (config.executorId === null) {
    issues.push({
      code: 'executor-not-selected',
      target: 'executor',
      reason: '尚未选择执行器',
    });
  } else if (!config.executorAvailable) {
    issues.push({
      code: 'executor-unavailable',
      target: config.executorId,
      reason: config.executorUnavailableReason?.trim() || '执行器不可用',
    });
  } else if (config.executorId !== 'simulated' && !config.executorVerified) {
    issues.push({
      code: 'executor-unverified',
      target: config.executorId,
      reason: config.executorUnavailableReason?.trim() || '执行器尚未验证',
    });
  }
  if (config.simulated !== (config.executorId === 'simulated')) {
    issues.push({
      code: 'simulated-mismatch',
      target: config.executorId ?? 'executor',
      reason: '模拟标识必须与显式选择的模拟执行器一致',
    });
  }
  if (config.simulated) {
    if (config.modelInheritance !== 'executor-managed' || config.modelId !== undefined) {
      issues.push({
        code: 'model-claims-real-success',
        target: 'model',
        reason: '模拟执行器不连接真实模型，不能显示具体模型已生效',
      });
    }
    if (!config.modelLabel.includes('模拟')) {
      issues.push({
        code: 'model-claims-real-success',
        target: 'model',
        reason: '模拟执行器的模型说明必须带有模拟标识',
      });
    }
  }
  if (!config.modelCompatible) {
    issues.push({
      code: 'model-incompatible',
      target: config.modelId ?? 'model',
      reason: config.modelUnavailableReason?.trim() || '模型与执行器不兼容',
    });
  }
  for (const skill of config.skills) {
    const key = `skill:${skill.id}`;
    if (seen.has(key)) {
      issues.push({ code: 'duplicate-resource', target: skill.id, reason: 'Skill 重复选择' });
    }
    seen.add(key);
    if (!skill.available && blank(skill.unavailableReason)) {
      issues.push({
        code: 'resource-unavailable',
        target: skill.id,
        reason: '不可用的 Skill 必须写明原因',
      });
    }
    if (!skill.available) {
      issues.push({
        code: 'resource-unavailable',
        target: skill.id,
        reason: skill.unavailableReason?.trim() || 'Skill 不可用',
      });
    }
  }
  for (const mcp of config.mcp) {
    const key = `mcp:${mcp.id}`;
    if (seen.has(key)) {
      issues.push({ code: 'duplicate-resource', target: mcp.id, reason: 'MCP 重复选择' });
    }
    seen.add(key);
    if (mcp.toolsAuthorized && !mcp.explicitToolGrant) {
      issues.push({
        code: 'mcp-not-auto-authorized',
        target: mcp.id,
        reason: '选择 MCP 不会自动授权全部工具',
      });
    }
    if (!mcp.available && blank(mcp.unavailableReason)) {
      issues.push({
        code: 'resource-unavailable',
        target: mcp.id,
        reason: '不可用的 MCP 必须写明原因',
      });
    }
    if (!mcp.available) {
      issues.push({
        code: 'resource-unavailable',
        target: mcp.id,
        reason: mcp.unavailableReason?.trim() || 'MCP 不可用',
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return { ok: true };
}
