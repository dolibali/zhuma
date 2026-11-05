/** Host-only fault classification contracts, not native startup/model proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostRunStartupDiagnostic } from '../dist/host-run-startup-diagnostics.js';
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
