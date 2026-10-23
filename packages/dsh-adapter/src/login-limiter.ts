/**
 * Failed-login counter for one process.
 *
 * The check runs before the password hash. A failure is recorded only after
 * the hash does not match. The same key expires when that key is written
 * again. There is no map-wide sweep.
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

export function loginLimited(req: IncomingMessage, accountId: string): boolean {
  const entry = loginFailures.get(failureKey(loginClientAddress(req), accountId));
  return entry !== undefined && entry.resetAt > Date.now() && entry.count >= LOGIN_FAILURE_LIMIT;
}

export function recordLoginFailure(req: IncomingMessage, accountId: string): void {
  const key = failureKey(loginClientAddress(req), accountId);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (entry === undefined || entry.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(req: IncomingMessage, accountId: string): void {
  loginFailures.delete(failureKey(loginClientAddress(req), accountId));
}
