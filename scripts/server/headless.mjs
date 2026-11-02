#!/usr/bin/env node
/** One read-only payload, one explicit data root, original CLI/profile/identity only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createMemberGateway } from './member-gateway.mjs';
import { inspectHeadlessRuntime } from './runtime-manifest.mjs';

export function parseHeadlessArgs(argv) {
  const { values, tokens } = parseArgs({
    args: argv,
    tokens: true,
    options: {
      data: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '3080' },
      'operator-port': { type: 'string', default: '3081' },
      'public-origin': { type: 'string', multiple: true },
      'file-uploads': { type: 'boolean', default: false },
      'independent-reviews': { type: 'boolean', default: false },
    },
  });
  const seen = new Set();
  for (const token of tokens)
    if (token.kind === 'option' && token.name !== 'public-origin') {
      assert(!seen.has(token.name), 'Repeated option.');
      seen.add(token.name);
    }
  assert(values.data?.trim(), 'An explicit data directory is required.');
  assert(isIP(values.host), 'A concrete bind IP is required.');
  const hostname = isIP(values.host) === 6 ? `[${values.host}]` : values.host;
  const canonical = new URL(`http://${hostname}/`).hostname;
  assert(!['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(canonical), 'Wildcard binds are refused.');
  for (const value of [values.port, values['operator-port']])
    assert(/^\d+$/u.test(value) && Number(value) > 0 && Number(value) <= 65535, 'Invalid port.');
  assert(
    Number(values.port) !== Number(values['operator-port']),
    'Member and operator ports must differ.',
  );
  assert(
    !values['independent-reviews'] || values['file-uploads'],
    'Independent reviews require file uploads.',
  );
  const origins = (values['public-origin'] ?? []).map((value) => {
    const url = new URL(value);
    assert(
      ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash,
      'Public origin must be an HTTP(S) root.',
    );
    return url.origin;
  });
  assert(origins.length <= 8, 'Too many public origins.');
  const local = `http://${hostname}:${Number(values.port)}`;
  return {
    data: resolve(values.data),
    host: values.host,
    port: Number(values.port),
    operatorPort: Number(values['operator-port']),
    origins,
    authorities: [
      ...new Set([new URL(local).host, ...origins.map((origin) => new URL(origin).host)]),
    ],
    fileUploads: values['file-uploads'],
    independentReviews: values['independent-reviews'],
  };
}

export function headlessLaunchPlan(runtime, options, path = process.env.PATH ?? '/usr/bin:/bin') {
  const overlayPath = join(options.data, 'zhuma-server.patch.json');
  return {
    executable: process.execPath,
    args: [
      '--expose-internals',
      runtime.cli,
      '--profile',
      'web',
      '--patch',
      overlayPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(options.operatorPort),
      '--no-open',
      '--trusted-host',
      ...options.authorities,
    ],
    cwd: options.data,
    overlayPath,
    env: {
      PATH: path,
      HOME: join(options.data, 'home'),
      DSH_HOME: join(options.data, 'dsh'),
      LANG: 'en_US.UTF-8',
      // Use the verified immutable binary directly; /tmp remains non-executable.
      NARB_DISABLE_NATIVE_CACHE: '1',
    },
    overlay: [
      { id: 'typert-gateway', config: { sessionAdmissionRequired: true } },
      {
        insert: [
          {
            id: 'zhuma-member-workbench',
            name: runtime.plugin,
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

export async function runHeadless(root, options) {
  const runtime = await inspectHeadlessRuntime(root);
  await mkdir(options.data, { recursive: true, mode: 0o700 });
  const data = await realpath(options.data),
    base = await realpath(root),
    local = relative(base, data);
  assert(
    local && (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)),
    'Data must be outside the immutable payload.',
  );
  options = { ...options, data };
  const plan = headlessLaunchPlan(runtime, options);
  await mkdir(plan.env.HOME, { recursive: true, mode: 0o700 });
  const temporary = join(data, `overlay-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(plan.overlay), { mode: 0o600, flag: 'wx' });
  await rename(temporary, plan.overlayPath);
  const operatorFile = join(data, `operator-url-${randomUUID()}.txt`);
  // Each process owns only its own capability file, including during failed concurrent starts.
  let ready = false,
    output = Promise.resolve(),
    closing,
    forced = false;
  const gateway = createMemberGateway({ ...options, ready: () => ready });
  const child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buffers = new Map();
  function feed(chunk, stream) {
    let buffer = (buffers.get(stream) ?? '') + chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const capability = line.match(/dsh web: (https?:\/\/\S+\?token=\S+)/u)?.[1];
      if (capability) {
        output = output.then(async () => {
          const url = new URL(capability);
          assert.equal(url.hostname, '127.0.0.1');
          assert.equal(url.port, String(options.operatorPort));
          if (closing || child.exitCode !== null || child.signalCode !== null) return;
          await writeFile(operatorFile, capability + '\n', { flag: 'wx', mode: 0o600 });
          if (closing || child.exitCode !== null || child.signalCode !== null) return;
          ready = true;
          console.log(
            'Member service ready. Private operator capability saved in the data directory.',
          );
        });
        void output.catch(() => {
          void stop();
        });
      } else console.error(line.replace(/token=[^\s&]+/gu, 'token=[redacted]'));
    }
    if (buffer.length > 65536) {
      buffer = '';
      console.error('Oversized backend log line omitted.');
    }
    buffers.set(stream, buffer);
  }
  child.stdout.on('data', (chunk) => feed(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => feed(chunk, 'stderr'));
  const exit = new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  function stop() {
    return (closing ??= (async () => {
      ready = false;
      const transport = gateway.stop();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          forced = true;
          child.kill('SIGKILL');
        }
      }, 30_000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
        await transport;
      }
    })());
  }
  const signal = () => {
    void stop();
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    await gateway.listen();
    const result = await exit;
    ready = false;
    await output;
    if (forced) throw Error('Original CLI did not stop within the shutdown budget.');
    return result.code ?? 1;
  } finally {
    await stop();
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    await rm(operatorFile, { force: true });
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runHeadless(
      dirname(fileURLToPath(import.meta.url)),
      parseHeadlessArgs(process.argv.slice(2)),
    );
  } catch {
    console.error(
      'Shared backend could not start or stop cleanly; inspect the private operator deployment.',
    );
    process.exitCode = 1;
  }
}
