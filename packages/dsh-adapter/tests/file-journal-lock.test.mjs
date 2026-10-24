import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync as makeScratch,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratchDirs = [];
function mkdtempSync(prefix) {
  const dir = makeScratch(prefix);
  scratchDirs.push(dir);
  return dir;
}
function discardScratch(dir) {
  spawnSync('chmod', ['-R', 'u+rwx', dir], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
}
test.after(() => {
  for (const dir of scratchDirs) discardScratch(dir);
});

// 回归：屏障留在回收确认和释放的空隙。改回先把锁改名再核对、释放时把锁改走后无条件删除、
// 不再理会死进程留下的互斥文件、保存把缺失的锁当成仍持有，然后重跑。已改回跑过，六则失败：
// 同时回收时确认空隙里活锁不在；正常退出后新锁文件不在；
// 过期观察碰上活锁时 twoWritersSavedSuccessfully 为 true；非持有者释放时第三人 saved 为 true；
// 死进程留下的互斥没有拦住，writable 为 true；锁文件不在时 saved 为 true。
// 锁文件还在、只是令牌被换掉的那则仍然得到 ELOCKED。

const adapter = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js'),
).href;

function wait(file, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 8000) {
        clearInterval(timer);
        reject(new Error(label));
      }
    }, 10);
  });
}

function spawnJournal(source, env, preload) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('ZHUMA_LOCK_')) delete childEnv[key];
  }
  Object.assign(childEnv, env);
  const args = preload === undefined ? [] : ['--import', preload];
  args.push('--input-type=module', '-e', source);
  const child = spawn(process.execPath, args, {
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
  return { child, exited };
}

async function deadPid() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await once(dead, 'exit');
    try {
      process.kill(dead.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return dead.pid;
    }
  }
  throw new Error('没有找到已确认死亡的 pid');
}

function staleLock(file, pid, token = '') {
  const record = {
    pid,
    hostname: hostname(),
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  if (token) record.token = token;
  writeFileSync(`${file}.write.lock`, JSON.stringify(record));
}

function pauseSource() {
  return `
    function pause(file) {
      const started = Date.now();
      while (!existsSync(file)) {
        if (Date.now() - started > 8000) process.exit(3);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  `;
}

test('契约：两个进程同时回收同一把过期锁时只有一个能写', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-race-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const arrived = path.join(directory, 'arrived');
  const signal = path.join(directory, 'leader-holding');
  const gapArrived = path.join(directory, 'gap-arrived');
  const gapWait = path.join(directory, 'gap-wait');
  const followerDone = path.join(directory, 'follower-done');
  const leaderResult = path.join(directory, 'leader.json');
  const followerResult = path.join(directory, 'follower.json');
  staleLock(file, await deadPid(), 'dead-token');

  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const file = ${JSON.stringify(file)};
    const lockPath = ${JSON.stringify(lockPath)};
    const role = process.env.ZHUMA_LOCK_ROLE;
    const journal = createFileJournal(file);
    if (process.env.ZHUMA_LOCK_SIGNAL) {
      const token = journal.writable === true ? JSON.parse(readFileSync(lockPath, 'utf8')).token : '';
      writeFileSync(process.env.ZHUMA_LOCK_SIGNAL, token);
      pause(process.env.ZHUMA_LOCK_FOLLOWER_DONE);
    }
    let code = '';
    let saved = false;
    try {
      journal.save({ role });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
    }
    if (process.env.ZHUMA_LOCK_FOLLOWER_DONE && role === 'follower') {
      writeFileSync(process.env.ZHUMA_LOCK_FOLLOWER_DONE, 'done');
    }
    writeFileSync(process.env.ZHUMA_LOCK_RESULT, JSON.stringify({
      writable: journal.writable === true,
      saved,
      code,
      body: existsSync(file) ? readFileSync(file, 'utf8') : '',
    }));
  `;
  const follower = spawnJournal(source, {
    ZHUMA_LOCK_ROLE: 'follower',
    ZHUMA_LOCK_ARRIVED: arrived,
    ZHUMA_LOCK_WAIT_FILE: signal,
    ZHUMA_LOCK_GAP_ARRIVED: gapArrived,
    ZHUMA_LOCK_GAP_WAIT: gapWait,
    ZHUMA_LOCK_FOLLOWER_DONE: followerDone,
    ZHUMA_LOCK_RESULT: followerResult,
  });
  try {
    await wait(arrived, '跟随者没有停在回收前');
    const leader = spawnJournal(source, {
      ZHUMA_LOCK_ROLE: 'leader',
      ZHUMA_LOCK_SIGNAL: signal,
      ZHUMA_LOCK_FOLLOWER_DONE: followerDone,
      ZHUMA_LOCK_RESULT: leaderResult,
    });
    await wait(gapArrived, '跟随者没有停在确认活锁的空隙');
    assert.equal(existsSync(lockPath), true, '确认期间活锁被挪走了');
    const token = readFileSync(signal, 'utf8');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, token);
    writeFileSync(gapWait, 'go');
    const [leaderExit, followerExit] = await Promise.all([leader.exited, follower.exited]);
    assert.equal(leaderExit.code, 0, leaderExit.stderr);
    assert.equal(followerExit.code, 0, followerExit.stderr);
    const leaderOut = JSON.parse(readFileSync(leaderResult, 'utf8'));
    const followerOut = JSON.parse(readFileSync(followerResult, 'utf8'));
    assert.equal(leaderOut.writable, true);
    assert.equal(leaderOut.saved, true);
    assert.equal(JSON.parse(leaderOut.body).role, 'leader');
    assert.equal(followerOut.writable, false);
    assert.equal(followerOut.saved, false);
    assert.equal(followerOut.code, 'ELOCKED');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).role, 'leader');
  } finally {
    if (!existsSync(signal)) writeFileSync(signal, 'missing');
    if (!existsSync(gapWait)) writeFileSync(gapWait, 'go');
    if (!existsSync(followerDone)) writeFileSync(followerDone, 'done');
  }
});

test('契约：旧持有者退出不会删掉新持有者的写锁', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-release-'));
  const cases = [
    { name: 'exit', exitFile: path.join(directory, 'please-exit') },
    { name: 'term', exitFile: '' },
  ];
  for (const item of cases) {
    const file = path.join(directory, `${item.name}.json`);
    const ready = path.join(directory, `${item.name}.ready`);
    const source = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { createFileJournal } from ${JSON.stringify(adapter)};
      const journal = createFileJournal(${JSON.stringify(file)});
      if (journal.writable !== true) process.exit(2);
      journal.save({ held: true });
      writeFileSync(${JSON.stringify(ready)}, 'held');
      const exitFile = process.env.ZHUMA_LOCK_EXIT_FILE;
      if (exitFile) {
        const started = Date.now();
        while (!existsSync(exitFile)) {
          if (Date.now() - started > 8000) process.exit(3);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        process.exit(0);
      }
      setInterval(() => {}, 1000);
    `;
    const child = spawnJournal(
      source,
      item.exitFile ? { ZHUMA_LOCK_EXIT_FILE: item.exitFile } : {},
    );
    await wait(ready, `${item.name} 没有拿到写锁`);
    const lockPath = `${file}.write.lock`;
    const replaced = {
      token: `taken-${item.name}`,
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-10-23T00:00:00.000Z',
    };
    writeFileSync(lockPath, JSON.stringify(replaced));
    if (item.exitFile) writeFileSync(item.exitFile, 'go');
    else child.child.kill('SIGTERM');
    const outcome = await child.exited;
    assert.equal(existsSync(lockPath), true, outcome.stderr);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, replaced.token);
  }
});

