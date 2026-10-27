// Original Service/plugin and published DSH JSON. Identity/project bindings are
// explicit contracts; this does not certify a real session, SDK or GUI.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNodeTransitionCommand, nodeRecordKey } from '@zhuma/agent-core';
import { open, caller, checked } from './execution-service-run-fixture.mjs';
import { projectWorkbench } from './execution-project-artifacts-fixture.mjs';

export async function progressHost(t, { workbench = projectWorkbench(), start = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-task-progress-'));
  const h = await open(root, { seed: false, workbench });
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  const outside = Object.freeze({ headers: {} });
  h.members.set(outside, 'outside');
  const hooks = {},
    calls = { source: 0, release: 0, member: 0, project: 0 };
  const source =
    (actor = 'chen') =>
    async () => {
      calls.source++;
      await hooks.source?.();
      const lease = await h.service.runHost.memberLease(actor === 'chen' ? h.request : outside);
      const authority = {
        lease: {
          ...lease,
          assertCurrent(spaceId) {
            calls.member++;
            lease.assertCurrent(spaceId);
            return hooks.member?.(authority);
          },
          release() {
            calls.release++;
            lease.release();
          },
        },
        assertProjectSpace(projectId, spaceId) {
          calls.project++;
          h.service.runHost.assertProjectSpace(projectId, spaceId);
          return hooks.project?.(authority);
        },
      };
      await hooks.issued?.(authority);
      return authority;
    };
  if (start)
    for (const plan of workbench.appliedPlans)
      checked(
        await h.service.startPlan(caller(plan.task.ownerId), {
          taskId: plan.taskId,
          planId: plan.id,
          revision: plan.revision,
          idempotencyKey: randomUUID(),
        }),
      );
  const target = (taskId = 'task') => {
    const plan = h
      .readWorkbench()
      .appliedPlans.filter((plan) => plan.taskId === taskId)
      .at(-1);
    return { taskId, planId: plan.id, revision: plan.revision };
  };
  const query = (ids = ['task']) => ({ spaceId: 'north', plans: ids.map(target) });
  const read = (input = query(), actor = 'chen', issuer = source(actor)) =>
    h.service.taskProgress(caller(actor), input, issuer);
  const submit = async (nodeId = 'work-0', taskId = 'task', text = '人工提交的当前正文') => {
    const locator = { ...target(taskId), nodeId },
      record = h.service.readRunNode(locator);
    return checked(
      await h.service.submit(caller(record.handoff.assignee.id), {
        ...locator,
        expectedVersion: record.command.version,
        idempotencyKey: randomUUID(),
        text,
        links: ['https://example.com/result'],
      }),
    );
  };
  // Explicit node-transition facts, never a claim that an Agent was dispatched.
  const transition = async (nodeId, payload, taskId = 'task') => {
    const record = h.service.readRunNode({ ...target(taskId), nodeId });
    const moved = applyNodeTransitionCommand(record.command, {
      actorId: record.ownerId,
      objectId: nodeId,
      expectedVersion: record.command.version,
      idempotencyKey: randomUUID(),
      payload,
    });
    if (moved.decision.status !== 'applied') throw Error(moved.decision.reason);
    await h.domain.table('nodes').put(nodeRecordKey(record), { ...record, command: moved.state });
  };
  return { ...h, root, hooks, calls, source, target, query, progress: read, submit, transition };
}
