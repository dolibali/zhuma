/** D authority/state + real DSH JSON. Member/workspace issuance and serialized B hooks
 * remain contracts; these tests do not mount the formal ExecutionService. */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ExecutionRunAuthorities } from '../dist/execution-run-authority.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import {
  executionRunGlobalSchema,
  enableExecutionRunWriter,
} from '../dist/execution-run-protocol.js';
import { begin, records, locator, applyEvent, stopCommand } from './execution-run-fixture.mjs';
import { currentExecutionRun, requestExecutionRunStop } from '../dist/execution-run-state.js';

export { boot, ScriptedAdapter, allHistory } from './native-work-session-fixture.mjs';
export { NativeWorkError } from '../dist/native-work-session-contract.js';
export {
  currentExecutionRun,
  executionRunScope,
  readExecutionRunState,
} from '../dist/execution-run-state.js';
export { begin, applyEvent, locator, stopCommand } from './execution-run-fixture.mjs';
export { requestExecutionRunStop } from '../dist/execution-run-state.js';

export const memberRequest = { headers: { cookie: 'contract-member-chen' } };

export async function attachExecutionRuns(host) {
  const domain = await host.ctx.storageDomain.open({
    name: 'zhuma_execution',
    version: 1,
    global: { schema: executionRunGlobalSchema, initial: { schemaVersion: 1 } },
    tables: { nodes: { valueSchema: z.unknown() }, plans: { valueSchema: z.unknown() } },
  });
  const nodes = domain.table('nodes');
  if (!nodes.get('native-control')) {
    await enableExecutionRunWriter(
      () => domain.global.get(),
      (value) => domain.global.set(value),
      [],
    );
    await nodes.put('native-control', begin(records()[0]).record);
  }
  let memberLifetime = new AbortController();
  let taskAllowed = true;
  const sourceLifetime = new AbortController();
  const source = {
    signal: sourceLifetime.signal,
    writerState: () => domain.global.get(),
    async memberLease(request) {
      assert.equal(request, memberRequest);
      return {
        memberId: 'chen',
        expiresAt: Date.now() + 60_000,
        signal: memberLifetime.signal,
        assertCurrent(spaceId) {
          assert.equal(memberLifetime.signal.aborted, false);
          assert.equal(spaceId, 'north');
        },
        release() {},
      };
    },
    readNode: () => nodes.get('native-control'),
    assertNodeAccess(memberId, spaceId) {
      assert.equal(taskAllowed, true);
      assert.equal(memberId, 'chen');
      assert.equal(spaceId, 'north');
    },
    assertWorkspace(memberId, spaceId, workspace, access, configurationId) {
      assert.equal(memberId, 'chen');
      assert.equal(spaceId, 'north');
      assert.deepEqual(workspace, { kind: 'text-only' });
      assert.equal(access, 'read');
      assert.equal(configurationId, 'configuration-1');
    },
    onChange(check) {
      return host.ctx.on(
        'domain/changed',
        (change) => {
          if (change.domain === 'zhuma_execution') check();
        },
        { global: true },
      );
    },
    migrationOrigin(query) {
      return host.service.migrationOrigin(query);
    },
    migrationDrain(previousScope) {
      try {
        return host.service.migrationDrain(previousScope);
      } catch (error) {
        // C's explicit not-ready result maps to D's optional proof. Never synthesize
        // a proof from persisted settled, and do not hide other native failures.
        if (error instanceof NativeWorkError && error.code === 'migration-not-ready')
          return undefined;
        throw error;
      }
    },
  };
  const authorities = new ExecutionRunAuthorities(source);
  host.ctx.effect(() => async () => {
    sourceLifetime.abort();
    await authorities.close();
    await domain.close();
  });
  return {
    authorities,
    get memberLifetime() {
      return memberLifetime;
    },
    renewContractMember() {
      assert.equal(memberLifetime.signal.aborted, true);
      memberLifetime = new AbortController();
    },
    setContractTaskAccess(allowed) {
      taskAllowed = allowed;
    },
    get row() {
      return nodes.get('native-control');
    },
    async save(row) {
      // Deliberately sequential test writes; not a second production Run queue.
      await nodes.put('native-control', row);
    },
    open(mode = 'drive', target = locator(nodes.get('native-control'))) {
      return authorities.open(memberRequest, target, mode);
    },
    migrate() {
      return authorities.openMigration(memberRequest, locator(nodes.get('native-control')));
    },
  };
}

export async function reserveNext(host, runs) {
  const previous = await runs.open();
  const queued = await host.service.send(previous.grant, {
    requestId: 'old-queue',
    text: 'OLD-QUEUED-CONTENT',
    mode: 'queue',
    selection: currentExecutionRun(runs.row).selection,
  });
  const binding = host.service.open(previous.grant).binding;
  await runs.save(
    applyEvent(runs.row, 'accepted', {
      nativeSessionId: binding.nativeSessionId,
      executorRunId: binding.nativeAgentId,
    }).record,
  );
  await runs.save(requestExecutionRunStop(runs.row, stopCommand(runs.row)).record);
  assert.equal((await host.service.stop(previous.grant)).status, 'stopped');
  // Actual C stop is this fixture's bridge fact, not a real B receipt issuer.
  await runs.save(
    applyEvent(runs.row, 'stopped', {
      idle: true,
      flushed: true,
      resourcesSettled: true,
    }).record,
  );
  const oldLocator = locator(runs.row);
  await runs.save(
    begin(runs.row, {
      mode: 'restart',
      requestId: 'restart-2',
      newRunId: 'run-2',
      newSegmentId: 'segment-2',
    }).record,
  );
  assert.equal(previous.grant.signal.aborted, true);
  return { binding, oldLocator, queued };
}

export async function failUnboundAndRetry(runs) {
  assert.equal(currentExecutionRun(runs.row).attempt.id, 'run-2');
  assert.equal(currentExecutionRun(runs.row).attempt.acknowledged, false);
  const cleanup = runs.authorities.cleanupAfterCommit(locator(runs.row));
  runs.memberLifetime.abort();
  cleanup.assertCurrent('failed');
  // Run2 never called C. Settling an empty claim cannot fabricate a C binding.
  await runs.save(applyEvent(runs.row, 'failed', { resourcesSettled: true }).record);
  runs.renewContractMember();
  await runs.save(
    begin(runs.row, {
      mode: 'retry',
      requestId: 'retry-3',
      newRunId: 'run-3',
      newSegmentId: 'segment-3',
    }).record,
  );
}
