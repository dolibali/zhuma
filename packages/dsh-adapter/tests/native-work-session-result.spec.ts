/** Actual pinned SDK/Cookie/Run owner. Scripted model output proves mechanism, not reasoning. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootNativeResults, toolResponse, allHistory } from './zhuma-native-result-bundle.ts';

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-native-result-'));
  const h = await bootNativeResults(root, options);
  t.onTestFinished(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = await h.upload('Actual accepted upstream input.');
  await h.submit(input, 'result-input');
  await h.ballot('approve', 'result-input-accept');
  const opened = await h.begin();
  t.onTestFinished(() => opened.dispose());
  return { ...h, opened, root, input };
}

test('old Cookie-issued Run never acquires the completion tool or a fixed result reference', async (t) => {
  const h = await setup(t, { complete: false });
  h.adapter.script.push('Old Run remains a normal conversation.');
  await h.native.service.send(h.opened.grant, h.firstMessage());
  await h.actor().whenIdle();
  await assert.rejects(h.results.prepareFixedResult(h.opened.grant, new AbortController().signal), {
    code: 'result-unavailable',
  });
  assert.throws(
    () =>
      h.results.registerNativeResultTool(
        h.agentContext(),
        h.native.service.open(h.opened.grant).binding,
        h.opened.grant,
      ),
    { code: 'result-unavailable' },
  );
  assert.deepEqual(
    h.adapter.requests[0].tools.map((value) => value.name),
    ['read_accepted_input'],
  );
});

for (const text of ['Explicit result text.', '中'.repeat(100000)])
  test(`actual completion intent becomes an owner-issued durable result (${text.length} characters)`, async (t) => {
    const h = await setup(t);
    const { grant } = h.opened;
    const links = ['https://example.com/result'];
    h.adapter.script.push(toolResponse({ text, links }, 'complete-current-work', 'complete_work'));
    const receipt = await h.native.service.send(grant, h.firstMessage());
    assert.equal(receipt.status, 'received');
    await h.actor().whenIdle();
    const prepared = await h.results.prepareFixedResult(grant, new AbortController().signal);
    assert.equal(prepared.status, 'ready');
    const lease = await h.results.readFixedResult(
      grant,
      prepared.ref,
      new AbortController().signal,
    );
    assert.equal(lease.content.text, text);
    assert.deepEqual(lease.content.links, links);
    assert.deepEqual(lease.source.scope, grant.scope);
    assert.equal(lease.source.nativeAgentId, lease.source.nativeSessionId);
    assert.equal(lease.source.configurationId, h.snapshot.configurationId);
    assert.ok(lease.source.cut.callSeq < lease.source.cut.resultSeq);
    assert.ok(lease.source.cut.resultSeq < lease.source.cut.turnEndSeq);
    assert.ok(lease.source.cut.turnEndSeq <= lease.source.cut.asOfSeq);
    assert.match(lease.digest, /^[a-f0-9]{64}$/u);
    assert.match(lease.provenanceFingerprint, /^[a-f0-9]{64}$/u);
    lease.check();
    assert.equal(
      h.adapter.requests.length,
      1,
      'The explicit tool actually concludes the native turn',
    );
    assert.equal(
      h.ctx.agents.list().length,
      0,
      'A ready result requires the actual writer barrier/drain',
    );
    assert.equal(JSON.stringify(h.native.service.open(grant).binding).includes(text), false);
    assert.throws(() => h.results.assertFixedResult(grant, { ...prepared.ref }), {
      code: 'result-unavailable',
    });
    const retry = await h.native.service.send(grant, h.firstMessage());
    assert.equal(retry.messageId, receipt.messageId);
    assert.equal(retry.status, 'claimed');
    for (const mode of ['followup', 'steer', 'queue'])
      await assert.rejects(
        h.native.service.send(grant, {
          ...h.firstMessage(),
          requestId: `after-${mode}`,
          text: 'Late input',
          mode,
        }),
        { code: 'completion-pending' },
      );
    assert.equal(h.native.service.open(grant).binding.receipts.length, 1);
    lease.release();
    assert.throws(() => lease.check(), { code: 'cancelled' });
  });

test('a normal completed reply never becomes a fixed result without explicit intent', async (t) => {
  const h = await setup(t);
  h.adapter.script.push('The work looks complete.');
  await h.native.service.send(h.opened.grant, h.firstMessage());
  await h.actor().whenIdle();
  assert.deepEqual(
    await h.results.prepareFixedResult(h.opened.grant, new AbortController().signal),
    { status: 'pending', reason: 'not-declared' },
  );
});

test('previously received native queue input prevents completion and is actually processed', async (t) => {
  const h = await setup(t);
  let entered;
  let resume;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (resume = resolve));
  h.adapter.script.push(
    async () => {
      entered();
      await gate;
      return toolResponse(
        { text: 'Premature completion', links: [] },
        'queued-intent',
        'complete_work',
      )();
    },
    'Continue the original work.',
    'Process the previously received work.',
  );
  const { grant } = h.opened;
  await h.native.service.send(grant, h.firstMessage());
  await started;
  const queued = await h.native.service.send(grant, {
    ...h.firstMessage(),
    requestId: 'before-intent',
    text: 'Previously acknowledged work.',
    mode: 'queue',
  });
  assert.equal(queued.status, 'received');
  resume();
  await h.actor().whenIdle();
  const history = await allHistory(h.native.service, grant);
  const result = history.find((event) => event.type === 'tool/result');
  assert.deepEqual(JSON.parse(result.data.message.content[0].text), {
    ok: false,
    code: 'input-pending',
  });
  assert.ok(
    history.some((event) => event.type === 'user/message' && event.data.id === queued.messageId),
  );
  assert.equal(h.native.service.open(grant).binding.resultIntent, undefined);
  assert.deepEqual(await h.results.prepareFixedResult(grant, grant.signal), {
    status: 'pending',
    reason: 'not-declared',
  });
});

test('a later tool in the same native step is denied and invalidates the proposed fixed result', async (t) => {
  const h = await setup(t);
  h.adapter.script.push(function* () {
    const calls = [
      {
        id: 'first-complete',
        name: 'complete_work',
        arguments: JSON.stringify({ text: 'Too early', links: [] }),
      },
      { id: 'later-read', name: 'read_accepted_input', arguments: '{}' },
    ];
    for (const [index, block] of calls.entries()) {
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: block.arguments,
      };
      yield { type: 'block-end', index, block: { type: 'tool-call', ...block } };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  const { grant } = h.opened;
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  await assert.rejects(h.results.prepareFixedResult(grant, grant.signal), {
    code: 'result-rejected',
  });
  const history = await allHistory(h.native.service, grant);
  const later = history.find(
    (event) => event.type === 'tool/result' && event.data.message.toolCallId === 'later-read',
  );
  assert.equal(later.data.message.isError, true);
  assert.equal(
    h.ctx.agents.list().length,
    1,
    'Rejected completion never retires the writer as accepted',
  );
});

test('a post-policy replacement cannot issue a genuine fixed result', async (t) => {
  const h = await setup(t, {
    configure(ctx) {
      ctx.on('tools/post-execute', (_exec, result) => ({
        kind: 'accept',
        value: { ...result.value, digest: '0'.repeat(64) },
      }));
    },
  });
  h.adapter.script.push(
    toolResponse({ text: 'Original output.', links: [] }, 'replaced-ack', 'complete_work'),
  );
  const { grant } = h.opened;
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  await assert.rejects(h.results.prepareFixedResult(grant, grant.signal), {
    code: 'result-rejected',
  });
  const history = await allHistory(h.native.service, grant);
  const result = history.find((event) => event.type === 'tool/result');
  assert.deepEqual(JSON.parse(result.data.message.content[0].text), {
    ok: false,
    code: 'result-rejected',
  });
});

test('native internal work inserted after declaration prevents a fixed result even after it is consumed', async (t) => {
  const h = await setup(t, {
    configure(ctx) {
      ctx.on('tools/post-execute', (exec, result) => {
        if (result.value?.phase === 'declared')
          exec.agent.inbox.append(
            'next-step',
            createUserMessage({
              content: [{ type: 'text', text: 'Internal work still needs to run.' }],
              source: { kind: 'completion-test-internal' },
            }),
          );
        return { kind: 'accept' };
      });
    },
  });
  h.adapter.script.push(
    toolResponse({ text: 'Proposed output.', links: [] }, 'internal-pending', 'complete_work'),
    'The internal work has been processed.',
  );
  const { grant } = h.opened;
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  await assert.rejects(h.results.prepareFixedResult(grant, grant.signal), (error) =>
    ['input-pending', 'result-rejected'].includes(error.code),
  );
  const snapshot = await h.native.service.readResultSnapshot(grant, grant.signal);
  assert.equal(snapshot.hasPending, false);
  assert.ok(
    snapshot.events.some(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some((message) => message.source.kind === 'completion-test-internal'),
    ),
  );
});

test('Stop during actual completion finalization cannot produce an accepted fixed result', async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const h = await setup(t, {
    configure(ctx) {
      ctx.on('tools/post-execute', async () => {
        entered.resolve();
        await gate.promise;
        return { kind: 'accept' };
      });
    },
  });
  const { grant } = h.opened;
  h.adapter.script.push(
    toolResponse({ text: 'Interrupted output.', links: [] }, 'stopped-result', 'complete_work'),
  );
  await h.native.service.send(grant, h.firstMessage());
  await entered.promise;
  try {
    await h.stop();
    gate.resolve();
    await h.actor().whenIdle();
    await assert.rejects(h.results.prepareFixedResult(grant, grant.signal));
    assert.equal(h.row('expert').command.status === 'completed', false);
  } finally {
    gate.resolve();
  }
});

test('original grant, logout and caller cancellation remain required after a result becomes ready', async (t) => {
  const h = await setup(t);
  const { grant } = h.opened;
  h.adapter.script.push(
    toolResponse({ text: 'Stable output.', links: [] }, 'logout-result', 'complete_work'),
  );
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  const prepared = await h.results.prepareFixedResult(grant, grant.signal);
  assert.equal(prepared.status, 'ready');
  assert.throws(() => h.results.assertFixedResult({ ...grant }, prepared.ref));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(h.results.readFixedResult(grant, prepared.ref, cancelled.signal), {
    code: 'cancelled',
  });
  const lease = await h.results.readFixedResult(grant, prepared.ref, grant.signal);
  await h.revoke();
  assert.throws(() => lease.check());
  assert.throws(() => h.results.assertFixedResult(grant, prepared.ref));
});

test('actual fixed-result leases have a shared bounded reader capacity and release returns it', async (t) => {
  const h = await setup(t);
  const { grant } = h.opened;
  h.adapter.script.push(
    toolResponse({ text: 'Bounded result.', links: [] }, 'reader-capacity', 'complete_work'),
  );
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  const ready = await h.results.prepareFixedResult(grant, grant.signal);
  assert.equal(ready.status, 'ready');
  const leases = [];
  try {
    for (let i = 0; i < 8; i++)
      leases.push(await h.results.readFixedResult(grant, ready.ref, grant.signal));
    await assert.rejects(h.results.readFixedResult(grant, ready.ref, grant.signal), {
      code: 'capacity',
    });
    leases.shift().release();
    const replacement = await h.results.readFixedResult(grant, ready.ref, grant.signal);
    replacement.check();
    replacement.release();
  } finally {
    for (const lease of leases) lease.release();
  }
});

test('a cancelled accepted-file source must physically drain before a fixed result is issued', async (t) => {
  const h = await setup(t, { acceptedFiles: true });
  const { grant } = h.opened;
  h.adapter.script.push('Begin reading the selected input.');
  await h.native.service.send(grant, h.firstMessage());
  await h.actor().whenIdle();
  const source = h.ctx.attachments.readFileStream.bind(h.ctx.attachments);
  const entered = Promise.withResolvers();
  const held = Promise.withResolvers();
  h.ctx.attachments.readFileStream = (...args) => {
    const iterator = source(...args)[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const value = await iterator.next();
        entered.resolve();
        await held.promise;
        return value;
      },
      async return() {
        return (await iterator.return?.()) ?? { done: true };
      },
    };
  };
  const cancel = new AbortController();
  const reading = h.agentContext().tools.execute({
    callId: 'held-completion-source',
    name: 'read_accepted_file',
    agent: h.actor(),
    signal: cancel.signal,
    arguments: {
      inputRef: h.snapshot.payload.contextRefs[0],
      part: 'file',
      fileId: h.input.uploadId,
      offset: 0,
      length: 1,
    },
  });
  try {
    await entered.promise;
    cancel.abort();
    assert.deepEqual(JSON.parse((await reading).content[0].text), { ok: false, code: 'cancelled' });
    h.adapter.script.push(
      toolResponse(
        { text: 'Delivery after drain.', links: [] },
        'complete-after-file',
        'complete_work',
      ),
    );
    await h.native.service.send(grant, {
      ...h.firstMessage(),
      requestId: 'after-file',
      text: 'Finish the work.',
    });
    await h.actor().whenIdle();
    const waiting = new AbortController();
    const prepared = h.results.prepareFixedResult(grant, waiting.signal);
    waiting.abort();
    assert.deepEqual(await prepared, { status: 'pending', reason: 'draining' });
    assert.equal(
      h.ctx.agents.list().length,
      1,
      'A logical tool cancellation cannot close a still-reading writer',
    );
    await assert.rejects(h.native.service.reserveInputRead(grant), { code: 'completion-pending' });
    held.resolve();
    await h.native.service.whenInputReadsIdle(grant.scope);
    const ready = await h.results.prepareFixedResult(grant, grant.signal);
    assert.equal(ready.status, 'ready');
    assert.equal(h.ctx.agents.list().length, 0);
    const lease = await h.results.readFixedResult(grant, ready.ref, grant.signal);
    assert.equal(lease.content.text, 'Delivery after drain.');
    lease.check();
    lease.release();
  } finally {
    cancel.abort();
    held.resolve();
    h.ctx.attachments.readFileStream = source;
    await reading.catch(() => undefined);
  }
});

const reopenRoot = process.env.ZHUMA_NATIVE_RESULT_REOPEN_ROOT;
const reopenMode = process.env.ZHUMA_NATIVE_RESULT_REOPEN_MODE;
if (reopenRoot)
  test(`independent-process fixed-result recovery ${reopenMode}`, async () => {
    assert.ok(reopenMode === 'write' || reopenMode === 'read');
    const h = await bootNativeResults(reopenRoot, { first: reopenMode === 'write' });
    let opened;
    try {
      if (reopenMode === 'write') {
        const input = await h.upload('Actual accepted source before process exit.');
        await h.submit(input, 'cold-result-input');
        await h.ballot('approve', 'cold-result-accept');
        opened = await h.begin();
        h.adapter.script.push(
          toolResponse(
            { text: '持久固定结果。', links: ['https://example.com/durable'] },
            'cold-result-call',
            'complete_work',
          ),
        );
        await h.native.service.send(opened.grant, h.firstMessage());
        await h.actor().whenIdle();
        const prepared = await h.results.prepareFixedResult(opened.grant, opened.grant.signal);
        assert.equal(prepared.status, 'ready');
        const lease = await h.results.readFixedResult(
          opened.grant,
          prepared.ref,
          opened.grant.signal,
        );
        lease.check();
        await writeFile(
          join(reopenRoot, 'fixed-result-proof.json'),
          JSON.stringify({
            source: lease.source,
            digest: lease.digest,
            fingerprint: lease.provenanceFingerprint,
            content: lease.content,
            serializedRef: JSON.stringify(prepared.ref),
          }),
        );
        lease.release();
      } else {
        const saved = JSON.parse(
          await readFile(join(reopenRoot, 'fixed-result-proof.json'), 'utf8'),
        );
        opened = await h.openExisting();
        assert.deepEqual(opened.grant.scope, saved.source.scope);
        const prepared = await h.results.prepareFixedResult(opened.grant, opened.grant.signal);
        assert.equal(prepared.status, 'ready');
        assert.throws(
          () => h.results.assertFixedResult(opened.grant, JSON.parse(saved.serializedRef)),
          { code: 'result-unavailable' },
        );
        const lease = await h.results.readFixedResult(
          opened.grant,
          prepared.ref,
          opened.grant.signal,
        );
        assert.deepEqual(lease.source, saved.source);
        assert.deepEqual(lease.content, saved.content);
        assert.equal(lease.digest, saved.digest);
        assert.equal(lease.provenanceFingerprint, saved.fingerprint);
        lease.check();
        lease.release();
        assert.equal(
          h.adapter.requests.length,
          0,
          'Recovery reads actual persisted SDK records without another model call',
        );
        assert.equal(h.ctx.agents.list().length, 0, 'Recovery never creates/resumes another Agent');
      }
    } finally {
      opened?.dispose();
      await h.close();
    }
  });
