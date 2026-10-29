import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  canonicalPayload,
  remoteRunScopeSchema,
  remoteLocalCapabilitiesSchema,
  type RemoteWorkflowRef,
} from '@zhuma/agent-core';
import { HostSharedBackend, SharedBackendError } from './host-shared-backend.js';
import {
  MemberLocalExecutionProtocol,
  type MemberLocalAcceptedRun,
  type MemberLocalAcceptInput,
} from './member-local-execution-protocol.js';
import { MemberLocalExecutionOwner } from './member-local-execution-owner.js';
import { createHostMemberNativeWorkflow } from './host-member-native-workflow.js';
import { MemberLocalReviewProtocol } from './member-local-review-protocol.js';
import { createHostMemberNativeReviews } from './host-member-native-review.js';
import {
  createHostMemberNativeKnowledge,
  memberNativeKnowledgeChoiceSchema,
} from './host-member-native-knowledge.js';
import { MemberLocalExecutionSecrets } from './member-local-execution-secrets.js';
import { createMemberLocalPrivateStore } from './host-member-local-credentials.js';
import { MEMBER_LOCAL_REMOTE_METHODS } from './host-remote-run-http.js';
import { hostRunOptionsQuerySchema } from './host-run-options.js';
import { hostRunBeginRequestSchema } from './host-run-configuration.js';
import { hostRunSendRequestSchema } from './host-run-owner.js';
import { readHostRunModels } from './host-run-models.js';
import { publicFrame, conversationTarget, type HostRunFrameSink } from './host-run-reader.js';
import { ExecutionRunError } from './execution-run-state.js';
import type { NativeHistoryEvent } from './native-work-session-contract.js';
import { NativeConversationProjection } from './native-work-session-view.js';
import {
  createHostMemberNativeWorkspaces,
  memberNativeWorkspaceSchema,
} from './host-member-native-workspaces.js';

const memberBeginRequest = hostRunBeginRequestSchema.extend({
  workspace: memberNativeWorkspaceSchema,
  knowledge: memberNativeKnowledgeChoiceSchema.optional(),
});

const id = z.string().min(1).max(200);
const integer = z.number().int().nonnegative().refine(Number.isSafeInteger);
const locator = hostRunOptionsQuerySchema.omit({ spaceId: true }).extend({ runId: id });
const readLocator = locator.extend({ spaceId: id.optional() });
const historyLocator = locator.extend({
  after: z.number().int().min(-1).refine(Number.isSafeInteger).default(-1),
  limit: integer.min(1).max(100).default(50),
});
const stopRequest = locator.extend({
  spaceId: id,
  generation: integer.positive(),
  segmentId: id,
  requestId: id,
  expectedNodeVersion: integer,
  expectedRunVersion: integer,
});
const sharedRun = locator.extend({
  generation: integer.positive(),
  segmentId: id,
  nodeVersion: integer,
  runVersion: integer,
  status: z.enum(['requested', 'running', 'waiting-for-input', 'completed', 'failed', 'cancelled']),
  dispatch: z.enum(['reserved', 'received', 'unknown']),
  resources: z.enum(['held', 'settled']),
  acknowledged: z.boolean(),
  stopPhase: z.enum(['none', 'requested', 'confirmed', 'receipt-rejected']),
  native: z.null(),
});
const metadata = z.object({
  target: hostRunOptionsQuerySchema,
  nodeVersion: integer,
  runVersion: integer,
  currentRunId: id.nullable(),
  currentRun: sharedRun.nullable(),
  selection: z
    .object({ model: z.unknown(), executor: z.unknown(), workspace: z.unknown().optional() })
    .nullable(),
  experts: z.array(z.unknown()).max(100),
  resources: z.array(z.unknown()).max(300),
  start: z.unknown(),
  tools: z.enum(['text-only', 'accepted-input-reader']),
});
const envelope = z.object({
  type: z.literal('server-response'),
  rpcId: z.uuid(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: metadata }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});
const denied = {
  kind: 'unavailable' as const,
  message: '此设备没有仍有效的执行控制权，请刷新或返回原执行设备。',
};

/** History transport strips runtime context, arguments and unknown event data.
 * Native logs remain in the original SDK; sequence advancement is preserved. */
