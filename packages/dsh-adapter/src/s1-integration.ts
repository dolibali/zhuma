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
import type { ProjectSpaceDirectory } from './project-space.js';
import type { RevisionView } from './revision-view.js';
export type { ProjectSpaceDirectory, ProjectSpaceLookup } from './project-space.js';
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
/**
 * Declared return union of `identityAccessMode`. `unmounted` stays so this
 * declaration matches the identity export. Runtime does not infer it from a
 * missing resolver. An unset mode throws
 * `identity startup refused: deployment mode is not configured`.
 */
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
/**
 * Selected by `configureDeploymentMode` before `applyIdentity`.
 * `applyIdentity` reads `deploymentMode` before it opens the identity domain
 * and refuses to start when the mode is unset.
 */
export type DeploymentMode = 'legacy-single-user' | 'multi-member';
export type ConfigureDeploymentMode = (ctx: object, mode: DeploymentMode) => void;
export type ReadDeploymentMode = (ctx: object) => DeploymentMode | undefined;
/** Cordis `inject` for the execution plugin. */
export type ExecutionInject = readonly ['connection', 'storageDomain'];
/** A wraps `WorkbenchService.snapshot()` and passes that closure here. */
export interface ExecutionApplyOptions {
  readWorkbench(): Workbench;
  /** Omission rejects every project. The official catalog comes from A's Host/space module. */
  readonly projectSpaces?: ProjectSpaceDirectory;
}
export type ApplyExecution = (ctx: Context, options: ExecutionApplyOptions) => Promise<void>;
/** Host object passed to `applyExecution`. The plugin reads `readWorkbench` and calls `resolveMember`. */
export interface S1ExecutionOptions {
  readonly memberResolver: MemberResolver;
  readWorkbench(): Workbench;
  /** Omission rejects every project. The official catalog comes from A's Host/space module. */
  readonly projectSpaces?: ProjectSpaceDirectory;
}
export interface ApplyWorkbench {
  (ctx: Context): Promise<void>;
}
/** Functions A calls, in this order: mode, identity, resolver, workbench, execution, UI. */
export interface S1Startup {
  configureDeploymentMode: ConfigureDeploymentMode;
  deploymentMode: ReadDeploymentMode;
  applyIdentity: ApplyIdentity;
  memberResolver: CreateMemberResolver;
  applyWorkbench: ApplyWorkbench;
  applyExecution(ctx: Context, options: S1ExecutionOptions): Promise<void>;
  mount(props: ExecutionWorkspaceProps): unknown;
}
export type ExecutionEndpoints = readonly [
  'start-plan',
  'inbox',
  'submit',
  'ballot',
  'settle',
  'report',
  'revision',
  'draft',
  'inbox-counts',
  'events',
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
export interface RevisionRequest {
  taskId: string;
  planId: string;
  revision: number;
  nodeId: string;
}
export interface RevisionValue {
  readonly view: RevisionView;
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
  | 'files-not-accepted'
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
  | 'not-returned'
  | 'not-deliverable'
  | 'empty-request-changes'
  | 'empty-comment'
  | 'comment-not-unresolved'
  | 'validation'
  | 'unknown-field'
  | 'invalid-handoff'
  | 'cancelled';
/** Codes the service forwards when they are not in the message catalog. The wire `code` stays `string`. */
export type ExecutionPassthroughCode =
  | 'invalid-file'
  | 'invalid-link'
  | 'invalid-artifact'
  | 'invalid-history'
  | 'invalid-round'
  | 'invalid-ballot'
  | 'conflicting-ballot'
  | 'round-closed'
  | 'non-passing-availability'
  | 'illegal-transition'
  | 'child-task-required'
  | 'agent-not-identity'
  | 'expert-ref-required';
export type ExecutionErrorCode = ExecutionMessageCode | ExecutionPassthroughCode;
/** Fetch status. Business results stay inside HTTP 200. */
export type ExecutionTransportStatus = 200 | 400 | 401 | 403 | 408 | 413 | 415;
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
export interface InboxPlace {
  readonly itemId: string;
  readonly taskPath: string;
  readonly ownerName: string;
}
export interface InboxCounts {
  readonly deliver: number;
  readonly review: number;
  readonly confirm: number;
}
export interface EventsRequest {
  taskId: string;
  planId: string;
  revision: number;
  nodeId: string;
  after: number;
  seenEventIds?: readonly string[];
}
export interface ExecutionEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly type: string;
  readonly nodeId: string;
  readonly status: string;
  readonly version: number;
}
export interface EventsValue {
  readonly events: readonly ExecutionEvent[];
}
export interface ChannelInboxValue {
  readonly actorId: string;
  readonly items: readonly InboxItem[];
  readonly nodes: ExecutionChannelNode[];
  readonly places?: readonly InboxPlace[];
}
export interface ExecutionCommandValue {
  readonly disposition: 'applied' | 'replayed' | 'ignored';
  readonly report: NodeExecutionReport;
  readonly node: ExecutionChannelNode;
}
export interface ReportValue {
  readonly reports: NodeExecutionReport[];
}
export interface ReconcileValue {
  readonly unlocked: number;
}
export interface ExecutionCaller {
  readonly member?: MemberResolution;
}
export interface ExecutionServiceMethods {
  startPlan(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<StartPlanValue>>;
  inbox(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<ChannelInboxValue>>;
  inboxCounts(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<InboxCounts>>;
  events(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<EventsValue>>;
  submit(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<ExecutionCommandValue>>;
  ballot(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<ExecutionCommandValue>>;
  settle(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<ExecutionCommandValue>>;
  report(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<ReportValue>>;
  revision(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<RevisionValue>>;
  draft(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<SavedDeliveryDraft>>;
  reconcile(): Promise<ExecutionChannelResult<ReconcileValue>>;
}
export interface ExecutionRoutes {
  readonly 'start-plan': { readonly body: StartPlanRequest; readonly value: StartPlanValue };
  readonly inbox: { readonly body: InboxRequest; readonly value: ChannelInboxValue };
  readonly 'inbox-counts': { readonly body: InboxRequest; readonly value: InboxCounts };
  readonly events: { readonly body: EventsRequest; readonly value: EventsValue };
  readonly submit: { readonly body: SubmitRequest; readonly value: ExecutionCommandValue };
  readonly ballot: { readonly body: BallotRequest; readonly value: ExecutionCommandValue };
  readonly settle: { readonly body: SettleRequest; readonly value: ExecutionCommandValue };
  readonly report: { readonly body: ReportRequest; readonly value: ReportValue };
  readonly revision: { readonly body: RevisionRequest; readonly value: RevisionValue };
  readonly draft: {
    readonly body: RevisionRequest | DeliveryDraftWrite;
    readonly value: SavedDeliveryDraft;
  };
}
export interface SavedDeliveryDraft {
  readonly version: number;
  readonly text: string;
  readonly links: readonly string[];
  readonly files: readonly ArtifactFileRef[];
}
export interface DeliveryDraftWrite {
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
  readonly places?: readonly InboxPlace[];
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
  readonly action: 'approve' | 'request-changes' | 'comment';
  readonly comment?: string;
  readonly unresolvedCommentIds?: readonly string[];
}
export interface ExecutionApi {
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  inboxCounts(signal?: AbortSignal): Promise<InboxCounts>;
  events(query: EventsRequest, signal?: AbortSignal): Promise<EventsValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  revision(
    query: { taskId: string; planId: string; revision: number; nodeId: string },
    signal?: AbortSignal,
  ): Promise<RevisionView>;
  readDeliveryDraft(
    query: { taskId: string; planId: string; revision: number; nodeId: string },
    signal?: AbortSignal,
  ): Promise<SavedDeliveryDraft>;
  saveDeliveryDraft(draft: DeliveryDraftWrite, signal?: AbortSignal): Promise<SavedDeliveryDraft>;
}
export type CreateExecutionApi = (rpc: ClientConnectionRpc) => ExecutionApi;
export interface ExecutionWorkspaceProps {
  api: ExecutionApi;
}
export interface InboxPanelProps {
  items: readonly InboxItem[];
  nodes: readonly ExecutionNodeWire[];
  places?: readonly InboxPlace[];
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
