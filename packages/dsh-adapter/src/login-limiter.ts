import type { IncomingMessage } from 'node:http';

/**
 * Login attempt counter for one host.
 *
 * `createLoginFailureTable` returns a table owned by that host. Two hosts in
 * one process do not share counts. Each reserve counts once for the source
 * address and once for that address plus account id. Either counter stops at
 * 8 attempts in 60 seconds, including ids that are not accounts. The reserve
 * happens before the password hash. A limited reserve does not add another
 * count. Expired keys are removed on the next reserve, clear, or count read.
 * `clear` drops the address key and that account's key. Another account's
 * counter on the same address stays, so one successful login does not reset
 * a different account that already failed. A shared source address on one
 * host therefore locks every login from that address until it is cleared;
 * see the identity contract.
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

  function addressKey(address: string): string {
    return `addr\0${address}`;
  }

  function accountKey(address: string, accountId: string): string {
    return `acct\0${address}\0${accountId}`;
  }

  function sweep(now: number): void {
    for (const [key, slot] of loginFailures) {
      if (slot.resetAt <= now) loginFailures.delete(key);
    }
  }

  function isLimited(key: string): boolean {
    const slot = loginFailures.get(key);
    return slot !== undefined && slot.count >= LOGIN_FAILURE_LIMIT;
  }

  function bump(key: string, now: number): void {
    const slot = loginFailures.get(key);
    if (slot === undefined) {
      loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
      return;
    }
    slot.count += 1;
  }

  return {
    reserve(address, accountId, now = Date.now()) {
      sweep(now);
      const forAddress = addressKey(address);
      const forAccount = accountKey(address, accountId);
      if (isLimited(forAddress) || isLimited(forAccount)) return 'limited';
      bump(forAddress, now);
      bump(forAccount, now);
      return 'allowed';
    },
    clear(address, accountId) {
      loginFailures.delete(addressKey(address));
      loginFailures.delete(accountKey(address, accountId));
    },
    count(address, accountId, now = Date.now()) {
      sweep(now);
      const slot = loginFailures.get(accountKey(address, accountId));
      if (slot === undefined || slot.resetAt <= now) return 0;
      return slot.count;
    },
  };
}
