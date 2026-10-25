/** Real C native owner/history/drain/mapping and D-issued phase capability.
 * Synthetic model/member/workspace source, sequential JSON test writes; no formal B issuer/queue. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import {
  boot,
  ScriptedAdapter,
  allHistory,
  NativeWorkError,
  attachExecutionRuns,
  begin,
  applyEvent,
  currentExecutionRun,
  locator,
  memberRequest,
  requestExecutionRunStop,
  stopCommand,
} from './zhuma-execution-run-bundle.ts';

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-run-native-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
function input(row, requestId, text, mode = 'followup') {
  return { requestId, text, mode, selection: currentExecutionRun(row).selection };
}
async function reserveNext(host, runs) {
  const previous = await runs.open();
  const queued = await host.service.send(
    previous.grant,
    input(runs.row, 'old-queue', 'OLD-QUEUED-CONTENT', 'queue'),
  );
  const binding = host.service.open(previous.grant).binding;
  await runs.save(
    applyEvent(runs.row, 'accepted', {
      nativeSessionId: binding.nativeSessionId,
      executorRunId: binding.nativeAgentId,
    }).record,
  );
  await runs.save(requestExecutionRunStop(runs.row, stopCommand(runs.row)).record);
  const stopped = await host.service.stop(previous.grant);
  assert.equal(stopped.status, 'stopped');
  // C's real completed stop is the fixture's bridge fact. The production B
  // receipt hook is intentionally absent, rather than replaced by a fake issuer.
  await runs.save(
    applyEvent(runs.row, 'stopped', { idle: true, flushed: true, resourcesSettled: true }).record,
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

test(
  'D/C integration: actual native cleanup unlocks one reserved segment; only explicit send runs the model',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    const host = await boot(root, new ScriptedAdapter(['NEW-ANSWER']));
    t.onTestFinished(() => host.close());
    const runs = await attachExecutionRuns(host);
    const old = await reserveNext(host, runs);
    const opened = await runs.migrate();
    const cap = opened.grant;
    cap.assertCurrent('prepare');
    assert.throws(() => cap.assertCurrent('migrate'), { code: 'run-migration-pending' });
    assert.equal(cap.signal.aborted, false, 'missing native epoch must retain preparation rights');
    assert.equal(host.adapter.requests.length, 0);
    const prepared = await host.service.prepareMigration(cap);
    assert.equal(prepared.status, 'prepared');
    assert.equal(host.service.migrationDrain(cap.previousScope).basis, 'flushed-and-closed');
    cap.assertCurrent('migrate');
    const moved = await host.service.migrate(cap);
    assert.equal(moved.status, 'migrated');
    assert.equal(moved.previous.nativeSessionId, old.binding.nativeSessionId);
    assert.notEqual(moved.next.nativeSessionId, old.binding.nativeSessionId);
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
    assert.equal(await host.ctx.sessionPersistence.stat(moved.next.nativeSessionId), undefined);
    const replay = await host.service.migrate(cap);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.next.nativeSessionId, moved.next.nativeSessionId);
    const history = await runs.open('read', old.oldLocator);
    assert.ok(
      JSON.stringify(await allHistory(host.service, history.grant)).includes(old.queued.messageId),
    );
    const next = await runs.open();
    await host.service.send(next.grant, input(runs.row, 'new-turn', 'NEW-RUN-CONTENT'));
    await runs.save(
      applyEvent(runs.row, 'accepted', {
        nativeSessionId: moved.next.nativeSessionId,
        executorRunId: moved.next.nativeAgentId,
      }).record,
    );
    assert.equal(cap.signal.aborted, true, 'native admission ends the pending migration pair');
    await host.ctx.agents.get(moved.next.nativeSessionId).whenIdle();
    assert.equal(host.adapter.requests.length, 1);
    assert.equal(JSON.stringify(host.adapter.requests[0]).includes('OLD-QUEUED-CONTENT'), false);
    assert.equal(host.service.open(next.grant).binding.nativeSessionId, moved.next.nativeSessionId);
  },
);

test(
  'D/C readiness adapter: only the exact native not-ready error may preserve preparation rights',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    const host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    const runs = await attachExecutionRuns(host);
    await reserveNext(host, runs);
    const original = host.service.migrationDrain;
    const mappingPath = join(root, 'domains/zhuma_native_work_sessions.json');
    const before = await readFile(mappingPath);
    try {
      for (const code of [
        'not-started',
        'scope-mismatch',
        'binding-state-invalid',
        'unavailable',
        'not-a-native-error',
      ]) {
        host.service.migrationDrain = () => {
          if (code === 'not-a-native-error')
            throw Object.assign(Error('CONTRACT_SOURCE_FAILURE'), {
              code: 'migration-not-ready',
            });
          throw new NativeWorkError(code);
        };
        const opened = await runs.migrate();
        assert.throws(() => opened.grant.assertCurrent('migrate'), {
          code: 'run-authority-denied',
        });
        assert.equal(opened.grant.signal.aborted, true);
      }
    } finally {
      host.service.migrationDrain = original;
    }
    assert.deepEqual(await readFile(mappingPath), before);
    assert.equal(host.adapter.requests.length, 0);
  },
);

test(
  'D/C cold integration: pending cleanup is not a persisted proof; sealing the native service revokes D authority',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    let host = await boot(root, new ScriptedAdapter([]));
    let runs = await attachExecutionRuns(host);
    const old = await reserveNext(host, runs);
    await host.close();
    host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    runs = await attachExecutionRuns(host);
    const opened = await runs.migrate();
    assert.throws(() => opened.grant.assertCurrent('migrate'), { code: 'run-migration-pending' });
    const accesses = [];
    const open = host.ctx.sessionPersistence.open.bind(host.ctx.sessionPersistence);
    host.ctx.sessionPersistence.open = (...args) => {
      accesses.push(args[1]);
      return open(...args);
    };
    const prepared = await host.service.prepareMigration(opened.grant);
    assert.equal(prepared.status, 'prepared');
    assert.deepEqual(accesses, ['write']);
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
    opened.grant.assertCurrent('migrate');
    const mappingPath = join(root, 'domains/zhuma_native_work_sessions.json');
    const before = await readFile(mappingPath);
    const read = await runs.open('read', old.oldLocator);
    assert.equal(
      host.service.open(read.grant).binding.nativeSessionId,
      old.binding.nativeSessionId,
    );
    await host.service.sealInputReads();
    assert.equal(prepared.drain.signal.aborted, true);
    assert.equal(opened.grant.signal.aborted, true);
    await assert.rejects(async () => host.service.migrate(opened.grant), { code: 'cancelled' });
    assert.deepEqual(await readFile(mappingPath), before);
  },
);

test(
  'D/C integration: contract member revocation after real cleanup prevents the native mapping write',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    const host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    const runs = await attachExecutionRuns(host);
    await reserveNext(host, runs);
    const opened = await runs.authorities.openMigration(memberRequest, locator(runs.row));
    const prepared = await host.service.prepareMigration(opened.grant);
    assert.equal(prepared.status, 'prepared');
    opened.grant.assertCurrent('migrate');
    const mappingPath = join(root, 'domains/zhuma_native_work_sessions.json');
    const before = await readFile(mappingPath);
    runs.memberLifetime.abort();
    assert.equal(opened.grant.signal.aborted, true);
    await assert.rejects(async () => host.service.migrate(opened.grant), { code: 'cancelled' });
    assert.deepEqual(await readFile(mappingPath), before);
    assert.equal(host.adapter.requests.length, 0);
  },
);

test(
  'D/C recovery boundary: an unbound middle Run fails closed without inventing a native binding',
  { timeout: 15000 },
  async (t) => {
    const root = await home(t);
    const host = await boot(root, new ScriptedAdapter([]));
    t.onTestFinished(() => host.close());
    const runs = await attachExecutionRuns(host);
    const old = await reserveNext(host, runs);
    assert.equal(currentExecutionRun(runs.row).attempt.id, 'run-2');
    assert.equal(currentExecutionRun(runs.row).attempt.acknowledged, false);
    const cleanup = runs.authorities.cleanupAfterCommit(locator(runs.row));
    runs.memberLifetime.abort();
    cleanup.assertCurrent('failed');
    // No Run2 native call was admitted. Internal cleanup may settle that empty
    // claim, but it cannot create a C mapping for an attempt which never ran.
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
    const opened = await runs.migrate();
    assert.equal(opened.grant.previousScope.runId, 'run-2');
    assert.equal(opened.grant.scope.runId, 'run-3');
    opened.grant.assertCurrent('prepare');
    const historical = await runs.open('read', old.oldLocator);
    const actualBinding = host.service.open(historical.grant).binding;
    assert.equal(actualBinding.scope.runId, 'run-1');
    assert.equal(actualBinding.nativeSessionId, old.binding.nativeSessionId);
    const mappingPath = join(root, 'domains/zhuma_native_work_sessions.json');
    const before = await readFile(mappingPath);
    await assert.rejects(async () => host.service.prepareMigration(opened.grant), {
      code: 'scope-mismatch',
    });
    assert.deepEqual(await readFile(mappingPath), before);
    assert.equal(currentExecutionRun(runs.row).attempt.id, 'run-3');
    assert.equal(currentExecutionRun(runs.row).resources, 'held');
    assert.equal(host.adapter.requests.length, 0);
    // This passing refusal control records a recovery gap. It does not claim
    // that Run3 can proceed or authorize skipping Run2's durable lineage.
  },
);
