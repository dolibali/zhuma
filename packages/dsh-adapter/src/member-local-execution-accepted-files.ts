import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { canonicalPayload } from '@zhuma/agent-core';
import { ArtifactUploadError, artifactFileLeaf } from './artifact-files.js';
import type {
  MemberLocalExecutionProtocol,
  MemberLocalRunHandle,
} from './member-local-execution-protocol.js';
import { MemberLocalProtocolError } from './member-local-execution-protocol.js';
import type { NativeSessionBinding, NativeWorkGrant } from './native-work-session-contract.js';
import type { NativeWorkSessionService } from './native-work-session.js';
import type { NativeDshComposition } from './native-work-session-dsh.js';
import {
  runFileListSchema,
  runFileReadSchema,
  runFileEncoding,
  type NativeRunAcceptedFiles,
  type NativeRunFileInfo,
  type NativeRunFileSource,
} from './native-work-session-files-contract.js';
import {
  describeNativeAcceptedFileTool,
  registerNativeAcceptedFileTool,
} from './native-work-session-files-tool.js';
import { acceptedInputRef } from './native-work-session-input-tool.js';
import { createMemberLocalAcceptedInputPorts } from './member-local-execution-inputs.js';

const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
function unavailable(): never {
  throw new ArtifactUploadError('input-unavailable');
}

/** D's fixed file slots -> the ORIGINAL native reader. Every source call still
 * authenticates the current member/device/Run/permit; no local AttachmentStore.
 * The file-capable backend must refuse non-UTF8 original-reader pages before
 * returning input-read success. A partial client page cannot attest a full file. */
