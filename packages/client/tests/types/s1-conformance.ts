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
} from '../../../dsh-adapter/dist/s1-integration.js';

type Assignable<A, B> = [A] extends [B] ? true : false;
type Both<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type Assert<T extends true> = T;
type PropsOf<T> = T extends (props: infer P) => unknown ? P : never;

export const createApiMatches = createExecutionApi satisfies CreateExecutionApi;
export const workspaceMatches = ExecutionWorkspace satisfies (
  props: ExecutionWorkspaceProps,
) => unknown;
export const inboxMatches = InboxPanel satisfies (props: InboxPanelProps) => unknown;
export const deliveryMatches = DeliveryPanel satisfies (props: DeliveryPanelProps) => unknown;
export const reviewMatches = ReviewWorkspace satisfies (props: ReviewWorkspaceProps) => unknown;

export type CreateApiBoth = Assert<Both<typeof createExecutionApi, CreateExecutionApi>>;
export type ApiBoth = Assert<Both<ClientExecutionApi, ExecutionApi>>;
export type WorkspacePropsBoth = Assert<
  Both<PropsOf<typeof ExecutionWorkspace>, ExecutionWorkspaceProps>
>;
export type InboxPropsBoth = Assert<Both<PropsOf<typeof InboxPanel>, InboxPanelProps>>;
export type DeliveryPropsBoth = Assert<Both<PropsOf<typeof DeliveryPanel>, DeliveryPanelProps>>;
export type ReviewPropsBoth = Assert<Both<PropsOf<typeof ReviewWorkspace>, ReviewWorkspaceProps>>;
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
  if (startup.deploymentMode(ctx) !== mode) {
    return Promise.reject(new Error('identity startup refused: deployment mode is not configured'));
  }
  return startup.applyIdentity(ctx, imported).then(async () => {
    const resolver = startup.memberResolver(ctx);
    await startup.applyWorkbench(ctx);
    const executionOptions = { memberResolver: resolver, readWorkbench, projectSpaces };
    await startup.applyExecution(ctx, executionOptions);
    await applyExecution(ctx, executionOptions);
    const props: ExecutionWorkspaceProps = { api: createExecutionApi(rpc) };
    startup.mount(props);
    return props;
  });
}
