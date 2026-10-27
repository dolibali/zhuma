/** Emitted Host child + original Connection/JSON/member HTTP and public Client.
 * Trusted confirmed seed; no native Agent, model, browser or GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hashPassword } from '../dist/identity-session.js';
import { startAcceptanceHost } from './fixtures/m1-acceptance-harness.mjs';

if (process.env.S1A_HOST_MODULE === undefined)
  process.env.S1A_HOST_MODULE = fileURLToPath(new URL('../dist/host-plugin.js', import.meta.url));
const bundle = await build({
  stdin: {
    contents: "export { createExecutionHttpApi } from '@zhuma/client';",
    resolveDir: fileURLToPath(new URL('../../client', import.meta.url)),
    sourcefile: 'task-progress-client.mjs',
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
  Object.keys(bundle.metafile.inputs).some((path) => /dsh-adapter\//u.test(path)),
  false,
);
const { createExecutionHttpApi } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

test(
  'member task progress Host: pure manual accepted work reaches the original public query without a Run; outsider and old refs fail closed',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'zhuma-progress-member-'));
    let host;
    t.after(async () => {
      await host?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const password = 'synthetic-progress-proof';
    const members = ['chen', 'outside'];
    const task = {
      id: 'task',
      projectId: 'project',
      title: '人工交付',
      goal: '核对同源进度',
      participantIds: ['chen'],
      ownerId: 'chen',
      status: 'ready',
      updatedAt: new Date().toISOString(),
      workflows: [
        {
          id: 'root',
          name: '工作流',
          parentNodeId: null,
          nodes: [
            {
              id: 'deliver',
              title: '提交说明',
              description: '',
              assigneeId: 'chen',
              reviewerIds: [],
              reviewRequired: false,
              dependsOn: [],
              skillIds: [],
              mcpIds: [],
              input: '',
              output: '说明',
              rationale: '',
              position: { x: 0, y: 0 },
            },
          ],
        },
      ],
    };
    host = await startAcceptanceHost(directory, {
      deploymentMode: 'multi-member',
      identityImport: {
        accounts: members.map((id) => ({ id, passwordHash: hashPassword(password) })),
      },
      spaceDirectoryImport: {
        spaces: [{ id: 'north', name: '团队', kind: 'team' }],
        memberships: members.map((accountId) => ({ spaceId: 'north', accountId })),
        projectSpaces: [{ projectId: 'project', spaceId: 'north' }],
      },
      workbenchSeed: [
        { type: 'save-project', project: { id: 'project', name: '项目', description: '' } },
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
        { type: 'save-task', task },
      ],
    });
    const cookie = await host.login('chen', password);
    const api = createExecutionHttpApi(
      (url, init) =>
        fetch(host.baseURL + url, {
          ...init,
          headers: {
            ...init.headers,
            origin: host.baseURL,
            cookie: `${host.ownerCookie}; ${cookie}`,
          },
        }),
      () => assert.fail('auth loss'),
      'chen',
      {
        spaceId: 'north',
        isCurrent: () => true,
        onUnavailable: () => assert.fail('scope loss'),
      },
    );
    const signal = new AbortController().signal;
    const plan = (await api.startable(signal)).plans.find((item) => item.taskId === 'task');
    assert.ok(plan);
    const target = { taskId: 'task', planId: plan.planId, revision: plan.revision };
    const query = { spaceId: 'north', plans: [target] };
    const before = await api.taskProgress.read(query, signal);
    assert.equal(before.actorId, 'chen');
    assert.equal(before.items[0].facts, 'not-started');
    assert.equal(before.items[0].acceptedNodes, 0);
    await api.startPlan({ ...target, idempotencyKey: 'manual-start' }, signal);
    const node = (await api.inbox(signal)).nodes.find((item) => item.nodeId === 'deliver');
    const privateText = 'Private fixed manual body: metadata queries must not return this.';
    const submitted = await api.submit(
      {
        ...target,
        nodeId: 'deliver',
        expectedVersion: node.version,
        idempotencyKey: 'manual-submit',
        text: privateText,
        files: [],
        links: [],
      },
      signal,
    );
    assert.ok(submitted.acceptedArtifactVersionId);
    const after = await api.taskProgress.read(query, signal);
    assert.equal(after.items[0].delivery, 'all-accepted');
    assert.equal(after.items[0].acceptedNodes, 1);
    assert.equal(after.items[0].byStatus.completed, 1);
    assert.deepEqual(after.items[0].assigneeCounts, { human: 1, expert: 0 });
    assert.deepEqual(after.items[0].resources, { authorHeld: 0, reviewHeld: 0, stopRequested: 0 });
    assert.equal(JSON.stringify(after).includes(privateText), false);
    const outsider = await host.login('outside', password);
    const hidden = await host.exec('task-progress', query, outsider);
    assert.equal(hidden.result.ok, false);
    await assert.rejects(
      api.taskProgress.read({ ...query, plans: [{ ...target, planId: 'old-plan' }] }, signal),
      { code: 'conflict' },
    );
  },
);
