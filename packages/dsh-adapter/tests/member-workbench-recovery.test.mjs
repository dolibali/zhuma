import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, projectCommand, taskInput } from './member-workbench-fixture.mjs';

async function boot(input) {
  const child = fork(
    fileURLToPath(new URL('./member-workbench-recovery-process.mjs', import.meta.url)),
    [],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH } },
  );
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-1000);
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`recovery child timed out: ${diagnostics}`)),
        15000,
      );
      child.once('message', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.send(input);
    });
    assert.equal(result.ok, true, result.error);
    return result;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
}
async function rows(home) {
  try {
    return Object.values(
      JSON.parse(await readFile(join(home, 'storages', 'zhuma_member_operations.json'), 'utf8'))
        .tables.intents,
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test(
  'member operation real JSON/new-process recovery: intent/assignment/Workbench/completion failure boundaries require explicit original retry',
  { timeout: 45000 },
  async () => {
    for (const stage of [
      'before-intent',
      'after-intent',
      'after-assign',
      'before-complete',
      'after-complete',
    ]) {
      const home = await mkdtemp(join(tmpdir(), 'zhuma-member-recovery-'));
      try {
        const input = request(0, projectCommand());
        const changed = {
          ...input,
          command: { ...input.command, project: { ...input.command.project, name: 'changed' } },
        };
        const failed = await boot({ home, faultStage: stage, crash: true, commands: [input] });
        assert.equal(failed.responses[0].ok, false);
        const expectedRevision = ['before-complete', 'after-complete'].includes(stage) ? 1 : 0;
        assert.equal(failed.revision, expectedRevision);
        const metadata = await rows(home);
        assert.equal(metadata.length, stage === 'before-intent' ? 0 : 1);
        if (metadata.length)
          assert.equal(metadata[0].state, stage === 'after-complete' ? 'completed' : 'pending');
        const readOnly = await boot({ home });
        assert.equal(readOnly.before, expectedRevision);
        assert.equal(readOnly.revision, expectedRevision); // startup never resumes a pending operation
        if (stage !== 'before-intent') {
          const rejected = await boot({ home, commands: [changed] });
          assert.equal(rejected.responses[0].error.code, 'request-reused');
          assert.equal(rejected.revision, expectedRevision);
        }
        const recovered = await boot({ home, commands: [input, input] });
        assert.equal(
          recovered.responses.every((r) => r.ok),
          true,
        );
        assert.equal(recovered.revision, 1);
        assert.equal(recovered.projectCount, 1);
        assert.equal((await rows(home))[0].state, 'completed');
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  'member operation real JSON/new-process recovery: task and confirm acknowledgement failure do not duplicate business objects or plan revisions',
  { timeout: 30000 },
  async () => {
    for (const type of ['create-task', 'confirm-task']) {
      const home = await mkdtemp(join(tmpdir(), 'zhuma-member-plan-recovery-'));
      try {
        const initial = [request(0, projectCommand())];
        if (type === 'confirm-task')
          initial.push(request(1, { type: 'create-task', task: taskInput() }));
        await boot({ home, commands: initial });
        const input = request(
          initial.length,
          type === 'create-task' ? { type, task: taskInput() } : { type, taskId: 'task-one' },
        );
        const failed = await boot({
          home,
          faultStage: 'before-complete',
          crash: true,
          commands: [input],
        });
        assert.equal(failed.responses[0].ok, false);
        const recovered = await boot({ home, commands: [input, input] });
        assert.equal(
          recovered.responses.every((r) => r.ok),
          true,
        );
        assert.equal(recovered.revision, initial.length + 1);
        assert.equal(recovered.projectCount, 1);
        assert.equal(recovered.taskCount, 1);
        assert.equal(recovered.planCount, type === 'confirm-task' ? 1 : 0);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  },
);

test(
  'member operation real JSON/new-process recovery: revoked pending owner does not commit on restart/retry',
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-member-revoke-recovery-'));
    try {
      const input = request(0, projectCommand());
      await boot({ home, faultStage: 'after-assign', crash: true, commands: [input] });
      const before = await rows(home);
      const rejected = await boot({ home, revoke: true, commands: [input] });
      assert.equal(rejected.responses[0].error.code, 'not-found');
      assert.equal(rejected.revision, 0);
      assert.equal(rejected.projectCount, 0);
      assert.deepEqual(await rows(home), before);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

for (const kind of ['expert', 'skill', 'mcp']) {
  test(
    `member catalog pin real JSON/new-process recovery: pending ${kind} definition stays fixed through replacement/revocation/restoration`,
    { timeout: 45000 },
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'zhuma-member-catalog-recovery-'));
      try {
        const { catalogTask, catalogFixture } =
          await import('./member-workbench-catalog-fixture.mjs');
        await boot({
          home,
          catalogMode: 'old',
          commands: [
            request(0, projectCommand()),
            request(1, { type: 'create-task', task: catalogTask() }),
          ],
        });
        const input = request(2, { type: 'confirm-task', taskId: 'task-one' });
        const interrupted = await boot({
          home,
          catalogMode: 'old',
          faultStage: 'after-intent',
          crash: true,
          commands: [input],
        });
        assert.equal(interrupted.revision, 2);
        assert.equal(interrupted.planCount, 0);
        assert.equal(interrupted.responses[0].ok, false);
        const pending = (await rows(home)).at(-1);
        assert.equal(pending.state, 'pending');
        assert.match(pending.contextFingerprint, /^[a-f0-9]{64}$/);
        for (const change of ['content', 'revoke', ...(kind === 'mcp' ? [] : ['version'])]) {
          const replaced = await boot({
            home,
            catalogMode: `${kind}:${change}`,
            commands: [input],
          });
          assert.equal(replaced.responses[0].error.code, 'context-changed');
          assert.equal(replaced.before, 2);
          assert.equal(replaced.revision, 2);
          assert.equal(replaced.taskCount, 1);
          assert.equal(replaced.planCount, 0);
          assert.deepEqual((await rows(home)).at(-1), pending);
        }
        const recovered = await boot({ home, catalogMode: 'old', commands: [input, input] });
        assert.equal(
          recovered.responses.every((value) => value.ok),
          true,
        );
        assert.equal(recovered.revision, 3);
        assert.equal(recovered.taskCount, 1);
        assert.equal(recovered.planCount, 1);
        const completed = (await rows(home)).at(-1);
        assert.equal(completed.contextFingerprint, pending.contextFingerprint);
        assert.equal(completed.state, 'completed');
        assert.doesNotMatch(
          JSON.stringify(completed),
          /OLD_AUTHORIZED|NEW_AUTHORIZED|instructions|content/,
        );
        const canonical = JSON.parse(
          await readFile(join(home, 'storages', 'zhuma_workbench.json'), 'utf8'),
        ).global;
        const original = catalogFixture();
        assert.deepEqual(
          canonical.appliedPlans[0].participants.find((p) => p.kind === 'expert'),
          original.experts[0],
        );
        assert.deepEqual(canonical.appliedPlans[0].assets, original.assets);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}
