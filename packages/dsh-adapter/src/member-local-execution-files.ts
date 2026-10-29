import { createHash } from 'node:crypto';
import { canonicalPayload, type RemoteRunOperationValue } from '@zhuma/agent-core';
import { ArtifactUploadError, type UploadFileRecord } from './artifact-files.js';
import type {
  MemberLocalExecutionProtocol,
  MemberLocalRunHandle,
} from './member-local-execution-protocol.js';
import type { NativeWorkGrant } from './native-work-session-contract.js';
import type {
  NativeOutputFileResourceSource,
  NativeOutputFileSource,
  NativeOutputFileReservation,
  NativeRunOutputFiles,
} from './native-work-session-output-file-contract.js';

const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);
const keyFor = (source: NativeOutputFileSource) =>
  `native-output_${createHash('sha256').update(canonicalPayload(source)).digest('hex')}`;
type FileValue = RemoteRunOperationValue<'publish-file'>;

/** Original native publisher port, backed by D's original remote file ledger.
 * No local AttachmentStore, replacement upload database or manufactured receipt.
 * The original issuer still owns the local FS/publication grant and SDK ACK. */
export function createMemberLocalOutputFiles(
  protocol: MemberLocalExecutionProtocol,
  resources: NativeOutputFileResourceSource,
  runForGrant: (grant: NativeWorkGrant) => MemberLocalRunHandle,
  ready: (grant: NativeWorkGrant) => Promise<void>,
): NativeRunOutputFiles {
  const run = (grant: NativeWorkGrant, action: 'send' | 'history') => {
    grant.assertCurrent(action);
    if (resources.signal.aborted || grant.signal.aborted)
      throw new ArtifactUploadError('cancelled');
    const handle = runForGrant(grant),
      { backendId: _backendId, ...scope } = handle.value.scope;
    if (!same(grant.scope, scope)) throw new ArtifactUploadError('publication-denied');
    return handle;
  };
  const record = (
    value: FileValue,
    source: NativeOutputFileSource,
    key: string,
    selector?: { name: string; selectorFingerprint: string },
  ): UploadFileRecord => {
    if (
      value.status !== 'completed' ||
      !value.record ||
      value.idempotencyKey !== key ||
      !same(value.record.producer.source, source) ||
      (selector &&
        (value.record.name !== selector.name ||
          value.record.producer.selectorFingerprint !== selector.selectorFingerprint))
    )
      throw new ArtifactUploadError('publication-unavailable');
    return structuredClone(value.record);
  };
  return {
    async readCompleted(grant, request, caller) {
      const handle = run(grant, 'history'),
        signal = AbortSignal.any([grant.signal, resources.signal, caller]),
        source = structuredClone(request.source);
      signal.throwIfAborted();
      const value = await protocol.command(
        handle,
        { operation: 'file-status', payload: { source, publicationId: request.publicationId } },
        signal,
        { waitForSourceSettlement: true },
      );
      const saved = record(value, source, keyFor(source));
      if (saved.uploadId !== request.publicationId)
        throw new ArtifactUploadError('publication-denied');
      const fingerprint = canonicalPayload({ source, record: saved });
      const check = (): undefined => {
        signal.throwIfAborted();
        run(grant, 'history');
        if (canonicalPayload({ source, record: saved }) !== fingerprint)
          throw new ArtifactUploadError('publication-unavailable');
        return undefined;
      };
      check();
      return Object.freeze({ source, record: saved, signal, check });
    },
    async reserve(grant, request, caller) {
      // A fast first tool call can precede the native receipt and D's accepted
      // event. Join this original admission; never invent its native identity.
      await ready(grant);
      const lifetime = new AbortController();
      const handle = run(grant, 'send'),
        source = structuredClone(request.source),
        key = keyFor(source),
        signal = AbortSignal.any([grant.signal, resources.signal, caller, lifetime.signal]);
      const check = (): undefined => {
        signal.throwIfAborted();
        run(grant, 'send');
        resources.assertPublication(grant, source, request.selectorFingerprint);
        return undefined;
      };
      check();
      const value = await protocol.command(
        handle,
        {
          operation: 'publish-file',
          payload: {
            mode: request.mode,
            source,
            idempotencyKey: key,
            selectorFingerprint: request.selectorFingerprint,
            name: request.name,
            ...(request.mode === 'reserve' ? { maximumBytes: request.maximumBytes } : {}),
          },
        },
        signal,
        { waitForSourceSettlement: true },
      );
      // An HTTP response is still unknown if local publication authority was
      // revoked while waiting. Whole-Run cleanup retains that backend obligation.
      check();
      if (value.idempotencyKey !== key) throw new ArtifactUploadError('publication-unavailable');
      if (value.status === 'absent') throw new ArtifactUploadError('not-found');
      const completed =
        value.status === 'completed' ? record(value, source, key, request) : undefined;
      if (!completed && value.status !== 'reserved')
        throw new ArtifactUploadError('publication-unavailable');
      const reservationId = 'reservationId' in value ? value.reservationId : undefined;
      let released = false,
        publishing: Promise<UploadFileRecord> | undefined,
        settle!: () => void;
      const drain = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const reservation: NativeOutputFileReservation = {
        signal,
        drain,
        ...(completed ? { completed } : {}),
        check,
        publish(input) {
          check();
          if (!reservationId || completed || publishing || released)
            return Promise.reject(new ArtifactUploadError('publication-denied'));
          publishing = (async () => {
            const response = await protocol.publishFile(
              handle,
              {
                mode: 'publish',
                reservationId,
                declare: {
                  name: request.name,
                  mediaType: input.mediaType,
                  byteSize: input.byteSize,
                  sha256: input.sha256,
                },
              },
              input.data,
              AbortSignal.any([signal, lifetime.signal]),
            );
            check();
            return record(response, source, key, request);
          })();
          return publishing;
        },
        releaseAfter(sourceDrain) {
          if (released) return;
          released = true;
          lifetime.abort();
          void (async () => {
            // An abort/early HTTP error is NOT physical source drain. Join the
            // original FS read and actual upload job before releasing D's slot.
            await Promise.allSettled([sourceDrain, ...(publishing ? [publishing] : [])]);
            if (reservationId) {
              try {
                await protocol.command(
                  handle,
                  { operation: 'abandon-file', payload: { reservationId } },
                  AbortSignal.any([grant.signal, resources.signal]),
                  { waitForSourceSettlement: true },
                );
              } catch {
                // Lost/revoked drive cannot certify a backend release. D keeps
                // its original held slot until the independent cleanup joins it.
              }
            }
          })().finally(settle);
        },
      };
      return Object.freeze(reservation);
    },
  };
}
