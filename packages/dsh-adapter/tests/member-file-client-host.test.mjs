/** Current public Client API + real Host child/member cookies/storage/attachments.
 * The confirmed workflow is a trusted fixture seed, not member creation or model planning.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { hashPassword } from '../dist/identity-session.js';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

if (process.env.S1A_HOST_MODULE === undefined)
  process.env.S1A_HOST_MODULE = fileURLToPath(new URL('../dist/host-plugin.js', import.meta.url));

// Resolve the Client's public package entry in its own package context. No Host
// code or cross-package source imports enter the Client proof artifact.
const client = await build({
  stdin: {
    contents: "export { createExecutionHttpApi } from '@zhuma/client';",
    resolveDir: fileURLToPath(new URL('../../client', import.meta.url)),
    sourcefile: 'client-file-proof.mjs',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
  metafile: true,
});
assert.equal(
  Object.keys(client.metafile.inputs).some((path) => /dsh-adapter\/src\//u.test(path)),
  false,
);
const clientBytes = client.outputFiles[0].contents;
const { createExecutionHttpApi } = await import(
  `data:text/javascript;base64,${Buffer.from(clientBytes).toString('base64')}`
);
const password = 'synthetic-file-client-proof';
const members = ['chen', 'lin', 'zhao', 'outside'];
const step = (id, assigneeId, extra = {}) => ({
  id,
  title: id,
  description: '',
  assigneeId,
  reviewerIds: [],
  reviewRequired: false,
  dependsOn: [],
  skillIds: [],
  mcpIds: [],
  input: '',
  output: '交付文件',
  rationale: '',
  position: { x: 0, y: 0 },
  ...extra,
});
const seed = [
  { type: 'save-project', project: { id: 'project', name: '文件交付', description: '' } },
  ...members.map((id) => ({
    type: 'save-participant',
    participant: {
      id,
      name: id,
      kind: 'human',
      role: '',
      capabilities: [],
      instructions: '',
      available: true,
    },
  })),
  {
    type: 'save-task',
    task: {
      id: 'task',
      projectId: 'project',
      title: '交付、评审与下游',
      goal: '验证固定文件读取',
      participantIds: ['chen', 'lin', 'zhao'],
      ownerId: 'chen',
      workflows: [
        {
          id: 'root',
          name: '工作流',
          parentNodeId: null,
          nodes: [
            step('design', 'chen', { reviewerIds: ['lin'], reviewRequired: true }),
            step('publish', 'zhao', { dependsOn: ['design'] }),
          ],
        },
      ],
      status: 'ready',
      updatedAt: '2026-10-26T00:00:00.000Z',
    },
  },
];

test(
  'actual member Client/Host HTTP: upload, draft restore, file-only review, return/re-submit and fixed downstream bytes',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-file-client-'));
    let host;
    t.after(async () => {
      await host?.close();
      await rm(directory, { recursive: true, force: true });
    });
    host = await startAcceptanceHost(directory, {
      deploymentMode: 'multi-member',
      identityImport: {
        accounts: members.map((id) => ({ id, passwordHash: hashPassword(password) })),
      },
      spaceDirectoryImport: {
        spaces: [{ id: 'north', name: '北队', kind: 'team' }],
        memberships: members.map((accountId) => ({ spaceId: 'north', accountId })),
        projectSpaces: [{ projectId: 'project', spaceId: 'north' }],
      },
      workbenchSeed: seed,
    });
    const clients = {};
    for (const id of members) {
      const cookie = await host.login(id, password);
      clients[id] = createExecutionHttpApi(
        (url, init) =>
          fetch(host.baseURL + url, {
            ...init,
            headers: {
              ...init.headers,
              origin: host.baseURL,
              cookie: `${host.ownerCookie}; ${cookie}`,
            },
          }),
        () => assert.fail('Unexpected authentication loss'),
        id,
        {
          spaceId: 'north',
          isCurrent: () => true,
          onUnavailable: () => assert.fail('Unexpected space loss'),
        },
      );
    }
    const signal = new AbortController().signal;
    const plans = await clients.chen.startable(signal);
    const plan = plans.plans.find((item) => item.taskId === 'task');
    assert.ok(plan);
    const locator = {
      taskId: 'task',
      planId: plan.planId,
      revision: plan.revision,
      nodeId: 'design',
    };
    await clients.chen.startPlan(
      { taskId: 'task', planId: plan.planId, revision: plan.revision, idempotencyKey: 'start' },
      signal,
    );
    const body = new TextEncoder().encode('真实产物文件\n不依赖模型执行。');
    const uploaded = await clients.chen.files.upload(
      {
        target: locator,
        file: new File([body], '交付说明.txt', { type: 'text/plain' }),
        requestId: 'file-one',
      },
      signal,
    );
    const draft = await clients.chen.saveDeliveryDraft(
      {
        ...locator,
        expectedVersion: 0,
        idempotencyKey: 'save',
        text: '',
        links: [],
        files: [uploaded.reference],
      },
      signal,
    );
    assert.equal(draft.files[0].checksum, createHash('sha256').update(body).digest('hex'));
    assert.equal(draft.fileDetails[0].name, '交付说明.txt');
    assert.deepEqual(await clients.chen.readDeliveryDraft(locator, signal), draft);
    const ready = (await clients.chen.inbox(signal)).nodes.find((item) => item.nodeId === 'design');
    const submitted = await clients.chen.submit(
      {
        ...locator,
        expectedVersion: ready.version,
        idempotencyKey: 'submit-one',
        text: '',
        links: [],
        files: draft.files,
      },
      signal,
    );
    const first = submitted.artifacts.at(-1),
      round = submitted.rounds.at(-1);
    const reviewTarget = {
      ...locator,
      purpose: 'review',
      artifactVersionId: first.id,
      roundId: round.id,
      uploadId: uploaded.uploadId,
    };
    const preview = await clients.lin.files.read(reviewTarget, 'preview', signal);
    assert.equal(preview.inline, true);
    assert.deepEqual(preview.bytes, body);
    await assert.rejects(clients.outside.files.metadata(reviewTarget, signal));
    await clients.lin.ballot(
      {
        ...locator,
        expectedVersion: submitted.version,
        idempotencyKey: 'return',
        roundId: round.id,
        artifactVersionId: first.id,
        action: 'request-changes',
        comment: '请补充说明后重新提交。',
      },
      signal,
    );
    const revision = await clients.chen.revision(locator, signal);
    assert.equal(revision.reviewed.id, first.id);
    const old = await clients.chen.files.read(
      { ...locator, purpose: 'artifact', artifactVersionId: first.id, uploadId: uploaded.uploadId },
      'download',
      signal,
    );
    assert.deepEqual(old.bytes, body);
    const changed = (await clients.chen.inbox(signal)).nodes.find(
      (item) => item.nodeId === 'design',
    );
    const second = await clients.chen.submit(
      {
        ...locator,
        expectedVersion: changed.version,
        idempotencyKey: 'submit-two',
        text: '补充了交付说明。',
        links: [],
        files: draft.files,
      },
      signal,
    );
    const latest = second.artifacts.at(-1),
      latestRound = second.rounds.at(-1);
    assert.notEqual(latest.id, first.id);
    await clients.lin.ballot(
      {
        ...locator,
        expectedVersion: second.version,
        idempotencyKey: 'approve',
        roundId: latestRound.id,
        artifactVersionId: latest.id,
        action: 'approve',
      },
      signal,
    );
    const downstream = (await clients.zhao.inbox(signal)).nodes.find(
      (item) => item.nodeId === 'publish',
    );
    assert.ok(downstream);
    assert.equal(downstream.inputs[0].artifactVersionId, latest.id);
    const accepted = await clients.zhao.files.read(
      {
        ...locator,
        nodeId: 'publish',
        purpose: 'upstream',
        sourceNodeId: 'design',
        artifactVersionId: latest.id,
        uploadId: uploaded.uploadId,
      },
      'download',
      signal,
    );
    assert.deepEqual(accepted.bytes, body);
    await assert.rejects(
      clients.zhao.files.metadata(
        {
          ...locator,
          nodeId: 'publish',
          purpose: 'upstream',
          sourceNodeId: 'design',
          artifactVersionId: first.id,
          uploadId: uploaded.uploadId,
        },
        signal,
      ),
    );
    assert.equal(host.seeded, true);
    assert.match(host.boundModule.contentDigest, /^[a-f0-9]{64}$/u);
    if (process.env.S1A_CLIENT_FILE_PROOF_FILE)
      await writeFile(
        process.env.S1A_CLIENT_FILE_PROOF_FILE,
        JSON.stringify({
          passed: true,
          clientSha256: createHash('sha256').update(clientBytes).digest('hex'),
          hostSha256: host.boundModule.contentDigest,
          sourceHead: host.boundModule.sourceSha,
          process: host.child.pid,
          scope:
            'real Client API, member HTTP, JSON domains and attachments; trusted confirmed-plan seed; no model or GUI',
        }),
      );
    t.diagnostic(
      `Client proof SHA256 ${createHash('sha256').update(clientBytes).digest('hex')}; Host module SHA256 ${host.boundModule.contentDigest}`,
    );
  },
);
