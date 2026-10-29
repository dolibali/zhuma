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
import type { OpenedSpaceDirectoryHandle, SpaceDirectoryImport } from './space-directory.js';
import type { RevisionView } from './revision-view.js';
import type { ExecutionPluginConfig } from './execution-plugin.js';
import type {
  ProjectArtifactsRequest,
  ProjectArtifactsValue,
} from './execution-project-artifacts-contract.js';
import type { TaskProgressValue } from './execution-task-progress-contract.js';
export type {
  TaskProgressTarget,
  TaskProgressQuery,
  TaskProgressResources,
  TaskProgressRow,
  TaskProgressValue,
  TaskProgressUnknownReason,
} from './execution-task-progress-contract.js';
import type {
  ExecutionFileAuthority,
  ExecutionFileAuthoritySource,
  AuthorizedFileContent,
} from './execution-service.js';
export type { ExecutionFileAuthority, ExecutionFileAuthoritySource } from './execution-service.js';
export type {
  FileContentInfo,
  FileContentRequest,
  AuthorizedFileContent,
} from './execution-service.js';
export type { ProjectSpaceDirectory, ProjectSpaceLookup } from './project-space.js';
export type {
  AuthorizedSpace,
  OpenedSpaceDirectoryHandle,
  SpaceDirectory,
  SpaceDirectoryImport,
  SpaceDirectoryWriter,
  SpaceKind,
} from './space-directory.js';
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
/**
 * The trusted space directory from #29. `applySpaceDirectory` mounts it on the
 * host root before `applyIdentity`; `spaceDirectoryFor` reads the mounted
 * handle, including the writer side the host owns. The mount returns nothing
 * because cordis treats a plugin `apply` result as an effect.
 */
export type ApplySpaceDirectory = (ctx: Context, imported?: SpaceDirectoryImport) => Promise<void>;
export type SpaceDirectoryFor = (ctx: object) => OpenedSpaceDirectoryHandle | undefined;
/** Cordis `inject` for the execution plugin. */
export type ExecutionInject = readonly ['connection', 'storageDomain'];
/**
 * Parameters `apply` reads. `readWorkbench` is required.
 * `projectSpaces` is optional; omission rejects every project.
 * B delivered the formal catalog on #29 (`applySpaceDirectory`); A only
 * injects that directory at the Host.
 */
export interface ExecutionApplyOptions {
  readWorkbench(): Workbench;
  readonly projectSpaces?: ProjectSpaceDirectory;
  publishRunService?: NonNullable<ExecutionPluginConfig['publishRunService']>;
}
export type ApplyExecution = (ctx: Context, options: ExecutionApplyOptions) => Promise<void>;
/**
 * Object passed to `applyExecution`. Same fields as `ExecutionApplyOptions`.
 * `memberResolver` is not a field; each request calls `resolveMember`.
 */
export type S1ExecutionOptions = ExecutionApplyOptions;
export interface ApplyWorkbench {
  (ctx: Context): Promise<void>;
}
/**
 * Functions A calls, in this order: mode, spaces, identity, resolver,
 * workbench, execution, UI. The space directory mounts before identity so the
 * member resolver enumerates trusted spaces from the start; mounting it later
 * also works because consumers resolve the directory lazily per call.
 * `memberResolver(ctx)` stays available for other callers. `applyExecution`
 * does not take it.
 */
export interface S1Startup {
  configureDeploymentMode: ConfigureDeploymentMode;
  deploymentMode: ReadDeploymentMode;
  applySpaceDirectory: ApplySpaceDirectory;
  applyIdentity: ApplyIdentity;
  memberResolver: CreateMemberResolver;
  applyWorkbench: ApplyWorkbench;
  applyExecution(ctx: Context, options: S1ExecutionOptions): Promise<void>;
  mount(props: ExecutionWorkspaceProps): unknown;
}
export type ExecutionEndpoints = readonly [
  'start-plan',
  'inbox',
  'startable',
  'submit',
  'ballot',
  'settle',
  'report',
  'revision',
  'review-outcome',
  'draft',
  'upstream-content',
  'project-artifacts',
  'task-progress',
  'inbox-counts',
  'events',
];
export interface StartPlanRequest {
  taskId: string;
  planId: string;
  revision: number;
  idempotencyKey: string;
  /** Chosen space constraint; re-checked against the plan's owning space before replay. */
  spaceId?: string | undefined;
}
export interface InboxRequest {
  /** Chosen space constraint; a filter the member must currently hold, never a grant. */
  readonly spaceId?: string | undefined;
}
/** Read-only discovery of confirmed plans the member may explicitly start. */
export interface StartableRequest {
  readonly spaceId?: string | undefined;
}
export interface ReportRequest {
  taskId: string;
  planId: string;
  revision: number;
  readonly spaceId?: string | undefined;
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
  | 'file-too-large'
  | 'quota-exceeded'
  | 'digest-mismatch'
  | 'upload-timeout'
  | 'file-timeout'
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
  readonly actorId: string;
  /** Echoes the requested scope. Absent when the caller did not send one. */
  readonly spaceId?: string | undefined;
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
  /** Chosen space constraint; checked against the task's owning space before the node is read. */
  readonly spaceId?: string | undefined;
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
  readonly actorId: string;
  /** Echoes the requested scope. Absent when the caller did not send one. */
  readonly spaceId?: string | undefined;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly events: readonly ExecutionEvent[];
}
/** Pinned upstream input content query: full downstream location, source, pinned version. */
export interface UpstreamContentRequest {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly sourceNodeId: string;
  readonly artifactVersionId: string;
  /** Required: a member holding two spaces must name the current one. */
  readonly spaceId: string;
}
export interface UpstreamContentValue {
  readonly actorId: string;
  readonly spaceId: string;
  /** Full downstream location echo so the caller can verify the correlation. */
  readonly downstream: {
    readonly nodeId: string;
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
  };
  readonly source: {
    readonly nodeId: string;
    readonly taskId: string;
    readonly planId: string;
    readonly revision: number;
  };
  readonly version: { readonly id: string; readonly version: number };
  readonly content: {
    readonly text?: string;
    readonly links: readonly string[];
    readonly files: readonly ArtifactFileRef[];
  };
}

