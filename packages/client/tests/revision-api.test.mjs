import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExecutionApi,
  readRevisionView,
  ExecutionError,
} from '../dist/execution/ExecutionApi.js';
import { revisionQuery, revisionView } from './revision-fixture.mjs';

test('revision DTO contract: bound Client sends exactly four frozen node fields, carries cancellation and preserves named metadata', async () => {
  const calls = [];
  const source = revisionView();
  source.reviewed.files[0].bytes = 'not-a-preview';
  const api = createExecutionApi(
    {
      async call(channel, endpoint, payload, signal) {
        calls.push({ channel, endpoint, payload, signal });
        return { ok: true, value: { view: source } };
      },
    },
    'team-current',
  );
  const controller = new AbortController();
  const view = await api.revision(
    { ...revisionQuery, spaceId: 'not-a-service-field', actorId: 'not-a-service-field' },
    controller.signal,
  );
  assert.deepEqual(calls[0], {
    channel: '/api',
    endpoint: 'zhuma-exec/revision',
    payload: revisionQuery,
    signal: controller.signal,
  });
  assert.equal(view.reviewed.id, 'artifact-v2');
  assert.equal(view.previous.version, 1);
  assert.equal(view.notes[0].reviewerName, '林夏');
  assert.deepEqual(view.notes[0].citedCommentIds, ['comment-auth']);
  assert.equal('bytes' in view.reviewed.files[0], false);
  source.notes[0].citedCommentIds.push('changed-after-read');
  assert.deepEqual(view.notes[0].citedCommentIds, ['comment-auth']);
});

test('revision DTO contract: missing content and empty opinions remain absence, never a latest-artifact fallback', () => {
  assert.deepEqual(readRevisionView({ view: { notes: [] } }), { notes: [] });
  const source = revisionView();
  delete source.previous;
  source.notes[0].body = '';
  assert.equal(readRevisionView({ view: source }).notes[0].body, '');
});

for (const [name, mutate] of [
  [
    'nonpositive version',
    (v) => {
      v.reviewed.version = 0;
    },
  ],
  [
    'fractional version',
    (v) => {
      v.reviewed.version = 1.5;
    },
  ],
  [
    'negative file size',
    (v) => {
      v.reviewed.files[0].byteSize = -1;
    },
  ],
  [
    'non-text body',
    (v) => {
      v.reviewed.text = {};
    },
  ],
  [
    'missing files',
    (v) => {
      delete v.reviewed.files;
    },
  ],
  [
    'unrelated previous',
    (v) => {
      v.previous.version = 9;
    },
  ],
  [
    'previous without reviewed',
    (v) => {
      delete v.reviewed;
    },
  ],
  [
    'blank reviewer',
    (v) => {
      v.notes[0].reviewerName = ' ';
    },
  ],
  [
    'non-text opinion',
    (v) => {
      v.notes[0].body = {};
    },
  ],
  [
    'malformed citation',
    (v) => {
      v.notes[0].citedCommentIds = [null];
    },
  ],
  [
    'duplicate note id',
    (v) => {
      v.notes[1].id = v.notes[0].id;
    },
  ],
  [
    'duplicate citation',
    (v) => {
      v.notes[0].citedCommentIds.push(v.notes[0].citedCommentIds[0]);
    },
  ],
])
  test(`revision DTO contract rejects ${name}`, () => {
    const view = revisionView();
    mutate(view);
    assert.throws(
      () => readRevisionView({ view }),
      (error) => error instanceof ExecutionError && error.code === 'validation',
    );
  });

test('revision DTO contract: server denials remain typed and are never retried or turned into empty success', async () => {
  let calls = 0;
  const api = createExecutionApi({
    async call() {
      calls++;
      return {
        ok: false,
        error: {
          code: 'not-participant',
          message: '不可读取该工作项。',
          details: { reason: 'membership' },
        },
      };
    },
  });
  await assert.rejects(
    api.revision(revisionQuery),
    (error) => error.code === 'not-participant' && error.details.reason === 'membership',
  );
  assert.equal(calls, 1);
});
