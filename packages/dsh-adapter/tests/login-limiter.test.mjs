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

test('one address is limited across account ids', () => {
  const attempts = createLoginFailureTable();
  const address = '198.51.100.10';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(attempts.reserve(address, `missing-${attempt}`, 1_000), 'allowed');
  }
  assert.equal(attempts.reserve(address, 'missing-next', 1_000), 'limited');
  assert.equal(attempts.reserve(address, 'chen', 1_000), 'limited');
  assert.equal(attempts.count(address, 'chen', 1_000), 0);
  attempts.clear(address, 'missing-0');
  assert.equal(attempts.reserve(address, 'chen', 1_000), 'allowed');
  assert.equal(attempts.count(address, 'chen', 1_000), 1);
});

test('a successful login clears the address without clearing another account', () => {
  const attempts = createLoginFailureTable();
  const address = '198.51.100.40';
  for (let attempt = 0; attempt < 7; attempt += 1) {
    assert.equal(attempts.reserve(address, 'chen', 1_000), 'allowed');
  }
  attempts.clear(address, 'zhao');
  assert.equal(attempts.count(address, 'chen', 1_000), 7);
  assert.equal(attempts.reserve(address, 'chen', 1_000), 'allowed');
  assert.equal(attempts.reserve(address, 'chen', 1_000), 'limited');
  assert.equal(attempts.reserve(address, 'lin', 1_000), 'allowed');
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
