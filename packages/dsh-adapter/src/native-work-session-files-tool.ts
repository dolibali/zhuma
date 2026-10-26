import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonSchemaNode, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import type { ExecutionRunAuthorities } from './execution-run-authority.js';
import {
  NativeWorkError,
  type NativeSessionBinding,
  type NativeWorkGrant,
} from './native-work-session-contract.js';
import type {
  NativeRunAcceptedFiles,
  NativeRunFileList,
  NativeRunFilePage,
} from './native-work-session-files-contract.js';
import { NATIVE_ACCEPTED_FILE_TOOL } from './native-work-session-files-contract.js';
import { NATIVE_INPUT_READ_LIMITS, type NativeWorkSessionService } from './native-work-session.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';

export { NATIVE_ACCEPTED_FILE_TOOL } from './native-work-session-files-contract.js';
export const NATIVE_ACCEPTED_FILE_TOOL_VERSION = 'zhuma-accepted-files@2';
const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const inputRef = z.string().regex(/^input_[a-f0-9]{64}$/u);
const argumentsSchema = z.discriminatedUnion('part', [
  z.strictObject({ inputRef, part: z.literal('files') }),
  z.strictObject({
    inputRef,
    part: z.literal('file'),
    fileId: id,
    offset: natural.default(0),
    length: natural.min(1).max(8192).default(4096),
  }),
]);
const scope = z.strictObject({
  actorId: id,
  spaceId: id,
  taskId: id,
  planId: id,
  revision: natural.min(1),
  nodeId: id,
  runId: id,
  generation: natural.min(1),
  segmentId: id,
});
const source = z.strictObject({
  scope,
  inputRef,
  sourceNodeId: id,
  artifactVersionId: z.string().min(1).max(1000),
  version: natural.min(1),
});
const fileInfo = z.strictObject({
  fileId: id,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(200),
  bytes: natural,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const errorCode = z.enum([
  'invalid-arguments',
  'input-unavailable',
  'cancelled',
  'read-timeout',
  'input-read-busy',
  'input-read-budget-exceeded',
  'output-too-large',
  'unsupported-encoding',
]);
const outputSchema = z.union([
  z.strictObject({ ok: z.literal(false), code: errorCode }),
  z.strictObject({
    ok: z.literal(true),
    part: z.literal('files'),
    source,
    files: z.array(fileInfo).max(20),
  }),
  z.strictObject({
    ok: z.literal(true),
    part: z.literal('file'),
    source: source.extend({ file: fileInfo }),
    range: z.strictObject({ offset: natural, length: natural, total: natural }),
    encoding: z.literal('utf-8'),
    text: z.string().max(8192),
  }),
]);
type Output = z.infer<typeof outputSchema>;
type ErrorCode = z.infer<typeof errorCode>;
const failure = (code: ErrorCode): Output => ({ ok: false, code });
const outputBytes = (value: Output) => Buffer.byteLength(JSON.stringify(value));
const digest = (value: Output) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blocks = (value: Output): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }];
const object = (
  properties: Record<string, JsonSchemaNode>,
  required = Object.keys(properties),
): JsonSchemaNode => ({ type: 'object', additionalProperties: false, properties, required });
const text: JsonSchemaNode = { type: 'string' };
const integer: JsonSchemaNode = { type: 'integer' };
const yes: JsonSchemaNode = { type: 'boolean', const: true };
const scopeDescription = object({
  actorId: text,
  spaceId: text,
  taskId: text,
  planId: text,
  revision: integer,
  nodeId: text,
  runId: text,
  generation: integer,
  segmentId: text,
});
const sourceDescription = {
  scope: scopeDescription,
  inputRef: text,
  sourceNodeId: text,
  artifactVersionId: text,
  version: integer,
};
const fileDescription = object({
  fileId: text,
  name: text,
  mediaType: text,
  bytes: integer,
  sha256: text,
});
// The SDK enforces a deliberate JSON-schema subset. Zod still enforces byte,
// string, numeric and identifier bounds before I/O and before publication.
const definition = {
  name: NATIVE_ACCEPTED_FILE_TOOL,
  description:
    'List files of an explicitly frozen accepted input, then read a selected UTF-8 byte range. Metadata is not proof of reading. Never fetches links, renders PDF/images, or opens a caller path.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['inputRef', 'part'],
    properties: {
      inputRef: text,
      part: { type: 'string', enum: ['files', 'file'] },
      fileId: {
        type: 'string',
        description: 'Required only for part=file; use the catalog fileId.',
      },
      offset: {
        type: 'integer',
        default: 0,
        description: 'Only for part=file. Nonnegative safe byte offset; defaults to 0.',
      },
      length: {
        type: 'integer',
        default: 4096,
        description: 'Only for part=file. Byte length from 1 to 8192; defaults to 4096.',
      },
    },
  } as ToolDefinition['parameters'],
  outputSchema: {
    oneOf: [
      object({
        ok: { type: 'boolean', const: false },
        code: { type: 'string', enum: [...errorCode.options] },
      }),
      object({
        ok: yes,
        part: { type: 'string', const: 'files' },
        source: object(sourceDescription),
        files: { type: 'array', items: fileDescription },
      }),
      object({
        ok: yes,
        part: { type: 'string', const: 'file' },
        source: object({ ...sourceDescription, file: fileDescription }),
        range: object({ offset: integer, length: integer, total: integer }),
        encoding: { type: 'string', const: 'utf-8' },
        text,
      }),
    ],
  } satisfies JsonSchemaNode,
  sourceVersion: NATIVE_ACCEPTED_FILE_TOOL_VERSION,
};
assertObjectJsonSchema(definition.parameters);
assertSupportedJsonSchema(definition.outputSchema);
export function describeNativeAcceptedFileTool() {
  return structuredClone(definition);
}

