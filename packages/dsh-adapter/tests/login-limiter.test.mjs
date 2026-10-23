import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearLoginAttempts,
  loginAttemptCount,
  reserveLoginAttempt,
} from '../dist/login-limiter.js';

test('expired login-failure slots are removed', () => {
  const address = '198.51.100.8';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(reserveLoginAttempt(address, 'chen', 1_000), 'allowed');
  }
  assert.equal(reserveLoginAttempt(address, 'chen', 1_000), 'limited');
  assert.equal(loginAttemptCount(address, 'chen', 1_000), 8);
  assert.equal(loginAttemptCount(address, 'chen', 1_000 + 60_000), 0);
  assert.equal(reserveLoginAttempt(address, 'chen', 1_000 + 60_000), 'allowed');
  clearLoginAttempts(address, 'chen');
  assert.equal(loginAttemptCount(address, 'chen', 1_000 + 60_000), 0);
});