test('契约：写锁被接过后再次保存得到 ELOCKED 并变成只读', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-taken-'));
  const file = path.join(directory, 'session.json');
  const ready = path.join(directory, 'ready');
  const go = path.join(directory, 'go');
  const result = path.join(directory, 'result.json');
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const file = ${JSON.stringify(file)};
    const journal = createFileJournal(file);
    journal.save({ first: 1 });
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    pause(${JSON.stringify(go)});
    const codes = [];
    for (const body of [{ stolen: true }, { again: true }]) {
      try {
        journal.save(body);
        codes.push('saved');
      } catch (error) {
        codes.push(error && error.code ? String(error.code) : 'throw');
      }
    }
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({
      codes,
      writable: journal.writable === true,
      body: readFileSync(file, 'utf8'),
    }));
  `;
  const child = spawnJournal(source, {});
  await wait(ready, '子进程没有完成第一次保存');
  writeFileSync(
    `${file}.write.lock`,
    JSON.stringify({
      token: 'taken-over',
      pid: process.pid,
      hostname: hostname(),
      startedAt: '2026-10-23T00:00:00.000Z',
    }),
  );
  writeFileSync(go, 'go');
  const outcome = await child.exited;
  assert.equal(outcome.code, 0, outcome.stderr);
  const reported = JSON.parse(readFileSync(result, 'utf8'));
  assert.deepEqual(reported.codes, ['ELOCKED', 'ELOCKED']);
  assert.equal(reported.writable, false);
  assert.deepEqual(JSON.parse(reported.body), { first: 1 });
});

test('契约：过期观察碰上活锁时，空隙中的第三人不能和持有者一起写成功', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-live-gap-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const arrived = path.join(directory, 'arrived');
  const holding = path.join(directory, 'holding');
  const gapArrived = path.join(directory, 'gap-arrived');
  const gapWait = path.join(directory, 'gap-wait');
  const saveWait = path.join(directory, 'save-wait');
  const results = {
    A: path.join(directory, 'a.json'),
    B: path.join(directory, 'b.json'),
    C: path.join(directory, 'c.json'),
  };
  staleLock(file, await deadPid(), 'dead-token');
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const file = ${JSON.stringify(file)};
    const lockPath = ${JSON.stringify(lockPath)};
    const role = process.env.ZHUMA_LOCK_ROLE;
    const journal = createFileJournal(file);
    let token = '';
    if (process.env.ZHUMA_LOCK_SIGNAL && journal.writable === true) {
      token = JSON.parse(readFileSync(lockPath, 'utf8')).token;
      writeFileSync(process.env.ZHUMA_LOCK_SIGNAL, token);
      pause(process.env.ZHUMA_LOCK_SAVE_WAIT);
    }
    let code = '';
    let saved = false;
    try {
      journal.save({ role });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
    }
    writeFileSync(process.env.ZHUMA_LOCK_RESULT, JSON.stringify({
      role,
      token,
      writable: journal.writable === true,
      saved,
      code,
    }));
  `;
  const reclaimer = spawnJournal(source, {
    ZHUMA_LOCK_ROLE: 'B',
    ZHUMA_LOCK_ARRIVED: arrived,
    ZHUMA_LOCK_WAIT_FILE: holding,
    ZHUMA_LOCK_GAP_ARRIVED: gapArrived,
    ZHUMA_LOCK_GAP_WAIT: gapWait,
    ZHUMA_LOCK_RESULT: results.B,
  });
  try {
    await wait(arrived, '回收方没有停在过期观察之后');
    const holder = spawnJournal(source, {
      ZHUMA_LOCK_ROLE: 'A',
      ZHUMA_LOCK_SIGNAL: holding,
      ZHUMA_LOCK_SAVE_WAIT: saveWait,
      ZHUMA_LOCK_RESULT: results.A,
    });
    await wait(gapArrived, '回收方没有停在活锁确认之后');
    const arriver = spawnJournal(source, {
      ZHUMA_LOCK_ROLE: 'C',
      ZHUMA_LOCK_RESULT: results.C,
    });
    const arriverExit = await arriver.exited;
    assert.equal(arriverExit.code, 0, arriverExit.stderr);
    writeFileSync(gapWait, 'go');
    const reclaimerExit = await reclaimer.exited;
    assert.equal(reclaimerExit.code, 0, reclaimerExit.stderr);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, readFileSync(holding, 'utf8'));
    writeFileSync(saveWait, 'go');
    const holderExit = await holder.exited;
    assert.equal(holderExit.code, 0, holderExit.stderr);
    const holderOut = JSON.parse(readFileSync(results.A, 'utf8'));
    const reclaimerOut = JSON.parse(readFileSync(results.B, 'utf8'));
    const arriverOut = JSON.parse(readFileSync(results.C, 'utf8'));
    const twoWritersSavedSuccessfully = holderOut.saved === true && arriverOut.saved === true;
    assert.equal(twoWritersSavedSuccessfully, false);
    assert.equal(holderOut.saved, true);
    assert.equal(holderOut.writable, true);
    assert.equal(reclaimerOut.saved, false);
    assert.equal(reclaimerOut.writable, false);
    assert.equal(reclaimerOut.code, 'ELOCKED');
    assert.equal(arriverOut.saved, false);
    assert.equal(arriverOut.writable, false);
    assert.equal(arriverOut.code, 'ELOCKED');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).role, 'A');
  } finally {
    if (!existsSync(gapWait)) writeFileSync(gapWait, 'go');
    if (!existsSync(saveWait)) writeFileSync(saveWait, 'go');
    if (!existsSync(holding)) writeFileSync(holding, 'missing');
  }
});

