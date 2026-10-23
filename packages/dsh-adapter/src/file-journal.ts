import {
  closeSync,
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
  /** 文件日志没拿到独占锁时为 false。内存日志省略，调用方视为可写。 */
  readonly writable?: boolean;
}

interface LockRecord {
  pid: number;
  hostname: string;
  startedAt: string;
}

const heldLocks = new Set<string>();
let exitHooked = false;

function lockFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.write.lock`);
}

function releaseHeldLocks(): void {
  for (const lockPath of heldLocks) {
    try {
      unlinkSync(lockPath);
    } catch {
      // 锁已经不在。
    }
  }
  heldLocks.clear();
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
      pid,
      hostname: parsed.hostname,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
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

function acquireLock(lockPath: string): boolean {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'EEXIST') throw error;
      const holder = readLock(lockPath);
      if (holder !== null && holderDead(holder)) {
        try {
          unlinkSync(lockPath);
        } catch {
          return false;
        }
        continue;
      }
      return false;
    }
    try {
      writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
    } finally {
      closeSync(fd);
    }
    heldLocks.add(lockPath);
    ensureExitHook();
    return true;
  }
  return false;
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
  const writable = acquireLock(lockFilePath(filePath));
  return {
    writable,
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
      if (!writable) {
        throw Object.assign(new Error('另一个进程正持有这份会话的写权'), { code: 'ELOCKED' });
      }
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(value));
      renameSync(temporary, filePath);
    },
  };
}
