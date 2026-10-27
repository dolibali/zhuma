/** Port contracts only: these objects do not mint genuine Service/Run authority. */
import assert from 'node:assert/strict';
import { createNativeWorkflowBridge } from '../dist/native-work-session-workflow-bridge.js';
import { workflowExecutionIntentSchema } from '../dist/execution-workflow-contract.js';
import { begin, records } from './execution-run-fixture.mjs';

export const turn = () => new Promise((resolve) => setImmediate(resolve));
export async function turns(count = 4) {
  for (let index = 0; index < count; index++) await turn();
}
export const ok = (value) => ({ ok: true, value });
export const fail = (code) => ({
  ok: false,
  error: { code, message: 'Contract refusal.', details: {} },
});

export function workflowFixture({ consumeClaim } = {}) {
  const host = new AbortController();
  const lifetime = new AbortController();
  const original = { headers: { cookie: 'synthetic-workflow-port-contract' } };
  const node = records()[0];
  const location = {
    spaceId: 'north',
    taskId: node.taskId,
    planId: node.planId,
    revision: node.revision,
  };
  const intent = workflowExecutionIntentSchema.parse({
    schemaVersion: 1,
    intentId: 'intent-contract',
    actorId: 'chen',
    spaceId: 'north',
    generation: 7,
    version: 1,
    status: 'running',
    defaults: {
      model: { provider: 'contract', model: 'contract-model', maxTokens: 1000 },
      tools: 'text-only',
      workspace: { kind: 'text-only' },
    },
    budget: { concurrent: 4, automaticAttemptsPerNode: 1, automaticRevisions: 0 },
    commandReceipts: [
      { requestId: 'start-contract', kind: 'start', fingerprint: 'a'.repeat(64), generation: 7 },
    ],
    starts: [],
  });
  const listeners = new Set();
  const offered = [];
  const calls = {
    claim: [],
    begin: [],
    stop: [],
    read: [],
    control: [],
    deferred: [],
    disposed: [],
    fences: 0,
  };
  let state = 'running';
  let activeRunIds = [];
  const currentNodes = new Map([[node.nodeId, node]]);
  let beginHandler = async () => ok({ dispatch: 'received' });
  let stopHandler = async () => ok({ status: 'pending' });
  let claimHandler;
  let controlHandler;
  let readHandler;
  let unsubscribeFailure = false;
  const view = (patch = {}) => ({
    disposition: 'unchanged',
    location: { ...location },
    intent: structuredClone(intent),
    requiresResume: false,
    activeRunIds: [...activeRunIds],
    state,
    ...patch,
  });
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const claim = (tickets = []) => ({
    view: view(),
    tickets,
    signal: lifetime.signal,
    check() {
      lifetime.signal.throwIfAborted();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        if (unsubscribeFailure) throw Error('contract unsubscribe failed');
        listeners.delete(listener);
      };
    },
    fence() {
      calls.fences++;
      lifetime.abort();
    },
  });
  const ticket = (name, patch = {}) => {
    const controller = new AbortController();
    const reservation = {
      intentId: intent.intentId,
      generation: intent.generation,
      nodeId: name,
      expectedNodeVersion: 0,
      expectedRunVersion: 0,
      requestId: `request-${name}`,
      newRunId: `run-${name}`,
      newSegmentId: `segment-${name}`,
      expertId: 'qa',
      expertVersionId: 'expert-version',
      inputsFingerprint: 'b'.repeat(64),
      ...patch,
    };
    if (!intent.starts.some((item) => item.requestId === reservation.requestId))
      intent.starts.push(structuredClone(reservation));
    return Object.freeze({
      location: Object.freeze({ ...location }),
      reservation: Object.freeze(reservation),
      defaults: structuredClone(intent.defaults),
      signal: AbortSignal.any([controller.signal, lifetime.signal]),
      check() {
        controller.signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
      },
      deferBusy() {
        calls.deferred.push(reservation.requestId);
        controller.abort();
      },
      dispose() {
        calls.disposed.push(reservation.requestId);
        controller.abort();
      },
    });
  };
  const execution = {
    async claimWorkflowExecution(request, body) {
      calls.claim.push({ request, body });
      assert.equal(request, original);
      assert.deepEqual(body, { ...location, intentId: intent.intentId, generation: 7 });
      if (claimHandler) return claimHandler();
      return ok(claim(offered.shift() ?? []));
    },
    async stopWorkflowExecution(request, body) {
      calls.control.push({ request, body });
      if (controlHandler) return controlHandler(request, body);
      intent.status = 'stopping';
      state = 'stopping';
      lifetime.abort();
      return ok(view());
    },
    async readWorkflowExecution(request, body) {
      calls.read.push({ request, body });
      if (readHandler) return readHandler(request, body);
      return ok(view());
    },
    readRunNode(locator) {
      assert.ok(currentNodes.has(locator.nodeId));
      return structuredClone(currentNodes.get(locator.nodeId));
    },
  };
  const runs = {
    async beginWorkflowRun(request, permit, wait) {
      calls.begin.push({ request, ticket: permit, wait });
      return beginHandler(request, permit, wait);
    },
    async stop(request, command, wait) {
      calls.stop.push({ request, command, wait });
      return stopHandler(request, command, wait);
    },
  };
  const bridge = createNativeWorkflowBridge({
    execution,
    runs,
    signal: host.signal,
    ...(consumeClaim ? { consumeClaim } : {}),
  });
  return {
    bridge,
    execution,
    runs,
    host,
    lifetime,
    original,
    location,
    intent,
    calls,
    listeners,
    offered,
    view,
    claim,
    ticket,
    emit,
    setBegin(handler) {
      beginHandler = handler;
    },
    setStop(handler) {
      stopHandler = handler;
    },
    setClaim(handler) {
      claimHandler = handler;
    },
    setControl(handler) {
      controlHandler = handler;
    },
    setRead(handler) {
      readHandler = handler;
    },
    setState(value) {
      state = value;
    },
    failUnsubscribe() {
      unsubscribeFailure = true;
    },
    control() {
      return { ...location, requestId: 'stop-contract', intentId: intent.intentId, generation: 7 };
    },
    activeRun(count = 1) {
      activeRunIds = [];
      for (const candidate of records().slice(0, count)) {
        const current = begin(candidate, {
          newRunId: `run-${candidate.nodeId}`,
          newSegmentId:
            candidate.nodeId === 'produce'
              ? 'actual-segment'
              : `actual-segment-${candidate.nodeId}`,
        }).record;
        currentNodes.set(current.nodeId, current);
        activeRunIds.push(`run-${candidate.nodeId}`);
        if (!intent.starts.some((item) => item.newRunId === `run-${candidate.nodeId}`))
          ticket(current.nodeId);
      }
      return structuredClone(currentNodes.get(node.nodeId));
    },
  };
}