export function publicMemberNativeHistory(event: NativeHistoryEvent): NativeHistoryEvent {
  const base = { seq: event.seq, time: event.time };
  const record = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const data = record(event.data);
  if (event.type === 'turn/end') {
    const frame = new NativeConversationProjection('public-history').push({ type: 'event', event });
    if (frame?.type === 'turn-end')
      return { ...base, type: 'turn/end', data: { turn: frame.turn, reason: frame.reason } };
  }
  if (event.type === 'tool/call' && typeof data?.name === 'string')
    return { ...base, type: 'tool/call', data: { name: data.name.slice(0, 200) } };
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.type === 'user/message' ? data : record(data?.message);
    const role = event.type === 'user/message' ? 'user' : 'assistant';
    if (
      message?.role === role &&
      record(message.source)?.kind === (role === 'user' ? 'user' : 'model') &&
      Array.isArray(message.content)
    ) {
      const content = message.content.flatMap((value: unknown) => {
        const item = record(value);
        return item?.type === 'text' && typeof item.text === 'string'
          ? [{ type: 'text', text: item.text.slice(0, 262144) }]
          : [];
      });
      const projected = {
        role,
        source: { kind: role === 'user' ? 'user' : 'model' },
        content,
        ...(typeof message.id === 'string' ? { id: message.id } : {}),
      };
      return {
        ...base,
        type: event.type,
        data: role === 'user' ? projected : { message: projected },
      };
    }
  }
  return { ...base, type: 'redacted', data: {} };
}

/** Local owner composition only. D owns every Run, C every handle and native
 * Session. No local ExecutionService, transcript cache or drive reconstruction. */
