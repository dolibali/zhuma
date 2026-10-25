import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import type {
  ExecutionCaller,
  ExecutionService,
  UpstreamContentValue,
} from './execution-service.js';
import type { UpstreamInputView, VisibleUpstreamInput } from './upstream-inputs.js';
import {
  NativeWorkError,
  type NativeSessionBinding,
  type NativeWorkGrant,
  type NativeWorkScope,
} from './native-work-session-contract.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import {
  NATIVE_INPUT_READ_LIMITS,
  nativeWorkSessionKey,
  type NativeWorkSessionService,
} from './native-work-session.js';

export const ACCEPTED_INPUT_TOOL = 'read_accepted_input';
const WAIT_MS = 5_000;
const scopeKey = (s: NativeWorkScope) =>
  JSON.stringify([nativeWorkSessionKey(s), s.runId, s.generation, s.segmentId]);
const id = z.string().min(1).max(200);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const scopeSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  nodeId: id,
  runId: id,
  generation: positive,
  segmentId: id,
});
const inputSchema = z.discriminatedUnion('access', [
  z.strictObject({
    access: z.literal('visible'),
    blocking: z.boolean(),
    sourceNodeId: id,
    artifactVersionId: id,
    sourceGoal: z.string().max(2000).optional(),
    version: positive,
    name: z.string().max(200),
  }),
  z.strictObject({
    access: z.literal('pending'),
    blocking: z.boolean(),
    sourceNodeId: id,
    pending: z.enum(['none', 'replaced']),
    message: z.string().max(2000),
  }),
  z.strictObject({
    access: z.literal('hidden'),
    blocking: z.boolean(),
    count: positive,
    message: z.string().max(2000),
  }),
]);
const catalogSchema = z.strictObject({
  scope: scopeSchema,
  inputs: z.array(z.strictObject({ input: inputSchema, required: z.boolean() })).max(100),
});
const argumentsSchema = z.strictObject({
  inputRef: z.string().regex(/^input_[a-f0-9]{64}$/),
  part: z.enum(['text', 'links']),
  offset: z.number().int().nonnegative().refine(Number.isSafeInteger).optional(),
  limit: positive.optional(),
});
const sourceSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: positive,
  downstreamNodeId: id,
  sourceNodeId: id,
  artifactVersionId: id,
  version: positive,
});
const rangeSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative(),
});
const errors = [
  'invalid-arguments',
  'input-unavailable',
  'cancelled',
  'read-timeout',
  'input-read-busy',
  'input-read-budget-exceeded',
  'output-too-large',
] as const;
type InputError = (typeof errors)[number];
const errorSchema = z.strictObject({ ok: z.literal(false), code: z.enum(errors) });
const textOutputSchema = z.strictObject({
  ok: z.literal(true),
  inputRef: argumentsSchema.shape.inputRef,
  part: z.literal('text'),
  source: sourceSchema,
  range: rangeSchema,
  text: z.string().max(8192),
});
const linksOutputSchema = z.strictObject({
  ok: z.literal(true),
  inputRef: argumentsSchema.shape.inputRef,
  part: z.literal('links'),
  source: sourceSchema,
  range: rangeSchema,
  links: z.array(z.string()).max(5),
});
const outputSchema = z.union([textOutputSchema, linksOutputSchema, errorSchema]);
type InputOutput = z.infer<typeof outputSchema>;

export interface NativeAcceptedInputToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
  readonly outputSchema: JsonSchemaNode;
  readonly sourceVersion: string;
}

function freezeDefinition<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDefinition(child);
    Object.freeze(value);
  }
  return value;
}

const object = (properties: Record<string, JsonSchemaNode>): JsonSchemaNode => ({
  type: 'object',
  properties,
  additionalProperties: false,
  required: Object.keys(properties),
});
const string: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const common = {
  ok: { type: 'boolean', const: true } satisfies JsonSchemaNode,
  inputRef: string,
  source: object({
    actorId: string,
    spaceId: string,
    taskId: string,
    planId: string,
    revision: integer,
    downstreamNodeId: string,
    sourceNodeId: string,
    artifactVersionId: string,
    version: integer,
  }),
  range: object({
    offset: integer,
    returned: integer,
    total: integer,
    hasMore: { type: 'boolean' },
    nextOffset: integer,
  }),
};

