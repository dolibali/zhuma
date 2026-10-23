import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
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
  /**
   * 死进程留下回收互斥时，写出要删除的那个文件的完整路径。
   * 没有这层互斥时省略。
   */
  readonly refusal?: string;
}

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

interface AcquireResult {
  token: string | null;
  refusal?: string;
}

const heldLocks = new Map<string, string>();
let exitHooked = false;
const barrierPause = new Int32Array(new SharedArrayBuffer(4));

function lockFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.write.lock`);
}

function reclaimMutexPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

/** 死进程留下的互斥不做第二层回收。信息里是要删除的完整路径。 */
function abandonedMutexMessage(mutexPath: string): string {
  return `回收互斥文件还在，不会自动删除。确认没有进程正在回收之后，删除 ${mutexPath}`;
}

function releaseHeldLocks(): void {
  const held = [...heldLocks.entries()];
  heldLocks.clear();
  for (const [lockPath, token] of held) releaseOne(lockPath, token);
}

/**
 * 只读锁文件。令牌仍是自己的才删除。不改名，避免把别人的活锁挪走后再覆盖回去。
 */
function releaseOne(lockPath: string, token: string): void {
  const current = readLock(lockPath);
  if (current !== null && current.token === token) {
    try {
      unlinkSync(lockPath);
    } catch {
      // 锁已经不在。
    }
    return;
  }
  reachBarrier('ZHUMA_LOCK_RELEASE_ARRIVED', 'ZHUMA_LOCK_RELEASE_WAIT');
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

function parseLockRecord(raw: string): LockRecord | null {
  const parsed = JSON.parse(raw) as Partial<LockRecord>;
  const pid = parsed.pid;
  if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return null;
  if (typeof parsed.hostname !== 'string' || parsed.hostname.length === 0) return null;
  return {
    token: typeof parsed.token === 'string' ? parsed.token : '',
    pid,
    hostname: parsed.hostname,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
  };
}

function readLock(lockPath: string): LockRecord | null {
  try {
    return parseLockRecord(readFileSync(lockPath, 'utf8'));
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
 * 到达点写一个文件，然后等到另一个文件出现，用来钉死顺序，而不是靠睡眠碰运气。
 */
function reachBarrier(arrivedKey: string, waitKey: string): void {
  const arrived = process.env[arrivedKey];
  if (arrived) writeFileSync(arrived, String(process.pid));
  const waitFile = process.env[waitKey];
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

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

/** 文件系统不支持硬链接时，改成带路径的只读，不要把进程打崩。 */
function hardlinkRefusal(targetPath: string, error: unknown): string | null {
  const code = errorCode(error);
  if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') return null;
  return `这个目录不能用硬链接保存写锁，本次改为只读。${targetPath}`;
}

/**
 * 互斥文件整段挂上，已存在就失败，不会覆盖。
 * 读得出活进程则让开。确认存在和读内容之间文件消失，就继续抢锁，不要求删除已经不在的路径。
 * 死进程、读不出或内容损坏时保持只读，并给出要删除的路径。
 */
function mutexBlock(lockPath: string): AcquireResult | null {
  const mutexPath = reclaimMutexPath(lockPath);
  if (!existsSync(mutexPath)) return null;
  reachBarrier('ZHUMA_LOCK_MUTEX_READ_ARRIVED', 'ZHUMA_LOCK_MUTEX_READ_WAIT');
  let holder: LockRecord | null;
  try {
    holder = parseLockRecord(readFileSync(mutexPath, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    return { token: null, refusal: abandonedMutexMessage(mutexPath) };
  }
  if (holder !== null && !holderDead(holder)) return { token: null };
  return { token: null, refusal: abandonedMutexMessage(mutexPath) };
}

/**
 * 记录先写进同目录临时文件并同步，再硬链接到目标路径。
 * 目标要么还不存在，要么一次出现完整内容。已存在则 EEXIST，不覆盖。
 * 读者不会看到空文件或半截 JSON。
 */
function publishRecord(
  targetPath: string,
  token: string,
  barrier?: { readonly arrived: string; readonly wait: string },
): void {
  const temporary = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const payload = JSON.stringify({
    token,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  });
  const fd = openSync(temporary, 'wx');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件已经不在。
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    reachBarrier('ZHUMA_LOCK_PUBLISH_ARRIVED', 'ZHUMA_LOCK_PUBLISH_WAIT');
    if (barrier) reachBarrier(barrier.arrived, barrier.wait);
    linkSync(temporary, targetPath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件已经不在。链接错误仍向外抛。
    }
  }
}

/** 互斥只在令牌仍是自己的时候删除。不改名。 */
function releaseMutex(mutexPath: string, token: string): void {
  const current = readLock(mutexPath);
  if (current === null || current.token !== token) return;
  try {
    unlinkSync(mutexPath);
  } catch {
    // 互斥已经不在。
  }
}

/**
 * 先独占 `<lock>.reclaim`，再读锁。确认仍是同一个已死持有者后才删除并挂上新锁。
 * 活锁留在原地，不改名。互斥和新锁都整段发布，不会先露出空文件。
 */
function reclaimStale(lockPath: string, holder: LockRecord): AcquireResult {
  reachBarrier('ZHUMA_LOCK_ARRIVED', 'ZHUMA_LOCK_WAIT_FILE');
  const blocked = mutexBlock(lockPath);
  if (blocked) return blocked;
  const mutexPath = reclaimMutexPath(lockPath);
  const mutexToken = randomBytes(16).toString('hex');
  try {
    publishRecord(mutexPath, mutexToken, {
      arrived: 'ZHUMA_LOCK_RECLAIM_ARRIVED',
      wait: 'ZHUMA_LOCK_RECLAIM_WAIT',
    });
  } catch (error) {
    const refusal = hardlinkRefusal(mutexPath, error);
    if (refusal !== null) return { token: null, refusal };
    if (errorCode(error) !== 'EEXIST') throw error;
    return mutexBlock(lockPath) ?? { token: null };
  }
  try {
    const current = readLock(lockPath);
    if (current === null || !sameHolder(current, holder) || !holderDead(current)) {
      reachBarrier('ZHUMA_LOCK_GAP_ARRIVED', 'ZHUMA_LOCK_GAP_WAIT');
      return { token: null };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      return { token: null };
    }
    const lockToken = randomBytes(16).toString('hex');
    try {
      publishRecord(lockPath, lockToken, {
        arrived: 'ZHUMA_LOCK_RELOCK_ARRIVED',
        wait: 'ZHUMA_LOCK_RELOCK_WAIT',
      });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return { token: null };
      const refusal = hardlinkRefusal(lockPath, error);
      if (refusal !== null) return { token: null, refusal };
      if (error instanceof Error && !error.message.includes(lockPath)) {
        error.message = `${error.message} ${lockPath}`;
      }
      throw error;
    }
    heldLocks.set(lockPath, lockToken);
    return { token: lockToken };
  } finally {
    releaseMutex(mutexPath, mutexToken);
  }
}

function acquireLock(lockPath: string): AcquireResult {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  ensureExitHook();
  const blocked = mutexBlock(lockPath);
  if (blocked) return blocked;
  try {
    const token = randomBytes(16).toString('hex');
    publishRecord(lockPath, token);
    heldLocks.set(lockPath, token);
    return { token };
  } catch (error) {
    const refusal = hardlinkRefusal(lockPath, error);
    if (refusal !== null) return { token: null, refusal };
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const holder = readLock(lockPath);
  if (holder !== null && holderDead(holder)) return reclaimStale(lockPath, holder);
  return { token: null };
}

/** 锁文件不在不是自己的。活锁不会被挪走，缺失就是写权已经丢了。 */
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
  const acquired = acquireLock(lockPath);
  const token = acquired.token;
  const state = { writable: token !== null };
  return {
    get writable() {
      return state.writable;
    },
    ...(acquired.refusal ? { refusal: acquired.refusal } : {}),
    load() {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as T;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    },
    save(value: T) {
      // 核对通过之后才写会话文件。这段空隙不再加锁。活锁不会被挪走，
      // 所以只有持有者已经死亡，别的进程才可能补上新锁；死亡的进程不会把这次保存写完。
      if (acquired.refusal || token === null || !state.writable || !holdsLock(lockPath, token)) {
        state.writable = false;
        throw Object.assign(new Error(acquired.refusal ?? '另一个进程正持有这份会话的写权'), {
          code: 'ELOCKED',
        });
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
