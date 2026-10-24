import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createExecutionApi, readRevisionView } from '../dist/execution/ExecutionApi.js';
import { executionPanels } from '../dist/execution/ExecutionWorkspace.js';
import { InboxPanel } from '../dist/execution/InboxPanel.js';
import { RevisionPanel } from '../dist/execution/RevisionPanel.js';

const view = {
  reviewed: {
    id: 'artifact-2',
    version: 2,
    text: '错误码还没写',
    links: ['https://example.test/spec'],
    files: [{ id: 'spec', mediaType: 'text/plain', byteSize: 12 }],
  },
  previous: {
    id: 'artifact-1',
    version: 1,
    text: '第一版说明',
    links: [],
    files: [],
  },
  notes: [
    {
      id: 'return-round-1-0',
      reviewerName: '林夏',
      body: '请补充错误码',
      artifactVersionId: 'artifact-2',
      citedCommentIds: ['c-1'],
    },
  ],
};

const revise = {
  id: 'inbox-revise',
  kind: 'deliver',
  actorId: 'chen',
  nodeId: 'design',
  taskId: 'task',
  reason: 'revision-delivery',
  action: 'revise',
};

test('revision read keeps return notes and does not ask for file bytes', async () => {
  const calls = [];
  const api = createExecutionApi({
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      return { ok: true, value: { view } };
    },
  });
  const read = await api.revision({
    taskId: 'task',
    planId: 'plan',
    revision: 1,
    nodeId: 'design',
  });
  assert.equal(calls[0].endpoint, 'zhuma-exec/revision');
  assert.deepEqual(Object.keys(calls[0].payload).sort(), [
    'nodeId',
    'planId',
    'revision',
    'taskId',
  ]);
  assert.equal(read.reviewed.text, '错误码还没写');
  assert.equal(read.previous.text, '第一版说明');
  assert.equal(read.notes[0].body, '请补充错误码');
  assert.deepEqual(read.notes[0].citedCommentIds, ['c-1']);
  assert.equal(read.reviewed.files[0].byteSize, 12);
  assert.throws(
    () =>
      readRevisionView({
        view: { notes: [], reviewed: { id: 'a', version: 1, links: [], files: [{}] } },
      }),
    /文件/,
  );
  await assert.rejects(
    createExecutionApi({
      async call() {
        return {
          ok: false,
          error: {
            code: 'not-found',
            message: '找不到这个节点。',
          },
        };
      },
    }).revision({ taskId: 'task', planId: 'plan', revision: 1, nodeId: 'design' }),
    /找不到这个节点/,
  );
});

test('a returned inbox item opens the reviewed content', () => {
  assert.deepEqual(executionPanels('revise'), ['revision', 'delivery']);
  assert.deepEqual(executionPanels('submit'), ['delivery']);
  assert.deepEqual(executionPanels('review'), ['review']);
  const html = renderToStaticMarkup(
    createElement(InboxPanel, {
      items: [revise],
      nodes: [],
      reload() {},
      open() {},
    }),
  );
  assert.match(html, /data-revision-target="revision-reviewed"/);
  assert.match(html, /提交新版本/);
});

test('the revision panel lists each return note and the previous version', () => {
  const html = renderToStaticMarkup(createElement(RevisionPanel, { view }));
  assert.match(html, /id="revision-reviewed"/);
  assert.match(html, /错误码还没写/);
  assert.match(html, /spec · text\/plain · 12 字节/);
  assert.match(html, /https:\/\/example\.test\/spec/);
  assert.match(html, /第一版说明/);
  assert.match(html, /查看上一版/);
  assert.match(html, /<h3>林夏<\/h3>/);
  assert.equal(html.includes('>lin<'), false);
  assert.match(html, /总体意见/);
  assert.match(html, /请补充错误码/);
  assert.match(html, /定位评论 c-1/);
  assert.match(html, /href="#revision-reviewed"/);
  assert.match(html, /定位到对应内容/);
  assert.match(html, /提交新版本/);
  const empty = renderToStaticMarkup(
    createElement(RevisionPanel, {
      view: {
        notes: [],
        reviewed: { id: 'a', version: 1, text: '只有一版', links: [], files: [] },
      },
    }),
  );
  assert.match(empty, /没有更早的版本/);
  assert.equal(empty.includes('查看上一版'), false);
});
