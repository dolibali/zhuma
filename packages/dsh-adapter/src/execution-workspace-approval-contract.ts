import { z } from 'zod';
import type { MemberRequest } from './member-session.js';
import type { ExecutionWorkspace } from './execution-run-state.js';
import type { NativeWorkScope } from './native-work-session-contract.js';
import { outputRelativePath } from './native-work-session-output-file-source.js';

export const WORKSPACE_APPROVAL_LIMITS = Object.freeze({
  approvals: 100,
  concurrent: 8,
  requestBytes: 8192,
  stateBytes: 262144,
  publish: 16,
  publishBytes: 4096,
  receipts: 16,
  revokeReserveBytes: 512,
  observedRuns: 4096,
});
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const range = z.strictObject({
  kind: z.enum(['file', 'directory']),
  path: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => {
      try {
        return outputRelativePath(value) === value;
      } catch {
        return false;
      }
    }),
});
export const workspaceApprovalPolicySchema = z
  .strictObject({
    access: z.enum(['read', 'write']),
    publish: z.array(range).max(WORKSPACE_APPROVAL_LIMITS.publish),
  })
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value.publish)) <= WORKSPACE_APPROVAL_LIMITS.publishBytes,
  )
  .refine(
    (value) =>
      new Set(value.publish.map((item) => `${item.kind}:${item.path}`)).size ===
      value.publish.length,
  );
export type WorkspaceApprovalPolicy = z.infer<typeof workspaceApprovalPolicySchema>;
export const workspaceApprovalIdentitySchema = z.strictObject({
  workspaceId: id,
  createdAt: z.string().min(1).max(100),
  pathFingerprint: digest,
});
export type WorkspaceApprovalIdentity = z.infer<typeof workspaceApprovalIdentitySchema>;
const scope = { spaceId: id, projectId: id };
export const workspaceApprovalCommandSchema = z
  .discriminatedUnion('operation', [
    workspaceApprovalPolicySchema.safeExtend({
      operation: z.literal('approve'),
      ...scope,
      requestId: z.uuid(),
      workspaceId: id,
      expectedGeneration: natural,
    }),
    z.strictObject({
      operation: z.literal('revoke'),
      ...scope,
      requestId: z.uuid(),
      approvalId: id,
      expectedGeneration: natural.positive(),
    }),
  ])
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= WORKSPACE_APPROVAL_LIMITS.requestBytes,
  );
export type WorkspaceApprovalCommand = z.infer<typeof workspaceApprovalCommandSchema>;
export const workspaceApprovalReceiptSchema = z.strictObject({
  requestId: z.uuid(),
  fingerprint: digest,
  expectedGeneration: natural,
  generation: natural.positive(),
  status: z.enum(['approved', 'revoked']),
});
export type WorkspaceApprovalReceipt = z.infer<typeof workspaceApprovalReceiptSchema>;
export const workspaceApprovalRowSchema = z
  .strictObject({
    id,
    actorId: id,
    ...scope,
    identity: workspaceApprovalIdentitySchema,
    generation: natural.positive(),
    status: z.enum(['approved', 'revoked']),
    policy: workspaceApprovalPolicySchema.optional(),
    receipts: z
      .array(workspaceApprovalReceiptSchema)
      .min(1)
      .max(WORKSPACE_APPROVAL_LIMITS.receipts),
  })
  .superRefine((value, context) => {
    if (
      (value.status === 'approved') !== (value.policy !== undefined) ||
      (value.status === 'approved' && value.generation >= Number.MAX_SAFE_INTEGER) ||
      new Set(value.receipts.map((item) => item.requestId)).size !== value.receipts.length ||
      value.receipts.some(
        (item) =>
          item.generation !== item.expectedGeneration + 1 || item.generation > value.generation,
      ) ||
      value.receipts.at(-1)?.generation !== value.generation ||
      value.receipts.at(-1)?.status !== value.status
    )
      context.addIssue({ code: 'custom', message: 'Invalid workspace approval state.' });
  });
