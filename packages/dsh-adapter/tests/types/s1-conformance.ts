import type { Context } from '@deepseek-ai/cordis';
import type { Workbench } from '@zhuma/agent-core';
import {
  apply,
  executionEndpoints,
  inject as executionInject,
  type ExecutionPluginConfig,
} from '../../dist/execution-plugin.js';
import type {
  MemberRequest as InjectedMemberRequest,
  MemberResolution as InjectedMemberResolution,
  MemberResolver as InjectedMemberResolver,
} from '../../dist/execution-identity.js';
import type {
  ExecutionCaller as ServiceCaller,
  ExecutionService,
} from '../../dist/execution-service.js';
import type {
  BallotRequest as ServiceBallotRequest,
  ExecutionFailure,
  ExecutionMessageCode as ServiceMessageCode,
  ExecutionNodeView,
  InboxRequest as ServiceInboxRequest,
  ReportRequest as ServiceReportRequest,
  RevisionRequest as ServiceRevisionRequest,
  SettleRequest as ServiceSettleRequest,
  StartPlanRequest as ServiceStartPlanRequest,
  SubmitRequest as ServiceSubmitRequest,
} from '../../dist/execution-service.js';
import type {
  ApplyExecution,
  BallotRequest,
  ChannelInboxValue,
  ExecutionApplyOptions,
  ExecutionCaller,
  ExecutionChannelFailure,
  ExecutionChannelNode,
  ExecutionChannelResult,
  ExecutionCommandValue,
  ExecutionEndpoints,
  ExecutionErrorCode,
  ExecutionInject,
  ExecutionMessageCode,
  ExecutionServiceMethods,
  InboxRequest,
  MemberRequest,
  MemberResolution,
  MemberResolver,
  ProjectSpaceDirectory,
  ReportRequest,
  ReportValue,
  RevisionRequest,
  RevisionValue,
  SettleRequest,
  ReconcileValue,
  S1ExecutionOptions,
  StartPlanRequest,
  StartPlanValue,
  SubmitRequest,
} from '../../dist/s1-integration.js';

type Assignable<A, B> = [A] extends [B] ? true : false;
type Both<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type Assert<T extends true> = T;
type ResultOf<T> = T extends Promise<infer R> ? R : never;
type OkValue<T> =
  ResultOf<T> extends infer R
    ? R extends { readonly ok: true; readonly value: infer V }
      ? V
      : never
    : never;

export const applyMatches = apply satisfies ApplyExecution;
export const endpointsMatch = executionEndpoints satisfies ExecutionEndpoints;
export const injectMatches = executionInject satisfies ExecutionInject;

declare const hostOptions: S1ExecutionOptions;
export const hostOptionsFitPlugin = hostOptions satisfies ExecutionPluginConfig;
export const applyAcceptsHostOptions = apply satisfies (
  ctx: Context,
  options: S1ExecutionOptions,
) => Promise<void>;

export function passExecutionOptions(
  ctx: Context,
  resolver: S1ExecutionOptions['memberResolver'],
  readWorkbench: () => Workbench,
  projectSpaces: ProjectSpaceDirectory,
): Promise<void> {
  const executionOptions = { memberResolver: resolver, readWorkbench, projectSpaces };
  return apply(ctx, executionOptions);
}

export type ApplyBoth = Assert<Both<typeof apply, ApplyExecution>>;
export type OptionsBoth = Assert<Both<ExecutionPluginConfig, ExecutionApplyOptions>>;
export type InjectBoth = Assert<Both<typeof executionInject, ExecutionInject>>;
export type EndpointsBoth = Assert<Both<typeof executionEndpoints, ExecutionEndpoints>>;
export type CallerBoth = Assert<Both<ServiceCaller, ExecutionCaller>>;
export type MessageExtendsError = Assert<
  Both<ExecutionMessageCode, ExecutionErrorCode & ExecutionMessageCode>
>;
type ServiceMethodName =
  | 'startPlan'
  | 'inbox'
  | 'submit'
  | 'ballot'
  | 'settle'
  | 'report'
  | 'revision'
  | 'draft'
  | 'inboxCounts'
  | 'events'
  | 'reconcile';
export type ServiceMethodsPresent = Assert<
  ServiceMethodName extends keyof ExecutionService ? true : false
>;
export type StartMethodBoth = Assert<
  Both<ExecutionService['startPlan'], ExecutionServiceMethods['startPlan']>
>;
export type InboxMethodBoth = Assert<
  Both<ExecutionService['inbox'], ExecutionServiceMethods['inbox']>
