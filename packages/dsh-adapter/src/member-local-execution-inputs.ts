import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { canonicalPayload, REMOTE_RUN_LIMITS, validateDeliveryContent } from '@zhuma/agent-core';
import { z } from 'zod';
import type { ExecutionCaller, UpstreamContentValue } from './execution-service.js';
import type {
  MemberLocalExecutionProtocol,
  MemberLocalRunHandle,
} from './member-local-execution-protocol.js';
import {
  NativeWorkError,
  type NativeSessionBinding,
  type NativeWorkGrant,
} from './native-work-session-contract.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import {
  describeAcceptedInputTool,
  registerNativeAcceptedInputTool,
  acceptedInputRef,
  type NativeAcceptedInputPorts,
} from './native-work-session-input-tool.js';
import type { NativeWorkSessionService } from './native-work-session.js';

// Same bounded original UpstreamContentValue JSON produced by D's inputSnapshot;
// this is not a new delivery schema, transcript or file-body transport.
const DOCUMENT_BYTES = 1024 * 1024;
const id = z.string().min(1).max(200);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const node = z.strictObject({ taskId: id, planId: id, revision: positive, nodeId: id });
const querySchema = node.extend({ spaceId: id, sourceNodeId: id, artifactVersionId: id });
const documentSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  downstream: node,
  source: node,
  version: z.strictObject({ id, version: positive }),
  content: z
    .strictObject({
      text: z.string().optional(),
      links: z.array(z.string()),
      files: z.array(
        z.strictObject({
          id,
          mediaType: z.string().min(1),
          byteSize: natural,
          checksum: z.string().min(1),
          accessPolicyId: id,
          uploadComplete: z.literal(true),
        }),
      ),
    })
    .transform(({ text, ...content }) => ({ ...content, ...(text === undefined ? {} : { text }) })),
}) satisfies z.ZodType<UpstreamContentValue>;

function unavailable(): never {
  throw new NativeWorkError('input-context-unavailable');
}

/** Adapt the exact authenticated remote slots to the ORIGINAL native input tool.
 * Its catalog, caller checks, page limits, read reservations and ACKs stay intact.
 * Only this unpublished local Agent receives the reader; no body is prefetched. */
export async function registerMemberLocalAcceptedInputs(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  sessions: NativeWorkSessionService,
  protocol: MemberLocalExecutionProtocol,
  run: MemberLocalRunHandle,
): Promise<NativeDshComposition> {
  const snapshot = run.composition,
    tools = snapshot.payload.tools,
    enabled =
      tools.kind === 'accepted-input-reader' ||
      (tools.kind === 'local-tools' && tools.acceptedInputReader !== undefined);
  if (!enabled) return { context: '', toolAllowlist: [] };
  const definition =
    tools.kind === 'accepted-input-reader'
      ? tools.definition
      : tools.kind === 'local-tools'
        ? tools.acceptedInputReader
        : undefined;
  if (canonicalPayload(definition) !== canonicalPayload(describeAcceptedInputTool())) unavailable();
  return registerNativeAcceptedInputTool(
    ctx,
    binding,
    grant,
    sessions,
    await createMemberLocalAcceptedInputPorts(binding, grant, protocol, run),
  );
}

/** The same bounded fixed input source for the original text and file tools.
 * Registration observes catalog metadata only; documents are fetched on demand. */
