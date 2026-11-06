/** Task-detail return contract. No browser, Host, or model call. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  registerCatalogReturn,
  selectRepeatedWorkbenchPanel,
} from '../dist/workbench/catalog-return.js';
import {
  resolveLeaveAcceptance,
  resolveLeaveGesture,
} from '../dist/workbench/useLeaveConfirmation.js';

const workbench = {
  target: 'zhuma-workbench',
  active: 'zhuma-workbench',
  workbenchId: 'zhuma-workbench',
};

test('a mounted leave gesture confirms or leaves and does not depend on a caller fence', () => {
  assert.equal(resolveLeaveGesture({ mounted: true, superseded: false, dirty: true }), 'confirm');
  assert.equal(resolveLeaveGesture({ mounted: true, superseded: false, dirty: false }), 'leave');
  assert.equal(resolveLeaveGesture({ mounted: false, superseded: false, dirty: true }), 'ignore');
  assert.equal(resolveLeaveGesture({ mounted: true, superseded: true, dirty: true }), 'ignore');
  assert.equal(resolveLeaveAcceptance({ mounted: true }), 'leave');
  assert.equal(resolveLeaveAcceptance({ mounted: false }), 'ignore');
});

test('reselecting the open team workbench defers to the task detail instead of completing immediately', () => {
  let pending;
  const stop = registerCatalogReturn((_signal, proceed) => {
    pending = proceed;
  });
  try {
    let proceeded = 0;
    const signal = new AbortController().signal;
    assert.equal(
      selectRepeatedWorkbenchPanel({
        ...workbench,
        signal,
        proceed() {
          proceeded++;
        },
      }),
      true,
    );
    assert.equal(proceeded, 0);
    pending();
    assert.equal(proceeded, 1);
    assert.equal(
      selectRepeatedWorkbenchPanel({
        target: 'zhuma-my-work',
        active: 'zhuma-workbench',
        workbenchId: 'zhuma-workbench',
        signal,
        proceed() {
          proceeded++;
        },
      }),
      false,
    );
    assert.equal(proceeded, 1);
  } finally {
    stop();
  }
});

test('with no open detail, reselecting the team workbench still completes', () => {
  let proceeded = 0;
  assert.equal(
    selectRepeatedWorkbenchPanel({
      ...workbench,
      signal: new AbortController().signal,
      proceed() {
        proceeded++;
      },
    }),
    true,
  );
  assert.equal(proceeded, 1);
});

test('a superseded reselect does not ask the detail to leave', () => {
  let asked = 0;
  const stop = registerCatalogReturn(() => {
    asked++;
  });
  try {
    const signal = AbortSignal.abort();
    let proceeded = 0;
    assert.equal(
      selectRepeatedWorkbenchPanel({
        ...workbench,
        signal,
        proceed() {
          proceeded++;
        },
      }),
      true,
    );
    assert.equal(asked, 0);
    assert.equal(proceeded, 1);
  } finally {
    stop();
  }
});
