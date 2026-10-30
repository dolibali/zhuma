/** Error-boundary contracts only: injected peers/builtin process seam, no CLI/model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeArtsAcpAgent } from '../dist/executors/codearts/agent.js';
import { CodeArtsHttpClient, CodeArtsHttpError } from '../dist/executors/codearts/http.js';
import { CodeArtsServerError, startCodeArtsServer } from '../dist/executors/codearts/server.js';
import { codeArtsOpenDiagnostic } from '../dist/executors/codearts/diagnostics.js';
import { CodeArtsStartupFailure } from '../dist/executors/codearts/startup-failure.js';

const bridge = {
  type: 'http',
  name: `dshteam_${'a'.repeat(16)}`,
  url: `http://127.0.0.1:44444/${'a'.repeat(64)}`,
  headers: [],
};
const message = 'CodeArts operation failed; inspect the current session before continuing';
const privateText = 'private-command /private/workspace Authorization: private-token provider-body';

async function directory(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'zhuma-codearts-diagnostic-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('CodeArts trust preflight: bounded independent UTF-8 streams match only the official prefixes', () => {
  const split = new CodeArtsStartupFailure();
  split.write('stdout', Buffer.from('Folder not '));
  split.write('stderr', Buffer.from('trusted:'));
  assert.equal(split.code, undefined, 'different output streams cannot form a template');
  split.write('stdout', Buffer.from('Folder not trusted'));
  assert.equal(split.code, undefined, 'a keyword or partial template cannot classify an error');
  for (const byte of Buffer.from(`\u001b[31m文件夹未被信任: ${privateText}\u001b[0m`))
    split.write('stderr', Uint8Array.of(byte));
  assert.equal(split.code, 'workspace-untrusted');
  assert.equal(JSON.stringify(split).includes(privateText), false);

  const exhausted = new CodeArtsStartupFailure();
  exhausted.write('stdout', Buffer.alloc(64 * 1024, 120));
  exhausted.write('stderr', Buffer.from('Folder not trusted:'));
  assert.equal(exhausted.code, undefined);
  const ready = new CodeArtsStartupFailure();
  ready.seal();
  ready.write('stderr', Buffer.from('Folder not trusted:'));
  assert.equal(ready.code, undefined, 'later server output is not a startup preflight failure');
});

for (const row of [
  { channel: 'stdout', text: `Folder not trusted: ${privateText}`, code: 'workspace-untrusted' },
  { channel: 'stderr', text: `文件夹未被信任: ${privateText}`, code: 'workspace-untrusted' },
  { channel: 'stderr', text: `信任 ${privateText}`, code: 'start-failed' },
]) {
  test(`CodeArts trust preflight: ${row.channel}/${row.code} reaches the unchanged ACP failure and teardown`, async (t) => {
    const cwd = await directory(t);
    let kills = 0,
      starts = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        kills++;
        this.emit('exit', 0);
        return true;
      },
    });
    const spawn = t.mock.method(childProcess, 'spawn', () => {
      starts++;
      queueMicrotask(() => {
        for (const byte of Buffer.from(row.text)) child[row.channel].write(Buffer.from([byte]));
        child.emit('exit', 1);
      });
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => {
      spawn.mock.restore();
      syncBuiltinESMExports();
    });
    t.mock.method(CodeArtsHttpClient.prototype, 'health', () =>
      assert.fail('preflight exit must not reach health'),
    );
    const agent = new CodeArtsAcpAgent({
      command: '/synthetic/codearts',
      signal: new AbortController().signal,
      connection: {
        async sessionUpdate() {
          assert.fail('preflight cannot publish model output');
        },
      },
    });
    t.after(() => agent.dispose());
    await assert.rejects(agent.newSession({ cwd, mcpServers: [bridge] }), (error) => {
      assert.equal(error.code, -32000);
      assert.equal(error.message, message);
      assert.deepEqual(error.data, { codeArts: { stage: 'start', code: row.code } });
      assert.equal(JSON.stringify(error.data).includes(privateText), false);
      return true;
    });
    assert.equal(kills, 0, 'natural exit keeps the original close path');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    await assert.rejects(agent.newSession({ cwd, mcpServers: [bridge] }));
    assert.equal(starts, 1, 'a failed preflight does not retry or grant trust');
  });
}

for (const row of [
  { stage: 'realpath', missing: true },
  { stage: 'policy', invalidPolicy: true },
  { stage: 'start', failure: new CodeArtsServerError('not-installed'), code: 'not-installed' },
  { stage: 'start', failure: Object.assign(new Error(privateText), { code: 'not-installed' }) },
  {
    stage: 'health',
    failure: new CodeArtsServerError(
      'start-failed',
      'health',
      codeArtsOpenDiagnostic('health', 'rejected', 503),
    ),
    code: 'rejected',
    httpStatus: 503,
  },
  {
    stage: 'create-session',
    failure: new CodeArtsHttpError('rejected', 403),
    code: 'rejected',
    httpStatus: 403,
  },
  { stage: 'create-session', failure: new CodeArtsHttpError(privateText, 999) },
  {
    stage: 'resume-session',
    resume: true,
    failure: new CodeArtsHttpError('invalid-session'),
    code: 'invalid-session',
  },
  { stage: 'history', resume: true, failure: new Error(privateText) },
]) {
  test(`CodeArts open diagnostics: ${row.stage}/${row.code ?? 'unknown'} preserves the RPC and cleanup boundary`, async (t) => {
    const cwd = await directory(t);
    let starts = 0,
      closes = 0,
      updates = 0;
    const agent = new CodeArtsAcpAgent({
      command: privateText,
      signal: new AbortController().signal,
      connection: {
        async sessionUpdate() {
          updates++;
        },
      },
      async startServer() {
        starts++;
        if (row.stage === 'start' || row.stage === 'health') throw row.failure;
        return {
          signal: new AbortController().signal,
          client: {
            async createSession() {
              throw row.failure;
            },
            async resumeSession() {
              if (row.stage === 'resume-session') throw row.failure;
              return { id: 'ses_contract' };
            },
            async messages() {
              throw row.failure;
            },
          },
          async close() {
            closes++;
          },
        };
      },
    });
    t.after(() => agent.dispose());
    const params = {
      cwd: row.missing ? join(cwd, 'absent') : cwd,
      mcpServers: [
        row.invalidPolicy
          ? { ...bridge, headers: [{ name: 'private', value: privateText }] }
          : bridge,
      ],
    };
    await assert.rejects(
      row.resume
        ? agent.resumeSession({ ...params, sessionId: 'ses_contract' })
        : agent.newSession(params),
      (error) => {
        assert.equal(error.code, -32000);
        assert.equal(error.message, message);
        assert.deepEqual(error.data, {
          codeArts: {
            stage: row.stage,
            code: row.code ?? 'unknown',
            ...(row.httpStatus ? { httpStatus: row.httpStatus } : {}),
          },
        });
        assert.equal(JSON.stringify(error.data).includes(privateText), false);
        assert.equal(JSON.stringify(error.data).includes(cwd), false);
        return true;
      },
    );
    assert.equal(starts, row.missing || row.invalidPolicy ? 0 : 1);
    assert.equal(
      closes,
      ['create-session', 'resume-session', 'history'].includes(row.stage) ? 1 : 0,
    );
    assert.equal(updates, 0);
    await assert.rejects(agent.newSession({ cwd, mcpServers: [bridge] }));
    assert.equal(
      starts,
      row.missing || row.invalidPolicy ? 0 : 1,
      'failure must retain the original poisoned admission',
    );
  });
}

for (const row of [
  {
    name: 'HTTP health rejection',
    health: async () => {
      throw new CodeArtsHttpError('rejected', 503);
    },
    code: 'rejected',
    httpStatus: 503,
  },
  {
    name: 'unsupported health version',
    health: async () => ({ version: 'unsupported' }),
    code: 'unsupported-version',
  },
  {
    name: 'unknown health exception',
    health: async () => {
      throw new Error(privateText);
    },
    code: 'unknown',
  },
]) {
  test(`CodeArts owned server diagnostics: ${row.name} survives actual failure cleanup`, async (t) => {
    const cwd = await directory(t);
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        kills++;
        this.emit('exit', 0);
        return true;
      },
    });
    const spawn = t.mock.method(childProcess, 'spawn', () => {
      queueMicrotask(() => child.stdout.write('http://127.0.0.1:44444\n'));
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => {
      spawn.mock.restore();
      syncBuiltinESMExports();
    });
    t.mock.method(CodeArtsHttpClient.prototype, 'health', row.health);
    await assert.rejects(
      startCodeArtsServer({
        command: join(cwd, 'synthetic'),
        directory: cwd,
        policy: { processConfig: '{}' },
        signal: new AbortController().signal,
      }),
      (error) => {
        assert.ok(error instanceof CodeArtsServerError);
        assert.equal(
          error.code,
          row.code === 'unsupported-version' ? 'unsupported-version' : 'start-failed',
        );
        assert.deepEqual(error.diagnostic, {
          stage: 'health',
          code: row.code,
          ...(row.httpStatus ? { httpStatus: row.httpStatus } : {}),
        });
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error.diagnostic).includes(privateText), false);
        return true;
      },
    );
    assert.equal(kills, 1);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });
}
