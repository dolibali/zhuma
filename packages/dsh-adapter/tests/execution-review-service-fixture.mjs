// Original Service/DSH JSON setup. Identity/model/native inputs remain explicit contracts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { open, caller, checked } from './execution-service-run-fixture.mjs';

export function workbench({
  reviewerIds = ['qa', 'qa-two', 'outside'],
  parallelExpert = false,
} = {}) {
  const f = fixture();
  f.state.participants.find((p) => p.id === 'qa').instructions =
    'Review the fixed content independently.';
  f.state.participants.push({ ...f.state.participants.find((p) => p.id === 'qa'), id: 'qa-two' });
  return applyWorkbenchCommand(f.state, {
    type: 'save-task',
    task: {
      ...f.task,
      status: 'ready',
      participantIds: ['chen', 'qa', 'qa-two', 'outside'],
      workflows: [
        {
          ...f.task.workflows[0],
          nodes: [
            { ...f.node, id: 'produce', skillIds: [], reviewerIds },
            {
              ...f.node,
              id: 'parallel',
              skillIds: [],
              reviewerIds: [],
              reviewRequired: false,
              ...(parallelExpert ? { assigneeId: 'qa-two' } : {}),
            },
            {
              ...f.node,
              id: 'consume',
              skillIds: [],
              dependsOn: ['produce'],
              reviewerIds: [],
              reviewRequired: false,
            },
          ],
        },
      ],
    },
  });
}
export async function host(
  t,
  {
    file,
    links = [],
    assertReviewConfiguration,
    migrationDrain,
    reviewerIds,
    parallelExpert,
    text = 'POST /login requires a valid challenge.',
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-review-service-'));
  const snapshot = workbench({ reviewerIds, parallelExpert });
  let media, attachments;
  if (file) {
    const ctx = new Context();
    media = ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'attachments') });
    await media;
    attachments = ctx.attachments;
  }
  const h = await open(root, {
    workbench: snapshot,
    attachments,
    assertReviewConfiguration,
    migrationDrain,
  });
  t.after(async () => {
    await h.close();
    await media?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const files = [];
  if (file) {
    const bytes = Buffer.from(file.text);
    const upload = checked(
      await h.service.uploadFile(
        caller(),
        {
          ...h.locate(),
          spaceId: 'north',
          idempotencyKey: 'upload-fixed-review-file',
          declare: {
            name: file.name,
            mediaType: file.mediaType,
            byteSize: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          data: (async function* () {
            yield bytes;
          })(),
        },
        {
          lease: {
            memberId: 'chen',
            expiresAt: Date.now() + 60_000,
            signal: new AbortController().signal,
            assertCurrent(spaceId) {
              assert.equal(spaceId, 'north');
            },
            release() {},
          },
          assertProjectSpace(projectId, spaceId) {
            assert.equal(projectId, 'project');
            assert.equal(spaceId, 'north');
          },
        },
      ),
    );
    files.push(upload.reference);
  }
  checked(
    await h.service.submit(
      caller(),
      {
        ...h.human('produce', 'deliver'),
        text,
        files,
        links,
      },
      file
        ? async () => ({
            lease: {
              memberId: 'chen',
              expiresAt: Date.now() + 60_000,
              signal: new AbortController().signal,
              assertCurrent(spaceId) {
                assert.equal(spaceId, 'north');
              },
              release() {},
            },
            assertProjectSpace(projectId, spaceId) {
              assert.equal(projectId, 'project');
              assert.equal(spaceId, 'north');
            },
          })
        : undefined,
    ),
  );
  h.resetCounts();
  return { ...h, root, snapshot, attachments };
}
