import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVersionedReviewComment, previewFixedDelivery } from '@zhuma/agent-core';

const versions = [
  { id: 'v1', version: 1, text: '第一行\n保留' },
  { id: 'v2', version: 2, text: '第一行\n已改' },
  { id: 'v3', version: 3, text: '后来的正文' },
];

test('preview pins the requested delivery version and diffs it against the previous stored text', () => {
  const pinned = previewFixedDelivery(versions, 'v2');
  assert.equal(pinned.ok, true);
  assert.equal(pinned.preview.artifactVersionId, 'v2');
  assert.equal(pinned.preview.version, 2);
  assert.equal(pinned.preview.text, '第一行\n已改');
  assert.equal(pinned.preview.baseVersion, 1);
  assert.equal(
    pinned.preview.diff,
    ['--- 第1版', '+++ 第2版', '@@ -2,1 +2,1 @@', '-保留', '+已改'].join('\n'),
  );
  assert.equal(pinned.preview.text.includes('后来的正文'), false);
  assert.equal(pinned.preview.diff.includes('后来的正文'), false);

  const first = previewFixedDelivery(versions, 'v1');
  assert.equal(first.ok, true);
  assert.equal(first.preview.text, '第一行\n保留');
  assert.equal(first.preview.diff, '');
  assert.equal(first.preview.baseVersion, undefined);

  const same = previewFixedDelivery(
    [
      { id: 'a', version: 1, text: '相同' },
      { id: 'b', version: 2, text: '相同' },
    ],
    'b',
  );
  assert.equal(same.ok, true);
  assert.equal(same.preview.diff, '');
  assert.equal(same.preview.baseVersion, 1);
  assert.equal(previewFixedDelivery(versions, 'missing').code, 'version-not-found');
  assert.equal(
    previewFixedDelivery(
      [
        { id: 'dup', version: 1, text: '一' },
        { id: 'dup', version: 1, text: '二' },
      ],
      'dup',
    ).code,
    'version-not-found',
  );
});

test('a comment or return binds to the given version and a blank opinion does not', () => {
  const noted = bindVersionedReviewComment({
    existing: [],
    id: 'c-1',
    artifactVersionId: 'v1',
    action: 'comment',
    comment: '请改第二行',
    authorId: 'lin',
  });
  assert.equal(noted.citedId, undefined);
  assert.deepEqual(noted.comments, [
    {
      id: 'c-1',
      status: 'open',
      versionId: 'v1',
      targetId: 'v1',
      body: '请改第二行',
      authorId: 'lin',
    },
  ]);
  const again = bindVersionedReviewComment({
    existing: noted.comments,
    id: 'c-1',
    artifactVersionId: 'v1',
    action: 'comment',
    comment: '请改第二行',
    authorId: 'lin',
  });
  assert.equal(again.comments.length, 1);
  const returned = bindVersionedReviewComment({
    existing: noted.comments,
    id: 'c-2',
    artifactVersionId: 'v1',
    action: 'request-changes',
    comment: ' 第二行不对 \u200b',
    authorId: 'lin',
  });
  assert.equal(returned.citedId, 'c-2');
  assert.equal(returned.comments[1].body, '第二行不对');
  assert.equal(returned.comments[1].versionId, 'v1');
  const blank = bindVersionedReviewComment({
    existing: noted.comments,
    id: 'c-blank',
    artifactVersionId: 'v1',
    action: 'request-changes',
    comment: ' \n\u200b',
    authorId: 'lin',
  });
  assert.equal(blank.citedId, undefined);
  assert.equal(blank.comments.length, 1);
  const approved = bindVersionedReviewComment({
    existing: noted.comments,
    id: 'c-ok',
    artifactVersionId: 'v1',
    action: 'approve',
    comment: '可以通过',
    authorId: 'lin',
  });
  assert.equal(approved.comments, noted.comments);
  const otherVersion = bindVersionedReviewComment({
    existing: noted.comments,
    id: 'c-1',
    artifactVersionId: 'v2',
    action: 'comment',
    comment: '这是另一版',
    authorId: 'lin',
  });
  assert.equal(otherVersion.comments, noted.comments);
  assert.equal(otherVersion.citedId, undefined);
});
