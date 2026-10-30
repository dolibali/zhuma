#!/usr/bin/env node
/** Installed-App launcher only. Original DSH CLI owns the server and storage. */
import { parseArgs } from 'node:util';
import { isIP } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PACKAGED_SDK_PIN = '504a01a9578abc2c6f1fb896b1dc322c9fe24f66';
export const HELP = `用法：packaged-backend.sh --app /Applications/Zhuma.app --data /path/to/backend-data [选项]
  --host <IP>       具体监听地址，默认 127.0.0.1，不接受通配地址
  --port <端口>     默认 3080（1–65535）
  --file-uploads    显式启用已装配的真实文件协议，默认关闭
  --independent-reviews  显式启用独立 Agent 评审，需同时指定 --file-uploads
  --help           显示帮助，不启动 profile
需要同目录的两个启动文件，以及包含成员 Web 和共享后端的新版 Zhuma App。
数据和新 profile 仅写入显式 --data；不会导入其他安装的凭据或会话。`;

class LauncherError extends Error {}
const refuse = (message) => {
  throw new LauncherError(message);
};

export function parseBackendArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      tokens: true,
      options: {
        app: { type: 'string' },
        data: { type: 'string' },
        host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '3080' },
        'file-uploads': { type: 'boolean', default: false },
        'independent-reviews': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch {
    refuse('参数无效；请使用 --help 查看用法。');
  }
  const seen = new Set();
  for (const token of parsed.tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name)) refuse('参数不能重复。');
      seen.add(token.name);
    }
  const value = parsed.values;
  if (value.help) return { help: true };
  if (!value.app?.trim() || !value.data?.trim()) refuse('必须显式指定 --app 和独立 --data。');
  if (value['independent-reviews'] && !value['file-uploads'])
    refuse('独立评审需要同时指定 --file-uploads。');
  if (!isIP(value.host) || ['0.0.0.0', '::'].includes(value.host))
    refuse('--host 必须是具体 IP 地址。');
  if (!/^\d+$/u.test(value.port) || Number(value.port) < 1 || Number(value.port) > 65535)
    refuse('--port 必须在 1–65535 之间。');
  const app = resolve(value.app),
    data = resolve(value.data),
    inside = relative(app, data);
  if (!inside || (!inside.startsWith('..' + '/') && inside !== '..' && !isAbsolute(inside)))
    refuse('--data 必须在 App 包之外。');
  return {
    app,
    data,
    host: value.host,
    port: Number(value.port),
    fileUploads: value['file-uploads'],
    independentReviews: value['independent-reviews'],
  };
}

