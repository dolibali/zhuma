import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import {
  requireNativeInboxRetention,
  NativeInboxRetentionUnsupportedError,
} from '../dist/index.js';

test('retention capability contract rejects unknown/false support before any agent operation', () => {
  for (const lifecycleCapabilities of [
    undefined,
    null,
    {},
    { retainPendingInboxOnDispose: false },
    { retainPendingInboxOnDispose: 'true' },
  ]) {
    let calls = 0;
    const registry = {
      lifecycleCapabilities,
      create() {
        ++calls;
      },
      resume() {
        ++calls;
      },
    };
    assert.throws(
      () => requireNativeInboxRetention(registry),
      NativeInboxRetentionUnsupportedError,
    );
    assert.equal(calls, 0);
  }
});

test('retention capability contract closes a missing or changing factory without revealing its error', () => {
  const registry = {
    get lifecycleCapabilities() {
      throw new Error('private factory details');
    },
  };
  assert.throws(
    () => requireNativeInboxRetention(registry),
    (error) =>
      error.code === 'native-inbox-retention-unsupported' &&
      !error.message.includes('private factory'),
  );
});

test('retention capability contract returns the same caller-bound registry, without starting work', () => {
  let calls = 0;
  const registry = {
    lifecycleCapabilities: Object.freeze({ retainPendingInboxOnDispose: true }),
    create() {
      ++calls;
    },
    resume() {
      ++calls;
    },
  };
  assert.equal(requireNativeInboxRetention(registry), registry);
  assert.equal(calls, 0);
});

test('the unpatched published SDK cannot be mistaken for retention support', () => {
  const sdk = createRequire(new URL('../package.json', import.meta.url))(
    '@deepseek-ai/dsh-agent/package.json',
  );
  assert.equal(sdk.version, '0.2.1-rc.4');
  // Actual public SDK class, not a fixture supplying a capability result.
  assert.throws(
    () => requireNativeInboxRetention(Object.create(AgentRegistry.prototype)),
    NativeInboxRetentionUnsupportedError,
  );
});