// Bump this version whenever any model-visible schema or description changes.
const acceptedInputDefinition: NativeAcceptedInputToolDefinition = freezeDefinition({
  name: ACCEPTED_INPUT_TOOL,
  description:
    'Read a bounded page from an explicitly listed accepted input. Only the catalog handle, part and range are accepted. Never fetches links or reads file bytes.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['inputRef', 'part'],
    properties: {
      inputRef: string,
      part: { type: 'string', enum: ['text', 'links'] },
      offset: integer,
      limit: integer,
    },
  },
  outputSchema: {
    oneOf: [
      object({
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...errors] },
      }),
      object({ ...common, part: { type: 'string', const: 'text' }, text: string }),
      object({
        ...common,
        part: { type: 'string', const: 'links' },
        links: { type: 'array', items: string },
      }),
    ],
  },
  sourceVersion: '1',
});

/** Pure JSON metadata from the same declaration used by the real registration. */
export function describeAcceptedInputTool(): NativeAcceptedInputToolDefinition {
  return freezeDefinition(structuredClone(acceptedInputDefinition));
}

const failure = (code: InputError) => ({ ok: false as const, code });
const bytes = (value: InputOutput) => Buffer.byteLength(JSON.stringify(value));
const blocks = (value: InputOutput): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value) },
];

/** All ports are Host-owned. A model cannot supply a caller, scope or catalog. */
export interface NativeAcceptedInputPorts {
  readonly catalog: {
    readonly scope: NativeWorkScope;
    readonly inputs: readonly { readonly input: UpstreamInputView; readonly required: boolean }[];
  };
  resolveCurrentCaller(signal: AbortSignal): Promise<ExecutionCaller>;
  readonly reader: Pick<ExecutionService, 'upstreamContent'>;
}

/** Opaque locator only: authorization still runs afresh for every read. */
export function acceptedInputRef(
  scope: NativeWorkScope,
  input: Pick<VisibleUpstreamInput, 'sourceNodeId' | 'artifactVersionId'>,
): string {
  return `input_${createHash('sha256')
    .update(JSON.stringify([scopeKey(scope), input.sourceNodeId, input.artifactVersionId]))
    .digest('hex')}`;
}

function matches(
  value: UpstreamContentValue,
  scope: NativeWorkScope,
  input: Pick<VisibleUpstreamInput, 'sourceNodeId' | 'artifactVersionId' | 'version'>,
): boolean {
  return (
    value.actorId === scope.actorId &&
    value.spaceId === scope.spaceId &&
    value.downstream.taskId === scope.taskId &&
    value.downstream.planId === scope.planId &&
    value.downstream.revision === scope.revision &&
    value.downstream.nodeId === scope.nodeId &&
    value.source.taskId === scope.taskId &&
    value.source.planId === scope.planId &&
    value.source.revision === scope.revision &&
    value.source.nodeId === input.sourceNodeId &&
    value.version.id === input.artifactVersionId &&
    value.version.version === input.version
  );
}

function currentCaller(caller: ExecutionCaller, scope: NativeWorkScope): void {
  if (
    caller.member?.ok !== true ||
    caller.member.memberId !== scope.actorId ||
    !caller.member.spaceIds.includes(scope.spaceId)
  )
    throw Error('input-unavailable');
}

