/** Same-disk recovery under actual D/C/native/JSON. Member/workspace/B write hooks
 * and model remain contracts. Explicit modes are run by separate Vitest processes. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'vitest';
import {
  boot,
  ScriptedAdapter,
  attachExecutionRuns,
  reserveNext,
  failUnboundAndRetry,
  allHistory,
} from './zhuma-execution-run-bundle.ts';

async function write(root) {
  const host = await boot(root, new ScriptedAdapter([]));
  try {
    const runs = await attachExecutionRuns(host);
    const old = await reserveNext(host, runs);
    await failUnboundAndRetry(runs);
    const opened = await runs.migrate();
    assert.equal(opened.grant.previousScope.runId, 'run-1');
    const moved = await host.service.migrate(opened.grant);
    assert.equal(moved.status, 'migrated');
    assert.equal(moved.next.scope.runId, 'run-3');
    assert.equal(host.adapter.requests.length, 0);
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(await host.ctx.sessionPersistence.stat(moved.next.nativeSessionId), undefined);
    await writeFile(
      join(root, 'expected-recovery.json'),
      JSON.stringify({
        previousScope: opened.grant.previousScope,
        scope: opened.grant.scope,
        requestId: opened.grant.requestId,
        inputFingerprint: opened.grant.inputFingerprint,
        selection: opened.grant.selection,
        oldLocator: old.oldLocator,
        queuedMessageId: old.queued.messageId,
        oldNativeId: old.binding.nativeSessionId,
        newNativeId: moved.next.nativeSessionId,
      }),
    );
  } finally {
    await host.close();
  }
}

async function read(root) {
  const expected = JSON.parse(await readFile(join(root, 'expected-recovery.json'), 'utf8'));
  const mappingPath = join(root, 'domains/zhuma_native_work_sessions.json');
  const executionPath = join(root, 'domains/zhuma_execution.json');
  const mappingBefore = await readFile(mappingPath);
  const executionBefore = await readFile(executionPath);
  const host = await boot(root, new ScriptedAdapter([]));
  try {
    let lookups = 0;
    const origin = host.service.migrationOrigin.bind(host.service);
    host.service.migrationOrigin = (query) => {
      lookups++;
      return origin(query);
    };
    const runs = await attachExecutionRuns(host);
    // The actual C receipt must refuse a changed key/hash on cold replay. These
    // are explicit source fault injections, after normal D member authorization.
    for (const patch of [
      { requestId: 'wrong-recovery-key' },
      { inputFingerprint: 'b'.repeat(64) },
    ]) {
      host.service.migrationOrigin = (query) => origin({ ...query, ...patch });
      await assert.rejects(runs.migrate(), { code: 'run-authority-denied' });
      assert.deepEqual(await readFile(mappingPath), mappingBefore);
    }
    host.service.migrationOrigin = (query) => {
      lookups++;
      return origin(query);
    };
    const opened = await runs.migrate();
    assert.deepEqual(opened.grant.previousScope, expected.previousScope);
    assert.deepEqual(opened.grant.scope, expected.scope);
    assert.deepEqual(opened.grant.selection, expected.selection);
    assert.equal(opened.grant.requestId, expected.requestId);
    assert.equal(opened.grant.inputFingerprint, expected.inputFingerprint);
    const replay = await host.service.migrate(opened.grant);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.previous.nativeSessionId, expected.oldNativeId);
    assert.equal(replay.next.nativeSessionId, expected.newNativeId);
    assert.equal(lookups, 1, 'C internal queue checks must not reenter the origin getter');
    const row = Object.values(JSON.parse(await readFile(mappingPath, 'utf8')).tables.bindings)[0];
    assert.equal(row.prior.length, 1);
    assert.equal(row.prior[0].binding.scope.runId, 'run-1');
    assert.equal(row.current.scope.runId, 'run-3');
    assert.deepEqual(
      runs.row.nativeExecution.runs.map((run) => run.attempt.id),
      ['run-1', 'run-2', 'run-3'],
    );
    const history = await runs.open('read', expected.oldLocator);
    assert.ok(
      JSON.stringify(await allHistory(host.service, history.grant)).includes(
        expected.queuedMessageId,
      ),
    );
    assert.equal(host.ctx.agents.list().length, 0);
    assert.equal(host.adapter.requests.length, 0);
    assert.equal(await host.ctx.sessionPersistence.stat(expected.newNativeId), undefined);
    assert.deepEqual(await readFile(mappingPath), mappingBefore);
    assert.deepEqual(await readFile(executionPath), executionBefore);
  } finally {
    await host.close();
  }
}

const mode = process.env.ZHUMA_RUN_RECOVERY_MODE;
if (mode !== undefined) {
  test(
    'D/C native recovery retains original origin and reserved ID across an independent process',
    { timeout: 15000 },
    async () => {
      const root = process.env.ZHUMA_RUN_RECOVERY_ROOT;
      if (!root || !['write', 'read'].includes(mode))
        throw Error('Explicit recovery root/mode required');
      await (mode === 'write' ? write(root) : read(root));
    },
  );
} else {
  test(
    'D/C cold recovery uses the committed original pair/key without a new segment or model call',
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'zhuma-origin-recovery-'));
      t.onTestFinished(() => rm(root, { recursive: true, force: true }));
      await write(root);
      await read(root);
    },
  );
}
