// Original Service/domain/JSON with actual published local attachment bytes.
// Member/session and project authority are explicit contracts, not normal UI.
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { open, checked, caller } from './execution-service-run-fixture.mjs';

export function projectWorkbench({ count = 2, privateTask = true } = {}) {
  const { state, task, node } = fixture();
  const workflows = Array.from({ length: Math.ceil(count / 80) }, (_, workflowIndex) => ({
    id: `workflow-${workflowIndex}`,
    name: `工作流 ${workflowIndex}`,
    parentNodeId: null,
    nodes: Array.from({ length: Math.min(80, count - workflowIndex * 80) }, (_, index) => ({
      ...node,
      id: `work-${workflowIndex * 80 + index}`,
      title: `交付 ${workflowIndex * 80 + index}`,
      assigneeId: 'outside',
      reviewerIds: [],
      reviewRequired: false,
      skillIds: [],
    })),
  }));
  let next = state;
  for (let index = 0; index < workflows.length; index++)
    next = applyWorkbenchCommand(next, {
      type: 'save-task',
      task: {
        ...task,
        id: index ? `task-${index}` : 'task',
        status: 'ready',
        participantIds: ['chen', 'outside'],
        workflows: [workflows[index]],
      },
    });
  if (privateTask)
    next = applyWorkbenchCommand(next, {
      type: 'save-task',
      task: {
        ...task,
        id: 'private-child',
        title: 'PRIVATE_CHILD_TITLE',
        goal: 'PRIVATE_CHILD_GOAL',
        participantIds: ['outside'],
        ownerId: 'outside',
        status: 'ready',
        workflows: [
          { ...workflows[0], nodes: [{ ...workflows[0].nodes[0], title: 'PRIVATE_CHILD_NODE' }] },
        ],
      },
    });
  return next;
}
export async function projectHost(t, { file = false, workbench = projectWorkbench() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-project-artifacts-')),
    hooks = {},
    calls = { source: 0, release: 0, bytes: 0 };
  let media, attachments, originalAttachments;
  if (file) {
    const ctx = new Context();
    media = ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'attachments') });
    await media;
    const original = ctx.attachments;
    originalAttachments = original;
    attachments = {
      saveFileStream: original.saveFileStream.bind(original),
      async *readFileStream(ref, options) {
        calls.bytes++;
        await hooks.beforeBytes?.();
        for await (const chunk of original.readFileStream(ref, options)) yield chunk;
      },
    };
  }
  const h = await open(root, { seed: false, workbench, attachments });
  const otherRequest = Object.freeze({ headers: {} });
  h.members.set(otherRequest, 'outside');
  const source =
    (actorId = 'chen') =>
    async () => {
      calls.source++;
      await hooks.source?.();
      const original = actorId === 'chen' ? h.request : otherRequest,
        lease = await h.service.runHost.memberLease(original),
        release = lease.release;
      return {
        lease: {
          ...lease,
          assertCurrent(spaceId) {
            lease.assertCurrent(spaceId);
            return hooks.member?.();
          },
          release() {
            calls.release++;
            return release.call(lease);
          },
        },
        assertProjectSpace(projectId, spaceId) {
          h.service.runHost.assertProjectSpace(projectId, spaceId);
          return hooks.project?.();
        },
      };
    };
  for (const plan of workbench.appliedPlans)
    checked(
      await h.service.startPlan(caller(plan.task.ownerId), {
        taskId: plan.taskId,
        planId: plan.id,
        revision: plan.revision,
        idempotencyKey: `start-${plan.id}`,
      }),
    );
  const locate = (taskId = 'task', nodeId = 'work-0') => {
    const plan = h
      .readWorkbench()
      .appliedPlans.filter((item) => item.taskId === taskId)
      .at(-1);
    return { taskId, planId: plan.id, revision: plan.revision, nodeId };
  };
  const submit = async (text = '已接受的固定正文', files = [], taskId, nodeId) => {
    const location = locate(taskId, nodeId),
      row = h.service.readRunNode(location),
      actor = row.handoff.assignee.id;
    checked(
      await h.service.submit(
        caller(actor),
        {
          ...location,
          expectedVersion: row.command.version,
          idempotencyKey: randomUUID(),
          text,
          files,
        },
        files.length ? source(actor) : undefined,
      ),
    );
    return {
      ...location,
      spaceId: 'north',
      projectId: 'project',
      artifactVersionId: h.service.readRunNode(location).acceptedArtifactVersionId,
    };
  };
  const upload = async (text = '固定文件正文') => {
    const location = locate(),
      data = Buffer.from(text),
      authority = await source('outside')();
    try {
      return checked(
        await h.service.uploadFile(
          caller('outside'),
          {
            ...location,
            spaceId: 'north',
            idempotencyKey: randomUUID(),
            declare: {
              name: 'fixed-result.txt',
              mediaType: 'text/plain',
              byteSize: data.length,
              sha256: createHash('sha256').update(data).digest('hex'),
            },
            data: (async function* () {
              yield data;
            })(),
          },
          authority,
        ),
      );
    } finally {
      authority.lease.release();
    }
  };
  t.after(async () => {
    await h.close();
    await media?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...h,
    root,
    attachments,
    media,
    source,
    otherRequest,
    hooks,
    calls,
    locate,
    submit,
    upload,
    attachmentPath: (upload) =>
      originalAttachments.fileHostPath({
        attachmentId: `sha256:${upload.sha256}`,
        bytes: upload.bytes,
        name: upload.name,
      }),
  };
}
export const listQuery = (patch = {}) => ({
  view: 'list',
  spaceId: 'north',
  projectId: 'project',
  ...patch,
});
export async function domainBytes(root) {
  const files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    files.map(async (name) => [name, (await readFile(join(root, name))).toString('base64')]),
  );
}
