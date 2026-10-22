export const CONTEXT_ITEM_KINDS = [
  'goal',
  'parent-goal',
  'node-input',
  'accepted-upstream-artifact',
  'project-knowledge',
  'review-comment',
] as const;

export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

export type ContextBlockReason =
  'missing-file' | 'unreadable-file' | 'permission-denied' | 'path-rejected' | 'missing-required';

/** 调用方已经探过的文件事实。本包不读取文件系统。 */
export interface ContextFileProbe {
  readonly exists: boolean;
  readonly readable: boolean;
  /** 路径被拒绝时为 false。拒绝后的路径不会进入清单。 */
  readonly pathAccepted: boolean;
}

export interface ContextSourceInput {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly sourceId: string;
  readonly version: string;
  readonly permission: 'granted' | 'denied';
  readonly summary: string;
  readonly required: boolean;
  readonly file?: ContextFileProbe;
}

export interface ContextCitation {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly sourceId: string;
  readonly version: string;
  readonly permission: 'granted';
  readonly summary: string;
  /** 逻辑引用。不是本机绝对路径。 */
  readonly reference: string;
}

export interface ContextBlock {
  readonly sourceId: string;
  readonly kind: ContextItemKind;
  readonly version: string;
  readonly reason: ContextBlockReason;
}

export interface RunContextManifest {
  readonly id: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly planRevision: number;
  readonly citations: readonly ContextCitation[];
  readonly blocks: readonly ContextBlock[];
}

export interface WorkspaceClaim {
  readonly workspaceId: string;
  readonly writerRunId: string;
  readonly active: boolean;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function referenceFor(item: ContextSourceInput): string {
  return `${item.kind}:${item.sourceId}@${item.version}`;
}

/**
 * 装配一次运行要读取的上下文。
 * 缺文件、不可读或无权限时整次装配阻塞，并且不把本机路径放进清单。
 */
export function assembleRunContext(input: {
  readonly id: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly planRevision: number;
  readonly items: readonly ContextSourceInput[];
}):
  | { readonly ok: true; readonly manifest: RunContextManifest }
  | {
      readonly ok: false;
      readonly code: 'context-blocked';
      readonly manifest: RunContextManifest;
    } {
  const blocks: ContextBlock[] = [];
  const citations: ContextCitation[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.id) || blank(item.id) || blank(item.sourceId) || blank(item.version)) {
      blocks.push({
        sourceId: item.sourceId || item.id || 'unknown',
        kind: item.kind,
        version: item.version || 'unknown',
        reason: 'missing-required',
      });
      continue;
    }
    seen.add(item.id);
    if (item.permission !== 'granted') {
      blocks.push({
        sourceId: item.sourceId,
        kind: item.kind,
        version: item.version,
        reason: 'permission-denied',
      });
      continue;
    }
    if (item.file) {
      if (!item.file.pathAccepted) {
        blocks.push({
          sourceId: item.sourceId,
          kind: item.kind,
          version: item.version,
          reason: 'path-rejected',
        });
        continue;
      }
      if (!item.file.exists) {
        blocks.push({
          sourceId: item.sourceId,
          kind: item.kind,
          version: item.version,
          reason: 'missing-file',
        });
        continue;
      }
      if (!item.file.readable) {
        blocks.push({
          sourceId: item.sourceId,
          kind: item.kind,
          version: item.version,
          reason: 'unreadable-file',
        });
        continue;
      }
    } else if (item.required && blank(item.summary)) {
      blocks.push({
        sourceId: item.sourceId,
        kind: item.kind,
        version: item.version,
        reason: 'missing-required',
      });
      continue;
    }
    citations.push({
      id: item.id,
      kind: item.kind,
      sourceId: item.sourceId,
      version: item.version,
      permission: 'granted',
      summary: item.summary,
      reference: referenceFor(item),
    });
  }
  const manifest: RunContextManifest = {
    id: input.id,
    taskId: input.taskId,
    nodeId: input.nodeId,
    planRevision: input.planRevision,
    citations: Object.freeze(citations),
    blocks: Object.freeze(blocks),
  };
  if (blocks.length > 0)
    return { ok: false, code: 'context-blocked', manifest: Object.freeze(manifest) };
  return { ok: true, manifest: Object.freeze(manifest) };
}

/** 同一节点的各次运行共用一个可写工作区。第二个写入者要等前一个释放。 */
export function isolateWorkspaceId(nodeId: string): string {
  return `node-workspace:${nodeId}`;
}

export function claimWritableWorkspace(input: {
  readonly workspaceId: string;
  readonly writerRunId: string;
  readonly existing: readonly WorkspaceClaim[];
}):
  | { readonly ok: true; readonly claim: WorkspaceClaim }
  | { readonly ok: false; readonly code: 'workspace-busy'; readonly writerRunId: string } {
  const active = input.existing.find(
    (claim) => claim.workspaceId === input.workspaceId && claim.active,
  );
  if (active && active.writerRunId !== input.writerRunId) {
    return { ok: false, code: 'workspace-busy', writerRunId: active.writerRunId };
  }
  if (active) return { ok: true, claim: active };
  return {
    ok: true,
    claim: { workspaceId: input.workspaceId, writerRunId: input.writerRunId, active: true },
  };
}

export function releaseWritableWorkspace(
  claims: readonly WorkspaceClaim[],
  workspaceId: string,
  writerRunId: string,
): readonly WorkspaceClaim[] {
  return claims.map((claim) =>
    claim.workspaceId === workspaceId && claim.writerRunId === writerRunId
      ? { ...claim, active: false }
      : claim,
  );
}
