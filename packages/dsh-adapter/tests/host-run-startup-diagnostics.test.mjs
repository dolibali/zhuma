/** Host-only fault classification contracts, not native startup/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Context, Logger } from '@deepseek-ai/cordis';
import {
  createHostRunStartupDiagnostic,
  emitHostRunStartupFailure,
  emitHostRunTerminalFailure,
} from '../dist/host-run-startup-diagnostics.js';
import { NativeWorkError } from '../dist/native-work-session-contract.js';
import { ExecutionRunError } from '../dist/execution-run-state.js';

const scope = {
  actorId: 'private-actor',
  spaceId: 'private-space',
  taskId: 'private-task',
  planId: 'private-plan',
  revision: 1,
  nodeId: 'private-node',
  runId: 'private-run',
  generation: 1,
  segmentId: 'private-segment',
};

test('startup sink contract: the actual emitter reaches default Cordis buffer and exporter without raising levels', async () => {
  const ctx = new Context(),
    records = [];
  try {
    const exporter = {
      export(message) {
        records.push(message);
      },
    };
    ctx.logger.exporter(exporter);
    ctx.logger.warn('threshold probe');
    assert.equal(records.length, 0);
    assert.equal(ctx.logger.buffer.length, 0);
    const diagnostic = createHostRunStartupDiagnostic(scope, (failure) =>
      emitHostRunStartupFailure(ctx, failure),
    );
    diagnostic.at('resource-adoption');
    diagnostic.failed(new Error('PRIVATE_MESSAGE /private/path sk-private-token'));
    assert.equal(records.length, 1);
    assert.equal(ctx.logger.buffer.length, 1);
    assert.equal(records[0].type, 'error');
    assert.equal(records[0].level, 0);
    assert.equal(exporter.levels, undefined);
    assert.equal(ctx.logger.buffer[0].args[1], records[0].args[1]);
    assert.equal(records[0].args[1].event, 'zhuma-native-startup-failed');
    assert.equal(records[0].args[1].stage, 'resource-adoption');
    assert.equal(records[0].args[1].code, 'unexpected-error');
    const line = Logger.format(exporter, records[0]);
    assert.match(line, /zhuma-native-startup-failed/u);
    assert.doesNotMatch(line, /PRIVATE|private|sk-/u);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('startup stdout contract: default is silent, exact opt-in writes only one safe JSON line, and a closed pipe preserves the original error', () => {
  const diagnosticModule = new URL('../dist/host-run-startup-diagnostics.js', import.meta.url).href;
  for (const [flag, closed] of [
    [undefined, false],
    ['0', false],
    ['true', false],
    ['1', false],
    ['1', true],
  ]) {
    const script = `
      import assert from 'node:assert/strict';
      import { closeSync } from 'node:fs';
      import { Context } from '@deepseek-ai/cordis';
      import { createHostRunStartupDiagnostic, emitHostRunStartupFailure } from ${JSON.stringify(diagnosticModule)};
      const ctx = new Context();
      const original = new Error('PRIVATE_MESSAGE /private/path sk-private-token');
      const diagnostic = createHostRunStartupDiagnostic(${JSON.stringify(scope)}, (failure) => emitHostRunStartupFailure(ctx, failure));
      diagnostic.at('native-send');
      ${closed ? 'closeSync(1);' : ''}
      try { throw original; }
      catch (error) { diagnostic.failed(error); assert.equal(error, original); }
      diagnostic.failed(new Error('PRIVATE_DUPLICATE'));
      assert.equal(ctx.logger.buffer.length, 1);
      await ctx.fiber.dispose();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../', import.meta.url),
      env: flag === undefined ? {} : { ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT: flag },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (flag !== '1' || closed) assert.equal(result.stdout, '');
    else {
      const lines = result.stdout.trim().split('\n');
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.deepEqual(Object.keys(record).sort(), ['code', 'correlation', 'event', 'stage']);
      assert.equal(record.event, 'zhuma-native-startup-failed');
      assert.equal(record.stage, 'native-send');
      assert.equal(record.code, 'unexpected-error');
      assert.match(record.correlation, /^[a-f0-9]{16}$/u);
      assert.doesNotMatch(result.stdout, /PRIVATE|private|sk-/u);
    }
  }
});

test('startup diagnostic contract: success emits nothing and one failure keeps only fixed stage/code and a scope digest', () => {
  const records = [];
  const successful = createHostRunStartupDiagnostic(scope, (value) => records.push(value));
  successful.at('native-send');
  successful.at('composition-ready');
  successful.at('receipt');
  assert.deepEqual(records, []);
  const failed = createHostRunStartupDiagnostic(scope, (value) => records.push(value));
  failed.at('resource-adoption');
  const error = new NativeWorkError('configuration-mismatch');
  error.message = 'PRIVATE_MESSAGE /private/path sk-private-token';
  error.stack = 'PRIVATE_STACK';
  failed.failed(error);
  failed.at('receipt');
  failed.failed(new Error('PRIVATE_LATE'));
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), ['code', 'correlation', 'event', 'stage']);
  assert.equal(records[0].stage, 'resource-adoption');
  assert.equal(records[0].code, 'configuration-mismatch');
  assert.match(records[0].correlation, /^[a-f0-9]{16}$/u);
  assert.equal(Object.isFrozen(records[0]), true);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private|sk-/u);
});

test('startup diagnostic contract: unknown errors, hostile properties, forged codes and stages never enter logs', () => {
  for (const error of [
    new Error('PRIVATE_MESSAGE'),
    new NativeWorkError('PRIVATE_FORGED_CODE'),
    {
      get code() {
        throw new Error('PRIVATE_GETTER');
      },
      message: 'PRIVATE_BODY',
    },
  ]) {
    const records = [];
    const diagnostic = createHostRunStartupDiagnostic(scope, (value) => records.push(value));
    diagnostic.at('PRIVATE_FORGED_STAGE');
    diagnostic.failed(error);
    assert.equal(records[0].stage, 'authority');
    assert.equal(records[0].code, 'unexpected-error');
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private/u);
  }
});

test('startup diagnostic contract: whitelisted execution/abort failures and distinct segments retain safe correlation', () => {
  const records = [];
  for (const [value, error] of [
    [scope, new ExecutionRunError('run-authority-denied')],
    [
      { ...scope, segmentId: 'another-private-segment' },
      new DOMException('PRIVATE_ABORT', 'AbortError'),
    ],
  ])
    createHostRunStartupDiagnostic(value, (record) => records.push(record)).failed(error);
  assert.equal(records[0].code, 'run-authority-denied');
  assert.equal(records[1].code, 'aborted');
  assert.notEqual(records[0].correlation, records[1].correlation);
});

test('startup diagnostic contract: synchronous/asynchronous logger failures cannot replace the original failure', async () => {
  const original = new NativeWorkError('unavailable');
  for (const emit of [
    () => {
      throw new Error('PRIVATE_LOGGER');
    },
    async () => {
      throw new Error('PRIVATE_LOGGER');
    },
  ]) {
    const diagnostic = createHostRunStartupDiagnostic(scope, emit);
    const operation = async () => {
      try {
        throw original;
      } catch (error) {
        diagnostic.failed(error);
        throw error;
      }
    };
    await assert.rejects(operation(), (error) => error === original);
  }
  await new Promise(setImmediate);
});

function terminalFlag(t, value = '1') {
  const previous = process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT;
  process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT = value;
  t.after(() => {
    if (previous === undefined) delete process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT;
    else process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT = previous;
  });
}
const boundary = (error) => ({ type: 'turn/end', data: { reason: { kind: 'error', error } } });

test('terminal diagnostic contract: the final boundary keeps only a whitelisted code and the original scope correlation', (t) => {
  terminalFlag(t);
  const records = [],
    startup = [];
  createHostRunStartupDiagnostic(scope, (value) => startup.push(value)).failed(new Error());
  emitHostRunTerminalFailure(
    scope,
    {
      events: [
        boundary({ code: 'AUTH' }),
        boundary({ code: 'UNSUPPORTED_REASONING_EFFORT', message: 'PRIVATE_MESSAGE' }),
      ],
    },
    (value) => records.push(value),
  );
  assert.deepEqual(records[0], {
    event: 'zhuma-native-run-failed',
    correlation: startup[0].correlation,
    stage: 'terminal-history',
    code: 'UNSUPPORTED_REASONING_EFFORT',
  });
  assert.equal(Object.isFrozen(records[0]), true);
  emitHostRunTerminalFailure(
    { ...scope, segmentId: 'other-private-segment' },
    { events: [boundary({ code: 'UNKNOWN' })] },
    (value) => records.push(value),
  );
  assert.notEqual(records[1].correlation, records[0].correlation);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private|sk-/u);
});

test('terminal diagnostic contract: getters, inherited values, malformed cuts and unknown codes never expose private data', (t) => {
  terminalFlag(t);
  let touched = 0;
  const poison = () => {
    touched++;
    throw Error('PRIVATE_GETTER');
  };
  const guarded = { code: 'AUTH' };
  for (const name of ['message', 'stack', 'cause', 'toJSON'])
    Object.defineProperty(guarded, name, { get: poison });
  const codeGetter = {};
  Object.defineProperty(codeGetter, 'code', { get: poison });
  const eventGetter = {};
  Object.defineProperty(eventGetter, 'data', { get: poison });
  Object.defineProperty(eventGetter, 'type', { value: 'turn/end' });
  const snapshotGetter = {};
  Object.defineProperty(snapshotGetter, 'events', { get: poison });
  const snapshots = [
    [{ events: [boundary(guarded)] }, 'AUTH'],
    [{ events: [boundary(codeGetter)] }, 'unclassified-error'],
    [{ events: [boundary(Object.create({ code: 'AUTH' }))] }, 'unclassified-error'],
    [{ events: [boundary({ code: 'PRIVATE_FORGED' })] }, 'unclassified-error'],
    [{ events: [eventGetter] }, 'unclassified-error'],
    [snapshotGetter, 'unclassified-error'],
    [{ events: new Proxy([], { getOwnPropertyDescriptor: poison }) }, 'unclassified-error'],
    [
      {
        events: [
          boundary({ code: 'AUTH' }),
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
      },
      'unclassified-error',
    ],
  ];
  for (const [snapshot, code] of snapshots) {
    const records = [];
    emitHostRunTerminalFailure(scope, snapshot, (value) => records.push(value));
    assert.equal(records[0].code, code);
    assert.deepEqual(Object.keys(records[0]).sort(), ['code', 'correlation', 'event', 'stage']);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE|private|sk-/u);
  }
  assert.equal(
    touched,
    1,
    'Only the deliberately throwing Proxy descriptor runs; no value getter is invoked',
  );
});

test('terminal diagnostic contract: exact opt-in is required and sync/async emission failures are contained', async (t) => {
  terminalFlag(t, 'true');
  const snapshot = new Proxy(
    {},
    { getOwnPropertyDescriptor: () => assert.fail('Disabled diagnostics cannot inspect a cut') },
  );
  emitHostRunTerminalFailure(scope, snapshot, () => assert.fail('Nonexact flag cannot emit'));
  process.env.ZHUMA_NATIVE_STARTUP_DIAGNOSTICS_STDOUT = '1';
  for (const emit of [
    () => {
      throw Error('PRIVATE_SINK');
    },
    async () => {
      throw Error('PRIVATE_SINK');
    },
  ])
    assert.doesNotThrow(() => emitHostRunTerminalFailure(scope, { events: [] }, emit));
  await new Promise(setImmediate);
});
