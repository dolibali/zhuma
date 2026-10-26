import { isAbsolute, relative, resolve, sep } from 'node:path';
import { symbols, type Context } from '@deepseek-ai/cordis';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import * as ToolFs from '@deepseek-ai/dsh-tool-fs';
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  readExecutionRunComposition,
  type FrozenExecutionRunComposition,
  type LocalFileToolDefinition,
  type LocalFileToolName,
} from './execution-run-composition.js';
import type {
  NativeSessionBinding,
  NativeWorkGrant,
  NativeWorkScope,
} from './native-work-session-contract.js';
import { describeAcceptedInputTool } from './native-work-session-input-tool.js';

/** Bump on any change to the implementation, fixed tool config or I/O contract. */
export const NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION = 'dsh-tool-fs@0.2.1-rc.2/zhuma-run-local@1';
export const NATIVE_RUN_LOCAL_TOOL_CONFIG = Object.freeze({
  read: true,
  readImage: false,
  write: true,
  edit: true,
  readLimit: 200,
  readMaxLineLength: 2000,
  readMaxBytes: 65_536,
  readStreamMinSize: 65_536,
} satisfies Required<ToolFs.Config>);
export const NATIVE_RUN_LOCAL_IO_LIMITS = Object.freeze({
  operationMs: 5000,
  fileBytes: 1_048_576,
  pathCharacters: 4096,
});
const names = ['read', 'write', 'edit'] as const;
type Action = 'read' | 'write';
export interface NativeRunWorkspaceCapability {
  readonly scope: NativeWorkScope;
  readonly root: string;
  readonly permissions: { readonly read: boolean; readonly write: boolean };
  readonly signal: AbortSignal;
  assertCurrent(action: Action): undefined;
}
export interface NativeRunLocalProducerSource {
  readonly sourceVersion: typeof NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
}
type LocalToolErrorCode =
  | 'local-tools-unavailable'
  | 'local-tools-denied'
  | 'local-tools-mismatch'
  | 'local-tools-budget'
  | 'local-tools-timeout';
export class NativeRunLocalToolError extends HarnessError {
  override readonly code: LocalToolErrorCode;
  constructor(code: LocalToolErrorCode) {
    const messages: Record<LocalToolErrorCode, string> = {
      'local-tools-unavailable': '本地文件工具尚未就绪。',
      'local-tools-denied': '当前运行没有此文件操作权限。',
      'local-tools-mismatch': '文件工具与本次运行配置不匹配。',
      'local-tools-budget': '文件内容超过本次操作的大小上限。',
      'local-tools-timeout': '文件操作超时。',
    };
    super(messages[code], code);
    this.code = code;
    this.name = 'NativeRunLocalToolError';
  }
}
function fail(code: NativeRunLocalToolError['code']): never {
  throw new NativeRunLocalToolError(code);
}
function sync(result: unknown): void {
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => undefined);
    fail('local-tools-denied');
  }
}
function original(value: unknown): unknown {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? (Reflect.get(value, symbols.original) ?? value)
    : value;
}
function descriptor(definition: ToolDefinition): LocalFileToolDefinition {
  return structuredClone({
    name: definition.name as LocalFileToolName,
    description: definition.description,
    parameters: definition.parameters,
    outputSchema: definition.output.schema,
    sourceVersion: NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION,
  });
}
function sameScope(a: NativeWorkScope, b: NativeWorkScope): boolean {
  return canonicalPayload(a) === canonicalPayload(b);
}
function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** Host-only observation of a qualified, already registered official producer. No tool is executed. */
export class NativeRunLocalToolProducer {
  readonly filesystem: FileSystem;
  private readonly toolService: unknown;
  private readonly definitions = new Map<LocalFileToolName, ToolDefinition>();
  constructor(
    readonly context: Context,
    private readonly source: NativeRunLocalProducerSource,
  ) {
    if (!context || typeof context.get !== 'function' || !source) fail('local-tools-unavailable');
    const filesystem = context.get('fs');
    const tools = context.get('tools');
    if (
      !filesystem ||
      !tools ||
      source.sourceVersion !== NATIVE_RUN_LOCAL_TOOL_SOURCE_VERSION ||
      !(source.signal instanceof AbortSignal) ||
      typeof source.assertCurrent !== 'function' ||
      filesystem.sandboxMode !== undefined
    )
      fail('local-tools-unavailable');
    this.filesystem = filesystem;
    this.toolService = original(tools);
    for (const name of names) {
      const definition = tools.get(name);
      if (definition) this.definitions.set(name, definition);
    }
    this.assertCurrent();
  }
  get signal(): AbortSignal {
    return this.source.signal;
  }
  assertCurrent(): void {
    try {
      sync(this.source.assertCurrent());
      if (
        this.source.signal.aborted ||
        original(this.context.get('fs')) !== original(this.filesystem) ||
        original(this.context.get('tools')) !== this.toolService
      )
        fail('local-tools-unavailable');
      for (const [name, definition] of this.definitions)
        if (this.context.get('tools')?.get(name) !== definition) fail('local-tools-mismatch');
    } catch (error) {
      if (error instanceof NativeRunLocalToolError) throw error;
      fail('local-tools-unavailable');
    }
  }
  describe(selected: readonly LocalFileToolName[]): readonly LocalFileToolDefinition[] {
    this.assertCurrent();
    if (
      !selected.includes('read') ||
      selected.length > 3 ||
      new Set(selected).size !== selected.length
    )
      fail('local-tools-mismatch');
    const result = selected.map((name) => {
      const definition = this.definitions.get(name);
      if (!definition || !names.includes(name)) return fail('local-tools-unavailable');
      return descriptor(definition);
    });
    this.assertCurrent();
    return result;
  }
}
export function describeNativeRunLocalTools(
  producer: NativeRunLocalToolProducer,
  selected: readonly LocalFileToolName[],
): readonly LocalFileToolDefinition[] {
  return producer.describe(selected);
}

