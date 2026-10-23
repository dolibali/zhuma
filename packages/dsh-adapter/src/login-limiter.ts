import type { IncomingMessage } from 'node:http';

/**
 * Failed-login counter for one host.
 *
 * `createLoginFailureTable` returns a table owned by that host. Two hosts in
 * one process do not share counts. The count is reserved before the password
 * hash so concurrent attempts cannot all pass the check. Expired keys are
 * removed on the next reserve, clear, or count read. A shared source address
 * on one host is a deployment limit; see the identity contract. This module
 * does not change that key.
 */
export function loginClientAddress(req: IncomingMessage): string {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_FAILURE_WINDOW_MS = 60_000;

interface FailureSlot {
  count: number;
  resetAt: number;
}

export interface LoginFailureTable {
  reserve(address: string, accountId: string, now?: number): 'allowed' | 'limited';
  clear(address: string, accountId: string): void;
  count(address: string, accountId: string, now?: number): number;
}

export function createLoginFailureTable(): LoginFailureTable {
  const loginFailures = new Map<string, FailureSlot>();

  function failureKey(address: string, accountId: string): string {
    return `${address}\0${accountId}`;
  }

  function sweep(now: number): void {
    for (const [key, slot] of loginFailures) {
      if (slot.resetAt <= now) loginFailures.delete(key);
    }
  }

  return {
    reserve(address, accountId, now = Date.now()) {
      sweep(now);
      const key = failureKey(address, accountId);
      const slot = loginFailures.get(key);
      if (slot === undefined || slot.resetAt <= now) {
        loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
        return 'allowed';
      }
      if (slot.count >= LOGIN_FAILURE_LIMIT) return 'limited';
      slot.count += 1;
      return 'allowed';
    },
    clear(address, accountId) {
      loginFailures.delete(failureKey(address, accountId));
    },
    count(address, accountId, now = Date.now()) {
      sweep(now);
      const slot = loginFailures.get(failureKey(address, accountId));
      if (slot === undefined || slot.resetAt <= now) return 0;
      return slot.count;
    },
  };
}