/** Host binds the same real issuer and factory port inside the original native Agent scope. */
export function registerNativeAcceptedFileTool(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  sessions: NativeWorkSessionService,
  issuer: Pick<ExecutionRunAuthorities, 'assertGrant'>,
  reader: NativeRunAcceptedFiles,
): NativeDshComposition {
  issuer.assertGrant(grant, 'send');
  const nativeAgent = scopeOf(ctx);
  const address = canonicalPayload(binding.scope);
  if (!nativeAgent || address !== canonicalPayload(grant.scope))
    throw new NativeWorkError('scope-mismatch');
  const lifetime = new AbortController();
  const declared = describeNativeAcceptedFileTool();
  const issued = new Map<
    ToolExecution['token'],
    {
      readonly digest: string;
      check(): void;
      release(): void;
    }
  >();
  const check = (exec: Readonly<ToolExecution>, signal = exec.signal) => {
    if (signal.aborted || lifetime.signal.aborted || grant.signal.aborted)
      throw new NativeWorkError('cancelled');
    issuer.assertGrant(grant, 'send');
    if (
      canonicalPayload(grant.scope) !== address ||
      !exec.agent ||
      exec.agent !== nativeAgent ||
      exec.agent.id !== binding.nativeAgentId ||
      ctx.agents.get(exec.agent.id) !== exec.agent
    )
      throw new NativeWorkError('scope-mismatch');
  };
  const codeOf = (error: unknown): ErrorCode => {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'file-timeout') return 'read-timeout';
    if (code === 'quota-exceeded') return 'input-read-busy';
    return errorCode.options.includes(code as ErrorCode)
      ? (code as ErrorCode)
      : 'input-unavailable';
  };
  ctx.effect(() => async () => {
    lifetime.abort();
    for (const pending of issued.values()) pending.release();
    issued.clear();
    await sessions.whenInputReadsIdle(binding.scope);
  });
  ctx.tools.register({
    name: declared.name,
    description: declared.description,
    parameters: declared.parameters,
    output: {
      schema: declared.outputSchema,
      render: (_args, value) => blocks(outputSchema.parse(value)),
    },
    async execute(raw, exec): Promise<Output> {
      let native: NativeRunFileList | NativeRunFilePage | undefined;
      const release = () => {
        if (native && 'release' in native) native.release();
        native = undefined;
      };
      let result: Output;
      try {
        check(exec);
        const reservation = await sessions.reserveInputRead(grant);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 5000);
        const signal = AbortSignal.any([
          exec.signal,
          grant.signal,
          lifetime.signal,
          timeout.signal,
        ]);
        let abandoned = false;
        const reading = (async (): Promise<Output> => {
          check(exec, signal);
          const args = argumentsSchema.safeParse(raw);
          if (!args.success) return failure('invalid-arguments');
          if (args.data.part === 'files') {
            const list = await reader.list(grant, { inputRef: args.data.inputRef }, signal);
            native = list;
            check(exec, signal);
            list.check();
            const { scope, inputRef, sourceNodeId, artifactVersionId, version } = list;
            return outputSchema.parse({
              ok: true,
              part: 'files',
              source: { scope, inputRef, sourceNodeId, artifactVersionId, version },
              files: list.files,
            });
          }
          const { inputRef, fileId, offset, length } = args.data;
          const page = await reader.read(grant, { inputRef, fileId, offset, length }, signal);
          native = page;
          check(exec, signal);
          page.check();
          if (page.encoding !== 'utf-8') return failure('unsupported-encoding');
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(page.bytes);
          } catch {
            return failure('unsupported-encoding');
          }
          return outputSchema.parse({
            ok: true,
            part: 'file',
            source: page.source,
            range: page.range,
            encoding: 'utf-8',
            text,
          });
        })();
        const settled = reading.then(
          async (value): Promise<Output> => {
            if (outputBytes(value) > reservation.maximumBytes) value = failure('output-too-large');
            await sessions.finishInputRead(
              grant,
              reservation,
              !abandoned && !signal.aborted && value.ok ? outputBytes(value) : undefined,
            );
            if (abandoned || signal.aborted || !value.ok) release();
            return value;
          },
          async (error): Promise<Output> => {
            release();
            await sessions.finishInputRead(grant, reservation);
            return failure(codeOf(error));
          },
        );
        try {
          result = await new Promise<Output>((resolve) => {
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
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        release();
        result = failure(codeOf(error));
      }
      issued.set(exec.token, {
        digest: digest(result),
        check: () => {
          check(exec);
          if (result.ok) native?.check();
        },
        release,
      });
      return result;
    },
    finalizeContent(exec, result) {
      const original = issued.get(exec.token);
      try {
        check(exec);
        if (result.isError || !original) return blocks(failure('input-unavailable'));
        const value = outputSchema.parse(result.value);
        if (
          digest(value) !== original.digest ||
          outputBytes(value) > NATIVE_INPUT_READ_LIMITS.pageBytes
        )
          return blocks(failure('input-unavailable'));
        original.check();
        return blocks(value);
      } catch {
        return blocks(failure('cancelled'));
      } finally {
        original?.release();
        issued.delete(exec.token);
      }
    },
  } satisfies ToolDefinition);
  return { context: '', toolAllowlist: [NATIVE_ACCEPTED_FILE_TOOL] };
}
