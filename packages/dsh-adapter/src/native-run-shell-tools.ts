import { isAbsolute, relative, resolve, sep } from 'node:path';
import { symbols, type Context } from '@deepseek-ai/cordis';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import LocalBash from '@deepseek-ai/dsh-bash-local';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';
import type { ShellExecutor, ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell';
import {
  SENSITIVE_ENV_PATTERN,
  type SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';
import type {} from '@deepseek-ai/dsh-shell-env';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  readExecutionRunComposition,
  type ForegroundShellToolDefinition,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';

export const NATIVE_RUN_SHELL_SOURCE_VERSION = 'dsh-tool-bash@0.2.1-rc.2/zhuma-foreground@2';
export const NATIVE_RUN_SHELL_CONFIG = Object.freeze({
  enableRunInBackground: false,
  promoteOnTimeout: false,
});
export const NATIVE_RUN_SHELL_LIMITS = Object.freeze({
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  setupMs: 5000,
  commands: 32,
  commandBytes: 16_384,
  outputBytes: 65_536,
  graceMs: 250,
  drainProbeMs: 5000,
});

/** Host-only explicit local process authority, NOT a workspace file permission or an isolation claim. */
export interface NativeRunShellCapability {
  readonly authority: 'local-host-process';
  readonly scope: NativeWorkScope;
  readonly root: string;
  readonly signal: AbortSignal;
  assertCurrent(action: 'execute'): undefined;
  /** Actual original member lease expiry and optional existing Run deadline, never manufactured from config. */
  deadlines(): { readonly memberExpiresAt: number; readonly runDeadlineAt?: number | undefined };
}
export interface NativeRunShellProducerSource {
  readonly sourceVersion: typeof NATIVE_RUN_SHELL_SOURCE_VERSION;
  readonly signal: AbortSignal;
  /** Qualifies the actual same-host local providers, current policy and source lifetime. */
  assertCurrent(): undefined;
}
type Code =
  | 'local-shell-unavailable'
  | 'local-shell-denied'
  | 'local-shell-mismatch'
  | 'local-shell-budget'
  | 'local-shell-timeout';
export class NativeRunShellError extends HarnessError {
  override readonly code: Code;
  constructor(code: Code) {
    super(
      {
        'local-shell-unavailable': '本机命令工具尚未就绪或资源未确认排空。',
        'local-shell-denied': '当前运行没有此本机命令执行权限。',
        'local-shell-mismatch': '本机命令工具与本次运行配置不匹配。',
        'local-shell-budget': '本次命令超过运行预算。',
        'local-shell-timeout': '本机命令执行超时。',
      }[code],
      code,
    );
    this.code = code;
    this.name = 'NativeRunShellError';
  }
}
function fail(code: Code): never {
  throw new NativeRunShellError(code);
}
function synchronous(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    fail('local-shell-denied');
  }
}
function original(value: unknown): unknown {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? (Reflect.get(value, symbols.original) ?? value)
    : value;
}
function sameScope(a: NativeWorkScope, b: NativeWorkScope): boolean {
  return canonicalPayload(a) === canonicalPayload(b);
}
function descriptor(tool: ToolDefinition): ForegroundShellToolDefinition {
  return structuredClone({
    name: 'bash',
    description: tool.description,
    parameters: tool.parameters,
    outputSchema: tool.output.schema,
    sourceVersion: NATIVE_RUN_SHELL_SOURCE_VERSION,
    budget: {
      defaultTimeoutMs: NATIVE_RUN_SHELL_LIMITS.defaultTimeoutMs,
      maxTimeoutMs: NATIVE_RUN_SHELL_LIMITS.maxTimeoutMs,
      maxAttempts: NATIVE_RUN_SHELL_LIMITS.commands,
    },
  });
}
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
/** Cordis tracing must see these own descriptors, rather than raw provider prototype methods. */
function facade<T extends object>(provider: T, surface: Record<string, unknown>): T {
  const proxy = new Proxy(provider, {
    getOwnPropertyDescriptor(target, key) {
      return Object.hasOwn(surface, key)
        ? {
            configurable: true,
            enumerable: true,
            writable: false,
            value: Reflect.get(surface, key),
          }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key) {
      if (key === symbols.original) return proxy;
      return Object.hasOwn(surface, key)
        ? Reflect.get(surface, key)
        : Reflect.get(target, key, target);
    },
  });
  return proxy;
}

/** Observation of an already mounted official, foreground-only producer; does not spawn or read files. */
export class NativeRunShellProducer {
  readonly filesystem: FileSystem;
  readonly subprocess: SubprocessRuntime;
  private readonly services: readonly (readonly [string, unknown])[];
  private readonly definition: ToolDefinition;
  private readonly executor: ShellExecutor;
  private readonly sourceScope: ReturnType<typeof scopeOf>;
  constructor(
    readonly context: Context,
    private readonly source: NativeRunShellProducerSource,
  ) {
    const fs = context.get('fs'),
      subprocess = context.get('subprocess'),
      shell = context.get('shell');
    this.sourceScope = scopeOf(context);
    const definition = context.get('tools')?.get('bash', this.sourceScope);
    if (
      !fs ||
      !subprocess ||
      !shell ||
      !context.get('shellEnv') ||
      !definition ||
      !source ||
      source.sourceVersion !== NATIVE_RUN_SHELL_SOURCE_VERSION ||
      !(source.signal instanceof AbortSignal) ||
      typeof source.assertCurrent !== 'function'
    )
      fail('local-shell-unavailable');
    this.filesystem = fs;
    this.subprocess = subprocess;
    this.definition = definition;
    this.executor = shell;
    this.services = ['fs', 'subprocess', 'shell', 'shellEnv', 'tools'].map((name) => [
      name,
      original(context.get(name)),
    ]);
    this.assertCurrent();
  }
  get signal(): AbortSignal {
    return this.source.signal;
  }
  assertCurrent(): void {
    try {
      synchronous(this.source.assertCurrent());
      if (
        this.source.signal.aborted ||
        this.context.get('shell')?.sandboxMode !== undefined ||
        this.filesystem.sandboxMode !== undefined ||
        this.services.some(([name, service]) => original(this.context.get(name)) !== service) ||
        this.context.get('tools')?.get('bash', this.sourceScope) !== this.definition
      )
        fail('local-shell-unavailable');
    } catch (error) {
      if (error instanceof NativeRunShellError) throw error;
      fail('local-shell-unavailable');
    }
  }
  describe(): ForegroundShellToolDefinition {
    this.assertCurrent();
    return descriptor(this.definition);
  }
  /** Resolve only the actual original provider's timeout/signal; never launch through it. */
  resolveBudget(request: ShellExecRequest): Pick<ShellExecSpec, 'timeoutMs' | 'signal'> {
    this.assertCurrent();
    try {
      const resolved = this.executor.resolve(request);
      this.assertCurrent();
      if (
        !Number.isFinite(resolved.timeoutMs) ||
        resolved.timeoutMs <= 0 ||
        resolved.onExpiry !== 'kill' ||
        resolved.sandboxPolicy !== undefined ||
        (resolved.signal !== undefined && !(resolved.signal instanceof AbortSignal))
      )
        fail('local-shell-unavailable');
      return { timeoutMs: resolved.timeoutMs, signal: resolved.signal };
    } catch (error) {
      if (error instanceof NativeRunShellError) throw error;
      fail('local-shell-unavailable');
    }
  }
}
export function describeNativeRunShellTool(
  producer: NativeRunShellProducer,
): ForegroundShellToolDefinition {
  return producer.describe();
}

export interface NativeRunShellAdoption {
  readonly toolAllowlist: readonly string[];
  dispose(): Promise<void>;
}
/** Post-durability, unpublished setup. The Host first adopts the saved file/reader tools. */
export async function adoptNativeRunShellTool(
  context: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  options: {
    readonly composition: FrozenExecutionRunComposition;
    readonly producer: NativeRunShellProducer;
    readonly capability: NativeRunShellCapability;
  },
): Promise<NativeRunShellAdoption> {
  const saved = readExecutionRunComposition(options.composition),
    { producer, capability } = options;
  const scope = scopeOf(context),
    tools = context.get('tools');
  if (
    !scope ||
    !tools ||
    saved.payload.tools.kind !== 'local-tools' ||
    !saved.payload.tools.shell ||
    !capability ||
    capability.authority !== 'local-host-process' ||
    !(capability.signal instanceof AbortSignal) ||
    typeof capability.assertCurrent !== 'function' ||
    typeof capability.deadlines !== 'function' ||
    !isAbsolute(capability.root) ||
    !sameScope(saved.payload.scope, binding.scope) ||
    !sameScope(grant.scope, binding.scope) ||
    !sameScope(capability.scope, binding.scope) ||
    canonicalPayload(binding.selection) !==
      canonicalPayload({ ...saved.payload.model, configurationId: saved.configurationId }) ||
    canonicalPayload(producer.describe()) !== canonicalPayload(saved.payload.tools.shell)
  )
    fail('local-shell-mismatch');
  const fixedScope = structuredClone(binding.scope),
    lifetime = new AbortController();
  const grantedRoot = capability.root,
    nativeSessionId = binding.nativeSessionId;
  const handles = new Set<SubprocessHandle>(),
    pending = new Set<Promise<void>>();
  let rootTarget: FsTarget | undefined,
    root = '',
    commands = 0;
  let active: AbortSignal | undefined, activeCwd: string | undefined;
  let activeRequest: ShellExecRequest | undefined,
    activeStartedAt = 0,
    activeUntil = Infinity;
  let activeDeadline: AbortController | undefined,
    activeTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined,
    failedDrain = false;
  let localFiber: ReturnType<Context['plugin']> | undefined,
    toolFiber: ReturnType<Context['plugin']> | undefined;
  let unprovideRuntime: (() => void) | undefined, unprovideShell: (() => void) | undefined;
  let mounted: (() => boolean) | undefined;
  const hostDeadline = () => {
    try {
      const value = capability.deadlines();
      if (value && typeof Reflect.get(value, 'then') === 'function') {
        void Promise.resolve(value).catch(() => undefined);
        fail('local-shell-unavailable');
      }
      if (
        !value ||
        !Number.isSafeInteger(value.memberExpiresAt) ||
        (value.runDeadlineAt !== undefined && !Number.isSafeInteger(value.runDeadlineAt))
      )
        fail('local-shell-unavailable');
      if (value.memberExpiresAt <= Date.now()) fail('local-shell-denied');
      if (value.runDeadlineAt !== undefined && value.runDeadlineAt <= Date.now())
        fail('local-shell-budget');
      return Math.min(value.memberExpiresAt, value.runDeadlineAt ?? Infinity);
    } catch (error) {
      if (error instanceof NativeRunShellError) throw error;
      fail('local-shell-unavailable');
    }
  };
  // A command's cutoff can only shrink. Awaiting cwd or re-resolving a provider
  // never buys a fresh timeout window or extends the original member lease.
  const shorten = (until: number) => {
    if (!activeDeadline || until >= activeUntil) return;
    activeUntil = until;
    clearTimeout(activeTimer);
    const deadline = activeDeadline;
    const remaining = until - Date.now();
    if (remaining <= 0) deadline.abort();
    else activeTimer = setTimeout(() => deadline.abort(), remaining);
  };
  const providerBudget = (request: ShellExecRequest) => {
    const budget = producer.resolveBudget(request);
    shorten(
      Math.min(
        activeStartedAt +
          Math.min(
            request.timeoutMs ?? NATIVE_RUN_SHELL_LIMITS.defaultTimeoutMs,
            NATIVE_RUN_SHELL_LIMITS.maxTimeoutMs,
            budget.timeoutMs,
          ),
        hostDeadline(),
      ),
    );
    if (budget.signal && active) active = AbortSignal.any([active, budget.signal]);
  };
  const check = () => {
    try {
      if (failedDrain) fail('local-shell-unavailable');
      if (
        lifetime.signal.aborted ||
        capability.signal.aborted ||
        grant.signal.aborted ||
        capability.authority !== 'local-host-process' ||
        capability.root !== grantedRoot ||
        !sameScope(fixedScope, capability.scope) ||
        !sameScope(fixedScope, grant.scope) ||
        (mounted && !mounted())
      )
        fail('local-shell-denied');
      producer.assertCurrent();
      synchronous(grant.assertCurrent('send'));
      synchronous(capability.assertCurrent('execute'));
      shorten(hostDeadline());
    } catch (error) {
      if (error instanceof NativeRunShellError) throw error;
      fail('local-shell-denied');
    }
  };
  const drain = async () => {
    const outcomes = await Promise.allSettled(
      [...handles].map(async (handle) => {
        handle.terminate();
        if (!(await handle.waitForExit(AbortSignal.timeout(NATIVE_RUN_SHELL_LIMITS.drainProbeMs))))
          fail('local-shell-unavailable');
        await handle.done.catch(() => undefined);
        handles.delete(handle);
      }),
    );
    if (outcomes.some((result) => result.status === 'rejected')) {
      failedDrain = true;
      fail('local-shell-unavailable');
    }
  };
  const dispose = () =>
    (closing ??= (async () => {
      lifetime.abort();
      let failed = false;
      for (const release of [
        () => drain(),
        async () => {
          while (pending.size) await Promise.allSettled([...pending]);
        },
        () => drain(),
        () => toolFiber?.dispose(),
        () => unprovideShell?.(),
        () => localFiber?.dispose(),
        () => unprovideRuntime?.(),
      ]) {
        try {
          await release();
        } catch {
          failed = true;
        }
      }
      if (failed || failedDrain || handles.size) fail('local-shell-unavailable');
    })());
  context.effect(() => () => dispose());
  const fs = producer.filesystem;
  const cwd = async (path: string, signal: AbortSignal): Promise<string> => {
    check();
    signal.throwIfAborted();
    if (!rootTarget || !inside(root, resolve(root, path))) fail('local-shell-denied');
    const currentRoot = await fs.resolve(capability.root, { cwd: capability.root, signal });
    check();
    signal.throwIfAborted();
    if (resolve(fs.processPath(currentRoot)) !== root) fail('local-shell-denied');
    const target = await fs.resolve(path, { cwd: root, signal });
    check();
    signal.throwIfAborted();
    const actual = fs.processPath(target);
    if (
      !isAbsolute(actual) ||
      !inside(root, resolve(actual)) ||
      !fs.contains(currentRoot, target) ||
      (await fs.stat(target, signal))?.type !== 'directory'
    )
      fail('local-shell-denied');
    check();
    signal.throwIfAborted();
    return resolve(actual);
  };
  try {
    check();
    const initSignal = AbortSignal.any([
      lifetime.signal,
      capability.signal,
      grant.signal,
      producer.signal,
      AbortSignal.timeout(NATIVE_RUN_SHELL_LIMITS.setupMs),
    ]);
    if (fs.processPathFromHostPath(capability.root) === undefined) fail('local-shell-unavailable');
    rootTarget = await fs.resolve(capability.root, { cwd: capability.root, signal: initSignal });
    check();
    initSignal.throwIfAborted();
    const actualRoot = fs.processPath(rootTarget);
    if (!isAbsolute(actualRoot)) fail('local-shell-unavailable');
    root = resolve(actualRoot);
    await cwd(root, initSignal);
    const runtime = facade(producer.subprocess, {
      spawn: (spec: SubprocessSpawnSpec) => {
        check();
        active?.throwIfAborted();
        const command = spec.argv[2];
        if (
          !active ||
          !activeCwd ||
          spec.cwd !== activeCwd ||
          spec.argv.length !== 3 ||
          spec.argv[0] !== 'bash' ||
          spec.argv[1] !== '-c' ||
          typeof command !== 'string' ||
          Buffer.byteLength(command, 'utf8') > NATIVE_RUN_SHELL_LIMITS.commandBytes
        )
          fail('local-shell-denied');
        const handle = producer.subprocess.spawn({
          ...spec,
          signal: AbortSignal.any([active, ...(spec.signal ? [spec.signal] : [])]),
          graceMs: NATIVE_RUN_SHELL_LIMITS.graceMs,
          env: Object.fromEntries(
            Object.entries(spec.env ?? {}).filter(([name]) => !SENSITIVE_ENV_PATTERN.test(name)),
          ),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes },
            stderr: { maxBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes },
          },
        });
        handles.add(handle);
        return handle;
      },
      spawnTerminal: () => fail('local-shell-denied'),
      resolveExecutable: () => fail('local-shell-denied'),
      terminalEnvironment: () => fail('local-shell-denied'),
    });
    const local = context.isolate('shell').isolate('subprocess');
    unprovideRuntime = local.provide('subprocess', runtime);
    localFiber = local.plugin(LocalBash, {
      cwd: root,
      timeoutMs: NATIVE_RUN_SHELL_LIMITS.defaultTimeoutMs,
      maxTimeoutMs: NATIVE_RUN_SHELL_LIMITS.maxTimeoutMs,
      maxOutputBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes,
      maxSpillBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes,
      graceMs: NATIVE_RUN_SHELL_LIMITS.graceMs,
    });
    await localFiber;
    check();
    const shell = local.get('shell');
    if (!shell) fail('local-shell-unavailable');
    const controlled: ShellExecutor = facade(shell, {
      resolve: (request: ShellExecRequest): ShellExecSpec => {
        check();
        if (
          !active ||
          request.onExpiry === 'none' ||
          request.sandboxPolicy !== undefined ||
          Buffer.byteLength(request.command, 'utf8') > NATIVE_RUN_SHELL_LIMITS.commandBytes
        )
          fail('local-shell-denied');
        providerBudget(request);
        active?.throwIfAborted();
        return shell.resolve({
          ...request,
          onExpiry: 'kill',
          signal: active,
          timeoutMs: Math.max(1, activeUntil - Date.now()),
          stdoutMaxBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes,
        });
      },
      execute: async (spec: ShellExecSpec) => {
        check();
        if (!active || spec.onExpiry !== 'kill' || spec.sandboxPolicy !== undefined)
          fail('local-shell-denied');
        activeCwd = await cwd(spec.workdir, active);
        check();
        if (!activeRequest) fail('local-shell-denied');
        providerBudget(activeRequest);
        active.throwIfAborted();
        return shell.execute({
          ...spec,
          workdir: activeCwd,
          signal: active,
          timeoutMs: Math.min(spec.timeoutMs, Math.max(1, activeUntil - Date.now())),
          stdoutMaxBytes: NATIVE_RUN_SHELL_LIMITS.outputBytes,
        });
      },
    });
    const toolContext = local.isolate('shell');
    unprovideShell = toolContext.provide('shell', controlled);
    mounted = () =>
      original(toolContext.get('shell', false)) === controlled &&
      original(local.get('subprocess', false)) === runtime;
    toolFiber = toolContext.plugin(ToolBash, NATIVE_RUN_SHELL_CONFIG);
    await toolFiber;
    check();
    const actual = tools.get('bash', scope);
    if (
      !actual ||
      canonicalPayload(descriptor(actual)) !== canonicalPayload(saved.payload.tools.shell)
    )
      fail('local-shell-mismatch');
    tools.guard((exec) => {
      if (exec.name !== 'bash') return undefined;
      try {
        check();
        const args = exec.arguments;
        if (
          !exec.agent ||
          String(exec.agent.session.id) !== nativeSessionId ||
          !args ||
          typeof args !== 'object' ||
          ['sandbox_permissions', 'justification'].some((key) => key in args) ||
          Reflect.get(args, 'run_in_background') === true
        )
          return 'local-shell-denied';
        return undefined;
      } catch {
        return 'local-shell-denied';
      }
    });
    context.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'bash') return next();
      check();
      if (active) fail('local-shell-denied');
      if (commands >= NATIVE_RUN_SHELL_LIMITS.commands) fail('local-shell-budget');
      commands += 1;
      const args = exec.arguments;
      if (!args || typeof args !== 'object' || typeof Reflect.get(args, 'command') !== 'string')
        fail('local-shell-denied');
      const timeoutMs: unknown = Reflect.get(args, 'timeoutMs');
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      )
        fail('local-shell-denied');
      const request: ShellExecRequest = {
        command: Reflect.get(args, 'command'),
        signal: exec.signal,
        onExpiry: 'kill',
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      };
      const startedAt = Date.now();
      const originalBudget = producer.resolveBudget(request);
      const until = Math.min(
        startedAt +
          Math.min(
            request.timeoutMs ?? NATIVE_RUN_SHELL_LIMITS.defaultTimeoutMs,
            NATIVE_RUN_SHELL_LIMITS.maxTimeoutMs,
            originalBudget.timeoutMs,
          ),
        hostDeadline(),
      );
      const deadline = new AbortController();
      activeStartedAt = startedAt;
      activeUntil = Infinity;
      activeDeadline = deadline;
      activeRequest = request;
      active = AbortSignal.any([
        lifetime.signal,
        grant.signal,
        capability.signal,
        producer.signal,
        exec.signal,
        deadline.signal,
        ...(originalBudget.signal ? [originalBudget.signal] : []),
      ]);
      shorten(until);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(done);
      const prior = exec.signal;
      exec.signal = active;
      try {
        const result = await next();
        await drain();
        if (deadline.signal.aborted) fail('local-shell-timeout');
        active.throwIfAborted();
        check();
        return result;
      } catch (error) {
        if (deadline.signal.aborted) fail('local-shell-timeout');
        if (error instanceof NativeRunShellError) throw error;
        fail(active?.aborted ? 'local-shell-denied' : 'local-shell-unavailable');
      } finally {
        try {
          await drain();
        } finally {
          clearTimeout(activeTimer);
          exec.signal = prior;
          active = undefined;
          activeCwd = undefined;
          activeRequest = undefined;
          activeDeadline = undefined;
          activeTimer = undefined;
          activeUntil = Infinity;
          pending.delete(done);
          finish();
        }
      }
    });
    return Object.freeze({
      toolAllowlist: Object.freeze([...saved.payload.toolAllowlist]),
      dispose,
    });
  } catch (error) {
    await dispose();
    if (error instanceof NativeRunShellError) throw error;
    fail('local-shell-unavailable');
  }
}