export async function createMemberLocalAcceptedFiles(
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  protocol: MemberLocalExecutionProtocol,
  run: MemberLocalRunHandle,
  ready: (grant: NativeWorkGrant) => Promise<void>,
): Promise<NativeRunAcceptedFiles> {
  const ports = await createMemberLocalAcceptedInputPorts(binding, grant, protocol, run),
    inputs = run.composition.payload.inputs;
  const current = (actual: NativeWorkGrant, caller: AbortSignal) => {
    if (actual !== grant) unavailable();
    caller.throwIfAborted();
    grant.assertCurrent('send');
    return AbortSignal.any([caller, grant.signal]);
  };
  const capture = async (inputRef: string, signal: AbortSignal) => {
    const input = inputs.find((input) => acceptedInputRef(binding.scope, input) === inputRef);
    if (!input) unavailable();
    const caller = await ports.resolveCurrentCaller(signal),
      result = await ports.reader.upstreamContent(caller, {
        spaceId: binding.scope.spaceId,
        taskId: binding.scope.taskId,
        planId: binding.scope.planId,
        revision: binding.scope.revision,
        nodeId: binding.scope.nodeId,
        sourceNodeId: input.sourceNodeId,
        artifactVersionId: input.artifactVersionId,
      });
    if (!result.ok) unavailable();
    current(grant, signal);
    const slots = run.value.shared.inputs.filter(
        (slot) =>
          slot.kind === 'file' &&
          slot.sourceNodeId === input.sourceNodeId &&
          slot.artifactVersionId === input.artifactVersionId,
      ),
      references = result.value.content.files;
    if (slots.length !== references.length) unavailable();
    const files = slots.map((slot): NativeRunFileInfo => {
      const file = references.find((file) => file.id === slot.fileId);
      if (
        !file ||
        slot.resourceRef?.id !== inputRef ||
        slot.resourceRef.version !== input.artifactVersionId ||
        file.byteSize !== slot.byteSize ||
        file.checksum !== slot.sha256 ||
        file.accessPolicyId !== `space:${binding.scope.spaceId}` ||
        file.uploadComplete !== true
      )
        unavailable();
      return {
        fileId: file.id,
        name: artifactFileLeaf(slot.name),
        mediaType: file.mediaType,
        bytes: file.byteSize,
        sha256: slot.sha256,
      };
    });
    const source: NativeRunFileSource = {
      scope: structuredClone(binding.scope),
      inputRef,
      sourceNodeId: input.sourceNodeId,
      artifactVersionId: input.artifactVersionId,
      version: input.version,
    };
    return { source, files, slots };
  };
  return {
    async list(actual, raw, caller) {
      current(actual, caller);
      await ready(actual);
      const signal = current(actual, caller),
        query = runFileListSchema.parse(raw),
        { source, files } = await capture(query.inputRef, signal),
        value = { ...source, files },
        fingerprint = canonicalPayload(value);
      const check = () => {
        current(actual, signal);
        if (canonicalPayload(value) !== fingerprint) unavailable();
      };
      check();
      return Object.freeze({ ...value, check });
    },
    async read(actual, raw, caller) {
      current(actual, caller);
      await ready(actual);
      const signal = current(actual, caller),
        query = runFileReadSchema.parse(raw),
        { source, files, slots } = await capture(query.inputRef, signal),
        slot = slots.find((slot) => slot.fileId === query.fileId),
        file = files.find((file) => file.fileId === query.fileId);
      if (!slot || !file || query.offset > slot.byteSize) unavailable();
      const page = await protocol
        .command(
          run,
          {
            operation: 'input-read',
            payload: {
              slotId: slot.slotId,
              offset: query.offset,
              maximumBytes: query.length,
            },
          },
          signal,
          { waitForSourceSettlement: true },
        )
        .catch((error: unknown) => {
          // This is the existing file-capable Run's bounded file read. D uses
          // its stable unsupported code when the original full-object reader
          // rejects binary/invalid UTF8, never an invented stale-version result.
          if (
            error instanceof MemberLocalProtocolError &&
            error.code === 'remote-protocol-unsupported'
          )
            throw new ArtifactUploadError('unsupported-encoding');
          throw error;
        });
      current(actual, signal);
      const bytes = Buffer.from(page.base64, 'base64');
      if (
        page.slotId !== slot.slotId ||
        page.offset !== query.offset ||
        page.totalBytes !== slot.byteSize ||
        page.sha256 !== slot.sha256 ||
        bytes.byteLength !== page.byteSize ||
        bytes.byteLength > query.length ||
        (query.offset < slot.byteSize && !bytes.byteLength) ||
        bytes.toString('base64') !== page.base64 ||
        (query.offset === 0 &&
          bytes.byteLength === slot.byteSize &&
          createHash('sha256').update(bytes).digest('hex') !== slot.sha256) ||
        page.eof !== (query.offset + bytes.byteLength === slot.byteSize)
      )
        unavailable();
      const value = {
          source: { ...source, file },
          range: { offset: query.offset, length: bytes.byteLength, total: slot.byteSize },
        },
        fingerprint = canonicalPayload(value),
        digest = createHash('sha256').update(bytes).digest('hex');
      let released = false;
      const check = () => {
        current(actual, signal);
        if (
          released ||
          canonicalPayload(value) !== fingerprint ||
          createHash('sha256').update(bytes).digest('hex') !== digest
        )
          unavailable();
      };
      check();
      return Object.freeze({
        ...value,
        bytes,
        encoding: runFileEncoding(file, bytes),
        signal,
        check,
        release() {
          released = true;
        },
      });
    },
  };
}

export async function registerMemberLocalAcceptedFiles(
  ctx: Context,
  binding: NativeSessionBinding,
  grant: NativeWorkGrant,
  sessions: NativeWorkSessionService,
  protocol: MemberLocalExecutionProtocol,
  run: MemberLocalRunHandle,
  ready: (grant: NativeWorkGrant) => Promise<void>,
): Promise<NativeDshComposition> {
  const snapshot = run.composition;
  if (snapshot.schemaVersion !== 2 || !snapshot.payload.acceptedFileReader)
    return { context: '', toolAllowlist: [] };
  if (!same(snapshot.payload.acceptedFileReader, describeNativeAcceptedFileTool())) unavailable();
  const reader = await createMemberLocalAcceptedFiles(binding, grant, protocol, run, ready);
  return registerNativeAcceptedFileTool(
    ctx,
    binding,
    grant,
    sessions,
    {
      assertGrant(actual, action) {
        if (actual !== grant) unavailable();
        grant.assertCurrent(action);
      },
    },
    reader,
  );
}
