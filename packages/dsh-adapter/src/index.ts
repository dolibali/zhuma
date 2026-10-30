import type { ActorRef, ExecutionEngine } from '@zhuma/agent-core';
import type { ContextPack } from '@zhuma/context';

/** DSH runs only when this port is given an explicit native engine. */
export interface ExecutionRequest {
  readonly taskId: string;
  readonly instruction: string;
  readonly workspaceDirectory: string;
  readonly context: ContextPack;
}

export type ExecutionResult =
  | { readonly status: 'completed'; readonly summary: string }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly reason: string };

export interface ExecutionPort {
  readonly engine: ExecutionEngine;
  execute(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

/**
 * Map B's internal execution classification onto an external actor.
 * A human stays human. An agent run with an expert id becomes that expert.
 * An agent run without one stays the human owner. The result is never `agent`.
 */
export function toHandoffActor(input: {
  readonly humanId: string;
  readonly runtime: 'human' | 'agent';
  readonly expertId?: string;
}): ActorRef {
  if (input.runtime === 'human') return { id: input.humanId, kind: 'human' };
  if (input.expertId !== undefined && input.expertId.trim() !== '') {
    return { id: input.expertId, kind: 'expert' };
  }
  return { id: input.humanId, kind: 'human' };
}

/** Explicit selection only; a missing executor must never silently change engines. */
export function selectExecutor(
  engine: ExecutionEngine,
  executors: readonly ExecutionPort[],
): ExecutionPort {
  const matches = executors.filter((executor) => executor.engine === engine);
  if (matches.length === 0) throw new Error(`Executor is not configured: ${engine}`);
  if (matches.length !== 1) throw new Error(`Executor is registered more than once: ${engine}`);
  const executor = matches[0];
  if (!executor) throw new Error(`Executor is not configured: ${engine}`);
  return executor;
}

export type {
  AgentActivity,
  AgentExecutor,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  CancelReceipt,
  DshModelConfig,
  DshModelConfigResult,
  ExecutorCapabilities,
  ResourceGrant,
  SimulatedExecutorOptions,
} from './agent-executor.js';
export {
  ExecutorNotImplementedError,
  SimulatedAgentExecutor,
  UnimplementedNativeExecutor,
  readDshModelConfig,
  selectAgentExecutor,
} from './agent-executor.js';
export {
  DshChatExecutor,
  describeDshSessionEvent,
  dshSessionHome,
  resolveDshBinary,
  resolveDshDataDir,
  sweepDshSessionOrphans,
} from './dsh-sdk-executor.js';

export type { FileProbeResult } from './file-probe.js';
export { probeRelativeFile, readRelativeFile } from './file-probe.js';

export type { DeskJournal } from './file-journal.js';
export { createFileJournal } from './file-journal.js';

export type {
  DeskContextSeed,
  DeskDependencies,
  DeskPersistence,
  DeskResult,
  DeskSeed,
} from './execution-desk.js';
export { ExecutionDesk, executionHint } from './execution-desk.js';

export type { WorkbenchServerOptions } from './workbench-server.js';
export { createWorkbenchServer } from './workbench-server.js';

export {
  ACTOR_FIELD_DEPTH_LIMIT,
  containsActorField,
  resolveActor,
  scanActorField,
  type ActorFieldScan,
  type ActorResolution,
  type MemberRequest,
  type MemberResolution,
  type MemberResolver,
} from './execution-identity.js';
export {
  ExecutionService,
  toNodeView,
  type ExecutionFailure,
  type ExecutionNodeView,
  type ExecutionResult as ExecutionCommandResult,
  type ExecutionStorage,
  type PlanReceipt,
  type BeginRunRequest,
  type StopRunRequest,
  type ExecutionNodeLocator,
  type ExecutionRunHostPorts,
  type RunEventAuthority,
  type ExecutionRunCompositionInputs,
} from './execution-service.js';
export {
  applySpaceDirectory,
  openSpaceDirectory,
  SPACE_DIRECTORY_MEMBERSHIP_LIMIT,
  SPACE_DIRECTORY_SPACE_LIMIT,
  spaceDirectoryDomainSpec,
  spaceDirectoryFor,
  type AuthorizedSpace,
  type OpenedSpaceDirectoryHandle,
  type SpaceDirectory,
  type SpaceDirectoryImport,
  type SpaceDirectoryWriter,
  type SpaceKind,
  type SpaceDirectoryInitializationStatus,
  type SpaceDirectoryOpenOptions,
} from './space-directory.js';
export type {
  IdentityInitializationHandle,
  IdentityInitializationOptions,
  IdentityInitializationStatus,
  IdentitySetupContext,
  IdentitySetupPreparation,
  IdentitySetupSnapshot,
} from './identity-session.js';
export type { HostLocalSetupInput, HostLocalSetupSnapshot } from './host-local-setup-http.js';
export type * from './s1-integration.js';
export {
  describeNativeAcceptedFileTool,
  registerNativeAcceptedFileTool,
  NATIVE_ACCEPTED_FILE_TOOL,
  NATIVE_ACCEPTED_FILE_TOOL_VERSION,
} from './native-work-session-files-tool.js';
export type {
  NativeRunAcceptedFiles,
  NativeRunFileResourceSource,
  NativeRunFileList,
  NativeRunFilePage,
} from './native-work-session-files-contract.js';
export {
  openExecutionMemberLease,
  type ExecutionMemberDirectoryBinding,
  type IdentityExecutionOptions,
} from './member-session.js';
export type {
  ExecutionMemberLease,
  ExecutionUnadmittedCleanupAuthority,
} from './execution-run-authority.js';
export type {
  ExecutionFileAuthoritySource,
  FileContentRequest,
  FileContentInfo,
} from './execution-service.js';
export type {
  NativeConversationFrame,
  NativeInboxSnapshot,
  NativeSessionLineage,
  NativeWorkSessionRecord,
  NativeRunMigrationGrant,
  NativeMigrationOriginRequest,
  NativeMigrationOrigin,
  NativeMigrationDrain,
  NativeBindingReference,
  NativeRunMigrationResult,
  NativeScopeCleanupAuthority,
  NativeScopeCleanupResult,
} from './native-work-session-contract.js';
export type { NativeDshWorkingDirectory } from './native-work-session-dsh.js';
export {
  NativeRunLocalToolProducer,
  NativeRunLocalToolError,
  NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
  NATIVE_RUN_LOCAL_TOOL_CONFIG,
  NATIVE_RUN_LOCAL_IO_LIMITS,
  describeNativeRunLocalTools,
  adoptNativeRunLocalTools,
  type NativeRunWorkspaceCapability,
  type NativeRunLocalProducerSource,
  type NativeRunLocalToolsAdoption,
} from './native-run-local-tools.js';
export {
  createNativeOutputFileIssuer,
  type NativeOutputFileIssuer,
} from './native-work-session-output-file.js';
export {
  NativeOutputFileByteProducer,
  type NativeOutputFileRead,
} from './native-work-session-output-file-source.js';
export { describeNativeOutputFileTool } from './native-work-session-output-file-tool.js';
export {
  createNativeFixedResultPublicationsIssuer,
  type NativeFixedResultIssuer,
  type NativeFixedResultPublicationsIssuer,
} from './native-work-session-result.js';
export { describeNativeResultPublicationsTool } from './native-work-session-result-publications-tool.js';
export {
  createNativeWorkflowBridge,
  type NativeWorkflowRunPort,
} from './native-work-session-workflow-bridge.js';
export type {
  WorkflowExecutionView,
  WorkflowStartTicket,
  WorkflowRunDefaults,
  WorkflowLocation,
} from './execution-workflow-contract.js';
export type { HostWorkflowView, HostWorkflowOptions } from './host-workflow-owner.js';
export {
  ExecutionReviewCompositionError,
  freezeExecutionReviewComposition,
  readExecutionReviewComposition,
  assertExecutionReviewComposition,
  executionReviewCompositionRequest,
  type ExecutionReviewPreparation,
  type ExecutionReviewCompositionInput,
  type FrozenExecutionReviewComposition,
  type ExecutionReviewToolDefinition,
} from './execution-review-composition.js';
export type { ExecutionReviewTarget, ExecutionReviewScope } from './execution-review-contract.js';
export { describeNativeReviewTool } from './native-work-session-review-tool.js';
export { describeNativeReviewReadTool } from './native-work-session-review-read.js';
export {
  NATIVE_RESULT_PUBLICATIONS_TOOL_VERSION,
  type NativeFixedResultPublicationsLease,
  type NativeFixedResultPublicationsSource,
  type NativePublicationManifestEntry,
} from './native-work-session-result-publications-contract.js';
export {
  NATIVE_OUTPUT_FILE_TOOL,
  NATIVE_OUTPUT_FILE_VERSION,
  type NativeOutputPublicationAuthority,
  type NativeOutputFileResourceSource,
  type NativeOutputFileReservation,
  type NativeRunOutputFiles,
  type NativePublishedFileRef,
  type NativePublishedFileLease,
} from './native-work-session-output-file-contract.js';
export {
  describeAcceptedInputTool,
  type NativeAcceptedInputToolDefinition,
} from './native-work-session-input-tool.js';
export {
  BASIC_TASK_EXECUTOR,
  EXECUTION_COMPOSITION_LIMITS,
  ExecutionRunCompositionError,
  assertExecutionRunComposition,
  assertExecutionRunCompositionBinding,
  executionRunCompositionRequest,
  executionRunCompositionSchema,
  freezeExecutionRunComposition,
  readExecutionRunComposition,
  type ExecutionCompositionTools,
  type ExecutionRunCompositionInput,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
export {
  requireNativeInboxRetention,
  NativeInboxRetentionUnsupportedError,
  type NativeInboxRetentionOptions,
  type RetainedInboxAgentRegistry,
  type RetainedInboxCreateOptions,
  type RetainedInboxResumeOptions,
} from './native-session-lifecycle.js';
export {
  apply as applyExecution,
  executionEndpoints,
  inject as executionInject,
  type ExecutionPluginConfig,
} from './execution-plugin.js';
export type {
  MemberWorkbenchCommand,
  MemberWorkbenchPlan,
  MemberWorkbenchDirectory,
  MemberWorkbenchCatalog,
  MemberWorkbenchOptions,
  MemberWorkbenchSnapshot,
  MemberWorkbenchPlanValue,
  MemberWorkbenchResult,
} from './member-workbench-dto.js';
export {
  applyMemberWorkbench,
  openMemberWorkbenchHttp,
  memberWorkbenchEndpoints,
  type MemberWorkbenchMountOptions,
  type MemberWorkbenchHttpHandle,
} from './member-workbench-http.js';
export { memberWorkbenchDirectoryFor } from './member-workbench-directory.js';
export {
  hostTeamCatalogManifest,
  hostTeamCatalogPin,
  type HostTeamCatalogGrants,
} from './host-team-catalog.js';
export {
  MemberWorkbenchOperations,
  openMemberWorkbenchOperations,
} from './member-workbench-operation.js';
export type {
  IdentityMemberLifecycleHandle,
  IdentityMemberLifecycleOptions,
  IdentityTeamView,
} from './identity-member-lifecycle.js';
export {
  openKnowledgeService,
  KnowledgeService,
  KnowledgeError,
  type KnowledgeServiceOptions,
} from './knowledge-service.js';

export {
  MemberLocalExecutionClient,
  MemberLocalTransportError,
} from './member-local-execution-client.js';
export type {
  MemberLocalClientOptions,
  MemberLocalTransportCode,
} from './member-local-execution-client.js';
export {
  MemberLocalExecutionProtocol,
  MemberLocalProtocolError,
} from './member-local-execution-protocol.js';
export type {
  MemberLocalProtocolOptions,
  MemberLocalAcceptedRun,
  MemberLocalRunHandle,
  MemberLocalReadHandle,
  MemberLocalStopInput,
  MemberLocalRecoveryInput,
  MemberLocalPreparedAccept,
  MemberLocalAcceptInput,
  MemberLocalWorkflowInput,
} from './member-local-execution-protocol.js';
export {
  NativeMemberWorkflowConsumer,
  type NativeMemberWorkflowConsumerOptions,
  type NativeMemberWorkflowHooks,
  type NativeMemberWorkflowPreparation,
} from './native-work-session-member-workflow.js';
export { MemberLocalExecutionOwner } from './member-local-execution-owner.js';
export type {
  MemberLocalOwnerOptions,
  MemberLocalOwnerView,
} from './member-local-execution-owner.js';
export {
  MemberLocalExecutionSecrets,
  MemberLocalSecretError,
} from './member-local-execution-secrets.js';
export type {
  MemberLocalPrivateStore,
  MemberLocalDeviceIdentity,
  MemberLocalAcceptSecrets,
} from './member-local-execution-secrets.js';
export { createMemberLocalPrivateStore } from './host-member-local-credentials.js';
export { MEMBER_LOCAL_REMOTE_METHODS } from './host-remote-run-http.js';
export { MemberLocalReviewProtocol } from './member-local-review-protocol.js';
export type {
  MemberLocalReviewAcceptInput,
  MemberLocalReviewRecoveryInput,
  MemberLocalReviewReconcileInput,
  MemberLocalReviewStopInput,
  MemberLocalReviewReadHandle,
  MemberLocalReviewRunHandle,
  MemberLocalAcceptedReview,
  MemberLocalPreparedReviewAccept,
} from './member-local-review-protocol.js';
export type { MemberLocalReviewView } from './member-local-execution-review.js';
export {
  MEMBER_KNOWLEDGE_TOOL,
  describeMemberKnowledgeTool,
  registerMemberKnowledgeTool,
} from './member-knowledge-tool.js';
export type {
  MemberKnowledgeToolDefinition,
  MemberKnowledgePortRequest,
  MemberKnowledgePortResult,
  MemberKnowledgeToolPorts,
} from './member-knowledge-tool.js';
export { RemoteRunMigrationAuthorities } from './remote-run-migration-authority.js';
export type { RemoteRunMigrationSource } from './remote-run-migration-authority.js';
export {
  REMOTE_RUN_UPLOAD_MEDIA_TYPE,
  REMOTE_RUN_UPLOAD_METHOD,
  encodeRemoteRunUploadPrefix,
} from './remote-run-file-transport.js';
export type { RemoteRunUpload } from './remote-run-files.js';
export type { RemoteTeamAssetFileReadGrant } from './remote-team-asset-file-authority.js';
export { TeamAssetFileBytes, TeamAssetFileError } from './team-asset-file.js';
export type {
  TeamAssetFileAuthority,
  TeamAssetFileBlob,
  TeamAssetFileDeclare,
  TeamAssetFileErrorCode,
  TeamAssetFileOperation,
} from './team-asset-file.js';
export { TeamAssetFileService } from './team-asset-file-service.js';
export type { TeamAssetFileReadHandle } from './team-asset-file-service.js';
export { openTeamAssetFileHttp, TEAM_ASSET_FILE_HTTP_PATHS } from './team-asset-file-http.js';
export {
  createVerifiedTeamAssetFile,
  verifiedTeamAssetFileInfo,
  readVerifiedTeamAssetText,
  type VerifiedTeamAssetFile,
} from './team-asset-file-carrier.js';
export {
  openTeamAssetRunFileHttp,
  type TeamAssetRunFileHttpSources,
} from './team-asset-run-file-http.js';
export {
  TEAM_ASSET_FILE_TOOL,
  TEAM_ASSET_FILE_TOOL_VERSION,
  describeTeamAssetFileTool,
  registerTeamAssetFileTool,
} from './team-asset-file-tool.js';
export type {
  TeamAssetFileToolPorts,
  TeamAssetFileToolRow,
  TeamAssetFileToolContent,
  TeamAssetFileCarrierReadHandle,
  TeamAssetFileToolReadHandle,
} from './team-asset-file-tool.js';
export { preflightTeamAssetImport } from './team-asset-import.js';
export type { TeamAssetImportPreflight } from './team-asset-import.js';

export { MemberAssetService } from './member-asset-service.js';
export type { MemberAssetServiceOptions } from './member-asset-service.js';
export { TeamAssetCatalogService } from './team-asset-catalog.js';
export type { TeamAssetCatalogSources } from './team-asset-catalog.js';

export { openMemberAssetHttp, MEMBER_ASSET_ENDPOINTS } from './member-asset-http.js';
export type { MemberAssetHttpSources } from './member-asset-http.js';
export {
  CODEARTS_PROFILE_ID,
  createCodeArtsProfileRegistration,
  CodeArtsProfileRegistrationProducer,
} from './executors/codearts/registration.js';
export type {
  CodeArtsAcpProfile,
  CodeArtsLaunchArtifact,
  CodeArtsProfileRegistration,
} from './executors/codearts/registration.js';
