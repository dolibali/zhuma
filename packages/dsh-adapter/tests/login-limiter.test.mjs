import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginFailureTable } from '../dist/login-limiter.js';

test('expired login-failure slots are removed', () => {
  const attempts = createLoginFailureTable();
  const address = '198.51.100.8';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(attempts.reserve(address, 'chen', 1_000), 'allowed');
  }
  assert.equal(attempts.reserve(address, 'chen', 1_000), 'limited');
  assert.equal(attempts.count(address, 'chen', 1_000), 8);
  assert.equal(attempts.count(address, 'chen', 1_000 + 60_000), 0);
  assert.equal(attempts.reserve(address, 'chen', 1_000 + 60_000), 'allowed');
  attempts.clear(address, 'chen');
  assert.equal(attempts.count(address, 'chen', 1_000 + 60_000), 0);
});

test('two hosts do not share login-failure counts', () => {
  const first = createLoginFailureTable();
  const second = createLoginFailureTable();
  const address = '198.51.100.9';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(first.reserve(address, 'chen', 1_000), 'allowed');
  }
  assert.equal(first.reserve(address, 'chen', 1_000), 'limited');
  assert.equal(second.reserve(address, 'chen', 1_000), 'allowed');
  assert.equal(second.count(address, 'chen', 1_000), 1);
});
