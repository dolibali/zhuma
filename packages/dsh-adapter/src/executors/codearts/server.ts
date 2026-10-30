import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CodeArtsHttpClient } from './http.js';
import type { CodeArtsMcpPolicy } from './policy.js';
import { deferred } from './deferred.js';

export class CodeArtsServerError extends Error {
  constructor(
    readonly code:
      'not-installed' | 'start-failed' | 'start-timeout' | 'unsupported-version' | 'server-exited',
  ) {
    super(`CodeArts ${code}`);
    this.name = 'CodeArtsServerError';
  }
}
export interface CodeArtsServer {
  readonly client: CodeArtsHttpClient;
  readonly signal: AbortSignal;
  /** Main process termination only. Outer official Subprocess proves the managed range. */
  close(): Promise<void>;
}

/** One owned external-agent descendant; never detaches from the official managed range. */
export async function startCodeArtsServer(input: {
  readonly command: string;
  readonly directory: string;
  readonly policy: CodeArtsMcpPolicy;
  readonly signal: AbortSignal;
}): Promise<CodeArtsServer> {
  if (
    !isAbsolute(input.command) ||
    !isAbsolute(input.directory) ||
    /\.(?:bat|cmd)$/iu.test(input.command)
  )
    throw new CodeArtsServerError('not-installed');
  input.signal.throwIfAborted();
  const username = 'zhuma-owned-codearts';
  const password = randomBytes(32).toString('base64url');
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const origin = deferred<string>();
  const exited = deferred<void>();
  let child: ChildProcess;
  try {
    child = spawn(input.command, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: input.directory,
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // This external agent forwards the normal CLI environment. Credentials
      // remain solely with the official CLI; no profile/store is read here.
      env: {
        ...process.env,
        CODEARTS_SERVER_USERNAME: username,
        CODEARTS_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: input.policy.processConfig,
        ENABLE_TOOL_LAZY_LOADING: 'false',
      },
    });
  } catch {
    throw new CodeArtsServerError('not-installed');
  }
  let done = false;
  let closing: Promise<void> | undefined;
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8192);
    const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(output);
    if (match) {
      origin.resolve(match[0]);
      output = '';
    }
  });
  // Consume private diagnostics without reflecting them into ACP or logs.
  child.stderr?.resume();
  const markExited = (): void => {
    done = true;
    exited.resolve();
    origin.reject(new CodeArtsServerError('start-failed'));
    lifetime.abort(new CodeArtsServerError('server-exited'));
  };
  child.once('error', markExited);
  child.once('exit', markExited);
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (!done) {
        child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited.promise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 3000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!done) {
          child.kill('SIGKILL');
          await exited.promise;
        }
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      lifetime.abort();
    })());
  const abort = (): void => {
    void close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const startup = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const ready = await Promise.race([
      origin.promise,
      new Promise<never>((_resolve, reject) => {
        startup.addEventListener('abort', () => reject(new CodeArtsServerError('start-timeout')), {
          once: true,
        });
      }),
    ]);
    const client = new CodeArtsHttpClient({
      origin: ready,
      basicAuthorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      directory: input.directory,
    });
    const health = await client.health(startup);
    if (health.version !== '26.10.13') throw new CodeArtsServerError('unsupported-version');
    return {
      client,
      signal,
      async close() {
        signal.removeEventListener('abort', abort);
        await close();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', abort);
    await close();
    throw error instanceof CodeArtsServerError ? error : new CodeArtsServerError('start-failed');
  }
}
