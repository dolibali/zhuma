import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalPayload,
  MemberAssetFileDeclareSchema,
  MemberAssetReferenceSchema,
  remoteRunErrorSchema,
  remoteRunScopeSchema,
  type MemberAssetFileDeclare,
  type MemberAssetReference,
  type RemoteRunScope,
} from '@zhuma/agent-core';

/** Host-private wire values. These byte proofs do not grant a native read. */
export interface MemberLocalTeamAssetFileValue {
  readonly scope: RemoteRunScope;
  readonly reference: MemberAssetReference;
  readonly file: MemberAssetFileDeclare;
}
export interface MemberLocalTeamAssetFileRead extends MemberLocalTeamAssetFileValue {
  readonly bytes: Uint8Array;
}
export interface MemberLocalTrackedOperation<T> {
  readonly result: Promise<T>;
  /** Authentication and the actual HTTP body/cancellation have settled. This
   * is not an acknowledgement that the remote server's leases have drained. */
  readonly drain: Promise<void>;
}
export class MemberLocalTeamAssetTransportError extends Error {
  constructor(readonly code: 'protocol' | 'limit') {
    super('团队资产文件通信未完成。');
  }
}
const valueSchema = z.strictObject({
  scope: remoteRunScopeSchema,
  reference: MemberAssetReferenceSchema.refine((value) => value.kind === 'file'),
  file: MemberAssetFileDeclareSchema,
});
const responseSchema = z.strictObject({
  type: z.literal('server-response'),
  rpcId: z.uuid(),
  result: z.union([
    z.strictObject({ ok: z.literal(true), value: valueSchema }),
    remoteRunErrorSchema,
  ]),
});
export function readMemberLocalTeamAssetFileValue(raw: unknown): MemberLocalTeamAssetFileValue {
  return valueSchema.parse(raw);
}
type Failure = z.infer<typeof remoteRunErrorSchema>;
export type MemberLocalTeamAssetResponse<Mode extends 'read' | 'check'> =
  | Failure
  | {
      readonly ok: true;
      readonly value: Mode extends 'read'
        ? MemberLocalTeamAssetFileRead
        : MemberLocalTeamAssetFileValue;
    };
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalPayload(value)).digest('hex');
const fail = (): never => {
  throw new MemberLocalTeamAssetTransportError('protocol');
};
function qualify(raw: unknown, expected: MemberLocalTeamAssetFileValue) {
  const parsed = valueSchema.safeParse(raw);
  if (!parsed.success || canonicalPayload(parsed.data) !== canonicalPayload(expected)) fail();
  return parsed.data;
}
async function body(response: Response, maximum: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return fail();
  // The declared bound is at most 20MiB (JSON uses 16KiB). A single buffer
  // also bounds memory when a producer emits arbitrarily many tiny chunks.
  const bytes = Buffer.allocUnsafe(maximum);
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new MemberLocalTeamAssetTransportError('limit');
      // A custom producer may reuse/mutate its buffer on the next pull.
      bytes.set(next.value, size - next.value.byteLength);
    }
  } catch (error) {
    if (error instanceof MemberLocalTeamAssetTransportError) throw error;
    return fail();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}
/** Only the dedicated fixed endpoint calls this decoder. Never infer a file
 * read from a JSON success, truncated body, or matching reference alone. */
export async function readMemberLocalTeamAssetResponse<Mode extends 'read' | 'check'>(
  response: Response,
  rpcId: string,
  mode: Mode,
  expected: MemberLocalTeamAssetFileValue,
  signal: AbortSignal,
): Promise<MemberLocalTeamAssetResponse<Mode>> {
  try {
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mode === 'check' || response.status !== 200) {
      if (type !== 'application/json') return fail();
      const bytes = await body(response, 16 * 1024, signal),
        parsed = responseSchema.safeParse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
      if (!parsed.success || parsed.data.rpcId !== rpcId) return fail();
      const result = parsed.data.result;
      if (!result.ok) return result;
      if (mode !== 'check' || response.status !== 200) return fail();
      return {
        ok: true,
        value: qualify(result.value, expected),
      } as MemberLocalTeamAssetResponse<Mode>;
    }
    if (type !== 'application/octet-stream') return fail();
    const headers = response.headers;
    if (
      headers.get('x-zhuma-rpc-id') !== rpcId ||
      headers.get('x-zhuma-run-scope-sha256') !== digest(expected.scope) ||
      headers.get('content-length') !== String(expected.file.byteSize) ||
      (headers.get('content-encoding') !== null && headers.get('content-encoding') !== 'identity')
    )
      return fail();
    qualify(
      {
        scope: expected.scope,
        reference: JSON.parse(
          decodeURIComponent(headers.get('x-zhuma-team-asset-reference') ?? ''),
        ),
        file: JSON.parse(decodeURIComponent(headers.get('x-zhuma-team-asset-file') ?? '')),
      },
      expected,
    );
    const bytes = await body(response, expected.file.byteSize, signal);
    if (
      bytes.byteLength !== expected.file.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== expected.file.sha256
    )
      return fail();
    signal.throwIfAborted();
    return { ok: true, value: { ...expected, bytes } } as MemberLocalTeamAssetResponse<Mode>;
  } finally {
    // Header/schema failures also own cancellation until its real settlement.
    await response.body?.cancel().catch(() => undefined);
  }
}
