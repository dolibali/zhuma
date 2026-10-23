/**
 * Compilable S1 signatures for A-INTEGRATE-S1.
 * Identity matches b/id0a-identity. Execution and UI match this branch.
 * `readWorkbench` is only the closure A passes; this module does not open the workbench.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { Context } from '@deepseek-ai/cordis';
import type {
  ArtifactFileRef,
  ExecutionNodeRecord,
  InboxItem,
  NodeExecutionReport,
  NodeStatus,
  Workbench,
} from '@zhuma/agent-core';
export interface MemberRequest {
  readonly headers: IncomingHttpHeaders;
}
export interface ResolvedMember {
  readonly memberId: string;
  readonly spaceIds: readonly string[];
}
export type MemberRejection =
  | { readonly ok: false; readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly ok: false; readonly status: 403; readonly code: 'untrusted-request' };
export type MemberResolution = ({ readonly ok: true } & ResolvedMember) | MemberRejection;
export interface MemberResolver {
  resolve(request: MemberRequest): Promise<MemberResolution>;
}
export type IdentityAccessMode = 'unmounted' | 'single-user' | 'multi-member';
/** `passwordHash` is a scrypt verifier, never a password. */
export interface IdentityImport {
  readonly accounts: readonly { readonly id: string; readonly passwordHash: string }[];
  readonly ownerAccountId?: string;
  readonly notes?: readonly {
    readonly id: string;
    readonly spaceId: string;
    readonly ownerId: string;
    readonly teamMemberIds: readonly string[];
    readonly text: string;
  }[];
}
export type ResolveMember = (ctx: object, request: MemberRequest) => Promise<MemberResolution>;
export type CreateMemberResolver = (ctx: object) => MemberResolver;
export type IdentityAccessModeFn = (ctx: object) => IdentityAccessMode;
export type ApplyIdentity = (ctx: Context, imported?: IdentityImport) => Promise<void>;
/** A wraps `WorkbenchService.snapshot()` and passes that closure here. */
export interface ExecutionApplyOptions {
  readWorkbench(): Workbench;
}
export type ApplyExecution = (ctx: Context, options: ExecutionApplyOptions) => Promise<void>;
export type ExecutionEndpoints = readonly [
  'start-plan',
  'inbox',
  'submit',
  'ballot',
  'settle',
  'report',
];
export interface StartPlanRequest {
  taskId: string;
  planId: string;
  revision: number;
  idempotencyKey: string;
}
export type InboxRequest = Record<string, never>;
export interface ReportRequest {
  taskId: string;
  planId: string;
  revision: number;
}
interface ExecutionLocate {
  taskId: string;
  planId: string;
  revision: number;
  nodeId: string;
  expectedVersion: number;
  idempotencyKey: string;
}
export interface SubmitRequest extends ExecutionLocate {
  text?: string | undefined;
  files?: ArtifactFileRef[] | undefined;
  links?: string[] | undefined;
}
export interface BallotRequest extends ExecutionLocate {
  roundId: string;
  artifactVersionId: string;
  action: 'approve' | 'request-changes' | 'comment';
  comment?: string | undefined;
  unresolvedCommentIds?: string[] | undefined;
}
export interface SettleRequest extends ExecutionLocate {
  roundId: string;
  artifactVersionId: string;
}
export interface ExecutionChannelFailure {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}
export type ExecutionChannelResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExecutionChannelFailure };
export type ExecutionMessageCode =
  | 'actor-from-body'
  | 'unauthenticated'
  | 'untrusted-request'
  | 'not-assignee'
  | 'not-assigned-reviewer'
  | 'actor-mismatch'
  | 'upload-incomplete'
  | 'empty-delivery'
  | 'conflict'
  | 'idempotency-mismatch'
  | 'plan-not-found'
  | 'plan-reference-required'
  | 'stale-round'
  | 'stale-version'
  | 'voided-round'
  | 'not-in-directory'
  | 'not-participant'
  | 'plan-incomplete'
  | 'unavailable'
  | 'not-found'
  | 'validation'
  | 'unknown-field'
  | 'invalid-handoff'
  | 'cancelled';
export interface ExecutionChannelNode {
  readonly nodeId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly version: number;
  readonly status: NodeExecutionReport['status'];
  readonly goal: string;
  readonly expectedOutput: string;
  readonly assigneeId: string;
  readonly assigneeKind: 'human' | 'expert';
  readonly reviewerIds: readonly string[];
  readonly ownerId: string | null;
  readonly rounds: ExecutionNodeRecord['rounds'];
  readonly artifacts: ExecutionNodeRecord['artifactVersions'];
  readonly comments: ExecutionNodeRecord['comments'];
  readonly entryStatus?: 'ready' | 'needs-revision';
  readonly currentRoundId?: string;
  readonly acceptedArtifactVersionId?: string;
  readonly reviewOutcome?: NodeExecutionReport['reviewOutcome'];
  readonly blockReason?: string;
}
export interface StartPlanValue {
  readonly disposition: string;
  readonly reports: NodeExecutionReport[];
}
export interface ChannelInboxValue {
  readonly actorId: string;
  readonly items: readonly InboxItem[];
  readonly nodes: ExecutionChannelNode[];
}
export interface ExecutionCommandValue {
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly report: NodeExecutionReport;
  readonly node: ExecutionChannelNode;
}
export interface ReportValue {
  readonly reports: NodeExecutionReport[];
}
export interface ExecutionArtifactWire {
  readonly id: string;
  readonly version: number;
  readonly text?: string;
}
export interface ExecutionBallotWire {
  readonly reviewerId: string;
  readonly action: string;
  readonly comment?: string;
}
export interface ExecutionRoundWire {
  readonly id: string;
  readonly status: string;
  readonly artifactVersionId: string;
  readonly reviewerIds: readonly string[];
  readonly ballots: readonly ExecutionBallotWire[];
}
export interface ExecutionNodeWire {
  readonly nodeId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly version: number;
  readonly status: NodeStatus;
  readonly goal: string;
  readonly expectedOutput: string;
  readonly assigneeId: string;
  readonly reviewerIds: readonly string[];
  readonly currentRoundId?: string;
  readonly artifacts: readonly ExecutionArtifactWire[];
  readonly rounds: readonly ExecutionRoundWire[];
  readonly comments: readonly { readonly id: string; readonly status: string }[];
  readonly reviewOutcome?: string;
  readonly blockReason?: string;
  readonly acceptedArtifactVersionId?: string;
}
export interface ExecutionInboxValue {
  readonly actorId: string;
  readonly items: readonly InboxItem[];
  readonly nodes: readonly ExecutionNodeWire[];
}
export interface DeliveryDraft {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly text?: string;
  readonly files?: readonly ArtifactFileRef[];
  readonly links?: readonly string[];
}
export interface ReviewDraft {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly roundId: string;
  readonly artifactVersionId: string;
  readonly action: 'approve' | 'request-changes';
  readonly comment?: string;
}
export interface ExecutionApi {
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
}
export type CreateExecutionApi = (rpc: ClientConnectionRpc) => ExecutionApi;
export interface ExecutionWorkspaceProps {
  api: ExecutionApi;
}
export interface InboxPanelProps {
  items: readonly InboxItem[];
  nodes: readonly ExecutionNodeWire[];
  error?: string;
  pending?: boolean;
  reload(): void;
  open(item: InboxItem): void;
}
export interface DeliveryPanelProps {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  onSubmitted(node: ExecutionNodeWire): void;
}
export interface ReviewWorkspaceProps {
  api: ExecutionApi;
  node: ExecutionNodeWire;
  onSubmitted(node: ExecutionNodeWire): void;
}
