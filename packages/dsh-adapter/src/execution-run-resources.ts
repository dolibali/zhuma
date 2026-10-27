import { symbols, type Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { canonicalPayload } from '@zhuma/agent-core';
import { z } from 'zod';
import {
  readExecutionRunComposition,
  type FrozenExecutionRunComposition,
} from './execution-run-composition.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import {
  EXECUTION_RESOURCE_SOURCE_VERSION,
  ExecutionRunResourceError,
  executionResourceToolSchema,
  readExecutionRunResources,
  executionResourceDigest,
  executionResourceToolNames,
  type FrozenMcpResource,
  type ExecutionResourceTool,
} from './execution-run-resource-snapshot.js';
export * from './execution-run-resource-snapshot.js';
function fail(code: ExecutionRunResourceError['code'] = 'resources-mismatch'): never {
  throw new ExecutionRunResourceError(code);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Borrowed Host configuration lease. Its private config is never serialized by this module. */
export interface ExecutionMcpConnectionLease {
  readonly connectionRef: { readonly id: string; readonly version: string };
  readonly signal: AbortSignal;
  readonly config: McpClient.Config;
  assertCurrent(): undefined;
  release(): void;
}
export interface ExecutionRunResourceProducer {
  readonly sourceVersion: typeof EXECUTION_RESOURCE_SOURCE_VERSION;
  readonly signal: AbortSignal;
  /** A checks the original D manager and SAME persisted frozen Run, not a DTO echo. */
  assertCurrent(
    snapshot: FrozenExecutionRunComposition,
    binding: NativeSessionBinding,
    grant: NativeWorkGrant,
  ): undefined;
  /** Called ONLY inside unpublished Agent compose, after durable Run admission. */
  openMcp(resource: FrozenMcpResource, signal: AbortSignal): Promise<ExecutionMcpConnectionLease>;
}
/** Same SDK registration core, with authority supplied by its original purpose owner. */
export interface ExecutionResourceScopeProducer {
  readonly sourceVersion: typeof EXECUTION_RESOURCE_SOURCE_VERSION;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  openMcp(resource: FrozenMcpResource, signal: AbortSignal): Promise<ExecutionMcpConnectionLease>;
}
export interface ExecutionRunResourceAdoption {
  readonly signal: AbortSignal;
  readonly toolAllowlist: readonly string[];
  readonly descriptors: readonly ExecutionResourceTool[];
  readonly ready: Promise<void>;
  /** Waits actual owned provider activation, SDK disposal and borrowed lease release. */
  drain(): Promise<void>;
  dispose(): Promise<void>;
}
const RESOURCE_IO_LIMITS = Object.freeze({
  startupMs: 5000,
  callMs: 5000,
  callsPerAttachment: 64,
  resultBytes: 32_768,
});
function assertion(value: unknown): void {
  if (value !== undefined) {
    void Promise.resolve(value).catch(() => undefined);
    fail('resources-unavailable');
  }
}
/** Public official SDK projection. Never serialize the execute closure or Host configuration. */
export function describeExecutionResourceTool(definition: ToolDefinition): ExecutionResourceTool {
  return describeResourceTool(definition, executionResourceToolSchema);
}
const skillResourceToolSchema = executionResourceToolSchema.extend({ name: z.literal('skill') });
/** The actual SDK loader is a resource tool, but never an MCP snapshot entry. */
export function describeExecutionScopedResourceTool(
  definition: ToolDefinition,
): ExecutionResourceTool {
  return describeResourceTool(
    definition,
    definition.name === 'skill' ? skillResourceToolSchema : executionResourceToolSchema,
  );
}
function describeResourceTool(
  definition: ToolDefinition,
  schema: z.ZodType<ExecutionResourceTool>,
): ExecutionResourceTool {
  const parsed = schema.safeParse({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    outputSchema: definition.output.schema,
    ...(definition.deferLoading === true ? { deferLoading: true } : {}),
  });
  return parsed.success ? freeze(parsed.data) : fail();
}
/** Installs selected resources in the actual unpublished Agent scope; never creates a session. */
export async function registerExecutionRunResources(
  context: Context,
  snapshot: FrozenExecutionRunComposition,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  producer: ExecutionRunResourceProducer,
): Promise<ExecutionRunResourceAdoption> {
  snapshot = readExecutionRunComposition(snapshot);
  if (
    !producer ||
    producer.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION ||
    !(producer.signal instanceof AbortSignal) ||
    !(grant?.signal instanceof AbortSignal) ||
    typeof producer.assertCurrent !== 'function' ||
    typeof producer.openMcp !== 'function'
  )
    fail('resources-unavailable');
  const resources = readExecutionRunResources(
    snapshot.schemaVersion === 2 && snapshot.payload.resources
      ? snapshot.payload.resources
      : { sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION, skills: [], mcp: [] },
  );
  if (
    snapshot.schemaVersion === 1 &&
    (snapshot.payload.handoff.skillRefs.length || snapshot.payload.handoff.mcpRefs.length)
  )
    fail();
  if (
    canonicalPayload(snapshot.payload.scope) !== canonicalPayload(binding.scope) ||
    canonicalPayload(grant.scope) !== canonicalPayload(binding.scope) ||
    canonicalPayload(binding.selection) !==
      canonicalPayload({ ...snapshot.payload.model, configurationId: snapshot.configurationId }) ||
    snapshot.configurationId !== `composition_${executionResourceDigest(snapshot.payload)}`
  )
    fail();
  const sourceSignal = producer.signal,
    sourceCheck = producer.assertCurrent,
    sourceOpen = producer.openMcp;
  return registerExecutionResourceScope(
    context,
    resources,
    grant,
    Object.freeze<ExecutionResourceScopeProducer>({
      sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
      signal: sourceSignal,
      assertCurrent() {
        if (
          producer.signal !== sourceSignal ||
          producer.assertCurrent !== sourceCheck ||
          producer.openMcp !== sourceOpen ||
          producer.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION
        )
          fail('resources-unavailable');
        assertion(sourceCheck.call(producer, snapshot, binding, grant));
        return undefined;
      },
      openMcp: (resource, signal) => sourceOpen.call(producer, resource, signal),
    }),
  );
}

/** Registers actual providers in the same unpublished SDK scope. This is not a
 * grant issuer: each purpose must continuously validate its original live grant. */
export async function registerExecutionResourceScope(
  context: Context,
  rawResources: unknown,
  grant: NativeWorkGrant,
  producer: ExecutionResourceScopeProducer,
): Promise<ExecutionRunResourceAdoption> {
  const scope = scopeOf(context),
    tools = context.get('tools'),
    registeredLookup: unknown = tools && Reflect.get(tools, 'getRegistered'),
    bindSkillRegistry: unknown = Reflect.get(ToolSkill, 'bindSkillRegistry');
  if (
    !scope ||
    !tools ||
    typeof registeredLookup !== 'function' ||
    typeof bindSkillRegistry !== 'function' ||
    !producer ||
    producer.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION ||
    !(producer.signal instanceof AbortSignal) ||
    !(grant?.signal instanceof AbortSignal) ||
    typeof producer.assertCurrent !== 'function' ||
    typeof producer.openMcp !== 'function'
  )
    fail('resources-unavailable');
  const resources = readExecutionRunResources(rawResources);
  const captureMcpClientClose: unknown = Reflect.get(McpClient, 'captureMcpClientClose');
  if (resources.mcp.length && typeof captureMcpClientClose !== 'function')
    fail('resources-unavailable');
  const sourceSignal = producer.signal,
    sourceCheck = producer.assertCurrent,
    sourceOpen = producer.openMcp;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, sourceSignal, grant.signal]);
  const fibers: { dispose(): Promise<void> }[] = [],
    unregister: (() => unknown)[] = [],
    leases: ExecutionMcpConnectionLease[] = [];
  const retainedLeases = new Set<ExecutionMcpConnectionLease>();
  const pending = new Set<Promise<unknown>>();
  const definitions = new Map<string, ToolDefinition>();
  const serviceIdentity = (service: object): object =>
    Reflect.get(service, symbols.original) ?? service;
  const toolIdentity = serviceIdentity(tools);
  const registeredIdentity: unknown = Reflect.get(toolIdentity, 'getRegistered');
  const isolatedServices: { context: Context; name: 'skills' | 'tools'; identity: unknown }[] = [];
  let closing: Promise<void> | undefined,
    published = false,
    calls = 0;
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  const dispose = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    closing = closed;
    lifetime.abort();
    void (async () => {
      const failures: unknown[] = [];
      for (const remove of unregister.reverse())
        try {
          remove();
        } catch (error) {
          failures.push(error);
        }
      for (const fiber of fibers.reverse())
        try {
          await fiber.dispose();
        } catch (error) {
          failures.push(error);
        }
      while (pending.size) await Promise.allSettled([...pending]);
      for (const lease of leases.reverse()) {
        // A failed original close remains owned, even if Cordis contains its
        // finalizer error. Other connections still finish their own cleanup.
        if (retainedLeases.has(lease)) continue;
        try {
          const result: unknown = lease.release();
          if (result !== undefined) {
            await Promise.resolve(result);
            fail('resources-unavailable');
          }
        } catch (error) {
          failures.push(error);
        }
      }
      signal.removeEventListener('abort', onAbort);
      if (failures.length) fail('resources-unavailable');
    })().then(resolve, reject);
    return closed;
  };
  const onAbort = () => {
    void dispose().catch(() => undefined);
  };
  const current = () => {
    try {
      if (
        signal.aborted ||
        closing ||
        producer.signal !== sourceSignal ||
        producer.assertCurrent !== sourceCheck ||
        producer.openMcp !== sourceOpen ||
        producer.sourceVersion !== EXECUTION_RESOURCE_SOURCE_VERSION ||
        !context.get('tools') ||
        serviceIdentity(context.get('tools')!) !== toolIdentity ||
        Reflect.get(toolIdentity, 'getRegistered') !== registeredIdentity ||
        Reflect.get(ToolSkill, 'bindSkillRegistry') !== bindSkillRegistry ||
        (resources.mcp.length > 0 &&
          Reflect.get(McpClient, 'captureMcpClientClose') !== captureMcpClientClose) ||
        isolatedServices.some((item) => {
          const service = item.context.get(item.name);
          return !service || serviceIdentity(service) !== item.identity;
        })
      )
        fail('resources-unavailable');
      grant.assertCurrent('send');
      assertion(sourceCheck.call(producer));
      for (const [name, definition] of definitions) {
        const actual: unknown = registeredLookup.call(tools, name, scope);
        if (actual !== definition) fail('resources-unavailable');
      }
      for (const lease of leases) {
        if (lease.signal.aborted) fail('resources-unavailable');
        assertion(lease.assertCurrent());
      }
    } catch {
      lifetime.abort();
      return fail('resources-unavailable');
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  context.effect(() => dispose, 'zhuma-run-resources');
  try {
    current();
    // These fences belong to the Agent scope, not the resource registration.
    // Keep them after resource disposal so an inherited same-name tool or
    // global explicit-invocation hook can never become a fallback authority.
    context.on('agent/pre-step', async (_payload, next) => {
      current();
      const decision = await next();
      current();
      return decision;
    });
    {
      if (!context.get('workingDirectory')) fail('resources-unavailable');
      const parentLoader = tools.get('skill', scope);
      const isolated = context.isolate('skills');
      const registry = isolated.plugin(SkillRegistry);
      fibers.push(registry);
      await registry;
      const actualRegistry = isolated.get('skills')!;
      isolatedServices.push({
        context: isolated,
        name: 'skills',
        identity: serviceIdentity(actualRegistry),
      });
      current();
      // Bind even an empty real registry to the actual Agent scope before any
      // loader/step. The SDK owns identity, lifetime and no-fallback tombstones.
      const bound: unknown = bindSkillRegistry.call(ToolSkill, context, actualRegistry);
      if (bound !== undefined) {
        // A malformed asynchronous API never authorizes, but its real end is
        // still owned by this registration's failure/drain path.
        void own(Promise.resolve(bound)).catch(() => undefined);
        fail('resources-unavailable');
      }
      current();
      for (const selected of resources.skills)
        unregister.push(
          actualRegistry.register({
            name: selected.name,
            description: selected.description,
            content: selected.definition.content,
            source: 'zhuma-frozen-plan',
            provider: EXECUTION_RESOURCE_SOURCE_VERSION,
            resourceBase: {
              kind: 'opaque',
              description: `Frozen skill ${selected.ref.id} at ${selected.ref.version}; no implicit filesystem access.`,
            },
            invocation: selected.invocation,
          }),
        );
      if (resources.skills.length || resources.mcp.length) {
        const loader = isolated.plugin(ToolSkill);
        fibers.push(loader);
        await loader;
        const definition = tools.get('skill', scope);
        if (!definition || definition === parentLoader) fail('resources-unavailable');
        definitions.set('skill', definition);
      }
    }
    const descriptors: ExecutionResourceTool[] = [];
    for (const selected of resources.mcp) {
      current();
      const waiting = own(
        sourceOpen.call(producer, selected, signal).then((lease) => {
          if (
            !lease ||
            !(lease.signal instanceof AbortSignal) ||
            typeof lease.assertCurrent !== 'function' ||
            typeof lease.release !== 'function'
          )
            fail('resources-unavailable');
          leases.push(lease);
          return lease;
        }),
      );
      const lease = await waiting;
      current();
      if (
        canonicalPayload(lease.connectionRef) !== canonicalPayload(selected.connectionRef) ||
        lease.config.serverName !== selected.serverName
      )
        fail();
      const abort = () => {
        void dispose().catch(() => undefined);
      };
      lease.signal.addEventListener('abort', abort, { once: true });
      unregister.push(() => lease.signal.removeEventListener('abort', abort));
      // A private OFFICIAL registry receives the server's complete tools/list. Only
      // exact selected real definitions are registered on the Agent's public registry.
      // ToolRuntime also registers a model-facing prompt provider. Isolate BOTH
      // official services: private schemas must not enter the Agent's prompt.
      const toolScope = Symbol('zhuma-mcp-private-tools');
      const isolated = context.isolate('tools', toolScope).isolate('systemPrompt');
      const prompt = isolated.plugin(SystemPrompt);
      fibers.push(prompt);
      await prompt;
      current();
      const runtime = isolated.plugin(ToolRuntime);
      fibers.push(runtime);
      await runtime;
      current();
      isolatedServices.push({
        context: isolated,
        name: 'tools',
        identity: serviceIdentity(isolated.get('tools')!),
      });
      isolated.get('tools')!.presentAs('native');
      const timer = setTimeout(() => {
        void dispose().catch(() => undefined);
      }, RESOURCE_IO_LIMITS.startupMs);
      timer.unref();
      try {
        // Keep official attributed server instructions on the real Agent
        // prompt. Only ToolRuntime's full schema provider remains private.
        const connectionContext = context.isolate('tools', toolScope);
        const connection = connectionContext.plugin(McpClient, {
          ...lease.config,
          failOnStartupError: true,
          reconnect: { enabled: false },
          toolCallTimeoutMs: RESOURCE_IO_LIMITS.callMs,
          maxInstructionBytes: 8192,
        });
        let confirmedClose: (() => Promise<void>) | undefined;
        const captureClose = (): (() => Promise<void>) => {
          if (typeof captureMcpClientClose !== 'function') fail('resources-unavailable');
          const owner: unknown = captureMcpClientClose.call(McpClient, connection.ctx);
          const close: unknown = owner && typeof owner === 'object' && Reflect.get(owner, 'close');
          if (typeof close !== 'function') fail('resources-unavailable');
          return async () => {
            const result: unknown = close.call(owner);
            if (!(result instanceof Promise)) fail('resources-unavailable');
            assertion(await result);
          };
        };
        // Cordis starts apply asynchronously. Capture after readiness, or from
        // this same original context during an unpublished startup's cleanup.
        fibers.push({
          async dispose() {
            try {
              await (confirmedClose ?? captureClose())();
              await connection.dispose();
            } catch (error) {
              retainedLeases.add(lease);
              // Best-effort cancellation cannot certify a failed explicit close.
              try {
                await connection.dispose();
              } catch {}
              throw error;
            }
          },
        });
        await connection;
        confirmedClose = captureClose();
      } finally {
        clearTimeout(timer);
      }
      current();
      for (const expected of selected.tools) {
        const actual = isolated.get('tools')!.get(expected.name, scope);
        if (
          !actual ||
          canonicalPayload(describeExecutionResourceTool(actual)) !== canonicalPayload(expected)
        )
          fail();
        descriptors.push(expected);
        const checked: ToolDefinition = {
          ...actual,
          async execute(args, exec) {
            try {
              current();
              if (
                !published ||
                exec.agent !== scope ||
                isolated.get('tools')!.get(expected.name, scope) !== actual ||
                canonicalPayload(describeExecutionResourceTool(actual)) !==
                  canonicalPayload(expected)
              )
                fail();
              const result = await own(Promise.resolve().then(() => actual.execute(args, exec)));
              current();
              if (Buffer.byteLength(canonicalPayload(result)) > RESOURCE_IO_LIMITS.resultBytes)
                fail('resources-budget');
              return result;
            } catch (error) {
              if (error instanceof ExecutionRunResourceError) throw error;
              return fail('resources-unavailable');
            }
          },
        };
        unregister.push(tools.register(checked));
        definitions.set(expected.name, checked);
      }
      const originalDefinitions = selected.tools.map((tool) =>
        isolated.get('tools')!.get(tool.name, scope),
      );
      unregister.push(
        isolated.on(
          'tools/change',
          () => {
            if (!published || closing) return;
            if (
              selected.tools.some(
                (tool, index) =>
                  isolated.get('tools')!.get(tool.name, scope) !== originalDefinitions[index],
              )
            )
              void dispose().catch(() => undefined);
          },
          { global: true },
        ),
      );
    }
    current();
    tools.guard((exec) => {
      // Empty Run domains must not execute an inherited same-name loader.
      // The SDK's separate explicit-invocation hook needs its owner gate too.
      if (exec.name === 'skill' && !definitions.has('skill'))
        return 'execution-resource-not-authorized';
      if (!definitions.has(exec.name)) return undefined;
      try {
        current();
        if (
          exec.agent !== scope ||
          tools.get(exec.name, scope) !== definitions.get(exec.name) ||
          ++calls > RESOURCE_IO_LIMITS.callsPerAttachment
        ) {
          lifetime.abort();
          return 'execution-resource-not-authorized';
        }
        return undefined;
      } catch {
        return 'execution-resource-not-authorized';
      }
    });
    published = true;
    return Object.freeze({
      signal,
      toolAllowlist: Object.freeze(executionResourceToolNames(resources)),
      descriptors: Object.freeze(descriptors),
      ready: Promise.resolve(),
      drain: dispose,
      dispose,
    });
  } catch {
    await dispose();
    return fail('resources-unavailable');
  }
}