export type WorkspaceApprovalRow = z.infer<typeof workspaceApprovalRowSchema>;
export const workspaceApprovalStateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    deviceId: z.uuid(),
    approvals: z.array(workspaceApprovalRowSchema).min(1).max(WORKSPACE_APPROVAL_LIMITS.approvals),
  })
  .refine(
    (value) => new Set(value.approvals.map((item) => item.id)).size === value.approvals.length,
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= WORKSPACE_APPROVAL_LIMITS.stateBytes,
  );
export type WorkspaceApprovalState = z.infer<typeof workspaceApprovalStateSchema>;
export interface WorkspaceApprovalRun {
  readonly scope: NativeWorkScope;
  readonly workspace: Extract<ExecutionWorkspace, { kind: 'local' }>;
  readonly resources: 'held' | 'settled';
  readonly nativeSessionId?: string;
  readonly nativeAgentId?: string;
}
export interface WorkspaceApprovalPreparation {
  readonly actorId: string;
  readonly command: WorkspaceApprovalCommand;
  readonly existing: WorkspaceApprovalRow | undefined;
  readonly snapshot: WorkspaceApprovalState | undefined;
  readonly runs: readonly WorkspaceApprovalRun[];
  readonly commandFingerprint: string;
}
/** Installed once by A's real SDK owner. These methods/objects never arrive
 * from an HTTP/member JSON body; D itself invokes and retains this producer. */
export interface WorkspaceApprovalQualification {
  readonly commandFingerprint: string;
  readonly identity?: WorkspaceApprovalIdentity;
  /** A must resolve actual canonical roots and nested overlap. Unknown roots
   * refuse qualification; an empty set cannot substitute for that check. */
  readonly conflictingRunScopes: readonly NativeWorkScope[];
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  release(): void;
}
export interface WorkspaceApprovalHostSource {
  readonly signal: AbortSignal;
  prepare(
    original: MemberRequest,
    input: WorkspaceApprovalPreparation,
    wait: AbortSignal,
  ): Promise<WorkspaceApprovalQualification>;
}
export interface WorkspaceApprovalMutation {
  readonly disposition: 'applied' | 'replayed';
  readonly receipt: WorkspaceApprovalReceipt;
  /** Always the latest state, including a newer revocation on an old replay. */
  readonly current: WorkspaceApprovalRow;
}
export interface WorkspaceApprovalResult<T> {
  readonly ok: true;
  readonly value: T;
}
export type WorkspaceApprovalOutcome<T> =
  | WorkspaceApprovalResult<T>
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };
/** Private A owner handle. snapshot is metadata only and must never be exposed
 * as a member-granted IO capability or included wholesale in a public DTO. */
export interface WorkspaceApprovalOwner {
  list(
    original: MemberRequest,
    scope: { spaceId: string; projectId: string },
    wait?: AbortSignal,
  ): Promise<WorkspaceApprovalOutcome<readonly WorkspaceApprovalRow[]>>;
  approve(
    original: MemberRequest,
    command: Omit<Extract<WorkspaceApprovalCommand, { operation: 'approve' }>, 'operation'>,
    wait?: AbortSignal,
  ): Promise<WorkspaceApprovalOutcome<WorkspaceApprovalMutation>>;
  revoke(
    original: MemberRequest,
    command: Omit<Extract<WorkspaceApprovalCommand, { operation: 'revoke' }>, 'operation'>,
    wait?: AbortSignal,
  ): Promise<WorkspaceApprovalOutcome<WorkspaceApprovalMutation>>;
  snapshot(): {
    readonly state: WorkspaceApprovalState | undefined;
    readonly runs: readonly WorkspaceApprovalRun[];
  };
  onChange(listener: () => void): () => void;
}
export class WorkspaceApprovalError extends Error {
  constructor(readonly code: string) {
    super('工作区授权操作未完成。');
    this.name = 'WorkspaceApprovalError';
  }
}