export async function openHostMemberNativeOwner(ctx: Context, backend: HostSharedBackend) {
  const lifetime = new AbortController();
  const admission = new AbortController();
  let closed = false,
    closing: Promise<void> | undefined;
  function admit(signal: AbortSignal) {
    if (closed) throw new SharedBackendError('unavailable');
    admission.signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    signal.throwIfAborted();
  }
  const connection = await backend.nativeConnection(lifetime.signal);
  const protocolOptions = {
    origin: connection.origin,
    methods: MEMBER_LOCAL_REMOTE_METHODS,
    authentication: async (active: AbortSignal, request?: { readonly method: string }) => {
      lifetime.signal.throwIfAborted();
      active.throwIfAborted();
      // Only C's actual allowlisted outgoing method can select this lane.
      // D authenticates its original independent signed cleanup permit;
      // cleanup neither needs nor receives a product member Cookie.
      if (request?.method === MEMBER_LOCAL_REMOTE_METHODS.cleanup)
        return { origin: connection.origin };
      admit(active);
      const headers = await connection.authentication(active);
      admit(active);
      return headers;
    },
    expectedActorId: connection.actorId,
    secrets: new MemberLocalExecutionSecrets(createMemberLocalPrivateStore(ctx, lifetime.signal)),
  };
  const protocol = await MemberLocalExecutionProtocol.open(protocolOptions, lifetime.signal);
  let reviewProtocol: MemberLocalReviewProtocol | undefined;
  try {
    if (protocol.supportsIndependentReviews) {
      reviewProtocol = await MemberLocalReviewProtocol.open(protocolOptions, lifetime.signal);
      if (
        reviewProtocol.backendId !== protocol.backendId ||
        reviewProtocol.actorId !== protocol.actorId ||
        reviewProtocol.deviceId !== protocol.deviceId
      )
        throw new SharedBackendError('identity-changed');
    }
  } catch (error) {
    await reviewProtocol?.close();
    await protocol.close();
    throw error;
  }
  const assertCurrent = async (signal: AbortSignal) => {
    admit(signal);
    const current = await backend.nativeConnection(signal);
    admit(signal);
    if (
      current.connectionId !== connection.connectionId ||
      current.backendId !== connection.backendId ||
      current.actorId !== connection.actorId
    )
      throw new SharedBackendError('identity-changed');
    await connection.authentication(signal);
    admit(signal);
  };
  const knowledge = createHostMemberNativeKnowledge({
    backend,
    connectionId: connection.connectionId,
    actorId: connection.actorId,
    lifetime: lifetime.signal,
    current: assertCurrent,
    admit,
  });
  const workspaces = createHostMemberNativeWorkspaces(ctx, {
    connectionId: connection.connectionId,
    backendId: protocol.backendId,
    deviceId: protocol.deviceId,
    actorId: protocol.actorId,
    signal: lifetime.signal,
  });
  let native: MemberLocalExecutionOwner;
  try {
    native = await MemberLocalExecutionOwner.open(ctx, {
      protocol,
      ...(reviewProtocol ? { review: { protocol: reviewProtocol } } : {}),
      knowledge: { create: knowledge.create },
      native: workspaces.native,
      ...(protocol.supportsFilePublishing
        ? { outputFiles: { resolveBytes: workspaces.output } }
        : {}),
      async assertModel(selection, signal) {
        await assertCurrent(signal);
        const models = await readHostRunModels(ctx, signal);
        if (
          models.kind !== 'ready' ||
          !models.items.some(
            ({ value }) => value.provider === selection.provider && value.model === selection.model,
          )
        )
          throw new ExecutionRunError('run-authority-unavailable');
        await assertCurrent(signal);
      },
    });
  } catch (error) {
    await workspaces.close();
    await protocol.close();
    await reviewProtocol?.close();
    throw error;
  }
  const jobs = new Set<Promise<unknown>>();
  const accepting = new Set<Promise<unknown>>();
  const acceptedRuns = new Set<MemberLocalAcceptedRun>();
  const reviews = reviewProtocol
    ? createHostMemberNativeReviews(ctx, {
        backend,
        connectionId: connection.connectionId,
        actorId: protocol.actorId,
        native,
        protocol: reviewProtocol,
        lifetime: lifetime.signal,
        accepting,
        current: assertCurrent,
        admit,
        publicHistory: publicMemberNativeHistory,
      })
    : undefined;
  const stops = new WeakMap<MemberLocalAcceptedRun, Promise<unknown>>();
  function pruneAccepted() {
    for (const run of acceptedRuns) {
      try {
        if (native.read(run).remote.resources === 'settled') acceptedRuns.delete(run);
      } catch {
        /* An unknown or not-yet-started handle remains an obligation. */
      }
    }
  }
  function stopAccepted(run: MemberLocalAcceptedRun) {
    const known = stops.get(run);
    if (known) return known;
    let view = run.value;
    try {
      const current = native.read(run).remote;
      if (current.resources === 'settled') return Promise.resolve();
      view = { ...view, ...current };
    } catch {
      /* A late issued handle is retained by the original cleanup-only path. */
    }
    const stop = native.stop(run, {
      requestId: randomUUID(),
      expectedNodeVersion: view.nodeVersion,
      expectedRunVersion: view.runVersion,
    });
    stops.set(run, stop);
    void stop.catch(() => undefined);
    return stop;
  }
  async function facts(target: z.infer<typeof hostRunOptionsQuerySchema>, signal: AbortSignal) {
    await assertCurrent(signal);
    const rpcId = randomUUID();
    const response = await backend.request(
      {
        connectionId: connection.connectionId,
        operation: 'execution.local-run-options',
        rpcId,
        payload: target,
      },
      signal,
    );
    const parsed = envelope.parse(response.body);
    if (parsed.rpcId !== rpcId || !parsed.result.ok)
      throw new ExecutionRunError('run-authority-denied');
    const value = parsed.result.value;
    const { runId: _requestedRunId, ...nodeTarget } = target;
    if (
      canonicalPayload(value.target) !== canonicalPayload(nodeTarget) ||
      value.currentRunId !== (value.currentRun?.runId ?? null)
    )
      throw new ExecutionRunError('run-scope-mismatch');
    await assertCurrent(signal);
    return value;
  }
  async function opened(raw: unknown, signal: AbortSignal) {
    const target = readLocator.strip().parse(raw);
    const value = await facts(
      {
        spaceId: target.spaceId ?? '',
        taskId: target.taskId,
        planId: target.planId,
        revision: target.revision,
        nodeId: target.nodeId,
        runId: target.runId,
      },
      signal,
    );
    const run = value.currentRun;
    if (!run || run.runId !== target.runId) throw new ExecutionRunError('run-scope-mismatch');
    const scope = remoteRunScopeSchema.parse({
      ...value.target,
      backendId: protocol.backendId,
      actorId: protocol.actorId,
      runId: run.runId,
      generation: run.generation,
      segmentId: run.segmentId,
    });
    const result = await native.openScope(scope, signal);
    await assertCurrent(signal);
    return { ...result, facts: value };
  }
  function projected(value: Awaited<ReturnType<typeof opened>>) {
    const run = value.facts.currentRun!;
    const view = value.view;
    const live =
      view.phase === 'working' &&
      view.remote.authority === 'drive' &&
      view.remote.resources === 'held' &&
      !view.remote.stopRequested;
    return {
      ...run,
      native: view.native
        ? {
            sessionId: view.native.binding.nativeSessionId,
            agentId: view.native.binding.nativeAgentId,
            status: view.native.status,
          }
        : null,
      sendCapabilities: {
        followup: live ? { kind: 'available' } : denied,
        steer: live ? { kind: 'available' } : denied,
        queue: live ? { kind: 'available' } : denied,
      },
      ...(view.remote.receipt
        ? {
            submission: {
              artifactVersionId: view.remote.receipt.artifactVersionId,
              ...(view.remote.receipt.roundId ? { roundId: view.remote.receipt.roundId } : {}),
            },
          }
        : {}),
    };
  }
  const track = <T>(work: Promise<T>) => {
    jobs.add(work);
    void work.finally(() => jobs.delete(work)).catch(() => undefined);
    return work;
  };
  /** Same preparation for explicit node work and automatic candidates. A
   * workflow default is a ceiling, never this node's input/tool authority. */
  async function prepareRun(
    input: Omit<z.infer<typeof memberBeginRequest>, 'newRunId' | 'newSegmentId'> & {
      workflow?: RemoteWorkflowRef;
    },
    wait: AbortSignal,
  ): Promise<MemberLocalAcceptInput> {
    const local = input.workspace.kind === 'local';
    if (local !== (input.tools === 'local-tools') || (local && !native.outputFileSource))
      throw new ExecutionRunError('run-authority-unavailable');
    const target = hostRunOptionsQuerySchema.parse({
      spaceId: input.spaceId,
      taskId: input.taskId,
      planId: input.planId,
      revision: input.revision,
      nodeId: input.nodeId,
    });
    const value = await facts(target, wait);
    const knowledgeChoice = await knowledge.prepare(
      input.requestId,
      target.spaceId,
      input.knowledge,
      wait,
    );
    if (knowledgeChoice && !native.knowledgeSource)
      throw new ExecutionRunError('run-authority-unavailable');
    const selected = workspaces.prepare(input.requestId, target, input.workspace);
    const acceptedInput = value.tools === 'accepted-input-reader';
    const resources = MemberLocalExecutionOwner.resourceSource(ctx);
    const needsResources = value.resources.some(
      (resource) => z.object({ kind: z.string() }).parse(resource).kind !== 'input',
    );
    return {
      target,
      purpose: 'work',
      mode: input.mode,
      expectedNodeVersion: input.expectedNodeVersion,
      expectedRunVersion: input.expectedRunVersion,
      model: input.model,
      executor: input.executor,
      workspace: selected?.workspace ?? { kind: 'text-only' },
      ...(input.workflow ? { workflow: input.workflow } : {}),
      capabilities: {
        ...(knowledgeChoice ? { knowledge: native.knowledgeSource! } : {}),
        ...(needsResources && resources ? { resources } : {}),
        ...(acceptedInput ? { acceptedInput: '1' as const } : {}),
        ...(acceptedInput && protocol.supportsFilePublishing && native.acceptedFileSource
          ? { acceptedFile: native.acceptedFileSource }
          : {}),
        ...(selected ? { outputFile: native.outputFileSource! } : {}),
        resultIntent: selected ? 'zhuma-native-result-intent@2' : 'zhuma-native-result-intent@1',
        localTools: selected
          ? remoteLocalCapabilitiesSchema.shape.localTools.parse(workspaces.describe(selected))
          : [],
      },
    };
  }
  const workflows = createHostMemberNativeWorkflow(ctx, {
    backend,
    connectionId: connection.connectionId,
    actorId: connection.actorId,
    protocol,
    ...(reviewProtocol ? { review: reviewProtocol } : {}),
    native,
    workspaces,
    signal: lifetime.signal,
    current: assertCurrent,
    hooks: {
      async prepareWork({ requestId, candidate, workflow, signal }) {
        if (!workflow.intent) throw new ExecutionRunError('run-authority-unavailable');
        const workspace = workspaces.workflowSelection(workflow.intent.defaults.workspace);
        const value = await facts(candidate.target, signal);
        const knowledgeChoice =
          native.knowledgeSource &&
          workflow.intent.defaults.capabilities.knowledge === native.knowledgeSource
            ? await knowledge.workflowChoice(candidate.target.spaceId, signal)
            : undefined;
        return prepareRun(
          {
            ...candidate.target,
            requestId,
            mode: candidate.mode,
            expectedNodeVersion: candidate.expectedNodeVersion,
            expectedRunVersion: candidate.expectedRunVersion,
            model: workflow.intent.defaults.model,
            executor: candidate.executor,
            workspace: memberNativeWorkspaceSchema.parse(workspace),
            tools: workspace.kind === 'local' ? 'local-tools' : value.tools,
            workflow: candidate.workflow,
            ...(knowledgeChoice ? { knowledge: knowledgeChoice } : {}),
          },
          signal,
        );
      },
      workAccepted({ requestId, signal }, accepted) {
        acceptedRuns.add(accepted);
        admit(signal);
        knowledge.bind(requestId, accepted);
        workspaces.bind(requestId, accepted);
      },
      ...(reviews
        ? {
            async prepareReview({ candidate, workflow, signal }) {
              if (!workflow.intent) throw new ExecutionRunError('run-authority-unavailable');
              return reviews.prepare(
                {
                  target: candidate.target,
                  expectedReviewVersion: candidate.expectedReviewVersion,
                  reviewerRef: {
                    id: candidate.reviewerRef.id,
                    version: candidate.reviewerRef.version,
                  },
                  model: workflow.intent.defaults.model,
                  workflow: candidate.workflow,
                },
                signal,
              );
            },
            reviewAccepted({ signal }, accepted) {
              reviews.accepted(accepted, signal);
            },
          }
        : {}),
    },
  });
  async function handle(endpoint: string, raw: unknown, wait: AbortSignal): Promise<unknown> {
    wait = AbortSignal.any([wait, admission.signal]);
    await assertCurrent(wait);
    if (endpoint.startsWith('workflow-')) return workflows.handle(endpoint, raw, wait);
    if (endpoint.startsWith('review-')) {
      if (!reviews) throw new ExecutionRunError('run-authority-unavailable');
      return reviews.handle(endpoint, raw, wait);
    }
    if (endpoint === 'options') {
      const target = hostRunOptionsQuerySchema.parse(raw);
      await facts(target, wait);
      const models = await readHostRunModels(ctx, wait);
      let knowledgeLibraries;
      if (native.knowledgeSource) {
        try {
          knowledgeLibraries = {
            kind: 'ready' as const,
            items: (await knowledge.libraries(target.spaceId, wait)).map((library) => ({
              id: library.id,
              label: library.name,
            })),
          };
        } catch {
          await assertCurrent(wait);
          knowledgeLibraries = {
            kind: 'unavailable' as const,
            message: '知识库暂不可用，可稍后重试。',
          };
        }
      }
      const value = await facts(target, wait);
      return {
        ...value,
        models,
        ...(knowledgeLibraries ? { knowledgeLibraries } : {}),
        workspaces: native.outputFileSource ? workspaces.choices() : [],
        ...(value.selection && value.currentRun
          ? {
              selection: {
                ...value.selection,
                ...(value.selection.workspace
                  ? {
                      workspace: workspaces.selection({
                        ...value.target,
                        actorId: protocol.actorId,
                        runId: value.currentRun.runId,
                        generation: value.currentRun.generation,
                        segmentId: value.currentRun.segmentId,
                      }),
                    }
                  : {}),
                ...(knowledge.selection({
                  ...value.target,
                  actorId: protocol.actorId,
                  runId: value.currentRun.runId,
                  generation: value.currentRun.generation,
                  segmentId: value.currentRun.segmentId,
                })
                  ? {
                      knowledge: knowledge.selection({
                        ...value.target,
                        actorId: protocol.actorId,
                        runId: value.currentRun.runId,
                        generation: value.currentRun.generation,
                        segmentId: value.currentRun.segmentId,
                      }),
                    }
                  : {}),
              },
            }
          : {}),
      };
    }
    if (endpoint === 'begin') {
      const input = memberBeginRequest.parse(raw);
      const target = hostRunOptionsQuerySchema.parse({
        spaceId: input.spaceId,
        taskId: input.taskId,
        planId: input.planId,
        revision: input.revision,
        nodeId: input.nodeId,
      });
      const prepared = await protocol.prepareAccept(
        input.requestId,
        await prepareRun(input, wait),
        wait,
      );
      // Preparing private retry material is not permission to send after close.
      admit(wait);
      pruneAccepted();
      const acceptingRun = (async () => {
        // Once sent, a disconnected renderer or logout does not erase the
        // actual backend obligation. Join its real reply under cleanup life.
        const accepted = await prepared.send(lifetime.signal);
        acceptedRuns.add(accepted);
        try {
          if (closed) {
            await stopAccepted(accepted).catch(() => undefined);
            throw new SharedBackendError('unavailable');
          }
          knowledge.bind(input.requestId, accepted);
          workspaces.bind(input.requestId, accepted);
          await native.start(accepted);
          await assertCurrent(lifetime.signal);
          return {
            ...target,
            runId: accepted.value.scope.runId,
            segmentId: accepted.value.scope.segmentId,
          };
        } catch (error) {
          // Failed local adoption also leaves a genuine accepted Run; hand it
          // to the same original independent cleanup path, never a new start.
          await stopAccepted(accepted).catch(() => undefined);
          throw error;
        }
      })();
      accepting.add(acceptingRun);
      void acceptingRun.finally(() => accepting.delete(acceptingRun)).catch(() => undefined);
      return acceptingRun;
    }
    // The public Client omits space on original read/send/history requests.
    // The private carrier supplies this exact bound space separately.
    if (endpoint === 'read') return projected(await opened(readLocator.parse(raw), wait));
    if (endpoint === 'history') {
      const data = z.object({ spaceId: id, query: historyLocator }).parse(raw);
      const { after, limit, ...target } = data.query;
      const result = await opened({ ...target, spaceId: data.spaceId }, wait);
      const page = await native.history(result.run, after, limit, wait);
      await assertCurrent(wait);
      return {
        ...target,
        sessionId: page.binding.nativeSessionId,
        events: page.events.map(publicMemberNativeHistory),
        nextAfter: page.events.at(-1)?.seq ?? after,
      };
    }
    if (endpoint === 'inbox') {
      const result = await opened(readLocator.parse(raw), wait);
      const page = await native.readInbox(result.run, wait);
      await assertCurrent(wait);
      return {
        target: conversationTarget(result.view.remote.scope),
        sessionId: page.binding.nativeSessionId,
        asOfSeq: page.asOfSeq,
        receipts: page.receipts.map(({ requestId, messageId, mode, status }) => ({
          requestId,
          messageId,
          mode,
          status,
        })),
        items: page.items.map(({ id, text, target, requestId, mode, status }) => ({
          id,
          text,
          target,
          requestId,
          mode,
          status,
        })),
      };
    }
    if (endpoint === 'send') {
      const data = z.object({ spaceId: id, query: hostRunSendRequestSchema }).parse(raw);
      const { generation, segmentId, requestId, text, mode, ...target } = data.query;
      const result = await opened({ ...target, spaceId: data.spaceId }, wait);
      if (
        result.view.remote.scope.generation !== generation ||
        result.view.remote.scope.segmentId !== segmentId
      )
        throw new ExecutionRunError('run-scope-mismatch');
      const receipt = await native.send(result.run, { requestId, text, mode });
      await assertCurrent(wait);
      return {
        ...target,
        requestId: receipt.requestId,
        messageId: receipt.messageId,
        mode: receipt.mode,
        status: receipt.status,
      };
    }
    if (endpoint === 'stop') {
      const data = stopRequest.parse(raw);
      const result = await opened(data, wait);
      if (
        result.view.remote.scope.generation !== data.generation ||
        result.view.remote.scope.segmentId !== data.segmentId
      )
        throw new ExecutionRunError('run-scope-mismatch');
      await native.stop(
        result.run,
        {
          requestId: data.requestId,
          expectedNodeVersion: data.expectedNodeVersion,
          expectedRunVersion: data.expectedRunVersion,
        },
        wait,
      );
      const next = await facts(result.facts.target, wait);
      return {
        ...data,
        status:
          next.currentRun?.resources === 'settled' && next.currentRun.stopPhase === 'confirmed'
            ? 'stopped'
            : 'pending',
      };
    }
    if (endpoint === 'lookup') {
      const { sessionId } = z.strictObject({ sessionId: id }).parse(raw);
      const found = native.lookupNativeSession(sessionId);
      if (found === null) return { kind: 'ordinary' };
      if (found.role === 'review') {
        const opened = await native.openReviewSession(sessionId, wait);
        await assertCurrent(wait);
        const { artifactFingerprint: _fingerprint, ...target } =
          opened.view.remote.scope.review.target;
        return { kind: 'review', target, sessionId, runId: opened.view.remote.scope.runId };
      }
      const result = await native.openSession(sessionId, wait);
      await assertCurrent(wait);
      return { kind: 'task', target: result.view.remote.scope, sessionId };
    }
    throw new ExecutionRunError('run-validation');
  }
  return {
    connectionId: connection.connectionId,
    actorId: connection.actorId,
    canSwitchBackend: () =>
      !closed &&
      !jobs.size &&
      workflows.canSwitchBackend() &&
      (!reviews || reviews.canSwitchBackend()) &&
      (
        native as MemberLocalExecutionOwner & { canSwitchBackend?: () => boolean }
      ).canSwitchBackend?.() === true,
    lookupNativeSession: (id: string) => native.lookupNativeSession(id),
    handle: (endpoint: string, raw: unknown, wait: AbortSignal) =>
      track(handle(endpoint, raw, wait)),
    async observe(raw: unknown, sink: HostRunFrameSink, wait: AbortSignal) {
      wait = AbortSignal.any([wait, admission.signal]);
      await assertCurrent(wait);
      const data = z
        .object({ spaceId: id, query: historyLocator.omit({ limit: true }) })
        .parse(raw);
      const { after, ...target } = data.query;
      const result = await opened({ ...target, spaceId: data.spaceId }, wait);
      const scope = result.view.remote.scope;
      const sessionId = result.view.native?.binding.nativeSessionId;
      if (!sessionId) throw new ExecutionRunError('run-authority-unavailable');
      await sink({ type: 'ready', target: conversationTarget(scope), sessionId }, wait);
      for await (const frame of native.observe(result.run, after, wait)) {
        await assertCurrent(wait);
        await sink({ ...publicFrame(frame), target: conversationTarget(scope), sessionId }, wait);
      }
    },
    close() {
      if (!closing) {
        closed = true;
        admission.abort();
        workflows.fence();
        reviews?.fence();
        knowledge.fence();
        // Native close owns physical cleanup before its original private
        // outgoing protocol or credentials adapter is sealed.
        closing = (async () => {
          workspaces.fence();
          await workflows.whenAdmissionsIdle();
          pruneAccepted();
          // stop fences each existing drive synchronously; its business ACK
          // may fail after logout while original private cleanup still drains.
          const stopping = [...acceptedRuns].map(stopAccepted);
          const reviewStopping = reviews?.stopAccepted();
          while (accepting.size) await Promise.allSettled([...accepting]);
          await Promise.allSettled(stopping);
          await reviewStopping;
          await native.close();
          await workflows.close();
          await workspaces.close();
          // Unknown accepts or unsettled original resources retain this closed
          // owner/protocol for recovery. Never report a successful replacement.
          if (
            !protocol.canSwitchBackend() ||
            (reviews && !reviews.canSwitchBackend()) ||
            [...acceptedRuns].some((run) => {
              try {
                return native.read(run).remote.resources !== 'settled';
              } catch {
                return true;
              }
            })
          )
            throw new SharedBackendError('unavailable');
          lifetime.abort();
          await Promise.allSettled([...jobs]);
          await protocol.close();
          await reviewProtocol?.close();
        })();
      }
      return closing;
    },
  };
}
