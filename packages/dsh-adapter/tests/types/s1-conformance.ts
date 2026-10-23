import {
  apply,
  executionEndpoints,
  type ExecutionPluginConfig,
} from '../../dist/execution-plugin.js';
import type {
  MemberRequest as InjectedMemberRequest,
  MemberResolution as InjectedMemberResolution,
  MemberResolver as InjectedMemberResolver,
} from '../../dist/execution-identity.js';
import type { ExecutionService } from '../../dist/execution-service.js';
import type {
  BallotRequest as ServiceBallotRequest,
  ExecutionFailure,
  ExecutionMessageCode as ServiceMessageCode,
  ExecutionNodeView,
  InboxRequest as ServiceInboxRequest,
  ReportRequest as ServiceReportRequest,
  SettleRequest as ServiceSettleRequest,
  StartPlanRequest as ServiceStartPlanRequest,
  SubmitRequest as ServiceSubmitRequest,
} from '../../dist/execution-service.js';
import type {
  ApplyExecution,
  BallotRequest,
  ChannelInboxValue,
  ExecutionApplyOptions,
  ExecutionChannelFailure,
  ExecutionChannelNode,
  ExecutionChannelResult,
  ExecutionCommandValue,
  ExecutionEndpoints,
  ExecutionMessageCode,
  InboxRequest,
  MemberRequest,
  MemberResolution,
  MemberResolver,
  ReportRequest,
  ReportValue,
  SettleRequest,
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

export type ApplyBoth = Assert<Both<typeof apply, ApplyExecution>>;
export type OptionsBoth = Assert<Both<ExecutionPluginConfig, ExecutionApplyOptions>>;
export type EndpointsBoth = Assert<Both<typeof executionEndpoints, ExecutionEndpoints>>;
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

type StartResult = ResultOf<ReturnType<ExecutionService['startPlan']>>;
type InboxResult = ResultOf<ReturnType<ExecutionService['inbox']>>;
type SubmitResult = ResultOf<ReturnType<ExecutionService['submit']>>;
type BallotResult = ResultOf<ReturnType<ExecutionService['ballot']>>;
type SettleResult = ResultOf<ReturnType<ExecutionService['settle']>>;
type ReportResult = ResultOf<ReturnType<ExecutionService['report']>>;

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
export type SubmitValueBoth = Assert<
  Both<OkValue<ReturnType<ExecutionService['submit']>>, ExecutionCommandValue>
>;
