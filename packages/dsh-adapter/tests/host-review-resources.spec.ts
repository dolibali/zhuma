/** Emitted production Host, original SDK Agent/Skill and real member cookies.
 * Model responses and confirmed plan data are explicit isolated fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, beforeEach } from 'vitest';
const errors = [];
beforeEach(() => {
  errors.length = 0;
});
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

const row = (h, id) =>
  [...h.table.entries()].map(([, node]) => node).find((node) => node.nodeId === id);
const attempt = (h) => row(h, 'produce')?.nativeExecution?.review?.attempts.at(-1);
function observeErrors(h) {
  const acceptedReads = [];
  h.ctx.on(
    'tools/result',
    (exec, result) => {
      errors.push(['SDK_TOOL_RESULT', exec.name, result.isError ? result.error : result.value]);
      if (exec.name === 'read_accepted_input')
        acceptedReads.push({
          agentId: exec.agent?.id,
          isError: result.isError,
          value: result.isError ? undefined : structuredClone(result.value),
        });
    },
    { global: true },
  );
  h.ctx.on(
    'agent/error',
    ({ agent, error }) => {
      errors.push([
        'SDK_AGENT_ERROR',
        agent?.id,
        error && { name: error.name, message: error.message, code: error.code, stack: error.stack },
      ]);
    },
    { global: true },
  );
  return acceptedReads;
}
function diagnostics(h) {
  return {
    errors,
    native: [
      ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
    ].map(([, r]) => ({
      role: r.role,
      intent: r.reviewIntent,
      receipts: r.binding?.receipts,
      agent: r.binding && h.ctx.agents.get(r.binding.nativeAgentId)?.status,
    })),
    nodes: [...h.table.entries()].map(([, n]) => ({
      id: n.nodeId,
      status: n.command.status,
      author: n.nativeExecution?.runs.map((r) => ({
        status: r.attempt.status,
        dispatch: r.dispatch,
        acknowledged: r.attempt.acknowledged,
        resources: r.resources,
      })),
      reviews: n.nativeExecution?.review?.attempts.map((r) => ({
        status: r.status,
        dispatch: r.dispatch,
        resources: r.resources,
        failure: r.failure,
        reviewer: r.scope.review.principal.reviewerRef.id,
      })),
    })),
    calls: h.adapter.requests.map((r) => r.tools.map((t) => t.name)),
  };
}
async function wait(h, predicate) {
  if (predicate()) return;
  await new Promise((resolve, reject) => {
    const stop = h.ctx.on(
      'domain/changed',
      () => {
        if (predicate()) {
          clearTimeout(timer);
          stop();
          resolve();
        }
      },
      { global: true },
    );
    // Observation only; the production 5s read timeout and Run budgets are unchanged.
    const timer = setTimeout(() => {
      stop();
      reject(new Error(JSON.stringify(diagnostics(h))));
    }, 150000);
    if (predicate()) {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
}

function tool(name, args, callId = name) {
  return function* () {
    const json = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: json },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
const nodes = (base) => [
  {
    ...base,
    id: 'produce',
    assigneeId: 'qa',
    reviewerIds: ['qa-review'],
    reviewRequired: true,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
  },
  {
    ...base,
    id: 'consume',
    assigneeId: 'qa',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: ['produce'],
    skillIds: [],
    mcpIds: [],
  },
];
const start = (h) =>
  h.rpc('workflow', 'start', {
    ...h.workflowLocation,
    requestId: 'start-independent-review',
    model: { provider: 'contract', model: 'contract-model', maxTokens: 3000 },
    workspace: { kind: 'text-only' },
    concurrent: 1,
  });

test(
  'actual Host independent review: fixed uploaded UTF8 file reaches Agent read receipt, ballot and Agent downstream',
  { timeout: 180000 },
  async (t) => {
    const text = '附件约定：保留旧调用方的 status 字段，保持中文文件内容。';
    const bytes = Buffer.from(text, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const reads = [],
      fileReads = [];
    let h, fixed, resourceRef, inputRef, fileId;
    const adapter = new ScriptedAdapter([
      (request) => {
        assert.deepEqual(request.tools.map((item) => item.name).sort(), [
          'complete_review',
          'read_review_target',
        ]);
        const actual = JSON.stringify(request);
        assert(!actual.includes(text), 'Catalog must not eagerly inject file bytes');
        const refs = [...new Set(actual.match(/review_file_[a-f0-9]{64}/gu))];
        assert.equal(refs.length, 1, 'Select the file reference from the actual Host catalog');
        resourceRef = refs[0];
        assert.equal(attempt(h).scope.review.target.artifactVersionId, fixed.id);
        return tool('read_review_target', { resourceRef, offset: 0, length: bytes.length })();
      },
      (request) => {
        assert.equal(reads.length, 1);
        const read = reads[0];
        assert.equal(read.isError, false);
        const result = read.value;
        assert.equal(result.ok, true);
        assert.equal(result.encoding, 'utf-8');
        assert.equal(result.sha256, sha256);
        assert.deepEqual(Buffer.from(result.text, 'utf8'), bytes);
        assert.deepEqual(result.range, { offset: 0, length: bytes.length, total: bytes.length });
        assert.equal(result.source.resourceRef, resourceRef);
        assert.equal(result.source.context.review.target.artifactVersionId, fixed.id);
        assert.equal(result.source.context.review.target.roundId, row(h, 'produce').rounds[0].id);
        assert.equal(result.source.nativeAgentId, attempt(h).nativeAgentId);
        assert.equal(read.agentId, attempt(h).nativeAgentId);
        const actual = JSON.stringify(request);
        assert(actual.includes(text));
        assert(actual.includes(sha256));
        assert(actual.includes(result.readRef));
        const evidenceRefs = [...new Set(actual.match(/review_read_[a-f0-9]{64}/gu))];
        assert.deepEqual(
          evidenceRefs,
          [result.readRef],
          'Actual SDK receipt reaches the next model request',
        );
        return tool('complete_review', {
          conclusion: 'approve',
          rationale: '已读取固定附件的真实 UTF8 字节并核对约定。',
          anchors: [{ resourceRef, offset: 0, length: bytes.length }],
          evidenceRefs,
        })();
      },
      (request) => {
        const actual = JSON.stringify(request);
        assert(request.tools.some((item) => item.name === 'read_accepted_file'));
        assert(!actual.includes(text), 'Downstream initially receives only a fixed input catalog');
        const refs = [...new Set(actual.match(/input_[a-f0-9]{64}/gu))];
        assert.equal(refs.length, 1);
        inputRef = refs[0];
        return tool('read_accepted_file', { inputRef, part: 'files' }, 'list-fixed-files')();
      },
      (request) => {
        assert.equal(fileReads.length, 1);
        const listed = fileReads[0];
        assert.equal(listed.isError, false);
        assert.equal(listed.value.ok, true);
        assert.equal(listed.value.part, 'files');
        assert.equal(listed.value.source.artifactVersionId, fixed.id);
        assert.equal(listed.value.source.version, fixed.version);
        assert.equal(listed.value.files.length, 1);
        const file = listed.value.files[0];
        assert.equal(file.fileId, fixed.files[0].id);
        assert.equal(file.sha256, sha256);
        assert.equal(file.bytes, bytes.length);
        fileId = file.fileId;
        const actual = JSON.stringify(request);
        assert(actual.includes(fileId));
        assert(actual.includes(sha256));
        assert(!actual.includes(text), 'File list is metadata, never body-read evidence');
        return tool(
          'read_accepted_file',
          { inputRef, part: 'file', fileId, offset: 0, length: bytes.length },
          'read-fixed-file',
        )();
      },
      (request) => {
        assert.equal(fileReads.length, 2);
        const read = fileReads[1];
        const result = read.value;
        assert.equal(read.isError, false);
        assert.equal(result.ok, true);
        assert.equal(result.part, 'file');
        assert.equal(result.encoding, 'utf-8');
        assert.equal(result.source.artifactVersionId, fixed.id);
        assert.equal(result.source.version, fixed.version);
        assert.equal(result.source.file.fileId, fileId);
        assert.equal(result.source.file.sha256, sha256);
        assert.equal(result.source.scope.nodeId, 'consume');
        assert.deepEqual(result.range, { offset: 0, length: bytes.length, total: bytes.length });
        assert.deepEqual(Buffer.from(result.text, 'utf8'), bytes);
        assert.equal(
          read.agentId,
          row(h, 'consume').nativeExecution.runs.at(-1).attempt.executorRunId,
        );
        const actual = JSON.stringify(request);
        for (const content of [text, fixed.id, fileId, sha256]) assert(actual.includes(content));
        return tool('complete_work', {
          text: '已使用评审接受的固定文件完成下游工作。',
          links: [],
          publications: [],
        })();
      },
    ]);
    h = await boot(t, {
      reviewerExpert: true,
      adapter,
      localWorkspace: { configured: false, policyMode: 'read-only' },
      workflowNodes: (base) =>
        nodes(base).map((node) => ({ ...node, assigneeId: node.id === 'produce' ? 'chen' : 'qa' })),
    });
    observeErrors(h);
    const stop = h.ctx.on(
      'tools/result',
      (exec, result) => {
        if (exec.name === 'read_accepted_file')
          fileReads.push({
            agentId: exec.agent?.id,
            isError: result.isError,
            value: result.isError ? undefined : structuredClone(result.value),
          });
        if (exec.name === 'read_review_target')
          reads.push({
            agentId: exec.agent?.id,
            isError: result.isError,
            value: result.isError ? undefined : structuredClone(result.value),
          });
      },
      { global: true },
    );
    t.onTestFinished(stop);
    const target = {
      taskId: h.locator.taskId,
      planId: h.locator.planId,
      revision: h.locator.revision,
      nodeId: 'produce',
    };
    const uploaded = await fetch(h.base + '/api/zhuma-exec/upload-file', {
      method: 'POST',
      headers: {
        cookie: h.cookie,
        origin: h.base,
        'content-type': 'application/octet-stream',
        'x-zhuma-file-name': encodeURIComponent('接口约定.txt'),
        'x-zhuma-file-type': 'text/plain',
        'x-zhuma-file-size': String(bytes.length),
        'x-zhuma-file-sha256': sha256,
        'x-zhuma-space': 'north',
        'x-zhuma-task': target.taskId,
        'x-zhuma-plan': target.planId,
        'x-zhuma-revision': String(target.revision),
        'x-zhuma-node': target.nodeId,
        'x-zhuma-idempotency-key': 'fixed-review-file',
      },
      body: bytes,
    });
    assert.equal(uploaded.status, 200);
    const receipt = await uploaded.json();
    assert.equal(receipt.ok, true);
    assert.equal(receipt.value.reference.checksum, sha256);
    const submitted = checked(
      await h.rpc('exec', 'submit', {
        ...target,
        expectedVersion: row(h, 'produce').command.version,
        idempotencyKey: 'submit-fixed-file',
        files: [receipt.value.reference],
        links: [],
      }),
    );
    fixed = row(h, 'produce').artifactVersions.find(
      (item) => item.id === submitted.node.rounds[0].artifactVersionId,
    );
    assert.ok(fixed);
    assert.equal(fixed.version, 1);
    assert.equal(fixed.text, undefined);
    assert.deepEqual(fixed.files, [receipt.value.reference]);
    assert.equal(row(h, 'consume').command.status, 'blocked');
    checked(await start(h));
    await wait(
      h,
      () =>
        row(h, 'produce')?.command.status === 'completed' &&
        row(h, 'consume')?.command.status === 'completed' &&
        row(h, 'consume')?.nativeExecution?.runs.at(-1)?.resources === 'settled' &&
        attempt(h)?.resources === 'settled' &&
        h.ctx.agents.list().length === 0,
    );
    const accepted = row(h, 'produce');
    assert.equal(accepted.acceptedArtifactVersionId, fixed.id);
    assert.equal(accepted.rounds[0].ballots.length, 1);
    assert.equal(accepted.rounds[0].ballots[0].reviewerId, 'qa-review');
    assert.equal(attempt(h).status, 'completed');
    const downstream = row(h, 'consume');
    assert(
      downstream.handoff.inputRefs.some(
        (input) => input.sourceNodeId === 'produce' && input.artifactVersionId === fixed.id,
      ),
    );
    assert.equal(adapter.script.length, 0);
    assert.equal(adapter.requests.length, 5);
    assert.equal(h.ctx.agents.list().length, 0);
    await h.host.dispose();
    assert.equal(h.counts.nativeClosed, 1);
    assert.equal(h.counts.executionClosed, 1);
  },
);

test(
  'actual Host independent review: real selected Skill and fixed read precede atomic expert ballot and downstream',
  { timeout: 180000 },
  async (t) => {
    let h;
    let acceptedReads;
    const body = 'Fixed API contract: retain the status field.';
    const adapter = new ScriptedAdapter([
      tool('complete_work', { text: body, links: [] }),
      (request) => {
        assert.deepEqual(request.tools.map((item) => item.name).sort(), [
          'complete_review',
          'read_review_target',
          'skill',
        ]);
        assert(!JSON.stringify(request).includes('PARENT_PRIVATE_BODY'));
        const selected = attempt(h).composition.payload.resources.skills[0];
        assert.equal(selected.policySource.kind, 'asset-package');
        return tool('skill', { name: selected.name })();
      },
      (request) => {
        assert(JSON.stringify(request).includes('SELECTED_ORIGINAL_SKILL_BODY'));
        return tool('read_review_target', {
          resourceRef: 'review_text',
          offset: 0,
          length: Buffer.byteLength(body),
        })();
      },
      (request) => {
        const evidenceRefs = [
          ...new Set(JSON.stringify(request).match(/review_read_[a-f0-9]{64}/gu)),
        ];
        assert.equal(evidenceRefs.length, 1);
        assert(JSON.stringify(request).includes(body));
        return tool('complete_review', {
          conclusion: 'approve',
          rationale: 'Read the exact fixed API body using the independently loaded method.',
          anchors: [{ resourceRef: 'review_text', offset: 0, length: 8 }],
          evidenceRefs,
        })();
      },
      (request) => {
        // complete_review concludes its own turn. This slot belongs to the
        // downstream Agent, whose first request contains only an input catalog.
        const refs = [...new Set(JSON.stringify(request).match(/input_[a-f0-9]{64}/gu))];
        assert.equal(refs.length, 1);
        assert(request.tools.some((item) => item.name === 'read_accepted_input'));
        assert(!JSON.stringify(request).includes(body));
        return tool('read_accepted_input', {
          inputRef: refs[0],
          part: 'text',
          offset: 0,
          limit: 4096,
        })();
      },
      (request) => {
        const produce = row(h, 'produce'),
          consume = row(h, 'consume');
        const fixed = produce.artifactVersions.find(
          (item) => item.id === produce.acceptedArtifactVersionId,
        );
        assert.ok(fixed);
        assert.equal(acceptedReads.length, 1);
        const read = acceptedReads[0];
        assert.equal(read.agentId, consume.nativeExecution.runs.at(-1).attempt.executorRunId);
        assert.equal(read.isError, false);
        assert.equal(read.value.ok, true);
        assert.equal(read.value.part, 'text');
        assert.equal(read.value.text, body);
        assert.equal(read.value.source.sourceNodeId, 'produce');
        assert.equal(read.value.source.downstreamNodeId, 'consume');
        assert.equal(read.value.source.artifactVersionId, fixed.id);
        assert.equal(read.value.source.version, fixed.version);
        assert.equal(read.value.range.hasMore, false);
        assert.equal(read.value.range.returned, body.length);
        const conversation = JSON.stringify(request);
        assert(conversation.includes(body));
        assert(conversation.includes(fixed.id));
        return tool('complete_work', {
          text: 'Downstream used the reviewed contract.',
          links: [],
        })();
      },
    ]);
    h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      reviewerSkill: true,
      parentSkill: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    acceptedReads = observeErrors(h);
    checked(await start(h));
    await wait(
      h,
      () =>
        row(h, 'consume')?.command.status === 'completed' &&
        row(h, 'consume')?.nativeExecution?.runs.at(-1)?.resources === 'settled' &&
        attempt(h)?.resources === 'settled' &&
        h.ctx.agents.list().length === 0,
    );
    assert.equal(row(h, 'produce').rounds[0].ballots.length, 1);
    assert.equal(row(h, 'produce').rounds[0].ballots[0].reviewerId, 'qa-review');
    assert.equal(attempt(h).status, 'completed');
    assert.notEqual(
      attempt(h).nativeSessionId,
      row(h, 'produce').nativeExecution.runs[0].attempt.sessionId,
    );
    assert.equal(h.counts.nativeOpened, 1);
    assert.equal(h.counts.executionOpened, 1);
    assert.deepEqual(
      attempt(h).composition.payload.resources.skills.map((item) => item.ref.id),
      ['api-skill'],
    );
    assert.equal(h.ctx.agents.get(attempt(h).nativeAgentId), undefined);
    assert.equal(adapter.script.length, 0);
    await h.host.dispose();
    assert.equal(h.counts.nativeClosed, 1);
    assert.equal(h.counts.executionClosed, 1);
  },
);

test(
  'actual Host independent review: missing fixed read is rejected without a ballot or downstream and retains its review obligation',
  { timeout: 180000 },
  async (t) => {
    const adapter = new ScriptedAdapter([
      tool('complete_work', { text: 'Fixed output needing independent review.', links: [] }),
      tool('complete_review', {
        conclusion: 'approve',
        rationale: 'Invalid synthetic no-read proposal.',
        anchors: [],
        evidenceRefs: ['review_read_' + 'a'.repeat(64)],
      }),
      'Cannot complete without the actual required read.',
    ]);
    const h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    observeErrors(h);
    checked(await start(h));
    await wait(h, () => adapter.requests.length >= 3 && attempt(h)?.nativeAgentId);
    await h.ctx.agents.get(attempt(h).nativeAgentId)?.whenIdle();
    const view = checked(await h.rpc('workflow', 'read', h.workflowLocation));
    checked(
      await h.rpc('workflow', 'stop', {
        ...h.workflowLocation,
        requestId: 'stop-unread-review',
        intentId: view.intent.intentId,
        generation: view.intent.generation,
      }),
    );
    await wait(h, () => attempt(h)?.resources === 'settled');
    assert.equal(row(h, 'produce').rounds[0].ballots.length, 0);
    assert.equal(row(h, 'consume').command.status, 'blocked');
    assert.equal(h.ctx.agents.get(attempt(h).nativeAgentId), undefined);
    assert.equal(adapter.requests.length, 3);
  },
);

test(
  'actual Host independent review: close retains the original owners until an actual held review stream ends',
  { timeout: 180000 },
  async (t) => {
    const entered = Promise.withResolvers(),
      cancelled = Promise.withResolvers(),
      release = Promise.withResolvers();
    const adapter = new ScriptedAdapter([
      tool('complete_work', {
        text: 'Fixed original body for a held independent review.',
        links: [],
      }),
      async function* (options) {
        entered.resolve();
        if (!options.signal.aborted)
          await new Promise((resolve) =>
            options.signal.addEventListener('abort', resolve, { once: true }),
          );
        cancelled.resolve();
        await release.promise;
        options.signal.throwIfAborted();
      },
    ]);
    const h = await boot(t, {
      expert: true,
      reviewerExpert: true,
      startPlan: false,
      adapter,
      workflowNodes: nodes,
    });
    observeErrors(h);
    checked(await start(h));
    await wait(h, () => adapter.requests.length >= 2);
    await entered.promise;
    t.onTestFailed(() => release.resolve());
    await wait(h, () => attempt(h)?.status === 'running');
    let closed = false;
    const closing = h.host.dispose().then(() => {
      closed = true;
    });
    try {
      await cancelled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, false);
      assert.equal(h.counts.nativeClosed, 0);
      assert.equal(h.counts.executionClosed, 0);
      assert.equal(attempt(h).resources, 'held');
      assert.equal(row(h, 'produce').rounds[0].ballots.length, 0);
    } finally {
      release.resolve();
    }
    await closing;
    assert.equal(h.counts.nativeClosed, 1);
    assert.equal(h.counts.executionClosed, 1);
    assert.equal(h.ctx.agents.list().length, 0);
  },
);
