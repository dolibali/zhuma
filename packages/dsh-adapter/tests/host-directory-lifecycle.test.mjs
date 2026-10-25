import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostDirectoryLifecycle } from '../dist/host-directory-lifecycle.js';

// Host publication contracts only; C separately proves the real directory close producer.
function directory() {
  const lifetime = new AbortController();
  return {
    lifetime,
    signal: lifetime.signal,
    spaces: () => [],
    space: () => undefined,
    isMember: () => false,
    spacesForMember: () => [],
    spaceForProject: async () => ({ ok: false, reason: 'unknown' }),
    createSpace: async () => {},
    grantMembership: async () => {},
    revokeMembership: async () => {},
    assignProjectSpace: async () => {},
    close: async () => {},
  };
}

test('Host publication contract: one stable binding preserves the original directory and its live read side', () => {
  const handle = directory();
  const lifecycle = createHostDirectoryLifecycle(() => handle);
  lifecycle.publish(handle);
  const binding = lifecycle.currentDirectoryBinding();
  assert.equal(binding.directory, handle);
  assert.equal(lifecycle.currentDirectory(), handle);
  assert.equal(lifecycle.currentDirectoryBinding(), binding);
  assert.equal(lifecycle.currentDirectoryBinding().signal, binding.signal);
  assert.equal(binding.isCurrent(), true);
  handle.isMember = (space, account) => space === 'team' && account === 'member';
  assert.equal(binding.directory.isMember('team', 'member'), true);
  assert.equal(binding.signal.aborted, false);
});

test('Host publication contract: raw directory lifetime aborts the binding synchronously', () => {
  const handle = directory();
  const lifecycle = createHostDirectoryLifecycle(() => handle);
  lifecycle.publish(handle);
  const binding = lifecycle.currentDirectoryBinding();
  handle.lifetime.abort();
  assert.equal(binding.signal.aborted, true);
  assert.equal(binding.isCurrent(), false);
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
  assert.equal(lifecycle.currentDirectory(), undefined);
});

test('Host publication contract: replacing and republishing the same handle fences ABA cleanup', () => {
  const first = directory();
  const second = directory();
  let registered = first;
  const lifecycle = createHostDirectoryLifecycle(() => registered);
  const oldDispose = lifecycle.publish(first);
  const oldBinding = lifecycle.currentDirectoryBinding();
  registered = second;
  const secondDispose = lifecycle.publish(second);
  const secondBinding = lifecycle.currentDirectoryBinding();
  oldDispose();
  assert.equal(oldBinding.signal.aborted, true);
  assert.equal(secondBinding.isCurrent(), true);
  const latestDispose = lifecycle.publish(second);
  const latestBinding = lifecycle.currentDirectoryBinding();
  secondDispose();
  secondDispose();
  assert.equal(secondBinding.signal.aborted, true);
  assert.notEqual(latestBinding, secondBinding);
  assert.equal(latestBinding.isCurrent(), true);
  assert.equal(latestBinding.signal.aborted, false);
  latestDispose();
  assert.equal(latestBinding.signal.aborted, true);
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
});

test('Host publication contract: close revokes before a held drain and never admits a late publication', async () => {
  const handle = directory();
  const lifecycle = createHostDirectoryLifecycle(() => handle);
  lifecycle.publish(handle);
  const binding = lifecycle.currentDirectoryBinding();
  const drain = Promise.withResolvers();
  let drained = false;
  async function beforeClose() {
    lifecycle.close();
    await drain.promise;
    drained = true;
  }
  const closing = beforeClose();
  assert.equal(drained, false);
  assert.equal(binding.signal.aborted, true);
  assert.equal(binding.isCurrent(), false);
  lifecycle.close();
  lifecycle.publish(handle)();
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
  drain.resolve();
  await closing;
  assert.equal(drained, true);
  assert.equal(binding.signal.aborted, true);
});

test('Host publication contract: unregistered or already-closed producers cannot become bindings', () => {
  const handle = directory();
  let registered;
  const lifecycle = createHostDirectoryLifecycle(() => registered);
  lifecycle.publish(handle);
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
  registered = handle;
  lifecycle.publish(handle);
  const binding = lifecycle.currentDirectoryBinding();
  registered = undefined;
  assert.equal(binding.isCurrent(), false);
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
  handle.lifetime.abort();
  registered = handle;
  lifecycle.publish(handle);
  assert.equal(lifecycle.currentDirectoryBinding(), undefined);
});

test('Host publication contract: a newer publication from an abort listener wins over its older caller', () => {
  const first = directory();
  const middle = directory();
  const latest = directory();
  let registered = first;
  const lifecycle = createHostDirectoryLifecycle(() => registered);
  lifecycle.publish(first);
  const oldBinding = lifecycle.currentDirectoryBinding();
  oldBinding.signal.addEventListener('abort', () => {
    registered = latest;
    lifecycle.publish(latest);
  });
  registered = middle;
  lifecycle.publish(middle)();
  assert.equal(oldBinding.signal.aborted, true);
  assert.equal(lifecycle.currentDirectory(), latest);
  assert.equal(lifecycle.currentDirectoryBinding().isCurrent(), true);
});

test('Host publication contract: same handle reentry preserves the newer binding through stale cleanup', () => {
  const handle = directory();
  const lifecycle = createHostDirectoryLifecycle(() => handle);
  lifecycle.publish(handle);
  const oldBinding = lifecycle.currentDirectoryBinding();
  let latestBinding;
  oldBinding.signal.addEventListener(
    'abort',
    () => {
      lifecycle.publish(handle);
      latestBinding = lifecycle.currentDirectoryBinding();
    },
    { once: true },
  );

  const staleDispose = lifecycle.publish(handle);
  assert.ok(latestBinding);
  assert.notEqual(latestBinding, oldBinding);
  assert.equal(oldBinding.signal.aborted, true);
  assert.equal(lifecycle.currentDirectoryBinding(), latestBinding);
  assert.equal(latestBinding.isCurrent(), true);
  staleDispose();
  assert.equal(lifecycle.currentDirectoryBinding(), latestBinding);
  assert.equal(latestBinding.isCurrent(), true);
  assert.equal(latestBinding.signal.aborted, false);
});
