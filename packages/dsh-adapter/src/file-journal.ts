import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

export interface DeskJournal<T> {
  load(): T | null;
  save(value: T): void;
  /**
   * 文件日志没拿到独占锁，或保存前发现令牌已经不是自己的，则为 false。
   * 内存日志省略，调用方视为可写。
   */
  readonly writable?: boolean;
}

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

const heldLocks = new Map<string, string>();
let exitHooked = false;
const barrierPause = new Int32Array(new SharedArrayBuffer(4));

function lockFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.write.lock`);
}

function releaseHeldLocks(): void {
  const held = [...heldLocks.entries()];
  heldLocks.clear();
  for (const [lockPath, token] of held) releaseOne(lockPath, token);
}

/** 先改名再核对令牌。对不上就放回去，避免退出时删掉新持有者的锁。 */
function releaseOne(lockPath: string, token: string): void {
  const temporary = `${lockPath}.${token}.releasing`;
  try {
    renameSync(lockPath, temporary);
  } catch {
    return;
  }
  const current = readLock(temporary);
  if (current !== null && current.token === token) {
    try {
      unlinkSync(temporary);
    } catch {
      // 锁已经不在。
    }
    return;
  }
  try {
    renameSync(temporary, lockPath);
  } catch {
    // 原路径上已经有另一把锁。临时文件不是自己的令牌，不删除那把新锁。
  }
}

function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', releaseHeldLocks);
  // SIGTERM / SIGINT 默认直接结束，不会发出 exit。写锁要在这之前放开。
  process.on('SIGTERM', () => {
    releaseHeldLocks();
    process.exit(143);
  });
  process.on('SIGINT', () => {
    releaseHeldLocks();
    process.exit(130);
  });
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    const pid = parsed.pid;
    if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return null;
    if (typeof parsed.hostname !== 'string' || parsed.hostname.length === 0) return null;
    return {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      pid,
      hostname: parsed.hostname,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

function sameHolder(left: LockRecord, right: LockRecord): boolean {
  if (left.token.length > 0 || right.token.length > 0) return left.token === right.token;
  return (
    left.pid === right.pid && left.hostname === right.hostname && left.startedAt === right.startedAt
  );
}

/**
 * 测试用屏障。未设置环境变量时什么都不做。
 * 到达点写一个文件，然后等到另一个文件出现，用来钉死回收顺序，而不是靠睡眠碰运气。
 */
function reachReclaimBarrier(): void {
  const arrived = process.env.ZHUMA_LOCK_ARRIVED;
  if (arrived) writeFileSync(arrived, String(process.pid));
  const waitFile = process.env.ZHUMA_LOCK_WAIT_FILE;
  if (!waitFile) return;
  const started = Date.now();
  while (!existsSync(waitFile)) {
    if (Date.now() - started > 8000) {
      throw Object.assign(new Error('写锁屏障超时'), { code: 'EBARRIER' });
    }
    Atomics.wait(barrierPause, 0, 0, 5);
  }
}

/** 只有同一台机器上 `process.kill(pid, 0)` 得到 ESRCH，才把持有者当成已经死掉。 */
function holderDead(record: LockRecord): boolean {
  if (record.hostname !== hostname()) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code === 'ESRCH';
  }
}

function restoreRenamed(temporary: string, lockPath: string): void {
  try {
    renameSync(temporary, lockPath);
  } catch {
    // 原路径已经有新锁。不删除它。
  }
}

/**
 * 过期锁先改名到唯一临时文件。rename 是原子的，只有一个进程能拿走这份文件。
 * 再读回，确认仍是刚才那个已死持有者，才丢掉。对不上就放回去。
 */
function reclaimStale(lockPath: string, holder: LockRecord): boolean {
  reachReclaimBarrier();
  const temporary = `${lockPath}.${randomBytes(8).toString('hex')}.reclaim`;
  try {
    renameSync(lockPath, temporary);
  } catch {
    return false;
  }
  const moved = readLock(temporary);
  if (moved === null || !sameHolder(moved, holder) || !holderDead(moved)) {
    restoreRenamed(temporary, lockPath);
    return false;
  }
  try {
    unlinkSync(temporary);
  } catch {
    restoreRenamed(temporary, lockPath);
    return false;
  }
  return true;
}

function acquireLock(lockPath: string): string | null {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  ensureExitHook();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'EEXIST') throw error;
      const holder = readLock(lockPath);
      if (holder !== null && holderDead(holder)) {
        if (!reclaimStale(lockPath, holder)) return null;
        continue;
      }
      return null;
    }
    const token = randomBytes(16).toString('hex');
    try {
      writeSync(
        fd,
        JSON.stringify({
          token,
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
    } finally {
      closeSync(fd);
    }
    heldLocks.set(lockPath, token);
    return token;
  }
  return null;
}

function holdsLock(lockPath: string, token: string): boolean {
  const current = readLock(lockPath);
  return current !== null && current.token === token;
}

/**
 * 数据目录里还有别的活进程的写锁时，不要清它的会话目录。
 * 本进程自己的锁，以及同一台机器上已确认死亡的锁，不挡住清扫。
 * 读不出持有者的锁文件也挡住清扫。
 */
export function foreignWriteLockHeld(dataDir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith('.write.lock')) continue;
    const holder = readLock(path.join(dataDir, name));
    if (holder === null) return true;
    if (holder.pid === process.pid && holder.hostname === hostname()) continue;
    if (holderDead(holder)) continue;
    return true;
  }
  return false;
}

/** 运行时日志。调用方负责把路径放在临时目录，不要提交这份文件。 */
export function createFileJournal<T>(filePath: string): DeskJournal<T> {
  const lockPath = lockFilePath(filePath);
  const token = acquireLock(lockPath);
  const state = { writable: token !== null };
  return {
    get writable() {
      return state.writable;
    },
    load() {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as T;
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT') return null;
        throw error;
      }
    },
    save(value: T) {
      if (token === null || !state.writable || !holdsLock(lockPath, token)) {
        state.writable = false;
        throw Object.assign(new Error('另一个进程正持有这份会话的写权'), { code: 'ELOCKED' });
      }
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value));
      try {
        renameSync(temporary, filePath);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch {
          // 清理失败不掩盖原来的改名错误。
        }
        throw error;
      }
    },
  };
}
