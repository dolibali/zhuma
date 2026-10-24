import type { Context } from '@deepseek-ai/cordis';
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client';
import type { Workbench } from '@zhuma/agent-core';
import {
  DeliveryPanel,
  ExecutionWorkspace,
  InboxPanel,
  ReviewWorkspace,
  createExecutionApi,
  type ExecutionApi as ClientExecutionApi,
  type ExecutionInboxValue as ClientInboxValue,
  type ExecutionStartableValue as ClientStartableValue,
  type StartablePlanWire,
  type StartPlanDraft,
  type StartPlanValue as ClientStartPlanValue,
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
} from '../../../dsh-adapter/dist/s1-integration.js';

type Assignable<A, B> = [A] extends [B] ? true : false;
type Both<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type Assert<T extends true> = T;
type PropsOf<T> = T extends (props: infer P) => unknown ? P : never;

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
type ExistingClientApi = Omit<ClientExecutionApi, 'revision'>;
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
export type InboxScopeBoth = Assert<
  Both<
    Pick<ClientInboxValue, 'actorId' | 'spaceId'>,
    Pick<ChannelInboxValue, 'actorId' | 'spaceId'>
  >
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
