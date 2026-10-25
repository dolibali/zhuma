import type { Context } from '@deepseek-ai/cordis';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { Workbench } from '@zhuma/agent-core';
import type { ExecutionNodeView } from '@zhuma/dsh-adapter';
import type {
  MemberWorkbenchSnapshot as HostMemberSnapshot,
  MemberWorkbenchCommand as HostMemberCommand,
  MemberWorkbenchPlan as HostMemberPlan,
  MemberWorkbenchPlanValue as HostMemberPlanValue,
} from '@zhuma/dsh-adapter';
import {
  DeliveryPanel,
  ExecutionWorkspace,
  InboxPanel,
  ReviewWorkspace,
  createExecutionApi,
  type ExecutionApi as ClientExecutionApi,
  type UpstreamInputWire,
  type UpstreamContentQuery,
  type UpstreamContentWire,
  type ExecutionNodeWire as ClientExecutionNodeWire,
  type SavedDeliveryDraftWire,
  type DeliveryDraftSave,
  type ExecutionInboxValue as ClientInboxValue,
  type InboxPlaceWire,
  type ExecutionStartableValue as ClientStartableValue,
  type StartablePlanWire,
  type StartPlanDraft,
  type StartPlanValue as ClientStartPlanValue,
  type MemberWorkbenchSnapshot,
  type MemberWorkbenchCommand,
  type MemberWorkbenchCommandInput,
  type MemberWorkbenchPlanValue,
  type MemberWorkbenchApi,
} from '../../dist/index.js';
import { apply as applyExecution } from '../../../dsh-adapter/dist/execution-plugin.js';
import type {
  CreateExecutionApi,
  DeliveryPanelProps,
  DeploymentMode,
  ExecutionApi,
  ExecutionWorkspaceProps,
  IdentityImport,
  InboxPanelProps,
  InboxPlace,
  ProjectSpaceDirectory,
  ReviewWorkspaceProps,
  S1Startup,
  ExecutionStartableValue,
  StartablePlan,
  StartPlanRequest,
  StartPlanValue,
  ChannelInboxValue,
  ChannelStartableValue,
  RevisionRequest,
  RevisionValue,
  SavedDeliveryDraft,
  DeliveryDraftWrite,
  UpstreamContentRequest,
  UpstreamContentValue,
} from '../../../dsh-adapter/dist/s1-integration.js';

type Assignable<A, B> = [A] extends [B] ? true : false;
type Both<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type Assert<T extends true> = T;
type PropsOf<T> = T extends (props: infer P) => unknown ? P : never;

export type MemberSnapshotBoth = Assert<Both<MemberWorkbenchSnapshot, HostMemberSnapshot>>;
export type MemberCommandBoth = Assert<Both<MemberWorkbenchCommand, HostMemberCommand['command']>>;
export type MemberCommandInputBoth = Assert<
  Both<MemberWorkbenchCommandInput & { spaceId: string }, HostMemberCommand>
>;
export type MemberPlanBoth = Assert<
  Both<Parameters<MemberWorkbenchApi['plan']>[0] & { spaceId: string }, HostMemberPlan>
>;
export type MemberPlanValueBoth = Assert<Both<MemberWorkbenchPlanValue, HostMemberPlanValue>>;

export const createApiMatches = createExecutionApi satisfies CreateExecutionApi;
type WithRevision<P extends { api: ExecutionApi }> = Omit<P, 'api'> & { api: ClientExecutionApi };
export const workspaceMatches = ExecutionWorkspace satisfies (
  props: WithRevision<ExecutionWorkspaceProps>,
) => unknown;
export const inboxMatches = InboxPanel satisfies (props: InboxPanelProps) => unknown;
export const deliveryMatches = DeliveryPanel satisfies (
  props: WithRevision<DeliveryPanelProps>,
) => unknown;
export const reviewMatches = ReviewWorkspace satisfies (
  props: WithRevision<ReviewWorkspaceProps>,
) => unknown;

// The frozen common API remains exact; the new Client read is independently checked against #80's channel DTO.
type ExistingClientApi = Omit<
  ClientExecutionApi,
  'revision' | 'readDeliveryDraft' | 'saveDeliveryDraft' | 'upstreamContent'
