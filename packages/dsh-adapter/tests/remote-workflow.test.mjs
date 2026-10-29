/** Original Service/DSH JSON and signed Ed25519 admissions. Member/SDK producers
 * are contracts; this does not certify two native Hosts or model execution. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  openHostRemoteRunHttp,
  MEMBER_LOCAL_REMOTE_METHODS,
} from '../dist/host-remote-run-http.js';
import { installMemberResolver, memberCredential, resolveMember } from '../dist/member-session.js';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  remoteResultDigestInput,
  remoteWorkflowViewSchema,
} from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { fileHost, ok, no } from './remote-run-files-fixture.mjs';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { nativeResultDigest } from '../dist/native-work-session-result-source.js';
const hash = (value) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
function workbench() {
  const { state, task, node } = fixture();
  return applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      status: 'ready',
      participantIds: ['chen', 'outside', 'qa'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            { ...node, id: 'produce', skillIds: [], reviewRequired: false, reviewerIds: [] },
            {
              ...node,
              id: 'consume',
              skillIds: [],
              reviewRequired: false,
              reviewerIds: [],
              dependsOn: ['produce'],
            },
          ],
        },
      ],
    },
  });
}
const defaults = () => ({
  model: { provider: 'contract', model: 'contract', maxTokens: 1000 },
  workspace: { kind: 'text-only' },
  capabilities: {
    resultIntent: 'zhuma-native-result-intent@1',
    acceptedInput: '1',
    localTools: [],
  },
});
const target = (h) => {
  const { nodeId, ...location } = h.locate();
  return { spaceId: 'north', ...location };
};
const ref = (value) => ({ intentId: value.intent.intentId, generation: value.intent.generation });
const control = (h, operation, value, extra = {}) =>
  h.envelope(operation, { target: target(h), workflow: ref(value), ...extra });
const start = (h) =>
  h.envelope('workflow-start', {
    target: target(h),
    defaults: defaults(),
    budget: { concurrent: 1, automaticRevisions: 2 },
  });
async function accepted(h, candidate) {
  assert.equal(candidate.kind, 'work');
  return h.send(
    h.accept(
      {
        target: candidate.target,
        expectedNodeVersion: candidate.expectedNodeVersion,
        expectedRunVersion: candidate.expectedRunVersion,
        mode: candidate.mode,
        executor: candidate.executor,
        workflow: candidate.workflow,
        model: defaults().model,
        workspace: { kind: 'text-only' },
        capabilities: defaults().capabilities,
      },
      candidate.target.nodeId,
    ),
  );
}
async function complete(h, view, text, send = h.send) {
  const scope = view.scope,
    id = scope.nodeId,
    nativeSessionId = `native-${id}`,
    nativeAgentId = `agent-${id}`;
  const scoped = (operation, fields = {}, requestId) =>
    h.envelope(operation, { scope, permit: h.drive.public, ...fields }, requestId);
  view = ok(
    await send(scoped('event', { event: { kind: 'received', sequence: 1, nativeSessionId } })),
  );
  view = ok(
    await send(
      scoped('event', {
        event: { kind: 'accepted', sequence: 2, nativeSessionId, executorRunId: nativeAgentId },
      }),
    ),
  );
  const { backendId, ...nativeScope } = scope,
    draft = { text, links: [], files: [] };
  const result = {
    requestId: randomUUID(),
    digest: nativeResultDigest(draft),
    artifactDigest: hash(remoteResultDigestInput(draft)),
    source: {
      scope: nativeScope,
      nativeSessionId,
      nativeAgentId,
      configurationId: currentExecutionRun(h.read(id)).selection.configurationId,
      intentId: `intent-${id}`,
      callId: `call-${id}`,
      toolVersion: 'zhuma-native-result-intent@1',
      cut: { callSeq: 1, resultSeq: 2, turnEndSeq: 3, asOfSeq: 3 },
    },
  };
  view = ok(
    await send(
      scoped('event', {
        event: {
          kind: 'completed',
          sequence: 3,
          idle: true,
          flushed: true,
          resourcesSettled: true,
          result,
        },
      }),
    ),
  );
  return ok(
    await send(
      scoped(
        'submit-result',
        { expectedNodeVersion: view.nodeVersion, result, draft },
        result.requestId,
      ),
    ),
  );
}
const snapshot = (h) =>
  canonicalPayload({
    global: h.domain.global.get(),
    nodes: [...h.domain.table('nodes').entries()],
    plans: [...h.domain.table('plans').entries()],
  });

test('remote workflow: passive discovery/info preserve original v1.1 inventory and zero writes; explicit start is durable and replay-safe', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    before = snapshot(h);
  h.resetCounts();
  assert.equal(ok(await h.send(h.envelope('info', {}))).operations.length, 16);
  assert.equal(
    ok(await h.send(h.envelope('info', { workflow: 'zhuma-remote-workflow@1' }))).operations.length,
    21,
  );
  const absent = ok(await h.send(h.envelope('workflow-status', { target: target(h) })));
  assert.equal(absent.intent, null);
  assert.equal(absent.state, 'inactive');
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
  const command = start(h),
    value = ok(await h.send(command));
  assert.equal(value.intent.actorId, 'chen');
  assert.equal(value.scope.deviceId, h.deviceId);
  assert.equal(h.domain.global.get().remoteWorkflowWriter, 1);
  h.resetCounts();
  const armed = snapshot(h);
  assert.equal(ok(await h.send(command)).disposition, 'replayed');
  no(
    await h.send({
      ...command,
      payload: { ...command.payload, budget: { concurrent: 2, automaticRevisions: 2 } },
    }),
    'remote-idempotency-mismatch',
  );
  assert.equal(snapshot(h), armed);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote workflow: accepted fixed upstream text automatically makes one downstream candidate, then all accepted completes the same intent', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    value = ok(await h.send(start(h)));
  const first = ok(await h.send(control(h, 'workflow-next', value)));
  assert.deepEqual(
    first.candidates.map((item) => item.target.nodeId),
    ['produce'],
  );
  const v1 = ok(await accepted(h, first.candidates[0]));
  assert.equal(ok(await h.send(control(h, 'workflow-next', value))).candidates.length, 0);
  const delivered = await complete(h, v1, 'Fixed upstream.');
  const next = ok(await h.send(control(h, 'workflow-next', value)));
  assert.deepEqual(
    next.candidates.map((item) => item.target.nodeId),
    ['consume'],
  );
  assert.equal(
    h.read('consume').handoff.inputRefs[0].artifactVersionId,
    delivered.receipt.artifactVersionId,
  );
  const v2 = ok(await accepted(h, next.candidates[0]));
  await complete(h, v2, 'Fixed downstream.');
  const done = ok(await h.send(control(h, 'workflow-status', value)));
  assert.equal(done.state, 'completed');
  assert.equal(done.activeWork.length, 2);
  assert.equal(h.read().artifactVersions.length, 1);
  assert.equal(h.read('consume').artifactVersions.length, 1);
});

test('remote workflow: original queue accepts a duplicate candidate at most once and Stop never calls held resources drained', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    value = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', value))).candidates[0];
  const results = await Promise.all([accepted(h, candidate), accepted(h, candidate)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const run = results.find((result) => result.ok).value;
  assert.equal(h.read().nativeExecution.runs.length, 1);
  const stopped = ok(await h.send(control(h, 'workflow-stop', value)));
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.activeWork[0].resources, 'held');
  no(await accepted(h, candidate));
  no(
    await h.send(
      control(h, 'workflow-resume', stopped, { expectedVersion: stopped.intent.version }),
    ),
    'remote-resource-held',
  );
  ok(
    await h.send(
      h.envelope('cleanup', {
        scope: run.scope,
        permit: h.cleanup.public,
        observation: { kind: 'drained', sequence: 1, evidence: { basis: 'absent-unadmitted' } },
      }),
      { secret: h.cleanup.raw, request: { headers: {} } },
    ),
  );
  const paused = ok(await h.send(control(h, 'workflow-status', stopped)));
  assert.equal(paused.state, 'paused');
  assert.equal(paused.activeWork[0].resources, 'settled');
  const resumed = ok(
    await h.send(control(h, 'workflow-resume', paused, { expectedVersion: paused.intent.version })),
  );
  assert.equal(resumed.intent.generation, 2);
  const retry = ok(await h.send(control(h, 'workflow-next', resumed)));
  assert.equal(h.read().command.status, 'ready');
  assert.equal(currentExecutionRun(h.read()).attempt.status, 'cancelled');
  assert.equal(retry.candidates[0].mode, 'begin');
});

test('remote workflow: wrong member/device/scope/generation and capability escalation cannot create a Run or modify facts', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    value = ok(await h.send(start(h))),
    candidate = ok(await h.send(control(h, 'workflow-next', value))).candidates[0];
  h.resetCounts();
  const before = snapshot(h);
  no(await h.send({ ...control(h, 'workflow-next', value), deviceId: randomUUID() }));
  no(
    await h.send(
      control(h, 'workflow-next', value, { workflow: { ...ref(value), generation: 2 } }),
    ),
  );
  no(
    await h.send(
      control(h, 'workflow-next', value, { target: { ...target(h), spaceId: 'other' } }),
    ),
  );
  const wrong = { headers: { cookie: h.request.headers.cookie } };
  h.members.set(wrong, 'outside');
  no(await h.send(control(h, 'workflow-next', value), { request: wrong }));
  no(
    await h.send(
      h.accept({
        workflow: candidate.workflow,
        workspace: { kind: 'text-only' },
        capabilities: { ...defaults().capabilities, knowledge: 'zhuma-native-knowledge@1' },
      }),
    ),
  );
  assert.equal(snapshot(h), before);
  assert.deepEqual(h.counters, { global: 0, nodes: 0, plans: 0 });
});

test('remote workflow: active resource projection rejects another device while preserving original Run generation scope', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    value = ok(await h.send(start(h)));
  const candidate = ok(await h.send(control(h, 'workflow-next', value))).candidates[0];
  ok(await accepted(h, candidate));
  const current = ok(await h.send(control(h, 'workflow-status', value)));
  remoteWorkflowViewSchema.parse(current);
  const other = structuredClone(current);
  other.activeWork[0].deviceId = randomUUID();
  assert.equal(remoteWorkflowViewSchema.safeParse(other).success, false);
});

test('remote workflow: cold discovery/start replay/next never rearm and explicit resume is idempotent across generation', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    originalStart = start(h),
    armed = ok(await h.send(originalStart));
  const currentWorkbench = h.readWorkbench();
  await h.close();
  const cold = await fileHost(t, {
    seed: false,
    root: h.root,
    identity: h.identity,
    workbench: currentWorkbench,
  });
  cold.resetCounts();
  const before = snapshot(cold);
  const discovered = ok(
    await cold.send(cold.envelope('workflow-status', { target: target(cold) })),
  );
  assert.equal(discovered.intent.intentId, armed.intent.intentId);
  assert.equal(discovered.state, 'requires-resume');
  assert.equal(ok(await cold.send(originalStart)).state, 'requires-resume');
  assert.deepEqual(ok(await cold.send(control(cold, 'workflow-next', discovered))).candidates, []);
  assert.equal(snapshot(cold), before);
  assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
  const command = control(cold, 'workflow-resume', discovered, {
    expectedVersion: discovered.intent.version,
  });
  const resumed = ok(await cold.send(command));
  assert.equal(resumed.intent.generation, 2);
  const after = snapshot(cold);
  cold.resetCounts();
  assert.equal(ok(await cold.send(command)).disposition, 'replayed');
  assert.equal(snapshot(cold), after);
  assert.deepEqual(cold.counters, { global: 0, nodes: 0, plans: 0 });
  await cold.close();
});

// Real original Host HTTP handler + signed cookie resolver + original Service/JSON.
// The member lease and native completion producers are still explicit contracts.
test('remote workflow HTTP: exact production routes carry fixed accepted text through two original node Runs', async (t) => {
  const h = await fileHost(t, { workbench: workbench() }),
    routes = new Map(),
    effects = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') effects.push(dispose);
  };
  const ctx = {
    root: {},
    effect,
    connection: { requestRejection: () => 401 },
    inject: (_names, apply) =>
      apply({
        effect,
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      }),
  };
  const secret = randomBytes(32),
    sessionId = randomUUID(),
    expiresAt = Date.now() + 60_000;
  const unpublish = installMemberResolver(ctx, {
    secret,
    requestRejection: () => 401,
    findSession: (id) => (id === sessionId ? { accountId: 'chen', expiresAt } : undefined),
    spaceIdsFor: () => ['north'],
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
  });
  const memberCookie = `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`;
  const originalLease = h.service.runHost.memberLease;
  h.service.runHost.memberLease = async (request) => {
    if (request !== h.request) {
      const member = await resolveMember(ctx, request);
      if (!member.ok) throw Error('HTTP_MEMBER_REQUIRED');
      h.members.set(request, member.memberId);
    }
    return originalLease(request);
  };
  const handle = openHostRemoteRunHttp(ctx, () => h.service);
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://test').pathname);
    if (route) void route.handler(req, res);
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await handle.close();
    unpublish();
    for (const dispose of effects.reverse()) await dispose();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const wire = async (body) => {
    const signed = h.signBody(body),
      method = MEMBER_LOCAL_REMOTE_METHODS[body.operation];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie,
        'x-zhuma-remote-permit': h.drive.raw,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: signed,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const intent = ok(await wire(start(h)));
  for (const id of ['produce', 'consume']) {
    const candidate = ok(await wire(control(h, 'workflow-next', intent))).candidates[0];
    assert.equal(candidate.target.nodeId, id);
    const body = h.accept(
      {
        target: candidate.target,
        expectedNodeVersion: candidate.expectedNodeVersion,
        expectedRunVersion: candidate.expectedRunVersion,
        mode: candidate.mode,
        executor: candidate.executor,
        workflow: candidate.workflow,
        model: defaults().model,
        workspace: { kind: 'text-only' },
        capabilities: defaults().capabilities,
      },
      id,
    );
    const run = ok(await wire(body));
    await complete(h, run, `HTTP fixed ${id}.`, wire);
  }
  assert.equal(ok(await wire(control(h, 'workflow-status', intent))).state, 'completed');
  assert.equal(h.read().artifactVersions[0].text, 'HTTP fixed produce.');
  assert.equal(h.read('consume').artifactVersions[0].text, 'HTTP fixed consume.');
});
