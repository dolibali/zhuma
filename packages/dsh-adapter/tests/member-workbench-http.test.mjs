import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { projectCommand, request, taskInput } from './member-workbench-fixture.mjs';

// Real DSH Connection, identity cookies, space and JSON Workbench domains. No browser/model.
test(
  'member HTTP components: create, edit, confirm, logout/revocation and same-disk reopen retain the canonical facts',
  { timeout: 30000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-member-workbench-'));
    let host;
    try {
      host = await startMemberWorkbenchHost(home);
      const cookies = {};
      for (const id of ['ann', 'bob', 'cy', 'dana']) cookies[id] = await host.login(id);
      assert.equal((await host.rpc('snapshot', { spaceId: 'north' })).status, 401);
      const empty = await host.rpc('snapshot', { spaceId: 'personal-ann' }, cookies.ann);
      assert.equal(empty.status, 200);
      assert.equal(empty.json.result.ok, true);
      assert.deepEqual(empty.json.result.value.state.projects, []);
      const project = request(0, projectCommand());
      const first = await host.rpc('command', project, cookies.ann);
      assert.equal(first.json.result.ok, true, JSON.stringify(first.json));
      assert.equal(first.json.result.value.state.revision, 1);
      assert.equal((await host.directory.spaceForProject('project-one')).spaceId, 'north');
      const created = await host.rpc(
        'command',
        request(1, { type: 'create-task', task: taskInput() }),
        cookies.ann,
      );
      assert.equal(created.json.result.ok, true);
      const updated = await host.rpc(
        'command',
        request(2, { type: 'update-task', task: taskInput({ title: '确认接口边界' }) }),
        cookies.ann,
      );
      assert.equal(updated.json.result.ok, true);
      const confirmation = request(3, { type: 'confirm-task', taskId: 'task-one' });
      const confirmed = await host.rpc('command', confirmation, cookies.ann);
      assert.equal(confirmed.json.result.ok, true);
      const plan = confirmed.json.result.value.state.appliedPlans[0];
      assert.equal(plan.task.title, '确认接口边界');
      assert.equal(plan.sourceWorkbenchRevision, 3);
      const other = await host.rpc('snapshot', { spaceId: 'north' }, cookies.cy);
      assert.deepEqual(other.json.result.value.state.tasks, []);
      const foreign = await host.rpc('snapshot', { spaceId: 'north' }, cookies.dana);
      assert.equal(foreign.json.result.error.code, 'not-found');
      const wrongActor = await host.rpc(
        'command',
        { ...request(4, projectCommand('wrong')), actorId: 'bob' },
        cookies.ann,
      );
      assert.equal(wrongActor.json.result.error.code, 'validation');
      const before = JSON.stringify(host.service.snapshot());
      const forbidden = await host.rpc(
        'command',
        request(4, { type: 'confirm-task', taskId: 'task-one' }),
        cookies.bob,
      );
      assert.equal(forbidden.json.result.error.code, 'forbidden');
      assert.equal(JSON.stringify(host.service.snapshot()), before);
      const badOrigin = await host.rpc('snapshot', { spaceId: 'north' }, cookies.ann, {
        origin: 'https://foreign.invalid',
      });
      assert.equal(badOrigin.status, 403);
      assert.equal((await host.post('/zhuma-id/logout', {}, cookies.ann)).status, 200);
      assert.equal((await host.rpc('snapshot', { spaceId: 'north' }, cookies.ann)).status, 401);
      cookies.ann = await host.login('ann');
      await host.directory.revokeMembership('north', 'ann');
      assert.equal(
        (await host.rpc('command', confirmation, cookies.ann)).json.result.error.code,
        'not-found',
      );
      assert.equal(host.service.snapshot().revision, 4);
      await host.close();
      host = undefined;
      const persisted = JSON.parse(
        await readFile(join(home, 'storages', 'zhuma_workbench.json'), 'utf8'),
      );
      assert.equal(persisted.global.revision, 4);
      assert.equal(persisted.global.appliedPlans.length, 1);
      host = await startMemberWorkbenchHost(home);
      cookies.bob = await host.login('bob');
      const restored = await host.rpc('snapshot', { spaceId: 'north' }, cookies.bob);
      assert.deepEqual(restored.json.result.value.state.appliedPlans[0], {
        ...plan,
        participants: plan.participants.filter((p) => p.id !== 'ann'),
      });
      assert.deepEqual(host.service.snapshot().appliedPlans[0], plan);
      assert.equal((await host.directory.spaceForProject('project-one')).spaceId, 'north');
      assert.equal(host.directory.isMember('north', 'ann'), false);
      cookies.ann = await host.login('ann');
      assert.equal(
        (await host.rpc('snapshot', { spaceId: 'north' }, cookies.ann)).json.result.error.code,
        'not-found',
      );
      await host.directory.grantMembership('north', 'ann');
      const replay = await host.rpc('command', confirmation, cookies.ann);
      assert.equal(replay.json.result.ok, true);
      assert.equal(replay.json.result.value.state.revision, 4);
      assert.equal(replay.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(JSON.stringify(restored.json), /passwordHash|scrypt|credentials.yaml/);
    } finally {
      if (host) await host.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