>;
export type CreateApiBoth = Assert<
  Both<(...args: Parameters<typeof createExecutionApi>) => ExistingClientApi, CreateExecutionApi>
>;
export type StartableValueBoth = Assert<Both<ClientStartableValue, ExecutionStartableValue>>;
export type StartablePlanBoth = Assert<Both<StartablePlanWire, StartablePlan>>;
export type StartBodyBoth = Assert<Both<StartPlanDraft, StartPlanRequest>>;
export type StartValueBoth = Assert<Both<ClientStartPlanValue, StartPlanValue>>;
export type ApiBoth = Assert<Both<ExistingClientApi, ExecutionApi>>;
export type RevisionBodyBoth = Assert<
  Both<Parameters<ClientExecutionApi['revision']>[0], RevisionRequest>
>;
export type RevisionValueBoth = Assert<
  Both<Awaited<ReturnType<ClientExecutionApi['revision']>>, RevisionValue['view']>
>;
export type UpstreamInputBoth = Assert<
  Both<UpstreamInputWire, NonNullable<ExecutionNodeView['inputs']>[number]>
>;
export type UpstreamPropertyBoth = Assert<
  Both<Pick<ClientExecutionNodeWire, 'inputs'>, Pick<ExecutionNodeView, 'inputs'>>
>;
export type UpstreamContentBodyBoth = Assert<
  Both<
    Omit<UpstreamContentQuery, 'expectedArtifactVersion'> & { readonly spaceId: string },
    UpstreamContentRequest
  >
>;
export type UpstreamContentValueBoth = Assert<Both<UpstreamContentWire, UpstreamContentValue>>;
export type DraftValueBoth = Assert<Both<SavedDeliveryDraftWire, SavedDeliveryDraft>>;
export type DraftWriteBoth = Assert<Both<DeliveryDraftSave, DeliveryDraftWrite>>;
export type DraftReadBoth = Assert<
  Both<Parameters<ClientExecutionApi['readDeliveryDraft']>[0], RevisionRequest>
>;
export type InboxScopeBoth = Assert<
  Both<
    Pick<ClientInboxValue, 'actorId' | 'spaceId'>,
    Pick<ChannelInboxValue, 'actorId' | 'spaceId'>
  >
>;
export type InboxPlaceBoth = Assert<Both<InboxPlaceWire, InboxPlace>>;
export type InboxPlaceKeysBoth = Assert<Both<keyof InboxPlaceWire, keyof InboxPlace>>;
export type InboxPlacesBoth = Assert<
  Both<Pick<ClientInboxValue, 'places'>, Pick<ChannelInboxValue, 'places'>>
>;
export type StartableScopeBoth = Assert<
  Both<
    Pick<ClientStartableValue, 'actorId' | 'spaceId'>,
    Pick<ChannelStartableValue, 'actorId' | 'spaceId'>
  >
>;
export type WorkspacePropsBoth = Assert<
  Both<PropsOf<typeof ExecutionWorkspace>, WithRevision<ExecutionWorkspaceProps>>
>;
export type InboxPropsBoth = Assert<Both<PropsOf<typeof InboxPanel>, InboxPanelProps>>;
export type DeliveryPropsBoth = Assert<
  Both<Omit<PropsOf<typeof DeliveryPanel>, 'mode'>, WithRevision<DeliveryPanelProps>>
>;
export type ReviewPropsBoth = Assert<
  Both<PropsOf<typeof ReviewWorkspace>, WithRevision<ReviewWorkspaceProps>>
>;
export const realApplyFitsStartup = applyExecution satisfies S1Startup['applyExecution'];

export function mountS1(
  ctx: Context,
  imported: IdentityImport | undefined,
  mode: DeploymentMode,
  startup: S1Startup,
  readWorkbench: () => Workbench,
  projectSpaces: ProjectSpaceDirectory,
  rpc: ClientConnectionRpc,
): Promise<ExecutionWorkspaceProps> {
  startup.configureDeploymentMode(ctx, mode);
  return startup.applyIdentity(ctx, imported).then(async () => {
    await startup.applyWorkbench(ctx);
    const executionOptions = { readWorkbench, projectSpaces };
    await startup.applyExecution(ctx, executionOptions);
    const props: ExecutionWorkspaceProps = { api: createExecutionApi(rpc) };
    startup.mount(props);
    return props;
  });
}
