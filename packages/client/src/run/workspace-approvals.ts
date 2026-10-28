import { ExecutionError } from '../execution/ExecutionApi.js';

export type WorkspaceApprovalLocation = { readonly spaceId: string; readonly projectId: string };
export type WorkspacePublishRange = { readonly kind: 'file' | 'directory'; readonly path: string };
export interface WorkspaceApprovalRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly status: 'approved' | 'revoked';
  readonly access: 'read' | 'write' | null;
  readonly publish: readonly WorkspacePublishRange[];
}
export interface WorkspaceApprovalView {
  readonly available: boolean;
  readonly directories: readonly {
    readonly id: string;
    readonly title: string;
    readonly path: string;
    readonly access: 'read' | 'write';
  }[];
  readonly approvals: readonly WorkspaceApprovalRow[];
}
export type WorkspaceApprovalInput = WorkspaceApprovalLocation & {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly expectedGeneration: number;
  readonly access: 'read' | 'write';
  readonly publish: readonly WorkspacePublishRange[];
};
export type WorkspaceRevokeInput = WorkspaceApprovalLocation & {
  readonly requestId: string;
  readonly approvalId: string;
  readonly expectedGeneration: number;
};
export interface WorkspaceApprovalApi {
  /** Existing Workspaces from this member's official local sidebar. */
  existingDirectories?:
    | ((signal: AbortSignal) => Promise<
        readonly {
          readonly id: string;
          readonly title: string;
          readonly path: string;
        }[]
      >)
    | undefined;
  /** Labels from the original current member directory; presentation, never a grant. */
  context?:
    | ((
        location: WorkspaceApprovalLocation,
        signal: AbortSignal,
      ) => Promise<{
        readonly accountName: string;
        readonly projectName: string;
      }>)
    | undefined;
  options(location: WorkspaceApprovalLocation, signal: AbortSignal): Promise<WorkspaceApprovalView>;
  approve(input: WorkspaceApprovalInput, signal: AbortSignal): Promise<WorkspaceApprovalRow>;
  revoke(input: WorkspaceRevokeInput, signal: AbortSignal): Promise<WorkspaceApprovalRow>;
  /** Uses the original SDK picker and registry only. It never creates an approval. */
  pickDirectory?: ((signal: AbortSignal) => Promise<string | null>) | undefined;
}
export type RegisterWorkspaceDirectory = (
  signal: AbortSignal,
  assertCurrentMember: () => Promise<void>,
) => Promise<string | null>;
function invalid(): never {
  throw new ExecutionError('validation', '工作目录数据已变化，请刷新后重试。');
}
function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : invalid();
}
function text(raw: unknown, max = 200): string {
  return typeof raw === 'string' && raw.length > 0 && raw.trim() === raw && raw.length <= max
    ? raw
    : invalid();
}
function count(raw: unknown, minimum = 0): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= minimum ? raw : invalid();
}
function items(raw: unknown, maximum: number): unknown[] {
  return Array.isArray(raw) && raw.length <= maximum ? raw : invalid();
}
function access(raw: unknown): 'read' | 'write' {
  return raw === 'read' || raw === 'write' ? raw : invalid();
}
function status(raw: unknown): 'approved' | 'revoked' {
  return raw === 'approved' || raw === 'revoked' ? raw : invalid();
}
export function workspacePublishRanges(raw: unknown): WorkspacePublishRange[] {
  const ranges = items(raw, 16).map((raw): WorkspacePublishRange => {
    const item = record(raw),
      path =
        typeof item.path === 'string' && item.path.length > 0 && item.path.length <= 512
          ? item.path
          : invalid();
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      /[\x00-\x1f\x7f]/u.test(path) ||
      /^[a-z]:/iu.test(path) ||
      path.includes('://') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      invalid();
    return {
      kind: item.kind === 'file' || item.kind === 'directory' ? item.kind : invalid(),
      path,
    };
  });
  if (
    new Set(ranges.map((item) => `${item.kind}:${item.path}`)).size !== ranges.length ||
    new TextEncoder().encode(JSON.stringify(ranges)).byteLength > 4096
  )
    invalid();
  return ranges;
}
function row(raw: unknown): WorkspaceApprovalRow {
  const item = record(raw),
    state = status(item.status);
  const ranges = workspacePublishRanges(item.publish);
  if (state === 'revoked' && (item.access !== null || ranges.length)) invalid();
  return {
    id: text(item.id),
    workspaceId: text(item.workspaceId),
    generation: count(item.generation, 1),
    status: state,
    access: state === 'revoked' ? null : access(item.access),
    publish: ranges,
  };
}
function view(raw: unknown): WorkspaceApprovalView {
  const item = record(raw);
  if (typeof item.available !== 'boolean') invalid();
  const directories = items(item.directories, 100).map((raw) => {
    const directory = record(raw);
    return {
      id: text(directory.id),
      title: text(directory.title, 160),
      path: text(directory.path, 4096),
      access: access(directory.access),
    };
  });
  const approvals = items(item.approvals, 100).map(row);
  if (
    new Set(directories.map((item) => item.id)).size !== directories.length ||
    new Set(approvals.map((item) => item.id)).size !== approvals.length ||
    new Set(approvals.map((item) => item.workspaceId)).size !== approvals.length
  )
    invalid();
  return { available: item.available, directories, approvals };
}
function requestId(raw: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(raw))
    invalid();
  return raw;
}
/** Member/account guards and exact same-origin transport are supplied by the
 * existing Run API. A returned directory/row is presentation, never IO authority. */