/** Register in the unpublished native Agent scope; absent formal ports fail closed. */
export function registerNativeAcceptedInputTool(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  sessions: NativeWorkSessionService,
  ports: NativeAcceptedInputPorts,
): NativeDshComposition {
  const parsed = catalogSchema.safeParse(ports?.catalog);
  if (
    !parsed.success ||
    typeof ports?.resolveCurrentCaller !== 'function' ||
    typeof ports?.reader?.upstreamContent !== 'function'
  )
    throw new NativeWorkError('input-context-unavailable');
  const scope = structuredClone(binding.scope);
  const nativeAgentId = binding.nativeAgentId;
  const identity = scopeKey(scope);
  if (identity !== scopeKey(grant.scope) || identity !== scopeKey(parsed.data.scope))
    throw new NativeWorkError('input-context-unavailable');
  if (parsed.data.inputs.some(({ input, required }) => required && input.access !== 'visible'))
    throw new NativeWorkError('input-required-unavailable');
  const visible = new Map<
    string,
    Pick<VisibleUpstreamInput, 'sourceNodeId' | 'artifactVersionId' | 'version'>
  >();
  const catalog = parsed.data.inputs.map(({ input, required }) => {
    if (input.access !== 'visible') return { ...input, required };
    const inputRef = acceptedInputRef(scope, input);
    if (visible.has(inputRef)) throw new NativeWorkError('input-context-unavailable');
    visible.set(inputRef, input);
    return {
      access: input.access,
      required,
      inputRef,
      name: input.name,
      version: input.version,
      ...(input.sourceGoal ? { goal: input.sourceGoal } : {}),
    };
  });
  const context = `Accepted input catalog (metadata only). Read selected text or links with ${ACCEPTED_INPUT_TOOL}; links are references, never fetched. Required unavailable inputs block execution.\n${JSON.stringify(catalog)}`;
  if (context.length > 20_000) throw new NativeWorkError('input-context-unavailable');
  if (!visible.size) return { context, toolAllowlist: [] };
  const lifetime = new AbortController();
  const check = (exec: Readonly<ToolExecution>, signal: AbortSignal = exec.signal) => {
    if (signal.aborted || lifetime.signal.aborted || grant.signal.aborted) throw Error('cancelled');
    grant.assertCurrent('send');
    if (
      scopeKey(grant.scope) !== identity ||
      !exec.agent ||
      exec.agent.id !== nativeAgentId ||
      ctx.agents.get(exec.agent.id) !== exec.agent
    )
      throw Error('input-unavailable');
  };
  ctx.effect(() => async () => {
    lifetime.abort();
    await sessions.whenInputReadsIdle(scope);
  });
  const issuedOutputs = new Map<ToolExecution['token'], string>();
  const digest = (value: InputOutput) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  ctx.tools.register({
    name: acceptedInputDefinition.name,
    description: acceptedInputDefinition.description,
    parameters: acceptedInputDefinition.parameters,
    output: {
      schema: acceptedInputDefinition.outputSchema,
      render: (_args, value) => blocks(outputSchema.parse(value)),
    },
    async execute(raw, exec): Promise<InputOutput> {
      const value = await (async (): Promise<InputOutput> => {
        const rejectAttempt = async (code: InputError): Promise<InputOutput> => {
          const value = failure(code);
          try {
            check(exec);
            const reservation = await sessions.reserveInputRead(grant);
            await sessions.finishInputRead(
              grant,
              reservation,
              Math.min(bytes(value), reservation.maximumBytes),
            );
            return value;
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            return failure(
              code === 'input-read-busy' || code === 'input-read-budget-exceeded'
                ? code
                : 'input-unavailable',
            );
          }
        };
        const args = argumentsSchema.safeParse(raw);
        if (!args.success) return rejectAttempt('invalid-arguments');
        const { inputRef, part, offset = 0, limit = part === 'text' ? 4096 : 5 } = args.data;
        if (limit > (part === 'text' ? 4096 : 5)) return rejectAttempt('invalid-arguments');
        const input = visible.get(inputRef);
        if (!input) return rejectAttempt('input-unavailable');
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), WAIT_MS);
        const signal = AbortSignal.any([
          exec.signal,
          grant.signal,
          lifetime.signal,
          timeout.signal,
        ]);
        let abandoned = false;
        try {
          check(exec, signal);
          const reservation = await sessions.reserveInputRead(grant);
          // This promise owns the slot until the actual source operation settles,
          // even after the caller stops waiting. Never release it in the race.
          const reading = (async (): Promise<InputOutput> => {
            check(exec, signal);
            const caller = await ports.resolveCurrentCaller(signal);
            check(exec, signal);
            currentCaller(caller, scope);
            const result = await ports.reader.upstreamContent(caller, {
              spaceId: scope.spaceId,
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              nodeId: scope.nodeId,
              sourceNodeId: input.sourceNodeId,
              artifactVersionId: input.artifactVersionId,
            });
            check(exec, signal);
            currentCaller(await ports.resolveCurrentCaller(signal), scope);
            check(exec, signal);
            if (!result.ok || !matches(result.value, scope, input))
              return failure('input-unavailable');
            const source = {
              actorId: scope.actorId,
              spaceId: scope.spaceId,
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              downstreamNodeId: scope.nodeId,
              sourceNodeId: input.sourceNodeId,
              artifactVersionId: input.artifactVersionId,
              version: input.version,
            };
            const items =
              part === 'text'
                ? Array.from(result.value.content.text ?? '')
                : result.value.content.links;
            if (offset > items.length) return failure('invalid-arguments');
            const page = items.slice(offset, offset + limit);
            if (
              part === 'links' &&
              page.some((link) => {
                try {
                  return !['https:', 'http:'].includes(new URL(link).protocol);
                } catch {
                  return true;
                }
              })
            )
              return failure('input-unavailable');
            const nextOffset = offset + page.length;
            const range = {
              offset,
              returned: page.length,
              total: items.length,
              hasMore: nextOffset < items.length,
              nextOffset,
            };
            const value: InputOutput =
              part === 'text'
                ? { ok: true, inputRef, part, source, range, text: page.join('') }
                : { ok: true, inputRef, part, source, range, links: [...page] };
            if (bytes(value) > reservation.maximumBytes) return failure('output-too-large');
            return outputSchema.parse(value);
          })();
          const settled = reading.then(
            async (value) => {
              // Only a known, delivered successful page can return unused charge.
              await sessions.finishInputRead(
                grant,
                reservation,
                !abandoned && !signal.aborted && value.ok ? bytes(value) : undefined,
              );
              return value;
            },
            async () => {
              await sessions.finishInputRead(grant, reservation);
              return failure('input-unavailable');
            },
          );
          return await new Promise<InputOutput>((resolve) => {
            const abort = () => {
              abandoned = true;
              signal.removeEventListener('abort', abort);
              resolve(failure(timeout.signal.aborted ? 'read-timeout' : 'cancelled'));
            };
            signal.addEventListener('abort', abort, { once: true });
            void settled.then(
              (value) => {
                signal.removeEventListener('abort', abort);
                if (!abandoned) resolve(value);
              },
              () => {
                signal.removeEventListener('abort', abort);
                if (!abandoned) resolve(failure('input-unavailable'));
              },
            );
            if (signal.aborted) abort();
          });
        } catch (error) {
          if (signal.aborted) return failure(timeout.signal.aborted ? 'read-timeout' : 'cancelled');
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          return failure(
            code === 'input-read-busy' || code === 'input-read-budget-exceeded'
              ? code
              : 'input-unavailable',
          );
        } finally {
          clearTimeout(timer);
        }
      })();
      issuedOutputs.set(exec.token, digest(value));
      return value;
    },
    finalizeContent(exec, result) {
      // Total: DSH may retain original content if this callback throws.
      try {
        check(exec);
        if (result.isError) return blocks(failure('input-unavailable'));
        const value = outputSchema.parse(result.value);
        if (issuedOutputs.get(exec.token) !== digest(value))
          return blocks(failure('input-unavailable'));
        if (value.ok) {
          const input = visible.get(value.inputRef);
          if (
            !input ||
            value.source.actorId !== scope.actorId ||
            value.source.spaceId !== scope.spaceId ||
            value.source.taskId !== scope.taskId ||
            value.source.planId !== scope.planId ||
            value.source.revision !== scope.revision ||
            value.source.downstreamNodeId !== scope.nodeId ||
            value.source.sourceNodeId !== input.sourceNodeId ||
            value.source.artifactVersionId !== input.artifactVersionId ||
            value.source.version !== input.version ||
            bytes(value) > NATIVE_INPUT_READ_LIMITS.pageBytes
          )
            return blocks(failure('input-unavailable'));
        }
        return blocks(value);
      } catch {
        return blocks(failure('cancelled'));
      } finally {
        issuedOutputs.delete(exec.token);
      }
    },
  } satisfies ToolDefinition);
  return { context, toolAllowlist: [ACCEPTED_INPUT_TOOL] };
}
