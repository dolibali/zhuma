import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, symlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotServerPlugin } from './plugin-snapshot.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Start the pinned official CLI with product plugins and an explicit, owned data directory. */
export async function startLocalServer({
  sdk,
  data,
  plugin,
  fileUploads = false,
  independentReviews = false,
  host = '127.0.0.1',
  port = 3080,
}) {
  if (independentReviews && !fileUploads)
    throw new Error('Independent review requires --file-uploads');
  const sdkRoot = resolve(sdk);
  const dataRoot = resolve(data);
  const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
  const pin = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sdkRoot, encoding: 'utf8' }).trim();
  if (pin !== lock.upstreams.deepseekHarness.commit) throw new Error('Unexpected SDK revision');
  const runtime = await snapshotServerPlugin({
    source: plugin ? resolve(plugin) : join(root, '.build/workbench'),
    sdkRoot,
    pin,
    outputRoot: join(root, '.build/server-runtime'),
    frozen: plugin !== undefined,
  });
  const pluginEntry = join(runtime, 'index.js');
  const cli = join(sdkRoot, 'apps/cli/lib/bin.js');
  await access(cli);
  const publicModules = join(sdkRoot, 'packages/bundle/web-app/node_modules');
  const moduleLink = join(runtime, 'node_modules');
  try {
    await symlink(publicModules, moduleLink, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if ((await realpath(moduleLink)) !== (await realpath(publicModules)))
    throw new Error('Workbench SDK dependencies belong to a different runtime');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(dataRoot, 'home'), { recursive: true, mode: 0o700 });
  const overlay = join(dataRoot, 'zhuma-server.patch.json');
  await writeFile(
    overlay,
    JSON.stringify([
      { id: 'typert-gateway', config: { sessionAdmissionRequired: true } },
      { id: 'zhuma-workbench', disabled: true },
      {
        insert: [
          {
            id: 'zhuma-member-workbench',
            name: pluginEntry,
            config: {
              deploymentMode: 'multi-member',
              localSetup: true,
              memberWeb: true,
              remoteExecution: true,
              ...(fileUploads ? { remoteFileUploads: true } : {}),
              ...(independentReviews ? { remoteIndependentReviews: true } : {}),
            },
          },
        ],
      },
    ]),
    { mode: 0o600 },
  );
  // No inherited model credentials, user home, acceptance profile or session library.
  return spawn(
    process.execPath,
    [
      cli,
      '--profile',
      'web',
      '--patch',
      overlay,
      '--host',
      host,
      '--port',
      String(port),
      '--no-open',
    ],
    {
      cwd: dataRoot,
      env: {
        PATH: process.env.PATH,
        HOME: join(dataRoot, 'home'),
        DSH_HOME: join(dataRoot, 'dsh'),
        LANG: 'en_US.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export async function stopLocalServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      done();
    });
    child.kill('SIGTERM');
  });
}
