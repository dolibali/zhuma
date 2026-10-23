import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 回归：屏障仍留在回收之前，把过期回收改回先 unlink 再 wx、释放改回无条件 unlink、
// 保存不再核对令牌后，下面三则都失败。已改回跑过：
// 跟随者的 writable 变成 true；正常退出和 SIGTERM 后新锁文件不存在；
// 接走后的两次保存都写成 saved，没有变成只读。

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

function spawnJournal(source, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ...env },
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

function staleLock(file, pid) {
  writeFileSync(
    `${file}.write.lock`,
    JSON.stringify({
      pid,
      hostname: hostname(),
      startedAt: '2026-10-23T00:00:00.000Z',
    }),
  );
}

test('契约：两个进程同时回收同一把过期锁时只有一个能写', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'zhuma-lock-race-'));
  const file = path.join(directory, 'session.json');
  const arrived = path.join(directory, 'arrived');
  const signal = path.join(directory, 'leader-saved');
  const leaderResult = path.join(directory, 'leader.json');
  const followerResult = path.join(directory, 'follower.json');
  staleLock(file, await deadPid());

  const followerDone = path.join(directory, 'follower-done');
  const source = `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createFileJournal } from ${JSON.stringify(adapter)};
    const file = ${JSON.stringify(file)};
    const role = process.env.ZHUMA_LOCK_ROLE;
    const journal = createFileJournal(file);
    if (process.env.ZHUMA_LOCK_SIGNAL) {
      writeFileSync(process.env.ZHUMA_LOCK_SIGNAL, 'holding');
      const started = Date.now();
      while (!existsSync(process.env.ZHUMA_LOCK_FOLLOWER_DONE)) {
        if (Date.now() - started > 8000) process.exit(3);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
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
      body: saved ? readFileSync(file, 'utf8') : '',
    }));
  `;
  const follower = spawnJournal(source, {
    ZHUMA_LOCK_ROLE: 'follower',
    ZHUMA_LOCK_ARRIVED: arrived,
    ZHUMA_LOCK_WAIT_FILE: signal,
    ZHUMA_LOCK_FOLLOWER_DONE: followerDone,
    ZHUMA_LOCK_RESULT: followerResult,
  });
  await wait(arrived, '跟随者没有停在回收前');
  const leader = spawnJournal(source, {
    ZHUMA_LOCK_ROLE: 'leader',
    ZHUMA_LOCK_SIGNAL: signal,
    ZHUMA_LOCK_FOLLOWER_DONE: followerDone,
    ZHUMA_LOCK_RESULT: leaderResult,
  });
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
    const file = ${JSON.stringify(file)};
    const journal = createFileJournal(file);
    journal.save({ first: 1 });
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    const started = Date.now();
    while (!existsSync(${JSON.stringify(go)})) {
      if (Date.now() - started > 8000) process.exit(3);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
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