test('契约：非持有者释放时新锁不会被删掉或覆盖', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-release-gap-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const ready = path.join(directory, 'ready');
  const releaseGo = path.join(directory, 'release-go');
  const releaseArrived = path.join(directory, 'release-arrived');
  const releaseWait = path.join(directory, 'release-wait');
  const holderResult = path.join(directory, 'holder.json');
  const arriverResult = path.join(directory, 'arriver.json');
  const replaced = {
    token: 'new-holder',
    pid: process.pid,
    hostname: hostname(),
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  const holderSource = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const journal = createFileJournal(${JSON.stringify(file)});
    if (journal.writable !== true) process.exit(2);
    journal.save({ role: 'A' });
    writeFileSync(${JSON.stringify(ready)}, 'held');
    pause(${JSON.stringify(releaseGo)});
    writeFileSync(${JSON.stringify(holderResult)}, JSON.stringify({ saved: true }));
    process.exit(0);
  `;
  const arriverSource = `
    import { writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    const journal = createFileJournal(${JSON.stringify(file)});
    let code = '';
    let saved = false;
    try {
      journal.save({ role: 'C' });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
    }
    writeFileSync(${JSON.stringify(arriverResult)}, JSON.stringify({
      writable: journal.writable === true,
      saved,
      code,
    }));
  `;
  const holder = spawnJournal(holderSource, {
    ZHUMA_LOCK_RELEASE_ARRIVED: releaseArrived,
    ZHUMA_LOCK_RELEASE_WAIT: releaseWait,
  });
  try {
    await wait(ready, '旧持有者没有拿到写锁');
    writeFileSync(lockPath, JSON.stringify(replaced));
    writeFileSync(releaseGo, 'go');
    await wait(releaseArrived, '旧持有者没有停在释放非自己的锁之前');
    const arriver = spawnJournal(arriverSource, {});
    const arriverExit = await arriver.exited;
    assert.equal(arriverExit.code, 0, arriverExit.stderr);
    writeFileSync(releaseWait, 'go');
    const holderExit = await holder.exited;
    assert.equal(holderExit.code, 0, holderExit.stderr);
    const arriverOut = JSON.parse(readFileSync(arriverResult, 'utf8'));
    assert.equal(arriverOut.saved, false);
    assert.equal(arriverOut.writable, false);
    assert.equal(arriverOut.code, 'ELOCKED');
    assert.equal(existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, replaced.token);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).role, 'A');
  } finally {
    if (!existsSync(releaseGo)) writeFileSync(releaseGo, 'go');
    if (!existsSync(releaseWait)) writeFileSync(releaseWait, 'go');
  }
});

test('契约：死进程留下的回收互斥保持只读并指出要删除的文件', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-mutex-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const mutexPath = `${lockPath}.reclaim`;
  const result = path.join(directory, 'result.json');
  const pid = await deadPid();
  const stale = {
    token: 'dead-lock',
    pid,
    hostname: hostname(),
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  const mutex = {
    token: 'dead-mutex',
    pid,
    hostname: hostname(),
    startedAt: '2026-10-23T00:00:00.000Z',
  };
  writeFileSync(lockPath, JSON.stringify(stale));
  writeFileSync(mutexPath, JSON.stringify(mutex));
  const source = `
    import { writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    const journal = createFileJournal(${JSON.stringify(file)});
    let code = '';
    let message = '';
    let saved = false;
    try {
      journal.save({ role: 'intruder' });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
      message = error && error.message ? String(error.message) : '';
    }
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({
      writable: journal.writable === true,
      refusal: journal.refusal || '',
      saved,
      code,
      message,
    }));
  `;
  const child = spawnJournal(source, {});
  const outcome = await child.exited;
  assert.equal(outcome.code, 0, outcome.stderr);
  const reported = JSON.parse(readFileSync(result, 'utf8'));
  assert.equal(reported.writable, false);
  assert.equal(reported.saved, false);
  assert.equal(reported.code, 'ELOCKED');
  assert.equal(
    reported.refusal,
    `回收互斥文件还在，不会自动删除。确认没有进程正在回收之后，删除 ${mutexPath}`,
  );
  assert.equal(reported.message, reported.refusal);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), stale);
  assert.deepEqual(JSON.parse(readFileSync(mutexPath, 'utf8')), mutex);
  assert.equal(existsSync(file), false);
});

test('契约：锁文件不在时保存得到 ELOCKED 并变成只读', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-missing-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const ready = path.join(directory, 'ready');
  const go = path.join(directory, 'go');
  const result = path.join(directory, 'result.json');
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const file = ${JSON.stringify(file)};
    const journal = createFileJournal(file);
    journal.save({ first: 1 });
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    pause(${JSON.stringify(go)});
    let code = '';
    let saved = false;
    try {
      journal.save({ missing: true });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
    }
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({
      writable: journal.writable === true,
      saved,
      code,
      body: readFileSync(file, 'utf8'),
    }));
  `;
  const child = spawnJournal(source, {});
  try {
    await wait(ready, '子进程没有完成第一次保存');
    unlinkSync(lockPath);
    writeFileSync(go, 'go');
    const outcome = await child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
    const reported = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(reported.saved, false);
    assert.equal(reported.code, 'ELOCKED');
    assert.equal(reported.writable, false);
    assert.deepEqual(JSON.parse(reported.body), { first: 1 });
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (!existsSync(go)) writeFileSync(go, 'go');
  }
});

function readPublished(lockPath, between) {
  if (!existsSync(lockPath)) return null;
  between?.();
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function completeLock(body) {
  assert.notEqual(body, '');
  const parsed = JSON.parse(body);
  assert.match(parsed.token, /^[0-9a-f]{32}$/);
  assert.equal(Number.isInteger(parsed.pid) && parsed.pid > 0, true);
  assert.equal(typeof parsed.hostname, 'string');
  assert.equal(parsed.hostname.length > 0, true);
  assert.match(parsed.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(parsed).sort(), ['hostname', 'pid', 'startedAt', 'token']);
  return parsed;
}

// 回归：改回先 openSync(lockPath, 'wx') 再 writeSync 后，子进程不会停在发布前，本用例超时失败。
test('契约：写锁路径在内容发布前不存在，发布后一次就是完整记录', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-publish-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const arrived = path.join(directory, 'publish-arrived');
  const waitFile = path.join(directory, 'publish-wait');
  const ready = path.join(directory, 'ready');
  const release = path.join(directory, 'release');
  const observations = [];
  const reader = setInterval(() => {
    const body = readPublished(lockPath);
    if (body !== null) observations.push(body);
  }, 1);
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const file = ${JSON.stringify(file)};
    const journal = createFileJournal(file);
    if (journal.writable !== true) process.exit(2);
    journal.save({ held: true });
    writeFileSync(${JSON.stringify(ready)}, readFileSync(${JSON.stringify(lockPath)}, 'utf8'));
    pause(${JSON.stringify(release)});
  `;
  const child = spawnJournal(source, {
    ZHUMA_LOCK_PUBLISH_ARRIVED: arrived,
    ZHUMA_LOCK_PUBLISH_WAIT: waitFile,
  });
  try {
    await wait(arrived, '子进程没有停在锁内容发布前');
    assert.equal(existsSync(lockPath), false, '锁路径在内容发布前就已经出现');
    assert.equal(observations.length, 0);
    const temps = readdirSync(directory).filter(
      (name) => name.endsWith('.tmp') && name.includes('.write.lock.'),
    );
    assert.equal(temps.length, 1);
    const staged = readFileSync(path.join(directory, temps[0]), 'utf8');
    const record = completeLock(staged);
    assert.equal(record.pid, Number(readFileSync(arrived, 'utf8')));
    writeFileSync(waitFile, 'go');
    await wait(ready, '子进程没有在持锁期间交出锁内容');
    const published = completeLock(readFileSync(lockPath, 'utf8'));
    assert.deepEqual(published, record);
    assert.deepEqual(completeLock(readFileSync(ready, 'utf8')), record);
    for (const body of observations) assert.deepEqual(completeLock(body), record);
    assert.equal(
      readdirSync(directory).some((name) => name.endsWith('.tmp')),
      false,
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).held, true);
    writeFileSync(release, 'go');
    const outcome = await child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    clearInterval(reader);
    if (!existsSync(waitFile)) writeFileSync(waitFile, 'go');
    if (!existsSync(release)) writeFileSync(release, 'go');
  }
});

function liveRecord(token) {
  return JSON.stringify({
    token,
    pid: process.pid,
    hostname: hostname(),
    startedAt: '2026-10-23T00:00:00.000Z',
  });
}

function reclaimSource(file, ready, release) {
  return `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const journal = createFileJournal(${JSON.stringify(file)});
    writeFileSync(${JSON.stringify(ready)}, journal.writable === true ? '1' : '0');
    pause(${JSON.stringify(release)});
  `;
}

async function openStaleReclaim(names) {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-reclaim-'));
  const file = path.join(directory, 'session.json');
  const ready = path.join(directory, 'ready');
  const release = path.join(directory, 'release');
  const env = {};
  const gates = {};
  for (const name of names) {
    const arrived = path.join(directory, `${name.toLowerCase()}-arrived`);
    const wait = path.join(directory, `${name.toLowerCase()}-wait`);
    env[`ZHUMA_LOCK_${name}_ARRIVED`] = arrived;
    env[`ZHUMA_LOCK_${name}_WAIT`] = wait;
    gates[name] = { arrived, wait };
  }
  staleLock(file, await deadPid(), 'dead-token');
  const child = spawnJournal(reclaimSource(file, ready, release), env);
  return {
    directory,
    file,
    lockPath: `${file}.write.lock`,
    mutexPath: `${file}.write.lock.reclaim`,
    ready,
    release,
    child,
    gates,
  };
}

function releaseGates(session) {
  for (const gate of Object.values(session.gates)) {
    if (!existsSync(gate.wait)) writeFileSync(gate.wait, 'go');
  }
  if (!existsSync(session.release)) writeFileSync(session.release, 'go');
}

// 回归：回收互斥或新锁改成覆盖写入，或在硬链接前先创建目标路径，下面四则失败。
test('契约：回收互斥在内容发布前不存在，发布后一次就是完整记录', async () => {
  const session = await openStaleReclaim(['RECLAIM', 'RELOCK']);
  try {
    await wait(session.gates.RECLAIM.arrived, '子进程没有停在回收互斥发布前');
    assert.equal(existsSync(session.mutexPath), false, '回收互斥在内容发布前就已经出现');
    const temps = readdirSync(session.directory).filter(
      (name) => name.endsWith('.tmp') && name.includes('.reclaim.'),
    );
    assert.equal(temps.length, 1);
    const staged = completeLock(readFileSync(path.join(session.directory, temps[0]), 'utf8'));
    writeFileSync(session.gates.RECLAIM.wait, 'go');
    await wait(session.gates.RELOCK.arrived, '子进程没有停在新锁发布前');
    assert.deepEqual(completeLock(readFileSync(session.mutexPath, 'utf8')), staged);
    writeFileSync(session.gates.RELOCK.wait, 'go');
    await wait(session.ready, '子进程没有完成回收');
    assert.equal(readFileSync(session.ready, 'utf8'), '1');
    const published = completeLock(readFileSync(session.lockPath, 'utf8'));
    assert.equal(published.pid, staged.pid);
    writeFileSync(session.release, 'go');
    const outcome = await session.child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    releaseGates(session);
  }
});

test('契约：回收互斥不会覆盖已经发布的文件', async () => {
  const session = await openStaleReclaim(['RECLAIM']);
  try {
    await wait(session.gates.RECLAIM.arrived, '子进程没有停在回收互斥发布前');
    writeFileSync(session.mutexPath, liveRecord('planted-mutex'));
    writeFileSync(session.gates.RECLAIM.wait, 'go');
    await wait(session.ready, '子进程没有结束回收');
    assert.equal(readFileSync(session.ready, 'utf8'), '0');
    assert.equal(JSON.parse(readFileSync(session.mutexPath, 'utf8')).token, 'planted-mutex');
    assert.equal(existsSync(session.file), false);
    writeFileSync(session.release, 'go');
    const outcome = await session.child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    releaseGates(session);
  }
});

test('契约：回收出的新锁在内容发布前不存在，发布后一次就是完整记录', async () => {
  const session = await openStaleReclaim(['RELOCK']);
  try {
    await wait(session.gates.RELOCK.arrived, '子进程没有停在新锁发布前');
    assert.equal(existsSync(session.lockPath), false, '新锁在内容发布前就已经出现');
    const temps = readdirSync(session.directory).filter(
      (name) => name.endsWith('.tmp') && name.includes('.write.lock.'),
    );
    assert.equal(temps.length, 1);
    const staged = completeLock(readFileSync(path.join(session.directory, temps[0]), 'utf8'));
    writeFileSync(session.gates.RELOCK.wait, 'go');
    await wait(session.ready, '子进程没有完成回收');
    assert.equal(readFileSync(session.ready, 'utf8'), '1');
    assert.deepEqual(completeLock(readFileSync(session.lockPath, 'utf8')), staged);
    writeFileSync(session.release, 'go');
    const outcome = await session.child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    releaseGates(session);
  }
});

test('契约：回收新锁遇到权限错误时把路径抛出来', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-relock-eacces-'));
  const directory = path.join(parent, 'data');
  mkdirSync(directory);
  const file = path.join(directory, 'session.json');
  const report = path.join(parent, 'report');
  const arrived = path.join(parent, 'relock-arrived');
  const waitFile = path.join(parent, 'relock-wait');
  const injectFlag = path.join(parent, 'inject-eacces');
  const preload = path.join(parent, 'preload.mjs');
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      'const original = fs.linkSync;',
      'fs.linkSync = (existing, target) => {',
      '  if (process.getuid() === 0 && fs.existsSync(process.env.ZHUMA_INJECT_EACCES)) {',
      "    const error = new Error(`EACCES: permission denied, link '${existing}' -> '${target}'`);",
      "    error.code = 'EACCES';",
      '    throw error;',
      '  }',
      '  return original(existing, target);',
      '};',
      '',
    ].join('\n'),
  );
  staleLock(file, await deadPid(), 'dead-token');
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    let text = '';
    try {
      const journal = createFileJournal(${JSON.stringify(file)});
      text = journal.writable === true ? 'writable' : 'readonly';
    } catch (error) {
      text = 'throw:' + (error && error.message ? error.message : String(error));
    }
    writeFileSync(${JSON.stringify(report)}, text);
  `;
  const child = spawnJournal(
    source,
    {
      ZHUMA_LOCK_RELOCK_ARRIVED: arrived,
      ZHUMA_LOCK_RELOCK_WAIT: waitFile,
      ZHUMA_INJECT_EACCES: injectFlag,
    },
    preload,
  );
  try {
    await wait(arrived, '子进程没有停在新锁发布前');
    chmodSync(directory, 0o555);
    if (process.getuid() === 0) writeFileSync(injectFlag, '1');
    writeFileSync(waitFile, 'go');
    await wait(report, '子进程没有写下新锁错误');
    const text = readFileSync(report, 'utf8');
    assert.match(text, /EACCES/);
    assert.equal(text.includes(directory), true);
    const outcome = await child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    chmodSync(directory, 0o755);
    if (!existsSync(waitFile)) writeFileSync(waitFile, 'go');
    rmSync(parent, { recursive: true, force: true });
  }
});

test('契约：回收新锁遇到不带路径的错误时，抛出的消息仍补上锁路径', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-relock-sealed-'));
  const directory = path.join(parent, 'data');
  mkdirSync(directory);
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const report = path.join(parent, 'report');
  const arrived = path.join(parent, 'relock-arrived');
  const waitFile = path.join(parent, 'relock-wait');
  const injectFlag = path.join(parent, 'inject-sealed');
  const preload = path.join(parent, 'preload.mjs');
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      'const original = fs.linkSync;',
      'fs.linkSync = (existing, target) => {',
      '  if (fs.existsSync(process.env.ZHUMA_INJECT_SEALED)) {',
      "    const error = new Error('sealed');",
      "    error.code = 'EIO';",
      '    throw error;',
      '  }',
      '  return original(existing, target);',
      '};',
      '',
    ].join('\n'),
  );
  staleLock(file, await deadPid(), 'dead-token');
  const source = `
    import { writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    let text = '';
    try {
      const journal = createFileJournal(${JSON.stringify(file)});
      text = journal.writable === true ? 'writable' : 'readonly';
    } catch (error) {
      text = 'throw:' + (error && error.message ? error.message : String(error));
    }
    writeFileSync(${JSON.stringify(report)}, text);
  `;
  const child = spawnJournal(
    source,
    {
      ZHUMA_LOCK_RELOCK_ARRIVED: arrived,
      ZHUMA_LOCK_RELOCK_WAIT: waitFile,
      ZHUMA_INJECT_SEALED: injectFlag,
    },
    preload,
  );
  try {
    await wait(arrived, '子进程没有停在新锁发布前');
    writeFileSync(injectFlag, '1');
    writeFileSync(waitFile, 'go');
    await wait(report, '子进程没有写下新锁错误');
    const text = readFileSync(report, 'utf8');
    assert.equal(text, `throw:sealed ${lockPath}`);
    const outcome = await child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    if (!existsSync(waitFile)) writeFileSync(waitFile, 'go');
    rmSync(parent, { recursive: true, force: true });
  }
});