class RunIo {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly streams = new Set<AsyncGenerator<string>>();
  private streamCloseFailed = false;
  private closing: Promise<void> | undefined;
  root: FsTarget | undefined;
  rootPath = '';
  mounted: (() => boolean) | undefined;
  private readonly scope: NativeWorkScope;
  constructor(
    readonly producer: NativeRunLocalToolProducer,
    readonly workspace: NativeRunWorkspaceCapability,
    readonly grant: NativeWorkGrant,
  ) {
    this.scope = structuredClone(grant.scope);
  }
  check(action: Action): void {
    try {
      if (
        this.lifetime.signal.aborted ||
        this.workspace.signal.aborted ||
        this.grant.signal.aborted ||
        this.workspace.permissions.read !== true ||
        this.workspace.permissions[action] !== true ||
        !sameScope(this.scope, this.workspace.scope) ||
        !sameScope(this.scope, this.grant.scope) ||
        (this.mounted && !this.mounted())
      )
        fail('local-tools-denied');
      this.producer.assertCurrent();
      sync(this.grant.assertCurrent('send'));
      sync(this.workspace.assertCurrent(action));
    } catch (error) {
      if (error instanceof NativeRunLocalToolError) throw error;
      fail('local-tools-denied');
    }
  }
  open(action: Action, caller?: AbortSignal) {
    this.check(action);
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.workspace.signal,
      this.grant.signal,
      this.producer.signal,
      deadline.signal,
      ...(caller ? [caller] : []),
    ]);
    const timer = setTimeout(() => deadline.abort(), NATIVE_RUN_LOCAL_IO_LIMITS.operationMs);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(done);
    return {
      signal,
      check: () => {
        if (deadline.signal.aborted) fail('local-tools-timeout');
        if (signal.aborted) fail('local-tools-denied');
        this.check(action);
      },
      finish: () => {
        clearTimeout(timer);
        this.pending.delete(done);
        finish();
      },
    };
  }
  async operation<T>(
    action: Action,
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const op = this.open(action, caller);
    try {
      op.check();
      const value = await work(op.signal);
      op.check();
      return value;
    } finally {
      op.finish();
    }
  }
  async initialize(): Promise<void> {
    await this.operation('read', undefined, async (signal) => {
      const provider = this.producer.filesystem;
      const root = this.workspace.root;
      if (
        !isAbsolute(root) ||
        root.length > NATIVE_RUN_LOCAL_IO_LIMITS.pathCharacters ||
        provider.processPathFromHostPath(root) === undefined
      )
        fail('local-tools-unavailable');
      const target = await provider.resolve(root, { cwd: root, signal });
      this.check('read');
      const path = provider.processPath(target);
      if (!isAbsolute(path) || (await provider.stat(target, signal))?.type !== 'directory')
        fail('local-tools-unavailable');
      this.check('read');
      this.root = target;
      this.rootPath = resolve(path);
    });
  }
  async target(path: string, action: Action, signal: AbortSignal): Promise<FsTarget> {
    this.check(action);
    const fs = this.producer.filesystem;
    if (
      !this.root ||
      !path ||
      path.length > NATIVE_RUN_LOCAL_IO_LIMITS.pathCharacters ||
      !contained(this.rootPath, resolve(this.rootPath, path))
    )
      fail('local-tools-denied');
    const root = await fs.resolve(this.workspace.root, { cwd: this.workspace.root, signal });
    this.check(action);
    if (resolve(fs.processPath(root)) !== this.rootPath) fail('local-tools-denied');
    const target = await fs.resolve(path, { cwd: this.rootPath, signal });
    this.check(action);
    const actual = fs.processPath(target);
    if (
      !isAbsolute(actual) ||
      !contained(this.rootPath, resolve(actual)) ||
      !fs.contains(root, target)
    )
      fail('local-tools-denied');
    return target;
  }
  async current(target: FsTarget, action: Action, signal: AbortSignal): Promise<FsTarget> {
    return this.target(this.producer.filesystem.processPath(target), action, signal);
  }
  stream(target: FsTarget, caller?: AbortSignal): AsyncGenerator<string> {
    const io = this;
    let stream!: AsyncGenerator<string>;
    stream = (async function* () {
      const op = io.open('read', caller);
      const stop = () => {
        void stream.return(undefined).catch(() => undefined);
      };
      op.signal.addEventListener('abort', stop, { once: true });
      let iterator: AsyncIterator<string> | undefined;
      try {
        const current = await io.current(target, 'read', op.signal);
        op.check();
        const chunks = await io.producer.filesystem.streamText(current, op.signal);
        op.check();
        const source = chunks[Symbol.asyncIterator]();
        iterator = source;
        let bytes = 0;
        while (true) {
          await io.current(current, 'read', op.signal);
          op.check();
          const next = await source.next();
          op.check();
          await io.current(current, 'read', op.signal);
          op.check();
          if (next.done) break;
          bytes += Buffer.byteLength(next.value, 'utf8');
          if (bytes > NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes) fail('local-tools-budget');
          yield next.value;
        }
      } finally {
        try {
          await iterator?.return?.();
        } catch {
          io.streamCloseFailed = true;
          fail('local-tools-unavailable');
        } finally {
          op.signal.removeEventListener('abort', stop);
          io.streams.delete(stream);
          op.finish();
        }
      }
    })();
    this.streams.add(stream);
    return stream;
  }
  facade(): FileSystem {
    const io = this,
      provider = this.producer.filesystem;
    const read = async <T>(
      target: FsTarget,
      signal: AbortSignal | undefined,
      call: (current: FsTarget, signal: AbortSignal) => Promise<T>,
    ) =>
      io.operation('read', signal, async (live) => {
        const current = await io.current(target, 'read', live);
        const value = await call(current, live);
        await io.current(current, 'read', live);
        return value;
      });
    const methods = {
      resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }) =>
        io.operation('read', options?.signal, async (signal) => {
          if (options?.cwd && resolve(options.cwd) !== io.rootPath) fail('local-tools-denied');
          return io.target(path, 'read', signal);
        }),
      stat: (target: FsTarget, signal?: AbortSignal) =>
        read(target, signal, (t, s) => provider.stat(t, s)),
      streamText: async (target: FsTarget, signal?: AbortSignal) => io.stream(target, signal),
      readText: async (target: FsTarget, signal?: AbortSignal) => {
        let result = '';
        for await (const chunk of io.stream(target, signal)) result += chunk;
        return result;
      },
      writeText: (
        target: FsTarget,
        content: string,
        expected?: Parameters<FileSystem['writeText']>[2],
        signal?: AbortSignal,
      ) =>
        io.operation('write', signal, async (live) => {
          if (Buffer.byteLength(content, 'utf8') > NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes)
            fail('local-tools-budget');
          const current = await io.current(target, 'write', live);
          const info = await provider.stat(current, live);
          if (info?.size !== undefined && info.size > NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes)
            fail('local-tools-budget');
          const fresh = await io.current(current, 'write', live);
          const value = await provider.writeText(fresh, content, expected, live);
          await io.current(fresh, 'write', live);
          return value;
        }),
      editText: (
        target: FsTarget,
        edit: Parameters<FileSystem['editText']>[1],
        expected?: Parameters<FileSystem['editText']>[2],
        signal?: AbortSignal,
      ) =>
        io.operation('write', signal, async (live) => {
          if (
            Buffer.byteLength(edit.oldString + edit.newString, 'utf8') >
            NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes
          )
            fail('local-tools-budget');
          const current = await io.current(target, 'write', live);
          const info = await provider.stat(current, live);
          if (info?.size === undefined || info.size > NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes)
            fail('local-tools-budget');
          // Bound the complete replacement, including replace-all amplification.
          // Use CRLF as a conservative storage upper bound; the real provider
          // still owns matching, line-ending restoration and the atomic edit.
          let before = '';
          for await (const chunk of io.stream(current, live)) before += chunk;
          const normalized = before.replaceAll('\r\n', '\n');
          const old = edit.oldString.replaceAll('\r\n', '\n');
          const replacement = edit.newString.replaceAll('\r\n', '\n');
          if (!old) fail('local-tools-denied');
          let occurrences = 0;
          for (let offset = 0; ;) {
            const found = normalized.indexOf(old, offset);
            if (found === -1) break;
            occurrences += 1;
            offset = found + old.length;
          }
          const storageBytes = (text: string) =>
            Buffer.byteLength(text.replaceAll('\n', '\r\n'), 'utf8');
          const projected =
            storageBytes(normalized) +
            occurrences * (storageBytes(replacement) - storageBytes(old));
          if (projected > NATIVE_RUN_LOCAL_IO_LIMITS.fileBytes) fail('local-tools-budget');
          const fresh = await io.current(current, 'write', live);
          const value = await provider.editText(
            fresh,
            edit,
            expected ?? { version: info.version },
            live,
          );
          await io.current(fresh, 'write', live);
          return value;
        }),
    };
    const pathOf = (target: FsTarget) => {
      io.check('read');
      const path = provider.processPath(target);
      if (!isAbsolute(path) || !contained(io.rootPath, resolve(path))) fail('local-tools-denied');
      return path;
    };
    const surface = {
      ...methods,
      processPath: pathOf,
      fileUrl: (target: FsTarget) => {
        pathOf(target);
        return provider.fileUrl(target);
      },
      contains: (parent: FsTarget, child: FsTarget) => {
        pathOf(parent);
        pathOf(child);
        return provider.contains(parent, child);
      },
      processPathFromHostPath: (path: string) => {
        io.check('read');
        if (!isAbsolute(path) || !contained(io.rootPath, resolve(path))) fail('local-tools-denied');
        return provider.processPathFromHostPath(path);
      },
      ...Object.fromEntries(
        ['readBytes', 'readByteRange', 'listDir', 'lstat', 'watch'].map((name) => [
          name,
          () => fail('local-tools-unavailable'),
        ]),
      ),
    };
    const proxy = new Proxy(provider, {
      // Cordis tracing consults property descriptors before a Proxy's get trap.
      // Publish our own method descriptors so tracing cannot recover the raw
      // provider's prototype methods and bypass the Run boundary.
      getOwnPropertyDescriptor(target, property) {
        if (Object.hasOwn(surface, property))
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: Reflect.get(surface, property),
          };
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property) {
        if (property === symbols.original) return proxy;
        if (Object.hasOwn(surface, property)) return Reflect.get(surface, property);
        return Reflect.get(target, property, target);
      },
    });
    return proxy;
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      const returned = await Promise.allSettled(
        [...this.streams].map((stream) => stream.return(undefined)),
      );
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      this.streams.clear();
      if (this.streamCloseFailed || returned.some((result) => result.status === 'rejected'))
        fail('local-tools-unavailable');
    })());
  }
}

