import {
  canonicalPayload,
  localReviewOptionsQuerySchema,
  localReviewOptionsSchema,
  remoteModelSelectionSchema,
  remoteReviewTargetSchema,
  remoteReviewRunViewSchema,
  remoteReviewReceiptSchema,
  remoteReviewFailureSchema,
  reviewOutcomeQuerySchema,
  reviewOutcomeSchema,
  type ReviewOutcomeView,
  type LocalReviewOptions,
  type LocalReviewOptionsQuery,
  type RemoteReviewView,
} from '@zhuma/agent-core';
import { createIdentityApi } from '../identity/api.js';
import { ExecutionError } from '../execution/ExecutionApi.js';
import { createExecutionHttpApi, type MemberExecutionScope } from '../execution/http.js';
import type { ExecutionApi } from '../execution/ExecutionApi.js';
import type { NativeRunModel, NativeRunPanelView } from './native-run-contract.js';
import { projectNativeRunMessages } from './api.js';
import type { NativeRunMessage } from './native-run-contract.js';

type Models = Extract<NativeRunPanelView, { kind: 'ready' }>['models'];
export interface NativeReviewState {
  readonly runId: string;
  readonly reviewerId: string;
  readonly status: RemoteReviewView['runStatus'];
  readonly resources: RemoteReviewView['resources'];
  readonly phase: string;
  readonly attemptVersion: number;
  readonly stopRequested: boolean;
  readonly receipt?: Pick<NonNullable<RemoteReviewView['receipt']>, 'action' | 'commentId'>;
  readonly failure?: Pick<NonNullable<RemoteReviewView['failure']>, 'code'>;
}
export interface NativeReviewApi {
  readonly files?: NonNullable<ExecutionApi['files']>;
  outcome(query: LocalReviewOptionsQuery, signal: AbortSignal): Promise<ReviewOutcomeView>;
  stopSession(
    query: LocalReviewOptionsQuery,
    sessionId: string,
    run: NativeReviewState,
    requestId: string,
    signal: AbortSignal,
  ): Promise<NativeReviewHistoryPage>;
  session(
    query: LocalReviewOptionsQuery,
    sessionId: string,
    signal: AbortSignal,
    after?: number,
  ): Promise<NativeReviewHistoryPage>;
  recover(
    query: LocalReviewOptionsQuery,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<NativeReviewHistoryPage>;
  options(
    query: LocalReviewOptionsQuery,
    signal: AbortSignal,
  ): Promise<{ facts: LocalReviewOptions; models: Models; currentRunId: string | null }>;
  start(
    query: LocalReviewOptionsQuery,
    input: {
      requestId: string;
      reviewerId: string;
      expectedReviewVersion: number;
      model: NativeRunModel;
    },
    signal: AbortSignal,
  ): Promise<string>;
  read(
    query: LocalReviewOptionsQuery,
    runId: string,
    signal: AbortSignal,
  ): Promise<NativeReviewState>;
  stop(
    query: LocalReviewOptionsQuery,
    run: NativeReviewState,
    requestId: string,
    signal: AbortSignal,
  ): Promise<NativeReviewState>;
}
export interface NativeReviewHistoryPage {
  readonly run: NativeReviewState;
  readonly messages: readonly NativeRunMessage[];
  readonly nextAfter: number;
}
const invalid = (): never => {
  throw new ExecutionError('validation', '评审数据与当前提交不一致，请刷新。');
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const text = (value: unknown, max = 1000): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid());

export function createNativeReviewApi(
  fetcher: typeof fetch,
  accountId: string,
  scope: MemberExecutionScope,
  onUnauthenticated: () => void,
): NativeReviewApi {
  const identity = createIdentityApi(fetcher);
  const current = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (scope.isCurrent?.() === false) throw new DOMException('Review view changed', 'AbortError');
  };
  async function authorize(signal: AbortSignal) {
    current(signal);
    const session = await identity.session(signal);
    current(signal);
    if (session.accountId !== accountId)
      throw new ExecutionError('unauthenticated', '请重新登录。');
    if (!session.spaces.some((space) => space.id === scope.spaceId))
      throw new ExecutionError('space-unavailable', '空间已不可访问。');
  }
  function query(raw: LocalReviewOptionsQuery) {
    const value = localReviewOptionsQuerySchema.parse(raw);
    if (value.spaceId !== scope.spaceId) invalid();
    return value;
  }
  async function call(endpoint: string, payload: unknown, signal: AbortSignal) {
    try {
      await authorize(signal);
      const rpcId = crypto.randomUUID();
      const method =
        endpoint === 'review-outcome' ? 'zhuma-exec/review-outcome' : `zhuma-review/${endpoint}`;
      const response = await fetcher(`/api/${method}`, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload,
        }),
      });
      if (response.status === 401) throw new ExecutionError('unauthenticated', '请重新登录。');
      if (!response.ok) throw new ExecutionError('unavailable', '评审服务暂不可用，请重试。');
      const wire = object(await response.json());
      if (wire.type !== 'server-response' || wire.rpcId !== rpcId) invalid();
      const result = object(wire.result);
      if (result.ok !== true)
        throw new ExecutionError(
          text(object(result.error).code),
          '评审操作尚未确认，请刷新或重试。',
        );
      await authorize(signal);
      return result.value;
    } catch (error) {
      current(signal);
      if (error instanceof ExecutionError && error.code === 'unauthenticated') onUnauthenticated();
      else if (error instanceof ExecutionError && error.code === 'space-unavailable')
        scope.onUnavailable();
      throw error;
    }
  }
  function state(
    raw: unknown,
    expected: LocalReviewOptionsQuery,
    runId: string,
  ): NativeReviewState {
    const value = object(raw),
      target = remoteReviewTargetSchema.parse(value.target);
    const { artifactFingerprint: _fingerprint, ...fixed } = target;
    if (value.runId !== runId || canonicalPayload(fixed) !== canonicalPayload(expected)) invalid();
    const receipt = value.receipt === undefined ? undefined : object(value.receipt);
    const failure = value.failure === undefined ? undefined : object(value.failure);
    return {
      runId,
      reviewerId: text(value.reviewerId),
      status: remoteReviewRunViewSchema.shape.runStatus.parse(value.status),
      resources: remoteReviewRunViewSchema.shape.resources.parse(value.resources),
      attemptVersion: remoteReviewRunViewSchema.shape.attemptVersion.parse(value.attemptVersion),
      stopRequested: boolean(value.stopRequested),
      phase: text(value.phase, 100),
      ...(receipt
        ? {
            receipt: {
              action: remoteReviewReceiptSchema.shape.action.parse(receipt.action),
              commentId: text(receipt.commentId),
            },
          }
        : {}),
      ...(failure
        ? { failure: { code: remoteReviewFailureSchema.shape.code.parse(failure.code) } }
        : {}),
    };
  }
  async function history(
    endpoint: 'session' | 'recover' | 'session-stop',
    raw: LocalReviewOptionsQuery,
    sessionId: string,
    signal: AbortSignal,
    after = -1,
    stop?: { requestId: string; expectedAttemptVersion: number },
  ): Promise<NativeReviewHistoryPage> {
    const expected = query(raw),
      value = object(await call(endpoint, { ...expected, sessionId, after, ...stop }, signal));
    if (value.sessionId !== sessionId || !Array.isArray(value.events) || value.events.length > 100)
      return invalid();
    let previous = after;
    for (const raw of value.events) {
      const event = object(raw);
      if (
        typeof event.seq !== 'number' ||
        !Number.isSafeInteger(event.seq) ||
        event.seq <= previous
      )
        invalid();
      previous = event.seq as number;
    }
    if (value.nextAfter !== previous) invalid();
    return {
      run: state(value.run, expected, text(object(value.run).runId)),
      messages: projectNativeRunMessages(value.events),
      nextAfter: previous,
    };
  }
  const files = createExecutionHttpApi(fetcher, onUnauthenticated, accountId, scope).files;
  return {
    ...(files ? { files } : {}),
    async outcome(raw, signal) {
      const expected = reviewOutcomeQuerySchema.parse(query(raw));
      const value = reviewOutcomeSchema.parse(await call('review-outcome', expected, signal));
      const { artifactFingerprint: _fingerprint, ...target } = value.target;
      if (
        value.controllerMemberId !== accountId ||
        canonicalPayload(target) !== canonicalPayload(expected) ||
        value.artifact.id !== expected.artifactVersionId ||
        value.round.id !== expected.roundId ||
        value.round.artifactVersionId !== expected.artifactVersionId ||
        value.round.ballots.some(
          (ballot) =>
            ballot.roundId !== expected.roundId ||
            ballot.artifactVersionId !== expected.artifactVersionId ||
            !value.round.reviewerIds.includes(ballot.reviewerId),
        )
      )
        invalid();
      return value;
    },
    stopSession: (query, sessionId, run, requestId, signal) =>
      history('session-stop', query, sessionId, signal, -1, {
        requestId,
        expectedAttemptVersion: run.attemptVersion,
      }),
    session: (query, sessionId, signal, after) =>
      history('session', query, sessionId, signal, after),
    recover: (query, sessionId, signal) => history('recover', query, sessionId, signal),
    async options(raw, signal) {
      const expected = query(raw),
        value = object(await call('options', expected, signal));
      const facts = localReviewOptionsSchema.parse(value.facts);
      const { artifactFingerprint: _fingerprint, ...target } = facts.target;
      if (
        facts.controllerMemberId !== accountId ||
        canonicalPayload(target) !== canonicalPayload(expected)
      )
        invalid();
      const models = object(value.models);
      let choices: Models;
      if (models.kind === 'ready') {
        const items = models.items;
        if (!Array.isArray(items) || items.length > 256) return invalid();
        choices = {
          kind: 'ready',
          items: items.map((raw: unknown) => {
            const item = object(raw);
            return {
              id: text(item.id),
              label: text(item.label),
              value: remoteModelSelectionSchema.parse(item.value),
            };
          }),
        };
      } else choices = { kind: 'unavailable', message: text(models.message) };
      return {
        facts,
        models: choices,
        currentRunId: value.currentRunId === null ? null : text(value.currentRunId),
      };
    },
    async start(raw, input, signal) {
      const value = object(await call('start', { ...query(raw), ...input }, signal));
      return text(value.runId, 200);
    },
    async read(raw, runId, signal) {
      const expected = query(raw);
      return state(await call('read', { ...expected, runId }, signal), expected, runId);
    },
    async stop(raw, run, requestId, signal) {
      const expected = query(raw);
      return state(
        await call(
          'stop',
          { ...expected, runId: run.runId, requestId, expectedAttemptVersion: run.attemptVersion },
          signal,
        ),
        expected,
        run.runId,
      );
    },
  };
}