test('契约：回收出的新锁不会覆盖已经发布的文件', async () => {
  const session = await openStaleReclaim(['RELOCK']);
  try {
    await wait(session.gates.RELOCK.arrived, '子进程没有停在新锁发布前');
    writeFileSync(session.lockPath, liveRecord('planted-lock'));
    writeFileSync(session.gates.RELOCK.wait, 'go');
    await wait(session.ready, '子进程没有结束回收');
    assert.equal(readFileSync(session.ready, 'utf8'), '0');
    assert.equal(JSON.parse(readFileSync(session.lockPath, 'utf8')).token, 'planted-lock');
    assert.equal(existsSync(session.file), false);
    writeFileSync(session.release, 'go');
    const outcome = await session.child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    releaseGates(session);
  }
});

// 回归：把消失的互斥当成仍要删除的文件后，writable 为 false，refusal 里还有这条路径。
test('契约：回收互斥在读到之前消失时继续抢锁，不要求删除已经不在的路径', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-mutex-enoent-'));
  const file = path.join(directory, 'session.json');
  const lockPath = `${file}.write.lock`;
  const mutexPath = `${lockPath}.reclaim`;
  const arrived = path.join(directory, 'mutex-read-arrived');
  const waitFile = path.join(directory, 'mutex-read-wait');
  const ready = path.join(directory, 'ready');
  const release = path.join(directory, 'release');
  writeFileSync(mutexPath, liveRecord('gone-soon'));
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    ${pauseSource()}
    const journal = createFileJournal(${JSON.stringify(file)});
    let saved = false;
    let code = '';
    try {
      journal.save({ held: true });
      saved = true;
    } catch (error) {
      code = error && error.code ? String(error.code) : 'throw';
    }
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({
      writable: journal.writable === true,
      refusal: journal.refusal ?? '',
      saved,
      code,
    }));
    pause(${JSON.stringify(release)});
  `;
  const child = spawnJournal(source, {
    ZHUMA_LOCK_MUTEX_READ_ARRIVED: arrived,
    ZHUMA_LOCK_MUTEX_READ_WAIT: waitFile,
  });
  try {
    await wait(arrived, '子进程没有停在读取回收互斥之前');
    unlinkSync(mutexPath);
    writeFileSync(waitFile, 'go');
    await wait(ready, '子进程没有完成抢锁');
    const reported = JSON.parse(readFileSync(ready, 'utf8'));
    assert.equal(reported.writable, true);
    assert.equal(reported.saved, true);
    assert.equal(reported.code, '');
    assert.equal(reported.refusal.includes(mutexPath), false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).held, true);
    assert.equal(existsSync(mutexPath), false);
    const published = completeLock(readFileSync(lockPath, 'utf8'));
    assert.equal(published.pid > 0, true);
    writeFileSync(release, 'go');
    const outcome = await child.exited;
    assert.equal(outcome.code, 0, outcome.stderr);
  } finally {
    if (!existsSync(waitFile)) writeFileSync(waitFile, 'go');
    if (!existsSync(release)) writeFileSync(release, 'go');
  }
});

function hardlinkChild() {
  const dir = mkdtempSync(path.join(tmpdir(), 'zhuma-link-fault-'));
  const preload = path.join(dir, 'preload.mjs');
  const script = path.join(dir, 'drive.mjs');
  writeFileSync(
    preload,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "const fs = require('node:fs');",
      'const original = fs.linkSync;',
      'fs.linkSync = (existing, target) => {',
      '  const code = process.env.ZHUMA_LINK_CODE;',
      '  if (code) {',
      '    const error = new Error(`${code}: link`);',
      '    error.code = code;',
      '    throw error;',
      '  }',
      '  return original(existing, target);',
      '};',
      '',
    ].join('\n'),
  );
  writeFileSync(
    script,
    [
      'const { createFileJournal } = await import(process.env.ZHUMA_ADAPTER);',
      'let text = "";',
      'try {',
      '  const journal = createFileJournal(process.env.ZHUMA_SESSION_FILE);',
      '  text = JSON.stringify({',
      '    threw: false,',
      '    writable: journal.writable === true,',
      '    refusal: journal.refusal ?? "",',
      '  });',
      '} catch (error) {',
      '  text = JSON.stringify({',
      '    threw: true,',
      '    writable: null,',
      '    refusal: error && error.message ? error.message : String(error),',
      '  });',
      '}',
      'process.stdout.write(text);',
      '',
    ].join('\n'),
  );
  return { dir, preload, script };
}

async function runHardlink(code) {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-link-journal-'));
  const file = path.join(directory, 'session.json');
  const childFiles = hardlinkChild();
  const child = spawn(process.execPath, ['--import', childFiles.preload, childFiles.script], {
    env: {
      ...process.env,
      ZHUMA_LINK_CODE: code,
      ZHUMA_SESSION_FILE: file,
      ZHUMA_ADAPTER: adapter,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [status] = await once(child, 'exit');
    if (status !== 0) throw new Error(`硬链接注入进程退出 ${status}\n${stderr}\n${stdout}`);
    return { ...JSON.parse(stdout), lockPath: `${file}.write.lock` };
  } finally {
    clearTimeout(timer);
    rmSync(childFiles.dir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

test('契约：硬链接返回 EPERM、ENOTSUP 或 EXDEV 时日志只读，拒绝理由带路径', async () => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    const reported = await runHardlink(code);
    assert.equal(reported.threw, false, reported.refusal);
    assert.equal(reported.writable, false);
    assert.match(reported.refusal, /只读/);
    assert.equal(reported.refusal.includes(reported.lockPath), true);
  }
});

test('契约：示例服务遇到不能硬链接的目录时按只读拒绝退出，不把异常抛出进程', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-link-server-'));
  const sessionFile = path.join(directory, 'session.json');
  const childFiles = hardlinkChild();
  const server = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../examples/agent-workspace/server.mjs',
  );
  const env = {
    ...process.env,
    ZHUMA_LINK_CODE: 'EPERM',
    ZHUMA_SESSION_FILE: sessionFile,
  };
  delete env.ZHUMA_MODEL_API_KEY;
  const child = spawn(process.execPath, ['--import', childFiles.preload, server], { env });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const [status] = await once(child, 'exit');
    assert.equal(status, 1);
    assert.match(stderr, /只读/);
    assert.equal(stderr.includes(sessionFile), true);
    assert.equal(stderr.includes('at '), false);
  } finally {
    clearTimeout(timer);
    rmSync(childFiles.dir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

// 回归：观察读取去掉 ENOENT 吞掉后，本用例抛 ENOENT。
test('契约：锁在观察到存在之后被删掉时，读取一侧忽略 ENOENT', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-observe-enoent-'));
  const lockPath = path.join(directory, 'session.json.write.lock');
  writeFileSync(lockPath, liveRecord('observe'));
  const body = readPublished(lockPath, () => unlinkSync(lockPath));
  assert.equal(body, null);
  assert.equal(existsSync(lockPath), false);
});