export function createWorkspaceApprovalApi(
  call: (
    endpoint: 'options' | 'approve' | 'revoke',
    payload: object,
    signal: AbortSignal,
  ) => Promise<unknown>,
  spaceId: string,
  pickDirectory?: WorkspaceApprovalApi['pickDirectory'],
): WorkspaceApprovalApi {
  const messages: Readonly<Record<string, string>> = {
    'workspace-approval-busy': '该目录仍有任务运行，请先停止并等待释放资源，再更新授权。',
    'workspace-approval-conflict': '授权版本或运行情况已变化，请刷新后重新确认。',
    'workspace-approval-source-changed': '目录或运行情况已变化，请刷新后重新确认。',
    'workspace-approval-recovery-required': '原运行尚未确认释放资源，请先完成停止或恢复处理。',
    'workspace-approval-cleanup-failed': '资源尚未释放，授权未修改，请稍后重试。',
    'workspace-policy-denied': '当前本机策略仅允许只读访问。',
    'workspace-directory-unavailable': '目录已移动或不可访问，请重新选择。',
    'workspace-approval-capacity': '目录授权数量或范围已达到上限，请先减少现有范围。',
    'workspace-approval-idempotency-mismatch': '重试内容已变化，请刷新后重新确认。',
  };
  async function request(
    endpoint: 'options' | 'approve' | 'revoke',
    payload: object,
    signal: AbortSignal,
  ) {
    try {
      return await call(endpoint, payload, signal);
    } catch (error) {
      if (error instanceof ExecutionError && Object.hasOwn(messages, error.code))
        throw new ExecutionError(error.code, messages[error.code]!);
      throw error;
    }
  }
  function location(raw: WorkspaceApprovalLocation): WorkspaceApprovalLocation {
    if (raw.spaceId !== spaceId) invalid();
    return { spaceId, projectId: text(raw.projectId) };
  }
  function mutation(raw: unknown, input: WorkspaceApprovalInput | WorkspaceRevokeInput) {
    const value = record(raw),
      receipt = record(value.receipt),
      current = row(value.current);
    const generation = count(receipt.generation, 1);
    if (
      !['applied', 'replayed'].includes(String(value.disposition)) ||
      receipt.requestId !== input.requestId ||
      receipt.expectedGeneration !== input.expectedGeneration ||
      generation !== input.expectedGeneration + 1 ||
      current.generation < generation ||
      status(receipt.status) !== ('workspaceId' in input ? 'approved' : 'revoked') ||
      ('workspaceId' in input
        ? current.workspaceId !== input.workspaceId
        : current.id !== input.approvalId)
    )
      invalid();
    return current;
  }
  return {
    options: async (input, signal) => view(await request('options', location(input), signal)),
    async approve(input, signal) {
      const payload = {
        ...location(input),
        requestId: requestId(input.requestId),
        workspaceId: text(input.workspaceId),
        expectedGeneration: count(input.expectedGeneration),
        access: access(input.access),
        publish: workspacePublishRanges(input.publish),
      };
      return mutation(await request('approve', payload, signal), payload);
    },
    async revoke(input, signal) {
      const payload = {
        ...location(input),
        requestId: requestId(input.requestId),
        approvalId: text(input.approvalId),
        expectedGeneration: count(input.expectedGeneration, 1),
      };
      return mutation(await request('revoke', payload, signal), payload);
    },
    ...(pickDirectory ? { pickDirectory } : {}),
  };
}
