import type { ArtifactFileRef } from '@zhuma/agent-core';
import { ExecutionError, readArtifactFileReference, type RevisionQuery } from './ExecutionApi.js';

export const FILE_LIMITS = { bytes: 20 * 1024 * 1024, count: 20, operationMs: 65_000 } as const;
export type FileTarget = RevisionQuery &
  (
    | { readonly purpose: 'draft' }
    | { readonly purpose: 'artifact'; readonly artifactVersionId: string }
    | {
        readonly purpose: 'accepted';
        readonly projectId: string;
        readonly artifactVersionId: string;
      }
    | { readonly purpose: 'review'; readonly artifactVersionId: string; readonly roundId: string }
    | {
        readonly purpose: 'upstream';
        readonly artifactVersionId: string;
        readonly sourceNodeId: string;
      }
  );
export type FileQuery = FileTarget & { readonly uploadId: string };
type FileRequest = FileQuery & {
  readonly spaceId: string;
  readonly mode: 'metadata' | 'preview' | 'download';
};
export interface FileInfo {
  readonly request: FileRequest;
  readonly uploadId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reference: ArtifactFileRef;
}
export interface FileUploadReceipt {
  readonly uploadId: string;
  readonly name: string;
  readonly reference: ArtifactFileRef;
}
export interface ExecutionFilesApi {
  upload(
    input: { readonly target: RevisionQuery; readonly file: File; readonly requestId: string },
    signal: AbortSignal,
    phase?: (phase: 'preparing' | 'uploading') => void,
  ): Promise<FileUploadReceipt>;
  metadata(query: FileQuery, signal: AbortSignal): Promise<FileInfo>;
  read(
    query: FileQuery,
    mode: 'preview' | 'download',
    signal: AbortSignal,
  ): Promise<{ readonly info: FileInfo; readonly bytes: Uint8Array; readonly inline: boolean }>;
}
interface Guard {
  authorize(signal: AbortSignal, caller: AbortSignal): Promise<void>;
  current(signal: AbortSignal): void;
  observed<T>(request: Promise<T>, caller: AbortSignal): Promise<T>;
}
const messages: Record<string, string> = {
  'not-found': '当前文件不可读取，请刷新工作项。',
  unauthenticated: '登录已失效，请重新登录。',
  'untrusted-request': '当前入口无法处理文件，请重新打开工作台。',
  'file-too-large': '单个文件不能超过 20 MiB。',
  'file-timeout': '文件读取超时，请重试。',
  'upload-timeout': '上传尚未确认完成，请使用原文件重试。',
  'digest-mismatch': '文件校验未通过，请使用原文件重试。',
  'idempotency-mismatch': '重试内容与原上传不一致，请重新选择文件。',
  conflict: '该文件仍在上传或校验中，请稍后重试。',
  cancelled: '文件操作已取消。',
  unavailable: '文件暂不可用，请重试。',
};
function fail(code = 'validation'): never {
  throw new ExecutionError(code, messages[code] ?? '文件操作未完成，请刷新后重试。');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail();
  return value;
}
function bytes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > FILE_LIMITS.bytes
  )
    fail();
  return value;
}
function leaf(value: unknown): string {
  const name = text(value, 255);
  if (/[\x00-\x1f\x7f/\\]/.test(name) || ['.', '..'].includes(name)) fail();
  return name;
}
function digest(value: unknown): string {
  const hash = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail();
  return hash;
}
function location(raw: RevisionQuery): RevisionQuery {
  if (!Number.isSafeInteger(raw.revision) || raw.revision <= 0) fail();
  return {
    taskId: text(raw.taskId, 200),
    planId: text(raw.planId, 200),
    revision: raw.revision,
    nodeId: text(raw.nodeId, 200),
  };
}
function request(raw: FileQuery, spaceId: string, mode: FileRequest['mode']): FileRequest {
  const base = { ...location(raw), spaceId, uploadId: text(raw.uploadId, 200), mode };
  switch (raw.purpose) {
    case 'draft':
      return { ...base, purpose: 'draft' };
    case 'artifact':
      return { ...base, purpose: 'artifact', artifactVersionId: text(raw.artifactVersionId) };
    case 'accepted':
      return {
        ...base,
        purpose: 'accepted',
        projectId: text(raw.projectId, 200),
        artifactVersionId: text(raw.artifactVersionId),
      };
    case 'review':
      return {
        ...base,
        purpose: 'review',
        artifactVersionId: text(raw.artifactVersionId),
        roundId: text(raw.roundId),
      };
    case 'upstream':
      return {
        ...base,
        purpose: 'upstream',
        artifactVersionId: text(raw.artifactVersionId),
        sourceNodeId: text(raw.sourceNodeId, 200),
      };
    default:
      return fail();
  }
}
function echo(raw: unknown, expected: FileRequest): void {
  const value = object(raw);
  if (
    Object.keys(value).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, entry]) => value[key] !== entry)
  )
    fail();
}
function info(raw: unknown, expected: FileRequest): FileInfo {
  const value = object(raw);
  echo(value.request, expected);
  const uploadId = text(value.uploadId),
    size = bytes(value.bytes),
    sha256 = digest(value.sha256);
  const reference = readArtifactFileReference(value.reference);
  const mediaType = text(value.mediaType, 200);
  if (
    uploadId !== expected.uploadId ||
    reference.id !== uploadId ||
    !reference.uploadComplete ||
    reference.byteSize !== size ||
    reference.checksum !== sha256 ||
    reference.mediaType !== mediaType ||
    reference.accessPolicyId !== `space:${expected.spaceId}`
  )
    fail();
  return {
    request: expected,
    uploadId,
    name: leaf(value.name),
    mediaType,
    bytes: size,
    sha256,
    reference,
  };
}
async function sha256(value: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
  return [...new Uint8Array(buffer)].map((part) => part.toString(16).padStart(2, '0')).join('');
}
/** Bounded response consumption also cancels late/oversized bodies. */
async function consume(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) fail();
  const chunks: Uint8Array[] = [];
  let total = 0,
    done = false;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        done = true;
        break;
      }
      total += next.value.byteLength;
      if (total > limit) fail();
      chunks.push(next.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function json(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (response.status === 401) {
    await response.body?.cancel();
    fail('unauthenticated');
  }
  if (response.status === 403) {
    await response.body?.cancel();
    fail('untrusted-request');
  }
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(new TextDecoder().decode(await consume(response, 32768, signal))));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ExecutionError) throw error;
    return fail();
  }
  if (!response.ok || value.ok !== true) {
    const error =
      value.error && typeof value.error === 'object'
        ? (value.error as Record<string, unknown>)
        : {};
    fail(typeof error.code === 'string' ? error.code : 'unavailable');
  }
  return object(value.value);
}
/** Exact member byte routes; general account checks complement, never replace, Host object authorization. */
export function createExecutionFilesApi(
  fetcher: typeof fetch,
  spaceId: string,
  guard: Guard,
): ExecutionFilesApi {
  async function operation<T>(
    caller: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return guard.observed(
      (async () => {
        const signal = AbortSignal.any([caller, AbortSignal.timeout(FILE_LIMITS.operationMs)]);
        await guard.authorize(signal, caller);
        const result = await run(signal);
        guard.current(signal);
        await guard.authorize(signal, caller);
        guard.current(signal);
        return result;
      })(),
      caller,
    );
  }
  function fetchFile(query: FileRequest, signal: AbortSignal) {
    const params = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    );
    return fetcher(`/api/zhuma-exec/file?${params}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  }
  async function metadata(query: FileQuery, caller: AbortSignal): Promise<FileInfo> {
    return operation(caller, async (signal) => {
      const expected = request(query, spaceId, 'metadata');
      const response = await fetchFile(expected, signal);
      try {
        guard.current(signal);
        return info(await json(response, signal), expected);
      } finally {
        if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
      }
    });
  }
  return {
    metadata,
    async upload(input, caller, phase) {
      return operation(caller, async (signal) => {
        const target = location(input.target),
          name = leaf(input.file.name),
          size = bytes(input.file.size);
        const mediaType = input.file.type || 'application/octet-stream';
        const idempotencyKey = text(input.requestId, 200);
        phase?.('preparing');
        const data = new Uint8Array(await input.file.arrayBuffer());
        guard.current(signal);
        if (data.length !== size) fail();
        const hash = await sha256(data);
        await guard.authorize(signal, caller);
        guard.current(signal);
        phase?.('uploading');
        const response = await fetcher('/api/zhuma-exec/upload-file', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
          headers: {
            'content-type': 'application/octet-stream',
            'x-zhuma-file-name': encodeURIComponent(name),
            'x-zhuma-file-type': mediaType,
            'x-zhuma-file-size': String(size),
            'x-zhuma-file-sha256': hash,
            'x-zhuma-space': spaceId,
            'x-zhuma-task': target.taskId,
            'x-zhuma-plan': target.planId,
            'x-zhuma-revision': String(target.revision),
            'x-zhuma-node': target.nodeId,
            'x-zhuma-idempotency-key': idempotencyKey,
          },
          body: new Blob([new Uint8Array(data)]),
        });
        try {
          guard.current(signal);
          const value = await json(response, signal),
            reference = readArtifactFileReference(value.reference);
          if (
            text(value.uploadId) !== reference.id ||
            value.name !== name ||
            value.bytes !== size ||
            value.mediaType !== mediaType ||
            value.sha256 !== hash ||
            value.attachmentId !== `sha256:${hash}` ||
            !reference.uploadComplete ||
            reference.byteSize !== size ||
            reference.checksum !== hash ||
            reference.mediaType !== mediaType ||
            reference.accessPolicyId !== `space:${spaceId}`
          )
            fail();
          return { uploadId: reference.id, name, reference };
        } finally {
          if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
        }
      });
    },
    async read(query, mode, caller) {
      return operation(caller, async (signal) => {
        const metadataRequest = request(query, spaceId, 'metadata');
        const metadataResponse = await fetchFile(metadataRequest, signal);
        let metadata: FileInfo;
        try {
          guard.current(signal);
          metadata = info(await json(metadataResponse, signal), metadataRequest);
        } finally {
          if (!metadataResponse.bodyUsed)
            await metadataResponse.body?.cancel().catch(() => undefined);
        }
        guard.current(signal);
        const expected = request(query, spaceId, mode),
          response = await fetchFile(expected, signal);
        try {
          guard.current(signal);
          if (
            !response.ok ||
            response.headers.get('content-type')?.startsWith('application/json')
          ) {
            await json(response, signal);
            return fail();
          }
          let context: unknown;
          try {
            context = JSON.parse(
              decodeURIComponent(response.headers.get('x-zhuma-file-context') ?? ''),
            );
          } catch {
            return fail();
          }
          echo(context, expected);
          // Fetch exposes decoded bytes. Content-Length describes HTTP framing
          // and may be omitted by streaming/native carriers or describe gzip.
          const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
          const length = response.headers.get('content-length');
          if (
            response.headers.get('x-zhuma-file-upload-id') !== metadata.uploadId ||
            response.headers.get('x-zhuma-file-sha256') !== metadata.sha256 ||
            ((!encoding || encoding === 'identity') &&
              length !== null &&
              length !== String(metadata.bytes))
          )
            fail();
          const data = await consume(response, metadata.bytes, signal);
          guard.current(signal);
          if (data.length !== metadata.bytes || (await sha256(data)) !== metadata.sha256)
            fail('digest-mismatch');
          const inline =
            mode === 'preview' &&
            response.headers.get('content-type')?.toLowerCase() === 'text/plain; charset=utf-8' &&
            response.headers.get('content-disposition')?.startsWith('inline;') === true;
          if (inline) {
            let plain: string;
            try {
              plain = new TextDecoder('utf-8', { fatal: true }).decode(data);
            } catch {
              return fail();
            }
            if (/[\0<]/.test(plain)) fail();
          }
          return { info: { ...metadata, request: expected }, bytes: data, inline };
        } finally {
          if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
        }
      });
    },
  };
}