export async function createMemberLocalAcceptedInputPorts(
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  protocol: MemberLocalExecutionProtocol,
  run: MemberLocalRunHandle,
): Promise<NativeAcceptedInputPorts> {
  const snapshot = run.composition;
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted();
    grant.assertCurrent('send');
    const { backendId: _backendId, ...scope } = run.value.scope;
    if (
      canonicalPayload(scope) !== canonicalPayload(binding.scope) ||
      canonicalPayload(grant.scope) !== canonicalPayload(binding.scope)
    )
      unavailable();
  };
  const list = async (signal: AbortSignal) => {
    check(signal);
    const value = await protocol.command(run, { operation: 'input-list', payload: {} }, signal, {
      waitForSourceSettlement: true,
    });
    check(signal);
    if (canonicalPayload(value.items) !== canonicalPayload(run.value.shared.inputs)) unavailable();
    return value.items;
  };
  const items = await list(grant.signal),
    inputs = snapshot.payload.inputs,
    textItems = items.filter((item) => item.kind === 'text'),
    fileItems = items.filter((item) => item.kind === 'file'),
    filesEnabled =
      snapshot.schemaVersion === 2 && snapshot.payload.acceptedFileReader !== undefined;
  if (
    items.some((item) => item.kind !== 'text' && item.kind !== 'file') ||
    (!filesEnabled && fileItems.length) ||
    new Set(
      fileItems.map((item) =>
        canonicalPayload([item.sourceNodeId, item.artifactVersionId, item.fileId]),
      ),
    ).size !== fileItems.length ||
    fileItems.some((item) => {
      const input = inputs.find(
        (input) =>
          input.sourceNodeId === item.sourceNodeId &&
          input.artifactVersionId === item.artifactVersionId,
      );
      return (
        !input ||
        !item.fileId ||
        item.resourceRef?.id !== acceptedInputRef(binding.scope, input) ||
        item.resourceRef.version !== input.artifactVersionId
      );
    })
  )
    unavailable();
  if (
    textItems.length !== inputs.length ||
    new Set(items.map((item) => item.slotId)).size !== items.length ||
    inputs.some(
      (input) =>
        items.filter(
          (item) =>
            item.kind === 'text' &&
            item.sourceNodeId === input.sourceNodeId &&
            item.artifactVersionId === input.artifactVersionId &&
            item.byteSize > 0 &&
            item.byteSize <= DOCUMENT_BYTES,
        ).length !== 1,
    )
  )
    unavailable();
  // Caller values route the original tool only. Every actual source read still
  // crosses D's live member/device/private-permit gate; this is not a local ACL.
  const callers = new WeakMap<ExecutionCaller, AbortSignal>();
  return {
    catalog: {
      scope: binding.scope,
      inputs: inputs.map(({ sourceGoal, ...input }) => ({
        input: { ...input, ...(sourceGoal === undefined ? {} : { sourceGoal }) },
        required: true,
      })),
    },
    async resolveCurrentCaller(signal) {
      check(signal);
      const caller: ExecutionCaller = {
        member: { ok: true, memberId: binding.scope.actorId, spaceIds: [binding.scope.spaceId] },
      };
      callers.set(caller, signal);
      return caller;
    },
    reader: {
      async upstreamContent(caller, raw) {
        const signal = callers.get(caller),
          query = querySchema.parse(raw);
        if (!signal) unavailable();
        check(signal);
        const scope = binding.scope;
        if (
          query.spaceId !== scope.spaceId ||
          query.taskId !== scope.taskId ||
          query.planId !== scope.planId ||
          query.revision !== scope.revision ||
          query.nodeId !== scope.nodeId
        )
          unavailable();
        const current = await list(signal),
          slot = current.find(
            (item) =>
              item.kind === 'text' &&
              item.sourceNodeId === query.sourceNodeId &&
              item.artifactVersionId === query.artifactVersionId,
          );
        if (!slot || slot.byteSize < 1 || slot.byteSize > DOCUMENT_BYTES) unavailable();
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < slot.byteSize) {
          check(signal);
          const maximumBytes = Math.min(REMOTE_RUN_LIMITS.inputChunkBytes, slot.byteSize - offset);
          const page = await protocol.command(
            run,
            { operation: 'input-read', payload: { slotId: slot.slotId, offset, maximumBytes } },
            signal,
            { waitForSourceSettlement: true },
          );
          check(signal);
          const bytes = Buffer.from(page.base64, 'base64');
          if (
            page.slotId !== slot.slotId ||
            page.offset !== offset ||
            page.totalBytes !== slot.byteSize ||
            page.sha256 !== slot.sha256 ||
            bytes.length !== page.byteSize ||
            bytes.length < 1 ||
            bytes.length > maximumBytes ||
            bytes.toString('base64') !== page.base64 ||
            page.eof !== (offset + bytes.length === slot.byteSize)
          )
            unavailable();
          chunks.push(bytes);
          offset += bytes.length;
        }
        const bytes = Buffer.concat(chunks, slot.byteSize);
        if (createHash('sha256').update(bytes).digest('hex') !== slot.sha256) unavailable();
        const value = documentSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        const input = inputs.find(
          (input) =>
            input.sourceNodeId === query.sourceNodeId &&
            input.artifactVersionId === query.artifactVersionId,
        );
        if (
          !input ||
          value.actorId !== scope.actorId ||
          value.spaceId !== scope.spaceId ||
          canonicalPayload(value.downstream) !==
            canonicalPayload({
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              nodeId: scope.nodeId,
            }) ||
          canonicalPayload(value.source) !==
            canonicalPayload({
              taskId: scope.taskId,
              planId: scope.planId,
              revision: scope.revision,
              nodeId: query.sourceNodeId,
            }) ||
          value.version.id !== input.artifactVersionId ||
          value.version.version !== input.version ||
          !validateDeliveryContent(value.content).ok
        )
          unavailable();
        check(signal);
        return { ok: true, value };
      },
    },
  };
}