function plistValue(plist, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Read only public installed resources. Electron Node mode supplies ASAR FS. */
export async function inspectPackagedApp(app, { readPlist = plistValue } = {}) {
  try {
    const info = join(app, 'Contents/Info.plist');
    const executableName = readPlist(info, 'CFBundleExecutable');
    const version = readPlist(info, 'CFBundleShortVersionString');
    if (
      readPlist(info, 'CFBundleIdentifier') !== 'dev.zhuma.app' ||
      !/^[\w .-]+$/u.test(executableName) ||
      ['.', '..'].includes(executableName)
    )
      refuse('不是有效的 Zhuma App。');
    const resources = join(app, 'Contents/Resources');
    const archive = join(resources, 'app.asar');
    const sdk = join(archive, 'dsh');
    const cli = join(sdk, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    const pluginDirectory = join(sdk, 'node_modules/@deepseek-ai/dsh-web-app/lib/zhuma-workbench');
    const executable = join(app, 'Contents/MacOS', executableName);
    const desktop = JSON.parse(await readFile(join(archive, 'package.json'), 'utf8'));
    const runtime = JSON.parse(
      await readFile(join(resources, 'runtime/primary-runtime/runtime.json'), 'utf8'),
    );
    const product = JSON.parse(await readFile(join(pluginDirectory, 'package.json'), 'utf8'));
    if (
      desktop.dshBuildCommit !== PACKAGED_SDK_PIN ||
      desktop.version !== version ||
      runtime.platform !== 'darwin' ||
      runtime.arch !== 'arm64' ||
      product.name !== '@zhuma/workbench' ||
      product.version !== version
    )
      refuse('App 的公开版本或固定 SDK 身份不匹配。');
    await access(executable, constants.X_OK);
    await access(cli, constants.R_OK);
    await access(join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), constants.R_OK);
    for (const file of ['index.js', 'member-web.js', 'LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
      try {
        await access(join(pluginDirectory, file), constants.R_OK);
      } catch {
        refuse('App 缺少共享成员后端资源；旧版 App 不能用于本入口。');
      }
    }
    return { app, executable, cli, plugin: join(pluginDirectory, 'index.js'), version };
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    refuse('无法读取 App 的公开 runtime；请用同目录 packaged-backend.sh 启动。');
  }
}

/** Original profile/overlay contract; not a second server or admission owner. */
export function backendLaunchPlan(app, options, path = process.env.PATH ?? '/usr/bin:/bin') {
  const overlayPath = join(options.data, 'zhuma-server.patch.json');
  return {
    executable: app.executable,
    args: [
      '--expose-internals',
      app.cli,
      '--profile',
      'web',
      '--patch',
      overlayPath,
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--no-open',
    ],
    cwd: options.data,
    env: {
      PATH: path,
      HOME: join(options.data, 'home'),
      DSH_HOME: join(options.data, 'dsh'),
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
    },
    overlayPath,
    overlay: [
      { id: 'typert-gateway', config: { sessionAdmissionRequired: true } },
      { id: 'zhuma-workbench', disabled: true },
      {
        insert: [
          {
            id: 'zhuma-member-workbench',
            name: app.plugin,
            config: {
              deploymentMode: 'multi-member',
              localSetup: true,
              memberWeb: true,
              remoteExecution: true,
              ...(options.fileUploads ? { remoteFileUploads: true } : {}),
              ...(options.independentReviews ? { remoteIndependentReviews: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

/** Intercept only this new process's operator URL; never expose it as a member link. */
export function createOutputSink({ operatorFile, writePrivate, member, log, failure = () => {} }) {
  const buffers = new Map();
  let queued = Promise.resolve();
  return {
    feed(chunk, stream = 'stdout') {
      let buffer = (buffers.get(stream) ?? '') + chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const url = line.match(/dsh web: (https?:\/\/\S+\?token=\S+)/u)?.[1];
        if (url) {
          queued = queued.then(async () => {
            await writePrivate(operatorFile, url + '\n');
            member(new URL('/workbench', url).href, operatorFile);
          });
          void queued.catch(failure);
        } else log(line.replace(/token=[^\s&]+/gu, 'token=[redacted]'));
      }
      if (buffer.length > 65536) {
        log('后端单行日志过长，已省略。');
        buffer = '';
      }
      buffers.set(stream, buffer);
    },
    finish: () => queued,
  };
}

async function run(options) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    refuse('此入口仅支持已验证的 macOS arm64 App。');
  const app = await inspectPackagedApp(options.app);
  if (
    !process.versions.electron ||
    process.env.ELECTRON_RUN_AS_NODE !== '1' ||
    (await realpath(process.execPath)) !== (await realpath(app.executable))
  )
    refuse('请用 packaged-backend.sh 启动原 App 的 Electron Node 模式。');
  const plan = backendLaunchPlan(app, options);
  await mkdir(options.data, { recursive: true, mode: 0o700 });
  await mkdir(plan.env.HOME, { recursive: true, mode: 0o700 });
  // Replace only this generated overlay path; do not follow a pre-existing symlink.
  const temporary = join(options.data, `overlay-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(plan.overlay, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const { rename } = await import('node:fs/promises');
  await rename(temporary, plan.overlayPath);
  const operatorFile = join(options.data, `operator-url-${randomUUID()}.txt`);
  let created = false;
  let child;
  const sink = createOutputSink({
    operatorFile,
    async writePrivate(path, value) {
      await writeFile(path, value, { mode: 0o600, flag: created ? 'w' : 'wx' });
      created = true;
    },
    member(url, path) {
      console.log(`Member entry: ${url}`);
      console.log(`Private operator URL saved to ${path}`);
    },
    log: (line) => console.error(line),
    failure: () => child?.kill('SIGTERM'),
  });
  child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => sink.feed(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => sink.feed(chunk, 'stderr'));
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const exit = await new Promise((done, fail) => {
      child.once('exit', (code) => done(code ?? 1));
      child.once('error', fail);
    });
    await sink.finish();
    process.exitCode = exit;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (created) await unlink(operatorFile);
  }
}

if (import.meta.main) {
  try {
    const options = parseBackendArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await run(options);
  } catch (error) {
    console.error(
      error instanceof LauncherError
        ? error.message
        : '本地共享后端未启动；请检查 App 和独立数据目录。',
    );
    process.exitCode = 1;
  }
}
