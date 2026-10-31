import { createHash, randomUUID } from 'node:crypto';
import type {
  RemoteReviewAuthorities,
  RemoteReviewTargetGrant,
} from './remote-review-authority.js';
import { describeNativeReviewTool } from './native-work-session-review-tool.js';
import { describeNativeReviewReadTool } from './native-work-session-review-read.js';
import { RemoteRunAuthorities, RemoteRunError } from './remote-run-authority.js';
import type { RemoteRunFileGrant, RemoteRunUpload } from './remote-run-files.js';
import type {
  ExecutionOutputFileGrant,
  ExecutionOutputFileIssuer,
  ExecutionOutputFileResources,
  ExecutionOutputFilePort,
} from './execution-output-file-port.js';
import { freezeExecutionRunComposition } from './execution-run-composition.js';
import { describeNativeResultTool } from './native-work-session-result-tool.js';
import { describeNativeResultPublicationsTool } from './native-work-session-result-publications-tool.js';
import { describeAcceptedInputTool } from './native-work-session-input-tool.js';
import { describeMemberKnowledgeTool } from './member-knowledge-tool.js';
import { describeTeamAssetFileTool } from './team-asset-file-tool.js';
import type { RemoteTeamAssetFileReadGrant } from './remote-team-asset-file-authority.js';
import { z } from 'zod';
import {
  canonicalPayload,
  remoteWorkflowRefSchema,
  remoteWorkflowIntentSchema,
  localReviewOptionsQuerySchema,
  localReviewOptionsSchema,
  localReviewUnavailableReasonSchema,
  type LocalReviewOptions,
  type RemoteWorkflowIntent,
  type KnowledgeProjectSnapshot,
  type MemberAssetFileSnapshotValue,
  type MemberAssetFileSnapshotQuery,
  type MemberAssetReference,
  type MemberAssetReferenceValue,
  type RemoteWorkflowCandidate,
  reviewOutcomeQuerySchema,
  reviewOutcomeSchema,
  type ReviewOutcomeView,
  completionSource,
  createExecutionHandoff,
  createNodeHandoffs,
  downstreamRecords,
  eventsAfter,
  executionInbox,
  nodeRecordKey,
  recordCommandEvent,
  settleReview,
  startAppliedPlan,
  submitDelivery,
  submitExpertDelivery,
  submitExpertManifestDelivery,
  type ArtifactDraft,
  toNodeExecutionReport,
  unlockDownstream,
  unlockKey,
  castBallot,
  WorkbenchError,
  WorkTaskSchema,
  type ArtifactFileRef,
  type DomainEvent,
  type ExecutionNodeRecord,
  type InboxItem,
  type NodeExecutionReport,
  type Workbench,
} from '@zhuma/agent-core';
import { resolveActor, scanActorField, type MemberResolution } from './execution-identity.js';
import {
  decideProjectSpace,
  type ProjectSpaceDirectory,
  type ProjectSpaceLookup,
} from './project-space.js';
import { readRevisionView, type RevisionView } from './revision-view.js';
import {
  applyDeliveryDraft,
  deliveryDraftView,
  draftFiles,
  withoutDeliveryDraft,
  type DeliveryDraftView,
} from './delivery-draft.js';
import {
  upstreamBlockMessage,
  upstreamInputsFor,
  type UpstreamInputView,
} from './upstream-inputs.js';
import type { MemberRequest } from './member-session.js';
import type { MemberWorkbenchDirectory } from './member-workbench-dto.js';
import {
  taskProgressQuerySchema,
  type TaskProgressValue,
} from './execution-task-progress-contract.js';
import {
  selectTaskProgress,
  taskProgressProjects,
  taskProgressProjection,
} from './execution-task-progress.js';
import type {
  NativeWorkGrant,
  NativeWorkAction,
  NativeMigrationDrain,
} from './native-work-session-contract.js';
import type {
  NativeFixedResultIssuer,
  NativeFixedResultPublicationsIssuer,
} from './native-work-session-result.js';
import type {
  NativeFixedResultPublicationsLease,
  NativePublicationManifestEntry,
} from './native-work-session-result-publications-contract.js';
import { NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION } from './native-work-session-result-publications-contract.js';
import {
  NativeResultError,
  nativeResultContentSchema,
  type NativeFixedResultRef,
  type NativeFixedResultLease,
} from './native-work-session-result-contract.js';
import { nativeResultDigest } from './native-work-session-result-source.js';
import {
  executionNativeResultDeliverySchema,
  executionNativeResultDeliveryV1Schema,
  nativeResultPublicationsProofSchema,
  nativeManifestContentSchema,
  nativeManifestResultDigest,
  readNativeResultManifest,
  nativeResultManifestRecords,
  nativeResultSubmitSchema,
  nativeResultConfirmSchema,
  nativeResultArtifactIds,
  nativeResultProvenance,
  nativeResultDeliveryReceipt,
  NativeResultDeliveryError,
  type NativeResultSubmit,
  type NativeResultConfirm,
  type NativeResultDeliveryReceipt,
} from './execution-native-result-delivery.js';
import {
  runFileListSchema,
  runFileReadSchema,
  runFileEncoding,
  NATIVE_ACCEPTED_FILE_TOOL,
  type NativeRunAcceptedFiles,
  type NativeRunFileResourceSource,
  type NativeRunFileInfo,
  type NativeRunFileSource,
} from './native-work-session-files-contract.js';
import { describeNativeAcceptedFileTool } from './native-work-session-files-tool.js';
import type {
  ExecutionAcceptedFileGrant,
  ExecutionAcceptedFilePort,
} from './execution-accepted-file-port.js';
import {
  executionRunCompositionSchema,
  readExecutionRunComposition,
  assertExecutionRunComposition,
  ExecutionRunCompositionError,
  type ExecutionRunCompositionInput,
  type FrozenExecutionRunComposition,
  type ExecutionCompositionTools,
} from './execution-run-composition.js';
import {
  withExecutionRunResourceQualification,
  ExecutionRunResourceQualificationCloseError,
  type ExecutionRunResourceCatalogHost,
  type ExecutionRunResourceVerification,
} from './execution-run-resource-qualification.js';
import {
  ExecutionRunAuthorities,
  type ExecutionMemberLease,
  type ExecutionRunAuthoritySource,
  type ExecutionRunCleanupAuthority,
  type ExecutionRunLocator,
} from './execution-run-authority.js';
import {
  assertExecutionRunQuiescent,
  beginExecutionRun,
  beginExecutionRunSchema,
  currentExecutionRun,
  isExecutionRunRevisionStart,
  ExecutionRunError,
  executionRunScope,
  readExecutionRunState,
  recordExecutionRunEvent,
  requestExecutionRunStop,
  validateExecutionRunBegin,
  stopExecutionRunSchema,
  withExecutionRunState,
  type ExecutionRunDecision,
  type ExecutionRunEvent,
} from './execution-run-state.js';
import {
  assertExecutionRunStoreCompatibility,
  enableExecutionRunWriter,
  ExecutionRunProtocolError,
  executionRunGlobalSchema,
  requireExecutionRunWriter,
  enableExecutionReviewWriter,
  requireExecutionReviewWriter,
  requireWorkspaceApprovalWriter,
  enableWorkspaceApprovalWriter,
  type ExecutionWriterGlobal,
} from './execution-run-protocol.js';
import {
  ExecutionReviewError,
  executionReviewTargetSchema,
  executionReviewScopeSchema,
  type ExecutionReviewAttempt,
  type ExecutionReviewTarget,
  type ExecutionReviewScope,
} from './execution-review-contract.js';
import {
  executionReviewTarget,
  executionReviewArtifactFingerprint,
  prepareExecutionReview,
  readExecutionReviewState,
} from './execution-review-state.js';
import {
  ExecutionReviewReadAuthorities,
  ExecutionReviewReadError,
  type ExecutionReviewReadGrant,
  type ExecutionReviewReadLocator,
  type OpenedExecutionReviewRead,
} from './execution-review-read-authority.js';
import {
  reviewTargetReadSchema,
  reviewTargetResources,
  reviewFileResourceRef,
  type ExecutionReviewResource,
  type ExecutionReviewTargetReadLease,
} from './execution-review-target-reader.js';
import {
  freezeExecutionReviewComposition,
  readExecutionReviewComposition,
  executionReviewCompositionRequest,
  type ExecutionReviewPreparation,
  type FrozenExecutionReviewComposition,
} from './execution-review-composition.js';
import { admitExecutionReview, recordExecutionReviewEvent } from './execution-review-lifecycle.js';
import type {
  ExecutionReviewNativePorts,
  ExecutionReviewNativeOutcome,
} from './execution-review-native-port.js';
import {
  ExecutionReviewFixedResultError,
  commitExecutionReviewFixedResult,
  readExecutionReviewFixedReceipt,
  readExecutionReviewFailure,
  recordExecutionReviewFailure,
  type ExecutionReviewFailure,
  type ExecutionReviewFixedFacts,
} from './execution-review-fixed-result.js';
import {
  NativeReviewError,
  type NativeFixedReviewLease,
} from './native-work-session-review-contract.js';
import {
  ExecutionReviewDriveAuthorities,
  type ExecutionReviewDriveGrant,
  type ExecutionReviewCleanupAuthority,
  type OpenedExecutionReviewDrive,
} from './execution-review-drive-authority.js';
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  ARTIFACT_FILE_LIMITS,
  artifactUploadOptionsSchema,
  ArtifactUploadError,
  ArtifactUploadStream,
  artifactFileReference,
  matchesArtifactFileReference,
  readVerifiedArtifactFile,
  artifactFileLeaf,
  nativeOutputFileSourceSchema,
  type ArtifactFileStore,
  type ArtifactFileUploadDeclare,
  type FileUploadReceipt,
  type UploadFileRecord,
} from './artifact-files.js';
import type {
  NativeRunOutputFiles,
  NativeOutputFileResourceSource,
  NativeOutputFileReservation,
} from './native-work-session-output-file-contract.js';
import {
  describeNativeOutputFileTool,
  NATIVE_OUTPUT_FILE_TOOL,
} from './native-work-session-output-file-tool.js';
import { ExecutionWorkflowIntents, type WorkflowMember } from './execution-workflow-intent.js';
import { ExecutionWorkspaceApprovals } from './execution-workspace-approval.js';
import {
  projectArtifactsQuerySchema,
  type ProjectArtifactsValue,
} from './execution-project-artifacts-contract.js';
import {
  acceptedProjectFileArtifact,
  projectArtifactsProjection,
  selectProjectArtifacts,
} from './execution-project-artifacts.js';
import {
  WorkspaceApprovalError,
  type WorkspaceApprovalHostSource,
  type WorkspaceApprovalOwner,
  type WorkspaceApprovalRun,
  type WorkspaceApprovalState,
} from './execution-workspace-approval-contract.js';
import {
  WORKFLOW_REVIEW_REQUEST_PREFIX,
  workflowReviewRequestId,
  workflowReviewCandidates,
  hasCommittedWorkflowStop,
  stoppedWorkflowReviewGeneration,
  stoppedWorkflowReviewRunIds,
  stoppedRemoteWorkflowReviewRunIds,
  stoppedPreparedWorkflowReviewRunIdsForRevision,
} from './execution-workflow-reviews.js';
import { isStoppedReviewHistory, splitExecutionReviewRecord } from './execution-review-record.js';
import {
  ExecutionWorkflowError,
  workflowExecutionIntentSchema,
  type WorkflowExecutionClaim,
  type WorkflowExecutionIntent,
  type WorkflowExecutionView,
  type WorkflowLocation,
  type WorkflowStartTicket,
} from './execution-workflow-contract.js';

/** The actor is only `member`, the result of identity's `resolveMember`. */
export interface ExecutionCaller {
  readonly member?: MemberResolution;
}

/** Minted from the original request and current published directory, never JSON. */
export interface ExecutionFileAuthority {
  readonly lease: ExecutionMemberLease;
  assertProjectSpace(projectId: string, spaceId: string): void;
}
export type ExecutionFileAuthoritySource = () => Promise<ExecutionFileAuthority>;

const fileReadLocation = {
  taskId: WorkTaskSchema.shape.id,
  planId: WorkTaskSchema.shape.id,
  revision: z.number().int().positive(),
  nodeId: WorkTaskSchema.shape.id,
  spaceId: WorkTaskSchema.shape.id,
  uploadId: WorkTaskSchema.shape.id,
  mode: z.enum(['metadata', 'preview', 'download']).default('metadata'),
};
const artifactId = z.string().min(1).max(1000);
export const fileReadSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ ...fileReadLocation, purpose: z.literal('draft') }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('artifact'),
    artifactVersionId: artifactId,
  }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('review'),
    artifactVersionId: artifactId,
    roundId: artifactId,
  }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('upstream'),
    sourceNodeId: WorkTaskSchema.shape.id,
    artifactVersionId: artifactId,
  }),
  z.strictObject({
    ...fileReadLocation,
    purpose: z.literal('accepted'),
    projectId: WorkTaskSchema.shape.id,
    artifactVersionId: artifactId,
  }),
]);
export type FileContentRequest = z.infer<typeof fileReadSchema>;
export interface FileContentInfo {
  readonly request: FileContentRequest;
  readonly uploadId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reference: ArtifactFileRef;
}
/** Host-only owned response. Raw HTTP strips control functions from metadata JSON. */
export interface AuthorizedFileContent {
  readonly info: FileContentInfo;
  readonly bytes?: Uint8Array;
  readonly signal: AbortSignal;
  check(): void;
  release(): void;
}

const id = z.string().min(1);
const TEXT_LIMIT = 100_000;
const boundedText = z.string().max(TEXT_LIMIT);
const fileSchema = z.strictObject({
  id,
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  checksum: z.string().min(1),
  accessPolicyId: z.string().min(1),
  uploadComplete: z.boolean(),
});
const locate = {
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: id,
};
const startSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int(),
  idempotencyKey: id,
  spaceId: id.optional(),
});
const submitSchema = z.strictObject({
  ...locate,
  text: boundedText.optional(),
  files: z.array(fileSchema).max(20).optional(),
  links: z.array(z.string()).max(20).optional(),
});
const ballotSchema = z.strictObject({
  ...locate,
  roundId: id,
  artifactVersionId: id,
  action: z.enum(['approve', 'request-changes', 'comment']),
  comment: boundedText.optional(),
  unresolvedCommentIds: z.array(z.string()).max(50).optional(),
});
const expertReviewPrepareSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(200),
  expectedReviewVersion: z.number().int().nonnegative().refine(Number.isSafeInteger),
  target: executionReviewTargetSchema,
  reviewerRef: z.strictObject({
    id: z.string().min(1).max(100),
    version: z.string().min(1).max(100),
  }),
  configurationId: z.string().trim().min(1).max(200),
});
const expertReviewPreparationSchema = expertReviewPrepareSchema
  .omit({ configurationId: true })
  .extend({
    workflow: remoteWorkflowRefSchema.optional(),
  });
const expertReviewAdmitSchema = z.strictObject({
  spaceId: id,
  taskId: id,
  planId: id,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  nodeId: id,
  runId: id,
  expectedAttemptVersion: z.number().int().positive().refine(Number.isSafeInteger),
  composition: z.unknown(),
});
const expertReviewNativeSchema = expertReviewAdmitSchema
  .omit({ composition: true, expectedAttemptVersion: true })
  .extend({
    requestId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
  });
const settleSchema = z.strictObject({
  ...locate,
  roundId: id,
  artifactVersionId: id,
});
const reportSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int(),
  spaceId: id.optional(),
});
const revisionSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
});
const upstreamContentSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  sourceNodeId: id,
  artifactVersionId: id,
  spaceId: id,
});
const draftLocate = {
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
};
const draftReadSchema = z.strictObject(draftLocate);
const runCompositionInputsSchema = draftReadSchema.extend({ spaceId: id });
const beginRunSchema = beginExecutionRunSchema
  .omit({ actorId: true })
  .extend({ ...draftLocate, composition: executionRunCompositionSchema });
const stopRunSchema = stopExecutionRunSchema
  .omit({ actorId: true })
  .extend({ ...draftLocate, spaceId: id });
export type BeginRunRequest = z.infer<typeof beginRunSchema>;
export type StopRunRequest = z.infer<typeof stopRunSchema>;
export type ExecutionNodeLocator = z.infer<typeof draftReadSchema>;
export type ExecutionRunCompositionInputs = ExecutionRunCompositionInput['inputs'];

/** Host-only real producers. Omission refuses Run admission; no DTO is a capability. */
export interface ExecutionRunHostPorts
  extends
    Pick<
      ExecutionRunAuthoritySource,
      'memberLease' | 'onChange' | 'signal' | 'migrationOrigin' | 'migrationDrain'
    >,
    ExecutionRunResourceCatalogHost {
  /** Current authoritative mapping (and its source lifetime), not a browser-selected space. */
  assertProjectSpace(projectId: string, spaceId: string): undefined;
  /** Same mounted knowledge Service, original request/space/project authorization.
   * Awaited outside this Service's queue. Failure must reject, never become an empty snapshot.
   * Optional only for legacy Hosts; references do not certify body reads. */
  prepareProjectKnowledge?(
    request: MemberRequest,
    query: { readonly spaceId: string; readonly projectId: string },
    signal: AbortSignal,
  ): Promise<KnowledgeProjectSnapshot>;
  prepareTeamAssetFiles?(
    request: MemberRequest,
    query: MemberAssetFileSnapshotQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetFileSnapshotValue>;
  qualifyTeamAssetFile?(
    request: MemberRequest,
    reference: MemberAssetReference,
    signal: AbortSignal,
  ): Promise<MemberAssetReferenceValue>;
  /** Verify the exact frozen expert/input/model/tool composition and executor readiness. */
  assertConfiguration(
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
    request: BeginRunRequest,
  ): undefined;
  /** A's original real model/resource producer, never a browser flag. Absence
   * keeps the review lane read-only. This assertion must complete synchronously. */
  assertReviewConfiguration?(
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
    composition: FrozenExecutionReviewComposition,
  ): undefined;
  assertWorkspace(...args: Parameters<ExecutionRunAuthoritySource['assertWorkspace']>): undefined;
}

type NativeResultPort = {
  readonly issuer: NativeFixedResultIssuer | NativeFixedResultPublicationsIssuer;
  readonly prepare: NativeFixedResultIssuer['prepareFixedResult'];
  readonly read: (
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal,
  ) => Promise<NativeFixedResultLease | NativeFixedResultPublicationsLease>;
  readonly assert: NativeFixedResultIssuer['assertFixedResult'];
};
type NativeResultOperation = {
  readonly signal: AbortSignal;
  check(): void;
  assert(callback: () => unknown): void;
  release(callback: () => unknown): void;
};
const fixedResultProofSchema = executionNativeResultDeliveryV1Schema.pick({
  source: true,
  digest: true,
  provenanceFingerprint: true,
});

/** `void` accepts async callbacks in TypeScript. Recheck runtime JS producers too:
 * only synchronous undefined means the assertion completed. Observe a rejected
 * promise to avoid an unhandled rejection, but never await it as authorization.
 */
function synchronousRunAssertion(result: unknown): undefined {
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    throw new ExecutionRunError('run-authority-unavailable');
  }
  return undefined;
}

export type RunEventAuthority =
  { readonly grant: NativeWorkGrant } | { readonly cleanup: ExecutionRunCleanupAuthority };
const DRAFT_LINK_MAX = 2048;
const DRAFT_LINK_TOTAL_MAX = 8192;
const DRAFT_FILE_FIELD_MAX = 2048;
const DRAFT_BODY_MAX = 262_144;
const DRAFT_KEY_MAX = 200;
const draftWriteSchema = z.strictObject({
  ...draftLocate,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: id,
  text: boundedText.optional(),
  files: z.array(fileSchema).max(20).optional(),
  links: z.array(z.string().min(1)).max(20).optional(),
});
/** Same-package member transport reuses the original strict decoders; no copied DTOs. */
export const executionMemberRequestSchemas = Object.freeze({
  startPlan: startSchema,
  submit: submitSchema,
  ballot: ballotSchema,
  revision: revisionSchema,
  upstreamContent: upstreamContentSchema,
  draftRead: draftReadSchema,
  draftWrite: draftWriteSchema,
});
const inboxSchema = z.strictObject({ spaceId: id.optional() });
const startableSchema = z.strictObject({ spaceId: id.optional() });
const eventsSchema = z.strictObject({
  taskId: id,
  planId: id,
  revision: z.number().int().positive(),
  nodeId: id,
  after: z.number().refine((value) => Number.isSafeInteger(value) && value >= 0),
  seenEventIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  spaceId: id.optional(),
});

export type StartPlanRequest = z.infer<typeof startSchema>;
export type InboxRequest = z.infer<typeof inboxSchema>;
export type StartableRequest = z.infer<typeof startableSchema>;

/**
 * One confirmed plan the member may explicitly start. Read-only discovery for
 * the "task → confirmed plan → explicit start" entry; nothing here launches.
 */
export type UpstreamContentRequest = z.infer<typeof upstreamContentSchema>;

/** Accepted content of a pinned upstream input. File refs carry metadata only, never bytes. */
export interface UpstreamContentValue {
  readonly actorId: string;
  readonly spaceId: string;
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

export interface StartablePlan {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
}
export type SubmitRequest = z.infer<typeof submitSchema>;
export type BallotRequest = z.infer<typeof ballotSchema>;
export type SettleRequest = z.infer<typeof settleSchema>;
export type ReportRequest = z.infer<typeof reportSchema>;
export type RevisionRequest = z.infer<typeof revisionSchema>;

export interface PlanReceipt {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly nodeIds: readonly string[];
  readonly workflowExecution?: WorkflowExecutionIntent | undefined;
  readonly remoteWorkflows?: RemoteWorkflowIntent[] | undefined;
}

export interface ExecutionStorage {
  readNode(key: string): ExecutionNodeRecord | undefined;
  writeNode(key: string, value: ExecutionNodeRecord): Promise<void>;
  listNodes(): readonly ExecutionNodeRecord[];
  readPlan(key: string): PlanReceipt | undefined;
  writePlan(key: string, value: PlanReceipt): Promise<void>;
  listPlans(): readonly { readonly key: string; readonly receipt: PlanReceipt }[];
  /** Same execution domain global. Optional only for legacy non-Run consumers. */
  readGlobal?(): unknown;
  writeGlobal?(value: ExecutionWriterGlobal): Promise<void>;
  /** Handle over the same already opened execution domain. No caller owns put. */
  workspaceApprovals?: {
    read(): unknown;
    write(state: WorkspaceApprovalState): Promise<void>;
  };
}

export interface ExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type ExecutionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExecutionFailure };

export interface ExecutionNodeView {
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
  readonly inputs?: readonly UpstreamInputView[];
}

const MESSAGES = {
  'actor-from-body': '不能在请求里指定操作者。',
  unauthenticated: '请先登录。',
  'untrusted-request': '这次请求不可信。',
  'not-assignee': '只有该节点的执行者可以提交。',
  'not-assigned-reviewer': '你不是这一轮的评审人。',
  'actor-mismatch': '不能代替其他评审人投票。',
  'upload-incomplete': '文件还没有上传完成，不能提交。',
  'file-too-large': '文件超过大小上限。',
  'quota-exceeded': '文件数量或总量已达上限。',
  'digest-mismatch': '文件内容与声明的摘要不一致。',
  'upload-timeout': '文件上传超时，请重试。',
  'file-timeout': '文件读取超时，请重试。',
  'files-not-accepted': '文件还不能随这次提交完成。请只提交文字或链接。',
  'empty-delivery': '请填写交付说明，或附上已上传完成的文件。',
  conflict: '内容已变化，请刷新后再试。',
  'idempotency-mismatch': '这个请求标识已经用于另一项操作。',
  'plan-not-found': '找不到指定的已确认计划版本。',
  'plan-reference-required': '请提供任务、计划标识和精确计划版本。',
  'stale-round': '这不是当前评审轮次。',
  'stale-version': '这不是当前产物版本。',
  'voided-round': '这一轮评审已作废。',
  'not-in-directory': '当前登录身份不在团队目录里。',
  'not-participant': '只有这项任务的负责人或参与者可以执行这个操作。',
  'plan-incomplete': '计划还没有完整启动，暂时不能查看或写入。',
  unavailable: '执行记录暂时写不进去，请用同一个请求再试一次。',
  'not-found': '找不到这个节点。',
  'not-returned': '这项工作还没有被退回。',
  'not-deliverable': '这项工作现在不能保存交付草稿。',
  'empty-request-changes': '退回要写意见，或引用一条还没解决的评论。',
  'empty-comment': '只评论时要写下评论，不能只留空白。',
  'comment-not-unresolved': '引用的评论不是这条产物上还没解决的评论。',
  validation: '提交的数据格式不正确。',
  'unknown-field': '请求里有无法识别的字段。',
  'invalid-handoff': '计划还不能派发，请补选负责人后重新确认。',
  cancelled: '操作已取消。',
} as const;

export type ExecutionMessageCode = keyof typeof MESSAGES;

const DIRECTORY_UNAVAILABLE_MESSAGE = '执行记录暂时不可用，请稍后用同一个请求再试一次。';

/** Same id rule as `save-task` and stored tasks. Not a second copy of the pattern. */
function acceptedTaskId(value: string): boolean {
  return WorkTaskSchema.shape.id.safeParse(value).success;
}

function directoryUnavailable(): { ok: false; error: ExecutionFailure } {
  return {
    ok: false,
    error: { code: 'unavailable', message: DIRECTORY_UNAVAILABLE_MESSAGE, details: {} },
  };
}

function fail(
  code: string,
  details: Record<string, unknown> = {},
): { ok: false; error: ExecutionFailure } {
  const message =
    code in MESSAGES ? MESSAGES[code as ExecutionMessageCode] : '执行请求没有被接受。';
  return {
    ok: false,
    error: { code, message, details },
  };
}

function draftLinkLimit(
  links: readonly string[],
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  if (links.some((link) => link.length > DRAFT_LINK_MAX)) {
    return {
      ok: false,
      error: { code: 'validation', message: '单条链接不能超过 2048 个字符。', details: {} },
    };
  }
  let total = 0;
  for (const link of links) total += link.length;
  if (total > DRAFT_LINK_TOTAL_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '草稿里的链接合计不能超过 8192 个字符。', details: {} },
    };
  }
  return undefined;
}

function draftFileLimit(
  text: string,
  links: readonly string[],
  files: readonly {
    id: string;
    mediaType: string;
    checksum: string;
    accessPolicyId: string;
  }[],
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  for (const file of files) {
    const fields = [file.id, file.mediaType, file.checksum, file.accessPolicyId];
    if (fields.some((field) => field.length > DRAFT_FILE_FIELD_MAX)) {
      return {
        ok: false,
        error: {
          code: 'validation',
          message: '文件信息的每一项不能超过 2048 个字符。',
          details: {},
        },
      };
    }
  }
  let total = text.length;
  for (const link of links) total += link.length;
  for (const file of files) {
    total +=
      file.id.length + file.mediaType.length + file.checksum.length + file.accessPolicyId.length;
  }
  if (total > DRAFT_BODY_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '草稿合计不能超过 262144 个字符。', details: {} },
    };
  }
  return undefined;
}

function draftKeyLimit(
  idempotencyKey: string,
): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
  if (idempotencyKey.length > DRAFT_KEY_MAX) {
    return {
      ok: false,
      error: { code: 'validation', message: '幂等键不能超过 200 个字符。', details: {} },
    };
  }
  return undefined;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): ExecutionResult<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const unknown = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
  return fail(unknown ? 'unknown-field' : 'validation');
}

export function toNodeView(record: ExecutionNodeRecord): ExecutionNodeView {
  const report = toNodeExecutionReport(record);
  return {
    nodeId: record.nodeId,
    taskId: record.taskId,
    planId: record.planId,
    revision: record.revision,
    version: record.command.version,
    status: report.status,
    goal: record.handoff.goal,
    expectedOutput: record.handoff.expectedOutput,
    assigneeId: record.handoff.assignee.id,
    assigneeKind: record.handoff.assignee.kind,
    reviewerIds: record.handoff.reviewerIds,
    ownerId: record.ownerId,
    rounds: record.rounds,
    artifacts: record.artifactVersions.map((artifact) => ({
      ...artifact,
      links: [...artifact.links],
      files: artifact.files.map((file) => ({ ...file })),
    })),
    comments: record.comments,
    ...(record.command.entryStatus !== undefined
      ? { entryStatus: record.command.entryStatus }
      : {}),
    ...(record.currentRoundId !== undefined ? { currentRoundId: record.currentRoundId } : {}),
    ...(report.acceptedArtifactVersionId !== undefined
      ? { acceptedArtifactVersionId: report.acceptedArtifactVersionId }
      : {}),
    ...(report.reviewOutcome !== undefined ? { reviewOutcome: report.reviewOutcome } : {}),
    ...(report.blockReason !== undefined ? { blockReason: report.blockReason } : {}),
  };
}

function receiptOf(record: UploadFileRecord): FileUploadReceipt {
  return {
    uploadId: record.uploadId,
    attachmentId: record.attachmentId,
    name: record.name,
    mediaType: record.mediaType,
    bytes: record.byteSize,
    sha256: record.sha256,
    reference: artifactFileReference(record),
  };
}

function planKey(taskId: string, planId: string, revision: number): string {
  return `${taskId}:${planId}:${revision}`;
}

function taskForPlanKey<T extends { readonly id: string }>(
  key: string,
  tasks: readonly T[],
): T | undefined {
  let found: T | undefined;
  for (const task of tasks) {
    if (!key.startsWith(`${task.id}:`)) continue;
    const rest = key.slice(task.id.length + 1);
    const splitAt = rest.lastIndexOf(':');
    if (splitAt <= 0) continue;
    if (!/^\d+$/.test(rest.slice(splitAt + 1))) continue;
    if (!found || task.id.length > found.id.length) found = task;
  }
  return found;
}

function directoryIds(workbench: Workbench): readonly string[] {
  return workbench.participants
    .filter((participant) => participant.kind === 'human')
    .map((participant) => participant.id);
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

/** Project, task, then ancestor node titles. The current node title stays on the row. */
function inboxPlace(workbench: Workbench, item: InboxItem): InboxPlace {
  const task = workbench.tasks.find((entry) => entry.id === item.taskId);
  const project = task
    ? workbench.projects.find((entry) => entry.id === task.projectId)
    : undefined;
  const titles: string[] = [];
  const projectName = project?.name.trim() ?? '';
  const taskTitle = task?.title.trim() ?? '';
  if (projectName !== '') titles.push(projectName);
  if (taskTitle !== '') titles.push(taskTitle);
  if (task) {
    const located = new Map<string, { parentNodeId: string | null; title: string }>();
    for (const workflow of task.workflows) {
      for (const node of workflow.nodes) {
        located.set(node.id, { parentNodeId: workflow.parentNodeId, title: node.title.trim() });
      }
    }
    const chain: string[] = [];
    const seen = new Set<string>();
    let parentId = located.get(item.nodeId)?.parentNodeId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = located.get(parentId);
      if (!parent) break;
      if (parent.title !== '') chain.push(parent.title);
      parentId = parent.parentNodeId;
    }
    titles.push(...chain.reverse());
  }
  const owner = task?.ownerId
    ? workbench.participants.find((person) => person.id === task.ownerId)
    : undefined;
  return { itemId: item.id, taskPath: titles.join(' / '), ownerName: owner?.name.trim() ?? '' };
}

function countInbox(
  items: readonly InboxItem[],
): Pick<InboxCounts, 'deliver' | 'review' | 'confirm'> {
  return {
    deliver: items.filter((item) => item.kind === 'deliver').length,
    review: items.filter((item) => item.kind === 'review').length,
    confirm: items.filter((item) => item.kind === 'confirm').length,
  };
}

type NodeEvent = DomainEvent<{ readonly status: string; readonly version: number }>;

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

