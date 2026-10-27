/** Pure Client wire/member epoch contracts. They cannot prove project authority or file bytes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionHttpApi } from '../dist/execution/http.js';
import { createProjectArtifactsApi } from '../dist/workbench/project-artifacts-api.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectHub } from '../dist/workbench/ProjectHub.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const location = { spaceId: 'north', projectId: 'project' };
const ref = {
  ...location,
  taskId: 'task',
  planId: 'plan',
  revision: 1,
  nodeId: 'node',
  artifactVersionId: 'fixed-version',
};
const item = {
  ref,
  version: 1,
  taskTitle: 'Task',
  nodeTitle: 'Design',
  nodeStatus: 'completed',
  submittedBy: 'chen',
  hasText: true,
  linkCount: 1,
  fileCount: 0,
};
const list = { view: 'list', ...location, coverage: 'latest-confirmed-plans', items: [item] };
const content = {
  view: 'content',
  ref,
  version: 1,
  content: { text: 'Accepted text', links: ['https://example.com/reference'], files: [] },
};
const signal = () => new AbortController().signal;
const session = (accountId = 'chen') => ({
  ok: true,
  accountId,
  principal: { kind: 'zhuma-member', memberId: accountId },
  peerId: 'peer',
  spaces: [{ id: 'north', kind: 'team', name: 'Team' }],
});

test('project results entry: normal materials tab mounts one lazy panel; overview never mounts its query', () => {
  const data = fixture(),
    props = {
      project: data.state.projects[0],
      state: data.state,
      tab: 'materials',
      changeTab() {},
      openTask() {},
      createTask() {},
      edit() {},
      spaceId: 'north',
      projectExecution: {
        projectArtifacts: {
          async list() {
            assert.fail('SSR must not read');
          },
          async content() {
            assert.fail('SSR must not read content');
          },
        },
      },
    };
  const html = renderToStaticMarkup(createElement(ProjectHub, props));
  assert.equal((html.match(/已接受成果<\/h2>/gu) ?? []).length, 1);
  assert.match(html, /正在读取成果/);
  const overview = renderToStaticMarkup(createElement(ProjectHub, { ...props, tab: 'overview' }));
  assert.doesNotMatch(overview, /正在读取成果|成果查询尚未接通/);
});
test('project results Client: list stays metadata-only; explicit exact version content uses original guarded member transport', async () => {
  const calls = [];
  const api = createExecutionHttpApi(
    async (url, options) => {
      calls.push({ url, options });
      if (url === '/zhuma-id/session') return Response.json(session());
      assert.equal(url, '/api/zhuma-exec/project-artifacts');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'zhuma-exec/project-artifacts');
      assert.equal('actorId' in body.payload, false);
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: body.payload.view === 'list' ? list : content },
      });
    },
    () => {},
    'chen',
    {
      spaceId: 'north',
      isCurrent: () => true,
      onUnavailable() {
        assert.fail();
      },
    },
  ).projectArtifacts;
  assert.deepEqual(await api.list({ ...location, actorId: 'not-sent' }, signal()), list);
  assert.equal(calls.filter((call) => call.url.startsWith('/api')).length, 1);
  assert.deepEqual(await api.content(ref, signal()), content);
  const bodies = calls
    .filter((call) => call.url.startsWith('/api'))
    .map((call) => JSON.parse(call.options.body).payload);
  assert.deepEqual(bodies, [
    { view: 'list', ...location, limit: 20 },
    { view: 'content', ref },
  ]);
  assert.equal(
    calls.filter((call) => call.url === '/zhuma-id/session').length,
    4,
    'fresh member check before and after each projection',
  );
});
test('project results Client: changed account after a delayed body cannot display accepted content under the old API', async () => {
  let account = 'chen',
    invalidated = 0,
    serverReads = 0;
  const api = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') return Response.json(session(account));
      serverReads++;
      account = 'outside';
      return Response.json({
        type: 'server-response',
        rpcId: JSON.parse(options.body).rpcId,
        result: { ok: true, value: content },
      });
    },
    () => invalidated++,
    'chen',
    { spaceId: 'north', isCurrent: () => true, onUnavailable() {} },
  ).projectArtifacts;
  await assert.rejects(api.content(ref, signal()), { code: 'unauthenticated' });
  assert.equal(serverReads, 1);
  assert.equal(invalidated, 1);
});
test('project results Client: crossed scope/version, duplicate rows and malformed cursor are rejected', async () => {
  let calls = 0;
  const api = createProjectArtifactsApi(async () => {
    calls++;
    return list;
  }, 'north');
  await assert.rejects(api.list({ ...location, spaceId: 'other' }, signal()), {
    code: 'validation',
  });
  await assert.rejects(
    api.list(
      {
        ...location,
        cursor: { selection: 'x', taskId: 'task', planId: 'plan', revision: 1, offset: 0 },
      },
      signal(),
    ),
    { code: 'validation' },
  );
  assert.equal(calls, 0);
  for (const bad of [
    { ...list, projectId: 'other' },
    { ...list, items: [item, item] },
    { ...list, coverage: 'all-plans' },
    { ...list, items: [{ ...item, ref: { ...ref, spaceId: 'other' } }] },
  ]) {
    const broken = createProjectArtifactsApi(async () => bad, 'north');
    await assert.rejects(broken.list(location, signal()), { code: 'validation' });
  }
  for (const bad of [
    { ...content, ref: { ...ref, artifactVersionId: 'other' } },
    { ...content, content: { ...content.content, text: 'x'.repeat(100001) } },
  ]) {
    const broken = createProjectArtifactsApi(async () => bad, 'north');
    await assert.rejects(broken.content(ref, signal()), { code: 'validation' });
  }
});
test('project results Client: an empty scan page retains its bounded next cursor and stale view results are discarded', async () => {
  const cursor = {
    selection: 'b'.repeat(64),
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    offset: 200,
  };
  const page = { ...list, items: [], nextCursor: cursor };
  const api = createProjectArtifactsApi(async () => page, 'north');
  assert.deepEqual(await api.list(location, signal()), page);
  let current = true;
  const stale = createExecutionHttpApi(
    async (url, options) => {
      if (url === '/zhuma-id/session') return Response.json(session());
      current = false;
      return Response.json({
        type: 'server-response',
        rpcId: JSON.parse(options.body).rpcId,
        result: { ok: true, value: list },
      });
    },
    () => {},
    'chen',
    { spaceId: 'north', isCurrent: () => current, onUnavailable() {} },
  ).projectArtifacts;
  await assert.rejects(stale.list(location, signal()), { name: 'AbortError' });
});
