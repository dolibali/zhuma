/** Real published DSH HTTP/Connection/JSON with synthetic member identities.
 * Legacy rows come from production castBallot/settleReview, not fabricated receipts.
 * This is a bounded protocol migration check, not a previous-release GUI/model test. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { castBallot, settleReview, nodeRecordKey } from '@zhuma/agent-core';
import { apply as applyExecution, inject as executionInject } from '../dist/execution-plugin.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { request, projectCommand, taskInput, node } from './member-workbench-fixture.mjs';

test(
  'legacy review HTTP/JSON: closed/reopened old receipts replay unchanged while altered requests and invalid citations cannot write',
  { timeout: 30000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'zhuma-legacy-review-'));
    let host, execution, domain;
    const disk = () => readFile(join(home, 'storages', 'zhuma_execution.json'), 'utf8');
    const ok = (response) => {
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.result?.ok, true, JSON.stringify(response.json));
      return response.json.result.value;
    };
    const mount = async () => {
      const open = host.ctx.storageDomain.open.bind(host.ctx.storageDomain);
      host.ctx.storageDomain.open = async (spec) => {
        const result = await open(spec);
        if (spec.name === 'zhuma_execution') domain = result;
        return result;
      };
      execution = host.ctx.plugin(
        { inject: [...executionInject], apply: applyExecution },
        {
          readWorkbench: () => host.service.snapshot(),
          projectSpaces: boundedProjectSpaces([{ projectId: 'project-one', spaceId: 'north' }]),
        },
      );
      await execution;
    };
    const exec = (endpoint, payload, cookie) =>
      host.post(
        `/api/zhuma-exec/${endpoint}`,
        {
          type: 'client-request',
          rpcId: 'legacy-migration',
          method: `zhuma-exec/${endpoint}`,
          payload,
        },
        cookie,
      );
    try {
      host = await startMemberWorkbenchHost(home);
      let ann = await host.login('ann');
      ok(await host.rpc('command', request(0, projectCommand()), ann));
      const task = taskInput({
        participantIds: ['ann', 'bob', 'cy'],
        workflows: [
          {
            id: 'root',
            name: 'Legacy review',
            parentNodeId: null,
            nodes: ['comment-node', 'return-node'].map((id) =>
              node(id, { reviewerIds: ['bob', 'cy'], reviewRequired: true }),
            ),
          },
        ],
      });
      ok(await host.rpc('command', request(1, { type: 'create-task', task }), ann));
      ok(await host.rpc('command', request(2, { type: 'confirm-task', taskId: task.id }), ann));
      const applied = host.service.snapshot().appliedPlans[0];
      const locate = (nodeId) => ({
        taskId: applied.taskId,
        planId: applied.id,
        revision: applied.revision,
        nodeId,
      });
      await mount();
      ok(
        await exec(
          'start-plan',
          {
            taskId: applied.taskId,
            planId: applied.id,
            revision: applied.revision,
            idempotencyKey: 'start-legacy',
          },
          ann,
        ),
      );
      const commands = [];
      for (const nodeId of ['comment-node', 'return-node']) {
        const active = ok(await exec('inbox', {}, ann)).nodes.find((n) => n.nodeId === nodeId);
        const delivered = ok(
          await exec(
            'submit',
            {
              ...locate(nodeId),
              expectedVersion: active.version,
              idempotencyKey: `deliver-${nodeId}`,
              text: `Fixed body for ${nodeId}`,
            },
            ann,
          ),
        );
        const command = {
          ...locate(nodeId),
          expectedVersion: delivered.node.version,
          idempotencyKey: `legacy-${nodeId}`,
          roundId: delivered.node.currentRoundId,
          artifactVersionId: delivered.node.artifacts[0].id,
          action: nodeId === 'return-node' ? 'request-changes' : 'comment',
          comment: `Original legacy ${nodeId}`,
        };
        let record = domain.table('nodes').get(nodeRecordKey(command));
        const old = castBallot({
          record,
          actorId: 'bob',
          idempotencyKey: command.idempotencyKey,
          expectedVersion: command.expectedVersion,
          ballot: {
            reviewerId: 'bob',
            roundId: command.roundId,
            artifactVersionId: command.artifactVersionId,
            action: command.action,
            comment: command.comment,
          },
          comments: record.comments,
        });
        assert.equal(old.ok, true);
        record = old.record;
        if (command.action === 'request-changes') {
          const settled = settleReview({
            record,
            actorId: 'bob',
            idempotencyKey: `settle:${command.roundId}`,
            expectedVersion: record.command.version,
            roundId: command.roundId,
            artifactVersionId: command.artifactVersionId,
          });
          assert.equal(settled.ok, true);
          record = settled.record;
          assert.equal(record.command.status, 'needs-revision');
        }
        await domain.table('nodes').put(nodeRecordKey(command), record);
        commands.push(command);
      }
      const stored = await disk();
      await execution.dispose();
      execution = undefined;
      await host.close();
      host = undefined;
      host = await startMemberWorkbenchHost(home);
      await mount();
      assert.equal(await disk(), stored, 'cold open does not migrate receipts or ballots');
      ann = await host.login('ann');
      const bob = await host.login('bob'),
        cy = await host.login('cy');
      const [comment, returned] = commands;
      const later = ok(
        await exec(
          'ballot',
          {
            ...comment,
            idempotencyKey: 'upgraded-comment',
            comment: 'Current other reviewer note',
          },
          cy,
        ),
      );
      const cited = later.node.comments.find((c) => c.authorId === 'cy');
      assert.ok(cited);
      const before = await disk();
      for (const command of commands) {
        const replay = ok(await exec('ballot', command, bob));
        assert.equal(replay.disposition, 'replayed');
        assert.equal(
          await disk(),
          before,
          'exact old retry writes no new binding, receipt, ballot or settlement',
        );
      }
      for (const [cookie, patch] of [
        [bob, { comment: 'Changed body' }],
        [cy, {}],
        [bob, { roundId: returned.roundId }],
        [bob, { artifactVersionId: returned.artifactVersionId }],
        [bob, { unresolvedCommentIds: [cited.id] }],
      ]) {
        const rejected = await exec('ballot', { ...comment, ...patch }, cookie);
        assert.equal(rejected.json.result?.ok, false);
        assert.equal(rejected.json.result.error.code, 'idempotency-mismatch');
        assert.equal(await disk(), before);
      }
      const invalid = await exec(
        'ballot',
        {
          ...comment,
          idempotencyKey: 'invalid-current-citation',
          action: 'request-changes',
          comment: 'Substantive return text',
          unresolvedCommentIds: ['does-not-exist'],
        },
        bob,
      );
      assert.equal(invalid.json.result?.ok, false);
      assert.equal(invalid.json.result.error.code, 'comment-not-unresolved');
      assert.equal(await disk(), before);
      const valid = ok(
        await exec(
          'ballot',
          {
            ...comment,
            idempotencyKey: 'valid-current-citation',
            action: 'request-changes',
            comment: undefined,
            unresolvedCommentIds: [cited.id],
          },
          bob,
        ),
      );
      assert.equal(valid.node.status, 'needs-revision');
      const afterReturn = await disk();
      await host.directory.revokeMembership('north', 'bob');
      const revoked = await exec('ballot', returned, bob);
      assert.equal(revoked.json.result?.ok, false);
      assert.equal(revoked.json.result.error.code, 'not-found');
      assert.equal(await disk(), afterReturn);
    } finally {
      await execution?.dispose();
      await host?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