export interface NativeRunLocalToolsAdoption {
  readonly toolAllowlist: readonly string[];
  dispose(): Promise<void>;
}
/** Same-process adoption after durable Run start, inside C's unpublished Agent setup. */
export async function adoptNativeRunLocalTools(
  context: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  options: {
    readonly composition: FrozenExecutionRunComposition;
    readonly producer: NativeRunLocalToolProducer;
    readonly workspace: NativeRunWorkspaceCapability;
  },
): Promise<NativeRunLocalToolsAdoption> {
  const saved = readExecutionRunComposition(options.composition);
  const agentScope = scopeOf(context);
  const tools = context.get('tools');
  const { producer, workspace } = options;
  if (
    !producer ||
    !workspace ||
    !workspace.permissions ||
    !grant ||
    !(grant.signal instanceof AbortSignal) ||
    typeof grant.assertCurrent !== 'function'
  )
    fail('local-tools-unavailable');
  const selected = saved.payload.tools;
  if (
    !agentScope ||
    !tools ||
    selected.kind !== 'local-tools' ||
    !sameScope(saved.payload.scope, binding.scope) ||
    !sameScope(grant.scope, binding.scope) ||
    !sameScope(workspace.scope, binding.scope) ||
    !isAbsolute(workspace.root) ||
    !(workspace.signal instanceof AbortSignal) ||
    typeof workspace.assertCurrent !== 'function' ||
    workspace.permissions.read !== true ||
    typeof workspace.permissions.write !== 'boolean' ||
    canonicalPayload({ ...saved.payload.model, configurationId: saved.configurationId }) !==
      canonicalPayload(binding.selection)
  )
    fail('local-tools-mismatch');
  const toolNames = selected.definitions.map((tool) => tool.name);
  if (
    canonicalPayload(producer.describe(toolNames)) !== canonicalPayload(selected.definitions) ||
    (toolNames.some((name) => name !== 'read') && !workspace.permissions.write)
  )
    fail('local-tools-mismatch');
  const io = new RunIo(producer, workspace, grant);
  let fiber: ReturnType<Context['plugin']> | undefined;
  let observation: ReturnType<Context['plugin']> | undefined;
  let unprovide: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const dispose = () =>
    (closing ??= (async () => {
      let failed = false;
      for (const release of [
        () => io.dispose(),
        () => fiber?.dispose(),
        () => observation?.dispose(),
        () => unprovide?.(),
      ]) {
        try {
          await release();
        } catch {
          failed = true;
        }
      }
      if (failed) fail('local-tools-unavailable');
    })());
  context.effect(() => () => dispose());
  try {
    await io.initialize();
    const scoped = context.isolate('fs').isolate('approval');
    const facade = io.facade();
    unprovide = scoped.provide('fs', facade);
    io.mounted = () => original(scoped.get('fs', false)) === facade;
    observation = scoped.plugin(ObservationPolicy);
    await observation;
    fiber = scoped.plugin(ToolFs, {
      ...NATIVE_RUN_LOCAL_TOOL_CONFIG,
      write: toolNames.includes('write'),
      edit: toolNames.includes('edit'),
    });
    await fiber;
    io.check('read');
    const definitions = toolNames.map((name) => {
      const actual = tools.get(name, agentScope);
      if (!actual) return fail('local-tools-mismatch');
      return descriptor(actual);
    });
    if (canonicalPayload(definitions) !== canonicalPayload(selected.definitions))
      fail('local-tools-mismatch');
    if (selected.acceptedInputReader) {
      const declared = describeAcceptedInputTool();
      const actual = tools.get(declared.name, agentScope);
      if (
        !actual ||
        canonicalPayload({
          name: actual.name,
          description: actual.description,
          parameters: actual.parameters,
          outputSchema: actual.output.schema,
          sourceVersion: declared.sourceVersion,
        }) !== canonicalPayload(selected.acceptedInputReader)
      )
        fail('local-tools-mismatch');
    }
    tools.guard((exec) => {
      if (!names.includes(exec.name as LocalFileToolName)) return undefined;
      if (!toolNames.includes(exec.name as LocalFileToolName)) return 'local-tools-denied';
      try {
        io.check(exec.name === 'read' ? 'read' : 'write');
        const args = exec.arguments;
        if (
          !exec.agent ||
          String(exec.agent.session.id) !== binding.nativeSessionId ||
          !args ||
          typeof args !== 'object' ||
          ['sandbox_permissions', 'justification'].some((key) => key in args)
        )
          return 'local-tools-denied';
        return undefined;
      } catch {
        return 'local-tools-denied';
      }
    });
    context.on('tools/execute', async (exec, next) => {
      if (!toolNames.includes(exec.name as LocalFileToolName)) return next();
      return io.operation(exec.name === 'read' ? 'read' : 'write', exec.signal, async (signal) => {
        const prior = exec.signal;
        exec.signal = signal;
        try {
          return await next();
        } finally {
          exec.signal = prior;
        }
      });
    });
    return Object.freeze({
      toolAllowlist: Object.freeze([...saved.payload.toolAllowlist]),
      dispose,
    });
  } catch (error) {
    await dispose();
    if (error instanceof NativeRunLocalToolError) throw error;
    fail('local-tools-unavailable');
  }
}
