import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { apply as applyExecution, inject as executionInject } from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { hashPassword } from '../dist/identity-session.js';
import { AUTHORITY, bootIdentity, disposeHost } from './member-host.mjs';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

const password = 'member-password-host';

function workflowNode(partial) {
  return {
    description: '',
    assigneeId: 'chen',
    reviewerIds: [],
    reviewRequired: false,
    dependsOn: [],
    skillIds: [],
    mcpIds: [],
    input: '',
    output: '交付说明',
    rationale: '',
    position: { x: 0, y: 0 },
    ...partial,
  };
}

test('a real connection and member cookie run start, report, and review', async () => {
  const { state, task } = fixture();
  state.participants.push(
    {
      id: 'lin',
      name: '林夏',
      kind: 'human',
      role: '复核',
      capabilities: [],
      instructions: '',
      available: true,
    },
    {
      id: 'zhao',
      name: '赵衡',
      kind: 'human',
      role: '同项目',
      capabilities: [],
      instructions: '',
      available: true,
    },
  );
  const workbench = applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'lin', 'zhao'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            workflowNode({
              id: 'design',
              title: '设计',
              reviewerIds: ['lin'],
              reviewRequired: true,
            }),
          ],
        },
      ],
      status: 'ready',
    },
  });
  const applied = workbench.appliedPlans.at(-1);
  const passwordHash = hashPassword(password);
  let host;
  let executionFiber;
  let executionStarted = false;
  try {
    host = await bootIdentity(
      {
        accounts: [
          { id: 'chen', passwordHash },
          { id: 'lin', passwordHash },
          { id: 'zhao', passwordHash },
        ],
        notes: [
          {
            id: 'note',
            spaceId: 'team-north',
            ownerId: 'chen',
            teamMemberIds: ['chen', 'lin'],
            text: 'shared',
          },
          {
            id: 'project-alias',
            spaceId: 'project',
            ownerId: 'zhao',
            teamMemberIds: ['zhao'],
            text: 'same id as the project',
          },
        ],
      },
      'multi-member',
    );
    executionFiber = host.ctx.plugin(
      { inject: [...executionInject], apply: applyExecution },
      {
        readWorkbench: () => workbench,
        projectSpaces: boundedProjectSpaces([{ projectId: 'project', spaceId: 'team-north' }]),
      },
    );
    await executionFiber;
    executionStarted = true;
    const chen = await host.login('chen', password);
    const lin = await host.login('lin', password);
    const zhao = await host.login('zhao', password);
    const owner = host.ownerCookie();
    async function exec(endpoint, payload, memberCookie) {
      const headers = {
        host: AUTHORITY,
        cookie: `${owner}; ${memberCookie}`,
        'content-type': 'application/json',
      };
      const admission = host.ctx.connection.admit({ headers });
      assert.equal(admission.peer.principal.kind, 'owner');
      const request = new Request(`http://${AUTHORITY}/api/zhuma-exec/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'e2e',
          method: `zhuma-exec/${endpoint}`,
          payload,
        }),
      });
      const response = await host.ctx.connection
        .createSharedFetchHandler('/api')
        .fetch(request, admission.peer);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : text };
    }
    const started = await exec(
      'start-plan',
      {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        idempotencyKey: 'start-1',
      },
      chen,
    );
    assert.equal(started.status, 200, JSON.stringify(started));
    assert.equal(started.body.result.ok, true, JSON.stringify(started.body));
    const counts = await exec('inbox-counts', {}, chen);
    assert.equal(counts.body.result.ok, true, JSON.stringify(counts.body));
    assert.equal(typeof counts.body.result.value.deliver, 'number');
    assert.equal(counts.body.result.value.confirm, 0);
    assert.equal(Object.hasOwn(counts.body.result.value, 'items'), false);
    const reported = await exec(
      'report',
      { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
      chen,
    );
    assert.equal(reported.body.result.ok, true, JSON.stringify(reported.body));
    assert.equal(reported.body.result.value.reports.length, 1);
    const submitted = await exec(
      'submit',
      {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        nodeId: 'design',
        expectedVersion: 1,
        idempotencyKey: 'deliver-1',
        text: '登录说明',
      },
      chen,
    );
    assert.equal(submitted.body.result.ok, true, JSON.stringify(submitted.body));
    const node = submitted.body.result.value.node;
    const reviewed = await exec(
      'ballot',
      {
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        nodeId: 'design',
        expectedVersion: node.version,
        idempotencyKey: 'vote-1',
        roundId: node.currentRoundId,
        artifactVersionId: node.artifacts.at(-1).id,
        action: 'approve',
      },
      lin,
    );
    assert.equal(reviewed.body.result.ok, true, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.result.value.disposition, 'applied');
    const beforeAlias = await exec(
      'report',
      { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
      chen,
    );
    assert.equal(beforeAlias.body.result.ok, true, JSON.stringify(beforeAlias.body));
    const aliasBody = {
      taskId: applied.taskId,
      planId: applied.id,
      revision: applied.revision,
    };
    const aliasStart = await exec(
      'start-plan',
      { ...aliasBody, idempotencyKey: 'start-alias' },
      zhao,
    );
    assert.equal(aliasStart.body.result.ok, false, JSON.stringify(aliasStart.body));
    assert.equal(aliasStart.body.result.error.code, 'not-found');
    const aliasReport = await exec('report', aliasBody, zhao);
    assert.equal(aliasReport.body.result.error.code, 'not-found');
    const aliasSubmit = await exec(
      'submit',
      {
        ...aliasBody,
        nodeId: 'design',
        expectedVersion: reviewed.body.result.value.node.version,
        idempotencyKey: 'alias-submit',
        text: '把项目 id 当成空间',
      },
      zhao,
    );
    assert.equal(aliasSubmit.body.result.error.code, 'not-found');
    assert.equal(JSON.stringify(aliasSubmit.body).includes('把项目 id 当成空间'), false);
    const afterAlias = await exec('report', aliasBody, chen);
    assert.deepEqual(afterAlias.body, beforeAlias.body);
    const forged = await exec(
      'report',
      { taskId: applied.taskId, planId: applied.id, revision: applied.revision },
      'zhuma-member=forged',
    );
    assert.equal(forged.status, 401);
    assert.equal(forged.body.ok, false);
    assert.equal(forged.body.error.code, 'unauthenticated');
  } finally {
    if (executionStarted) await executionFiber.dispose();
    await disposeHost(host);
  }
});