/** Append one accepted fact onto the node record. The id is the next sequence. */
function withExecutionEvent(
  record: ExecutionNodeRecord,
  type: string,
  actorId: string,
): ExecutionNodeRecord | undefined {
  const log: readonly NodeEvent[] = Array.isArray(record.events) ? record.events : [];
  const sequence = log.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
  const appended = recordCommandEvent({
    decisionStatus: 'applied',
    log,
    event: {
      eventId: `evt:${record.nodeId}:${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      actorId,
      object: { type: 'node', id: record.nodeId },
      type,
      payload: { status: record.command.status, version: record.command.version },
    },
  });
  if (!appended.ok || !appended.emitted) return undefined;
  return { ...record, events: appended.log };
}

function publishExecutionEvent(event: NodeEvent): ExecutionEvent | undefined {
  const payload = event.payload;
  if (
    event.object.type !== 'node' ||
    typeof payload?.status !== 'string' ||
    typeof payload.version !== 'number'
  ) {
    return undefined;
  }
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    type: event.type,
    nodeId: event.object.id,
    status: payload.status,
    version: payload.version,
  };
}

function planMembership(
  workbench: Workbench,
  taskId: string,
  actorId: string,
): 'allowed' | 'missing' | 'not-participant' {
  const task = workbench.tasks.find((item) => item.id === taskId);
  if (!task) return 'missing';
  if (task.ownerId === actorId || task.participantIds.includes(actorId)) return 'allowed';
  return 'not-participant';
}

function maySettle(record: ExecutionNodeRecord, actorId: string): boolean {
  const assignee = record.handoff.assignee;
  if (assignee.kind === 'human' && assignee.id === actorId) return true;
  return record.handoff.reviewerIds.includes(actorId);
}

/**
 * The round was already settled, or the node already reached the outcome of
 * this round. A later ballot replay must not settle again as the current actor.
 */
function settlementLanded(record: ExecutionNodeRecord, roundId: string): boolean {
  const round = record.rounds.find((item) => item.id === roundId);
  if (!round || record.currentRoundId !== roundId) return false;
  const stored = record.command.stored;
  if (Array.isArray(stored) && stored.some((item) => item.idempotencyKey === `settle:${roundId}`)) {
    return true;
  }
  if (round.status === 'approved' && record.command.status === 'completed') return true;
  if (round.status === 'changes-requested' && record.command.status === 'needs-revision') {
    return true;
  }
  return false;
}

function recordedPlan(storage: ExecutionStorage, record: ExecutionNodeRecord): boolean {
  const receipt = storage.readPlan(planKey(record.taskId, record.planId, record.revision));
  if (
    !receipt ||
    typeof receipt.idempotencyKey !== 'string' ||
    receipt.idempotencyKey.length === 0 ||
    typeof receipt.fingerprint !== 'string' ||
    receipt.fingerprint.length === 0 ||
    !Array.isArray(receipt.nodeIds) ||
    !receipt.nodeIds.every((nodeId) => typeof nodeId === 'string' && nodeId.length > 0)
  )
    return false;
  const nodes = new Set(receipt.nodeIds);
  return nodes.size === receipt.nodeIds.length && nodes.has(record.nodeId);
}

/** A stored value that cannot be read as a node is skipped, not fatal. */
function intactNode(record: ExecutionNodeRecord): boolean {
  try {
    if (record == null || typeof record !== 'object') return false;
    if (
      typeof record.nodeId !== 'string' ||
      typeof record.taskId !== 'string' ||
      typeof record.planId !== 'string' ||
      typeof record.revision !== 'number'
    ) {
      return false;
    }
    const handoff = record.handoff as {
      dependencyNodeIds?: unknown;
      reviewerIds?: unknown;
      assignee?: { kind?: unknown; id?: unknown };
    } | null;
    if (handoff == null || typeof handoff !== 'object' || Array.isArray(handoff)) return false;
    if (!Array.isArray(handoff.dependencyNodeIds) || !Array.isArray(handoff.reviewerIds)) {
      return false;
    }
    if (
      handoff.assignee == null ||
      typeof handoff.assignee !== 'object' ||
      typeof handoff.assignee.kind !== 'string' ||
      typeof handoff.assignee.id !== 'string'
    ) {
      return false;
    }
    if (record.command == null || typeof record.command !== 'object') return false;
    if (typeof record.command.status !== 'string' || typeof record.command.version !== 'number') {
      return false;
    }
    return Array.isArray(record.rounds) && Array.isArray(record.receipts);
  } catch {
    return false;
  }
}

function samePlan(record: ExecutionNodeRecord, taskId: string, planId: string, revision: number) {
  return record.taskId === taskId && record.planId === planId && record.revision === revision;
}

function rejectionDetails(
  code: string,
  current: ExecutionNodeRecord,
  request: { expectedVersion: number },
): Record<string, unknown> {
  if (code === 'not-assignee') return { canSubmitNode: false };
  if (code === 'conflict') {
    return { currentVersion: current.command.version, expectedVersion: request.expectedVersion };
  }
  return {};
}

/** Serializes durable execution commands. One user command writes one node record. */
export class ExecutionService {
  private reviewReadAuthorities: ExecutionReviewReadAuthorities | undefined;
  private reviewDriveAuthorities: ExecutionReviewDriveAuthorities | undefined;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly runLifetime = new AbortController();
  private readonly reviewCleanupLifetime = new AbortController();
  private reviewCleanupSealed = false;
  private readonly runChanges = new Set<() => void>();
  private readonly runPreparations = new Set<Promise<ExecutionResult<ExecutionRunDecision>>>();
  private runPreparationFailure: ExecutionRunResourceQualificationCloseError | undefined;
  private runHost: ExecutionRunHostPorts | undefined;
  private runAuthorities: ExecutionRunAuthorities | undefined;
  private remoteRunAuthorities: RemoteRunAuthorities | undefined;
  private remoteFileUploadsEnabled = false;
  private remoteIndependentReviewsEnabled = false;
  private workflowIntents: ExecutionWorkflowIntents | undefined;
  private workspaceApprovalOwner: ExecutionWorkspaceApprovals | undefined;
  private readonly reviewWorkflowClaims = new Map<
    string,
    {
      original: MemberRequest;
      claim: WorkflowExecutionClaim;
      dispose(): void;
    }
  >();
  private readonly reviewDrains = new Map<
    string,
    {
      drain: NativeMigrationDrain;
      signal: AbortSignal;
      assert: NativeMigrationDrain['assertCurrent'];
    }
  >();
  private nativeResultIssuer: NativeResultPort | undefined;
  private nativeResultPublicationsIssuer: NativeResultPort | undefined;
  private reviewNativePorts:
    | {
        readonly original: ExecutionReviewNativePorts;
        readonly issuer: ExecutionReviewNativePorts['issuer'];
        readonly grantFor: ExecutionReviewNativePorts['grantFor'];
        readonly retireForCleanup: ExecutionReviewNativePorts['retireForCleanup'];
        readonly prepare: ExecutionReviewNativePorts['issuer']['prepareFixedReview'];
        readonly assert: ExecutionReviewNativePorts['issuer']['assertFixedReview'];
        readonly read: ExecutionReviewNativePorts['issuer']['readFixedReview'];
      }
    | undefined;
  private readonly nativeResultOperations = new Set<Promise<unknown>>();
  private nativeReviewCleanupOperations = 0;
  private nativeResultCleanupFailure: NativeResultDeliveryError | undefined;
  private readonly uploadLifetime = new AbortController();
  private readonly uploadDrains = new Set<Promise<void>>();
  private readonly uploadOperations = new Set<Promise<unknown>>();
  private readonly fileLifetime = new AbortController();
  private readonly fileOperations = new Set<Promise<unknown>>();
  private readonly fileReadResources = new Set<{
    readonly spaceId: string;
    readonly drain: Promise<void>;
  }>();
  /** Ephemeral resource reservations; durable file facts still have one queued writer. */
  private readonly pendingUploads = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly spaceId: string;
      readonly nodeKey: string;
      readonly bytes: number;
      readonly newFile: boolean;
      readonly nativeRunKey?: string;
    }
  >();

  constructor(
    private readonly storage: ExecutionStorage,
    private readonly workbench: {
      readWorkbench(): Workbench;
      memberDirectory?(): MemberWorkbenchDirectory | undefined;
    },
    private readonly projectSpaces: ProjectSpaceDirectory | undefined,
    private readonly attachments?: AttachmentStore,
    private readonly fileStore?: ArtifactFileStore,
  ) {
    this.assertRunStoreCompatibility();
    if (storage.workspaceApprovals?.read() !== undefined)
      requireWorkspaceApprovalWriter(this.readRunGlobal());
  }

  /** A registers its actual controlled SDK confirmation producer once. The
   * returned private view never exposes the table writer to Host or Client. */
  openWorkspaceApprovalOwner(source: WorkspaceApprovalHostSource): WorkspaceApprovalOwner {
    const table = this.storage.workspaceApprovals;
    if (!table || this.workspaceApprovalOwner || this.runLifetime.signal.aborted)
      throw new WorkspaceApprovalError('workspace-approval-unavailable');
    let installedHost: ExecutionRunHostPorts | undefined;
    let migrationDrain: ExecutionRunHostPorts['migrationDrain'];
    const currentHost = () => {
      const host = this.requireRunHost();
      if (!installedHost) {
        installedHost = host;
        migrationDrain = host.migrationDrain;
      }
      if (host !== installedHost || host.migrationDrain !== migrationDrain)
        throw new WorkspaceApprovalError('workspace-approval-unavailable');
      return host;
    };
    const approvals = new ExecutionWorkspaceApprovals(
      {
        signal: this.runLifetime.signal,
        read: () => table.read(),
        write: (state) => table.write(state),
        assertCompatible: (hasState) => {
          this.assertRunStoreCompatibility();
          if (hasState) requireWorkspaceApprovalWriter(this.readRunGlobal());
        },
        enableWriter: () => {
          if (!this.storage.writeGlobal)
            throw new WorkspaceApprovalError('workspace-approval-unavailable');
          return enableWorkspaceApprovalWriter(
            () => this.readRunGlobal(),
            (next) => this.storage.writeGlobal!(next),
            this.storage.listNodes(),
          );
        },
        enqueue: (work) =>
          this.enqueue(async () => {
            const result = await work();
            return result.ok ? result : fail(result.error.code);
          }),
        member: async (original, scope) => {
          const host = currentHost(),
            member = await host.memberLease(original);
          const { memberId, expiresAt, signal, assertCurrent, release } = member;
          let released = false;
          return {
            actorId: memberId,
            signal,
            assertCurrent: () => {
              currentHost();
              if (
                released ||
                !Number.isSafeInteger(expiresAt) ||
                expiresAt <= Date.now() ||
                signal.aborted ||
                member.memberId !== memberId ||
                member.expiresAt !== expiresAt ||
                member.signal !== signal ||
                member.assertCurrent !== assertCurrent ||
                member.release !== release
              )
                throw new WorkspaceApprovalError('workspace-approval-unauthenticated');
              synchronousRunAssertion(assertCurrent.call(member, scope.spaceId));
              if (
                !this.workbench
                  .readWorkbench()
                  .projects.some((project) => project.id === scope.projectId)
              )
                throw new WorkspaceApprovalError('workspace-approval-not-found');
              synchronousRunAssertion(host.assertProjectSpace(scope.projectId, scope.spaceId));
              if (signal.aborted)
                throw new WorkspaceApprovalError('workspace-approval-unauthenticated');
              return undefined;
            },
            release() {
              if (released) return;
              released = true;
              return release.call(member);
            },
          };
        },
        runs: () => {
          const found: WorkspaceApprovalRun[] = [];
          for (const node of this.storage.listNodes())
            for (const run of readExecutionRunState(node)?.runs ?? []) {
              if (run.workspace.kind !== 'local') continue;
              found.push({
                scope: executionRunScope(node, run),
                workspace: run.workspace,
                resources: run.resources,
                ...(run.attempt.sessionId ? { nativeSessionId: run.attempt.sessionId } : {}),
                ...(run.attempt.executorRunId ? { nativeAgentId: run.attempt.executorRunId } : {}),
              });
            }
          return found;
        },
        assertDrained: (run) => {
          const host = currentHost();
          if (!migrationDrain)
            throw new WorkspaceApprovalError('workspace-approval-recovery-required');
          const proof = migrationDrain.call(host, run.scope);
          if (
            !proof ||
            !(proof.signal instanceof AbortSignal) ||
            proof.signal.aborted ||
            typeof proof.assertCurrent !== 'function'
          )
            throw new WorkspaceApprovalError('workspace-approval-recovery-required');
          synchronousRunAssertion(proof.assertCurrent());
          if (proof.signal.aborted)
            throw new WorkspaceApprovalError('workspace-approval-recovery-required');
          return undefined;
        },
        notify: () => this.notifyRuns(),
      },
      source,
    );
    this.workspaceApprovalOwner = approvals;
    return approvals.owner;
  }

  /** Install once on this owner. A supplies the SAME Host bundle's real member lease issuer. */
  installRunHost(host: ExecutionRunHostPorts): ExecutionRunAuthorities {
    if (
      this.runHost ||
      this.runLifetime.signal.aborted ||
      !host ||
      !(host.signal instanceof AbortSignal) ||
      host.signal.aborted ||
      [
        'memberLease',
        'assertProjectSpace',
        'assertConfiguration',
        'assertWorkspace',
        'onChange',
      ].some((key) => typeof (host as unknown as Record<string, unknown>)[key] !== 'function')
    )
      throw new ExecutionRunError('run-authority-unavailable');
    const migrationOrigin = host.migrationOrigin?.bind(host);
    const migrationDrain = host.migrationDrain?.bind(host);
    const authorities = new ExecutionRunAuthorities({
      writerState: () => this.readRunGlobal(),
      memberLease: (request) => host.memberLease(request),
      readNode: (locator) => this.readRunNode(locator),
      assertNodeAccess: (memberId, spaceId, node, action) => {
        this.assertRunNodeAccess(host, memberId, spaceId, node);
        if (['send', 'queue', 'stop'].includes(action)) this.assertRunController(memberId, node);
      },
      assertWorkspace: (...args) => synchronousRunAssertion(host.assertWorkspace(...args)),
      onChange: (recheck) => {
        const stop = host.onChange(recheck);
        this.runChanges.add(recheck);
        return () => {
          this.runChanges.delete(recheck);
          stop();
        };
      },
      signal: AbortSignal.any([host.signal, this.runLifetime.signal]),
      ...(migrationOrigin ? { migrationOrigin } : {}),
      ...(migrationDrain ? { migrationDrain } : {}),
    });
    this.runHost = host;
    this.runAuthorities = authorities;
    return authorities;
  }

  startWorkflowExecution(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    return this.workflows().start(request, body);
  }
  readWorkflowExecution(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    return this.workflows().read(request, body);
  }
  resumeWorkflowExecution(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    return this.workflows().resume(request, body);
  }
  /** Fences admission and persists stopping. Host drains original Runs; read
   * derives paused only once their original resource facts actually settle. */
  stopWorkflowExecution(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionView>> {
    return this.workflows().stop(request, body);
  }
  /** Only the original retained Host request can mint non-serializable tickets. */
  claimWorkflowExecution(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<WorkflowExecutionClaim>> {
    return this.workflows().claim(request, body);
  }

  /** Host checks original claim/request identity before reserving local work.
   * A copied claim's borrowed check closure is not an authority check. */
  assertWorkflowExecutionClaim(request: MemberRequest, claim: WorkflowExecutionClaim): undefined {
    this.workflows().assertClaim(request, claim);
    return undefined;
  }

  private workflows(): ExecutionWorkflowIntents {
    const host = this.requireRunHost();
    const migrationDrain = host.migrationDrain;
    this.workflowIntents ??= new ExecutionWorkflowIntents({
      signal: AbortSignal.any([host.signal, this.runLifetime.signal]),
      enqueue: (work) => this.enqueue(work),
      open: async (request, location) => {
        const lease = await host.memberLease(request);
        const signal = lease.signal,
          assert = lease.assertCurrent,
          release = lease.release;
        const memberId = lease.memberId,
          expiresAt = lease.expiresAt;
        const facts: WorkflowMember['facts'] = (requireStarted) => {
          if (
            this.requireRunHost() !== host ||
            lease.signal !== signal ||
            !(signal instanceof AbortSignal) ||
            signal.aborted ||
            lease.assertCurrent !== assert ||
            lease.release !== release ||
            lease.memberId !== memberId ||
            lease.expiresAt !== expiresAt ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= Date.now()
          )
            throw new ExecutionWorkflowError('workflow-authority-denied');
          synchronousRunAssertion(assert.call(lease, location.spaceId));
          const workbench = this.workbench.readWorkbench();
          const task = workbench.tasks.find((item) => item.id === location.taskId);
          if (
            !task ||
            task.ownerId !== memberId ||
            !workbench.participants.some(
              (item) => item.id === memberId && item.kind === 'human' && item.available,
            ) ||
            planMembership(workbench, location.taskId, memberId) !== 'allowed'
          )
            throw new ExecutionWorkflowError('workflow-authority-denied');
          synchronousRunAssertion(host.assertProjectSpace(task.projectId, location.spaceId));
          const applied = createExecutionHandoff(
            {
              taskId: location.taskId,
              planId: location.planId,
              revision: location.revision,
            },
            workbench,
          );
          const handoffs = createNodeHandoffs(applied);
          if (!handoffs.length) throw new ExecutionWorkflowError('workflow-plan-incomplete');
          const receipt = this.storage.readPlan(
            planKey(location.taskId, location.planId, location.revision),
          );
          const nodes = handoffs.flatMap(({ nodeId }) => {
            const node = this.readRunNode({ ...location, nodeId });
            return node ? [node] : [];
          });
          if (requireStarted && !receipt)
            throw new ExecutionWorkflowError('workflow-plan-incomplete');
          if (receipt) {
            if (nodes.length !== handoffs.length)
              throw new ExecutionWorkflowError('workflow-plan-incomplete');
            this.assertRunNodeAccess(host, memberId, location.spaceId, nodes[0]!);
          }
          const availableExpertIds = applied.participants
            .filter(
              (expert) =>
                expert.kind === 'expert' &&
                expert.available &&
                expert.instructions.trim() &&
                !expert.origin?.missing.length &&
                workbench.participants.some(
                  (current) =>
                    current.id === expert.id && current.kind === 'expert' && current.available,
                ),
            )
            .map((expert) => expert.id);
          // These private clones were fully validated by readRunNode above.
          if (nodes.some((node) => splitExecutionReviewRecord(node).review !== undefined))
            requireExecutionReviewWriter(this.readRunGlobal());
          return { receipt: receipt && structuredClone(receipt), nodes, availableExpertIds };
        };
        return {
          memberId,
          signal,
          facts,
          assertDrained: (node, run) => {
            facts(true);
            if (!migrationDrain || host.migrationDrain !== migrationDrain)
              throw new ExecutionWorkflowError('workflow-recovery-required');
            const proof = migrationDrain.call(host, executionRunScope(node, run));
            if (
              !proof ||
              !(proof.signal instanceof AbortSignal) ||
              proof.signal.aborted ||
              typeof proof.assertCurrent !== 'function'
            )
              throw new ExecutionWorkflowError('workflow-recovery-required');
            try {
              synchronousRunAssertion(proof.assertCurrent());
            } catch {
              throw new ExecutionWorkflowError('workflow-recovery-required');
            }
          },
          assertReviewDrained: (review) => {
            facts(true);
            this.assertExpertReviewDrained(review.scope);
          },
          initialize: async (requestId) => {
            facts(false);
            const started = await this.startPlanNow(
              { member: { ok: true, memberId, spaceIds: [location.spaceId] } },
              {
                ...location,
                idempotencyKey: `workflow-plan-${createHash('sha256').update(requestId).digest('hex')}`,
              },
              () => {
                facts(false);
              },
            );
            if (!started.ok) throw new ExecutionWorkflowError(started.error.code);
          },
          release: () => release.call(lease),
        };
      },
      write: async (location, receipt) => {
        await this.storage.writePlan(
          planKey(location.taskId, location.planId, location.revision),
          receipt,
        );
      },
      watch: (listener) => {
        const stop = host.onChange(listener);
        this.runChanges.add(listener);
        return () => {
          this.runChanges.delete(listener);
          stop();
        };
      },
    });
    return this.workflowIntents;
  }

  /** Host-only current facts, copied so a consumer cannot mutate the domain's live row. */
  readRunNode(locator: ExecutionNodeLocator): ExecutionNodeRecord | undefined {
    const parsed = draftReadSchema.parse({
      taskId: locator.taskId,
      planId: locator.planId,
      revision: locator.revision,
      nodeId: locator.nodeId,
    });
    const node = this.storage.readNode(nodeRecordKey(parsed));
    if (!node) return undefined;
    if (
      !intactNode(node) ||
      node.taskId !== parsed.taskId ||
      node.planId !== parsed.planId ||
      node.revision !== parsed.revision ||
      node.nodeId !== parsed.nodeId
    )
      throw new ExecutionRunError('run-state-invalid');
    readExecutionRunState(node);
    return structuredClone(node);
  }

  readRunGlobal(): unknown {
    if (!this.storage.readGlobal) throw new ExecutionRunError('run-authority-unavailable');
    return structuredClone(this.storage.readGlobal());
  }

  /** Host composition installs the same genuine member issuer first, then explicitly
   * enables remote admission. No HTTP read or native effect creates a second writer. */
  async enableRemoteRuns(
    options: { readonly fileUploads?: true; readonly independentReviews?: true } = {},
  ): Promise<void> {
    if (options.fileUploads) {
      if (!this.attachments || !this.fileStore) throw new RemoteRunError('remote-unavailable');
      this.remoteFileUploadsEnabled = true;
    }
    const host = this.requireRunHost();
    if (options.independentReviews) {
      if (
        !this.attachments ||
        !this.fileStore ||
        typeof host.prepareReviewResourceCatalog !== 'function'
      )
        throw new RemoteRunError('remote-unavailable');
      this.remoteIndependentReviewsEnabled = true;
    }
    if (!this.storage.writeGlobal) throw new RemoteRunError('remote-unavailable');
    if (!this.remoteRunAuthorities) {
      this.remoteRunAuthorities = new RemoteRunAuthorities({
        signal: this.runLifetime.signal,
        workflow: {
          facts: (lease, target) => {
            if (host !== this.requireRunHost() || host.signal.aborted)
              throw new RemoteRunError('remote-unavailable');
            lease.assertCurrent(target.spaceId);
            const workbench = this.workbench.readWorkbench();
            const task = workbench.tasks.find((item) => item.id === target.taskId);
            if (
              !task ||
              planMembership(workbench, target.taskId, lease.memberId) !== 'allowed' ||
              !workbench.participants.some(
                (item) => item.id === lease.memberId && item.kind === 'human' && item.available,
              )
            )
              throw new RemoteRunError('remote-forbidden');
            const plans = workbench.appliedPlans.filter((plan) => plan.taskId === target.taskId);
            const latest = Math.max(...plans.map((plan) => plan.revision));
            const selected = plans.filter((plan) => plan.revision === latest);
            if (
              selected.length !== 1 ||
              selected[0]!.id !== target.planId ||
              latest !== target.revision
            )
              throw new RemoteRunError('remote-stale-plan');
            const applied = createExecutionHandoff(target, workbench);
            const receipt = this.storage.readPlan(
              planKey(target.taskId, target.planId, target.revision),
            );
            if (!receipt) throw new RemoteRunError('remote-not-found');
            if (
              receipt.remoteWorkflows?.length &&
              executionRunGlobalSchema.parse(this.readRunGlobal()).remoteWorkflowWriter !== 1
            )
              throw new RemoteRunError('remote-unavailable');
            const nodes = createNodeHandoffs(applied).map((handoff) => {
              const node = this.readRunNode({ ...target, nodeId: handoff.nodeId });
              if (!node) throw new RemoteRunError('remote-not-found');
              return node;
            });
            if (!nodes.length) throw new RemoteRunError('remote-not-found');
            this.assertRunNodeAccess(host, lease.memberId, target.spaceId, nodes[0]!);
            const controlledNodeIds = nodes
              .filter((node) =>
                node.handoff.assignee.kind === 'human'
                  ? node.handoff.assignee.id === lease.memberId
                  : node.handoff.assignee.kind === 'expert' &&
                    node.ownerId === lease.memberId &&
                    task.ownerId === lease.memberId,
              )
              .map((node) => node.nodeId);
            const reviewNodeIds = nodes
              .filter(
                (node) =>
                  node.ownerId === lease.memberId &&
                  task.ownerId === lease.memberId &&
                  node.handoff.reviewRequired &&
                  node.handoff.reviewerIds.some((id) =>
                    applied.participants.some(
                      (participant) => participant.id === id && participant.kind === 'expert',
                    ),
                  ),
              )
              .map((node) => node.nodeId);
            const availableExpertIds = applied.participants
              .filter(
                (item) =>
                  item.kind === 'expert' &&
                  item.available &&
                  item.instructions.trim() &&
                  !item.origin?.missing.length &&
                  workbench.participants.some(
                    (current) =>
                      current.id === item.id && current.kind === 'expert' && current.available,
                  ),
              )
              .map((item) => item.id);
            const allNodes = this.storage.listNodes().map((node) => {
              const current = this.readRunNode(node);
              if (!current) throw new RemoteRunError('remote-unavailable');
              return current;
            });
            lease.assertCurrent(target.spaceId);
            return {
              receipt: structuredClone(receipt),
              nodes,
              allNodes,
              controlledNodeIds,
              reviewNodeIds,
              availableExpertIds,
            };
          },
          reviewCandidates: (lease, target, intent) => {
            const result: Extract<RemoteWorkflowCandidate, { kind: 'review' }>[] = [];
            if (!this.remoteIndependentReviewsEnabled) return result;
            const workbench = this.workbench.readWorkbench();
            const applied = createExecutionHandoff(target, workbench);
            const task = workbench.tasks.find((item) => item.id === target.taskId);
            if (task?.ownerId !== lease.memberId) return result;
            for (const handoff of createNodeHandoffs(applied)) {
              const node = this.readRunNode({ ...target, nodeId: handoff.nodeId });
              if (
                !node ||
                !intent.nodeIds.includes(node.nodeId) ||
                node.command.status !== 'in-review' ||
                node.command.upstreamAffected
              )
                continue;
              if (
                readExecutionRunState(node)?.runs.some((run) => run.resources !== 'settled') ||
                readExecutionReviewState(node)?.attempts.some(
                  (attempt) => attempt.resources !== 'settled',
                )
              )
                continue;
              const exact = executionReviewTarget(node, target.spaceId);
              const expectedReviewVersion = readExecutionReviewState(node)?.version ?? 0;
              for (const reviewerId of node.handoff.reviewerIds) {
                if (
                  !applied.participants.some(
                    (participant) => participant.id === reviewerId && participant.kind === 'expert',
                  )
                )
                  continue;
                try {
                  const prepared = this.currentExpertReviewPreparation(host, lease, {
                    requestId: randomUUID(),
                    expectedReviewVersion,
                    target: exact,
                    reviewerRef: { id: reviewerId, version: node.planId },
                    workflow: { intentId: intent.intentId, generation: intent.generation },
                  });
                  result.push({
                    kind: 'review',
                    target: exact,
                    expectedReviewVersion,
                    reviewerRef: prepared.prepared.attempt.scope.review.principal.reviewerRef,
                    workflow: { intentId: intent.intentId, generation: intent.generation },
                  });
                  break;
                } catch (error) {
                  if (
                    !(error instanceof ExecutionReviewError) ||
                    !localReviewUnavailableReasonSchema.safeParse(error.code).success
                  )
                    throw error;
                }
              }
            }
            lease.assertCurrent(target.spaceId);
            return result;
          },
          write: (target, receipt) =>
            this.storage.writePlan(planKey(target.taskId, target.planId, target.revision), receipt),
        },
        resourceHost: host,
        review: {
          signal: this.runLifetime.signal,
          resourceHost: host,
          enabled: () =>
            this.remoteIndependentReviewsEnabled && !!this.attachments && !!this.fileStore,
          enqueue: async (work) => {
            const result = await this.enqueue(async () => ({ ok: true, value: await work() }));
            if (!result.ok) throw new RemoteRunError('remote-unavailable');
            return result.value;
          },
          memberLease: (request) => host.memberLease(request),
          readGlobal: () => this.readRunGlobal(),
          writeGlobal: (next) => this.storage.writeGlobal!(next),
          readNode: (target) => this.readRunNode(target),
          writeNode: (next) => this.writeNode(next, true),
          prepare: (lease, query, configurationId) => {
            const result = this.currentExpertReviewPreparation(host, lease, {
              ...query,
              ...(configurationId === undefined ? {} : { configurationId }),
            });
            this.assertRemoteReviewNode(
              host,
              lease.memberId,
              result.prepared.attempt.scope,
              result.node,
              true,
            );
            return result;
          },
          compose: (preparation, body, catalog) =>
            freezeExecutionReviewComposition({
              ...preparation,
              model: body.payload.model,
              resourceCatalog: catalog,
              tools: {
                readTarget: describeNativeReviewReadTool(),
                completeReview: describeNativeReviewTool(),
              },
            }),
          assertTarget: (actorId, scope, node, current) =>
            this.assertRemoteReviewNode(host, actorId, scope, node, current),
          targetPort: (issuer) => this.remoteReviewTargetPort(issuer),
          stampBallot: (record, reviewerId) => {
            const stamped = withExecutionEvent(record, 'ballot-recorded', reviewerId);
            if (!stamped) throw new RemoteRunError('remote-unavailable');
            return stamped;
          },
          afterCommit: async (record) => {
            if (record.command.status === 'completed') {
              try {
                await this.unlockFrom(record);
              } catch {
                /* Original reconciliation retries. */
              }
            }
          },
        },
        filesEnabled: () => this.remoteFileUploadsEnabled,
        outputFiles: (issuer) => this.createRemoteRunOutputFiles(issuer),
        acceptedFiles: (issuer) => {
          if (!this.remoteFileUploadsEnabled || issuer !== this.remoteRunAuthorities)
            throw new ArtifactUploadError('unavailable');
          const attachments = this.attachments;
          if (!attachments) throw new ArtifactUploadError('unavailable');
          return this.acceptedFilePort<RemoteRunFileGrant>(
            (grant) => issuer.assertFileGrant(grant, 'send'),
            {
              signal: host.signal,
              assertCurrent: (actual) => {
                if (actual !== attachments || issuer !== this.remoteRunAuthorities)
                  throw new ArtifactUploadError('unavailable');
                return undefined;
              },
            },
            () => issuer === this.remoteRunAuthorities,
          );
        },
        inputFiles: (scope, composition) => {
          if (!this.remoteFileUploadsEnabled || !this.attachments || !this.fileStore)
            throw new ArtifactUploadError('unavailable');
          return composition.payload.contextRefs.map((inputRef) => {
            const current = this.currentRunFileInput(scope, inputRef, host, composition);
            return { ...current.source, files: current.infos };
          });
        },
        readNativeFile: (idOrKey) =>
          this.fileStore?.get(idOrKey) ?? this.fileStore?.findByIdempotencyKey(idOrKey),
        verifyOutputFiles: async (records, signal, check) => {
          const job = (async () => {
            for (const record of records) {
              check();
              const verified = await this.verifyOwnedFileBytes(
                record,
                AbortSignal.any([signal, this.fileLifetime.signal, this.runLifetime.signal]),
                check,
                false,
                true,
              );
              try {
                await verified.drain;
                check();
              } finally {
                verified.release();
              }
            }
          })();
          this.fileOperations.add(job);
          try {
            await job;
          } finally {
            this.fileOperations.delete(job);
          }
        },
        enqueue: async (work) => {
          const result = await this.enqueue(async () => ({ ok: true, value: await work() }));
          if (!result.ok)
            throw new RemoteRunError(
              result.error.code === 'run-active' || result.error.code === 'run-workspace-busy'
                ? 'remote-resource-held'
                : result.error.code === 'run-conflict'
                  ? 'remote-conflict'
                  : 'remote-unavailable',
            );
          return result.value;
        },
        memberLease: (request) => host.memberLease(request),
        readGlobal: () => this.readRunGlobal(),
        writeGlobal: (next) => this.storage.writeGlobal!(next),
        readNode: (target) => this.readRunNode(target),
        listNodes: () => this.storage.listNodes(),
        writeNode: (next) => this.writeNode(next, true),
        readInput: (actorId, spaceId, node, sourceNodeId, artifactVersionId) =>
          this.readUpstreamContent(actorId, spaceId, node, sourceNodeId, artifactVersionId),
        prepareDelivery: (record, actorId) => {
          const stamped = withExecutionEvent(
            withoutDeliveryDraft(record),
            'delivery-submitted',
            actorId,
          );
          if (!stamped) throw new RemoteRunError('remote-unavailable');
          return stamped;
        },
        afterDelivery: async (record) => {
          // Artifact and receipt already landed. Original idempotent reconciliation
          // can retry a failed downstream write without another submission.
          if (record.command.status === 'completed') {
            try {
              await this.unlockFrom(record);
            } catch {
              /* Original reconcile retries. */
            }
          }
        },
        assertTarget: (actorId, target, node) => {
          if (host !== this.requireRunHost() || host.signal.aborted)
            throw new RemoteRunError('remote-unavailable');
          this.assertRunNodeAccess(host, actorId, target.spaceId, node);
          this.assertRunController(actorId, node);
          const plans = this.workbench
            .readWorkbench()
            .appliedPlans.filter((plan) => plan.taskId === target.taskId);
          const latest = Math.max(...plans.map((plan) => plan.revision));
          const current = plans.filter((plan) => plan.revision === latest);
          if (
            current.length !== 1 ||
            current[0]!.id !== target.planId ||
            latest !== target.revision
          )
            throw new RemoteRunError('remote-stale-plan');
        },
        ...(host.prepareProjectKnowledge
          ? {
              prepareProjectKnowledge: async (
                request: MemberRequest,
                target: { spaceId: string; taskId: string; planId: string; revision: number },
                signal: AbortSignal,
              ) => {
                const prepare = host.prepareProjectKnowledge!;
                const applied = createExecutionHandoff(target, this.workbench.readWorkbench());
                const query = { spaceId: target.spaceId, projectId: applied.task.projectId };
                if (host !== this.requireRunHost() || host.signal.aborted || signal.aborted)
                  throw new RemoteRunError('remote-unavailable');
                const snapshot = await prepare.call(host, request, query, signal);
                if (
                  host !== this.requireRunHost() ||
                  host.prepareProjectKnowledge !== prepare ||
                  host.signal.aborted ||
                  signal.aborted
                )
                  throw new RemoteRunError('remote-unavailable');
                return snapshot;
              },
            }
          : {}),
        ...(host.prepareTeamAssetFiles
          ? {
              prepareTeamAssetFiles: async (
                request: MemberRequest,
                target: { spaceId: string; taskId: string; planId: string; revision: number },
                signal: AbortSignal,
              ) => {
                const prepare = host.prepareTeamAssetFiles!;
                const applied = createExecutionHandoff(target, this.workbench.readWorkbench());
                if (host !== this.requireRunHost() || host.signal.aborted || signal.aborted)
                  throw new RemoteRunError('remote-unavailable');
                const value = await prepare.call(
                  host,
                  request,
                  { spaceId: target.spaceId, references: applied.task.fileRefs ?? [] },
                  signal,
                );
                if (
                  host !== this.requireRunHost() ||
                  host.prepareTeamAssetFiles !== prepare ||
                  host.signal.aborted ||
                  signal.aborted
                )
                  throw new RemoteRunError('remote-unavailable');
                return value;
              },
            }
          : {}),
        ...(host.qualifyTeamAssetFile
          ? {
              qualifyTeamAssetFile: async (
                request: MemberRequest,
                reference: MemberAssetReference,
                signal: AbortSignal,
              ) => {
                const qualify = host.qualifyTeamAssetFile!;
                if (host !== this.requireRunHost() || host.signal.aborted || signal.aborted)
                  throw new RemoteRunError('remote-unavailable');
                const value = await qualify.call(host, request, reference, signal);
                if (
                  host !== this.requireRunHost() ||
                  host.qualifyTeamAssetFile !== qualify ||
                  host.signal.aborted ||
                  signal.aborted
                )
                  throw new RemoteRunError('remote-unavailable');
                return value;
              },
            }
          : {}),
        compose: (actorId, request, node, scope, resourceCatalog, projectKnowledge, teamAssets) => {
          const workbench = this.workbench.readWorkbench();
          const applied = createExecutionHandoff(request.payload.target, workbench);
          if (
            applied.task.fileRefs?.length &&
            request.payload.capabilities.teamAssets !== 'zhuma-native-team-assets@1'
          )
            throw new RemoteRunError('remote-protocol-unsupported');
          const files =
            request.payload.capabilities.resultIntent === 'zhuma-native-result-intent@2';
          const descriptor = files
            ? describeNativeResultPublicationsTool()
            : describeNativeResultTool();
          const publisher = files ? describeNativeOutputFileTool() : undefined;
          if (
            descriptor.name !== 'complete_work' ||
            descriptor.sourceVersion !==
              (files ? 'zhuma-native-result-intent@2' : 'zhuma-native-result-intent@1')
          )
            throw new RemoteRunError('remote-protocol-unsupported');
          if (
            publisher &&
            (publisher.name !== 'publish_output_file' ||
              publisher.sourceVersion !== 'zhuma-native-output-file@1')
          )
            throw new RemoteRunError('remote-protocol-unsupported');
          const definitions = request.payload.capabilities.localTools
            .filter((tool) => tool.name !== 'bash')
            .map((tool) => {
              const { name, description, parameters, outputSchema, sourceVersion } = tool;
              if (name === 'bash') throw new RemoteRunError('remote-protocol-unsupported');
              return { name, description, parameters, outputSchema, sourceVersion };
            });
          const shell = request.payload.capabilities.localTools.find(
            (tool) => tool.name === 'bash',
          );
          const acceptedInputReader = node.handoff.inputRefs.length
            ? describeAcceptedInputTool()
            : undefined;
          let tools: ExecutionCompositionTools;
          if (definitions.length) {
            if (shell && !shell.budget) throw new RemoteRunError('remote-protocol-unsupported');
            tools = {
              kind: 'local-tools',
              definitions,
              ...(shell?.budget
                ? { shell: { ...shell, name: 'bash' as const, budget: shell.budget } }
                : {}),
              ...(acceptedInputReader ? { acceptedInputReader } : {}),
            };
          } else {
            if (shell) throw new RemoteRunError('remote-protocol-unsupported');
            tools = acceptedInputReader
              ? { kind: 'accepted-input-reader', definition: acceptedInputReader }
              : { kind: 'text-only' };
          }
          return freezeExecutionRunComposition({
            workbench,
            node,
            scope,
            model: request.payload.model,
            executor: request.payload.executor,
            ...(resourceCatalog ? { resourceCatalog } : {}),
            ...(projectKnowledge ? { projectKnowledge } : {}),
            ...(teamAssets ? { teamAssets, teamAssetTool: describeTeamAssetFileTool() } : {}),
            inputs: {
              actorId,
              ...request.payload.target,
              items: upstreamInputsFor(
                node,
                this.storage
                  .listNodes()
                  .filter((source) => samePlan(source, node.taskId, node.planId, node.revision)),
              ),
            },
            tools,
            ...(request.payload.capabilities.knowledge
              ? { knowledgeTool: describeMemberKnowledgeTool() }
              : {}),
            ...(request.payload.capabilities.acceptedFile
              ? {
                  acceptedFileReader: {
                    ...describeNativeAcceptedFileTool(),
                    name: 'read_accepted_file' as const,
                    sourceVersion: 'zhuma-accepted-files@2' as const,
                  },
                }
              : {}),
            resultIntentTool: {
              ...descriptor,
              name: descriptor.name,
              sourceVersion: files
                ? 'zhuma-native-result-intent@2'
                : 'zhuma-native-result-intent@1',
            },
            ...(publisher
              ? {
                  outputFilePublisherTool: {
                    ...publisher,
                    name: 'publish_output_file',
                    sourceVersion: 'zhuma-native-output-file@1',
                  },
                }
              : {}),
          });
        },
      });
      host.signal.addEventListener('abort', () => this.remoteRunAuthorities?.fence(), {
        once: true,
      });
    }
    await this.remoteRunAuthorities.enable();
  }

  /** A's product HTTP transport forwards the original request and private header.
   * This method never starts a native Agent on the shared backend. */
  openRemoteTeamAssetFile(
    request: MemberRequest,
    raw: unknown,
    rawPrivatePermit: unknown,
    signal: AbortSignal,
  ): Promise<RemoteTeamAssetFileReadGrant> {
    if (!this.remoteRunAuthorities)
      return Promise.reject(new RemoteRunError('remote-protocol-unsupported'));
    return this.remoteRunAuthorities.openTeamAssetFile(request, raw, rawPrivatePermit, signal);
  }

  remoteRun(
    request: MemberRequest,
    body: unknown,
    privatePermit?: string,
    upload?: RemoteRunUpload,
  ) {
    if (!this.remoteRunAuthorities)
      return Promise.resolve({
        ok: false as const,
        error: { code: 'remote-unavailable' as const },
      });
    return this.remoteRunAuthorities.handle(request, body, privatePermit, upload);
  }

  readRunComposition(locator: ExecutionRunLocator): FrozenExecutionRunComposition {
    const node = this.readRunNode(locator);
    const run =
      node && readExecutionRunState(node)?.runs.find((item) => item.attempt.id === locator.runId);
    if (!run?.composition) throw new ExecutionRunCompositionError('composition-invalid');
    return readExecutionRunComposition(run.composition);
  }

  /** Host-only preparation for this node's current controller, independent of human inbox items. */
  readRunCompositionInputs(
    request: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionRunCompositionInputs>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(runCompositionInputsSchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.withRunMember(
        request,
        input,
        async (host, lease) => {
          const visible = await this.readableRecords(
            [input.spaceId],
            lease.memberId,
            input.spaceId,
          );
          const { node, items } = this.currentRunCompositionInputs(host, lease, input, visible);
          return {
            ok: true,
            value: structuredClone({
              actorId: lease.memberId,
              spaceId: input.spaceId,
              taskId: node.taskId,
              planId: node.planId,
              revision: node.revision,
              nodeId: node.nodeId,
              items,
            }),
          };
        },
        false,
      );
    });
  }

  /** Explicit opt-in only, after guards are installed. Reads and startup never enable it. */
  enableRunWriter(): Promise<ExecutionResult<void>> {
    return this.enqueue(async () => {
      this.requireRunHost();
      if (!this.storage.writeGlobal) throw new ExecutionRunError('run-authority-unavailable');
      await enableExecutionRunWriter(
        () => this.readRunGlobal(),
        (next) => this.storage.writeGlobal!(next),
        this.storage.listNodes(),
      );
      return { ok: true, value: undefined };
    });
  }

  /** Passive Host facts for A's real configuration producer. The candidate scope
   * has no durable reservation, model selection, grant, or dispatch authority. */
  readExpertReviewPreparation(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionReviewPreparation>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(expertReviewPreparationSchema, body);
      if (!parsed.ok) return parsed;
      return this.withRunMember(
        original,
        parsed.value.target,
        async (host, lease) => {
          const decision = this.currentExpertReviewPreparation(host, lease, parsed.value);
          return {
            ok: true,
            value: structuredClone({
              scope: decision.prepared.attempt.scope,
              applied: decision.applied,
              node: decision.node,
            }),
          };
        },
        false,
        'review',
      );
    });
  }

  /** Host-only preparation, not native dispatch or a grant. ConfigurationId is a
   * reservation reference; actual prompt/model/tool configuration is still a later gate. */
  prepareExpertReview(
    original: MemberRequest,
    body: unknown,
    workflowClaim?: WorkflowExecutionClaim,
  ): Promise<
    ExecutionResult<{ disposition: 'applied' | 'replayed'; attempt: ExecutionReviewAttempt }>
  > {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(expertReviewPrepareSchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.withRunMember(
        original,
        input.target,
        async (host, lease) => {
          const prepare = () => {
            this.assertWorkflowReviewPreparation(original, workflowClaim, input);
            return this.currentExpertReviewPreparation(host, lease, input).prepared;
          };
          const proposed = prepare();
          if (proposed.disposition === 'replayed') {
            this.bindWorkflowReview(original, workflowClaim, input.requestId, proposed.attempt);
            return {
              ok: true,
              value: structuredClone({
                disposition: proposed.disposition,
                attempt: proposed.attempt,
              }),
            };
          }
          if (!this.storage.writeGlobal) throw new ExecutionRunError('run-authority-unavailable');
          await enableExecutionReviewWriter(
            () => this.readRunGlobal(),
            (next) => this.storage.writeGlobal!(next),
            this.storage.listNodes(),
          );
          // Marker-only is a safe crash prefix. Fresh membership, target and state
          // are checked after that await and immediately before the original node put.
          const decision = prepare();
          lease.assertCurrent(input.target.spaceId);
          if (decision.disposition === 'applied') {
            const stored = await this.persist(() => this.writeNode(decision.record, true));
            if (!stored.ok) return stored;
          }
          this.bindWorkflowReview(original, workflowClaim, input.requestId, decision.attempt);
          return {
            ok: true,
            value: structuredClone({
              disposition: decision.disposition,
              attempt: decision.attempt,
            }),
          };
        },
        false,
        'review',
      );
    });
  }

  /** Qualify and persist only. A native driver still needs a separate genuine
   * drive capability and the original C owner; this method never sends. */
  admitExpertReview(
    original: MemberRequest,
    body: unknown,
  ): Promise<
    ExecutionResult<{
      disposition: 'applied' | 'replayed' | 'ignored';
      attempt: ExecutionReviewAttempt;
    }>
  > {
    return this.enqueue(async () => {
      // Like the author composition, scope fields inside this strict snapshot
      // are data compared with the real lease. Other command fields keep the scan.
      const fields =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'composition'))
          : body;
      const actorField = this.actorField(fields);
      if (actorField) return actorField;
      const parsed = parseBody(expertReviewAdmitSchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      let composition: FrozenExecutionReviewComposition;
      try {
        composition = readExecutionReviewComposition(input.composition);
      } catch {
        return fail('review-validation');
      }
      return this.withRunMember(
        original,
        input,
        async (host, lease, node) => {
          requireExecutionReviewWriter(this.readRunGlobal());
          const state = readExecutionReviewState(node);
          const attempt = state?.attempts.find((item) => item.scope.runId === input.runId);
          const receipt = state?.receipts.find((item) => item.runId === input.runId);
          if (!attempt || !receipt || ('remote' in attempt && attempt.remote))
            throw new ExecutionReviewError('review-not-prepared');
          const current = () => {
            this.assertWorkflowReviewBinding(node, attempt, composition);
            return this.currentExpertReviewPreparation(host, lease, {
              requestId: receipt.requestId,
              expectedReviewVersion: state!.version,
              target: attempt.scope.review.target,
              reviewerRef: {
                id: attempt.scope.review.principal.reviewerRef.id,
                version: node.planId,
              },
              configurationId: attempt.configurationId,
            });
          };
          current();
          if (typeof host.assertReviewConfiguration !== 'function')
            throw new ExecutionRunError('run-authority-unavailable');
          synchronousRunAssertion(
            host.assertReviewConfiguration(lease.memberId, input.spaceId, node, composition),
          );
          // A producer may synchronously invalidate its source. Re-read true
          // membership, current expert and exact target after that assertion.
          const fresh = current();
          const decision = admitExecutionReview(fresh.node, {
            scope: attempt.scope,
            expectedAttemptVersion: input.expectedAttemptVersion,
            composition,
          });
          if (decision.disposition === 'applied') {
            const stored = await this.persist(() => this.writeNode(decision.record, true));
            if (!stored.ok) return stored;
          }
          return {
            ok: true,
            value: structuredClone({
              disposition: decision.disposition,
              attempt: decision.attempt,
            }),
          };
        },
        true,
        'review',
      );
    });
  }

  /** Copy persisted fixed-round facts without repairing nodes or admitting review work. */
  readReviewOutcome(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ReviewOutcomeView>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(reviewOutcomeQuerySchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.withRunMember(
        original,
        input,
        async (host, lease, node) => {
          const workbench = this.workbench.readWorkbench();
          const plans = workbench.appliedPlans.filter((plan) => plan.taskId === node.taskId);
          const latest = Math.max(...plans.map((plan) => plan.revision));
          const selected = plans.filter((plan) => plan.revision === latest);
          const round = node.rounds.find((item) => item.id === input.roundId);
          const artifact = node.artifactVersions.find(
            (item) => item.id === input.artifactVersionId,
          );
          if (
            selected.length !== 1 ||
            selected[0]!.id !== node.planId ||
            latest !== node.revision ||
            !node.handoff.reviewRequired ||
            !round ||
            round.artifactVersionId !== input.artifactVersionId ||
            !artifact ||
            artifact.nodeId !== node.nodeId
          )
            throw new ExecutionReviewError('review-target-stale');
          const applied = createExecutionHandoff(node, workbench);
          const ballots = round.ballots.map((ballot) => {
            const reviewer = applied.participants.find((item) => item.id === ballot.reviewerId);
            if (!reviewer || !round.reviewerIds.includes(reviewer.id))
              throw new ExecutionReviewError('review-plan-mismatch');
            return { ...ballot, reviewerName: reviewer.name };
          });
          const cited = new Set(
            round.ballots.flatMap((ballot) => ballot.unresolvedCommentIds ?? []),
          );
          const value = reviewOutcomeSchema.parse({
            controllerMemberId: lease.memberId,
            target: { ...input, artifactFingerprint: executionReviewArtifactFingerprint(artifact) },
            nodeStatus: node.command.status,
            artifact: {
              id: artifact.id,
              version: artifact.version,
              ...(artifact.text === undefined ? {} : { text: artifact.text }),
              links: artifact.links,
              files: artifact.files.map(({ id, mediaType, byteSize }) => ({
                id,
                mediaType,
                byteSize,
              })),
            },
            round: { ...round, ballots },
            comments: node.comments.filter(
              (comment) =>
                (comment.versionId === undefined || comment.versionId === artifact.id) &&
                (comment.targetId === undefined || comment.targetId === artifact.id) &&
                (comment.versionId === artifact.id ||
                  comment.targetId === artifact.id ||
                  cited.has(comment.id)),
            ),
          });
          this.assertRunNodeAccess(host, lease.memberId, input.spaceId, node);
          this.assertReviewController(lease.memberId, node);
          lease.assertCurrent(input.spaceId);
          return { ok: true, value: structuredClone(value) };
        },
        false,
        'review',
      );
    });
  }

  /** Passive exact target discovery: never creates a marker, reservation, or grant. */
  readLocalReviewOptions(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<LocalReviewOptions>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(localReviewOptionsQuerySchema, body);
      if (!parsed.ok) return parsed;
      const input = parsed.value;
      return this.withRunMember(
        original,
        input,
        async (host, lease, node) => {
          const target = executionReviewTarget(node, input.spaceId);
          if (
            target.roundId !== input.roundId ||
            target.artifactVersionId !== input.artifactVersionId
          )
            throw new ExecutionReviewError('review-target-stale');
          const workbench = this.workbench.readWorkbench();
          const applied = createExecutionHandoff(node, workbench);
          const latest = Math.max(
            ...workbench.appliedPlans
              .filter((p) => p.taskId === node.taskId)
              .map((p) => p.revision),
          );
          if (
            latest !== node.revision ||
            workbench.appliedPlans.filter((p) => p.taskId === node.taskId && p.revision === latest)
              .length !== 1
          )
            throw new ExecutionReviewError('review-target-stale');
          const state = readExecutionReviewState(node);
          const expectedReviewVersion = state?.version ?? 0;
          const round = node.rounds.find((item) => item.id === target.roundId)!;
          const reviewers: LocalReviewOptions['reviewers'] = [];
          for (const reviewerId of node.handoff.reviewerIds) {
            if (!round.reviewerIds.includes(reviewerId)) continue;
            const reviewer = applied.participants.find((p) => p.id === reviewerId);
            if (!reviewer) throw new ExecutionReviewError('review-plan-mismatch');
            if (reviewer.kind !== 'expert') continue;
            const reviewerRef = {
              id: reviewer.id,
              version: applied.id,
              digest: createHash('sha256').update(canonicalPayload(reviewer)).digest('hex'),
            };
            try {
              // The original getter derives a disposable pure candidate only.
              // No reservation/marker is persisted and no candidate scope is returned.
              this.currentExpertReviewPreparation(host, lease, {
                requestId: `local-review-options-${randomUUID()}`,
                expectedReviewVersion,
                target,
                reviewerRef: { id: reviewerRef.id, version: reviewerRef.version },
              });
              reviewers.push({ name: reviewer.name, reviewerRef, canStart: true });
            } catch (error) {
              const reason =
                error instanceof ExecutionReviewError
                  ? localReviewUnavailableReasonSchema.safeParse(error.code)
                  : undefined;
              if (!reason?.success) throw error;
              reviewers.push({
                name: reviewer.name,
                reviewerRef,
                canStart: false,
                unavailableReason: reason.data,
              });
            }
          }
          lease.assertCurrent(input.spaceId);
          return {
            ok: true,
            value: localReviewOptionsSchema.parse({
              controllerMemberId: lease.memberId,
              target,
              expectedReviewVersion,
              reviewers,
              attempts: (state?.attempts ?? [])
                .filter(
                  (attempt) =>
                    canonicalPayload(attempt.scope.review.target) === canonicalPayload(target),
                )
                .map((attempt) => ({
                  scope: attempt.scope,
                  version: attempt.version,
                  status: attempt.status,
                  dispatch: attempt.dispatch,
                  resources: attempt.resources,
                  ...('stopPhase' in attempt ? { stopPhase: attempt.stopPhase } : {}),
                  ...('remote' in attempt && attempt.remote
                    ? {
                        remoteScope: {
                          ...attempt.scope,
                          backendId: attempt.remote.backendId,
                        },
                      }
                    : {}),
                })),
            }),
          };
        },
        false,
        'review',
      );
    });
  }

  /** Passive exact target discovery: never creates a marker, reservation, or grant. */
  readExpertReviewTarget(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionReviewTarget>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(
        z.strictObject({
          spaceId: id,
          taskId: id,
          planId: id,
          revision: z.number().int().positive(),
          nodeId: id,
        }),
        body,
      );
      if (!parsed.ok) return parsed;
      return this.withRunMember(
        original,
        parsed.value,
        async (_host, _lease, node) => ({
          ok: true,
          value: executionReviewTarget(node, parsed.value.spaceId),
        }),
        false,
        'review',
      );
    });
  }

  /** Genuine read-only capability. No native session/model send or ballot rights. */
  openExpertReviewRead(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<OpenedExecutionReviewRead>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(
        z.strictObject({
          spaceId: id,
          taskId: id,
          planId: id,
          revision: z.number().int().positive(),
          nodeId: id,
          runId: id,
        }),
        body,
      );
      if (!parsed.ok) return parsed;
      const host = this.requireRunHost();
      const resolve = (locator: ExecutionReviewReadLocator) => {
        requireExecutionReviewWriter(this.readRunGlobal());
        const node = this.readRunNode(locator);
        const attempt =
          node &&
          readExecutionReviewState(node)?.attempts.find(
            (item) => item.scope.runId === locator.runId,
          );
        if (!node || !attempt || ('remote' in attempt && attempt.remote))
          throw new ExecutionReviewReadError('review-authority-denied');
        return { scope: attempt.scope, version: attempt.version };
      };
      this.reviewReadAuthorities ??= new ExecutionReviewReadAuthorities({
        signal: AbortSignal.any([host.signal, this.runLifetime.signal]),
        memberLease: (request) => host.memberLease(request),
        resolve,
        assertCurrent: (scope, version) => {
          if (host !== this.requireRunHost())
            throw new ExecutionReviewReadError('review-authority-denied');
          const current = resolve(scope);
          if (
            current.version !== version ||
            canonicalPayload(current.scope) !== canonicalPayload(scope)
          )
            throw new ExecutionReviewReadError('review-target-changed');
          this.assertCurrentExpertReviewTarget(host, scope);
        },
        onChange: (recheck) => {
          const stop = host.onChange(recheck);
          this.runChanges.add(recheck);
          return () => {
            this.runChanges.delete(recheck);
            stop();
          };
        },
      });
      return { ok: true, value: await this.reviewReadAuthorities.open(original, parsed.value) };
    });
  }

  /** Owner identity is checked before inspecting any purported grant fields. */
  assertExpertReviewReadGrant(grant: ExecutionReviewReadGrant): void {
    if (!this.reviewReadAuthorities) throw new ExecutionReviewReadError('review-authority-denied');
    this.reviewReadAuthorities.assertGrant(grant);
  }

  /** Separate genuine drive issuer, after durable admission and real A source
   * qualification. No read grant or JSON object is accepted as a promotion. */
  openExpertReviewDrive(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<OpenedExecutionReviewDrive>> {
    return this.enqueue(async () => {
      const actor = this.actorField(body);
      if (actor) return actor;
      const parsed = parseBody(
        expertReviewAdmitSchema.omit({ expectedAttemptVersion: true, composition: true }),
        body,
      );
      if (!parsed.ok) return parsed;
      return { ok: true, value: await this.reviewDrives().open(original, parsed.value) };
    });
  }

  /** Original Host recovery only. Externally requested cleanup still requires A's
   * fresh member and complete workflow-bound ID checks before this internal call. */
  reviewCleanupAfterCommit(scope: ExecutionReviewScope): ExecutionReviewCleanupAuthority {
    return this.reviewDrives().cleanupAfterCommit(scope);
  }

  private reviewDrives(): ExecutionReviewDriveAuthorities {
    const host = this.requireReviewCleanupHost();
    const resolve = (locator: ExecutionReviewReadLocator) => {
      if (host !== this.requireReviewCleanupHost())
        throw new ExecutionReviewReadError('review-authority-denied');
      requireExecutionReviewWriter(this.readRunGlobal());
      const node = this.readRunNode(locator);
      const attempt =
        node &&
        splitExecutionReviewRecord(node).review?.attempts.find(
          (a) => a.scope.runId === locator.runId,
        );
      if (!node || !attempt || attempt.status === 'prepared' || attempt.remote)
        throw new ExecutionReviewReadError('review-authority-denied');
      const composition = readExecutionReviewComposition(attempt.composition);
      return {
        node,
        attempt,
        composition,
        scope: attempt.scope,
        // This same resolve already fully validated and froze the composition.
        selection: Object.freeze({
          ...composition.payload.model,
          configurationId: composition.configurationId,
        }),
      };
    };
    this.reviewDriveAuthorities ??= new ExecutionReviewDriveAuthorities({
      signal: AbortSignal.any([host.signal, this.runLifetime.signal]),
      memberLease: (request) => host.memberLease(request),
      resolve,
      assertCurrent: (scope, selection, _action) => {
        this.requireRunHost();
        const check = () => {
          const current = resolve(scope);
          this.assertCurrentExpertReviewTarget(host, scope, current.node);
          if (
            !['requested', 'running'].includes(current.attempt.status) ||
            current.attempt.resources !== 'held' ||
            current.attempt.stopPhase !== 'none' ||
            canonicalPayload(current.scope) !== canonicalPayload(scope) ||
            canonicalPayload(current.selection) !== canonicalPayload(selection)
          )
            throw new ExecutionReviewReadError('review-target-changed');
          return current;
        };
        const current = check();
        if (typeof host.assertReviewConfiguration !== 'function')
          throw new ExecutionReviewReadError('review-authority-denied');
        synchronousRunAssertion(
          host.assertReviewConfiguration(
            scope.actorId,
            scope.spaceId,
            current.node,
            current.composition,
          ),
        );
        check();
        return undefined;
      },
      assertCleanup: (scope, selection) => {
        // Retire this exact already admitted scope even after member/target
        // revocation. This cannot drive, vote, or prove drain by itself.
        const current = resolve(scope);
        if (
          canonicalPayload(current.scope) !== canonicalPayload(scope) ||
          canonicalPayload(current.selection) !== canonicalPayload(selection)
        )
          throw new ExecutionReviewReadError('review-target-changed');
        return undefined;
      },
      assertCleanupAfterCommit: (scope, selection) => {
        const current = resolve(scope);
        if (
          canonicalPayload(current.scope) !== canonicalPayload(scope) ||
          canonicalPayload(current.selection) !== canonicalPayload(selection) ||
          (!['completed', 'failed', 'cancelled'].includes(current.attempt.status) &&
            current.attempt.stopPhase !== 'requested')
        )
          throw new ExecutionReviewReadError('review-authority-denied');
        return undefined;
      },
      onChange: (recheck) => {
        const stop = host.onChange(recheck);
        this.runChanges.add(recheck);
        return () => {
          this.runChanges.delete(recheck);
          stop();
        };
      },
    });
    return this.reviewDriveAuthorities;
  }
  assertExpertReviewDriveGrant(grant: ExecutionReviewDriveGrant, action: NativeWorkAction): void {
    if (!this.reviewDriveAuthorities) throw new ExecutionReviewReadError('review-authority-denied');
    this.reviewDriveAuthorities.assertGrant(grant, action);
  }
  assertExpertReviewCleanupAuthority(authority: ExecutionReviewCleanupAuthority): void {
    if (!this.reviewDriveAuthorities) throw new ExecutionReviewReadError('review-authority-denied');
    this.reviewDriveAuthorities.assertCleanup(authority);
  }

  /** Owner Stop remains possible after the expert/model/target stopped being
   * dispatchable. This only requests Stop; C's actual cleanup certifies it. */
  requestExpertReviewStop(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionReviewAttempt>> {
    return this.enqueue(async () => {
      const actor = this.actorField(body);
      if (actor) return actor;
      const parsed = parseBody(expertReviewAdmitSchema.omit({ composition: true }), body);
      if (!parsed.ok) return parsed;
      return this.withRunMember(
        original,
        parsed.value,
        async (_host, lease) => {
          const { node, attempt } = this.nativeReviewFacts(parsed.value);
          if (attempt.scope.actorId !== lease.memberId)
            throw new ExecutionReviewReadError('review-authority-denied');
          if (
            attempt.stopPhase !== 'none' ||
            ['completed', 'failed', 'cancelled'].includes(attempt.status)
          )
            return { ok: true, value: structuredClone(attempt) };
          if (attempt.version !== parsed.value.expectedAttemptVersion)
            throw new ExecutionReviewError('review-conflict');
          const decision = recordExecutionReviewEvent(node, {
            scope: attempt.scope,
            kind: 'stop-requested',
            sequence: attempt.lastEventSequence + 1,
          });
          synchronousRunAssertion(lease.assertCurrent(parsed.value.spaceId));
          const stored = await this.persist(() => this.writeNode(decision.record, true));
          return stored.ok ? { ok: true, value: structuredClone(decision.attempt) } : stored;
        },
        true,
        'review',
      );
    });
  }

  /** The original cleanup capability survives member/expert revocation. It can
   * only stop and retire its own original scope, never drive or cast a ballot. */
  retireExpertReviewForCleanup(
    original: ExecutionReviewCleanupAuthority,
    wait: AbortSignal = this.reviewCleanupLifetime.signal,
  ): Promise<ExecutionResult<{ status: 'pending' | 'settled' }>> {
    return this.nativeResultOperation<{ status: 'pending' | 'settled' }>(
      wait,
      async (operation) => {
        this.assertExpertReviewCleanupAuthority(original); // Before reading claimed fields.
        const stopped = await this.enqueue(() => this.requestCleanupStop(original, operation));
        if (!stopped.ok) return stopped;
        return this.settleNativeReviewCleanupNow(original.scope, operation);
      },
      true,
    );
  }

  /** Cold Host recovery from the original committed workflow Stop, not a scope
   * supplied as permission. Unknown, manual or a different generation stays held. */
  recoverStoppedWorkflowReviewCleanup(
    raw: ExecutionReviewScope,
    wait: AbortSignal = this.reviewCleanupLifetime.signal,
  ): Promise<ExecutionResult<{ status: 'pending' | 'settled' }>> {
    return this.nativeResultOperation<{ status: 'pending' | 'settled' }>(
      wait,
      async (operation) => {
        const scope = executionReviewScopeSchema.parse(raw);
        const stopped = await this.enqueue(async () => {
          operation.check();
          const { node, attempt } = this.nativeReviewFacts(scope);
          if (canonicalPayload(attempt.scope) !== canonicalPayload(scope))
            throw new ExecutionReviewReadError('review-authority-denied');
          const plan = this.storage.readPlan(planKey(scope.taskId, scope.planId, scope.revision));
          const parsed = workflowExecutionIntentSchema.safeParse(plan?.workflowExecution);
          const receipt = readExecutionReviewState(node)!.receipts.find(
            (item) => item.runId === scope.runId,
          );
          const stoppedGeneration = parsed.success
            ? stoppedWorkflowReviewGeneration(node, parsed.data, attempt)
            : undefined;
          // Resume preserves terminal history but a cold owner loses its live
          // drain. Rebuild only that stopped history, never a new driving scope.
          const historicalStop =
            parsed.success &&
            parsed.data.status === 'running' &&
            stoppedGeneration !== undefined &&
            stoppedGeneration < parsed.data.generation &&
            isStoppedReviewHistory(attempt);
          if (
            !parsed.success ||
            node.ownerId !== scope.actorId ||
            !plan?.nodeIds.includes(scope.nodeId) ||
            (!historicalStop &&
              (parsed.data.status !== 'stopping' ||
                !hasCommittedWorkflowStop(node, parsed.data, parsed.data.generation))) ||
            parsed.data.actorId !== scope.actorId ||
            parsed.data.spaceId !== scope.spaceId ||
            !receipt ||
            stoppedGeneration === undefined
          )
            throw new ExecutionReviewReadError('review-authority-denied');
          if (attempt.stopPhase === 'none' && ['requested', 'running'].includes(attempt.status)) {
            const decision = recordExecutionReviewEvent(node, {
              scope,
              kind: 'stop-requested',
              sequence: attempt.lastEventSequence + 1,
            });
            const stored = await this.persist(() => this.writeNode(decision.record, true));
            if (!stored.ok) return stored;
          }
          return { ok: true as const, value: undefined };
        });
        return stopped.ok ? this.settleNativeReviewCleanupNow(scope, operation) : stopped;
      },
      true,
    );
  }

  private async requestCleanupStop(
    original: ExecutionReviewCleanupAuthority,
    operation: NativeResultOperation,
  ): Promise<ExecutionResult<void>> {
    operation.check();
    this.assertExpertReviewCleanupAuthority(original);
    const { node, attempt } = this.nativeReviewFacts(original.scope);
    if (canonicalPayload(attempt.scope) !== canonicalPayload(original.scope))
      throw new ExecutionReviewReadError('review-authority-denied');
    if (attempt.stopPhase === 'none' && ['requested', 'running'].includes(attempt.status)) {
      const decision = recordExecutionReviewEvent(node, {
        scope: attempt.scope,
        kind: 'stop-requested',
        sequence: attempt.lastEventSequence + 1,
      });
      this.assertExpertReviewCleanupAuthority(original);
      const stored = await this.persist(() => this.writeNode(decision.record, true));
      if (!stored.ok) return stored;
    }
    return { ok: true, value: undefined };
  }

  /** Actual retained C view only. Settled labels and parsed scope cannot mint it;
   * after a cold start explicit C cleanup must re-establish the original view. */
  assertExpertReviewDrained(scope: ExecutionReviewScope): void {
    this.nativeReviews(true);
    const proof = this.reviewDrains.get(canonicalPayload(scope));
    if (
      !proof ||
      proof.drain.signal !== proof.signal ||
      proof.signal.aborted ||
      proof.drain.assertCurrent !== proof.assert
    )
      throw new ExecutionWorkflowError('workflow-recovery-required');
    synchronousRunAssertion(proof.assert.call(proof.drain));
  }

  private assertWorkflowReviewPreparation(
    original: MemberRequest,
    claim: WorkflowExecutionClaim | undefined,
    input: z.infer<typeof expertReviewPrepareSchema>,
  ) {
    if (!input.requestId.startsWith(WORKFLOW_REVIEW_REQUEST_PREFIX)) return;
    if (!claim) throw new ExecutionWorkflowError('workflow-authority-denied');
    const current = this.workflows().assertClaim(original, claim);
    if (
      input.requestId !==
        workflowReviewRequestId(current.intent, input.target, input.reviewerRef.id) ||
      !current.facts.nodes.some(
        (node) =>
          samePlan(node, input.target.taskId, input.target.planId, input.target.revision) &&
          node.nodeId === input.target.nodeId,
      ) ||
      input.target.spaceId !== current.intent.spaceId
    )
      throw new ExecutionWorkflowError('workflow-authority-denied');
    const node = current.facts.nodes.find((node) => node.nodeId === input.target.nodeId)!;
    const prior = readExecutionReviewState(node)?.receipts.some(
      (receipt) => receipt.requestId === input.requestId,
    );
    if (
      !prior &&
      (current.availableSlots <= 0 ||
        !workflowReviewCandidates(
          current.facts.nodes,
          current.intent,
          current.facts.availableExpertIds,
          (review) => this.assertExpertReviewDrained(review.scope),
        ).some((item) => item.requestId === input.requestId))
    )
      throw new ExecutionWorkflowError('workflow-capacity');
    if (!prior && this.reviewWorkflowClaims.size >= 512)
      throw new ExecutionWorkflowError('workflow-capacity');
  }

  private bindWorkflowReview(
    original: MemberRequest,
    claim: WorkflowExecutionClaim | undefined,
    requestId: string,
    attempt: ExecutionReviewAttempt,
  ) {
    if (!requestId.startsWith(WORKFLOW_REVIEW_REQUEST_PREFIX)) return;
    if (!claim) throw new ExecutionWorkflowError('workflow-authority-denied');
    this.workflows().assertClaim(original, claim);
    const prior = this.reviewWorkflowClaims.get(attempt.scope.runId);
    if (prior) return;
    if (this.reviewWorkflowClaims.size >= 512)
      throw new ExecutionWorkflowError('workflow-capacity');
    const abort = () => {
      this.reviewWorkflowClaims.delete(attempt.scope.runId);
      this.notifyRuns();
    };
    claim.signal.addEventListener('abort', abort, { once: true });
    this.reviewWorkflowClaims.set(attempt.scope.runId, {
      original,
      claim,
      dispose: () => claim.signal.removeEventListener('abort', abort),
    });
    if (claim.signal.aborted) abort();
  }

  private assertWorkflowReviewBinding(
    node: ExecutionNodeRecord,
    attempt: ExecutionReviewAttempt,
    composition?: FrozenExecutionReviewComposition,
    admittedDrive = false,
    validatedReview?: ReturnType<typeof readExecutionReviewState>,
  ) {
    const state = validatedReview ?? readExecutionReviewState(node)!;
    const receipt = state.receipts.find((receipt) => receipt.runId === attempt.scope.runId)!;
    if (!receipt.requestId.startsWith(WORKFLOW_REVIEW_REQUEST_PREFIX)) return;
    const bound = this.reviewWorkflowClaims.get(attempt.scope.runId);
    if (!bound) throw new ExecutionWorkflowError('workflow-authority-denied');
    const current =
      admittedDrive && !composition && attempt.status !== 'prepared'
        ? this.workflows().assertClaimCurrent(bound.original, bound.claim)
        : this.workflows().assertClaim(bound.original, bound.claim);
    if (
      receipt.requestId !==
      workflowReviewRequestId(
        current.intent,
        attempt.scope.review.target,
        attempt.scope.review.principal.reviewerRef.id,
      )
    )
      throw new ExecutionWorkflowError('workflow-authority-denied');
    if (composition) {
      // The original Host freezes the independent review budget in the prepared
      // configuration ID. Keep its source assertion and exact admission binding;
      // only the route/reasoning selection is shared with the author's defaults.
      const { maxTokens: _reviewBudget, ...reviewModel } = composition.payload.model;
      const { maxTokens: _authorBudget, ...workflowModel } = current.intent.defaults.model;
      if (canonicalPayload(reviewModel) !== canonicalPayload(workflowModel))
        throw new ExecutionWorkflowError('workflow-authority-denied');
    }
  }

  /** Install views/adapters of A's one original C owner. No Client transport or
   * alternate Agent factory is created by this method. */
  installNativeReviewPorts(ports: ExecutionReviewNativePorts): void {
    this.requireRunHost();
    if (
      this.reviewNativePorts ||
      !ports ||
      !ports.issuer ||
      typeof ports.grantFor !== 'function' ||
      typeof ports.retireForCleanup !== 'function' ||
      [
        'prepareFixedReview',
        'assertFixedReview',
        'readFixedReview',
        'registerNativeReviewTools',
      ].some((key) => typeof Reflect.get(ports.issuer, key) !== 'function')
    )
      throw new ExecutionReviewFixedResultError('review-result-invalid');
    this.reviewNativePorts = Object.freeze({
      original: ports,
      issuer: ports.issuer,
      grantFor: ports.grantFor,
      retireForCleanup: ports.retireForCleanup,
      prepare: ports.issuer.prepareFixedReview,
      assert: ports.issuer.assertFixedReview,
      read: ports.issuer.readFixedReview,
    });
  }

  /** Only A's trusted original native bridge owns the genuine drive object.
   * Terminal events require the fixed-result/cleanup paths below, never JSON. */
  recordNativeReviewEvent(
    grant: ExecutionReviewDriveGrant,
    event: unknown,
  ): Promise<ExecutionResult<{ disposition: string; attempt: ExecutionReviewAttempt }>> {
    return this.enqueue(async () => {
      this.assertExpertReviewDriveGrant(grant, 'send');
      const kind = event && typeof event === 'object' ? Reflect.get(event, 'kind') : undefined;
      if (!['received', 'accepted', 'dispatch-unknown', 'idle'].includes(kind))
        throw new ExecutionReviewFixedResultError('review-result-invalid');
      const facts = this.nativeReviewFacts(grant.scope);
      const result = recordExecutionReviewEvent(facts.node, event);
      if (canonicalPayload(result.attempt.scope) !== canonicalPayload(grant.scope))
        throw new ExecutionReviewFixedResultError('review-result-stale');
      if (result.disposition === 'applied') {
        const stored = await this.persist(() => this.writeNode(result.record, true));
        if (!stored.ok) return stored;
      }
      return {
        ok: true,
        value: structuredClone({ disposition: result.disposition, attempt: result.attempt }),
      };
    });
  }

  /** Passive recovery does not revive a drive, read C again, or resend a model. */
  confirmNativeFixedReview(
    original: MemberRequest,
    body: unknown,
  ): Promise<ExecutionResult<ExecutionReviewNativeOutcome>> {
    return this.enqueue(async () => {
      const actor = this.actorField(body);
      if (actor) return actor;
      const parsed = parseBody(expertReviewNativeSchema, body);
      if (!parsed.ok) return parsed;
      return this.withRunMember(
        original,
        parsed.value,
        async () => {
          const facts = this.nativeReviewFacts(parsed.value);
          const outcome = this.reviewHistoricalOutcome(
            facts.node,
            facts.attempt,
            parsed.value.requestId,
          );
          return outcome
            ? { ok: true, value: structuredClone(outcome) }
            : fail('review-result-not-recorded');
        },
        true,
        'review',
      );
    });
  }

  /** Keep the original drive running+held while C authenticates the read/cut and
   * retires its writer. Only then atomically complete and cast the original ballot. */
  submitNativeFixedReview(
    original: MemberRequest,
    body: unknown,
    grant: ExecutionReviewDriveGrant,
    wait: AbortSignal = this.runLifetime.signal,
  ): Promise<ExecutionResult<ExecutionReviewNativeOutcome>> {
    const actor = this.actorField(body);
    if (actor) return Promise.resolve(actor);
    const parsed = parseBody(expertReviewNativeSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const input = parsed.value;
    return this.nativeResultOperation<ExecutionReviewNativeOutcome>(wait, (operation) =>
      this.withRunMember(
        original,
        input,
        async (host, member) => {
          const memberId = member.memberId,
            expires = member.expiresAt,
            memberSignal = member.signal,
            memberCheck = member.assertCurrent,
            memberRelease = member.release;
          const memberCurrent = () => {
            operation.check();
            if (
              host !== this.requireRunHost() ||
              member.memberId !== memberId ||
              member.expiresAt !== expires ||
              member.signal !== memberSignal ||
              member.assertCurrent !== memberCheck ||
              member.release !== memberRelease ||
              memberSignal.aborted ||
              expires <= Date.now()
            )
              throw new ExecutionReviewReadError('review-authority-denied');
            operation.assert(() => memberCheck.call(member, input.spaceId));
            const node = this.nativeReviewFacts(input).node;
            this.assertRunNodeAccess(host, memberId, input.spaceId, node);
            this.assertReviewController(memberId, node);
            return node;
          };
          const recovered = await this.enqueue(async () => {
            const node = memberCurrent(),
              facts = this.nativeReviewFacts(input);
            const outcome = this.reviewHistoricalOutcome(node, facts.attempt, input.requestId);
            if (outcome && node.command.status === 'completed') {
              const repaired = await this.unlockFrom(node);
              if (!repaired.ok) return repaired;
            }
            return {
              ok: true,
              value: outcome,
            };
          });
          if (!recovered.ok) return recovered;
          if (recovered.value) return { ok: true, value: structuredClone(recovered.value) };
          const driveCurrent = () => {
            const node = memberCurrent();
            this.assertExpertReviewDriveGrant(grant, 'send');
            const current = this.nativeReviewFacts(input);
            if (
              grant.scope.actorId !== memberId ||
              canonicalPayload(grant.scope) !== canonicalPayload(current.attempt.scope)
            )
              throw new ExecutionReviewReadError('review-authority-denied');
            return { node, attempt: current.attempt };
          };
          driveCurrent();
          const port = this.nativeReviews();
          const nativeGrant = port.grantFor.call(port.original, grant);
          const signal = AbortSignal.any([operation.signal, memberSignal, grant.signal]);
          let fixed: ExecutionReviewFixedFacts;
          let live: NativeFixedReviewLease;
          try {
            const prepared = await port.prepare.call(port.issuer, nativeGrant, signal);
            driveCurrent();
            if (prepared.status === 'pending')
              return { ok: true, value: { status: 'pending', reason: prepared.reason } };
            operation.assert(() => port.assert.call(port.issuer, nativeGrant, prepared.ref));
            live = await port.read.call(port.issuer, nativeGrant, prepared.ref, signal);
            const check = live?.check,
              release = live?.release,
              sourceSignal = live?.signal;
            if (
              typeof check !== 'function' ||
              typeof release !== 'function' ||
              !(sourceSignal instanceof AbortSignal)
            )
              throw new ExecutionReviewFixedResultError('review-result-invalid');
            operation.release(() => release.call(live));
            const leaseCurrent = () => {
              driveCurrent();
              if (
                live.check !== check ||
                live.release !== release ||
                live.signal !== sourceSignal ||
                sourceSignal.aborted
              )
                throw new ExecutionReviewFixedResultError('review-result-stale');
              operation.assert(() => port.assert.call(port.issuer, nativeGrant, prepared.ref));
              operation.assert(() => check.call(live));
            };
            leaseCurrent();
            fixed = structuredClone({
              source: live.source,
              content: live.content,
              readManifest: live.readManifest,
              readManifestDigest: live.readManifestDigest,
              digest: live.digest,
              provenanceFingerprint: live.provenanceFingerprint,
            });
            leaseCurrent();
            const committed = await this.enqueue(
              async (): Promise<ExecutionResult<ExecutionReviewNativeOutcome>> => {
                const node = memberCurrent(),
                  { attempt } = this.nativeReviewFacts(input);
                const prior = this.reviewHistoricalOutcome(node, attempt, input.requestId);
                if (prior) return { ok: true, value: structuredClone(prior) };
                driveCurrent();
                leaseCurrent();
                try {
                  const decision = commitExecutionReviewFixedResult(
                    node,
                    grant.scope,
                    input.requestId,
                    fixed,
                  );
                  const stamped = withExecutionEvent(
                    decision.record,
                    'ballot-recorded',
                    grant.scope.review.principal.reviewerRef.id,
                  );
                  if (!stamped) return fail('unavailable');
                  const stored = await this.persist(() => this.writeNode(stamped, true));
                  if (!stored.ok) return stored;
                  if (stamped.command.status === 'completed') {
                    const unlocked = await this.unlockFrom(stamped);
                    if (!unlocked.ok) return unlocked;
                  }
                  return {
                    ok: true,
                    value: {
                      status: 'committed',
                      receipt: structuredClone(decision.receipt),
                      cleanup: 'pending',
                    },
                  };
                } catch (error) {
                  if (
                    !(error instanceof ExecutionReviewFixedResultError) ||
                    error.code !== 'review-read-required'
                  )
                    throw error;
                  const failed = recordExecutionReviewFailure(node, grant.scope, {
                    requestId: input.requestId,
                    code: 'review-read-required',
                    resourceRefs: [...error.resourceRefs],
                  });
                  leaseCurrent();
                  const stored = await this.persist(() => this.writeNode(failed.record, true));
                  if (!stored.ok) return stored;
                  return {
                    ok: true,
                    value: {
                      status: 'needs-attention',
                      failure: structuredClone(failed.failure),
                      cleanup: 'pending',
                    },
                  };
                }
              },
            );
            if (!committed.ok) return committed;
            // Never check/reopen C through a now-terminal drive. Cleanup has its
            // own original issuer and physical certificate after the atomic put.
            const cleanup = await this.finishNativeReviewCleanup(grant.scope, operation);
            return {
              ok: true,
              value: { ...committed.value, cleanup },
            };
          } catch (error) {
            // Another exact operation may have committed while this C lease
            // was being invalidated. Confirm its original receipt without
            // reviving drive or reading C through a now-closed target.
            const raced = await this.enqueue(async () => {
              const node = memberCurrent(),
                { attempt } = this.nativeReviewFacts(input);
              const outcome = this.reviewHistoricalOutcome(node, attempt, input.requestId);
              if (outcome && node.command.status === 'completed') {
                const repaired = await this.unlockFrom(node);
                if (!repaired.ok) return repaired;
              }
              return { ok: true, value: outcome };
            });
            if (!raced.ok) return raced;
            if (raced.value) return { ok: true, value: structuredClone(raced.value) };
            if (
              !(error instanceof NativeReviewError) ||
              ![
                'review-unsupported-material',
                'review-read-budget-exceeded',
                'output-too-large',
                'review-result-rejected',
              ].includes(error.code)
            )
              throw error;
            const failed = await this.enqueue(
              async (): Promise<ExecutionResult<ExecutionReviewNativeOutcome>> => {
                const { node } = driveCurrent();
                const decision = recordExecutionReviewFailure(node, grant.scope, {
                  requestId: input.requestId,
                  code: error.code as ExecutionReviewFailure['code'],
                  resourceRefs: [],
                });
                const stored = await this.persist(() => this.writeNode(decision.record, true));
                return stored.ok
                  ? {
                      ok: true,
                      value: {
                        status: 'needs-attention',
                        failure: structuredClone(decision.failure),
                        cleanup: 'pending',
                      },
                    }
                  : stored;
              },
            );
            if (!failed.ok) return failed;
            const cleanup = await this.finishNativeReviewCleanup(grant.scope, operation);
            return {
              ok: true,
              value: { ...failed.value, cleanup },
            };
          }
        },
        true,
        'review',
      ),
    );
  }

  /** Host-internal explicit recovery, not a passive query or model permission. */
  settleNativeReviewCleanup(
    scope: ExecutionReviewScope,
    wait: AbortSignal = this.reviewCleanupLifetime.signal,
  ): Promise<ExecutionResult<{ status: 'pending' | 'settled' }>> {
    return this.nativeResultOperation<{ status: 'pending' | 'settled' }>(
      wait,
      (operation) => this.settleNativeReviewCleanupNow(scope, operation),
      true,
    );
  }

  private async finishNativeReviewCleanup(
    scope: ExecutionReviewScope,
    operation: NativeResultOperation,
  ): Promise<'pending' | 'settled' | 'failed'> {
    try {
      const result = await this.settleNativeReviewCleanupNow(scope, operation);
      return result.ok ? result.value.status : 'failed';
    } catch {
      return 'failed';
    } // A committed receipt must remain confirmable.
  }

  private async settleNativeReviewCleanupNow(
    scope: ExecutionReviewScope,
    operation: NativeResultOperation,
  ): Promise<ExecutionResult<{ status: 'pending' | 'settled' }>> {
    const authority = this.reviewCleanupAfterCommit(scope),
      port = this.nativeReviews(true);
    this.assertExpertReviewCleanupAuthority(authority);
    const retired = await port.retireForCleanup.call(port.original, authority, operation.signal);
    if (retired.status === 'pending') return { ok: true, value: { status: 'pending' as const } };
    const drain = retired.drain;
    if (
      !(drain?.signal instanceof AbortSignal) ||
      drain.signal.aborted ||
      typeof drain.assertCurrent !== 'function'
    )
      throw new ExecutionReviewFixedResultError('review-result-invalid');
    return this.enqueue(async () => {
      operation.check();
      this.assertExpertReviewCleanupAuthority(authority);
      operation.assert(() => drain.assertCurrent());
      const facts = this.nativeReviewFacts(scope),
        { review: _review, ...nativeScope } = scope;
      if (
        retired.binding &&
        (canonicalPayload(retired.binding.scope) !== canonicalPayload(nativeScope) ||
          retired.binding.selection.configurationId !== facts.attempt.configurationId)
      )
        throw new ExecutionReviewFixedResultError('review-result-stale');
      if (
        facts.attempt.nativeSessionId &&
        (!retired.binding ||
          retired.binding.nativeSessionId !== facts.attempt.nativeSessionId ||
          retired.binding.nativeAgentId !== facts.attempt.nativeAgentId ||
          drain.basis !== 'flushed-and-closed')
      )
        throw new ExecutionReviewFixedResultError('review-result-stale');
      let node = facts.node;
      if (!['completed', 'failed', 'cancelled'].includes(facts.attempt.status)) {
        if (facts.attempt.stopPhase !== 'requested')
          throw new ExecutionReviewFixedResultError('review-result-not-running');
        node = recordExecutionReviewEvent(node, {
          scope,
          kind: 'stopped',
          sequence: facts.attempt.lastEventSequence + 1,
        }).record;
      }
      const current = this.nativeReviewFacts({ ...scope });
      const sequence = readExecutionReviewState(node)!.attempts.find(
        (a) => a.scope.runId === scope.runId,
      )!;
      if (sequence.status === 'prepared')
        throw new ExecutionReviewFixedResultError('review-result-invalid');
      const result = recordExecutionReviewEvent(node, {
        scope,
        kind: 'cleanup',
        sequence: sequence.lastEventSequence + 1,
      });
      const key = canonicalPayload(scope);
      if (!this.reviewDrains.has(key) && this.reviewDrains.size >= 512)
        this.reviewDrains.delete(this.reviewDrains.keys().next().value!);
      this.reviewDrains.set(key, { drain, signal: drain.signal, assert: drain.assertCurrent });
      if (current.attempt.resources !== 'settled' && result.disposition === 'applied') {
        operation.assert(() => drain.assertCurrent());
        const stored = await this.persist(() => this.writeNode(result.record, true));
        if (!stored.ok) return stored;
      } else this.notifyRuns();
      return { ok: true, value: { status: 'settled' as const } };
    });
  }

  private nativeReviews(cleanup = false) {
    if (cleanup) this.requireReviewCleanupHost();
    else this.requireRunHost();
    const port = this.reviewNativePorts;
    if (
      !port ||
      port.original.issuer !== port.issuer ||
      port.original.grantFor !== port.grantFor ||
      port.original.retireForCleanup !== port.retireForCleanup ||
      port.issuer.prepareFixedReview !== port.prepare ||
      port.issuer.assertFixedReview !== port.assert ||
      port.issuer.readFixedReview !== port.read
    )
      throw new ExecutionReviewFixedResultError('review-result-invalid');
    return port;
  }
  private nativeReviewFacts(input: ExecutionReviewReadLocator) {
    requireExecutionReviewWriter(this.readRunGlobal());
    const node = this.readRunNode(input),
      state = node && readExecutionReviewState(node);
    const attempt = state?.attempts.find((a) => a.scope.runId === input.runId);
    if (
      !node ||
      !attempt ||
      attempt.status === 'prepared' ||
      attempt.remote !== undefined ||
      attempt.scope.spaceId !== input.spaceId
    )
      throw new ExecutionReviewFixedResultError('review-result-not-running');
    return { node, attempt };
  }
  private reviewHistoricalOutcome(
    node: ExecutionNodeRecord,
    attempt: ExecutionReviewAttempt,
    requestId: string,
  ): ExecutionReviewNativeOutcome | undefined {
    const receipt = readExecutionReviewFixedReceipt(node, attempt),
      failure = readExecutionReviewFailure(node, attempt);
    if (
      (receipt && receipt.requestId !== requestId) ||
      (failure && failure.requestId !== requestId)
    )
      throw new ExecutionReviewFixedResultError('review-result-conflict');
    const cleanup = attempt.resources === 'settled' ? ('settled' as const) : ('pending' as const);
    return receipt
      ? { status: 'confirmed', receipt, cleanup }
      : failure
        ? { status: 'needs-attention', failure, cleanup }
        : undefined;
  }
  private assertExpertReviewTargetReader(
    grant: ExecutionReviewReadGrant | ExecutionReviewDriveGrant,
  ): void {
    if (this.reviewDriveAuthorities?.owns(grant as ExecutionReviewDriveGrant))
      this.reviewDriveAuthorities.assertGrant(grant as ExecutionReviewDriveGrant, 'history');
    else this.assertExpertReviewReadGrant(grant as ExecutionReviewReadGrant);
  }

  /** Exact target catalog; metadata does not count as content-read evidence. */
  listExpertReviewResources(
    grant: ExecutionReviewReadGrant | ExecutionReviewDriveGrant,
  ): readonly ExecutionReviewResource[] {
    this.assertExpertReviewTargetReader(grant);
    return this.reviewTargetCatalog(grant.scope);
  }

  private remoteReviewTargetPort(issuer: RemoteReviewAuthorities) {
    const current = () => {
      if (!this.remoteIndependentReviewsEnabled || !this.remoteRunAuthorities?.ownsReview(issuer))
        throw new ExecutionReviewReadError('review-authority-denied');
    };
    current();
    const assert = (grant: RemoteReviewTargetGrant) => {
      current();
      issuer.assertTargetGrant(grant);
    };
    return Object.freeze({
      list: (grant: RemoteReviewTargetGrant) => {
        assert(grant);
        return this.reviewTargetCatalog(grant.scope);
      },
      read: (grant: RemoteReviewTargetGrant, query: unknown, signal: AbortSignal) =>
        this.readReviewTargetResource(grant, query, signal, () => assert(grant)),
    });
  }

  private reviewTargetCatalog(scope: ExecutionReviewScope): readonly ExecutionReviewResource[] {
    const node = this.currentFileNode(scope);
    const artifact = node.artifactVersions.find(
      (item) => item.id === scope.review.target.artifactVersionId,
    );
    if (!artifact) throw new ExecutionReviewReadError('review-target-changed');
    return reviewTargetResources(artifact);
  }

  /** Bounded fixed bytes under the genuine read grant. C alone binds actual SDK
   * calls/results, native identity and completion cut; this lease is not a vote. */
  readExpertReviewResource(
    grant: ExecutionReviewReadGrant | ExecutionReviewDriveGrant,
    raw: unknown,
    caller: AbortSignal,
  ): Promise<ExecutionReviewTargetReadLease> {
    return this.readReviewTargetResource(grant, raw, caller, () =>
      this.assertExpertReviewTargetReader(grant),
    );
  }

  private readReviewTargetResource<
    Grant extends { readonly scope: ExecutionReviewScope; readonly signal: AbortSignal },
  >(
    grant: Grant,
    raw: unknown,
    caller: AbortSignal,
    assertGrant: () => void,
  ): Promise<ExecutionReviewTargetReadLease & { readonly drain: Promise<void> }> {
    const job = Promise.resolve().then(
      async (): Promise<ExecutionReviewTargetReadLease & { readonly drain: Promise<void> }> => {
        assertGrant(); // issuer before any claimed fields
        const parsed = reviewTargetReadSchema.safeParse(raw);
        if (!parsed.success || !(caller instanceof AbortSignal))
          throw new ArtifactUploadError('invalid-request');
        const signal = AbortSignal.any([
          caller,
          grant.signal,
          this.fileLifetime.signal,
          this.runLifetime.signal,
        ]);
        const query = parsed.data;
        const resource = this.reviewTargetCatalog(grant.scope).find(
          (item) => item.resourceRef === query.resourceRef,
        );
        if (!resource) throw new ArtifactUploadError('not-found');
        if (resource.kind === 'external-reference')
          throw new ArtifactUploadError('review-unsupported-material');
        const expected = canonicalPayload(resource);
        let actualDrain: Promise<void> = Promise.resolve();
        let released = false,
          releaseOwned: (() => void) | undefined;
        const release = () => {
          if (released) return;
          released = true;
          signal.removeEventListener('abort', release);
          releaseOwned?.();
        };
        const check = () => {
          if (released || signal.aborted) throw new ArtifactUploadError('cancelled');
          assertGrant();
          const current = this.reviewTargetCatalog(grant.scope).find(
            (item) => item.resourceRef === query.resourceRef,
          );
          if (canonicalPayload(current ?? null) !== expected)
            throw new ArtifactUploadError('not-found');
        };
        signal.addEventListener('abort', release, { once: true });
        try {
          check();
          const node = this.currentFileNode(grant.scope);
          const artifact = node.artifactVersions.find(
            (item) => item.id === grant.scope.review.target.artifactVersionId,
          )!;
          let bytes: Uint8Array, encoding: 'utf-8' | 'binary';
          if (resource.kind === 'text') {
            if (
              [...this.fileReadResources].filter((item) => item.spaceId === grant.scope.spaceId)
                .length >= ARTIFACT_FILE_LIMITS.maxConcurrentReadsPerSpace
            )
              throw new ArtifactUploadError('quota-exceeded');
            let free!: () => void;
            const drain = new Promise<void>((resolve) => {
              free = resolve;
            });
            actualDrain = drain;
            const reservation = { spaceId: grant.scope.spaceId, drain };
            this.fileReadResources.add(reservation);
            releaseOwned = () => {
              free();
              this.fileReadResources.delete(reservation);
            };
            bytes = Buffer.from(artifact.text!, 'utf8');
            encoding = 'utf-8';
          } else {
            const ref = artifact.files.find(
              (file) => reviewFileResourceRef(file.id) === query.resourceRef,
            );
            const record = ref && this.fileStore?.get(ref.id);
            if (
              !ref ||
              !record ||
              !this.attachments ||
              record.spaceId !== grant.scope.spaceId ||
              record.taskId !== grant.scope.taskId ||
              record.planId !== grant.scope.planId ||
              record.revision !== grant.scope.revision ||
              record.nodeId !== grant.scope.nodeId ||
              !matchesArtifactFileReference(ref, record)
            )
              throw new ArtifactUploadError('not-found');
            const recordFingerprint = canonicalPayload(record);
            const fileCheck = () => {
              check();
              if (canonicalPayload(this.fileStore?.get(ref.id) ?? null) !== recordFingerprint)
                throw new ArtifactUploadError('not-found');
            };
            const owned = await this.verifyOwnedFileBytes(record, signal, fileCheck, true, true);
            actualDrain = owned.drain;
            releaseOwned = owned.release;
            if (released) owned.release();
            check();
            fileCheck();
            if (!owned.bytes) throw new ArtifactUploadError('unavailable');
            bytes = owned.bytes;
            encoding = runFileEncoding(
              {
                fileId: record.uploadId,
                name: artifactFileLeaf(record.name),
                mediaType: record.mediaType,
                bytes: record.byteSize,
                sha256: record.sha256,
              },
              bytes,
            );
          }
          if (query.offset > bytes.length) throw new ArtifactUploadError('invalid-request');
          const page = Uint8Array.from(
            bytes.subarray(query.offset, Math.min(query.offset + query.length, bytes.length)),
          );
          check();
          return {
            scope: grant.scope,
            resource: structuredClone(resource),
            range: { offset: query.offset, length: page.length, total: bytes.length },
            bytes: page,
            encoding,
            signal,
            drain: actualDrain,
            check,
            release,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    );
    this.fileOperations.add(job);
    void job.then(
      () => this.fileOperations.delete(job),
      () => this.fileOperations.delete(job),
    );
    return job;
  }

  /** Commit only. A runs a returned effect AFTER awaiting success, outside this queue. */
  beginRun(
    request: MemberRequest,
    body: unknown,
    ticket?: WorkflowStartTicket,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.prepareRunBegin(request, body, false, ticket);
  }

  /** A installs the original C owner once, after installing this service's Run Host. */
  installNativeResultIssuer(
    issuer: NativeFixedResultIssuer,
    publications?: NativeFixedResultPublicationsIssuer,
  ): void {
    this.requireRunHost();
    if (
      !this.runAuthorities ||
      this.nativeResultIssuer ||
      !issuer ||
      typeof issuer.prepareFixedResult !== 'function' ||
      typeof issuer.readFixedResult !== 'function' ||
      typeof issuer.assertFixedResult !== 'function' ||
      (publications !== undefined &&
        (!publications ||
          publications.v1Issuer !== issuer ||
          typeof publications.readFixedResult !== 'function' ||
          [
            'registerNativeResultTool',
            'prepareFixedResult',
            'assertFixedResult',
            'onReady',
            'close',
          ].some((key) => Reflect.get(publications, key) !== Reflect.get(issuer, key))))
    )
      throw new NativeResultDeliveryError('native-result-unavailable');
    this.nativeResultIssuer = Object.freeze({
      issuer,
      prepare: issuer.prepareFixedResult,
      read: issuer.readFixedResult,
      assert: issuer.assertFixedResult,
    });
    if (publications)
      this.nativeResultPublicationsIssuer = Object.freeze({
        issuer: publications,
        prepare: publications.prepareFixedResult,
        read: publications.readFixedResult,
        assert: publications.assertFixedResult,
      });
  }

  /** Host-only: real objects never arrive through an HTTP/JSON command. */
  submitNativeFixedResult(
    request: MemberRequest,
    body: unknown,
    grant: NativeWorkGrant,
    ref: NativeFixedResultRef,
    signal: AbortSignal = this.runLifetime.signal,
  ): Promise<ExecutionResult<NativeResultDeliveryReceipt>> {
    const actor = this.actorField(body);
    if (actor) return Promise.resolve(actor);
    const parsed = parseBody(nativeResultSubmitSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const input = parsed.value;
    return this.nativeResultOperation(signal, async (operation) => {
      const manager = this.runAuthorities!;
      // Hold this original request's member lease throughout preparation/write.
      // A borrowed drive grant alone does not authenticate this request.
      const host = this.requireRunHost();
      const member = await host.memberLease(request);
      const memberRelease = member.release;
      operation.release(() => memberRelease.call(member));
      const memberSignal = member.signal;
      const memberCheck = member.assertCurrent;
      const memberExpiry = member.expiresAt;
      const memberCurrent = () => {
        operation.check();
        if (
          !(memberSignal instanceof AbortSignal) ||
          member.signal !== memberSignal ||
          member.assertCurrent !== memberCheck ||
          member.release !== memberRelease ||
          member.expiresAt !== memberExpiry ||
          memberSignal.aborted ||
          !Number.isSafeInteger(member.expiresAt) ||
          member.expiresAt <= Date.now()
        )
          throw new NativeResultDeliveryError('native-result-authority-denied');
        operation.assert(() => memberCheck.call(member, grant.scope.spaceId));
      };
      const reading = await manager.open(
        request,
        {
          taskId: input.taskId,
          planId: input.planId,
          revision: input.revision,
          nodeId: input.nodeId,
          runId: input.runId,
        },
        'read',
      );
      operation.release(() => reading.dispose());
      const readCurrent = () => {
        memberCurrent();
        manager.assertGrant(reading.grant, 'history');
      };
      const preflight = await this.enqueue(async () => {
        readCurrent();
        const { node, run, state } = this.nativeResultFacts(input);
        this.assertRunNodeAccess(host, member.memberId, run.spaceId, node);
        if (run.resultDelivery) return fail('native-result-confirmation-required');
        this.assertNativeResultWriter(input, node, run, state.version, grant, member.memberId);
        const version =
          run.composition?.schemaVersion === 2
            ? run.composition.payload.resultIntentTool?.sourceVersion
            : undefined;
        if (
          version !== 'zhuma-native-result-intent@1' &&
          version !== NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION
        )
          return fail('native-result-delivery-invalid');
        return {
          ok: true,
          value: version === NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION ? (2 as const) : (1 as const),
        };
      });
      if (!preflight.ok) return preflight;
      const protocolVersion = preflight.value;
      const port = this.nativeResultPort(protocolVersion);
      const prepared = await port.prepare.call(port.issuer, grant, operation.signal);
      readCurrent();
      if (prepared.status !== 'ready')
        return fail('native-result-pending', { reason: prepared.reason });
      if (prepared.ref !== ref) return fail('native-result-reference-mismatch');
      const lease = await port.read.call(port.issuer, grant, ref, operation.signal);
      const release = lease?.release;
      operation.release(() => {
        if (typeof release !== 'function')
          throw new NativeResultDeliveryError('native-result-cleanup-failed');
        return release.call(lease);
      });
      const fixed = (() => {
        const rawProof = {
          source: lease?.source,
          digest: lease?.digest,
          provenanceFingerprint: lease?.provenanceFingerprint,
        };
        if (protocolVersion === 1) {
          const proof = fixedResultProofSchema.safeParse(rawProof);
          const content = nativeResultContentSchema.safeParse(lease?.content);
          if (
            !proof.success ||
            !content.success ||
            nativeResultDigest(content.data) !== proof.data.digest
          )
            throw new NativeResultDeliveryError();
          return { protocolVersion: 1 as const, ...proof.data, content: content.data };
        }
        const proof = nativeResultPublicationsProofSchema.safeParse({
          ...rawProof,
          manifestDigest: 'manifestDigest' in lease ? lease.manifestDigest : undefined,
        });
        const content = nativeManifestContentSchema.safeParse(lease?.content);
        if (
          !proof.success ||
          !content.success ||
          proof.data.manifestDigest !== proof.data.source.manifestDigest
        )
          throw new NativeResultDeliveryError();
        return {
          protocolVersion: 2 as const,
          ...proof.data,
          content: content.data,
          manifest: 'manifest' in lease ? lease.manifest : undefined,
        };
      })();
      if (
        typeof lease.check !== 'function' ||
        !(lease.signal instanceof AbortSignal) ||
        nativeResultProvenance(fixed.source, fixed.digest) !== fixed.provenanceFingerprint ||
        canonicalPayload(fixed.content) !== canonicalPayload(lease.content)
      )
        return fail('native-result-delivery-invalid');
      const check = lease.check;
      const leaseSignal = lease.signal;
      const leaseFacts = () => ({
        source: lease.source,
        digest: lease.digest,
        provenanceFingerprint: lease.provenanceFingerprint,
        content: lease.content,
        ...(protocolVersion === 2
          ? {
              manifest: 'manifest' in lease ? lease.manifest : undefined,
              manifestDigest: 'manifestDigest' in lease ? lease.manifestDigest : undefined,
            }
          : {}),
      });
      const fingerprint = canonicalPayload(leaseFacts());
      const confirmation = () => ({
        ...input,
        intentId: fixed.source.intentId,
        digest: fixed.digest,
        provenanceFingerprint: fixed.provenanceFingerprint,
        ...(fixed.protocolVersion === 2
          ? { protocolVersion: 2 as const, manifestDigest: fixed.manifestDigest }
          : {}),
      });
      const fixedCurrent = () => {
        readCurrent();
        this.nativeResultPort(protocolVersion);
        if (
          lease.signal !== leaseSignal ||
          leaseSignal.aborted ||
          lease.check !== check ||
          lease.release !== release ||
          canonicalPayload(leaseFacts()) !== fingerprint
        )
          throw new NativeResultDeliveryError('native-result-authority-denied');
        operation.assert(() => port.assert.call(port.issuer, grant, ref));
        operation.assert(() => check.call(lease));
      };
      let manifest: readonly NativePublicationManifestEntry[] = [];
      if (fixed.protocolVersion === 2) {
        type Stage =
          | { kind: 'manifest'; entries: readonly NativePublicationManifestEntry[] }
          | { kind: 'confirmed'; receipt: NativeResultDeliveryReceipt };
        const stage = await this.enqueue<Stage>(async () => {
          readCurrent();
          const { node, run, state } = this.nativeResultFacts(input);
          this.assertRunNodeAccess(host, member.memberId, run.spaceId, node);
          if (run.resultDelivery) {
            const result = this.confirmNativeResultNow(confirmation());
            return result.ok
              ? { ok: true, value: { kind: 'confirmed', receipt: result.value } }
              : result;
          }
          fixedCurrent();
          this.assertNativeResultWriter(input, node, run, state.version, grant, member.memberId);
          const entries = readNativeResultManifest(
            fixed.source,
            fixed.manifest,
            fixed.manifestDigest,
            fixed.content,
            (id) => this.fileStore?.get(id),
          );
          if (
            nativeManifestResultDigest(
              fixed.content,
              fixed.manifestDigest,
              entries.map((entry) => entry.evidence),
            ) !== fixed.digest
          )
            throw new NativeResultDeliveryError();
          return { ok: true, value: { kind: 'manifest', entries } };
        });
        if (!stage.ok) return stage;
        if (stage.value.kind === 'confirmed') return { ok: true, value: stage.value.receipt };
        manifest = stage.value.entries;
        try {
          for (const entry of manifest) {
            fixedCurrent();
            const verified = await this.verifyOwnedFileBytes(
              entry.record,
              AbortSignal.any([
                operation.signal,
                leaseSignal,
                memberSignal,
                this.fileLifetime.signal,
              ]),
              fixedCurrent,
              false,
              true,
            );
            operation.release(() => verified.release());
            await verified.drain;
            fixedCurrent();
          }
        } catch (error) {
          // Another exact request may have committed while this reader drained.
          // Confirm only with the held history right; never revive its send grant.
          const existing = await this.enqueue<NativeResultDeliveryReceipt | undefined>(async () => {
            readCurrent();
            const { run } = this.nativeResultFacts(input);
            return run.resultDelivery
              ? this.confirmNativeResultNow(confirmation())
              : { ok: true as const, value: undefined };
          });
          if (!existing.ok) return existing;
          if (existing.value) return { ok: true, value: existing.value };
          throw error;
        }
      }
      return this.enqueue(async () => {
        readCurrent();
        const { node, run, state } = this.nativeResultFacts(input);
        this.assertRunNodeAccess(host, member.memberId, run.spaceId, node);
        // Concurrent exact requests may have prepared while the first was live.
        // After its put, this branch only confirms facts with held read authority;
        // it does not reuse the now-revoked send grant to write or read C again.
        if (run.resultDelivery) return this.confirmNativeResultNow(confirmation());
        fixedCurrent();
        this.assertNativeResultWriter(input, node, run, state.version, grant, member.memberId);
        if (
          canonicalPayload(fixed.source.scope) !== canonicalPayload(executionRunScope(node, run)) ||
          fixed.source.configurationId !== input.configurationId ||
          fixed.source.nativeSessionId !== run.attempt.sessionId ||
          fixed.source.nativeAgentId !== run.attempt.executorRunId ||
          (fixed.protocolVersion === 2 &&
            fixed.source.expertVersionId !== run.attempt.expertVersionId)
        )
          return fail('native-result-delivery-invalid');
        if (fixed.protocolVersion === 2)
          readNativeResultManifest(
            fixed.source,
            fixed.manifest,
            fixed.manifestDigest,
            fixed.content,
            (id) => this.fileStore?.get(id),
          );
        const terminal = recordExecutionRunEvent(node, {
          kind: 'completed',
          runId: run.attempt.id,
          generation: run.attempt.generation,
          segmentId: run.segmentId,
          sequence: run.attempt.lastEventSequence + 1,
          idle: true,
          flushed: true,
          resourcesSettled: true,
        });
        const ids = nativeResultArtifactIds(input);
        const command = {
          record: terminal.record,
          expertId: node.handoff.assignee.id,
          producerRunId: run.attempt.id,
          provenanceFingerprint: fixed.provenanceFingerprint,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: terminal.record.command.version,
          ...ids,
        };
        const delivered =
          fixed.protocolVersion === 1
            ? submitExpertDelivery({ ...command, draft: { ...fixed.content, files: [] } })
            : submitExpertManifestDelivery({ ...command, draft: fixed.content });
        if (!delivered.ok) return fail(delivered.code);
        if (terminal.disposition !== 'applied' || delivered.disposition !== 'applied')
          return fail('native-result-delivery-conflict');
        const ended = readExecutionRunState(terminal.record)!;
        const resultDelivery = executionNativeResultDeliverySchema.parse({
          protocolVersion: fixed.protocolVersion,
          source: fixed.source,
          digest: fixed.digest,
          provenanceFingerprint: fixed.provenanceFingerprint,
          ...(fixed.protocolVersion === 2
            ? {
                manifestDigest: fixed.manifestDigest,
                publications: manifest.map((entry) => entry.evidence),
              }
            : {}),
          receiptKey: input.idempotencyKey,
          artifactVersionId: ids.artifactId,
          ...(node.handoff.reviewRequired ? { roundId: ids.roundId } : {}),
        });
        const combined = withExecutionRunState(delivered.record, {
          ...ended,
          runs: ended.runs.map((item) =>
            item.attempt.id === run.attempt.id ? { ...item, resultDelivery } : item,
          ),
        });
        const stamped = withExecutionEvent(
          combined,
          'delivery-submitted',
          node.handoff.assignee.id,
        );
        if (!stamped) return fail('unavailable');
        const finalRun = readExecutionRunState(stamped)!.runs.find(
          (item) => item.attempt.id === run.attempt.id,
        )!;
        const receipt = nativeResultDeliveryReceipt(stamped, finalRun, 'applied');
        fixedCurrent();
        const stored = await this.persist(() => this.writeNode(stamped, true));
        if (!stored.ok) return stored;
        // The durable terminal state intentionally revokes driving. No send-
        // based C assertion may run after this point, including in cleanup.
        if (stamped.command.status === 'completed') {
          try {
            const unlocked = await this.unlockFrom(stamped);
            if (!unlocked.ok) return { ok: true, value: { ...receipt, downstream: 'pending' } };
          } catch {
            return { ok: true, value: { ...receipt, downstream: 'pending' } };
          }
        }
        return { ok: true, value: receipt };
      });
    });
  }

  /** Independent readonly recovery: no C owner/ref, new submit right or repair. */
  confirmNativeResultDelivery(
    request: MemberRequest,
    body: unknown,
    signal: AbortSignal = this.runLifetime.signal,
  ): Promise<ExecutionResult<NativeResultDeliveryReceipt>> {
    const actor = this.actorField(body);
    if (actor) return Promise.resolve(actor);
    const parsed = parseBody(nativeResultConfirmSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    return this.nativeResultOperation(signal, async (operation) => {
      const manager = this.runAuthorities;
      if (!manager) return fail('native-result-unavailable');
      const input = parsed.value;
      const opened = await manager.open(
        request,
        {
          taskId: input.taskId,
          planId: input.planId,
          revision: input.revision,
          nodeId: input.nodeId,
          runId: input.runId,
        },
        'read',
      );
      operation.release(() => opened.dispose());
      return this.enqueue(async () => {
        operation.check();
        manager.assertGrant(opened.grant, 'history');
        return this.confirmNativeResultNow(parsed.value);
      });
    });
  }

  private nativeResultPort(protocolVersion: 1 | 2 = 1): NativeResultPort {
    this.requireRunHost();
    const port =
      protocolVersion === 1 ? this.nativeResultIssuer : this.nativeResultPublicationsIssuer;
    if (
      !port ||
      port.issuer.prepareFixedResult !== port.prepare ||
      port.issuer.readFixedResult !== port.read ||
      port.issuer.assertFixedResult !== port.assert ||
      (protocolVersion === 2 &&
        (!('v1Issuer' in port.issuer) ||
          port.issuer.v1Issuer !== this.nativeResultIssuer?.issuer ||
          port.prepare !== this.nativeResultIssuer.prepare ||
          port.assert !== this.nativeResultIssuer.assert))
    )
      throw new NativeResultDeliveryError('native-result-unavailable');
    return port;
  }

  private nativeResultFacts(input: NativeResultSubmit | NativeResultConfirm) {
    const node = this.readRunNode(input);
    if (!node) throw new NativeResultDeliveryError('native-result-authority-denied');
    const state = readExecutionRunState(node);
    const run = state?.runs.find((item) => item.attempt.id === input.runId);
    if (
      !state ||
      !run ||
      run.attempt.generation !== input.generation ||
      run.segmentId !== input.segmentId ||
      run.selection.configurationId !== input.configurationId
    )
      throw new NativeResultDeliveryError('native-result-delivery-conflict');
    return { node, run, state };
  }

  private assertNativeResultWriter(
    input: NativeResultSubmit,
    node: ExecutionNodeRecord,
    run: ReturnType<ExecutionService['nativeResultFacts']>['run'],
    runVersion: number,
    grant: NativeWorkGrant,
    memberId: string,
  ): void {
    if (
      readExecutionRunState(node)?.currentRunId !== run.attempt.id ||
      ['completed', 'failed', 'cancelled'].includes(run.attempt.status)
    )
      throw new NativeResultDeliveryError('native-result-terminal-no-receipt');
    this.runAuthorities!.assertGrant(grant, 'send');
    this.assertRunController(memberId, node);
    const executor = run.composition?.payload.executor;
    if (
      node.handoff.assignee.kind !== 'expert' ||
      executor?.kind !== 'plan-expert' ||
      run.composition?.schemaVersion !== 2 ||
      !run.composition.payload.resultIntentTool ||
      executor.ref.id !== node.handoff.assignee.id ||
      executor.ref.version !== node.planId
    )
      throw new NativeResultDeliveryError('native-result-not-expert');
    if (
      memberId !== run.actorId ||
      canonicalPayload(grant.scope) !== canonicalPayload(executionRunScope(node, run))
    )
      throw new NativeResultDeliveryError('native-result-authority-denied');
    if (
      node.command.version !== input.expectedNodeVersion ||
      runVersion !== input.expectedRunVersion
    )
      throw new NativeResultDeliveryError('native-result-delivery-conflict');
  }

  private confirmNativeResultNow(
    input: NativeResultConfirm,
  ): ExecutionResult<NativeResultDeliveryReceipt> {
    const { node, run } = this.nativeResultFacts(input);
    const value = run.resultDelivery;
    if (!value) return fail('native-result-terminal-no-receipt');
    if (
      value.receiptKey !== input.idempotencyKey ||
      value.source.intentId !== input.intentId ||
      value.digest !== input.digest ||
      value.provenanceFingerprint !== input.provenanceFingerprint
    )
      return fail('native-result-delivery-conflict');
    if (value.protocolVersion === 2) {
      if (
        !('protocolVersion' in input) ||
        input.protocolVersion !== 2 ||
        input.manifestDigest !== value.manifestDigest
      )
        return fail('native-result-delivery-conflict');
      nativeResultManifestRecords(value.source, value.publications, value.manifestDigest, (id) =>
        this.fileStore?.get(id),
      );
    } else if ('protocolVersion' in input) return fail('native-result-delivery-conflict');
    return { ok: true, value: nativeResultDeliveryReceipt(node, run, 'confirmed') };
  }

  private nativeResultOperation<T extends object>(
    signal: AbortSignal,
    work: (operation: NativeResultOperation) => Promise<ExecutionResult<T>>,
    cleanup = false,
  ): Promise<ExecutionResult<T>> {
    if (!(signal instanceof AbortSignal)) return Promise.resolve(fail('validation'));
    if (cleanup && this.reviewCleanupSealed)
      return Promise.resolve(fail('run-authority-unavailable'));
    // Cleanup must be able to retire the physical IO occupying all read slots.
    // It cannot read target bytes/send/vote and shares the original close join.
    const occupied = cleanup
      ? this.nativeReviewCleanupOperations
      : this.nativeResultOperations.size - this.nativeReviewCleanupOperations;
    if (occupied >= 8) return Promise.resolve(fail('native-result-capacity'));
    const combined = AbortSignal.any([
      cleanup ? this.reviewCleanupLifetime.signal : this.runLifetime.signal,
      signal,
    ]);
    const releases: (() => unknown)[] = [];
    const check = () => {
      if (cleanup) this.requireReviewCleanupHost();
      else this.requireRunHost();
      if (combined.aborted) throw new NativeResultDeliveryError('native-result-cancelled');
    };
    const operation = Promise.resolve().then(async () => {
      let result: ExecutionResult<T>;
      try {
        check();
        result = await work({
          signal: combined,
          check,
          release: (fn) => releases.push(fn),
          assert(callback) {
            const value = callback();
            if (value !== undefined) {
              // Never await an invalid async assertion as permission or inside
              // the original queue. Still own its physical completion on close.
              const ended = Promise.resolve(value);
              void ended.catch(() => undefined);
              releases.push(() => ended);
              throw new NativeResultDeliveryError('native-result-authority-denied');
            }
          },
        });
      } catch (error) {
        result = fail(
          error instanceof NativeResultDeliveryError ||
            error instanceof NativeResultError ||
            error instanceof NativeReviewError ||
            error instanceof ExecutionReviewReadError ||
            error instanceof ExecutionReviewFixedResultError ||
            error instanceof ExecutionRunError ||
            error instanceof ExecutionRunCompositionError
            ? error.code
            : 'native-result-unavailable',
        );
      }
      let cleanupFailed = false;
      for (const release of releases.reverse()) {
        try {
          const value = release();
          if (value !== undefined) {
            await Promise.resolve(value);
            cleanupFailed = true;
          }
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        this.nativeResultCleanupFailure ??= new NativeResultDeliveryError(
          'native-result-cleanup-failed',
        );
        if (result.ok)
          return { ok: true as const, value: { ...result.value, cleanup: 'failed' as const } };
      }
      return result;
    });
    if (cleanup) this.nativeReviewCleanupOperations++;
    this.nativeResultOperations.add(operation);
    void operation
      .finally(() => {
        this.nativeResultOperations.delete(operation);
        if (cleanup) this.nativeReviewCleanupOperations--;
      })
      .catch(() => undefined);
    return operation;
  }

  /** Normal explicit first start: authenticate all facts before the first global write. */
  startRun(
    request: MemberRequest,
    body: unknown,
    ticket?: WorkflowStartTicket,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.prepareRunBegin(request, body, true, ticket);
  }

  private async prepareRunBegin(
    request: MemberRequest,
    body: unknown,
    enableWriter: boolean,
    ticket?: WorkflowStartTicket,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    // The snapshot's scope is data to compare against the real lease below,
    // not an actor assignment. All other command fields keep the old scan.
    const commandFields =
      body && typeof body === 'object' && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'composition'))
        : body;
    const actorField = this.actorField(commandFields);
    if (actorField) return actorField;
    const parsed = parseBody(beginRunSchema, body);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    let workflowSignal: AbortSignal | undefined;
    if (ticket !== undefined) {
      try {
        if (!this.workflowIntents)
          throw new ExecutionWorkflowError('workflow-start-ticket-invalid');
        workflowSignal = this.workflowIntents.preparing(request, input, ticket);
      } catch (error) {
        return fail(
          error instanceof ExecutionWorkflowError ? error.code : 'workflow-authority-denied',
        );
      }
    }
    if (input.composition.schemaVersion !== 2 || !input.composition.payload.resources)
      return this.enqueue(() =>
        this.beginRunNow(request, input, enableWriter, undefined, ticket),
      ).then((result) => {
        if (!result.ok && result.error.code === 'run-workspace-busy')
          this.workflowIntents?.deferBusy(ticket);
        return result;
      });
    let host: ExecutionRunHostPorts;
    try {
      host = this.requireRunHost();
    } catch (error) {
      if (error instanceof ExecutionRunError) return fail(error.code);
      throw error;
    }
    // Register the whole operation BEFORE invoking a potentially reentrant
    // provider. Its 145 reads need the original queue, not a second queue.
    let workflowCleanupFailed = false;
    const operation = Promise.resolve().then(async () => {
      try {
        return await withExecutionRunResourceQualification(
          {
            host,
            ownerSignal: workflowSignal
              ? AbortSignal.any([this.runLifetime.signal, workflowSignal])
              : this.runLifetime.signal,
            originalRequest: request,
            command: input,
          },
          (qualification) =>
            this.enqueue(() =>
              this.beginRunNow(request, input, enableWriter, qualification, ticket),
            ),
        );
      } catch (error) {
        if (error instanceof ExecutionRunResourceQualificationCloseError) {
          workflowCleanupFailed = true;
          this.runPreparationFailure ??= error;
        }
        if (error instanceof ExecutionRunError || error instanceof ExecutionRunCompositionError)
          return fail(error.code);
        throw error;
      }
    });
    if (ticket)
      this.workflowIntents!.trackPreparation(ticket, operation, () => workflowCleanupFailed);
    this.runPreparations.add(operation);
    void operation.finally(() => this.runPreparations.delete(operation)).catch(() => undefined);
    return operation.then((result) => {
      if (!result.ok && result.error.code === 'run-workspace-busy')
        this.workflowIntents?.deferBusy(ticket);
      return result;
    });
  }

  private async beginRunNow(
    request: MemberRequest,
    input: BeginRunRequest,
    enableWriter: boolean,
    qualification?: ExecutionRunResourceVerification,
    ticket?: WorkflowStartTicket,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.withRunMember(
      request,
      input,
      async (host, lease, initial) => {
        let node = initial;
        const revisionReservations = (): ReadonlySet<string> => {
          if (
            input.mode !== 'begin' ||
            ticket ||
            !isExecutionRunRevisionStart(node) ||
            !readExecutionReviewState(node)?.attempts.some(
              (attempt) => attempt.status === 'prepared',
            )
          )
            return new Set<string>();
          // Never carry the Stop/never-admitted qualification across an await
          // or a Host callback. Its retained marker stays prepared/held.
          lease.assertCurrent(input.spaceId);
          const current = this.readRunNode(input);
          if (!current || canonicalPayload(current) !== canonicalPayload(node))
            throw new ExecutionRunError('run-conflict');
          const raw = this.storage.readPlan(
            planKey(node.taskId, node.planId, node.revision),
          )?.workflowExecution;
          if (raw === undefined) return new Set<string>();
          const workflow = workflowExecutionIntentSchema.safeParse(raw);
          if (!workflow.success) throw new ExecutionWorkflowError('workflow-incompatible');
          if (workflow.data.actorId !== lease.memberId || workflow.data.spaceId !== input.spaceId)
            return new Set<string>();
          const stopped = stoppedPreparedWorkflowReviewRunIdsForRevision(node, workflow.data);
          if (stopped.size) requireExecutionReviewWriter(this.readRunGlobal());
          return stopped;
        };
        const validate = () =>
          validateExecutionRunBegin(
            node,
            this.runInput(input, lease.memberId),
            this.storage.listNodes(),
            {
              expertEnabled: true,
              executorConnected: true,
              stoppedPreparedReviewRunIds: revisionReservations(),
            },
          );
        const revisionCurrent = () => {
          const state = readExecutionRunState(node);
          if (state?.receipts.some((receipt) => receipt.requestId === input.requestId)) return;
          const previous = currentExecutionRun(node);
          if (previous?.attempt.status !== 'completed') return;
          if (input.mode !== 'begin' || ticket || !isExecutionRunRevisionStart(node))
            throw new ExecutionRunError('run-recovery-unavailable');
          if (
            input.composition.schemaVersion !== 2 ||
            input.composition.payload.returnedRevision?.roundId !== node.currentRoundId
          )
            throw new ExecutionRunCompositionError('composition-mismatch');
          // A persisted settled label alone cannot certify C's old physical scope.
          const proof = host.migrationDrain?.(executionRunScope(node, previous));
          if (
            !proof ||
            !(proof.signal instanceof AbortSignal) ||
            proof.signal.aborted ||
            typeof proof.assertCurrent !== 'function'
          )
            throw new ExecutionRunError('run-migration-pending');
          try {
            synchronousRunAssertion(proof.assertCurrent());
          } catch {
            throw new ExecutionRunError('run-migration-pending');
          }
          if (proof.signal.aborted) throw new ExecutionRunError('run-migration-pending');
        };
        const workflowCurrent = () => {
          if (ticket !== undefined) this.workflows().assertBegin(input, lease.memberId, ticket);
          const intent = this.storage.readPlan(
            planKey(node.taskId, node.planId, node.revision),
          )?.workflowExecution;
          const reservation = intent?.starts.find(
            (item) =>
              item.requestId === input.requestId ||
              item.newRunId === input.newRunId ||
              item.newSegmentId === input.newSegmentId,
          );
          const replay = readExecutionRunState(node)?.receipts.some(
            (item) => item.requestId === input.requestId,
          );
          if (reservation && !ticket && !replay)
            throw new ExecutionWorkflowError('workflow-start-ticket-required');
        };
        const verify = async () => {
          qualification?.assertCurrent();
          this.requireRunHost();
          lease.assertCurrent(input.spaceId);
          const visible = await this.readableRecords(
            [input.spaceId],
            lease.memberId,
            input.spaceId,
          );
          const fresh = this.currentRunCompositionInputs(host, lease, input, visible);
          qualification?.assertCurrent();
          node = fresh.node;
          workflowCurrent();
          const state = readExecutionRunState(node);
          const prior = state?.receipts.find((receipt) => receipt.requestId === input.requestId);
          const generation = prior
            ? state!.runs.find((run) => run.attempt.id === prior.runId)!.attempt.generation
            : (state?.runs.length ?? 0) + 1;
          const { configurationId: _configuration, ...model } = input.selection;
          const executor = input.composition.payload.executor;
          assertExecutionRunComposition(
            input.composition,
            {
              workbench: this.workbench.readWorkbench(),
              node,
              scope: {
                actorId: lease.memberId,
                spaceId: input.spaceId,
                taskId: node.taskId,
                planId: node.planId,
                revision: node.revision,
                nodeId: node.nodeId,
                runId: input.newRunId,
                generation,
                segmentId: input.newSegmentId,
              },
              model,
              executor:
                executor.kind === 'builtin'
                  ? { kind: 'builtin' }
                  : { kind: 'plan-expert', ref: executor.ref },
              tools: input.composition.payload.tools,
              ...(qualification ? { resourceCatalog: qualification.catalog } : {}),
              ...('acceptedFileReader' in input.composition.payload &&
              input.composition.payload.acceptedFileReader !== undefined
                ? { acceptedFileReader: input.composition.payload.acceptedFileReader }
                : {}),
              ...('resultIntentTool' in input.composition.payload &&
              input.composition.payload.resultIntentTool !== undefined
                ? { resultIntentTool: input.composition.payload.resultIntentTool }
                : {}),
              ...('outputFilePublisherTool' in input.composition.payload &&
              input.composition.payload.outputFilePublisherTool !== undefined
                ? { outputFilePublisherTool: input.composition.payload.outputFilePublisherTool }
                : {}),
              inputs: {
                actorId: lease.memberId,
                spaceId: input.spaceId,
                taskId: node.taskId,
                planId: node.planId,
                revision: node.revision,
                nodeId: node.nodeId,
                items: fresh.items,
              },
            },
            input,
          );
          synchronousRunAssertion(
            host.assertConfiguration(lease.memberId, input.spaceId, node, input),
          );
          synchronousRunAssertion(
            host.assertWorkspace(
              lease.memberId,
              input.spaceId,
              input.workspace,
              input.workspace.kind === 'local' ? input.workspace.access : 'read',
              input.selection.configurationId,
            ),
          );
          validate();
          revisionCurrent();
          qualification?.assertCurrent();
        };
        await verify();
        if (enableWriter) {
          if (!this.storage.writeGlobal) throw new ExecutionRunError('run-authority-unavailable');
          await enableExecutionRunWriter(
            () => this.readRunGlobal(),
            (next) => this.storage.writeGlobal!(next),
            this.storage.listNodes(),
          );
          await verify();
        }
        const decision = beginExecutionRun(
          node,
          this.runInput(input, lease.memberId),
          this.storage.listNodes(),
          {
            expertEnabled: true,
            executorConnected: true,
            writerState: this.readRunGlobal(),
            stoppedPreparedReviewRunIds: revisionReservations(),
          },
        );
        lease.assertCurrent(input.spaceId);
        qualification?.assertCurrent();
        const committed = await this.commitRunDecision(decision, () => {
          workflowCurrent();
          lease.assertCurrent(input.spaceId);
          revisionCurrent();
          if (
            readExecutionReviewState(node)?.attempts.some(
              (attempt) => attempt.status === 'prepared',
            )
          )
            validate();
        });
        qualification?.assertCurrent();
        return committed;
      },
      !enableWriter,
    );
  }

  stopRun(request: MemberRequest, body: unknown): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(async () => {
      const actorField = this.actorField(body);
      if (actorField) return actorField;
      const parsed = parseBody(stopRunSchema, body);
      if (!parsed.ok) return parsed;
      return this.withRunMember(request, parsed.value, async (_host, lease, node) => {
        const { spaceId, ...input } = parsed.value;
        const run = currentExecutionRun(node);
        if (!run || run.spaceId !== spaceId || run.actorId !== lease.memberId)
          throw new ExecutionRunError('run-authority-denied');
        const decision = requestExecutionRunStop(node, this.runInput(input, lease.memberId));
        lease.assertCurrent(spaceId);
        return this.commitRunDecision(decision);
      });
    });
  }

  /** Native bridge only: require a capability issued by THIS owner, never a Client envelope. */
  recordRunEvent(
    locator: ExecutionNodeLocator,
    event: ExecutionRunEvent,
    authority: RunEventAuthority,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    return this.enqueue(async () => {
      requireExecutionRunWriter(this.readRunGlobal());
      const manager = this.runAuthorities;
      if (!manager) throw new ExecutionRunError('run-authority-unavailable');
      const node = this.readRunNode(locator);
      if (!node || !recordedPlan(this.storage, node))
        throw new ExecutionRunError('run-authority-denied');
      const state = readExecutionRunState(node);
      const run = state?.runs.find((item) => item.attempt.id === event.runId);
      if (!run) throw new ExecutionRunError('run-scope-mismatch');
      const capability = 'grant' in authority ? authority.grant : authority.cleanup;
      if (canonicalPayload(capability.scope) !== canonicalPayload(executionRunScope(node, run)))
        throw new ExecutionRunError('run-scope-mismatch');
      // `stop` is permitted by drive grants even while stopping, and denied by
      // read grants. Checking only `open` would let a history reader emit events.
      if ('grant' in authority) manager.assertGrant(authority.grant, 'stop');
      else {
        if (!['failed', 'stop-pending', 'stopped', 'cleanup'].includes(event.kind))
          throw new ExecutionRunError('run-authority-denied');
        manager.assertCleanup(
          authority.cleanup,
          event.kind as 'failed' | 'stop-pending' | 'stopped' | 'cleanup',
        );
      }
      return this.commitRunDecision(recordExecutionRunEvent(node, event));
    });
  }

  /** Fence driving first. A may still commit capability-checked cleanup during native drain. */
  fenceRuns(): void {
    this.runLifetime.abort();
    this.workspaceApprovalOwner?.fence();
    this.runAuthorities?.fence();
    this.remoteRunAuthorities?.fence();
  }

  /** Call only after the native owner drained and its cleanup facts committed. */
  async closeRuns(): Promise<void> {
    this.fenceRuns();
    this.reviewCleanupSealed = true;
    while (this.runPreparations.size) await Promise.allSettled([...this.runPreparations]);
    while (this.nativeResultOperations.size)
      await Promise.allSettled([...this.nativeResultOperations]);
    let workspaceApprovalFailure: unknown;
    let remoteFailure: unknown;
    try {
      await this.remoteRunAuthorities?.close();
    } catch (error) {
      remoteFailure = error;
    }
    try {
      await this.workspaceApprovalOwner?.close();
    } catch (error) {
      workspaceApprovalFailure = error;
    }
    await this.writes;
    try {
      await this.workflowIntents?.close();
      await this.runAuthorities?.close();
    } finally {
      this.reviewCleanupLifetime.abort();
      for (const binding of this.reviewWorkflowClaims.values()) binding.dispose();
      this.reviewWorkflowClaims.clear();
      this.reviewDrains.clear();
    }
    if (this.runPreparationFailure) throw this.runPreparationFailure;
    if (this.nativeResultCleanupFailure) throw this.nativeResultCleanupFailure;
    if (workspaceApprovalFailure) throw workspaceApprovalFailure;
    if (remoteFailure) throw remoteFailure;
  }

  private requireRunHost(): ExecutionRunHostPorts {
    const host = this.runHost;
    if (!host || host.signal.aborted || this.runLifetime.signal.aborted)
      throw new ExecutionRunError('run-authority-unavailable');
    return host;
  }
  private requireReviewCleanupHost(): ExecutionRunHostPorts {
    const host = this.runHost;
    if (!host || this.reviewCleanupLifetime.signal.aborted)
      throw new ExecutionRunError('run-authority-unavailable');
    return host;
  }

  private assertRunNodeAccess(
    host: ExecutionRunHostPorts,
    memberId: string,
    spaceId: string,
    node: ExecutionNodeRecord,
  ): void {
    const workbench = this.workbench.readWorkbench();
    const task = workbench.tasks.find((item) => item.id === node.taskId);
    if (
      !task ||
      !workbench.participants.some(
        (item) => item.id === memberId && item.kind === 'human' && item.available,
      ) ||
      planMembership(workbench, node.taskId, memberId) !== 'allowed' ||
      !recordedPlan(this.storage, node)
    )
      throw new ExecutionRunError('run-authority-denied');
    synchronousRunAssertion(host.assertProjectSpace(task.projectId, spaceId));
    this.assertRunRecordedPlan(workbench, node);
  }

  /** A receipt must certify the exact complete plan, not just exist at its storage key. */
  private assertRunRecordedPlan(workbench: Workbench, node: ExecutionNodeRecord): void {
    let expected: string[];
    try {
      expected = createNodeHandoffs(createExecutionHandoff(node, workbench)).map(
        (handoff) => handoff.nodeId,
      );
    } catch {
      throw new ExecutionRunError('run-authority-denied');
    }
    const receipt = this.storage.readPlan(planKey(node.taskId, node.planId, node.revision));
    const nodes = new Set(receipt?.nodeIds);
    if (
      receipt?.fingerprint !==
        canonicalPayload({ taskId: node.taskId, planId: node.planId, revision: node.revision }) ||
      expected.length === 0 ||
      nodes.size !== expected.length ||
      !expected.every((nodeId) => {
        if (!nodes.has(nodeId)) return false;
        const record = this.storage.readNode(nodeRecordKey({ ...node, nodeId }));
        return (
          record !== undefined &&
          intactNode(record) &&
          samePlan(record, node.taskId, node.planId, node.revision) &&
          record.nodeId === nodeId &&
          record.handoff.nodeId === nodeId &&
          record.handoff.taskId === node.taskId &&
          record.handoff.workflowVersionId === node.planId &&
          record.handoff.revision === node.revision
        );
      })
    )
      throw new ExecutionRunError('run-authority-denied');
  }

  private assertRunController(memberId: string, node: ExecutionNodeRecord): void {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === node.taskId);
    const controller =
      node.handoff.assignee.kind === 'human'
        ? node.handoff.assignee.id
        : node.ownerId === task?.ownerId
          ? node.ownerId
          : undefined;
    if (controller !== memberId) throw new ExecutionRunError('run-not-controller');
  }

  private assertRemoteReviewNode(
    host: ExecutionRunHostPorts,
    actorId: string,
    scope: ExecutionReviewScope,
    node: ExecutionNodeRecord,
    current: boolean,
  ): void {
    if (host !== this.requireRunHost() || host.signal.aborted)
      throw new RemoteRunError('remote-unavailable');
    this.assertRunNodeAccess(host, actorId, scope.spaceId, node);
    this.assertReviewController(actorId, node);
    if (current) {
      const plans = this.workbench
        .readWorkbench()
        .appliedPlans.filter((plan) => plan.taskId === scope.taskId);
      const latest = Math.max(...plans.map((plan) => plan.revision));
      const selected = plans.filter((plan) => plan.revision === latest);
      if (selected.length !== 1 || selected[0]!.id !== scope.planId || latest !== scope.revision)
        throw new RemoteRunError('remote-stale-plan');
      this.assertCurrentExpertReviewTarget(host, scope, node);
    }
  }

  private assertReviewController(memberId: string, node: ExecutionNodeRecord): void {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === node.taskId);
    if (node.ownerId !== memberId || task?.ownerId !== memberId)
      throw new ExecutionReviewError('review-not-controller');
  }

  private assertCurrentExpertReviewTarget(
    host: ExecutionRunHostPorts,
    scope: ExecutionReviewScope,
    validatedNode?: ExecutionNodeRecord,
  ): ExecutionNodeRecord {
    // The private drive check has just validated/cloned this node synchronously.
    // Its next check after the Host callback resolves a fresh node again.
    const node = validatedNode ?? this.readRunNode(scope);
    if (!node) throw new ExecutionReviewReadError('review-target-changed');
    const review = splitExecutionReviewRecord(node).review;
    const attempt = review?.attempts.find((item) => item.scope.runId === scope.runId);
    if (attempt)
      this.assertWorkflowReviewBinding(
        node,
        attempt,
        undefined,
        validatedNode !== undefined,
        review,
      );
    this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, node);
    this.assertReviewController(scope.actorId, node);
    const target = executionReviewTarget(node, scope.spaceId);
    const reviewer = scope.review.principal.reviewerRef;
    const plan = createExecutionHandoff(node, this.workbench.readWorkbench());
    const frozen = plan.participants.find((p) => p.id === reviewer.id);
    const live = this.workbench.readWorkbench().participants.find((p) => p.id === reviewer.id);
    const round = node.rounds.find((r) => r.id === target.roundId)!;
    if (
      canonicalPayload(target) !== canonicalPayload(scope.review.target) ||
      !frozen ||
      frozen.kind !== 'expert' ||
      !frozen.available ||
      !frozen.instructions.trim() ||
      reviewer.version !== node.planId ||
      createHash('sha256').update(canonicalPayload(frozen)).digest('hex') !== reviewer.digest ||
      !live ||
      live.kind !== 'expert' ||
      !live.available ||
      !node.handoff.reviewerIds.includes(reviewer.id) ||
      !round.reviewerIds.includes(reviewer.id) ||
      round.ballots.some(
        (ballot) => ballot.reviewerId === reviewer.id && ballot.action !== 'comment',
      )
    )
      throw new ExecutionReviewReadError('review-target-changed');
    return node;
  }

  private currentExpertReviewPreparation(
    host: ExecutionRunHostPorts,
    lease: ExecutionMemberLease,
    input: z.infer<typeof expertReviewPreparationSchema> & { readonly configurationId?: string },
  ) {
    if (host !== this.requireRunHost()) throw new ExecutionRunError('run-authority-denied');
    lease.assertCurrent(input.target.spaceId);
    const node = this.readRunNode(input.target);
    if (!node) throw new ExecutionRunError('run-authority-denied');
    this.assertRunNodeAccess(host, lease.memberId, input.target.spaceId, node);
    this.assertReviewController(lease.memberId, node);
    if (input.reviewerRef.version !== node.planId)
      throw new ExecutionReviewError('review-plan-mismatch');
    const applied = createExecutionHandoff(node, this.workbench.readWorkbench());
    const live = this.workbench
      .readWorkbench()
      .participants.find((p) => p.id === input.reviewerRef.id);
    if (!live || live.kind !== 'expert' || !live.available)
      throw new ExecutionReviewError('review-expert-unavailable');
    const reservation = createHash('sha256')
      .update(
        canonicalPayload({
          location: input.target,
          controllerMemberId: lease.memberId,
          requestId: input.requestId,
        }),
      )
      .digest('hex');
    const state = readExecutionReviewState(node);
    const receipt = state?.receipts.find((item) => item.requestId === input.requestId);
    const prior = receipt && state?.attempts.find((item) => item.scope.runId === receipt.runId);
    const plan = this.storage.readPlan(planKey(node.taskId, node.planId, node.revision));
    const workflow = workflowExecutionIntentSchema.safeParse(plan?.workflowExecution);
    // Only this Service's original writer/queue derives the exception. It is
    // never a caller field; actual automatic preparation still needs its claim.
    const stopped = new Set(
      workflow.success &&
        workflow.data.status === 'running' &&
        input.requestId ===
          workflowReviewRequestId(workflow.data, input.target, input.reviewerRef.id)
        ? stoppedWorkflowReviewRunIds(node, workflow.data, (review) =>
            this.assertExpertReviewDrained(review.scope),
          )
        : [],
    );
    if (input.workflow) {
      const remote = remoteWorkflowIntentSchema.safeParse(
        plan?.remoteWorkflows?.find(
          (item) => item.intentId === input.workflow!.intentId && item.actorId === lease.memberId,
        ),
      );
      if (
        !remote.success ||
        remote.data.generation !== input.workflow.generation ||
        remote.data.spaceId !== input.target.spaceId
      )
        throw new ExecutionWorkflowError('workflow-recovery-required');
      for (const runId of stoppedRemoteWorkflowReviewRunIds(node, remote.data)) stopped.add(runId);
    }
    if (stopped.size) requireExecutionReviewWriter(this.readRunGlobal());
    // Replayed preparation must not preserve an admission permission after its
    // predecessor's genuine C proof expired between prepare and admit.
    if (prior && state) {
      for (const older of state.attempts.slice(0, state.attempts.indexOf(prior))) {
        if (
          isStoppedReviewHistory(older) &&
          canonicalPayload(older.scope.review) === canonicalPayload(prior.scope.review) &&
          !stopped.has(older.scope.runId)
        )
          throw new ExecutionWorkflowError('workflow-recovery-required');
      }
    }
    const prepared = prepareExecutionReview(
      node,
      applied,
      {
        requestId: input.requestId,
        expectedReviewVersion: input.expectedReviewVersion,
        target: input.target,
        reviewerId: input.reviewerRef.id,
        controllerMemberId: lease.memberId,
        configurationId:
          input.configurationId ?? (prior ? prior.configurationId : 'review-preparation-only'),
        newRunId: `review-run-${reservation}`,
        newSegmentId: `review-segment-${reservation}`,
      },
      stopped,
    );
    return { node, applied, prepared };
  }

  private async withRunMember<T>(
    request: MemberRequest,
    input: ExecutionNodeLocator & { spaceId: string },
    work: (
      host: ExecutionRunHostPorts,
      lease: ExecutionMemberLease,
      node: ExecutionNodeRecord,
    ) => Promise<ExecutionResult<T>>,
    requireWriter = true,
    control: 'author' | 'review' = 'author',
  ): Promise<ExecutionResult<T>> {
    const host = this.requireRunHost();
    if (requireWriter) requireExecutionRunWriter(this.readRunGlobal());
    else this.assertRunStoreCompatibility();
    let lease: ExecutionMemberLease;
    try {
      lease = await host.memberLease(request);
    } catch {
      throw new ExecutionRunError('run-authority-denied');
    }
    try {
      this.requireRunHost();
      if (
        !lease ||
        !Number.isSafeInteger(lease.expiresAt) ||
        lease.expiresAt <= Date.now() ||
        lease.signal.aborted
      )
        throw new ExecutionRunError('run-authority-denied');
      lease.assertCurrent(input.spaceId);
      const node = this.readRunNode(input);
      if (!node) throw new ExecutionRunError('run-authority-denied');
      this.assertRunNodeAccess(host, lease.memberId, input.spaceId, node);
      if (control === 'review') this.assertReviewController(lease.memberId, node);
      else this.assertRunController(lease.memberId, node);
      return await work(host, lease, node);
    } catch (error) {
      if (
        error instanceof ExecutionReviewError ||
        error instanceof ExecutionReviewFixedResultError ||
        error instanceof NativeReviewError ||
        error instanceof NativeResultDeliveryError ||
        error instanceof ExecutionReviewReadError ||
        error instanceof ExecutionRunError ||
        error instanceof ExecutionWorkflowError ||
        error instanceof ExecutionRunProtocolError ||
        error instanceof ExecutionRunCompositionError
      )
        throw error;
      throw new ExecutionRunError('run-authority-denied');
    } finally {
      try {
        lease?.release();
      } catch {
        // A release failure cannot turn a durable commit into a retryable write failure.
        this.fenceRuns();
      }
    }
  }

  private currentRunCompositionInputs(
    host: ExecutionRunHostPorts,
    lease: ExecutionMemberLease,
    input: ExecutionNodeLocator & { spaceId: string },
    visible: ExecutionNodeRecord[] | ExecutionResult<never>,
  ): { node: ExecutionNodeRecord; items: UpstreamInputView[] } {
    if (!Array.isArray(visible)) throw new ExecutionRunError('run-authority-unavailable');
    this.requireRunHost();
    lease.assertCurrent(input.spaceId);
    const node = this.readRunNode(input);
    if (!node) throw new ExecutionRunError('run-authority-denied');
    this.assertRunNodeAccess(host, lease.memberId, input.spaceId, node);
    this.assertRunController(lease.memberId, node);
    if (
      !visible.some(
        (record) =>
          samePlan(record, node.taskId, node.planId, node.revision) &&
          record.nodeId === node.nodeId,
      )
    )
      throw new ExecutionRunError('run-authority-denied');

    // A directory lookup awaited later in the scan may outlive an earlier source row.
    // Re-read only same-plan refs synchronously, after the final task/space/controller gate.
    const refs = new Set(node.handoff.inputRefs.map((ref) => ref.sourceNodeId.trim()));
    const sources = visible
      .filter(
        (record) =>
          samePlan(record, node.taskId, node.planId, node.revision) && refs.has(record.nodeId),
      )
      .flatMap((record) => {
        const current = this.readRunNode(record);
        return current ? [current] : [];
      });
    return { node, items: upstreamInputsFor(node, sources) };
  }

  private runInput<T extends ExecutionNodeLocator>(input: T, actorId: string) {
    const { taskId: _task, planId: _plan, revision: _revision, nodeId: _node, ...fields } = input;
    return { ...fields, actorId };
  }

  private async commitRunDecision(
    decision: ExecutionRunDecision,
    beforeWrite?: () => void,
  ): Promise<ExecutionResult<ExecutionRunDecision>> {
    if (decision.disposition === 'applied') {
      beforeWrite?.();
      const stored = await this.persist(() => this.writeNode(decision.record, true));
      if (!stored.ok) return stored;
    }
    return { ok: true, value: structuredClone(decision) };
  }

  private assertRunStoreCompatibility(): void {
    const nodes = this.storage.listNodes();
    assertExecutionRunStoreCompatibility(
      this.storage.readGlobal ? this.storage.readGlobal() : { schemaVersion: 1 },
      nodes,
    );
    for (const node of nodes) readExecutionRunState(node);
  }

  /** Every old writer passes here in the original queue. Never drop native metadata. */
  private async writeNode(record: ExecutionNodeRecord, native = false): Promise<void> {
    assertExecutionRunStoreCompatibility(
      this.storage.readGlobal ? this.storage.readGlobal() : { schemaVersion: 1 },
      [record],
    );
    readExecutionRunState(record);
    const current = this.storage.readNode(nodeRecordKey(record));
    if (current && !native) {
      assertExecutionRunQuiescent(current);
      if (
        canonicalPayload((current as { nativeExecution?: unknown }).nativeExecution ?? null) !==
        canonicalPayload((record as { nativeExecution?: unknown }).nativeExecution ?? null)
      )
        throw new ExecutionRunError('run-state-invalid');
    }
    await this.storage.writeNode(nodeRecordKey(record), record);
    for (const attempt of readExecutionReviewState(record)?.attempts ?? []) {
      if (attempt.status !== 'prepared' && attempt.resources === 'settled') {
        this.reviewWorkflowClaims.get(attempt.scope.runId)?.dispose();
        this.reviewWorkflowClaims.delete(attempt.scope.runId);
      }
    }
    this.notifyRuns();
  }
  private notifyRuns(): void {
    for (const recheck of [...this.runChanges]) {
      try {
        recheck();
      } catch {
        /* A notification cannot undo a durable commit. */
      }
    }
  }

  startPlan(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ disposition: string; reports: NodeExecutionReport[] }>> {
    return this.enqueue(() => this.startPlanNow(caller, body));
  }

  inbox(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<
    ExecutionResult<{
      actorId: string;
      items: readonly InboxItem[];
      nodes: ExecutionNodeView[];
      places?: readonly InboxPlace[];
    }>
  > {
    return this.enqueue(async () => {
      const opened = await this.openInbox(caller, body);
      if (!opened.ok) return opened;
      const current = this.checkListActor(caller, body, opened.actor);
      if (!current.ok) return current;
      const workbench = this.workbench.readWorkbench();
      return {
        ok: true,
        value: {
          actorId: opened.actorId,
          ...(opened.scope === undefined ? {} : { spaceId: opened.scope }),
          items: opened.items,
          nodes: opened.nodes,
          places: opened.items.map((item) => inboxPlace(workbench, item)),
        },
      };
    });
  }

  /**
   * Counts for a shortcut. The next read follows the current node status.
   * `actorId` and a requested `spaceId` are echoes, not a grant.
   */
  inboxCounts(caller: ExecutionCaller, body: unknown): Promise<ExecutionResult<InboxCounts>> {
    return this.enqueue(async () => {
      const opened = await this.openInbox(caller, body);
      if (!opened.ok) return opened;
      const current = this.checkListActor(caller, body, opened.actor);
      if (!current.ok) return current;
      return {
        ok: true,
        value: {
          actorId: opened.actorId,
          ...(opened.scope === undefined ? {} : { spaceId: opened.scope }),
          ...countInbox(opened.items),
        },
      };
    });
  }

  /**
   * Events after a cursor. A requested scope is checked before the node is
   * read or an unlock is repaired. Seen ids are dropped inside that one node.
   */
  events(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<
    ExecutionResult<{
      readonly actorId: string;
      readonly spaceId?: string | undefined;
      readonly taskId: string;
      readonly planId: string;
      readonly revision: number;
      readonly nodeId: string;
      readonly events: readonly ExecutionEvent[];
    }>
  > {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(eventsSchema, body);
      if (!parsed.ok) return parsed;
      const scope = parsed.value.spaceId;
      const space = await this.gateSpaceScoped(parsed.value.taskId, actor.value.spaceIds, scope);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const current = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!current || !intactNode(current)) return fail('not-found');
      if (
        planMembership(this.workbench.readWorkbench(), current.taskId, actor.value.actorId) !==
        'allowed'
      ) {
        return fail('not-found');
      }
      if (!recordedPlan(this.storage, current)) return fail('not-found');
      await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
      const latest = this.storage.readNode(nodeRecordKey(parsed.value)) ?? current;
      const log: readonly NodeEvent[] = Array.isArray(latest.events) ? latest.events : [];
      const page = eventsAfter(log, {
        sequence: parsed.value.after,
        seenEventIds: parsed.value.seenEventIds ?? [],
      });
      return {
        ok: true,
        value: {
          actorId: actor.value.actorId,
          ...(scope === undefined ? {} : { spaceId: scope }),
          taskId: parsed.value.taskId,
          planId: parsed.value.planId,
          revision: parsed.value.revision,
          nodeId: parsed.value.nodeId,
          events: page.flatMap((event) => {
            const published = publishExecutionEvent(event);
            return published ? [published] : [];
          }),
        },
      };
    });
  }

  /**
   * Confirmed plans this member may explicitly start. A task qualifies when it
   * is `ready`, the member owns or participates in it, the trusted directory
   * places its project in a space the member belongs to, and its latest
   * applied plan has not been started yet. No directory, an unknown project,
   * or a mismatched space hides the task; a directory failure is unavailable.
   */
  startable(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ actorId: string; plans: readonly StartablePlan[] }>> {
    return this.enqueue(async () => {
      const actor = this.listActor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(startableSchema.optional(), body ?? {});
      if (!parsed.ok) return parsed;
      if (!this.projectSpaceDirectory()) return fail('not-found');
      const scope = parsed.value?.spaceId;
      if (!this.scopeHeld(actor.value.spaceIds, scope)) {
        return {
          ok: true,
          value: {
            actorId: actor.value.actorId,
            ...(scope === undefined ? {} : { spaceId: scope }),
            plans: [],
          },
        };
      }
      const workbench = this.workbench.readWorkbench();
      const plans: StartablePlan[] = [];
      for (const task of workbench.tasks) {
        if (task.status !== 'ready') continue;
        if (planMembership(workbench, task.id, actor.value.actorId) !== 'allowed') continue;
        const space = await this.gateSpaceScoped(task.id, actor.value.spaceIds, scope);
        const current = this.checkListActor(caller, body, actor.value);
        if (!current.ok) return current;
        if (space === 'missing') continue;
        if (!space.ok) {
          if (space.error.code === 'unavailable') return space;
          continue;
        }
        const applied = workbench.appliedPlans
          .filter((plan) => plan.taskId === task.id)
          .sort((a, b) => b.revision - a.revision)[0];
        if (applied === undefined) continue;
        if (this.storage.readPlan(planKey(task.id, applied.id, applied.revision)) !== undefined) {
          continue;
        }
        plans.push({
          taskId: task.id,
          planId: applied.id,
          revision: applied.revision,
          title: task.title,
        });
      }
      const current = this.checkListActor(caller, body, actor.value);
      if (!current.ok) return current;
      return {
        ok: true,
        value: {
          actorId: actor.value.actorId,
          ...(scope === undefined ? {} : { spaceId: scope }),
          plans,
        },
      };
    });
  }

  submit(caller: ExecutionCaller, body: unknown, fileAuthority?: ExecutionFileAuthoritySource) {
    if (
      this.attachments &&
      this.fileStore &&
      body &&
      typeof body === 'object' &&
      Array.isArray((body as { files?: unknown }).files) &&
      (body as { files: unknown[] }).files.length
    )
      return this.submitFiles(caller, body, fileAuthority);
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        submitSchema,
        (actorId, request, record) => {
          if ((request.files ?? []).length > 0) {
            return {
              result: {
                ok: false as const,
                disposition: 'rejected' as const,
                code: 'files-not-accepted',
                record,
              },
              settle: false,
            };
          }
          const result = submitDelivery({
            record,
            actorId,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            draft: {
              files: [],
              links: request.links ?? [],
              ...(request.text === undefined ? {} : { text: request.text }),
            },
            artifactId: `artifact:${request.idempotencyKey}`,
            roundId: `round:${request.idempotencyKey}`,
          });
          return { result, settle: false };
        },
        'delivery-submitted',
        true,
      ),
    );
  }

  private submitFiles(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
  ) {
    const actorField = this.actorField(body);
    if (actorField) return Promise.resolve(actorField);
    const parsed = parseBody(submitSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const input = parsed.value;
    const keyed = draftKeyLimit(input.idempotencyKey);
    if (keyed) return Promise.resolve(keyed);
    return this.withFileAuthority(caller, body, source, async (actor, authority) => {
      const submit = (record: ExecutionNodeRecord, files: ArtifactFileRef[]) =>
        submitDelivery({
          record,
          actorId: actor.actorId,
          idempotencyKey: input.idempotencyKey,
          expectedVersion: input.expectedVersion,
          draft: {
            files,
            links: input.links ?? [],
            ...(input.text === undefined ? {} : { text: input.text }),
          },
          artifactId: `artifact:${input.idempotencyKey}`,
          roundId: `round:${input.idempotencyKey}`,
        });
      const space = await this.gateSpace(input.taskId, actor.spaceIds);
      if (space === 'missing' || !space.ok)
        return fail(space === 'missing' ? 'not-found' : space.error.code);
      const task = this.workbench.readWorkbench().tasks.find((item) => item.id === input.taskId);
      if (!task) return fail('not-found');
      const admission = await this.enqueue(async () => {
        const node = this.assertFileNode(
          authority,
          actor.actorId,
          input,
          task.projectId,
          space.value,
        );
        assertExecutionRunQuiescent(node);
        const bound = this.boundFileReferences(input.files ?? [], node, space.value, actor.actorId);
        const proposal = submit(node, bound.files);
        if (!proposal.ok) return fail(proposal.code);
        return {
          ok: true,
          value: {
            nodeSnapshot: canonicalPayload(node),
            projectId: task.projectId,
            spaceId: space.value,
            ...bound,
          },
        };
      });
      if (!admission.ok) return admission;
      const state = admission.value;
      let commitSnapshot: string | undefined;
      const guard = (current: ExecutionNodeRecord) => {
        const fresh = this.assertFileNode(
          authority,
          actor.actorId,
          input,
          state.projectId,
          state.spaceId,
        );
        const freshSnapshot = canonicalPayload(fresh);
        if (
          freshSnapshot !== canonicalPayload(current) ||
          (commitSnapshot !== undefined && freshSnapshot !== commitSnapshot)
        )
          throw new ArtifactUploadError('conflict');
        if (freshSnapshot !== state.nodeSnapshot) {
          const replay = submit(fresh, state.files);
          if (!replay.ok || replay.disposition !== 'replayed')
            throw new ArtifactUploadError('conflict');
        }
        commitSnapshot ??= freshSnapshot;
        const bound = this.boundFileReferences(
          input.files ?? [],
          fresh,
          state.spaceId,
          actor.actorId,
        );
        if (canonicalPayload(bound.records) !== canonicalPayload(state.records))
          throw new ArtifactUploadError('not-found');
      };
      // SDK byte verification is outside the only command queue. The resulting
      // preparation is never a grant: every final write rechecks its live source.
      for (const record of state.records)
        await this.verifyFileBytes(
          record,
          authority,
          () =>
            this.assertFileNode(authority, actor.actorId, input, state.projectId, state.spaceId),
          false,
        );
      return this.enqueue(() =>
        this.command(
          caller,
          { ...input, files: state.files },
          submitSchema,
          (_actor, request, record) => ({
            result: submit(record, request.files ?? []),
            settle: false,
          }),
          'delivery-submitted',
          true,
          guard,
        ),
      );
    });
  }

  private withFileAuthority<T>(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
    work: (
      actor: { actorId: string; spaceIds: readonly string[] },
      authority: ExecutionFileAuthority,
    ) => Promise<ExecutionResult<T>>,
    retainLeaseOnSuccess = false,
  ): Promise<ExecutionResult<T>> {
    const operation = (async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      if (typeof source !== 'function') return fail('unauthenticated');
      let authority: ExecutionFileAuthority | undefined;
      let transferred = false;
      try {
        if (this.fileLifetime.signal.aborted) return fail('cancelled');
        authority = await source();
        if (
          !authority ||
          authority.lease?.memberId !== actor.value.actorId ||
          !(authority.lease.signal instanceof AbortSignal) ||
          typeof authority.assertProjectSpace !== 'function'
        )
          return fail('unauthenticated');
        const result = await work(actor.value, authority);
        transferred = retainLeaseOnSuccess && result.ok;
        return result;
      } catch (error) {
        return fail(
          error instanceof ArtifactUploadError || error instanceof WorkbenchError
            ? error.code
            : 'unavailable',
        );
      } finally {
        if (!transferred) authority?.lease.release();
      }
    })();
    this.fileOperations.add(operation);
    void operation.then(
      () => this.fileOperations.delete(operation),
      () => this.fileOperations.delete(operation),
    );
    return operation;
  }

  private assertFileAuthority(
    authority: ExecutionFileAuthority,
    actorId: string,
    projectId: string,
    spaceId: string,
  ): void {
    const lease = authority.lease;
    if (this.fileLifetime.signal.aborted || lease.signal.aborted)
      throw new ArtifactUploadError('cancelled');
    if (
      lease.memberId !== actorId ||
      !Number.isFinite(lease.expiresAt) ||
      Date.now() >= lease.expiresAt
    )
      throw new ArtifactUploadError('unauthenticated');
    try {
      for (const result of [
        lease.assertCurrent(spaceId),
        authority.assertProjectSpace(projectId, spaceId),
      ]) {
        const checked: unknown = result;
        if (checked !== undefined) {
          void Promise.resolve(checked).catch(() => undefined);
          throw new Error('A current file authority must decide synchronously.');
        }
      }
    } catch {
      throw new ArtifactUploadError('not-found');
    }
  }

  private assertFileRecord(
    authority: ExecutionFileAuthority,
    actorId: string,
    locator: { taskId: string; planId: string; revision: number; nodeId: string },
    projectId: string,
    spaceId: string,
  ): ExecutionNodeRecord {
    this.assertFileAuthority(authority, actorId, projectId, spaceId);
    const workbench = this.workbench.readWorkbench();
    const task = workbench.tasks.find((item) => item.id === locator.taskId);
    if (
      !task ||
      task.projectId !== projectId ||
      !this.directory().includes(actorId) ||
      planMembership(workbench, locator.taskId, actorId) !== 'allowed'
    )
      throw new ArtifactUploadError('not-found');
    return this.currentFileNode(locator);
  }

  /** Read the exact current node without cloning its whole artifact history per byte chunk. */
  private currentFileNode(locator: {
    taskId: string;
    planId: string;
    revision: number;
    nodeId: string;
  }): ExecutionNodeRecord {
    const node = this.storage.readNode(nodeRecordKey(locator));
    if (
      !node ||
      !intactNode(node) ||
      !samePlan(node, locator.taskId, locator.planId, locator.revision) ||
      node.nodeId !== locator.nodeId ||
      !recordedPlan(this.storage, node)
    )
      throw new ArtifactUploadError('not-found');
    try {
      readExecutionRunState(node);
    } catch {
      throw new ArtifactUploadError('not-found');
    }
    return node;
  }

  private assertFileNode(
    authority: ExecutionFileAuthority,
    actorId: string,
    locator: { taskId: string; planId: string; revision: number; nodeId: string },
    projectId: string,
    spaceId: string,
  ): ExecutionNodeRecord {
    const node = this.assertFileRecord(authority, actorId, locator, projectId, spaceId);
    if (node.handoff.assignee.kind !== 'human' || node.handoff.assignee.id !== actorId)
      throw new ArtifactUploadError('not-assignee');
    return node;
  }

  private boundFileReferences(
    files: readonly ArtifactFileRef[],
    node: ExecutionNodeRecord,
    spaceId: string,
    memberId: string,
  ): { records: UploadFileRecord[]; files: ArtifactFileRef[] } {
    if (!this.fileStore || !this.attachments) throw new ArtifactUploadError('files-not-accepted');
    if (
      files.length > ARTIFACT_FILE_LIMITS.maxFilesPerSubmission ||
      new Set(files.map((file) => file.id)).size !== files.length
    )
      throw new ArtifactUploadError('validation');
    const records = files.map((file) => {
      const record = this.fileStore!.get(file.id);
      if (
        !record ||
        record.uploadedBy !== memberId ||
        record.spaceId !== spaceId ||
        record.taskId !== node.taskId ||
        record.planId !== node.planId ||
        record.revision !== node.revision ||
        record.nodeId !== node.nodeId ||
        !matchesArtifactFileReference(file, record)
      )
        throw new ArtifactUploadError('not-found');
      return { ...record };
    });
    if (
      records.reduce((sum, record) => sum + record.byteSize, 0) > ARTIFACT_FILE_LIMITS.maxNodeBytes
    )
      throw new ArtifactUploadError('quota-exceeded');
    return { records, files: records.map(artifactFileReference) };
  }

  private async verifyFileBytes(
    record: UploadFileRecord,
    authority: ExecutionFileAuthority,
    assertCurrent: () => unknown,
    collect: boolean,
  ): Promise<{ bytes: Uint8Array | undefined; release(): void }> {
    return this.verifyOwnedFileBytes(
      record,
      AbortSignal.any([authority.lease.signal, this.fileLifetime.signal]),
      assertCurrent,
      collect,
    );
  }

  /** Same physical quota/drain for human reads and the Host-only Run consumer. */
  private async verifyOwnedFileBytes(
    record: UploadFileRecord,
    signal: AbortSignal,
    assertCurrent: () => unknown,
    collect: boolean,
    drainBeforeReject = false,
  ): Promise<{ bytes: Uint8Array | undefined; readonly drain: Promise<void>; release(): void }> {
    if (!this.attachments) throw new ArtifactUploadError('unavailable');
    if (
      [...this.fileReadResources].filter((item) => item.spaceId === record.spaceId).length >=
      ARTIFACT_FILE_LIMITS.maxConcurrentReadsPerSpace
    )
      throw new ArtifactUploadError('quota-exceeded');
    const read = readVerifiedArtifactFile({
      attachments: this.attachments,
      record,
      signal,
      assertCurrent: () => {
        assertCurrent();
      },
      collect,
    });
    let resolveRelease!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const release = () => {
      resolveRelease();
    };
    const resource = {
      spaceId: record.spaceId,
      drain: Promise.all([read.drain, released]).then(() => undefined),
    };
    this.fileReadResources.add(resource);
    signal.addEventListener('abort', release, { once: true });
    if (!collect || signal.aborted) release();
    void resource.drain.then(() => {
      signal.removeEventListener('abort', release);
      this.fileReadResources.delete(resource);
    });
    try {
      return { bytes: await read.result, release, drain: resource.drain };
    } catch (error) {
      release();
      if (drainBeforeReject) await resource.drain;
      throw error;
    }
  }

  sealFileReads(): void {
    this.fileLifetime.abort();
  }
  async closeFileReads(): Promise<void> {
    this.sealFileReads();
    while (this.fileOperations.size) await Promise.allSettled([...this.fileOperations]);
    while (this.fileReadResources.size)
      await Promise.all([...this.fileReadResources].map((item) => item.drain));
  }

  /** Host-only factory: the original installed issuer, not a structural grant, authorizes. */
  createRunAcceptedFiles(
    issuer: ExecutionRunAuthorities,
    resources: NativeRunFileResourceSource,
  ): NativeRunAcceptedFiles {
    if (issuer !== this.runAuthorities) throw new ArtifactUploadError('unavailable');
    return this.acceptedFilePort<NativeWorkGrant>(
      (grant) => issuer.assertGrant(grant, 'send'),
      resources,
      () => issuer === this.runAuthorities,
    );
  }

  private acceptedFilePort<Grant extends ExecutionAcceptedFileGrant>(
    assertGrant: (grant: Grant) => void,
    resources: NativeRunFileResourceSource,
    isIssuerCurrent: () => boolean,
  ): ExecutionAcceptedFilePort<Grant> {
    const host = this.requireRunHost();
    const attachments = this.attachments;
    const files = this.fileStore;
    if (
      !isIssuerCurrent() ||
      !attachments ||
      !files ||
      !(resources?.signal instanceof AbortSignal) ||
      typeof resources.assertCurrent !== 'function'
    )
      throw new ArtifactUploadError('unavailable');
    const assertCurrent = (grant: Grant, signal: AbortSignal) => {
      if (!isIssuerCurrent() || host !== this.requireRunHost())
        throw new ArtifactUploadError('unavailable');
      assertGrant(grant);
      if (signal.aborted || resources.signal.aborted || this.fileLifetime.signal.aborted)
        throw new ArtifactUploadError('cancelled');
      if (attachments !== this.attachments || files !== this.fileStore)
        throw new ArtifactUploadError('unavailable');
      const result: unknown = resources.assertCurrent(attachments);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new ArtifactUploadError('unavailable');
      }
    };
    const operation = <T>(work: () => Promise<T>): Promise<T> => {
      const pending = Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          if (error instanceof ArtifactUploadError || error instanceof ExecutionRunError)
            throw error;
          throw new ArtifactUploadError('unavailable');
        });
      this.fileOperations.add(pending);
      void pending.then(
        () => this.fileOperations.delete(pending),
        () => this.fileOperations.delete(pending),
      );
      return pending;
    };
    const begin = (grant: Grant, caller: AbortSignal) => {
      // Check issuer identity before inspecting any claimed scope/signal.
      assertGrant(grant);
      if (!(caller instanceof AbortSignal)) throw new ArtifactUploadError('invalid-request');
      const signal = AbortSignal.any([
        caller,
        grant.signal,
        resources.signal,
        host.signal,
        this.fileLifetime.signal,
        this.runLifetime.signal,
      ]);
      assertCurrent(grant, signal);
      return signal;
    };
    const capture = (grant: Grant, inputRef: string, signal: AbortSignal) => {
      assertCurrent(grant, signal);
      const initial = this.currentRunFileInput(grant.scope, inputRef, host);
      const fingerprint = canonicalPayload(initial);
      const check = () => {
        assertCurrent(grant, signal);
        if (canonicalPayload(this.currentRunFileInput(grant.scope, inputRef, host)) !== fingerprint)
          throw new ArtifactUploadError('not-found');
        assertCurrent(grant, signal);
      };
      return { ...initial, check };
    };
    return Object.freeze({
      list: (grant, raw, caller) =>
        operation(async () => {
          const signal = begin(grant, caller);
          const query = runFileListSchema.safeParse(raw);
          if (!query.success) throw new ArtifactUploadError('invalid-request');
          const state = capture(grant, query.data.inputRef, signal);
          const value = {
            ...structuredClone(state.source),
            files: state.infos.map((file) => ({ ...file })),
          };
          if (Buffer.byteLength(JSON.stringify(value)) > 24_576)
            throw new ArtifactUploadError('output-too-large');
          state.check();
          return { ...value, check: state.check };
        }),
      read: (grant, raw, caller) =>
        operation(async () => {
          const signal = begin(grant, caller);
          const query = runFileReadSchema.safeParse(raw);
          if (!query.success) throw new ArtifactUploadError('invalid-request');
          const { inputRef, fileId, offset, length } = query.data;
          const state = capture(grant, inputRef, signal);
          const index = state.records.findIndex((record) => record.uploadId === fileId);
          const record = state.records[index];
          const info = state.infos[index];
          if (!record || !info) throw new ArtifactUploadError('not-found');
          if (offset > record.byteSize) throw new ArtifactUploadError('invalid-request');
          let owned:
            { bytes: Uint8Array | undefined; drain: Promise<void>; release(): void } | undefined;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            signal.removeEventListener('abort', release);
            owned?.release();
            owned = undefined;
          };
          signal.addEventListener('abort', release, { once: true });
          try {
            owned = await this.verifyOwnedFileBytes(record, signal, state.check, true, true);
            state.check();
            if (released || !owned.bytes) throw new ArtifactUploadError('cancelled');
            const bytes = owned.bytes.slice(offset, Math.min(offset + length, record.byteSize));
            const encoding = runFileEncoding(info, owned.bytes);
            state.check();
            return {
              source: { ...structuredClone(state.source), file: { ...info } },
              range: { offset, length: bytes.length, total: record.byteSize },
              bytes,
              encoding,
              signal,
              drain: owned.drain,
              check() {
                if (released) throw new ArtifactUploadError('cancelled');
                state.check();
              },
              release,
            };
          } catch (error) {
            // An abort may have happened before the pending read returned its handle.
            owned?.release();
            release();
            throw error;
          }
        }),
    } satisfies ExecutionAcceptedFilePort<Grant>);
  }

  /** Host-only publication, sharing the existing human-upload queue, slots and drain. */
  private createRemoteRunOutputFiles(
    issuer: RemoteRunAuthorities,
  ): ExecutionOutputFilePort<RemoteRunFileGrant> {
    if (!this.remoteFileUploadsEnabled || issuer !== this.remoteRunAuthorities)
      throw new ArtifactUploadError('unavailable');
    const host = this.requireRunHost();
    return this.outputFilePort<RemoteRunFileGrant>(
      {
        assertGrant: (grant, action) => {
          issuer.assertFileGrant(grant, action);
        },
      },
      {
        signal: this.runLifetime.signal,
        assertCurrent: (attachments) => {
          if (host !== this.requireRunHost() || attachments !== this.attachments || !this.fileStore)
            throw new ArtifactUploadError('unavailable');
          return undefined;
        },
        assertPublication: (grant, source, selector) =>
          issuer.assertFilePublication(grant, source, selector),
      },
      () => issuer === this.remoteRunAuthorities && this.remoteFileUploadsEnabled,
    );
  }

  /** Original local factory still requires the original local issuer. */
  createRunOutputFiles(
    issuer: ExecutionRunAuthorities,
    resources: NativeOutputFileResourceSource,
  ): NativeRunOutputFiles {
    if (issuer !== this.runAuthorities) throw new ArtifactUploadError('unavailable');
    return this.outputFilePort<NativeWorkGrant>(
      issuer,
      resources,
      () => issuer === this.runAuthorities,
    );
  }

  /** Same queue, quota, stream, SDK drain and ledger for original local and authenticated remote owners. */
  private outputFilePort<Grant extends ExecutionOutputFileGrant>(
    issuer: ExecutionOutputFileIssuer<Grant>,
    resources: ExecutionOutputFileResources<Grant>,
    isIssuerCurrent: () => boolean,
  ): ExecutionOutputFilePort<Grant> {
    const host = this.requireRunHost();
    const attachments = this.attachments,
      files = this.fileStore;
    if (
      !isIssuerCurrent() ||
      !attachments ||
      !files ||
      !(resources?.signal instanceof AbortSignal) ||
      typeof resources.assertCurrent !== 'function' ||
      typeof resources.assertPublication !== 'function'
    )
      throw new ArtifactUploadError('unavailable');
    const sourceSignal = resources.signal;
    const assertResource = resources.assertCurrent;
    const assertPublication = resources.assertPublication;
    const queue = async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await this.enqueue<T>(async () => ({ ok: true, value: await work() }));
      if (!result.ok) throw new ArtifactUploadError(result.error.code);
      return result.value;
    };
    const track = <T>(job: Promise<T>): Promise<T> => {
      this.uploadOperations.add(job);
      void job.then(
        () => this.uploadOperations.delete(job),
        () => this.uploadOperations.delete(job),
      );
      return job;
    };
    return {
      readCompleted: async (grant, request, caller) => {
        issuer.assertGrant(grant, 'history');
        const parsed = z
          .strictObject({
            source: nativeOutputFileSourceSchema,
            publicationId: WorkTaskSchema.shape.id,
          })
          .safeParse(request);
        if (!parsed.success || !(caller instanceof AbortSignal))
          throw new ArtifactUploadError('invalid-request');
        const { source, publicationId } = parsed.data;
        const scope = source.scope;
        const scopeKey = canonicalPayload(scope);
        const signal = AbortSignal.any([
          caller,
          grant.signal,
          host.signal,
          sourceSignal,
          this.fileLifetime.signal,
          this.runLifetime.signal,
        ]);
        const initial = files.get(publicationId);
        if (!initial) throw new ArtifactUploadError('not-found');
        const projection = { source: structuredClone(source), record: structuredClone(initial) };
        const fingerprint = canonicalPayload(projection);
        const check = (): undefined => {
          issuer.assertGrant(grant, 'history');
          if (signal.aborted) throw new ArtifactUploadError('cancelled');
          if (
            !isIssuerCurrent() ||
            host !== this.requireRunHost() ||
            attachments !== this.attachments ||
            files !== this.fileStore ||
            resources.signal !== sourceSignal ||
            resources.assertCurrent !== assertResource
          )
            throw new ArtifactUploadError('unavailable');
          const checked: unknown = assertResource.call(resources, attachments);
          if (checked !== undefined) {
            void Promise.resolve(checked).catch(() => undefined);
            throw new ArtifactUploadError('unavailable');
          }
          if (
            canonicalPayload(grant.scope) !== scopeKey ||
            canonicalPayload(projection) !== fingerprint
          )
            throw new ArtifactUploadError('not-found');
          const node = this.currentFileNode(scope);
          this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, node);
          const run = readExecutionRunState(node)?.runs.find(
            (item) => item.attempt.id === scope.runId,
          );
          const composition = this.readRunComposition(scope);
          const publisher = Reflect.get(composition.payload, 'outputFilePublisherTool');
          const current = files.get(publicationId);
          if (
            !run ||
            canonicalPayload(executionRunScope(node, run)) !== scopeKey ||
            run.selection.configurationId !== source.configurationId ||
            run.attempt.expertVersionId !== source.expertVersionId ||
            (run.attempt.sessionId !== undefined &&
              run.attempt.sessionId !== source.nativeSessionId) ||
            (run.attempt.executorRunId !== undefined &&
              run.attempt.executorRunId !== source.nativeAgentId) ||
            !publisher ||
            canonicalPayload(publisher) !== canonicalPayload(describeNativeOutputFileTool()) ||
            !(composition.payload.toolAllowlist as readonly string[]).includes(
              NATIVE_OUTPUT_FILE_TOOL,
            ) ||
            !current ||
            current.state !== 'completed' ||
            !current.producer ||
            canonicalPayload(current.producer.source) !== canonicalPayload(source) ||
            current.uploadedBy !== scope.actorId ||
            canonicalPayload(current) !== canonicalPayload(projection.record)
          )
            throw new ArtifactUploadError('not-found');
          return undefined;
        };
        check();
        return Object.freeze({ ...projection, signal, check });
      },
      reserve: (grant, request, caller) =>
        track(
          (async () => {
            issuer.assertGrant(grant, 'send');
            const fields = {
              source: nativeOutputFileSourceSchema,
              selectorFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
              name: z.string().min(1).max(255),
            };
            const parsed = z
              .discriminatedUnion('mode', [
                z.strictObject({ ...fields, mode: z.literal('lookup') }),
                z.strictObject({
                  ...fields,
                  mode: z.literal('reserve'),
                  maximumBytes: z
                    .number()
                    .int()
                    .nonnegative()
                    .max(ARTIFACT_FILE_LIMITS.maxFileBytes)
                    .refine(Number.isSafeInteger),
                }),
              ])
              .safeParse(request);
            if (!parsed.success || !(caller instanceof AbortSignal))
              throw new ArtifactUploadError('invalid-request');
            const input = parsed.data;
            artifactFileLeaf(input.name);
            const deadline = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              deadline.abort();
            }, ARTIFACT_FILE_LIMITS.uploadTimeoutMs);
            const signal = AbortSignal.any([
              caller,
              grant.signal,
              host.signal,
              resources.signal,
              this.uploadLifetime.signal,
              this.runLifetime.signal,
              deadline.signal,
            ]);
            const source = input.source,
              scope = source.scope;
            const runKey = canonicalPayload(scope);
            const key = `native-output_${createHash('sha256').update(canonicalPayload(source)).digest('hex')}`;
            const fingerprint = canonicalPayload({
              source,
              name: input.name,
              selectorFingerprint: input.selectorFingerprint,
            });
            let permitActive = true;
            const check = (): undefined => {
              if (!permitActive) throw new ArtifactUploadError('cancelled');
              if (
                !isIssuerCurrent() ||
                host !== this.requireRunHost() ||
                attachments !== this.attachments ||
                files !== this.fileStore ||
                resources.signal !== sourceSignal ||
                resources.assertCurrent !== assertResource ||
                resources.assertPublication !== assertPublication
              )
                throw new ArtifactUploadError('unavailable');
              issuer.assertGrant(grant, 'send');
              if (signal.aborted)
                throw new ArtifactUploadError(timedOut ? 'upload-timeout' : 'cancelled');
              const checked: unknown = resources.assertCurrent(attachments);
              if (checked !== undefined) {
                void Promise.resolve(checked).catch(() => undefined);
                throw new ArtifactUploadError('unavailable');
              }
              const publication: unknown = resources.assertPublication(
                grant,
                source,
                input.selectorFingerprint,
              );
              if (publication !== undefined) {
                void Promise.resolve(publication).catch(() => undefined);
                throw new ArtifactUploadError('publication-denied');
              }
              if (canonicalPayload(grant.scope) !== runKey)
                throw new ArtifactUploadError('not-found');
              const node = this.currentFileNode(scope);
              this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, node);
              const state = readExecutionRunState(node);
              const run = state?.runs.find((r) => r.attempt.id === scope.runId);
              const composition = this.readRunComposition(scope);
              const publisher = Reflect.get(composition.payload, 'outputFilePublisherTool');
              if (
                !run ||
                state?.currentRunId !== scope.runId ||
                canonicalPayload(executionRunScope(node, run)) !== runKey ||
                run.selection.configurationId !== source.configurationId ||
                run.workspace.kind !== 'local' ||
                !publisher ||
                canonicalPayload(publisher) !== canonicalPayload(describeNativeOutputFileTool()) ||
                !(composition.payload.toolAllowlist as readonly string[]).includes(
                  NATIVE_OUTPUT_FILE_TOOL,
                ) ||
                run.attempt.expertVersionId !== source.expertVersionId ||
                (run.attempt.sessionId !== undefined &&
                  run.attempt.sessionId !== source.nativeSessionId) ||
                (run.attempt.executorRunId !== undefined &&
                  run.attempt.executorRunId !== source.nativeAgentId)
              )
                throw new ArtifactUploadError('not-found');
              return undefined;
            };
            let admitted = false;
            try {
              check();
              const completed = await queue(async () => {
                check();
                const pending = this.pendingUploads.get(key);
                if (pending)
                  throw new ArtifactUploadError(
                    pending.fingerprint === fingerprint ? 'conflict' : 'idempotency-mismatch',
                  );
                const prior = files.findNativePublication(source);
                if (!prior && files.findByIdempotencyKey(key))
                  throw new ArtifactUploadError('idempotency-mismatch');
                if (
                  prior &&
                  (prior.state !== 'completed' ||
                    prior.name !== input.name ||
                    prior.producer?.selectorFingerprint !== input.selectorFingerprint)
                )
                  throw new ArtifactUploadError('idempotency-mismatch');
                if (input.mode === 'lookup') {
                  if (!prior) throw new ArtifactUploadError('not-found');
                  return prior;
                }
                if (prior) return prior;
                const peers = [...this.pendingUploads.values()].filter(
                  (p) => p.spaceId === scope.spaceId,
                );
                if (peers.length >= ARTIFACT_FILE_LIMITS.maxConcurrentUploadsPerSpace)
                  throw new ArtifactUploadError('quota-exceeded');
                if (
                  !prior &&
                  (files.countInSpace(scope.spaceId) + peers.filter((p) => p.newFile).length >=
                    ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
                    files.countNativePublications(scope) +
                      peers.filter((p) => p.nativeRunKey === runKey && p.newFile).length >=
                      ARTIFACT_FILE_LIMITS.maxFilesPerSubmission ||
                    files.bytesForNode(scope.taskId, scope.planId, scope.revision, scope.nodeId) +
                      peers
                        .filter((p) => p.nodeKey === nodeRecordKey(scope))
                        .reduce((sum, p) => sum + p.bytes, 0) +
                      input.maximumBytes >
                      ARTIFACT_FILE_LIMITS.maxNodeBytes)
                )
                  throw new ArtifactUploadError('quota-exceeded');
                this.pendingUploads.set(key, {
                  fingerprint,
                  spaceId: scope.spaceId,
                  nodeKey: nodeRecordKey(scope),
                  bytes: prior ? 0 : input.maximumBytes,
                  newFile: !prior,
                  nativeRunKey: runKey,
                });
                admitted = true;
                return prior;
              });
              if (completed) {
                clearTimeout(timer);
                let active = true;
                return {
                  signal,
                  drain: Promise.resolve(),
                  completed: structuredClone(completed),
                  check: () => {
                    if (!active) throw new ArtifactUploadError('cancelled');
                    return check();
                  },
                  publish: async () => {
                    throw new ArtifactUploadError('conflict');
                  },
                  releaseAfter: () => {
                    active = false;
                    permitActive = false;
                  },
                } satisfies NativeOutputFileReservation;
              }
              if (input.mode !== 'reserve') throw new ArtifactUploadError('not-found');
              let resolveExternal!: () => void;
              const external = new Promise<void>((resolve) => {
                resolveExternal = resolve;
              });
              let released = false,
                publishing = false;
              let sdkDrain: Promise<void> = Promise.resolve();
              let publishSettled: Promise<void> = Promise.resolve();
              const retained = external
                .then(async () => {
                  await publishSettled;
                  await sdkDrain;
                })
                .then(() => {
                  this.pendingUploads.delete(key);
                  clearTimeout(timer);
                });
              this.uploadDrains.add(retained);
              void retained.then(() => this.uploadDrains.delete(retained));
              const permit: NativeOutputFileReservation = {
                signal,
                drain: retained,
                check,
                ...(completed ? { completed: structuredClone(completed) } : {}),
                releaseAfter: (drain) => {
                  if (released) return;
                  released = true;
                  permitActive = false;
                  clearTimeout(timer);
                  void Promise.resolve(drain).then(resolveExternal, resolveExternal);
                },
                publish: (body) => {
                  const job = (async () => {
                    check();
                    if (released || publishing || completed)
                      throw new ArtifactUploadError('conflict');
                    publishing = true;
                    const declaration = z
                      .strictObject({
                        mediaType: z.string().min(1).max(200),
                        byteSize: z
                          .number()
                          .int()
                          .nonnegative()
                          .max(input.maximumBytes)
                          .refine(Number.isSafeInteger),
                        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
                      })
                      .safeParse({
                        mediaType: body.mediaType,
                        byteSize: body.byteSize,
                        sha256: body.sha256,
                      });
                    if (
                      !declaration.success ||
                      !body.data ||
                      typeof body.data[Symbol.asyncIterator] !== 'function'
                    )
                      throw new ArtifactUploadError('validation');
                    const declare = { ...declaration.data, name: input.name };
                    const stream = new ArtifactUploadStream(body.data, declare, signal, check);
                    try {
                      const ref = await stream.wait(
                        attachments.saveFileStream({
                          name: input.name,
                          data: stream,
                          signal: stream.signal,
                        }),
                      );
                      stream.check();
                      if (
                        !stream.verified ||
                        ref.attachmentId !== `sha256:${declare.sha256}` ||
                        ref.bytes !== declare.byteSize ||
                        ref.name !== input.name
                      )
                        throw new ArtifactUploadError('digest-mismatch');
                      return await queue(async () => {
                        stream.check();
                        if (
                          files.findNativePublication(source) ||
                          files.countInSpace(scope.spaceId) >=
                            ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
                          files.bytesForNode(
                            scope.taskId,
                            scope.planId,
                            scope.revision,
                            scope.nodeId,
                          ) +
                            ref.bytes >
                            ARTIFACT_FILE_LIMITS.maxNodeBytes
                        )
                          throw new ArtifactUploadError('quota-exceeded');
                        const record: UploadFileRecord = {
                          uploadId: randomUUID(),
                          attachmentId: ref.attachmentId,
                          name: input.name,
                          mediaType: declare.mediaType,
                          byteSize: ref.bytes,
                          sha256: declare.sha256,
                          spaceId: scope.spaceId,
                          taskId: scope.taskId,
                          planId: scope.planId,
                          revision: scope.revision,
                          nodeId: scope.nodeId,
                          uploadedBy: scope.actorId,
                          idempotencyKey: key,
                          state: 'completed',
                          uploadedAt: new Date().toISOString(),
                          producer: {
                            kind: 'native-run-output',
                            version: 1,
                            source,
                            selectorFingerprint: input.selectorFingerprint,
                          },
                        };
                        await files.putNativePublication(record);
                        stream.check();
                        return structuredClone(record);
                      });
                    } finally {
                      stream.finish();
                      sdkDrain = stream.drain();
                    }
                  })();
                  publishSettled = job.then(
                    () => undefined,
                    () => undefined,
                  );
                  return track(job);
                },
              };
              return permit;
            } catch (error) {
              clearTimeout(timer);
              if (admitted) this.pendingUploads.delete(key);
              throw error;
            }
          })(),
        ),
    };
  }

  /** Current authoritative fixed objects; no human-assignee or caller impersonation. */
  private currentRunFileInput(
    scope: NativeWorkGrant['scope'],
    inputRef: string,
    host: ExecutionRunHostPorts,
    preparedComposition?: FrozenExecutionRunComposition,
  ): { source: NativeRunFileSource; infos: NativeRunFileInfo[]; records: UploadFileRecord[] } {
    if (!this.fileStore) throw new ArtifactUploadError('unavailable');
    const node = this.currentFileNode(scope);
    this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, node);
    const snapshot = preparedComposition ?? this.readRunComposition(scope);
    const saved = snapshot.payload;
    const allowed: readonly string[] = saved.toolAllowlist;
    if (
      !allowed.includes(NATIVE_ACCEPTED_FILE_TOOL) ||
      canonicalPayload(saved.scope) !== canonicalPayload(scope) ||
      canonicalPayload(saved.handoff) !== canonicalPayload(node.handoff) ||
      saved.contextRefs.length !== saved.inputs.length ||
      saved.contextRefs.filter((ref) => ref === inputRef).length !== 1
    )
      throw new ArtifactUploadError('not-found');
    const input = saved.inputs[saved.contextRefs.indexOf(inputRef)];
    if (
      !input ||
      !(node.handoff.inputRefs ?? []).some(
        (ref) =>
          ref.sourceNodeId === input.sourceNodeId &&
          ref.artifactVersionId === input.artifactVersionId,
      )
    )
      throw new ArtifactUploadError('not-found');
    const upstream = this.currentFileNode({ ...scope, nodeId: input.sourceNodeId });
    this.assertRunNodeAccess(host, scope.actorId, scope.spaceId, upstream);
    const artifact = upstream.artifactVersions.find(
      (version) => version.id === input.artifactVersionId,
    );
    if (
      upstream.acceptedArtifactVersionId !== input.artifactVersionId ||
      !artifact ||
      artifact.version !== input.version ||
      artifact.files.length > ARTIFACT_FILE_LIMITS.maxFilesPerSubmission ||
      new Set(artifact.files.map((file) => file.id)).size !== artifact.files.length
    )
      throw new ArtifactUploadError('not-found');
    const records = artifact.files.map((file) => {
      const record = this.fileStore!.get(file.id);
      if (
        !record ||
        record.spaceId !== scope.spaceId ||
        record.taskId !== scope.taskId ||
        record.planId !== scope.planId ||
        record.revision !== scope.revision ||
        record.nodeId !== upstream.nodeId ||
        !matchesArtifactFileReference(file, record)
      )
        throw new ArtifactUploadError('not-found');
      return { ...record };
    });
    const infos = records.map((record) => ({
      fileId: record.uploadId,
      name: artifactFileLeaf(record.name),
      mediaType: record.mediaType,
      bytes: record.byteSize,
      sha256: record.sha256,
    }));
    return {
      source: {
        scope: structuredClone(scope),
        inputRef,
        sourceNodeId: upstream.nodeId,
        artifactVersionId: artifact.id,
        version: artifact.version,
      },
      infos,
      records,
    };
  }

  ballot(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        ballotSchema,
        (actorId, request, record) => {
          const result = castBallot({
            record,
            actorId,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            ballot: {
              reviewerId: actorId,
              roundId: request.roundId,
              artifactVersionId: request.artifactVersionId,
              action: request.action,
              ...(request.comment === undefined ? {} : { comment: request.comment }),
              ...(request.unresolvedCommentIds === undefined
                ? {}
                : { unresolvedCommentIds: request.unresolvedCommentIds }),
            },
            comments: record.comments,
          });
          return { result, settle: true };
        },
        'ballot-recorded',
      ),
    );
  }

  settle(caller: ExecutionCaller, body: unknown) {
    return this.enqueue(() =>
      this.command(
        caller,
        body,
        settleSchema,
        (actorId, request, record) => {
          if (!maySettle(record, actorId)) {
            return {
              result: {
                ok: false as const,
                disposition: 'rejected' as const,
                code: 'not-assigned-reviewer',
                record,
              },
              settle: false,
            };
          }
          return {
            result: settleReview({
              record,
              actorId,
              idempotencyKey: request.idempotencyKey,
              expectedVersion: request.expectedVersion,
              roundId: request.roundId,
              artifactVersionId: request.artifactVersionId,
            }),
            settle: false,
          };
        },
        'review-settled',
      ),
    );
  }

  /** Project result reads share the ORIGINAL request's file/member authority.
   * Metadata/text projection never repairs dependencies, writes or opens bytes. */
  projectArtifacts(
    caller: ExecutionCaller,
    body: unknown,
    source?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<ProjectArtifactsValue>> {
    const parsed = parseBody(projectArtifactsQuerySchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const query = parsed.value,
      scope = query.view === 'list' ? query : query.ref;
    return this.withFileAuthority(caller, body, source, async (actor, authority) =>
      this.enqueue(async () => {
        const check = () => {
          this.assertFileAuthority(authority, actor.actorId, scope.projectId, scope.spaceId);
          if (
            this.fileLifetime.signal.aborted ||
            authority.lease.signal.aborted ||
            !actor.spaceIds.includes(scope.spaceId)
          )
            throw new ArtifactUploadError('not-found');
        };
        check();
        const selection = selectProjectArtifacts(
          this.workbench.readWorkbench(),
          actor.actorId,
          scope.spaceId,
          scope.projectId,
        );
        const value = projectArtifactsProjection(selection, query, (ref) => {
          check();
          try {
            return this.currentFileNode(ref);
          } catch (error) {
            if (error instanceof ArtifactUploadError && error.code === 'not-found')
              return undefined;
            throw error;
          }
        });
        check();
        const fresh = selectProjectArtifacts(
          this.workbench.readWorkbench(),
          actor.actorId,
          scope.spaceId,
          scope.projectId,
        );
        if (fresh.fingerprint !== selection.fingerprint) return fail('conflict');
        return { ok: true, value };
      }),
    );
  }

  /** Current confirmed-plan metadata only. Reuses the original request's member
   * and project authority, never the repairing report/inbox or another fact store. */
  taskProgress(
    caller: ExecutionCaller,
    body: unknown,
    source?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<TaskProgressValue>> {
    const parsed = parseBody(taskProgressQuerySchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const query = parsed.value;
    return this.withFileAuthority(caller, body, source, async (actor, authority) => {
      const lease = authority.lease;
      const { memberId, expiresAt, signal, assertCurrent, release } = lease;
      const assertProjectSpace = authority.assertProjectSpace;
      const live = () => {
        if (
          authority.lease !== lease ||
          lease.memberId !== memberId ||
          lease.expiresAt !== expiresAt ||
          lease.signal !== signal ||
          lease.assertCurrent !== assertCurrent ||
          lease.release !== release ||
          authority.assertProjectSpace !== assertProjectSpace ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= Date.now()
        )
          throw new ArtifactUploadError('unauthenticated');
        if (this.fileLifetime.signal.aborted || signal.aborted)
          throw new ArtifactUploadError('cancelled');
        if (!actor.spaceIds.includes(query.spaceId)) throw new ArtifactUploadError('not-found');
      };
      return this.enqueue(async () => {
        live();
        const currentSelection = () => {
          live();
          const projects = taskProgressProjects(
            this.workbench.readWorkbench(),
            actor.actorId,
            query,
          );
          for (const projectId of projects) {
            this.assertFileAuthority(authority, actor.actorId, projectId, query.spaceId);
            live(); // A synchronous source callback may invalidate or replace its lease.
            // Project checks are external callbacks. Stable lease fields alone
            // cannot certify that the original request still has this identity.
            try {
              synchronousRunAssertion(assertCurrent.call(lease, query.spaceId));
            } catch {
              throw new ArtifactUploadError('not-found');
            }
            live();
          }
          const state = this.workbench.readWorkbench();
          if (
            canonicalPayload(taskProgressProjects(state, actor.actorId, query)) !==
            canonicalPayload(projects)
          )
            throw new ArtifactUploadError('not-found');
          return selectTaskProgress(state, actor.actorId, query);
        };
        const selection = currentSelection();
        const check = () => {
          const current = currentSelection();
          if (current.fingerprint !== selection.fingerprint)
            throw new WorkbenchError('conflict', '当前计划已变化，请刷新。');
        };
        const value = taskProgressProjection(selection, {
          global: this.storage.readGlobal ? this.storage.readGlobal() : { schemaVersion: 1 },
          readPlan: (target) =>
            this.storage.readPlan(planKey(target.taskId, target.planId, target.revision)),
          readNode: (target) => this.storage.readNode(nodeRecordKey(target)),
        });
        check();
        return { ok: true, value };
      });
    });
  }

  report(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ reports: NodeExecutionReport[] }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(reportSchema, body);
      if (!parsed.ok) return parsed;
      const space = await this.gateSpaceScoped(
        parsed.value.taskId,
        actor.value.spaceIds,
        parsed.value.spaceId,
      );
      if (space === 'missing' || !space.ok) {
        return space === 'missing' ? fail('not-found') : space;
      }
      const membership = planMembership(
        this.workbench.readWorkbench(),
        parsed.value.taskId,
        actor.value.actorId,
      );
      if (membership === 'missing') return fail('not-found');
      if (membership === 'not-participant') return fail('not-participant');
      const { taskId, planId, revision } = parsed.value;
      const listed = () =>
        this.storage
          .listNodes()
          .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision));
      if (this.storage.readPlan(planKey(taskId, planId, revision)) === undefined) {
        if (listed().length > 0) return fail('plan-incomplete');
        return { ok: true, value: { reports: [] } };
      }
      await this.repairTaskUnlocks(taskId, actor.value.spaceIds);
      return { ok: true, value: { reports: listed().map(toNodeExecutionReport) } };
    });
  }

  /** Space, membership, and assignee checks shared by reading and saving a draft. */
  private async prepareDraft(
    spaceIds: readonly string[],
    actorId: string,
    query: { taskId: string; planId: string; revision: number; nodeId: string },
  ): Promise<ExecutionResult<ExecutionNodeRecord>> {
    const space = await this.gateSpace(query.taskId, spaceIds);
    if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    if (space === 'missing' || !space.ok) return fail('not-found');
    const current = this.storage.readNode(nodeRecordKey(query));
    if (!current || !intactNode(current)) return fail('not-found');
    const membership = planMembership(this.workbench.readWorkbench(), current.taskId, actorId);
    if (membership === 'missing') return fail('not-found');
    if (membership === 'not-participant') return fail('not-participant');
    if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
    const assignee = current.handoff.assignee;
    if (assignee.kind !== 'human' || assignee.id !== actorId) return fail('not-assignee');
    if (current.command.status !== 'ready' && current.command.status !== 'needs-revision') {
      return fail('not-deliverable');
    }
    await this.repairTaskUnlocks(query.taskId, spaceIds);
    const refreshed = this.storage.readNode(nodeRecordKey(query));
    if (!refreshed || !intactNode(refreshed)) return fail('not-found');
    return { ok: true, value: refreshed };
  }

  /** Read or save the assignee's delivery draft. The draft itself is unchanged by a read. */
  draft(
    caller: ExecutionCaller,
    body: unknown,
    fileAuthority?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<DeliveryDraftView>> {
    if (this.attachments && this.fileStore) {
      const actor = this.actor(caller, body);
      if (!actor.ok) return Promise.resolve(actor);
      if (this.isFileDraft(body)) return this.fileDraft(caller, body, fileAuthority);
    }
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
      if (!writing) {
        const parsed = parseBody(draftReadSchema, body);
        if (!parsed.ok) return parsed;
        const opened = await this.prepareDraft(
          actor.value.spaceIds,
          actor.value.actorId,
          parsed.value,
        );
        if (!opened.ok) return opened;
        return { ok: true, value: deliveryDraftView(opened.value.deliveryDraft) };
      }
      const parsed = parseBody(draftWriteSchema, body);
      if (!parsed.ok) return parsed;
      const limited = draftLinkLimit(parsed.value.links ?? []);
      if (limited) return limited;
      const sized = draftFileLimit(
        parsed.value.text ?? '',
        parsed.value.links ?? [],
        parsed.value.files ?? [],
      );
      if (sized) return sized;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const keyed = draftKeyLimit(parsed.value.idempotencyKey);
      if (keyed) return keyed;
      const opened = await this.prepareDraft(
        actor.value.spaceIds,
        actor.value.actorId,
        parsed.value,
      );
      if (!opened.ok) return opened;
      const current = opened.value;
      assertExecutionRunQuiescent(current);
      const text = parsed.value.text ?? '';
      const links = parsed.value.links ?? [];
      const files = draftFiles(parsed.value.files ?? []);
      const applied = applyDeliveryDraft({
        current: current.deliveryDraft,
        expectedVersion: parsed.value.expectedVersion,
        idempotencyKey: parsed.value.idempotencyKey,
        fingerprint: canonicalPayload({
          kind: 'delivery-draft',
          actorId: actor.value.actorId,
          nodeId: current.nodeId,
          text,
          links,
          files,
        }),
        text,
        links,
        files,
      });
      if (!applied.ok) {
        if (applied.code === 'conflict') {
          return fail('conflict', {
            currentVersion: applied.currentVersion,
            expectedVersion: parsed.value.expectedVersion,
          });
        }
        return fail(applied.code);
      }
      if (applied.disposition === 'applied') {
        const stored = await this.persist(() =>
          this.writeNode({
            ...current,
            deliveryDraft: applied.draft,
          }),
        );
        if (!stored.ok) return stored;
      }
      return { ok: true, value: deliveryDraftView(applied.draft) };
    });
  }

  private isFileDraft(body: unknown): boolean {
    const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
    const parsed = (writing ? draftWriteSchema : draftReadSchema).safeParse(body);
    if (!parsed.success) return false;
    const supplied = (parsed.data as { files?: unknown }).files;
    if (Array.isArray(supplied) && supplied.length > 0) return true;
    try {
      return (
        (this.storage.readNode(nodeRecordKey(parsed.data))?.deliveryDraft?.files.length ?? 0) > 0
      );
    } catch {
      return true;
    }
  }

  private fileDraft(
    caller: ExecutionCaller,
    body: unknown,
    source: ExecutionFileAuthoritySource | undefined,
  ): Promise<ExecutionResult<DeliveryDraftView>> {
    const writing = body !== null && typeof body === 'object' && 'idempotencyKey' in body;
    let input: z.infer<typeof draftWriteSchema> | undefined;
    let query: z.infer<typeof draftReadSchema>;
    if (writing) {
      const parsed = parseBody(draftWriteSchema, body);
      if (!parsed.ok) return Promise.resolve(parsed);
      input = parsed.value;
      query = parsed.value;
    } else {
      const parsed = parseBody(draftReadSchema, body);
      if (!parsed.ok) return Promise.resolve(parsed);
      query = parsed.value;
    }
    const write = input;
    return this.withFileAuthority(caller, body, source, async (actor, authority) => {
      const space = await this.gateSpace(query.taskId, actor.spaceIds);
      if (space === 'missing' || !space.ok)
        return fail(space === 'missing' ? 'not-found' : space.error.code);
      const task = this.workbench.readWorkbench().tasks.find((item) => item.id === query.taskId);
      if (!task) return fail('not-found');
      return this.enqueue(async () => {
        const current = this.assertFileNode(
          authority,
          actor.actorId,
          query,
          task.projectId,
          space.value,
        );
        if (current.command.status !== 'ready' && current.command.status !== 'needs-revision')
          return fail('not-deliverable');
        const view = (draft: ExecutionNodeRecord['deliveryDraft']): DeliveryDraftView => {
          const verified: ArtifactFileRef[] = [],
            details: { id: string; name: string }[] = [];
          for (const file of draft?.files ?? []) {
            try {
              const bound = this.boundFileReferences([file], current, space.value, actor.actorId);
              verified.push(...bound.files);
              details.push({ id: file.id, name: artifactFileLeaf(bound.records[0]!.name) });
            } catch {
              verified.push(...draftFiles([file]));
            }
          }
          return { ...deliveryDraftView(draft, verified), fileDetails: details };
        };
        if (!write) return { ok: true, value: view(current.deliveryDraft) };
        assertExecutionRunQuiescent(current);
        const text = write.text ?? '',
          links = write.links ?? [];
        const limited =
          draftLinkLimit(links) ??
          draftFileLimit(text, links, write.files ?? []) ??
          draftKeyLimit(write.idempotencyKey);
        if (limited) return limited;
        const bound = this.boundFileReferences(
          write.files ?? [],
          current,
          space.value,
          actor.actorId,
        );
        const files = draftFiles(bound.files);
        const applied = applyDeliveryDraft({
          current: current.deliveryDraft,
          expectedVersion: write.expectedVersion,
          idempotencyKey: write.idempotencyKey,
          fingerprint: canonicalPayload({
            kind: 'delivery-draft',
            actorId: actor.actorId,
            nodeId: current.nodeId,
            text,
            links,
            files,
          }),
          text,
          links,
          files,
        });
        if (!applied.ok)
          return fail(
            applied.code,
            applied.code === 'conflict'
              ? {
                  currentVersion: applied.currentVersion,
                  expectedVersion: write.expectedVersion,
                }
              : {},
          );
        if (applied.disposition === 'applied') {
          this.assertFileNode(authority, actor.actorId, query, task.projectId, space.value);
          const stored = await this.persist(() =>
            this.writeNode({ ...current, deliveryDraft: applied.draft }),
          );
          if (!stored.ok) return stored;
        }
        this.assertFileAuthority(authority, actor.actorId, task.projectId, space.value);
        return { ok: true, value: view(applied.draft) };
      });
    });
  }

  /** Return notes and the two newest relevant versions. The revision record itself is unchanged. */
  /**
   * Upload one file's exact bytes for a node this member currently executes.
   * The server computes the digest and length from the streamed bytes; a
   * declared size/digest mismatch fails. The trusted receipt is a server-issued
   * uploadId plus the content-addressed attachment reference; the client cannot
   * prove completion itself. Bytes publish through the upstream store; metadata
   * lands in `zhuma_files`. A missing provider, budget, or attachment service
   * fails closed.
   */
  uploadFile(
    caller: ExecutionCaller,
    options: {
      readonly declare: ArtifactFileUploadDeclare;
      readonly taskId: string;
      readonly planId: string;
      readonly revision: number;
      readonly nodeId: string;
      readonly spaceId: string;
      readonly idempotencyKey: string;
      readonly data: AsyncIterable<Uint8Array>;
      readonly signal?: AbortSignal;
    },
    authority: ExecutionFileAuthority,
  ): Promise<ExecutionResult<FileUploadReceipt>> {
    const operation = (async (): Promise<ExecutionResult<FileUploadReceipt>> => {
      const actor = this.actor(caller, options);
      if (!actor.ok) return actor;
      const attachments = this.attachments;
      const fileStore = this.fileStore;
      if (!attachments || !fileStore) return fail('unavailable');
      const located = artifactUploadOptionsSchema.safeParse({
        declare: options.declare,
        taskId: options.taskId,
        planId: options.planId,
        revision: options.revision,
        nodeId: options.nodeId,
        spaceId: options.spaceId,
        idempotencyKey: options.idempotencyKey,
      });
      if (!located.success) return fail('validation');
      const request = { ...located.data, data: options.data, signal: options.signal };
      if (request.declare.byteSize > ARTIFACT_FILE_LIMITS.maxFileBytes)
        return fail('file-too-large');
      // This is the original request's Host lease, never a MemberResolution
      // snapshot or a client-provided field. Upload does not require NativeRun.
      const lease = authority?.lease;
      if (
        !lease ||
        lease.memberId !== actor.value.actorId ||
        !(lease.signal instanceof AbortSignal) ||
        typeof lease.assertCurrent !== 'function' ||
        !Number.isFinite(lease.expiresAt) ||
        typeof authority.assertProjectSpace !== 'function'
      )
        return fail('unauthenticated');
      const signal = AbortSignal.any([
        lease.signal,
        this.uploadLifetime.signal,
        ...(request.signal ? [request.signal] : []),
      ]);
      const initialTask = this.workbench.readWorkbench().tasks.find((t) => t.id === request.taskId);
      const assertCurrent = () => {
        if (signal.aborted) throw new ArtifactUploadError('cancelled');
        if (Date.now() >= lease.expiresAt) throw new ArtifactUploadError('unauthenticated');
        try {
          // Reject an accidentally async assertion: permission must be decided
          // synchronously at the publication/write boundary.
          const asserted: unknown = lease.assertCurrent(request.spaceId);
          if (asserted !== undefined) {
            void Promise.resolve(asserted).catch(() => undefined);
            throw new Error('invalid lease assertion');
          }
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        const workbench = this.workbench.readWorkbench();
        const task = workbench.tasks.find((t) => t.id === request.taskId);
        if (
          !initialTask ||
          !task ||
          task.projectId !== initialTask.projectId ||
          !this.directory().includes(actor.value.actorId) ||
          planMembership(workbench, request.taskId, actor.value.actorId) !== 'allowed'
        )
          throw new ArtifactUploadError('not-found');
        try {
          const asserted: unknown = authority.assertProjectSpace(task.projectId, request.spaceId);
          if (asserted !== undefined) {
            void Promise.resolve(asserted).catch(() => undefined);
            throw new Error('invalid project assertion');
          }
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        let node: ExecutionNodeRecord | undefined;
        try {
          node = this.readRunNode(request);
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        if (!node) throw new ArtifactUploadError('not-found');
        if (!recordedPlan(this.storage, node)) throw new ArtifactUploadError('plan-incomplete');
        if (
          node.handoff.assignee.kind !== 'human' ||
          node.handoff.assignee.id !== actor.value.actorId
        )
          throw new ArtifactUploadError('not-assignee');
        if (node.command.status !== 'ready' && node.command.status !== 'needs-revision')
          throw new ArtifactUploadError('not-deliverable');
      };
      let stream: ArtifactUploadStream | undefined;
      const reservation = {
        fingerprint: canonicalPayload({ ...located.data, uploadedBy: actor.value.actorId }),
        spaceId: request.spaceId,
        nodeKey: nodeRecordKey(request),
        bytes: request.declare.byteSize,
        newFile: true,
      };
      let reserved = false;
      try {
        assertCurrent();
        const gate = async () => {
          const space = await this.gateSpaceScoped(
            request.taskId,
            actor.value.spaceIds,
            request.spaceId,
          );
          assertCurrent();
          if (space === 'missing' || !space.ok)
            throw new ArtifactUploadError(space === 'missing' ? 'not-found' : space.error.code);
        };
        // The only business queue admits/reserves briefly, then stays free
        // while real byte I/O waits. Same-key concurrent bodies cannot publish twice.
        await gate();
        const admission = await this.enqueue<UploadFileRecord | undefined>(async () => {
          assertCurrent();
          const pending = this.pendingUploads.get(request.idempotencyKey);
          if (pending)
            return fail(
              pending.fingerprint === reservation.fingerprint ? 'conflict' : 'idempotency-mismatch',
              { reason: 'upload-in-progress' },
            );
          const prior = fileStore.findByIdempotencyKey(request.idempotencyKey);
          if (
            prior &&
            (prior.uploadedBy !== actor.value.actorId ||
              prior.spaceId !== request.spaceId ||
              prior.taskId !== request.taskId ||
              prior.planId !== request.planId ||
              prior.revision !== request.revision ||
              prior.nodeId !== request.nodeId ||
              prior.name !== request.declare.name ||
              prior.mediaType !== request.declare.mediaType ||
              prior.byteSize !== request.declare.byteSize ||
              prior.sha256 !== request.declare.sha256)
          )
            return fail('idempotency-mismatch');
          const peers = [...this.pendingUploads.values()].filter(
            (item) => item.spaceId === request.spaceId,
          );
          if (peers.length >= ARTIFACT_FILE_LIMITS.maxConcurrentUploadsPerSpace)
            return fail('quota-exceeded');
          if (!prior) {
            if (
              fileStore.countInSpace(request.spaceId) +
                peers.filter((item) => item.newFile).length >=
                ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
              fileStore.bytesForNode(
                request.taskId,
                request.planId,
                request.revision,
                request.nodeId,
              ) +
                peers
                  .filter((item) => item.nodeKey === reservation.nodeKey)
                  .reduce((sum, item) => sum + item.bytes, 0) +
                request.declare.byteSize >
                ARTIFACT_FILE_LIMITS.maxNodeBytes
            )
              return fail('quota-exceeded');
          }
          this.pendingUploads.set(
            request.idempotencyKey,
            prior ? { ...reservation, bytes: 0, newFile: false } : reservation,
          );
          reserved = true;
          return { ok: true, value: prior };
        });
        if (!admission.ok) return admission;
        const prior = admission.value;
        stream = new ArtifactUploadStream(request.data, request.declare, signal, assertCurrent);
        if (prior) {
          for await (const _chunk of stream) {
            /* Bounded actual replay bytes. */
          }
          await stream.wait(gate());
          return await this.enqueue(async () => {
            stream!.check();
            const current = fileStore.get(prior.uploadId);
            if (
              !current ||
              current.state !== 'completed' ||
              current.idempotencyKey !== request.idempotencyKey
            )
              return fail('not-found');
            return { ok: true, value: receiptOf(current) };
          });
        }
        const ref: FileAttachmentRef = await stream.wait(
          attachments.saveFileStream({
            name: request.declare.name,
            data: stream,
            signal: stream.signal,
          }),
        );
        // Actual SDK must have observed our verified EOS; an early or malformed
        // provider response cannot mint a trusted receipt.
        if (
          !stream.verified ||
          ref.attachmentId !== `sha256:${request.declare.sha256}` ||
          ref.bytes !== request.declare.byteSize ||
          ref.name !== request.declare.name
        )
          return fail('digest-mismatch');
        await stream.wait(gate());
        return await this.enqueue(async () => {
          stream!.check();
          if (
            fileStore.countInSpace(request.spaceId) >= ARTIFACT_FILE_LIMITS.maxFilesPerSpace ||
            fileStore.bytesForNode(
              request.taskId,
              request.planId,
              request.revision,
              request.nodeId,
            ) +
              request.declare.byteSize >
              ARTIFACT_FILE_LIMITS.maxNodeBytes
          )
            return fail('quota-exceeded');
          const record = {
            uploadId: randomUUID(),
            attachmentId: ref.attachmentId,
            name: ref.name,
            mediaType: request.declare.mediaType,
            byteSize: ref.bytes,
            sha256: request.declare.sha256,
            spaceId: request.spaceId,
            taskId: request.taskId,
            planId: request.planId,
            revision: request.revision,
            nodeId: request.nodeId,
            uploadedBy: actor.value.actorId,
            idempotencyKey: request.idempotencyKey,
            state: 'completed' as const,
            uploadedAt: new Date().toISOString(),
          };
          // Keep the actual durable write owned by the existing command queue;
          // cancellation must not release that queue while a put is still writing.
          await fileStore.put(record);
          stream!.check();
          return { ok: true, value: receiptOf(record) };
        });
      } catch (error) {
        const failure = stream?.failure;
        if (failure) return fail(failure.code);
        if (error instanceof ArtifactUploadError || error instanceof WorkbenchError)
          return fail(error.code);
        return fail(signal.aborted ? 'cancelled' : 'unavailable');
      } finally {
        const releaseReservation = () => {
          if (reserved) this.pendingUploads.delete(request.idempotencyKey);
        };
        if (stream) {
          stream.finish();
          const drain = stream.drain().then(releaseReservation);
          this.uploadDrains.add(drain);
          void drain.then(() => this.uploadDrains.delete(drain));
        } else releaseReservation();
      }
    })();
    this.uploadOperations.add(operation);
    void operation.then(
      () => this.uploadOperations.delete(operation),
      () => this.uploadOperations.delete(operation),
    );
    return operation;
  }

  /** Seal before draining the existing command queue or closing either domain. */
  sealUploads(): void {
    this.uploadLifetime.abort();
  }

  async closeUploads(): Promise<void> {
    this.sealUploads();
    while (this.uploadOperations.size) await Promise.allSettled([...this.uploadOperations]);
    await this.writes;
    while (this.uploadDrains.size) await Promise.all([...this.uploadDrains]);
  }

  /**
   * Read the content of the accepted version a downstream node froze as its
   * input. Bounded, on demand, read-only: the member must be a participant of
   * the downstream task, the frozen ref must be among the node's inputRefs,
   * and the source's current accepted version must be exactly the pinned one.
   * No hidden source leaks; pending or replaced refs stay a hint, not content.
   * A read writes nothing.
   */
  fileContent(
    caller: ExecutionCaller,
    body: unknown,
    source?: ExecutionFileAuthoritySource,
  ): Promise<ExecutionResult<AuthorizedFileContent>> {
    const parsed = parseBody(fileReadSchema, body);
    if (!parsed.ok) return Promise.resolve(parsed);
    const query = parsed.value;
    return this.withFileAuthority(
      caller,
      body,
      source,
      async (actor, authority) => {
        if (!this.attachments || !this.fileStore) return fail('unavailable');
        const space = await this.gateSpaceScoped(query.taskId, actor.spaceIds, query.spaceId);
        if (space === 'missing' || !space.ok)
          return fail(space === 'missing' ? 'not-found' : space.error.code);
        const task = this.workbench.readWorkbench().tasks.find((item) => item.id === query.taskId);
        if (!task) return fail('not-found');
        const assertAccess = () =>
          this.readableFileRecord(authority, actor.actorId, query, task.projectId);
        const record = assertAccess();
        const check = () => {
          const fresh = assertAccess();
          if (canonicalPayload(fresh) !== canonicalPayload(record))
            throw new ArtifactUploadError('not-found');
        };
        const info: FileContentInfo = {
          request: { ...query },
          uploadId: record.uploadId,
          name: artifactFileLeaf(record.name),
          mediaType: record.mediaType,
          bytes: record.byteSize,
          sha256: record.sha256,
          reference: artifactFileReference(record),
        };
        const signal = AbortSignal.any([authority.lease.signal, this.fileLifetime.signal]);
        let read: { bytes: Uint8Array | undefined; release(): void } | undefined;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          signal.removeEventListener('abort', release);
          read?.release();
          authority.lease.release();
        };
        signal.addEventListener('abort', release, { once: true });
        try {
          if (query.mode !== 'metadata')
            read = await this.verifyFileBytes(record, authority, check, true);
          if (signal.aborted) throw new ArtifactUploadError('cancelled');
          const fresh = assertAccess();
          if (canonicalPayload(fresh) !== canonicalPayload(record))
            throw new ArtifactUploadError('not-found');
          return {
            ok: true,
            value: {
              info,
              ...(read?.bytes === undefined ? {} : { bytes: read.bytes }),
              signal,
              check: () => {
                if (released) throw new ArtifactUploadError('cancelled');
                check();
              },
              release,
            },
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      true,
    );
  }

  private readableFileRecord(
    authority: ExecutionFileAuthority,
    actorId: string,
    query: FileContentRequest,
    projectId: string,
  ): UploadFileRecord {
    if (!this.fileStore) throw new ArtifactUploadError('not-found');
    const target = this.assertFileRecord(authority, actorId, query, projectId, query.spaceId);
    let source = target;
    let file: ArtifactFileRef | undefined;
    let expertProducerRunId: string | undefined;
    if (query.purpose === 'draft') {
      if (
        target.handoff.assignee.kind !== 'human' ||
        target.handoff.assignee.id !== actorId ||
        (target.command.status !== 'ready' && target.command.status !== 'needs-revision')
      )
        throw new ArtifactUploadError('not-found');
    } else {
      if (query.purpose === 'upstream') {
        if (
          target.handoff.assignee.kind !== 'human' ||
          target.handoff.assignee.id !== actorId ||
          !(target.handoff.inputRefs ?? []).some(
            (ref) =>
              ref.sourceNodeId === query.sourceNodeId &&
              ref.artifactVersionId === query.artifactVersionId,
          )
        )
          throw new ArtifactUploadError('not-found');
        try {
          source = this.currentFileNode({ ...query, nodeId: query.sourceNodeId });
        } catch {
          throw new ArtifactUploadError('not-found');
        }
        if (
          !source ||
          !recordedPlan(this.storage, source) ||
          source.acceptedArtifactVersionId !== query.artifactVersionId
        )
          throw new ArtifactUploadError('not-found');
      }
      const artifact =
        query.purpose === 'accepted'
          ? acceptedProjectFileArtifact(this.workbench.readWorkbench(), actorId, query, source)
          : source.artifactVersions.find((item) => item.id === query.artifactVersionId);
      if (!artifact) throw new ArtifactUploadError('not-found');
      if (query.purpose === 'review') {
        const round = source.rounds.find(
          (item) => item.id === query.roundId && item.artifactVersionId === artifact.id,
        );
        if (
          !round ||
          round.status === 'voided' ||
          !round.reviewerIds.includes(actorId) ||
          !source.handoff.reviewerIds.includes(actorId)
        )
          throw new ArtifactUploadError('not-found');
      } else if (query.purpose === 'artifact') {
        try {
          // Reuse the original exact-node controller rule for both human and
          // expert work; task membership/ownership alone never grants a read.
          this.assertRunController(actorId, source);
          if (source.handoff.assignee.kind === 'expert') {
            if (!artifact.producerRunId) throw new ArtifactUploadError('not-found');
            expertProducerRunId = artifact.producerRunId;
          }
        } catch {
          throw new ArtifactUploadError('not-found');
        }
      }
      file = artifact.files.find((item) => item.id === query.uploadId);
      if (!file) throw new ArtifactUploadError('not-found');
      if (query.purpose === 'accepted' && authority.lease.signal.aborted)
        throw new ArtifactUploadError('not-found');
    }
    const record = this.fileStore.get(query.uploadId);
    if (
      !record ||
      record.state !== 'completed' ||
      record.spaceId !== query.spaceId ||
      record.taskId !== source.taskId ||
      record.planId !== source.planId ||
      record.revision !== source.revision ||
      record.nodeId !== source.nodeId ||
      (expertProducerRunId !== undefined &&
        (!record.producer ||
          record.producer.source.scope.actorId !== actorId ||
          record.producer.source.scope.runId !== expertProducerRunId ||
          (['spaceId', 'taskId', 'planId', 'revision', 'nodeId'] as const).some(
            (key) => record.producer!.source.scope[key] !== record[key],
          ))) ||
      (query.purpose === 'draft'
        ? record.uploadedBy !== actorId
        : !file || !matchesArtifactFileReference(file, record))
    )
      throw new ArtifactUploadError('not-found');
    return { ...record };
  }

  /** Shared fixed-source reader, called only after the original member/task/space
   * gates or the remote device+permit gates. Metadata is copied; no file bytes or links are fetched. */
  private readUpstreamContent(
    actorId: string,
    spaceId: string,
    downstream: ExecutionNodeRecord,
    sourceNodeId: string,
    artifactVersionId: string,
  ): UpstreamContentValue | undefined {
    if (
      !downstream.handoff.inputRefs.some(
        (ref) => ref.sourceNodeId === sourceNodeId && ref.artifactVersionId === artifactVersionId,
      )
    )
      return undefined;
    const source = this.storage.readNode(nodeRecordKey({ ...downstream, nodeId: sourceNodeId }));
    if (
      !source ||
      !intactNode(source) ||
      source.nodeId !== sourceNodeId ||
      !samePlan(source, downstream.taskId, downstream.planId, downstream.revision) ||
      source.acceptedArtifactVersionId !== artifactVersionId
    )
      return undefined;
    const artifact = source.artifactVersions.find((item) => item.id === artifactVersionId);
    if (!artifact) return undefined;
    return {
      actorId,
      spaceId,
      downstream: {
        taskId: downstream.taskId,
        planId: downstream.planId,
        revision: downstream.revision,
        nodeId: downstream.nodeId,
      },
      source: {
        taskId: source.taskId,
        planId: source.planId,
        revision: source.revision,
        nodeId: source.nodeId,
      },
      version: { id: artifact.id, version: artifact.version },
      content: {
        ...(artifact.text === undefined ? {} : { text: artifact.text }),
        links: [...artifact.links],
        files: artifact.files.map((file) => ({ ...file })),
      },
    };
  }

  upstreamContent(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<UpstreamContentValue>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(upstreamContentSchema, body);
      if (!parsed.ok) return parsed;
      if (!this.projectSpaceDirectory()) return fail('not-found');
      // The scope is required for this read: a member holding two spaces must
      // name the current one, so the chosen constraint is always explicit.
      const scope = parsed.value.spaceId;
      if (!this.scopeHeld(actor.value.spaceIds, scope)) return fail('not-found');
      // Authorize the downstream node first: the member must belong to its task.
      const space = await this.gateSpaceScoped(parsed.value.taskId, actor.value.spaceIds, scope);
      if (space === 'missing' || !space.ok) return space === 'missing' ? fail('not-found') : space;
      const downstream = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!downstream || !intactNode(downstream)) return fail('not-found');
      const membership = planMembership(
        this.workbench.readWorkbench(),
        downstream.taskId,
        actor.value.actorId,
      );
      if (membership !== 'allowed') return fail('not-found');
      const value = this.readUpstreamContent(
        actor.value.actorId,
        scope,
        downstream,
        parsed.value.sourceNodeId,
        parsed.value.artifactVersionId,
      );
      return value ? { ok: true, value } : fail('not-found');
    });
  }

  revision(
    caller: ExecutionCaller,
    body: unknown,
  ): Promise<ExecutionResult<{ view: RevisionView }>> {
    return this.enqueue(async () => {
      const actor = this.actor(caller, body);
      if (!actor.ok) return actor;
      const parsed = parseBody(revisionSchema, body);
      if (!parsed.ok) return parsed;
      const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
      if (space === 'missing' || !space.ok) return fail('not-found');
      const current = this.storage.readNode(nodeRecordKey(parsed.value));
      if (!current || !intactNode(current)) return fail('not-found');
      const membership = planMembership(
        this.workbench.readWorkbench(),
        current.taskId,
        actor.value.actorId,
      );
      if (membership === 'missing') return fail('not-found');
      if (membership === 'not-participant') return fail('not-participant');
      if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
      const reviewerNames: Record<string, string> = {};
      for (const participant of this.workbench.readWorkbench().participants) {
        const name = participant.name.trim();
        if (name !== '') reviewerNames[participant.id] = name;
      }
      const read = readRevisionView(current, actor.value.actorId, reviewerNames);
      if (!read.ok) return fail(read.code);
      await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
      return { ok: true, value: { view: read.view } };
    });
  }

  /** Fill unlocks that were settled before their downstream write landed. */
  reconcile(): Promise<ExecutionResult<{ unlocked: number }>> {
    return this.enqueue(() => this.reconcileNow());
  }

  /**
   * Finish unlocks for one task the caller is already allowed to see.
   * A failed write is left for the next authorized request and does not
   * change this request's result. Other tasks are not written.
   */
  private async repairTaskUnlocks(taskId: string, spaceIds: readonly string[]): Promise<void> {
    const space = await this.gateSpace(taskId, spaceIds);
    if (space === 'missing' || !space.ok) return;
    for (const record of [...this.storage.listNodes()]) {
      if (
        !intactNode(record) ||
        record.command.status !== 'completed' ||
        record.taskId !== taskId
      ) {
        continue;
      }
      try {
        const result = await this.unlockFrom(record);
        if (!result.ok) return;
      } catch {
        return;
      }
    }
  }

  private enqueue<T>(work: () => Promise<ExecutionResult<T>>): Promise<ExecutionResult<T>> {
    const operation = this.writes.then(work, work).catch((error: unknown) => {
      if (
        error instanceof ArtifactUploadError ||
        error instanceof WorkspaceApprovalError ||
        error instanceof ExecutionReviewReadError ||
        error instanceof ExecutionReviewError ||
        error instanceof ExecutionReviewFixedResultError ||
        error instanceof ExecutionWorkflowError ||
        error instanceof ExecutionRunError ||
        error instanceof ExecutionRunProtocolError ||
        error instanceof ExecutionRunCompositionError
      )
        return fail(error.code);
      throw error;
    });
    this.writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private directory(): readonly string[] {
    return directoryIds(this.workbench.readWorkbench());
  }

  private actorField(
    body: unknown,
  ): { readonly ok: false; readonly error: ExecutionFailure } | undefined {
    const scan = scanActorField(body);
    if (scan === 'too-deep') return fail('validation');
    if (scan === 'present') return fail('actor-from-body');
    return undefined;
  }

  private actor(
    input: ExecutionCaller,
    body: unknown,
  ): ExecutionResult<{ readonly actorId: string; readonly spaceIds: readonly string[] }> {
    const actorField = this.actorField(body);
    if (actorField) return actorField;
    const resolved = resolveActor(input.member, this.directory());
    if (!resolved.ok) return fail(resolved.code);
    return {
      ok: true,
      value: { actorId: resolved.actorId, spaceIds: resolved.spaceIds },
    };
  }

  /** Normal member list reads use the SAME current account/space directory as
   * the member workbench. Absence keeps legacy semantics; a broken injection
   * never falls back to legacy participants or caller-supplied space echoes. */
  private listActor(
    input: ExecutionCaller,
    body: unknown,
  ): ExecutionResult<{
    readonly actorId: string;
    readonly spaceIds: readonly string[];
  }> {
    if (!('memberDirectory' in this.workbench)) return this.actor(input, body);
    const actorField = this.actorField(body);
    if (actorField) return actorField;
    const member = input.member;
    if (!member || member.ok !== true) {
      const rejected = resolveActor(member, []);
      return rejected.ok ? fail('unauthenticated') : fail(rejected.code);
    }
    if (
      typeof member.memberId !== 'string' ||
      !Array.isArray(member.spaceIds) ||
      member.spaceIds.some((space) => typeof space !== 'string')
    )
      return fail('unauthenticated');
    try {
      const directory = this.workbench.memberDirectory?.();
      if (!directory) return directoryUnavailable();
      const actorId = member.memberId.trim();
      const read = () => {
        const spaces = new Set<string>(),
          accounts = new Set<string>();
        for (const space of directory.spacesForMember(actorId)) {
          const members = directory.membersForSpace(space.id);
          if (!members.every((item) => typeof item.id === 'string' && item.id.length > 0))
            throw Error('Invalid member directory.');
          if (
            !directory.isMember(space.id, actorId) ||
            !members.some((item) => item.id === actorId)
          )
            continue;
          spaces.add(space.id);
          for (const account of members) accounts.add(account.id);
        }
        return { spaceIds: [...spaces].sort(), accounts: [...accounts] };
      };
      const before = read();
      const resolved = resolveActor(member, before.accounts);
      if (!resolved.ok) return fail(resolved.code);
      const after = read();
      const current = resolveActor(member, after.accounts);
      if (!current.ok) return fail(current.code);
      if (canonicalPayload(before.spaceIds) !== canonicalPayload(after.spaceIds))
        return directoryUnavailable();
      return { ok: true, value: { actorId: current.actorId, spaceIds: after.spaceIds } };
    } catch {
      return directoryUnavailable();
    }
  }
  private checkListActor(
    caller: ExecutionCaller,
    body: unknown,
    original: { readonly actorId: string; readonly spaceIds: readonly string[] },
  ): ExecutionResult<void> {
    if (!('memberDirectory' in this.workbench)) return { ok: true, value: undefined };
    const current = this.listActor(caller, body);
    if (!current.ok) return current;
    return current.value.actorId === original.actorId &&
      canonicalPayload(current.value.spaceIds) === canonicalPayload(original.spaceIds)
      ? { ok: true, value: undefined }
      : directoryUnavailable();
  }

  /** Absent or unusable injection. Callers do not fall back to the project id. */
  private projectSpaceDirectory(): ProjectSpaceDirectory | undefined {
    const directory = this.projectSpaces;
    if (typeof directory?.spaceForProject !== 'function') return undefined;
    return directory;
  }

  /**
   * Ask the directory before distinguishing a missing task from a hidden one.
   * A thrown lookup, `unavailable`, or an ok answer whose space id cannot be
   * used is the same answer either way.
   * No directory, an unknown project, or a mismatch is not-found.
   * A missing task is asked with its task id only when that id matches
   * `WorkTaskSchema`. Any other requested id is not-found and is not sent.
   * An empty string is never sent.
   */
  /**
   * The requested space scope is a filter the caller chose, never a grant.
   * The member must currently hold it in the trusted session: an unknown,
   * revoked, or foreign scope is indistinguishable from an empty one for
   * reads (empty list) and from a missing task for commands (not-found).
   */
  private scopeHeld(spaceIds: readonly string[], scope: string | undefined): boolean {
    if (scope === undefined) return true;
    return spaceIds.includes(scope);
  }

  /**
   * Scope check on top of the space gate: the task's owning space must equal
   * the requested scope. Returns the gate verdict; a scoped miss collapses
   * into not-found for commands and an empty projection for reads.
   */
  private async gateSpaceScoped(
    taskId: string,
    spaceIds: readonly string[],
    scope: string | undefined,
  ): Promise<'missing' | ExecutionResult<string>> {
    const space = await this.gateSpace(taskId, spaceIds);
    if (scope === undefined || space === 'missing' || !space.ok) return space;
    if (space.value !== scope) return fail('not-found');
    return space;
  }

  private async gateSpace(
    taskId: string,
    spaceIds: readonly string[],
  ): Promise<'missing' | ExecutionResult<string>> {
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === taskId);
    const directory = this.projectSpaceDirectory();
    if (!directory) {
      if (!task) return 'missing';
      return fail('not-found');
    }
    let lookup: ProjectSpaceLookup;
    try {
      if (!task && !acceptedTaskId(taskId)) return 'missing';
      const projectId = task ? task.projectId : taskId;
      if (projectId === '') return task ? fail('not-found') : 'missing';
      lookup = await directory.spaceForProject(projectId);
    } catch {
      return directoryUnavailable();
    }
    if (
      lookup == null ||
      typeof lookup !== 'object' ||
      (!lookup.ok && lookup.reason !== 'unknown')
    ) {
      return directoryUnavailable();
    }
    const decision = decideProjectSpace(lookup, spaceIds);
    if (decision === 'ok' && lookup.ok) return { ok: true, value: lookup.spaceId };
    if (decision === 'unavailable') return directoryUnavailable();
    if (!task) return 'missing';
    return fail('not-found');
  }

  /**
   * Shared inbox read. An unknown scope is an empty projection and does not
   * ask the directory. A held scope keeps that space; no scope keeps every
   * space the member can already see.
   */
  private async openInbox(caller: ExecutionCaller, body: unknown) {
    const actor = this.listActor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(inboxSchema.optional(), body ?? {});
    if (!parsed.ok) return parsed;
    if (!this.projectSpaceDirectory()) return fail('not-found');
    const scope = parsed.value?.spaceId;
    if (!this.scopeHeld(actor.value.spaceIds, scope)) {
      // Unknown or revoked scope: an empty projection, indistinguishable from an empty space.
      return {
        ok: true as const,
        actor: actor.value,
        actorId: actor.value.actorId,
        scope,
        items: [] as readonly InboxItem[],
        nodes: [] as ExecutionNodeView[],
      };
    }
    const visible = await this.readableRecords(actor.value.spaceIds, actor.value.actorId, scope);
    if (!Array.isArray(visible)) return visible;
    const current = this.checkListActor(caller, body, actor.value);
    if (!current.ok) return current;
    for (const taskId of new Set(visible.map((record) => record.taskId))) {
      const current = this.checkListActor(caller, body, actor.value);
      if (!current.ok) return current;
      await this.repairTaskUnlocks(taskId, actor.value.spaceIds);
    }
    const records = await this.readableRecords(actor.value.spaceIds, actor.value.actorId, scope);
    if (!Array.isArray(records)) return records;
    const refreshed = this.checkListActor(caller, body, actor.value);
    if (!refreshed.ok) return refreshed;
    const items = executionInbox({ actorId: actor.value.actorId, records });
    const nodes = records
      .filter((record) =>
        items.some((item) => item.nodeId === record.nodeId && item.taskId === record.taskId),
      )
      .map((record) => ({ ...toNodeView(record), inputs: upstreamInputsFor(record, records) }));
    return {
      ok: true as const,
      actor: actor.value,
      actorId: actor.value.actorId,
      scope,
      items,
      nodes,
    };
  }

  /**
   * Intact nodes this actor can read. A requested scope keeps that space only.
   * A failed lookup stops the scan, whether or not any node is stored.
   */
  private async readableRecords(spaceIds: readonly string[], actorId: string, scope?: string) {
    for (const task of this.workbench.readWorkbench().tasks) {
      const space = await this.gateSpaceScoped(task.id, spaceIds, scope);
      if (space !== 'missing' && !space.ok && space.error.code === 'unavailable') return space;
    }
    const records: ExecutionNodeRecord[] = [];
    for (const record of this.storage.listNodes()) {
      if (!intactNode(record) || !recordedPlan(this.storage, record)) continue;
      const space = await this.gateSpaceScoped(record.taskId, spaceIds, scope);
      if (space === 'missing') continue;
      if (!space.ok) {
        if (space.error.code === 'unavailable') return space;
        continue;
      }
      if (planMembership(this.workbench.readWorkbench(), record.taskId, actorId) !== 'allowed') {
        continue;
      }
      records.push(record);
    }
    return records;
  }

  /** Hidden upstream refs refuse the write. The message is the count placeholder. */
  private async upstreamRefusal(
    spaceIds: readonly string[],
    actorId: string,
    current: ExecutionNodeRecord,
  ) {
    const readable = await this.readableRecords(spaceIds, actorId);
    if (!Array.isArray(readable)) return readable;
    const message = upstreamBlockMessage(upstreamInputsFor(current, readable));
    if (message === undefined) return undefined;
    return {
      ok: false as const,
      error: { code: 'upstream-blocked', message, details: {} },
    };
  }

  /**
   * Another plan in this space already used the key.
   * Only an explicit other space id is ignored, so a foreign key neither
   * blocks the start nor changes the response when that lookup succeeds.
   * `unknown` is a directory fault here: the task still exists on the workbench.
   * A throw, `unavailable`, `unknown`, or an unusable answer refuses the start.
   */
  private async sameSpaceIdempotencyConflict(
    idempotencyKey: string,
    key: string,
    spaceId: string,
    projectId: string,
  ): Promise<ExecutionResult<boolean>> {
    const directory = this.projectSpaceDirectory();
    const tasks = this.workbench.readWorkbench().tasks;
    const spaceByProject = new Map<string, string | undefined>([[projectId, spaceId]]);
    for (const item of this.storage.listPlans()) {
      if (item.receipt.idempotencyKey !== idempotencyKey || item.key === key) continue;
      const task = taskForPlanKey(item.key, tasks);
      if (!task) continue;
      let owner = spaceByProject.get(task.projectId);
      if (!spaceByProject.has(task.projectId)) {
        owner = undefined;
        if (directory) {
          try {
            const lookup = await directory.spaceForProject(task.projectId);
            if (lookup != null && typeof lookup === 'object' && lookup.ok === false) {
              return directoryUnavailable();
            }
            const decision = decideProjectSpace(lookup, [spaceId]);
            if (decision === 'unavailable') return directoryUnavailable();
            owner = decision === 'ok' ? spaceId : undefined;
          } catch {
            return directoryUnavailable();
          }
        }
        spaceByProject.set(task.projectId, owner);
      }
      if (owner === spaceId) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }

  private async startPlanNow(caller: ExecutionCaller, body: unknown, beforeWrite?: () => void) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(startSchema, body);
    if (!parsed.ok) return parsed;
    const { taskId, planId, revision, idempotencyKey } = parsed.value;
    // The chosen scope re-checks the plan's owning space before any idempotent
    // replay: "currently in A, the old plan actually lives in B" refuses even
    // when the member holds both spaces.
    const space = await this.gateSpaceScoped(taskId, actor.value.spaceIds, parsed.value.spaceId);
    if (space === 'missing' || !space.ok) {
      return space === 'missing' ? fail('not-found') : space;
    }
    const membership = planMembership(this.workbench.readWorkbench(), taskId, actor.value.actorId);
    if (membership === 'not-participant') return fail('not-participant');
    const fingerprint = canonicalPayload({ taskId, planId, revision });
    const key = planKey(taskId, planId, revision);
    const task = this.workbench.readWorkbench().tasks.find((item) => item.id === taskId);
    if (!task) return fail('not-found');
    const prior = this.storage.readPlan(key);
    // The same key replays before the conflict scan, so another project's
    // directory fault cannot change that retry. Any other key is checked first.
    // A replay still compensates unlocks that failed after the nodes completed.
    // Reports are read only after that compensation succeeds, so a retry that
    // finishes a previously failed downstream write does not return the blocked snapshot.
    const replayAfterUnlock = async () => {
      const compensated = await this.unlockCompleted(taskId, planId, revision);
      if (!compensated.ok) return compensated;
      return {
        ok: true as const,
        value: { disposition: 'replayed', reports: this.reportsFor(taskId, planId, revision) },
      };
    };
    if (prior?.fingerprint === fingerprint && prior.idempotencyKey === idempotencyKey) {
      return replayAfterUnlock();
    }
    const conflict = await this.sameSpaceIdempotencyConflict(
      idempotencyKey,
      key,
      space.value,
      task.projectId,
    );
    if (!conflict.ok) return conflict;
    if (conflict.value) return fail('idempotency-mismatch');
    if (prior?.fingerprint === fingerprint) {
      return replayAfterUnlock();
    }
    let applied;
    try {
      applied = createExecutionHandoff(
        { taskId, planId, revision },
        this.workbench.readWorkbench(),
      );
    } catch (error) {
      if (error instanceof WorkbenchError) return fail(error.code);
      return directoryUnavailable();
    }
    const started = startAppliedPlan({
      requested: { taskId, planId, revision },
      applied,
      actorId: actor.value.actorId,
      existing: this.storage
        .listNodes()
        .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision)),
    });
    if (!started.ok) return fail(started.code);
    for (const record of started.records) {
      const key = nodeRecordKey(record);
      if (this.storage.readNode(key) === record) continue;
      const stamped = withExecutionEvent(record, 'node-started', actor.value.actorId);
      if (!stamped) return fail('unavailable');
      beforeWrite?.();
      const stored = await this.persist(() => this.writeNode(stamped));
      if (!stored.ok) return stored;
    }
    const compensated = await this.unlockCompleted(taskId, planId, revision);
    if (!compensated.ok) return compensated;
    const receipt: PlanReceipt = {
      idempotencyKey,
      fingerprint,
      nodeIds: started.records.map((record) => record.nodeId),
    };
    beforeWrite?.();
    const stored = await this.persist(() => this.storage.writePlan(key, receipt));
    if (!stored.ok) return stored;
    return {
      ok: true as const,
      value: {
        disposition: started.disposition,
        reports: started.records.map(toNodeExecutionReport),
      },
    };
  }

  private async command<
    T extends {
      taskId: string;
      planId: string;
      revision: number;
      nodeId: string;
      expectedVersion: number;
    },
  >(
    caller: ExecutionCaller,
    body: unknown,
    schema: z.ZodType<T>,
    run: (
      actorId: string,
      request: T,
      record: ExecutionNodeRecord,
    ) => { result: ReturnType<typeof submitDelivery>; settle: boolean },
    eventType: string,
    guardUpstream = false,
    beforeFileWrite?: (current: ExecutionNodeRecord) => void,
  ) {
    const actor = this.actor(caller, body);
    if (!actor.ok) return actor;
    const parsed = parseBody(schema, body);
    if (!parsed.ok) return parsed;
    const space = await this.gateSpace(parsed.value.taskId, actor.value.spaceIds);
    if (space !== 'missing' && !space.ok) {
      if (space.error.code === 'unavailable') return space;
      return fail('not-found');
    }
    const current = this.storage.readNode(nodeRecordKey(parsed.value));
    if (space === 'missing' || !current || !intactNode(current)) return fail('not-found');
    const membership = planMembership(
      this.workbench.readWorkbench(),
      current.taskId,
      actor.value.actorId,
    );
    if (membership === 'missing') return fail('not-found');
    if (membership === 'not-participant') return fail('not-participant');
    if (!recordedPlan(this.storage, current)) return fail('plan-incomplete');
    assertExecutionRunQuiescent(current);
    beforeFileWrite?.(current);
    const executed = run(actor.value.actorId, parsed.value, current);
    if (!executed.result.ok) {
      return fail(
        executed.result.code,
        rejectionDetails(executed.result.code, current, parsed.value),
      );
    }
    let record = executed.result.record;
    if (executed.settle && record.currentRoundId) {
      const round = record.rounds.find((item) => item.id === record.currentRoundId);
      if (
        round &&
        (round.status === 'approved' || round.status === 'changes-requested') &&
        !settlementLanded(record, round.id)
      ) {
        const settled = settleReview({
          record,
          actorId: actor.value.actorId,
          idempotencyKey: `settle:${round.id}`,
          expectedVersion: record.command.version,
          roundId: round.id,
          artifactVersionId: round.artifactVersionId,
        });
        if (!settled.ok) return fail(settled.code);
        record = settled.record;
      }
    }
    if (record !== current) {
      if (guardUpstream) {
        const blocked = await this.upstreamRefusal(
          actor.value.spaceIds,
          actor.value.actorId,
          current,
        );
        if (blocked) return blocked;
        record = withoutDeliveryDraft(record);
      }
      beforeFileWrite?.(current);
      if (executed.result.disposition === 'applied') {
        const stamped = withExecutionEvent(record, eventType, actor.value.actorId);
        if (!stamped) return fail('unavailable');
        record = stamped;
      }
      const stored = await this.persist(() => this.writeNode(record));
      if (!stored.ok) return stored;
    }
    if (record.command.status === 'completed') {
      const unlocked = await this.unlockFrom(record);
      if (!unlocked.ok) return unlocked;
    }
    await this.repairTaskUnlocks(current.taskId, actor.value.spaceIds);
    return {
      ok: true as const,
      value: {
        disposition: executed.result.disposition,
        report: toNodeExecutionReport(record),
        node: toNodeView(record),
      },
    };
  }

  /** Idempotent unlock for nodes already completed in this plan. Write failures propagate. */
  private async unlockCompleted(
    taskId: string,
    planId: string,
    revision: number,
  ): Promise<ExecutionResult<void>> {
    const completed = this.storage
      .listNodes()
      .filter(
        (record) =>
          intactNode(record) &&
          samePlan(record, taskId, planId, revision) &&
          record.command.status === 'completed',
      );
    for (const record of completed) {
      const latest = this.storage.readNode(nodeRecordKey(record));
      if (!latest || !intactNode(latest) || latest.command.status !== 'completed') continue;
      const unlocked = await this.unlockFrom(latest);
      if (!unlocked.ok) return unlocked;
    }
    return { ok: true, value: undefined };
  }

  private async unlockFrom(completed: ExecutionNodeRecord): Promise<ExecutionResult<number>> {
    const source = completionSource(completed);
    if (!source || completed.ownerId === null) return { ok: true, value: 0 };
    let unlocked = 0;
    const peers = () =>
      this.storage
        .listNodes()
        .filter(
          (record) =>
            intactNode(record) &&
            samePlan(record, completed.taskId, completed.planId, completed.revision),
        );
    for (const downstream of downstreamRecords(peers(), completed.nodeId)) {
      const latest = this.storage.readNode(nodeRecordKey(downstream)) ?? downstream;
      const moved = unlockDownstream({
        record: latest,
        dependencies: peers(),
        actorId: completed.ownerId,
        idempotencyKey: unlockKey(source, downstream.nodeId),
        expectedVersion: latest.command.version,
      });
      if (!moved.ok || moved.disposition !== 'applied') continue;
      const stamped = withExecutionEvent(moved.record, 'downstream-unlocked', completed.ownerId);
      if (!stamped) return fail('unavailable');
      const stored = await this.persist(() => this.writeNode(stamped));
      if (!stored.ok) return stored;
      unlocked += 1;
    }
    return { ok: true, value: unlocked };
  }

  private async reconcileNow() {
    let unlocked = 0;
    for (const record of [...this.storage.listNodes()]) {
      if (!intactNode(record) || record.command.status !== 'completed') continue;
      try {
        const result = await this.unlockFrom(record);
        if (!result.ok) continue;
        unlocked += result.value;
      } catch {
        continue;
      }
    }
    return { ok: true as const, value: { unlocked } };
  }

  private reportsFor(taskId: string, planId: string, revision: number) {
    return this.storage
      .listNodes()
      .filter((record) => intactNode(record) && samePlan(record, taskId, planId, revision))
      .map(toNodeExecutionReport);
  }

  private async persist(write: () => Promise<void>): Promise<ExecutionResult<void>> {
    try {
      await write();
      return { ok: true, value: undefined };
    } catch (error) {
      if (
        error instanceof ExecutionReviewError ||
        error instanceof ExecutionRunError ||
        error instanceof ExecutionRunProtocolError
      )
        return fail(error.code);
      return fail('unavailable');
    }
  }
}
