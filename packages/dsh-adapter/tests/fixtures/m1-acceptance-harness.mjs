import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

/**
 * Acceptance harness over the real Host subprocess fixture: real Connection,
 * credentials, JSON storage domains and member cookies. A confirmed plan is
 * seeded through `workbenchSeed` before the Host mounts; that preparation is
 * a Host-level act recorded in the suite, never a member impersonation.
 */
export async function startAcceptanceHost(directory, config) {
  const child = fork(fileURLToPath(new URL('./s1a-host-process.mjs', import.meta.url)), [], {
    cwd: directory,
    env: { PATH: process.env.PATH },
    silent: true,
  });
  const phases = new Map();
  const waits = new Map();
  const actions = new Map();
  let diagnostics = '';
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
      const timer = setTimeout(() => reject(Error(`Host action timed out: ${action}`)), 10000);
      actions.set(id, (message) => {
        clearTimeout(timer);
        actions.delete(id);
        message.error ? reject(Error(message.error)) : resolveAction(message.value);
      });
    });
    child.send({ id, action, ...extra });
    return response;
  };
  const { identityImport, spaceDirectoryImport, workbenchSeed, ...publicConfig } = config;
  child.send({
    type: 'boot',
    options: {
      directory,
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
      ...(spaceDirectoryImport === undefined ? {} : { spaceDirectoryImport }),
      ...(workbenchSeed === undefined ? {} : { workbenchSeed }),
    },
  });
  const listener = await wait('listening');
  const handshake = await fetch(listener.ownerURL, { redirect: 'manual' });
  const ownerCookie = handshake.headers.get('set-cookie')?.split(';')[0];
  assert.ok(ownerCookie, 'The real Connection must issue an owner transport cookie');
  await wait('ready');

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
    wait,
    act,
    child,
    post,
    exec,
    async login(memberId, password) {
      const response = await post('/zhuma-id/login', { accountId: memberId, password }, undefined);
      assert.equal(response.status, 200, `login ${memberId}: ${response.status}`);
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie, `login ${memberId} must set a member cookie`);
      return cookie;
    },
    async close() {
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
