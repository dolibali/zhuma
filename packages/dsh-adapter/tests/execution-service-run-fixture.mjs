/** Real Cordis plugin/fiber + product plugin/service + published DSH JSON metadata. Identity, workspace,
 * configuration and native event producers below are explicit contract fixtures.
 * No real login, native driver, attachment bytes or model is exercised here.
 */
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { applyWorkbenchCommand } from '@zhuma/agent-core';
import { apply } from '../dist/execution-plugin.js';
import { currentExecutionRun } from '../dist/execution-run-state.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { fixture } from '../../../tests/fixtures/workbench.mjs';
import { command, event, stable } from './execution-run-fixture.mjs';

export { event, stable };
export const caller = (memberId = 'chen') => ({
  member: { ok: true, memberId, spaceIds: ['north'] },
});
export function checked(result) {
  assert.equal(result.ok, true, result.ok ? '' : result.error.code);
  return result.value;
}
export function refused(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

function confirmed() {
  const { state, task, node } = fixture();
  return applyWorkbenchCommand(state, {
    type: 'save-task',
    task: {
      ...task,
      participantIds: ['chen', 'outside', 'qa'],
      workflows: [
        {
          ...task.workflows[0],
          nodes: [
            { ...node, id: 'produce', reviewerIds: ['outside'] },
            { ...node, id: 'parallel', reviewerIds: [], reviewRequired: false },
            {
              ...node,
              id: 'consume',
              dependsOn: ['produce'],
              reviewerIds: [],
              reviewRequired: false,
            },
          ],
        },
      ],
      status: 'ready',
    },
  });
}

export async function open(
  root,
  {
    seed = true,
    mount = true,
    beforePublish,
    prepareDomain,
    startupFailure,
    closeState = { calls: 0, closed: false, errors: [] },
  } = {},
) {
  const ctx = new Context();
  const fibers = [];
  const counters = { global: 0, nodes: 0, plans: 0 };
  const faults = { global: false, node: false, configuration: false, workspace: false };
  const assertionResults = {};
  const source = new AbortController();
  const member = new AbortController();
  const changes = new Set();
  const request = Object.freeze({ headers: {} });
  const members = new Map([[request, 'chen']]);
  let workbench = confirmed();
  const plan = workbench.appliedPlans.at(-1);
  let service;
  let authorities;
  let domain;
  let executionFiber;
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root }],
    [Domain, { backend: 'json' }],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const close = async () => {
    await executionFiber?.dispose();
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose();
  };
  try {
    executionFiber = ctx.plugin({
      apply: async (fiberCtx) => {
        await apply(
          {
            root: ctx.root,
            effect: (callback) =>
              fiberCtx.effect(() => {
                const stop = callback();
                return async () => {
                  try {
                    await stop?.();
                  } catch (error) {
                    closeState.errors.push(error);
                    throw error;
                  }
                };
              }),
            connection: { fetch: { register: () => () => {} } },
            storageDomain: {
              async open(spec) {
                domain = await ctx.storageDomain.open(spec);
                await prepareDomain?.(domain);
                let nodeLists = 0;
                return {
                  close: async () => {
                    closeState.calls++;
                    if (faults.close) throw Error('CONTRACT_DOMAIN_CLOSE_FAILURE');
                    await domain.close();
                    closeState.closed = true;
                  },
                  global: {
                    get: () => domain.global.get(),
                    async set(next) {
                      if (faults.global) throw Error('PRIVATE_GLOBAL_WRITE_FAILURE');
                      await domain.global.set(next);
                      counters.global++;
                    },
                  },
                  table(name) {
                    const table = domain.table(name);
                    return {
                      get: (key) => table.get(key),
                      entries: () => {
                        if (name === 'nodes' && ++nodeLists === 2 && startupFailure === 'reconcile')
                          throw Error('CONTRACT_RECONCILE_FAILURE');
                        return table.entries();
                      },
                      async put(key, value) {
                        if (name === 'nodes' && faults.node)
                          throw Error('PRIVATE_NODE_WRITE_FAILURE');
                        await table.put(key, value);
                        counters[name]++;
                      },
                    };
                  },
                };
              },
            },
          },
          {
            readWorkbench: () => workbench,
            projectSpaces: boundedProjectSpaces([{ projectId: 'project', spaceId: 'north' }]),
            publishRunService(value) {
              service = value;
              return beforePublish?.(value);
            },
          },
        );
      },
    });
    await executionFiber;
    const prior = [...domain.table('nodes').entries()]
      .map(([, node]) => node)
      .find((node) => node.nodeId === 'produce');
    const locate = (nodeId = 'produce') => ({
      taskId: prior?.taskId ?? plan.taskId,
      planId: prior?.planId ?? plan.id,
      revision: prior?.revision ?? plan.revision,
      nodeId,
    });
    const read = (nodeId) => service.readRunNode(locate(nodeId));
    const begin = (patch = {}, nodeId = 'produce') => {
      const { actorId: _actor, ...input } = command(read(nodeId), patch);
      return { ...locate(nodeId), ...input };
    };
    if (seed)
      checked(
        await service.startPlan(caller(), {
          taskId: plan.taskId,
          planId: plan.id,
          revision: plan.revision,
          idempotencyKey: 'start',
        }),
      );
    if (mount)
      authorities = service.installRunHost({
        signal: source.signal,
        async memberLease(original) {
          const memberId = members.get(original);
          if (!memberId) throw Error('PRIVATE_SESSION_REFUSAL');
          let released = false;
          return {
            memberId,
            expiresAt: Date.now() + 60_000,
            signal: member.signal,
            assertCurrent(spaceId) {
              if (released || member.signal.aborted || spaceId !== 'north')
                throw Error('PRIVATE_SESSION_REFUSAL');
            },
            release() {
              released = true;
              if (faults.release) throw Error('CONTRACT_LEASE_RELEASE_FAILURE');
            },
          };
        },
        assertProjectSpace(projectId, spaceId) {
          if (source.signal.aborted || projectId !== 'project' || spaceId !== 'north')
            throw Error('PRIVATE_SPACE_REFUSAL');
          return assertionResults.project?.();
        },
        assertConfiguration(_member, _space, _node, input) {
          if (faults.configuration || input.selection.configurationId !== 'configuration-1')
            throw Error('PRIVATE_CONFIGURATION_REFUSAL');
          return assertionResults.configuration?.();
        },
        assertWorkspace(_member, _space, _workspace, _access, configurationId) {
          if (faults.workspace || source.signal.aborted || configurationId !== 'configuration-1')
            throw Error('PRIVATE_WORKSPACE_REFUSAL');
          return assertionResults.workspace?.();
        },
        onChange(callback) {
          changes.add(callback);
          return () => changes.delete(callback);
        },
      });
    return {
      service,
      authorities,
      domain,
      request,
      members,
      member,
      source,
      counters,
      faults,
      assertionResults,
      locate,
      read,
      begin,
      close,
      closeState,
      disposeExecution: () => executionFiber.dispose(),
      resetCounts() {
        counters.global = counters.nodes = counters.plans = 0;
      },
      runLocator(nodeId) {
        return { ...locate(nodeId), runId: currentExecutionRun(read(nodeId)).attempt.id };
      },
      setWorkbench(next) {
        workbench = next(workbench);
        for (const change of changes) change();
      },
      async native(kind, authority, patch = {}, nodeId = 'produce') {
        return service.recordRunEvent(locate(nodeId), event(read(nodeId), kind, patch), authority);
      },
      human(nodeId, key) {
        return {
          ...locate(nodeId),
          expectedVersion: read(nodeId).command.version,
          idempotencyKey: key,
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