>;
export type SubmitMethodBoth = Assert<
  Both<ExecutionService['submit'], ExecutionServiceMethods['submit']>
>;
export type BallotMethodBoth = Assert<
  Both<ExecutionService['ballot'], ExecutionServiceMethods['ballot']>
>;
export type SettleMethodBoth = Assert<
  Both<ExecutionService['settle'], ExecutionServiceMethods['settle']>
>;
export type ReportMethodBoth = Assert<
  Both<ExecutionService['report'], ExecutionServiceMethods['report']>
>;
export type RevisionMethodBoth = Assert<
  Both<ExecutionService['revision'], ExecutionServiceMethods['revision']>
>;
export type DraftMethodBoth = Assert<
  Both<ExecutionService['draft'], ExecutionServiceMethods['draft']>
>;
export type InboxCountsMethodBoth = Assert<
  Both<ExecutionService['inboxCounts'], ExecutionServiceMethods['inboxCounts']>
>;
export type EventsMethodBoth = Assert<
  Both<ExecutionService['events'], ExecutionServiceMethods['events']>
>;
export type ReconcileMethodBoth = Assert<
  Both<ExecutionService['reconcile'], ExecutionServiceMethods['reconcile']>
>;
export type ReconcileValueBoth = Assert<
  Both<
    Awaited<ReturnType<ExecutionService['reconcile']>> extends infer R
      ? R extends { readonly ok: true; readonly value: infer V }
        ? V
        : never
      : never,
    ReconcileValue
  >
>;
export type MemberRequestBoth = Assert<Both<InjectedMemberRequest, MemberRequest>>;
export type MemberResolutionBoth = Assert<Both<InjectedMemberResolution, MemberResolution>>;
export type MemberResolverBoth = Assert<Both<InjectedMemberResolver, MemberResolver>>;
export type FailureBoth = Assert<Both<ExecutionFailure, ExecutionChannelFailure>>;
export type MessageCodeBoth = Assert<Both<ServiceMessageCode, ExecutionMessageCode>>;
export type NodeBoth = Assert<Both<ExecutionChannelNode, ExecutionNodeView>>;
export type StartRequestBoth = Assert<Both<ServiceStartPlanRequest, StartPlanRequest>>;
export type InboxRequestBoth = Assert<Both<ServiceInboxRequest, InboxRequest>>;
export type SubmitRequestBoth = Assert<Both<ServiceSubmitRequest, SubmitRequest>>;
export type BallotRequestBoth = Assert<Both<ServiceBallotRequest, BallotRequest>>;
export type SettleRequestBoth = Assert<Both<ServiceSettleRequest, SettleRequest>>;
export type ReportRequestBoth = Assert<Both<ServiceReportRequest, ReportRequest>>;
export type RevisionRequestBoth = Assert<Both<ServiceRevisionRequest, RevisionRequest>>;

type StartResult = ResultOf<ReturnType<ExecutionService['startPlan']>>;
type InboxResult = ResultOf<ReturnType<ExecutionService['inbox']>>;
type SubmitResult = ResultOf<ReturnType<ExecutionService['submit']>>;
type BallotResult = ResultOf<ReturnType<ExecutionService['ballot']>>;
type SettleResult = ResultOf<ReturnType<ExecutionService['settle']>>;
type ReportResult = ResultOf<ReturnType<ExecutionService['report']>>;
type RevisionResult = ResultOf<ReturnType<ExecutionService['revision']>>;

export type StartResultBoth = Assert<Both<StartResult, ExecutionChannelResult<StartPlanValue>>>;
export type InboxResultBoth = Assert<Both<InboxResult, ExecutionChannelResult<ChannelInboxValue>>>;
export type SubmitResultBoth = Assert<
  Both<SubmitResult, ExecutionChannelResult<ExecutionCommandValue>>
>;
export type BallotResultBoth = Assert<
  Both<BallotResult, ExecutionChannelResult<ExecutionCommandValue>>
>;
export type SettleResultBoth = Assert<
  Both<SettleResult, ExecutionChannelResult<ExecutionCommandValue>>
>;
export type ReportResultBoth = Assert<Both<ReportResult, ExecutionChannelResult<ReportValue>>>;
export type RevisionResultBoth = Assert<
  Both<RevisionResult, ExecutionChannelResult<RevisionValue>>
>;
export type SubmitValueBoth = Assert<
  Both<OkValue<ReturnType<ExecutionService['submit']>>, ExecutionCommandValue>
>;
