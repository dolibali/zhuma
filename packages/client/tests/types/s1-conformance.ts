import {
  DeliveryPanel,
  ExecutionWorkspace,
  InboxPanel,
  ReviewWorkspace,
  createExecutionApi,
  type ExecutionApi as ClientExecutionApi,
} from '../../dist/index.js';
import type {
  CreateExecutionApi,
  DeliveryPanelProps,
  ExecutionApi,
  ExecutionWorkspaceProps,
  InboxPanelProps,
  ReviewWorkspaceProps,
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
