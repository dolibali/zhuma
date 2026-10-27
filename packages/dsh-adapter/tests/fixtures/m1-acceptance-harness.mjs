import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Acceptance harness over the real Host subprocess fixture: real Connection,
 * credentials, JSON storage domains and member cookies. A confirmed plan is
 * seeded through `workbenchSeed` before the Host mounts; that preparation is
 * a Host-level act recorded in the suite, never a member impersonation.
 *
 * Every boot reads `S1A_HOST_MODULE`, resolves it to an absolute path, and
 * passes that path as `options.modulePath` beside the strict Host config.
 * A missing or empty value, or a path that is not a readable file, fails
 * before the child starts. The child does not substitute another entry.
 */
export function acceptanceModulePath() {
  const raw = process.env.S1A_HOST_MODULE;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Error('S1A_HOST_MODULE must name the Host entry');
  }
  return resolve(raw);
}

function sourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

export async function startAcceptanceHost(directory, config) {
  const modulePath = acceptanceModulePath();
  try {
    await access(modulePath);
  } catch {
    throw Error(`S1A_HOST_MODULE does not exist: ${modulePath}`);
  }
  const child = fork(fileURLToPath(new URL('./s1a-host-process.mjs', import.meta.url)), [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    silent: true,
  });
  async function stopChild() {
    if (child.exitCode !== null || child.killed) return;
    child.kill('SIGKILL');
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, 1000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  const phases = new Map();
  const waits = new Map();
  const actions = new Map();
  let diagnostics = '';
  let closed = false;
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk.toString();
  });
  child.stdout.resume();
  child.on('message', (message) => {
    if (message.phase) {
      phases.set(message.phase, message);
      waits.get(message.phase)?.(message);
    } else if (message.reply) {
      actions.get(message.reply)?.(message);
    }
  });
  const wait = (phase) =>
    phases.has(phase)
      ? Promise.resolve(phases.get(phase))
      : new Promise((resolveWait, reject) => {
          const timer = setTimeout(
            () => reject(Error(`Host phase timed out: ${phase}; ${diagnostics.slice(-500)}`)),
            15000,
          );
          waits.set(phase, (message) => {
            clearTimeout(timer);
            resolveWait(message);
          });
        });
  const act = (action, extra = {}) => {
    const id = randomUUID();
    const response = new Promise((resolveAction, reject) => {
      const timer = setTimeout(
        () => reject(Error(`Host action timed out: ${action}; ${diagnostics.slice(-2000)}`)),
        10000,
      );
      actions.set(id, (message) => {
        clearTimeout(timer);
        actions.delete(id);
        message.error ? reject(Error(message.error)) : resolveAction(message.value);
      });
    });
    child.send({ id, action, ...extra });
    return response;
  };
  const {
    identityImport,
    spaceDirectoryImport,
    workbenchSeed,
    observeUpload,
    webServerCompression,
    ...publicConfig
  } = config;
  if (webServerCompression !== undefined && !['none', 'gzip'].includes(webServerCompression))
    throw Error('Unsupported test WebServer compression');
  child.send({
    type: 'boot',
    options: {
      directory,
      modulePath,
      config: {
        ...publicConfig,
        ...(identityImport === undefined
          ? {}
          : { identityBootstrapKey: 'zhuma-identity/bootstrap' }),
        ...(spaceDirectoryImport === undefined
          ? {}
          : { spaceDirectoryBootstrapKey: 'zhuma-spaces/bootstrap' }),
      },
      identityImport,
      ...(observeUpload === undefined ? {} : { observeUpload }),
      ...(webServerCompression === undefined ? {} : { webServerCompression }),
      ...(spaceDirectoryImport === undefined ? {} : { spaceDirectoryImport }),
      ...(workbenchSeed === undefined ? {} : { workbenchSeed }),
    },
  });
  const listener = await new Promise((resolveBoot, rejectBoot) => {
    const timer = setTimeout(
      () => rejectBoot(Error(`Host phase timed out: listening; ${diagnostics.slice(-500)}`)),
      15000,
    );
    const finish = (message) => {
      if (message.phase === 'listening') {
        clearTimeout(timer);
        resolveBoot(message);
        return;
      }
      if (message.phase === 'failed') {
        clearTimeout(timer);
        rejectBoot(Error('Host boot failed'));
      }
    };
    if (phases.has('failed')) finish(phases.get('failed'));
    else if (phases.has('listening')) finish(phases.get('listening'));
    else {
      waits.set('listening', finish);
      waits.set('failed', finish);
    }
  }).catch(async (error) => {
    await stopChild();
    throw error;
  });
  const bound = phases.get('bound-module');
  const expectedDigest = createHash('sha256')
    .update(await readFile(modulePath))
    .digest('hex');
  if (bound?.modulePath !== modulePath || bound?.contentDigest !== expectedDigest) {
    await stopChild();
    throw Error('Bound Host module does not match S1A_HOST_MODULE');
  }
  const boundModule = {
    modulePath: bound.modulePath,
    contentDigest: bound.contentDigest,
    sourceSha: sourceSha(),
  };
  const seeded = phases.has('workbench-seeded');
  let ownerCookie;
  try {
    const handshake = await fetch(listener.ownerURL, { redirect: 'manual' });
    ownerCookie = handshake.headers.get('set-cookie')?.split(';')[0];
    assert.ok(ownerCookie, 'The real Connection must issue an owner transport cookie');
    await wait('ready');
  } catch (error) {
    await stopChild();
    throw error;
  }

  const authority = new URL(listener.baseURL).host;
  async function post(path, payload, cookie, extraHeaders = {}) {
    const response = await fetch(`${listener.baseURL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: authority,
        origin: listener.baseURL,
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(
        path.startsWith('/api/zhuma-exec/')
          ? {
              type: 'client-request',
              rpcId: randomUUID(),
              method: `zhuma-exec/${path.slice('/api/zhuma-exec/'.length)}`,
              payload,
            }
          : payload,
      ),
      redirect: 'manual',
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return { status: response.status, json, headers: response.headers };
  }

  async function upload(declare, options, bytes, memberCookie, signal) {
    const combined = memberCookie ? `${ownerCookie}; ${memberCookie}` : ownerCookie;
    const response = await fetch(`${listener.baseURL}/api/zhuma-exec/upload-file`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        host: authority,
        origin: listener.baseURL,
        cookie: combined,
        'x-zhuma-file-name': encodeURIComponent(declare.name),
        'x-zhuma-file-type': declare.mediaType,
        'x-zhuma-file-size': String(declare.byteSize),
        'x-zhuma-file-sha256': declare.sha256,
        'x-zhuma-space': options.spaceId,
        'x-zhuma-task': options.taskId,
        'x-zhuma-plan': options.planId,
        'x-zhuma-revision': String(options.revision),
        'x-zhuma-node': options.nodeId,
        'x-zhuma-idempotency-key': options.idempotencyKey,
      },
      body: bytes,
      duplex: 'half',
      ...(signal ? { signal } : {}),
      redirect: 'manual',
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json };
  }

  async function exec(endpoint, payload, memberCookie) {
    // Member execution routes sit behind the owner transport cookie plus the
    // member cookie, the same combination a member session carries.
    const combined = memberCookie ? `${ownerCookie}; ${memberCookie}` : ownerCookie;
    const result = await post(`/api/zhuma-exec/${endpoint}`, payload, combined);
    if (result.json?.type !== 'server-response') {
      return { status: result.status, result: null, raw: result.json };
    }
    return { status: result.status, result: result.json.result };
  }

  return {
    baseURL: listener.baseURL,
    ownerCookie,
    boundModule,
    seeded,
    wait,
    act,
    child,
    post,
    exec,
    upload,
    async file(query, memberCookie, signal) {
      const params = new URLSearchParams(
        Object.entries(query).map(([key, value]) => [key, String(value)]),
      );
      const response = await fetch(`${listener.baseURL}/api/zhuma-exec/file?${params}`, {
        headers: {
          host: authority,
          origin: listener.baseURL,
          cookie: memberCookie ? `${ownerCookie}; ${memberCookie}` : ownerCookie,
        },
        ...(signal ? { signal } : {}),
        redirect: 'manual',
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const json = response.headers.get('content-type')?.startsWith('application/json')
        ? JSON.parse(Buffer.from(bytes).toString())
        : undefined;
      return { status: response.status, bytes, json, headers: response.headers };
    },
    async login(memberId, password) {
      const response = await post('/zhuma-id/login', { accountId: memberId, password }, undefined);
      assert.equal(response.status, 200, `login ${memberId}: ${response.status}`);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie, `login ${memberId} must set a member cookie`);
      return cookie;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await act('stop');
      } finally {
        if (child.exitCode === null)
          await new Promise((resolveExit) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolveExit();
            });
          });
      }
    },
  };
}
