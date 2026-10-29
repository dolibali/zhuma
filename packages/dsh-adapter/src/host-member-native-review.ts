import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  canonicalPayload,
  localReviewOptionsQuerySchema,
  localReviewOptionsSchema,
  remoteModelSelectionSchema,
  type LocalReviewOptionsQuery,
} from '@zhuma/agent-core';
import type { HostSharedBackend } from './host-shared-backend.js';
import { SharedBackendError } from './host-shared-backend.js';
import { readHostRunModels } from './host-run-models.js';
import { ExecutionRunError } from './execution-run-state.js';
import { MemberLocalExecutionOwner } from './member-local-execution-owner.js';
import type {
  MemberLocalReviewProtocol,
  MemberLocalAcceptedReview,
  MemberLocalPreparedReviewAccept,
  MemberLocalReviewAcceptInput,
} from './member-local-review-protocol.js';
import type { NativeHistoryEvent } from './native-work-session-contract.js';

const id = z.string().min(1).max(200);
const startSchema = localReviewOptionsQuerySchema.extend({
  requestId: z.uuid(),
  expectedReviewVersion: z.number().int().nonnegative(),
  reviewerId: id,
  model: remoteModelSelectionSchema,
});
const readSchema = localReviewOptionsQuerySchema.extend({ runId: id });
const stopSchema = readSchema.extend({
  requestId: z.uuid(),
  expectedAttemptVersion: z.number().int().positive(),
});
const sessionSchema = localReviewOptionsQuerySchema.extend({
  sessionId: id,
  after: z.number().int().min(-1).default(-1),
});
const sessionStopSchema = sessionSchema.extend({
  requestId: z.uuid(),
  expectedAttemptVersion: z.number().int().positive(),
});
const replySchema = z.object({
  type: z.literal('server-response'),
  rpcId: z.uuid(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: localReviewOptionsSchema }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** Private assembly over C's SAME original owner and E's genuine handles.
 * This keeps retry/cleanup obligations, never a second native factory or ballot. */
export function createHostMemberNativeReviews(
  ctx: Context,
  options: {
    backend: HostSharedBackend;
    connectionId: string;
    actorId: string;
    native: MemberLocalExecutionOwner;
    protocol: MemberLocalReviewProtocol;
    lifetime: AbortSignal;
    accepting: Set<Promise<unknown>>;
    current(signal: AbortSignal): Promise<void>;
    admit(signal: AbortSignal): void;
    publicHistory(event: NativeHistoryEvent): NativeHistoryEvent;
  },
) {
  const accepted = new Map<string, MemberLocalAcceptedReview>();
  const prepared = new Map<
    string,
    { fingerprint: string; value: Promise<MemberLocalPreparedReviewAccept> }
  >();
  const starting = new Map<string, Promise<unknown>>();
  const stops = new WeakMap<MemberLocalAcceptedReview, Promise<unknown>>();
  let fenced = false;
  async function prepare(
    input: Pick<
      MemberLocalReviewAcceptInput,
      'target' | 'expectedReviewVersion' | 'reviewerRef' | 'model' | 'workflow'
    >,
    signal: AbortSignal,
  ): Promise<MemberLocalReviewAcceptInput> {
    if (fenced) throw new SharedBackendError('unavailable');
    await options.current(signal);
    const models = await readHostRunModels(ctx, signal);
    if (
      models.kind !== 'ready' ||
      !models.items.some(
        (item) =>
          item.value.provider === input.model.provider && item.value.model === input.model.model,
      )
    )
      throw new ExecutionRunError('run-authority-denied');
    await options.current(signal);
    if (fenced) throw new SharedBackendError('unavailable');
    const resources = MemberLocalExecutionOwner.resourceSource(ctx);
    return {
      ...input,
      workspace: { kind: 'text-only' },
      capabilities: {
        ...(resources ? { resources } : {}),
        reader: 'zhuma-native-review-read@1',
        resultIntent: 'zhuma-native-review-intent@1',
      },
    };
  }
  async function facts(target: LocalReviewOptionsQuery, signal: AbortSignal) {
    await options.current(signal);
    const rpcId = randomUUID();
    const response = await options.backend.request(
      {
        connectionId: options.connectionId,
        operation: 'execution.local-review-options',
        rpcId,
        payload: target,
      },
      signal,
    );
    const reply = replySchema.parse(response.body);
    if (reply.rpcId !== rpcId || !reply.result.ok)
      throw new ExecutionRunError('run-authority-denied');
    const value = reply.result.value;
    const { artifactFingerprint: _fingerprint, ...query } = value.target;
    if (
      value.controllerMemberId !== options.actorId ||
      canonicalPayload(query) !== canonicalPayload(target)
    )
      throw new ExecutionRunError('run-scope-mismatch');
    await options.current(signal);
    return value;
  }
  function stopAccepted(run: MemberLocalAcceptedReview) {
    const previous = stops.get(run);
    if (previous) return previous;
    let version = run.value.attemptVersion;
    try {
      const view = options.native.readReview(run);
      if (view.remote.resources === 'settled') return Promise.resolve();
      version = view.remote.attemptVersion;
    } catch {
      /* A genuine late accept still needs independent cleanup. */
    }
    const pending = options.native.stopReview(run, {
      requestId: randomUUID(),
      expectedAttemptVersion: version,
    });
    stops.set(run, pending);
    void pending.catch(() => undefined);
    return pending;
  }
  async function read(run: MemberLocalAcceptedReview, signal: AbortSignal) {
    await options.current(signal);
    const remote = await options.protocol.status(run, signal);
    await options.current(signal);
    const local = options.native.readReview(run);
    return {
      runId: remote.scope.runId,
      target: remote.scope.review.target,
      reviewerId: remote.scope.review.principal.reviewerRef.id,
      status: remote.runStatus,
      resources: remote.resources,
      attemptVersion: remote.attemptVersion,
      stopRequested: remote.stopRequested,
      phase: local.phase,
      ...(remote.receipt
        ? { receipt: { action: remote.receipt.action, commentId: remote.receipt.commentId } }
        : {}),
      ...(remote.failure ? { failure: { code: remote.failure.code } } : {}),
      ...(local.native
        ? {
            native: {
              sessionId: local.native.binding.nativeSessionId,
              agentId: local.native.binding.nativeAgentId,
              status: local.native.status,
            },
          }
        : {}),
    };
  }
  function find(raw: unknown) {
    const { runId, ...target } = readSchema.parse(raw);
    const run = accepted.get(runId);
    if (!run) throw new ExecutionRunError('run-authority-denied');
    const { artifactFingerprint: _fingerprint, ...original } = run.value.scope.review.target;
    if (canonicalPayload(target) !== canonicalPayload(original))
      throw new ExecutionRunError('run-scope-mismatch');
    return run;
  }
  return {
    // Automatic callers carry only C's original signed candidate; the original
    // prepareAccept revalidates its full target, reviewer and workflow generation.
    prepare,
    accepted(run: MemberLocalAcceptedReview, signal: AbortSignal) {
      accepted.set(run.value.scope.runId, run);
      options.admit(signal);
      if (fenced) throw new SharedBackendError('unavailable');
    },
    async handle(endpoint: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
      if (fenced) throw new SharedBackendError('unavailable');
      await options.current(signal);
      if (
        endpoint === 'review-session' ||
        endpoint === 'review-recover' ||
        endpoint === 'review-session-stop'
      ) {
        const stop = endpoint === 'review-session-stop' ? sessionStopSchema.parse(raw) : undefined;
        const read = stop
          ? (() => {
              const { requestId: _id, expectedAttemptVersion: _version, ...query } = stop;
              return query;
            })()
          : raw;
        const { sessionId, after, ...target } = sessionSchema.parse(read);
        const opened = await options.native.openReviewSession(sessionId, signal);
        const { artifactFingerprint: _fingerprint, ...fixed } =
          opened.view.remote.scope.review.target;
        if (canonicalPayload(fixed) !== canonicalPayload(target))
          throw new ExecutionRunError('run-scope-mismatch');
        if (stop)
          await options.protocol.stop(
            opened.run,
            { requestId: stop.requestId, expectedAttemptVersion: stop.expectedAttemptVersion },
            signal,
          );
        const result =
          endpoint === 'review-recover' || stop
            ? await options.native.recoverReview(opened.run, signal)
            : opened;
        const view = result.view;
        const page = await options.native.historyReview(result.run, after, 100, signal);
        await options.current(signal);
        const remote = view.remote;
        return {
          run: {
            runId: remote.scope.runId,
            target: remote.scope.review.target,
            reviewerId: remote.scope.review.principal.reviewerRef.id,
            status: remote.runStatus,
            resources: remote.resources,
            attemptVersion: remote.attemptVersion,
            stopRequested: remote.stopRequested,
            phase: view.phase,
            ...(remote.receipt
              ? { receipt: { action: remote.receipt.action, commentId: remote.receipt.commentId } }
              : {}),
            ...(remote.failure ? { failure: { code: remote.failure.code } } : {}),
          },
          sessionId,
          events: page.events.map(options.publicHistory),
          nextAfter: page.events.at(-1)?.seq ?? after,
        };
      }
      if (endpoint === 'review-options') {
        const target = localReviewOptionsQuerySchema.parse(raw);
        await facts(target, signal);
        const models = await readHostRunModels(ctx, signal);
        const value = await facts(target, signal);
        const current = [...accepted.values()].reverse().find((run) => {
          const { artifactFingerprint: _fingerprint, ...fixed } = run.value.scope.review.target;
          return canonicalPayload(fixed) === canonicalPayload(target);
        });
        return { facts: value, models, currentRunId: current?.value.scope.runId ?? null };
      }
      if (endpoint === 'review-start') {
        const input = startSchema.parse(raw);
        const { requestId, reviewerId, model, expectedReviewVersion, ...target } = input;
        const fingerprint = canonicalPayload(input);
        const known = prepared.get(requestId);
        if (known && known.fingerprint !== fingerprint)
          throw new ExecutionRunError('run-scope-mismatch');
        if (!known) {
          if (prepared.size >= 64) throw new ExecutionRunError('run-capacity');
          const value = (async () => {
            const current = await facts(target, signal);
            const reviewer = current.reviewers.find((item) => item.reviewerRef.id === reviewerId);
            if (!reviewer?.canStart || current.expectedReviewVersion !== expectedReviewVersion)
              throw new ExecutionRunError('run-authority-denied');
            return options.protocol.prepareAccept(
              requestId,
              await prepare(
                {
                  target: current.target,
                  expectedReviewVersion,
                  reviewerRef: {
                    id: reviewer.reviewerRef.id,
                    version: reviewer.reviewerRef.version,
                  },
                  model,
                },
                signal,
              ),
              signal,
            );
          })();
          prepared.set(requestId, { fingerprint, value });
          void value.catch(() => {
            if (prepared.get(requestId)?.value === value) prepared.delete(requestId);
          });
        }
        const ready = await prepared.get(requestId)!.value;
        options.admit(signal);
        let work = starting.get(requestId);
        if (!work) {
          work = (async () => {
            const run = await ready.send(options.lifetime);
            const existing = accepted.get(run.value.scope.runId);
            if (!existing) accepted.set(run.value.scope.runId, run);
            if (fenced || options.lifetime.aborted) {
              await stopAccepted(run).catch(() => undefined);
              throw new SharedBackendError('unavailable');
            }
            if (!existing) {
              try {
                await options.native.startReview(run);
              } catch (error) {
                await stopAccepted(run).catch(() => undefined);
                throw error;
              }
            }
            return { runId: run.value.scope.runId };
          })();
          starting.set(requestId, work);
          options.accepting.add(work);
          void work
            .finally(() => {
              options.accepting.delete(work!);
              if (starting.get(requestId) === work) starting.delete(requestId);
            })
            .catch(() => undefined);
        }
        return work;
      }
      if (endpoint === 'review-read') return read(find(raw), signal);
      if (endpoint === 'review-stop') {
        const { requestId, expectedAttemptVersion, ...target } = stopSchema.parse(raw);
        const run = find(target);
        await options.native.stopReview(run, { requestId, expectedAttemptVersion }, signal);
        return read(run, signal);
      }
      throw new ExecutionRunError('run-validation');
    },
    fence() {
      fenced = true;
    },
    async stopAccepted() {
      fenced = true;
      await Promise.allSettled([...accepted.values()].map(stopAccepted));
    },
    canSwitchBackend() {
      return (
        options.protocol.canSwitchBackend() &&
        [...accepted.values()].every((run) => {
          try {
            return options.native.readReview(run).remote.resources === 'settled';
          } catch {
            return false;
          }
        })
      );
    },
  };
}
