import {
  MEMBER_ASSET_LIMITS,
  MemberAssetFolderListQuerySchema,
  MemberAssetFolderListValueSchema,
  MemberAssetFolderCreateSchema,
  MemberAssetFolderCreateValueSchema,
  MemberAssetCommandSchema,
  MemberAssetCommandValueSchema,
  MemberAssetPreviewImportQuerySchema,
  MemberAssetPreviewImportValueSchema,
  MemberAssetImportDraftsQuerySchema,
  MemberAssetImportDraftsValueSchema,
  MEMBER_ASSET_IMPORT_LIMITS,
  MemberAssetErrorCodeSchema,
  MemberAssetFileDeclareSchema,
  MemberAssetFileReadSchema,
  MemberAssetFileReserveSchema,
  MemberAssetLegacySourceSchema,
  MemberAssetLegacySourceValueSchema,
  MemberAssetListQuerySchema,
  MemberAssetListValueSchema,
  MemberAssetReadQuerySchema,
  MemberAssetReadValueSchema,
  MemberAssetReferenceSchema,
  MemberAssetReferenceValueSchema,
  TeamAssetCatalogQuerySchema,
  TeamAssetCatalogValueSchema,
  type MemberAssetFolderListQuery,
  type MemberAssetFolderListValue,
  type MemberAssetFolderCreate,
  type MemberAssetFolderCreateValue,
  type MemberAssetCommand,
  type MemberAssetCommandValue,
  type MemberAssetPreviewImportQuery,
  type MemberAssetPreviewImportValue,
  type MemberAssetImportDraftsQuery,
  type MemberAssetImportDraftsValue,
  type MemberAssetFileDeclare,
  type MemberAssetFileRead,
  type MemberAssetFileReserve,
  type MemberAssetLegacySource,
  type MemberAssetLegacySourceValue,
  type MemberAssetListQuery,
  type MemberAssetListValue,
  type MemberAssetReadQuery,
  type MemberAssetReadValue,
  type MemberAssetReference,
  type MemberAssetReferenceValue,
  type TeamAssetCatalogQuery,
  type TeamAssetCatalogValue,
} from '@zhuma/agent-core';
import { createIdentityApi, IdentityApiError } from '../identity/api.js';
import type { MemberWorkbenchScope } from '../workbench/member-api.js';

