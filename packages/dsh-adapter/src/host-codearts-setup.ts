import { symbols, type Context } from '@deepseek-ai/cordis';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createCodeArtsProfileRegistration } from './executors/codearts/registration.js';
import { readPreparedCodeArtsRoute } from './host-codearts-policy.js';
import { readWorkbenchBody, WorkbenchBodyError } from './workbench-http.js';

const commandSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !/[\u0000-\u001f\u007f]/u.test(value) &&
        (isAbsolute(value) || !/[\s/\\|&;<>()$`"']/u.test(value)),
    ),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  entry: z.literal('codearts-acp.js'),
  acpProtocolSdk: z.literal('1.5.1'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const original = (value: unknown): unknown =>
  record(value) ? (Reflect.get(value, symbols.original) ?? value) : value;
type SetupStage =
  | 'request-admission'
  | 'request-origin'
  | 'request-body'
  | 'request-recheck'
  | 'status'
  | 'edit-admission'
  | 'editor'
  | 'acp-entry'
  | 'policy-entry'
  | 'health'
  | 'subprocess'
  | 'resolve-command'
  | 'manifest'
  | 'hash-node'
  | 'hash-adapter'
  | 'hash-launcher'
  | 'hash-policy'
  | 'verify-artifacts'
  | 'register-profile'
  | 'health-before-acp-edit'
  | 'verify-services'
  | 'edit-acp'
  | 'verify-registration'
  | 'health-before-policy-edit'
  | 'edit-policy'
  | 'loader'
  | 'effective-policy';
class SetupError extends Error {
  constructor(
    readonly code: 'unavailable' | 'active-sessions' | 'command-not-found' | 'incomplete',
  ) {
    super('CodeArts setup is unavailable.');
  }
}
interface ConfigEntry {
  options: { id: string; name: string };
}
interface ConfigEditor {
  entries(): ConfigEntry[];
  edit(
    entry: ConfigEntry,
    change: (raw: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

/** Local owner settings, over the ORIGINAL profile editor and ACP registry.
 * A configuration action resolves/hashes executables but never executes them.
 * The stable workbench owns this operation while the policy/ACP entries reload. */
export function openHostCodeArtsSetup(ctx: Context, bundle = new URL('./', import.meta.url)) {
  const lifetime = new AbortController(),
    active = new Set<Promise<Response>>();
  let writing = false,
    closing: Promise<void> | undefined;
  const current = () => {
    lifetime.signal.throwIfAborted();
    ctx.fiber.assertActive();
  };
  function editor(): ConfigEditor {
    const value: unknown = ctx.get('configEditor');
    if (!record(value) || typeof value.entries !== 'function' || typeof value.edit !== 'function')
      throw new SetupError('unavailable');
    return value as unknown as ConfigEditor;
  }
  function entry(source: ConfigEditor, id: string, name: string | readonly string[]) {
    const names = typeof name === 'string' ? [name] : name;
    const rows = source
      .entries()
      .filter((row) => row.options.id === id && names.includes(row.options.name));
    if (rows.length !== 1) throw new SetupError('unavailable');
    return rows[0]!;
  }
  async function assertIdle() {
    current();
    const acp: unknown = ctx.get('dshAcp');
    if (!record(acp) || typeof acp.health !== 'function') throw new SetupError('unavailable');
    // No recheck: the original service returns cached facts, never a CLI probe.
    const health: unknown = await Reflect.apply(acp.health, acp, []);
    current();
    if (
      original(ctx.get('dshAcp')) !== original(acp) ||
      !record(health) ||
      !Array.isArray(health.liveSessions)
    )
      throw new SetupError('unavailable');
    if (health.liveSessions.length) throw new SetupError('active-sessions');
  }
  async function hashArtifact(file: string, maxBytes: number) {
    current();
    const path = await realpath(file),
      metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maxBytes) throw new SetupError('unavailable');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { signal: lifetime.signal })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new SetupError('unavailable');
      hash.update(chunk);
    }
    current();
    return { path, sha256: hash.digest('hex') };
  }
  async function configure(command: string, checkpoint: (stage: SetupStage) => void) {
    checkpoint('edit-admission');
    if (writing) throw new SetupError('incomplete');
    writing = true;
    let registration: Awaited<ReturnType<typeof createCodeArtsProfileRegistration>> | undefined;
    try {
      checkpoint('editor');
      const source = editor();
      checkpoint('acp-entry');
      const acp = entry(source, 'dsh-acp-adapter', '@zaimokuza/dsh-acp-adapter');
      checkpoint('policy-entry');
      const policy = entry(source, 'zhuma-codearts-policy', [
        './lib/zhuma-workbench/codearts-policy.js',
        new URL('codearts-policy.js', bundle).href,
        fileURLToPath(new URL('codearts-policy.js', bundle)),
      ]);
      checkpoint('health');
      await assertIdle();
      checkpoint('subprocess');
      const subprocess: unknown = ctx.get('subprocess');
      if (!record(subprocess) || typeof subprocess.resolveExecutable !== 'function')
        throw new SetupError('unavailable');
      checkpoint('resolve-command');
      const launcher: unknown = await Reflect.apply(subprocess.resolveExecutable, subprocess, [
        command,
        undefined,
        lifetime.signal,
      ]);
      current();
      if (typeof launcher !== 'string' || !isAbsolute(launcher))
        throw new SetupError('command-not-found');
      checkpoint('manifest');
      const manifestFile = new URL('codearts-acp.manifest.json', bundle);
      if ((await stat(manifestFile)).size > 256 * 1024) throw new SetupError('unavailable');
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')));
      checkpoint('hash-node');
      const node = await hashArtifact(process.execPath, 1024 * 1024 * 1024);
      checkpoint('hash-adapter');
      const adapter = await hashArtifact(
        fileURLToPath(new URL(manifest.entry, bundle)),
        32 * 1024 * 1024,
      );
      checkpoint('hash-launcher');
      const launcherArtifact = await hashArtifact(launcher, 256 * 1024 * 1024);
      const artifacts = { node, adapter, launcher: launcherArtifact };
      checkpoint('hash-policy');
      const policyArtifact = await hashArtifact(
        fileURLToPath(new URL('codearts-policy.js', bundle)),
        32 * 1024 * 1024,
      );
      checkpoint('verify-artifacts');
      if (
        artifacts.adapter.sha256 !== manifest.sha256 ||
        policyArtifact.sha256 !== manifest.policySha256
      )
        throw new SetupError('unavailable');
      checkpoint('register-profile');
      registration = await createCodeArtsProfileRegistration({
        ...artifacts,
        signal: lifetime.signal,
      });
      checkpoint('health-before-acp-edit');
      await assertIdle();
      checkpoint('verify-services');
      const currentSubprocess: unknown = ctx.get('subprocess');
      if (
        original(editor()) !== original(source) ||
        original(currentSubprocess) !== original(subprocess)
      )
        throw new SetupError('unavailable');
      const profile = registration.profile,
        profileId = registration.profileId;
      // Preserve all foreign ACP profiles and settings under the original
      // editor's file lock; never reconstruct a redacted settings document.
      checkpoint('edit-acp');
      await source.edit(acp, (raw) => {
        current();
        return {
          ...raw,
          agents: { ...(record(raw.agents) ? raw.agents : {}), [profileId]: profile },
        };
      });
      current();
      checkpoint('verify-registration');
      if (original(editor()) !== original(source) || !registration.isCurrent())
        throw new SetupError('incomplete');
      checkpoint('health-before-policy-edit');
      await assertIdle();
      checkpoint('edit-policy');
      await source.edit(policy, (raw) => {
        current();
        return { ...raw, artifacts };
      });
      current();
      checkpoint('loader');
      const loader: unknown = ctx.get('loader');
      if (!record(loader) || typeof loader.await !== 'function') throw new SetupError('incomplete');
      await Reflect.apply(loader.await, loader, []);
      current();
      checkpoint('effective-policy');
      if (original(editor()) !== original(source) || !readPreparedCodeArtsRoute(ctx))
        throw new SetupError('incomplete');
      return { configured: true };
    } finally {
      registration?.revoke();
      writing = false;
    }
  }
  function admit(request: Request) {
    current();
    if (ctx.connection.requestRejection({ headers: request.headers })) return false;
    const admission = ctx.connection.admit({ headers: request.headers });
    return !('rejection' in admission) && admission.peer.principal.kind === 'owner';
  }
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  async function handle(endpoint: 'status' | 'configure', request: Request): Promise<Response> {
    let stage: SetupStage = 'request-admission';
    const checkpoint = (next: SetupStage) => {
      stage = next;
    };
    try {
      if (!admit(request)) return reply({ ok: false, code: 'untrusted-request' }, 403);
      if (endpoint === 'status') {
        checkpoint('status');
        return reply({ ok: true, value: { configured: !!readPreparedCodeArtsRoute(ctx) } });
      }
      checkpoint('request-origin');
      const origin = request.headers.get('origin');
      if (
        !origin ||
        new URL(origin).origin !== origin ||
        new URL(origin).host !== request.headers.get('host') ||
        request.headers.get('content-type')?.split(';')[0] !== 'application/json'
      )
        return reply({ ok: false, code: 'untrusted-request' }, 403);
      checkpoint('request-body');
      const input = commandSchema.safeParse(
        await readWorkbenchBody(
          request,
          { bodyBytes: 8192, bodyTimeoutMs: 5000 },
          AbortSignal.any([request.signal, lifetime.signal]),
        ),
      );
      if (!input.success) return reply({ ok: false, code: 'invalid-input' }, 400);
      checkpoint('request-recheck');
      if (!admit(request)) return reply({ ok: false, code: 'untrusted-request' }, 403);
      // Once admitted, drain the original durable operation even if the reply
      // is lost. Status on reopening checks the real current producer.
      return reply({ ok: true, value: await configure(input.data.command, checkpoint) });
    } catch (error) {
      if (
        !(error instanceof WorkbenchBodyError) &&
        (!(error instanceof SetupError) || error.code === 'unavailable')
      ) {
        // Fixed labels only: never print an Error, command, path, profile or credential.
        try {
          ctx.logger.error(`CodeArts setup unavailable at ${stage}.`);
        } catch {}
      }
      return reply(
        { ok: false, code: error instanceof SetupError ? error.code : 'unavailable' },
        error instanceof WorkbenchBodyError ? error.status : 409,
      );
    }
  }
  const stops = (['status', 'configure'] as const).map((endpoint) =>
    ctx.connection.fetch.register({
      path: `/api/zhuma-codearts/${endpoint}`,
      methods: [endpoint === 'status' ? 'GET' : 'POST'],
      requestBody: endpoint === 'status' ? 'buffered' : 'streaming',
      fetch(request) {
        const operation = handle(endpoint, request);
        active.add(operation);
        void operation.finally(() => active.delete(operation)).catch(() => undefined);
        return operation;
      },
    }),
  );
  const close = () =>
    (closing ??= (async () => {
      lifetime.abort();
      for (const stop of stops) stop();
      while (active.size) await Promise.allSettled([...active]);
    })());
  ctx.effect(() => close);
  return { close };
}
