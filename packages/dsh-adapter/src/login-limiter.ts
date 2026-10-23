/**
 * Failed-login counter for one process.
 *
 * The count is reserved before the password hash so concurrent attempts cannot
 * all pass the check. Expired keys are removed on the next reserve, clear, or
 * count read. A shared source address is a deployment limit; see the identity
 * contract. This module does not change that key.
 */
import type { IncomingMessage } from 'node:http';

const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_FAILURE_WINDOW_MS = 60_000;

interface FailureSlot {
  count: number;
  resetAt: number;
}

const loginFailures = new Map<string, FailureSlot>();

export function loginClientAddress(req: IncomingMessage): string {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

function failureKey(address: string, accountId: string): string {
  return `${address}\0${accountId}`;
}

export function sweepExpiredLoginFailures(now = Date.now()): void {
  for (const [key, slot] of loginFailures) {
    if (slot.resetAt <= now) loginFailures.delete(key);
  }
}

/**
 * Count this attempt before hashing. `limited` means the caller must reject
 * without hashing. A later success must call `clearLoginAttempts`.
 */
export function reserveLoginAttempt(
  address: string,
  accountId: string,
  now = Date.now(),
): 'allowed' | 'limited' {
  sweepExpiredLoginFailures(now);
  const key = failureKey(address, accountId);
  const slot = loginFailures.get(key);
  if (slot === undefined || slot.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
    return 'allowed';
  }
  if (slot.count >= LOGIN_FAILURE_LIMIT) return 'limited';
  slot.count += 1;
  return 'allowed';
}

export function clearLoginAttempts(address: string, accountId: string): void {
  loginFailures.delete(failureKey(address, accountId));
}

/** Failures still inside the window for this address and account. */
export function loginAttemptCount(address: string, accountId: string, now = Date.now()): number {
  sweepExpiredLoginFailures(now);
  const slot = loginFailures.get(failureKey(address, accountId));
  if (slot === undefined || slot.resetAt <= now) return 0;
  return slot.count;
}