const messages = {
  'asset-unavailable': '资产服务暂不可用，请稍后重试。',
  'asset-not-found': '找不到该资产或固定版本。',
  'asset-forbidden': '当前账号没有此资产的操作权限。',
  'asset-conflict': '资产已更新，请重新读取后再编辑。',
  'asset-request-reused': '原请求内容不一致，请核对操作结果。',
  'asset-quota': '资产或文件已达到容量限制。',
  'asset-invalid': '提交的数据不完整，请检查后再试。',
  'asset-dependency-required': '请先选择所需的固定依赖版本。',
  'asset-reference-denied': '当前不能使用此资产或依赖版本。',
  'asset-upload-pending': '该资产的上传仍在处理，请稍后核对。',
  'asset-file-invalid': '文件长度或摘要校验失败。',
  'asset-cancelled': '操作尚未确认，请核对原结果。',
  'invalid-response': '返回内容与当前资产不一致，请重新读取。',
  unauthenticated: '登录已变化，请重新登录。',
  forbidden: '当前空间已不可访问。',
};
export class MemberAssetClientError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    /** A lost response is not a failed business write. Retry the same intent. */
    readonly outcome: 'rejected' | 'unknown' = 'rejected',
  ) {
    super(messages[code]);
    this.name = 'MemberAssetClientError';
  }
}
export interface MemberAssetUploadReceipt {
  readonly spaceId: string;
  readonly assetId: string;
  readonly idempotencyKey: string;
  readonly assetVersion: number;
  readonly file: MemberAssetFileDeclare;
}
export interface MemberAssetFileContent {
  readonly blob: Blob;
  readonly contentType: string;
  readonly inline: boolean;
}
export interface MemberAssetApi {
  listFolder(
    input: MemberAssetFolderListQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetFolderListValue>;
  createFolder(
    input: MemberAssetFolderCreate,
    signal: AbortSignal,
  ): Promise<MemberAssetFolderCreateValue>;
  previewImport(
    input: MemberAssetPreviewImportQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetPreviewImportValue>;
  importDrafts(
    input: MemberAssetImportDraftsQuery,
    signal: AbortSignal,
  ): Promise<MemberAssetImportDraftsValue>;
  catalog(input: TeamAssetCatalogQuery, signal: AbortSignal): Promise<TeamAssetCatalogValue>;
  list(input: MemberAssetListQuery, signal: AbortSignal): Promise<MemberAssetListValue>;
  read(input: MemberAssetReadQuery, signal: AbortSignal): Promise<MemberAssetReadValue>;
  source(
    input: MemberAssetLegacySource,
    signal: AbortSignal,
  ): Promise<MemberAssetLegacySourceValue>;
  reference(input: MemberAssetReference, signal: AbortSignal): Promise<MemberAssetReferenceValue>;
  command(input: MemberAssetCommand, signal: AbortSignal): Promise<MemberAssetCommandValue>;
  upload(
    input: MemberAssetFileReserve,
    file: Blob,
    signal: AbortSignal,
  ): Promise<MemberAssetUploadReceipt>;
  file(
    input: MemberAssetFileRead & { mode: 'preview' | 'download' },
    expected: MemberAssetFileDeclare,
    signal: AbortSignal,
  ): Promise<MemberAssetFileContent>;
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> =>
  object(raw) &&
  Object.keys(raw).length === keys.length &&
  keys.every((key) => Object.hasOwn(raw, key));
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => same(a[key], b[key]));
};
const invalid = (): never => {
  throw new MemberAssetClientError('invalid-response');
};
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');

/** Member-only transport. Core codecs own DTOs; the live identity, view epoch,
 * exact RPC and full object/version selection must agree before publication. */
export function createMemberAssetApi(
  scope: MemberWorkbenchScope,
  fetcher: typeof fetch = globalThis.fetch,
): MemberAssetApi {
  const identity = createIdentityApi(fetcher);
  const current = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!scope.isCurrent()) throw new DOMException('Asset view changed', 'AbortError');
  };
  const space = (spaceId: string) => {
    if (spaceId !== scope.spaceId) throw new MemberAssetClientError('forbidden');
  };
  const actor = (actorId: string) => {
    if (actorId !== scope.actorId) {
      scope.onUnauthenticated();
      throw new MemberAssetClientError('unauthenticated');
    }
  };
  async function inspect(signal: AbortSignal) {
    current(signal);
    try {
      const value = await identity.session(signal);
      current(signal);
      actor(value.accountId);
      if (!value.spaces.some(({ id }) => id === scope.spaceId)) {
        scope.onUnavailable();
        throw new MemberAssetClientError('forbidden');
      }
    } catch (error) {
      current(signal);
      if (error instanceof MemberAssetClientError) throw error;
      if (
        error instanceof IdentityApiError &&
        ['unauthenticated', 'member-session-required', 'session-changed'].includes(error.code)
      ) {
        scope.onUnauthenticated();
        throw new MemberAssetClientError('unauthenticated');
      }
      throw new MemberAssetClientError('asset-unavailable');
    }
  }
  async function bytes(
    response: Response,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const reader = response.body?.getReader();
    if (!reader) return invalid();
    const chunks: Uint8Array[] = [];
    let count = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        current(signal);
        const next = await reader.read();
        current(signal);
        if (next.done) break;
        count += next.value.byteLength;
        if (count > limit) return invalid();
        chunks.push(next.value);
      }
      const output = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async function json(response: Response, signal: AbortSignal): Promise<unknown> {
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      scope.onUnauthenticated();
      throw new MemberAssetClientError('unauthenticated');
    }
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
      await response.body?.cancel().catch(() => undefined);
      return invalid();
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await bytes(response, MEMBER_ASSET_LIMITS.registryBytes + 2 * 1024 * 1024, signal),
        ),
      );
    } catch (error) {
      current(signal);
      if (error instanceof MemberAssetClientError) throw error;
      return invalid();
    }
  }
  function result(raw: unknown): unknown {
    if (!object(raw) || typeof raw.ok !== 'boolean') return invalid();
    if (!raw.ok) {
      const parsed = MemberAssetErrorCodeSchema.safeParse(
        object(raw.error) ? raw.error.code : undefined,
      );
      if (!parsed.success) return invalid();
      throw new MemberAssetClientError(parsed.data);
    }
    if (!exact(raw, ['ok', 'value'])) return invalid();
    return raw.value;
  }
  async function call<T extends { actorId: string }>(
    endpoint: string,
    payload: { spaceId: string },
    schema: { parse(raw: unknown): T },
    signal: AbortSignal,
  ): Promise<T> {
    space(payload.spaceId);
    await inspect(signal);
    const rpcId = crypto.randomUUID();
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method: `zhuma-member/${endpoint}`,
      payload,
    });
    if (
      (endpoint === 'asset-preview-import' || endpoint === 'asset-import-drafts') &&
      new TextEncoder().encode(body).byteLength > MEMBER_ASSET_IMPORT_LIMITS.requestBytes
    )
      throw new MemberAssetClientError('asset-quota');
    const response = await fetcher(`/api/zhuma-member/${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
    const raw = await json(response, signal);
    current(signal);
    if (
      !exact(raw, ['type', 'rpcId', 'result']) ||
      raw.type !== 'server-response' ||
      raw.rpcId !== rpcId
    )
      return invalid();
    const selected = result(raw.result);
    if (!response.ok) return invalid();
    let value: T;
    try {
      value = schema.parse(selected);
    } catch {
      return invalid();
    }
    actor(value.actorId);
    current(signal);
    return value;
  }
  const dependencies = (refs: MemberAssetReadValue['dependencies']) => {
    for (const { reference } of refs) if (reference.spaceId !== scope.spaceId) invalid();
  };
  async function write<T>(perform: () => Promise<T>): Promise<T> {
    try {
      return await perform();
    } catch (error) {
      if (
        error instanceof MemberAssetClientError &&
        !['invalid-response', 'asset-unavailable', 'asset-cancelled'].includes(error.code)
      )
        throw error;
      // Never report network loss, cancellation or a malformed ACK as a rejected write.
      throw new MemberAssetClientError('asset-unavailable', 'unknown');
    }
  }
  return {
    async listFolder(input, signal) {
      const query = MemberAssetFolderListQuerySchema.parse(input);
      const value = await call(
        'asset-folder-list',
        query,
        MemberAssetFolderListValueSchema,
        signal,
      );
      if (value.spaceId !== query.spaceId || value.folderId !== query.folderId) invalid();
      return value;
    },
    async createFolder(input, signal) {
      const query = MemberAssetFolderCreateSchema.parse(input);
      space(query.spaceId);
      return write(async () => {
        const value = await call(
          'asset-folder-create',
          query,
          MemberAssetFolderCreateValueSchema,
          signal,
        );
        if (
          value.spaceId !== query.spaceId ||
          value.folder.spaceId !== query.spaceId ||
          value.folder.folderId !== query.folderId ||
          value.folder.parentFolderId !== query.parentFolderId ||
          value.folder.name !== query.name ||
          value.folder.createdBy !== scope.actorId
        )
          invalid();
        return value;
      });
    },
    async previewImport(input, signal) {
      const query = MemberAssetPreviewImportQuerySchema.parse(input);
      const value = await call(
        'asset-preview-import',
        query,
        MemberAssetPreviewImportValueSchema,
        signal,
      );
      if (value.spaceId !== query.spaceId) invalid();
      return value;
    },
    async importDrafts(input, signal) {
      const query = MemberAssetImportDraftsQuerySchema.parse(input);
      space(query.spaceId);
      return write(async () => {
        const value = await call(
          'asset-import-drafts',
          query,
          MemberAssetImportDraftsValueSchema,
          signal,
        );
        const ids = new Set(query.choices.map((choice) => choice.id));
        if (
          value.spaceId !== query.spaceId ||
          value.source.sha256 !== query.packageChecksum ||
          value.assets.length !== ids.size ||
          value.assets.some((asset) => !ids.has(asset.assetId))
        )
          invalid();
        return value;
      });
    },
    async catalog(input, signal) {
      const query = TeamAssetCatalogQuerySchema.parse(input);
      const value = await call('asset-catalog', query, TeamAssetCatalogValueSchema, signal);
      if (
        ['spaceId', 'category', 'search', 'offset', 'limit'].some(
          (key) => Reflect.get(value, key) !== Reflect.get(query, key),
        )
      )
        invalid();
      return value;
    },
    async list(input, signal) {
      const query = MemberAssetListQuerySchema.parse(input);
      const value = await call('asset-list', query, MemberAssetListValueSchema, signal);
      if (
        value.spaceId !== scope.spaceId ||
        value.items.some(
          (item) => item.spaceId !== scope.spaceId || (query.kind && item.kind !== query.kind),
        )
      )
        invalid();
      return value;
    },
    async read(input, signal) {
      const query = MemberAssetReadQuerySchema.parse(input);
      const value = await call('asset-read', query, MemberAssetReadValueSchema, signal);
      if (
        value.asset.spaceId !== query.spaceId ||
        value.asset.assetId !== query.assetId ||
        value.definition.kind !== value.asset.kind ||
        ('draft' in query
          ? value.selection.kind !== 'draft' ||
            value.selection.expectedVersion !== value.asset.version
          : value.selection.kind !== 'published' ||
            value.selection.reference.versionId !== query.versionId ||
            value.selection.reference.assetId !== query.assetId ||
            value.selection.reference.spaceId !== query.spaceId ||
            value.selection.reference.kind !== value.asset.kind)
      )
        invalid();
      dependencies(value.dependencies);
      if (
        (value.file && value.asset.kind !== 'file') ||
        (value.selection.kind === 'published' && value.asset.kind === 'file' && !value.file)
      )
        invalid();
      return value;
    },
    async source(input, signal) {
      const query = MemberAssetLegacySourceSchema.parse(input);
      const value = await call('asset-source', query, MemberAssetLegacySourceValueSchema, signal);
      if (value.spaceId !== query.spaceId || !same(value.source, query)) invalid();
      return value;
    },
    async reference(input, signal) {
      const query = MemberAssetReferenceSchema.parse(input);
      const value = await call('asset-reference', query, MemberAssetReferenceValueSchema, signal);
      if (!same(query, value.reference) || value.definition.kind !== query.kind) invalid();
      dependencies(value.dependencies);
      return value;
    },
    async command(input, signal) {
      const query = MemberAssetCommandSchema.parse(input);
      space(query.spaceId);
      return write(async () => {
        const value = await call('asset-command', query, MemberAssetCommandValueSchema, signal);
        if (
          value.asset.spaceId !== query.spaceId ||
          value.asset.assetId !== query.assetId ||
          value.asset.version < value.resultVersion ||
          (value.reference &&
            (value.reference.spaceId !== query.spaceId ||
              value.reference.assetId !== query.assetId ||
              value.reference.kind !== value.asset.kind)) ||
          (query.operation === 'publish' && !value.reference)
        )
          invalid();
        return value;
      });
    },
    async upload(input, file, signal) {
      const query = MemberAssetFileReserveSchema.parse(input);
      space(query.spaceId);
      if (file.size !== query.declare.byteSize)
        throw new MemberAssetClientError('asset-file-invalid');
      return write(async () => {
        await inspect(signal);
        const response = await fetcher('/api/zhuma-member/asset-file-upload', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
          headers: {
            'content-type': 'application/octet-stream',
            'x-zhuma-space-id': query.spaceId,
            'x-zhuma-asset-id': query.assetId,
            'x-zhuma-expected-version': String(query.expectedVersion),
            'x-zhuma-idempotency-key': query.idempotencyKey,
            'x-zhuma-file-name': encodeURIComponent(query.declare.name),
            'x-zhuma-file-type': query.declare.mediaType,
            'x-zhuma-file-size': String(query.declare.byteSize),
            'x-zhuma-file-sha256': query.declare.sha256,
          },
          body: file,
        });
        const raw = result(await json(response, signal));
        current(signal);
        if (
          !response.ok ||
          !exact(raw, ['spaceId', 'assetId', 'idempotencyKey', 'assetVersion', 'file']) ||
          raw.spaceId !== query.spaceId ||
          raw.assetId !== query.assetId ||
          raw.idempotencyKey !== query.idempotencyKey ||
          typeof raw.assetVersion !== 'number' ||
          !Number.isSafeInteger(raw.assetVersion) ||
          raw.assetVersion <= query.expectedVersion
        )
          return invalid();
        const declared = MemberAssetFileDeclareSchema.parse(raw.file);
        if (!same(declared, query.declare)) invalid();
        return {
          spaceId: query.spaceId,
          assetId: query.assetId,
          idempotencyKey: query.idempotencyKey,
          assetVersion: raw.assetVersion,
          file: declared,
        };
      });
    },
    async file(input, expected, signal) {
      const { mode, ...target } = input;
      const query = MemberAssetFileReadSchema.parse(target),
        file = MemberAssetFileDeclareSchema.parse(expected);
      space(query.spaceId);
      if (!['preview', 'download'].includes(mode))
        throw new MemberAssetClientError('asset-invalid');
      await inspect(signal);
      const rpcId = crypto.randomUUID();
      const response = await fetcher('/api/zhuma-member/asset-file-read', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'zhuma-member/asset-file-read',
          payload: { ...query, mode },
        }),
      });
      try {
        current(signal);
        if (!response.ok) {
          const raw = await json(response, signal);
          if (
            exact(raw, ['type', 'rpcId', 'result']) &&
            raw.type === 'server-response' &&
            raw.rpcId === rpcId
          )
            result(raw.result);
          else result(raw);
          return invalid();
        }
        const context = JSON.parse(
          decodeURIComponent(response.headers.get('x-zhuma-asset-file-context') ?? ''),
        );
        const contentType = response.headers.get('content-type') ?? '';
        if (
          !same(context, { ...query, mode }) ||
          response.headers.get('x-zhuma-file-sha256') !== file.sha256 ||
          ![
            'application/octet-stream',
            'text/plain; charset=utf-8',
            'image/png',
            'image/jpeg',
            'image/webp',
            'application/pdf',
          ].includes(contentType)
        )
          invalid();
        const received = await bytes(response, file.byteSize, signal);
        if (received.byteLength !== file.byteSize || (await sha256(received)) !== file.sha256)
          invalid();
        await inspect(signal);
        return {
          blob: new Blob([received], { type: contentType }),
          contentType,
          inline:
            mode === 'preview' &&
            /^inline(?:;|$)/u.test(response.headers.get('content-disposition') ?? ''),
        };
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}

/** Read the chosen local file only; no timers, fake percentage or upload claim. */
export async function describeMemberAssetFile(
  file: File,
  signal: AbortSignal,
): Promise<MemberAssetFileDeclare> {
  if (file.size > MEMBER_ASSET_LIMITS.fileBytes) throw new MemberAssetClientError('asset-quota');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const sha = await sha256(bytes);
  signal.throwIfAborted();
  return MemberAssetFileDeclareSchema.parse({
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    byteSize: bytes.byteLength,
    sha256: sha,
  });
}