/** File upload: declarations ride headers, the body is the byte stream. */
export interface UploadFileDeclare {
  readonly name: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
export interface UploadFileOptions {
  readonly declare: UploadFileDeclare;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly spaceId: string;
  readonly idempotencyKey: string;
  readonly data: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}
export interface FileUploadReceiptValue {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reference: ArtifactFileRef;
}

export interface ChannelInboxValue {
  readonly actorId: string;
  /** Echoes the requested scope so the caller can verify the answer matches. */
  readonly spaceId?: string | undefined;
  readonly items: readonly InboxItem[];
  readonly nodes: ExecutionChannelNode[];
  readonly places?: readonly InboxPlace[];
}
/** One confirmed, not-yet-started plan the member may explicitly start. */
export interface StartablePlan {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
}
export interface ChannelStartableValue {
  readonly actorId: string;
  readonly spaceId?: string | undefined;
  readonly plans: readonly StartablePlan[];
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
  fileContent(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionChannelResult<AuthorizedFileContent>>;
  startPlan(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<StartPlanValue>>;
  inbox(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<ChannelInboxValue>>;
  startable(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<ChannelStartableValue>>;
  inboxCounts(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<InboxCounts>>;
  events(caller: ExecutionCaller, body: unknown): Promise<ExecutionChannelResult<EventsValue>>;
  submit(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
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
  upstreamContent(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionChannelResult<UpstreamContentValue>>;
  projectArtifacts(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionChannelResult<ProjectArtifactsValue>>;
  taskProgress(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionChannelResult<TaskProgressValue>>;
  /** Raw byte upload rides headers + a byte stream, never the JSON envelope. */
  uploadFile(
    caller: ExecutionCaller,
    options: UploadFileOptions,
    authority: ExecutionFileAuthority,
  ): Promise<ExecutionChannelResult<FileUploadReceiptValue>>;
  draft(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionChannelResult<SavedDeliveryDraft>>;
  reconcile(): Promise<ExecutionChannelResult<ReconcileValue>>;
}
export interface ExecutionRoutes {
  readonly 'start-plan': { readonly body: StartPlanRequest; readonly value: StartPlanValue };
  readonly inbox: { readonly body: InboxRequest; readonly value: ChannelInboxValue };
  readonly startable: { readonly body: StartableRequest; readonly value: ChannelStartableValue };
  readonly 'inbox-counts': { readonly body: InboxRequest; readonly value: InboxCounts };
  readonly events: { readonly body: EventsRequest; readonly value: EventsValue };
  readonly submit: { readonly body: SubmitRequest; readonly value: ExecutionCommandValue };
  readonly ballot: { readonly body: BallotRequest; readonly value: ExecutionCommandValue };
  readonly settle: { readonly body: SettleRequest; readonly value: ExecutionCommandValue };
  readonly report: { readonly body: ReportRequest; readonly value: ReportValue };
  readonly revision: { readonly body: RevisionRequest; readonly value: RevisionValue };
  readonly 'upstream-content': {
    readonly body: UpstreamContentRequest;
    readonly value: UpstreamContentValue;
  };
  readonly 'project-artifacts': {
    readonly body: ProjectArtifactsRequest;
    readonly value: ProjectArtifactsValue;
  };
  readonly 'task-progress': {
    readonly body: import('./execution-task-progress-contract.js').TaskProgressQuery;
    readonly value: TaskProgressValue;
  };
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
  readonly fileDetails?: readonly { readonly id: string; readonly name: string }[];
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
/**
 * Wire value of the `startable` route. The Client-side `ExecutionApi` method
 * consumes this authoritative projection on #32; the declaration does not
 * move discovery or authorization into the Client.
 */
export interface ExecutionStartableValue {
  readonly actorId: string;
  readonly plans: readonly StartablePlan[];
}
export interface ExecutionApi {
  startable(signal?: AbortSignal): Promise<ExecutionStartableValue>;
  startPlan(draft: StartPlanRequest, signal?: AbortSignal): Promise<StartPlanValue>;
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  // Client-side `startable` / `inboxCounts` / `events` / `revision` /
  // delivery-draft methods are added by A on #32 when the panels consume
  // them; this layer declares the route shapes only.
}
export type CreateExecutionApi = (rpc: ClientConnectionRpc) => ExecutionApi;
export interface ExecutionWorkspaceProps {
  api: ExecutionApi;
  refreshKey?: number;
  plan?: Omit<StartPlanRequest, 'idempotencyKey'> & { readonly title: string };
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
