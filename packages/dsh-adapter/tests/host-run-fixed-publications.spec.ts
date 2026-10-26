/** Actual emitted Host assembly, original SDK factory and genuine member/Run/file
 * services. Local scripted model and SDK source aliases only; no GUI proof.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { boot, checked, waitFor } from './zhuma-host-run-native.spec.ts';
import { ScriptedAdapter } from './zhuma-native-work-bundle.ts';

function tool(name, args, id = name) {
  return function* () {
    const text = JSON.stringify(args);
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: text };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}
function published(options) {
  const message = options.messages.find(
    (item) => item.role === 'tool' && item.toolCallId === 'publish_output_file',
  );
  assert.ok(message && !message.isError);
  const ack = JSON.parse(message.content[0].text);
  assert.equal(ack.ok, true);
  assert.equal(ack.phase, 'published');
  return ack;
}
const localWorkspace = {
  access: 'write',
  sandboxed: true,
  policyMode: 'workspace-write',
  publish: [{ kind: 'file', path: 'deliverable.txt' }],
};
for (const outcome of ['ready', 'failed'])
  test(
    `actual Host backend readiness: a registered initializing original provider cannot admit legacy v1, including when it later becomes ${outcome}`,
    { timeout: 20000 },
    async (t) => {
      const initialization = Promise.withResolvers();
      const h = await boot(t, {
        expert: true,
        attachmentInitialization: initialization,
        allowNativeUnavailable: true,
        adapter: new ScriptedAdapter([
          tool('complete_work', { text: 'Ready original v2 owner', links: [], publications: [] }),
        ]),
      });
      try {
        assert.ok(h.ctx.get('attachments', false) instanceof LocalAttachmentStore);
        assert.equal(h.ctx.get('attachments'), undefined);
        const pending = await h.rpc('run', 'begin', h.begin);
        assert.equal(
          pending.result.ok,
          false,
          'Initializing attachments must not select legacy v1',
        );
        assert.equal(pending.status, 503);
        assert.equal(pending.result.error.code, 'run-authority-unavailable');
        assert.equal(h.run(), undefined);
        assert.equal(h.adapter.requests.length, 0);
        assert.equal(h.ctx.agents.list().length, 0);
        assert.equal(h.row().artifactVersions.length, 0);
        assert.equal(h.nativeReadiness[0].status, 'rejected');
        assert.equal(h.nativeReadiness[0].reason.code, 'run-authority-unavailable');
        if (outcome === 'ready') {
          initialization.resolve();
          await h.attachmentFiber;
          assert.ok(h.ctx.get('attachments') instanceof LocalAttachmentStore);
        } else {
          initialization.reject(Error('Original attachment provider initialization failed'));
          await assert.rejects(h.attachmentFiber.await());
          assert.equal(h.ctx.get('attachments'), undefined);
        }
        // Fail-closed startup does not hot-upgrade an old owner or admit a Run.
        const settled = await h.rpc('run', 'begin', h.begin);
        assert.equal(settled.status, 503);
        assert.equal(settled.result.ok, false);
        assert.equal(settled.result.error.code, 'run-authority-unavailable');
        assert.equal(h.run(), undefined);
        assert.equal(h.adapter.requests.length, 0);
        assert.equal(h.row().artifactVersions.length, 0);
        if (outcome === 'ready') {
          // Explicitly remount the original Host; provider readiness alone is
          // not a retry signal for the independently failed native child.
          await h.remountHost();
          const table = h.ctx.storageDomain.get('zhuma_execution').table('nodes');
          const row = () => [...table.entries()][0][1];
          const credential = await h.login();
          checked(await h.rpc('run', 'begin', h.begin, credential));
          await waitFor(h.ctx, () => row().artifactVersions.length === 1);
          const runs = row().nativeExecution.runs;
          assert.equal(runs.length, 1);
          assert.equal(
            runs[0].composition.payload.resultIntentTool.sourceVersion,
            'zhuma-native-result-intent@2',
          );
          assert.equal(runs[0].resultDelivery.protocolVersion, 2);
          assert.equal(row().artifactVersions[0].text, 'Ready original v2 owner');
          assert.equal(h.adapter.requests.length, 1);
        }
      } finally {
        initialization.resolve();
        await h.attachmentFiber.await().catch(() => {});
      }
    },
  );
async function start(h) {
  checked(
    await h.rpc('run', 'begin', {
      ...h.begin,
      tools: 'local-tools',
      workspace: { kind: 'local', id: 'project-files' },
    }),
  );
  await waitFor(h.ctx, () => h.run()?.attempt.acknowledged === true);
}
function waitForFileSubmission(h) {
  if (h.row().artifactVersions.length === 1) return Promise.resolve();
  // File delivery additionally qualifies/seals the native manifest, verifies
  // attachment bytes and commits through the original Service. Observe its
  // business row with a separate bounded budget; no polling or inferred success.
  return new Promise((resolve, reject) => {
    const stop = h.ctx.on(
      'domain/changed',
      () => {
        if (h.row().artifactVersions.length !== 1) return;
        clearTimeout(timer);
        stop();
        resolve();
      },
      { global: true },
    );
    const timer = setTimeout(() => {
      stop();
      reject(Error('File submission did not complete within its bounded budget'));
    }, 15000);
  });
}

test(
  'actual Host fixed publications: file-only completion uses the original publisher and Service, retaining v2 receipt fields on passive reads',
  { timeout: 30000 },
  async (t) => {
    const startedAt = performance.now();
    const timings = {};
    const mark = (phase) => {
      timings[phase] ??= Math.round((performance.now() - startedAt) * 100) / 100;
    };
    const bytes = 'Exact original attached bytes';
    let ack;
    let h;
    const adapter = new ScriptedAdapter([
      tool('write', { file_path: 'deliverable.txt', content: bytes }),
      tool('publish_output_file', { path: 'deliverable.txt' }),
      async function* (options) {
        ack = published(options);
        mark('publicationAcknowledgedMs');
        assert.equal(await readFile(join(h.workspaceRoot, 'deliverable.txt'), 'utf8'), bytes);
        await unlink(join(h.workspaceRoot, 'deliverable.txt'));
        yield* tool('complete_work', {
          links: [],
          publications: [{ publicationId: ack.publicationId }],
        })();
      },
    ]);
    h = await boot(t, { expert: true, review: true, localWorkspace, adapter });
    mark('hostReadyMs');
    await start(h);
    mark('runAcknowledgedMs');
    try {
      await waitForFileSubmission(h);
    } catch (cause) {
      const binding = [
        ...h.ctx.storageDomain.get('zhuma_native_work_sessions').table('bindings').entries(),
      ][0]?.[1];
      const handle = await h.ctx.sessionPersistence.open(binding.nativeSessionId, 'read');
      let events;
      try {
        events = (await handle.read(0, 100)).events;
      } finally {
        await handle.close();
      }
      const eventMetadata = events.map((event) => {
        const data = event.data;
        let ack;
        if (event.type === 'tool/result') {
          try {
            ack = JSON.parse(data.message.content[0].text);
          } catch {}
        }
        return {
          seq: event.seq,
          type: event.type,
          turn: data.turn,
          step: data.step,
          name: data.name,
          isError: data.message?.isError,
          code: ack?.code,
          protocol: ack?.protocolVersion,
        };
      });
      const view = await h.rpc('run', 'read', { ...h.locator, runId: h.begin.newRunId });
      throw new Error(
        `Host fixed file did not submit: ${JSON.stringify({ requests: adapter.requests.length, status: h.run().attempt.status, resources: h.run().resources, stopPhase: h.run().attempt.stopPhase, intentProtocol: binding?.resultIntent?.protocolVersion, hasCut: !!binding?.resultIntent?.cut, delivery: !!h.run().resultDelivery, pending: view.result.value?.resultDelivery, eventMetadata, files: [...h.ctx.storageDomain.get('zhuma_files').table('files').entries()].map(([, value]) => value.state) })}`,
        { cause },
      );
    }
    mark('businessCommittedMs');
    const run = h.run();
    const artifact = h.row().artifactVersions[0];
    assert.equal(
      run.composition.payload.resultIntentTool.sourceVersion,
      'zhuma-native-result-intent@2',
    );
    assert.equal(run.resultDelivery.protocolVersion, 2);
    assert.equal(run.resultDelivery.manifestDigest, run.resultDelivery.source.manifestDigest);
    assert.equal(artifact.text, undefined);
    assert.deepEqual(artifact.files, [
      {
        id: ack.publicationId,
        mediaType: ack.mediaType,
        byteSize: Buffer.byteLength(bytes),
        checksum: createHash('sha256').update(bytes).digest('hex'),
        accessPolicyId: 'space:north',
        uploadComplete: true,
      },
    ]);
    assert.equal(artifact.submittedBy, 'qa');
    assert.equal(h.row().command.status, 'in-review');
    assert.equal(h.row().rounds.length, 1);
    assert.equal(run.resources, 'settled');
    assert.equal(h.ctx.agents.list().length, 0);
    const before = JSON.stringify(h.row());
    for (let i = 0; i < 2; i++) {
      const view = checked(await h.rpc('run', 'read', { ...h.locator, runId: h.begin.newRunId }));
      assert.equal(view.resultDelivery.protocolVersion, 2);
      assert.equal(view.resultDelivery.manifestDigest, run.resultDelivery.manifestDigest);
      assert.equal(view.resultDelivery.artifactVersionId, artifact.id);
      assert.ok(Buffer.byteLength(JSON.stringify(view)) < 8192);
    }
    assert.equal(JSON.stringify(h.row()), before);
    assert.equal(adapter.requests.length, 3);
    mark('passiveReadsCompleteMs');
    if (process.env.ZHUMA_HOST_FIXED_PUBLICATION_TIMINGS)
      await writeFile(process.env.ZHUMA_HOST_FIXED_PUBLICATION_TIMINGS, JSON.stringify(timings));
  },
);

test(
  'actual Host fixed publications: explicit legacy Host without an attachment backend retains its original v1 text owner',
  { timeout: 20000 },
  async (t) => {
    const h = await boot(t, {
      expert: true,
      adapter: new ScriptedAdapter([
        tool('complete_work', { text: 'Original legacy text', links: [] }),
      ]),
    });
    assert.equal(h.ctx.get('attachments'), undefined);
    checked(await h.rpc('run', 'begin', h.begin));
    await waitFor(h.ctx, () => h.row().artifactVersions.length === 1);
    assert.equal(
      h.run().composition.payload.resultIntentTool.sourceVersion,
      'zhuma-native-result-intent@1',
    );
    assert.equal(h.run().resultDelivery.protocolVersion, 1);
    assert.equal(h.row().artifactVersions[0].text, 'Original legacy text');
    const view = checked(await h.rpc('run', 'read', { ...h.locator, runId: h.begin.newRunId }));
    assert.equal('manifestDigest' in view.resultDelivery, false);
    assert.equal('protocolVersion' in view.resultDelivery, false);
  },
);

test(
  'actual Host fixed publications: a present original attachment backend with a failed file ledger cannot fall back to a text owner',
  { timeout: 20000 },
  async (t) => {
    await assert.rejects(
      boot(t, {
        expert: true,
        localWorkspace,
        failFileLedger: true,
        adapter: new ScriptedAdapter([]),
      }),
    );
  },
);

for (const cause of ['logout', 'backend-unload'])
  test(
    `actual Host fixed publications: ${cause} cancels the v2 owner without a legacy fallback or file submission`,
    { timeout: 20000 },
    async (t) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let signal;
      const adapter = new ScriptedAdapter([
        tool('write', { file_path: 'deliverable.txt', content: 'Not yet submitted' }),
        tool('publish_output_file', { path: 'deliverable.txt' }),
        async function* (options) {
          const ack = published(options);
          signal = options.signal;
          entered.resolve();
          await release.promise;
          yield* tool('complete_work', {
            links: [],
            publications: [{ publicationId: ack.publicationId }],
          })();
        },
      ]);
      const h = await boot(t, { expert: true, localWorkspace, adapter });
      try {
        await start(h);
        await entered.promise;
        const snapshot = JSON.stringify(h.run().composition);
        if (cause === 'logout') {
          const response = await fetch(h.base + '/zhuma-id/logout', {
            method: 'POST',
            headers: { cookie: h.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          assert.equal(response.status, 200);
        } else {
          const fibers = [...h.ctx.registry.get(LocalAttachmentStore).fibers];
          assert.equal(fibers.length, 1);
          await fibers[0].dispose();
        }
        if (!signal.aborted) await once(signal, 'abort', { signal: AbortSignal.timeout(5000) });
        assert.equal(h.run().resources, 'held');
        assert.equal(h.row().artifactVersions.length, 0);
        release.resolve();
        await waitFor(h.ctx, () => h.run().resources === 'settled');
        assert.equal(JSON.stringify(h.run().composition), snapshot);
        assert.equal(h.run().resultDelivery, undefined);
        assert.equal(h.row().artifactVersions.length, 0);
        assert.equal(h.ctx.agents.list().length, 0);
        assert.equal(adapter.requests.length, 3);
        assert.equal((await h.rpc('run', 'begin', h.begin)).result.ok, false);
      } finally {
        release.resolve();
      }
    },
  );
