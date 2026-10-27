/** Actual emitted Host + original DSH SDK owner/member/file transport. No model
 * is invoked; bootstrap/catalog fixtures do not establish native GUI proof. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { boot, checked } from './zhuma-host-run-native.spec.ts';

test(
  'actual Host project artifacts: normal member reads accepted text and exact file bytes; non-participant cannot open either target',
  { timeout: 30000 },
  async (t) => {
    const h = await boot(t, { localWorkspace: { configured: false, policyMode: 'read-only' } });
    const fileText = 'Exact accepted project file.\n',
      bytes = Buffer.from(fileText),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploaded = await fetch(h.base + '/api/zhuma-exec/upload-file', {
      method: 'POST',
      headers: {
        cookie: h.cookie,
        'content-type': 'application/octet-stream',
        'x-zhuma-file-name': encodeURIComponent('result.txt'),
        'x-zhuma-file-type': 'text/plain',
        'x-zhuma-file-size': String(bytes.byteLength),
        'x-zhuma-file-sha256': sha256,
        'x-zhuma-space': 'north',
        'x-zhuma-task': h.locator.taskId,
        'x-zhuma-plan': h.locator.planId,
        'x-zhuma-revision': String(h.locator.revision),
        'x-zhuma-node': h.locator.nodeId,
        'x-zhuma-idempotency-key': randomUUID(),
      },
      body: bytes,
    });
    assert.equal(uploaded.status, 200);
    const upload = await uploaded.json();
    assert.equal(upload.ok, true, JSON.stringify(upload));
    const privateText = 'Accepted project body shown only on explicit content read.';
    const submitted = checked(
      await h.rpc('exec', 'submit', {
        ...h.locator,
        expectedVersion: h.row().command.version,
        idempotencyKey: randomUUID(),
        text: privateText,
        files: [upload.value.reference],
        links: [],
      }),
    );
    assert.ok(submitted.node.acceptedArtifactVersionId);
    const query = { view: 'list', spaceId: 'north', projectId: 'project' };
    const list = checked(await h.rpc('exec', 'project-artifacts', query));
    assert.equal(list.coverage, 'latest-confirmed-plans');
    assert.equal(list.items.length, 1);
    assert.equal(JSON.stringify(list).includes(privateText), false);
    assert.equal(list.items[0].fileCount, 1);
    const ref = list.items[0].ref;
    assert.equal(ref.artifactVersionId, submitted.node.acceptedArtifactVersionId);
    const content = checked(await h.rpc('exec', 'project-artifacts', { view: 'content', ref }));
    assert.equal(content.content.text, privateText);
    assert.deepEqual(content.content.files, [upload.value.reference]);
    const params = new URLSearchParams(
      Object.entries({
        ...ref,
        purpose: 'accepted',
        uploadId: upload.value.uploadId,
        mode: 'preview',
      }).map(([key, value]) => [key, String(value)]),
    );
    const preview = await fetch(h.base + '/api/zhuma-exec/file?' + params, {
      headers: { cookie: h.cookie },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('x-zhuma-file-sha256'), sha256);
    assert.equal(await preview.text(), fileText);
    const outsider = await h.login('outside');
    const hidden = checked(await h.rpc('exec', 'project-artifacts', query, outsider));
    assert.deepEqual(hidden.items, []);
    const denied = await h.rpc('exec', 'project-artifacts', { view: 'content', ref }, outsider);
    assert.equal(denied.result.ok, false);
    const blocked = await fetch(h.base + '/api/zhuma-exec/file?' + params, {
      headers: { cookie: outsider },
    });
    assert.equal(blocked.status, 404);
    assert.equal((await blocked.json()).ok, false);
    assert.equal(h.adapter.requests.length, 0);
    assert.equal(h.ctx.agents.list().length, 0);
    assert.equal(h.ctx.sessions.list().length, 0);
  },
);
