import { createHash, randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import {
  MEMBER_ASSET_LIMITS,
  MEMBER_ASSET_IMPORT_LIMITS,
  MemberAssetPreviewImportQuerySchema,
  MemberAssetPreviewImportValueSchema,
  MemberAssetImportDraftsQuerySchema,
  MemberAssetImportDraftsValueSchema,
  MemberAssetCommandSchema,
  MemberAssetCommandValueSchema,
  MemberAssetListQuerySchema,
  MemberAssetListValueSchema,
  MemberAssetLegacyListValueSchema,
  MemberAssetLegacySourceValueSchema,
  MemberAssetLegacySourceSchema,
  MemberAssetLegacySummarySchema,
  MemberAssetDefinitionSchema,
  MemberAssetFileBlobSchema,
  MemberAssetFileReserveSchema,
  MemberAssetFileReadSchema,
  MemberAssetReadQuerySchema,
  MemberAssetReadValueSchema,
  MemberAssetRecordSchema,
  MemberAssetReferenceSchema,
  MemberAssetReferenceValueSchema,
  MemberAssetFileSnapshotQuerySchema,
  MemberAssetRegistrySchema,
  MemberAssetFileSnapshotValueSchema,
  ParticipantSchema,
  AssetSchema,
  WorkbenchError,
  canonicalPayload,
  memberAssetVersionDigestInput,
  memberAssetDefinitionId,
  memberAssetImportSkillSlotId,
  applyResourceImport,
  emptyWorkbench,
  memberAssetFileSnapshotDigestInput,
  packageFileBytes,
  packageFileText,
  parseWorkflowTemplate,
  previewResourcePackage,
  type MemberAssetAuthority,
  type MemberAssetCommand,
  type MemberAssetCommandValue,
  type MemberAssetDefinition,
  type MemberAssetErrorCode,
  type MemberAssetListQuery,
  type MemberAssetPublishedVersion,
  type MemberAssetReadQuery,
  type MemberAssetRecord,
  type MemberAssetReference,
  type MemberAssetLegacySource,
  type MemberAssetFileSnapshot,
  type MemberAssetFileSnapshotQuery,
  type MemberAssetReadValue,
  type MemberAssetPreviewImportQuery,
  type MemberAssetImportDraftsQuery,
  type PackageFile,
} from '@zhuma/agent-core';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import type { MemberWorkbenchDirectory, MemberWorkbenchCatalog } from './member-workbench-dto.js';
import type { MemberRequest } from './member-session.js';
import type { WorkbenchService } from './workbench-service.js';
import type {
  MemberAssetSourceProvider,
  MemberAssetSourceSnapshot,
} from './member-asset-source-contract.js';
import type {
  MemberAssetFileAuthority,
  MemberAssetFileBlob,
  MemberAssetFileReserve,
  MemberAssetFileRead,
  MemberAssetFileTicket,
  MemberAssetFileReceipt,
} from './member-asset-file-contract.js';
import { preflightTeamAssetImport, type TeamAssetImportPreflight } from './team-asset-import.js';

const hash = (value: unknown) => createHash('sha256').update(canonicalPayload(value)).digest('hex');
/** UUIDv5 identifies an actual original immutable imported package, never a
 * publication or grant. Integrity/permission still use SHA256 and live leases. */
function importPackageVersion(actorId: string, spaceId: string, key: string) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const value = createHash('sha1')
    .update(namespace)
    .update(`zhuma:member-assets:import:1:${canonicalPayload({ actorId, spaceId, key })}`)
    .digest()
    .subarray(0, 16);
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const messages: Record<MemberAssetErrorCode, string> = {
  'asset-unavailable': '资产服务暂不可用。',
  'asset-not-found': '找不到该资产或固定版本。',
  'asset-forbidden': '当前成员没有此资产的操作权限。',
  'asset-conflict': '资产已变化，请重新读取后再操作。',
  'asset-request-reused': '请求标识已用于其他内容，请勿改变原请求重试。',
  'asset-quota': '资产或操作已达到容量限制。',
  'asset-invalid': '资产数据不完整或格式无效。',
  'asset-dependency-required': '请明确选择当前空间中有权使用的固定依赖版本。',
  'asset-reference-denied': '资产依赖或来源版本当前不可引用。',
  'asset-upload-pending': '该资产已有上传正在处理或等待结束。',
  'asset-file-invalid': '文件长度、摘要或固定引用校验失败。',
  'asset-cancelled': '资产操作已取消，必要时请核对原请求结果。',
};
function fail(code: MemberAssetErrorCode): never {
  throw new WorkbenchError(code, messages[code]);
}
interface Access {
  readonly actorId: string;
  readonly spaceId: string;
  readonly directory: MemberWorkbenchDirectory;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
interface FileTicketState {
  readonly ticket: MemberAssetFileTicket;
  readonly access: Access;
  readonly controller: AbortController;
  readonly input: MemberAssetFileReserve;
  readonly fingerprint: string;
  readonly done: Promise<void>;
  finish(): void;
  stamp: number;
  released: boolean;
  mode: 'pending' | 'committed';
}
interface FileReadState {
  readonly access: Access;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  release(): void;
}
type FileReservation =
  | { readonly mode: 'pending'; readonly stamp: number }
  | {
      readonly mode: 'committed';
      readonly stamp: number;
      readonly receipt: MemberAssetFileReceipt;
    };
export interface MemberAssetServiceOptions {
  readonly signal: AbortSignal;
  readonly memberLease: (request: MemberRequest) => Promise<ExecutionMemberLease>;
  readonly directory: () => MemberWorkbenchDirectory | undefined;
  readonly now?: () => string;
  readonly sources?: MemberAssetSourceProvider;
  /** Same Host catalog used by original member task creation, never a Client grant.
   * Projection below does not call this closure, so catalog assembly cannot recurse. */
  readonly catalog?: (spaceId: string) => Promise<MemberWorkbenchCatalog>;
}

/** Pure projection of this original fact owner's exact published files. The
 * caller still owns member/space/project authorization and the writer queue. */
export function memberAssetFixedFiles(
  raw: readonly MemberAssetRecord[],
  input: MemberAssetFileSnapshotQuery,
): MemberAssetFileSnapshot['files'] {
  const query = MemberAssetFileSnapshotQuerySchema.safeParse(input);
  if (!query.success) return fail('asset-reference-denied');
  if (!query.data.references.length) return [];
  const records = MemberAssetRegistrySchema.safeParse(raw);
  if (!records.success) return fail('asset-unavailable');
  return query.data.references.map((reference) => {
    const record = records.data.find(
      (value) => value.spaceId === query.data.spaceId && value.assetId === reference.assetId,
    );
    const version = record?.published.find(
      (value) => value.reference.versionId === reference.versionId,
    );
    if (
      record?.kind !== 'file' ||
      !version ||
      version.definition.kind !== 'file' ||
      canonicalPayload(version.reference) !== canonicalPayload(reference) ||
      hash(memberAssetVersionDigestInput(version)) !== reference.sha256
    )
      return fail('asset-reference-denied');
    if (!version.blob || version.blob.attachmentId !== `sha256:${version.blob.sha256}`)
      return fail('asset-file-invalid');
    const { attachmentId: _privateHandle, ...file } = version.blob;
    return { reference: version.reference, file };
  });
}

/** Pure Host projection, not a new grant or fact store. All historical publications
 * remain addressable; newer drafts/publications never mutate an old definition. */
export function memberAssetPublishedCatalog(
  raw: readonly MemberAssetRecord[],
  spaceId: string,
): MemberWorkbenchCatalog {
  const parsed = MemberAssetRegistrySchema.safeParse(raw);
  if (!parsed.success) return fail('asset-unavailable');
  const records = parsed.data;
  const experts: MemberWorkbenchCatalog['experts'][number][] = [];
  const assets: MemberWorkbenchCatalog['assets'][number][] = [];
  for (const record of records.filter((item) => item.spaceId === spaceId)) {
    if (record.kind === 'file') continue;
    for (const version of record.published) {
      if (hash(memberAssetVersionDigestInput(version)) !== version.reference.sha256)
        return fail('asset-unavailable');
      const skillIds: string[] = [];
      for (const dependency of version.dependencies) {
        if (dependency.reference.spaceId !== spaceId) return fail('asset-reference-denied');
        const source = records.find(
          (item) => item.spaceId === spaceId && item.assetId === dependency.reference.assetId,
        );
        const fixed = source?.published.find(
          (item) => item.reference.versionId === dependency.reference.versionId,
        );
        if (
          !fixed ||
          hash(memberAssetVersionDigestInput(fixed)) !== fixed.reference.sha256 ||
          canonicalPayload(fixed.reference) !== canonicalPayload(dependency.reference)
        )
          return fail('asset-reference-denied');
        if (dependency.reference.kind === 'skill')
          skillIds.push(memberAssetDefinitionId(fixed.reference));
      }
      const definition = version.definition;
      const common = {
        id: memberAssetDefinitionId(version.reference),
        name: definition.name,
        available: true,
        memberAsset: version.reference,
        ...('origin' in definition && definition.origin ? { origin: definition.origin } : {}),
      };
      if (definition.kind === 'expert')
        experts.push(
          ParticipantSchema.parse({
            ...common,
            kind: 'expert',
            role: definition.role,
            capabilities: definition.capabilities,
            instructions: definition.instructions,
            resourceBindings: { skillIds, mcpIds: [] },
          }),
        );
      else if (definition.kind !== 'file')
        assets.push(
          AssetSchema.parse({
            ...common,
            kind: definition.kind,
            description: definition.description,
            content: definition.content,
          }),
        );
    }
  }
  return structuredClone({ experts, assets });
}

/** One authority facade over the original Workbench fact and writer queue. */
export class MemberAssetService
  implements MemberAssetAuthority<MemberRequest>, MemberAssetFileAuthority
{
  private readonly lifetime = new AbortController();
  private readonly tickets = new WeakMap<object, FileTicketState>();
  private readonly files = new Set<FileTicketState>();
  private readonly fileSlots = new Set<string>();
  private readonly reads = new Set<FileReadState>();
  private readonly openings = new Set<Promise<unknown>>();
  private openingUploads = 0;
  private imports = 0;
  private openingReads = 0;
  private closed = false;
  private cleanupFailed = false;
  private closing: Promise<void> | undefined;
  private readonly leaseSource: MemberAssetServiceOptions['memberLease'];
  private readonly directorySource: MemberAssetServiceOptions['directory'];
  private readonly sourceProvider: MemberAssetServiceOptions['sources'];
  private readonly catalogSource: MemberAssetServiceOptions['catalog'];
  constructor(
    private readonly workbench: WorkbenchService,
    private readonly options: MemberAssetServiceOptions,
  ) {
    this.leaseSource = options.memberLease;
    this.directorySource = options.directory;
    this.sourceProvider = options.sources;
    this.catalogSource = options.catalog;
  }

  /** Host-private. Call only inside the original member scope's pre/post checks;
   * this method does not authorize a renderer, Run, or file read. */
  publishedDefinitions(spaceId: string): MemberWorkbenchCatalog {
    if (this.closed || this.options.signal.aborted || this.cleanupFailed)
      return fail('asset-unavailable');
    return memberAssetPublishedCatalog(this.workbench.memberAssetRecords(), spaceId);
  }

  /** Reference-only preparation for a newly admitted Run. Explicit fixed reads
   * later repeat original member, complete Run and FileAuthority checks. */
  fileSnapshot(request: MemberRequest, raw: MemberAssetFileSnapshotQuery, signal: AbortSignal) {
    const parsed = MemberAssetFileSnapshotQuerySchema.safeParse(raw);
    if (!parsed.success)
      return Promise.reject(new WorkbenchError('asset-invalid', messages['asset-invalid']));
    return this.scoped(request, parsed.data.spaceId, signal, async (access) => {
      const files = memberAssetFixedFiles(this.records(), parsed.data);
      files.sort((a, b) => a.reference.assetId.localeCompare(b.reference.assetId, 'en'));
      const snapshot: MemberAssetFileSnapshot = {
        sourceVersion: 'zhuma-native-team-assets@1',
        spaceId: access.spaceId,
        files,
        sha256: '0'.repeat(64),
      };
      snapshot.sha256 = hash(memberAssetFileSnapshotDigestInput(snapshot));
      return MemberAssetFileSnapshotValueSchema.parse({ actorId: access.actorId, snapshot });
    });
  }

  private async imported<T>(operation: () => Promise<T>): Promise<T> {
    if (this.imports >= MEMBER_ASSET_IMPORT_LIMITS.active)
      return Promise.reject(new WorkbenchError('asset-unavailable', messages['asset-unavailable']));
    this.imports++;
    try {
      return await operation();
    } finally {
      this.imports--;
    }
  }

  private async preflightImport(
    access: Access,
    upload: MemberAssetPreviewImportQuery['upload'],
  ): Promise<TeamAssetImportPreflight> {
    try {
      const result = await preflightTeamAssetImport(upload, {
        signal: access.signal,
        assertCurrent: access.assertCurrent,
      });
      access.assertCurrent();
      return result;
    } catch {
      access.assertCurrent();
      return fail('asset-invalid');
    }
  }

  previewImport(request: MemberRequest, raw: MemberAssetPreviewImportQuery, signal: AbortSignal) {
    const query = MemberAssetPreviewImportQuerySchema.safeParse(raw);
    if (!query.success)
      return Promise.reject(new WorkbenchError('asset-invalid', messages['asset-invalid']));
    return this.imported(() =>
      this.scoped(request, query.data.spaceId, signal, async (access) => {
        const { preview, packageChecksum } = await this.preflightImport(access, query.data.upload);
        return MemberAssetPreviewImportValueSchema.parse({
          actorId: access.actorId,
          spaceId: access.spaceId,
          packageChecksum,
          items: preview.items,
          ignored: preview.ignored,
        });
      }),
    );
  }

  importDrafts(request: MemberRequest, raw: MemberAssetImportDraftsQuery, signal: AbortSignal) {
    const query = MemberAssetImportDraftsQuerySchema.safeParse(raw);
    if (!query.success)
      return Promise.reject(new WorkbenchError('asset-invalid', messages['asset-invalid']));
    const input = query.data;
    return this.imported(() =>
      this.scoped(request, input.spaceId, signal, async (access) => {
        const actual = await this.preflightImport(access, input.upload);
        if (actual.packageChecksum !== input.packageChecksum) return fail('asset-conflict');
        if (
          input.choices.some(
            (choice) => !actual.preview.items.some((item) => item.key === choice.key),
          )
        )
          return fail('asset-invalid');
        const packageVersionId = importPackageVersion(
          access.actorId,
          access.spaceId,
          input.idempotencyKey,
        );
        const fingerprint = hash({
          actorId: access.actorId,
          spaceId: access.spaceId,
          operation: 'import-drafts',
          packageChecksum: actual.packageChecksum,
          choices: input.choices,
        });
        const source = {
          kind: 'import' as const,
          versionId: packageVersionId,
          sha256: actual.packageChecksum,
        };
        // Only original static parsing: this temporary Workbench is never stored,
        // enabled or used as task authority. Include all package items to retain
        // physical missing-file information separately from unpublished choices.
        const usedNames = new Set(
          input.choices.map((choice) => choice.name.normalize('NFC').toLowerCase()),
        );
        const parsed = applyResourceImport(emptyWorkbench(), {
          versionId: packageVersionId,
          files: actual.preview.files,
          choices: actual.preview.items.map((item, index) => {
            const selected = input.choices.find((choice) => choice.key === item.key);
            let temporaryName = `source-item-${index}`,
              suffix = 0;
            while (usedNames.has(temporaryName)) temporaryName = `source-item-${index}-${++suffix}`;
            usedNames.add(temporaryName);
            return {
              key: item.key,
              id: selected?.id ?? `source-item-${index}`,
              name: selected?.name ?? temporaryName,
              description: selected?.description ?? item.description,
              role: selected?.role ?? item.role,
              capabilities: selected?.capabilities ?? item.capabilities,
              replace: false,
              available: true,
            };
          }),
        });
        return this.workbench.memberAssetCommand(
          access.signal,
          access.assertCurrent,
          async (records) => {
            const prior = records.filter(
              (record) =>
                record.spaceId === access.spaceId &&
                record.ownerId === access.actorId &&
                record.receipts.some(
                  (receipt) =>
                    receipt.operation === 'import-drafts' &&
                    receipt.idempotencyKey === input.idempotencyKey,
                ),
            );
            const result = (
              disposition: 'applied' | 'replayed',
              rows: readonly MemberAssetRecord[],
            ) =>
              MemberAssetImportDraftsValueSchema.parse({
                disposition,
                actorId: access.actorId,
                spaceId: access.spaceId,
                source,
                assets: input.choices.map((choice) => {
                  const record = rows.find((item) => item.assetId === choice.id);
                  if (!record) return fail('asset-unavailable');
                  return this.summary(access, record, true);
                }),
                resultVersions: input.choices.map((choice) => ({ assetId: choice.id, version: 1 })),
              });
            if (prior.length) {
              if (
                prior.length !== input.choices.length ||
                prior.some(
                  (record) =>
                    !input.choices.some((choice) => choice.id === record.assetId) ||
                    !record.receipts.some(
                      (receipt) =>
                        receipt.idempotencyKey === input.idempotencyKey &&
                        receipt.fingerprint === fingerprint,
                    ),
                )
              )
                return fail('asset-request-reused');
              const original = this.workbench.memberAssetPackage(packageVersionId);
              if (!original || hash(original.files) !== actual.packageChecksum)
                return fail('asset-unavailable');
              return { value: result('replayed', prior) };
            }
            if (records.length + input.choices.length > MEMBER_ASSET_LIMITS.assets)
              return fail('asset-quota');
            if (
              input.choices.some((choice) => records.some((record) => record.assetId === choice.id))
            )
              return fail('asset-conflict');
            const created: MemberAssetRecord[] = input.choices.map((choice) => {
              this.dependencies(access, records, choice.dependencies);
              const item = actual.preview.items.find((item) => item.key === choice.key)!;
              let definition: MemberAssetDefinition;
              if (item.kind === 'expert') {
                const value = parsed.participants.find((value) => value.id === choice.id)!;
                definition = {
                  kind: 'expert',
                  name: value.name,
                  description: choice.description,
                  role: value.role,
                  capabilities: value.capabilities,
                  instructions: value.instructions,
                  ...(value.origin ? { origin: value.origin } : {}),
                };
              } else {
                const value = parsed.assets.find((value) => value.id === choice.id)!;
                definition = {
                  kind: item.kind,
                  name: value.name,
                  description: value.description,
                  content: value.content,
                  ...(value.origin ? { origin: value.origin } : {}),
                };
              }
              return MemberAssetRecordSchema.parse({
                schemaVersion: 1,
                spaceId: access.spaceId,
                assetId: choice.id,
                kind: item.kind,
                ownerId: access.actorId,
                maintainerIds: [access.actorId],
                version: 1,
                draft: {
                  definition,
                  dependencies: choice.dependencies,
                  source: {
                    ...source,
                    entryPath: item.key,
                    ...(item.sourceId ? { sourceId: item.sourceId } : {}),
                    ...(item.sourceVersion ? { sourceVersion: item.sourceVersion } : {}),
                  },
                },
                published: [],
                uploads: [],
                receipts: [
                  {
                    operation: 'import-drafts',
                    idempotencyKey: input.idempotencyKey,
                    fingerprint,
                    resultVersion: 1,
                  },
                ],
              });
            });
            const next = [...records, ...created];
            if (!MemberAssetRegistrySchema.safeParse(next).success) return fail('asset-quota');
            const oldPackage = this.workbench.memberAssetPackage(packageVersionId);
            if (oldPackage && hash(oldPackage.files) !== actual.packageChecksum)
              return fail('asset-request-reused');
            await this.workbench.putMemberAssetPackage({
              versionId: packageVersionId,
              files: actual.preview.files,
              digest: createHash('sha256')
                .update(JSON.stringify(actual.preview.files))
                .digest('hex'),
            });
            return { records: next, value: result('applied', created) };
          },
        );
      }),
    );
  }

  private importRequirements(
    access: Access,
    records: readonly MemberAssetRecord[],
    selected: NonNullable<MemberAssetRecord['draft']>,
  ): NonNullable<MemberAssetReadValue['requirements']> {
    if (selected.source?.kind !== 'import' || selected.definition.kind !== 'expert') return [];
    const source = selected.source;
    const original = this.workbench.memberAssetPackage(source.versionId);
    if (!original || hash(original.files) !== source.sha256) return fail('asset-unavailable');
    const key = source.entryPath ?? selected.definition.origin?.entryPath;
    const preview = previewResourcePackage(original.files, parseWorkflowTemplate);
    const item = preview.items.find((item) => item.key === key && item.kind === 'expert');
    if (!item) return fail('asset-unavailable');
    return item.skillKeys.map((sourceKey, index) => {
      const skill = preview.items.find((item) => item.key === sourceKey && item.kind === 'skill');
      const suggested =
        skill &&
        records.find((record) => {
          const candidate = (record.draft ?? record.published.at(-1))?.source;
          return (
            record.spaceId === access.spaceId &&
            record.kind === 'skill' &&
            (record.published.length || record.maintainerIds.includes(access.actorId)) &&
            candidate?.kind === 'import' &&
            candidate.versionId === source.versionId &&
            candidate.entryPath === sourceKey
          );
        });
      return {
        slotId: memberAssetImportSkillSlotId(index),
        kind: 'skill' as const,
        name: skill?.name ?? sourceKey.slice(0, 160),
        sourceKey,
        ...(suggested ? { suggestedAssetId: suggested.assetId } : {}),
      };
    });
  }

  private async publicationCatalog(
    access: Access,
    records: readonly MemberAssetRecord[],
    kind: MemberAssetRecord['kind'],
  ) {
    const provider = this.catalogSource;
    if (!provider || this.options.catalog !== provider) return fail('asset-unavailable');
    const raw = await provider(access.spaceId);
    access.assertCurrent();
    if (this.options.catalog !== provider) return fail('asset-unavailable');
    const experts = raw.experts.map((item) => ParticipantSchema.parse(item));
    const assets = raw.assets.map((item) => AssetSchema.parse(item));
    const state = this.workbench.snapshot();
    const participantIds = new Set([
      ...state.participants.map((p) => p.id),
      ...experts.map((p) => p.id),
      ...access.directory.membersForSpace(access.spaceId).map((p) => p.id),
    ]);
    const assetIds = new Set([...state.assets.map((a) => a.id), ...assets.map((a) => a.id)]);
    for (const record of records)
      for (const version of record.published) {
        if (record.kind === 'expert')
          participantIds.add(memberAssetDefinitionId(version.reference));
        else if (record.kind !== 'file') assetIds.add(memberAssetDefinitionId(version.reference));
      }
    if (
      participantIds.size + (kind === 'expert' ? 1 : 0) > 100 ||
      assetIds.size + (kind === 'expert' ? 0 : 1) > 100
    )
      return fail('asset-quota');
    return hash({ experts, assets });
  }

  private async access(
    request: MemberRequest,
    spaceId: string,
    caller: AbortSignal,
  ): Promise<Access> {
    if (this.cleanupFailed) return fail('asset-unavailable');
    if (this.closed || caller.aborted || this.options.signal.aborted)
      return fail('asset-cancelled');
    let lease: ExecutionMemberLease;
    try {
      lease = await this.leaseSource(request);
    } catch {
      return fail('asset-forbidden');
    }
    let directory: MemberWorkbenchDirectory | undefined;
    try {
      directory = this.directorySource();
    } catch {
      lease.release();
      return fail('asset-unavailable');
    }
    const signal = AbortSignal.any([
      caller,
      this.options.signal,
      this.lifetime.signal,
      lease.signal,
    ]);
    let released = false;
    const assertCurrent = () => {
      if (signal.aborted || released) return fail('asset-cancelled');
      if (
        this.options.memberLease !== this.leaseSource ||
        this.options.directory !== this.directorySource ||
        !directory ||
        this.directorySource() !== directory
      )
        return fail('asset-unavailable');
      try {
        lease.assertCurrent(spaceId);
      } catch {
        return fail('asset-forbidden');
      }
      const space = directory.space(spaceId);
      if (!space || !directory.isMember(spaceId, lease.memberId)) return fail('asset-forbidden');
      if (space.kind === 'personal') {
        const owner = directory.administratorForSpace?.(spaceId);
        if (!owner) return fail('asset-unavailable');
        if (owner !== lease.memberId) return fail('asset-forbidden');
      }
    };
    const release = () => {
      if (!released) {
        released = true;
        try {
          lease.release();
        } catch (error) {
          this.cleanupFailed = true;
          throw error;
        }
      }
    };
    try {
      assertCurrent();
      return {
        actorId: lease.memberId,
        spaceId,
        directory: directory!,
        signal,
        assertCurrent,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.lifetime.abort();
      for (const file of this.files) file.controller.abort();
      for (const read of this.reads) read.controller.abort();
      while (this.openings.size) await Promise.allSettled([...this.openings]);
      await Promise.all(
        [...this.files].map((file) => file.done).concat([...this.reads].map((read) => read.done)),
      );
      if (this.cleanupFailed) return fail('asset-unavailable');
    })());
  }

  private ownOpening<T>(operation: Promise<T>): Promise<T> {
    const guarded = operation.catch((error: unknown) => {
      if (error instanceof WorkbenchError && Object.hasOwn(messages, error.code))
        return fail(error.code as MemberAssetErrorCode);
      if (this.closed || this.lifetime.signal.aborted) return fail('asset-cancelled');
      return fail('asset-unavailable');
    });
    this.openings.add(guarded);
    void guarded.finally(() => this.openings.delete(guarded)).catch(() => undefined);
    return guarded;
  }

  private fenceFiles(spaceId: string, assetId: string): void {
    for (const state of this.files)
      if (state.input.spaceId === spaceId && state.input.assetId === assetId)
        state.controller.abort();
  }

  private scoped<T>(
    request: MemberRequest,
    spaceId: string,
    signal: AbortSignal,
    operation: (access: Access) => Promise<T>,
  ): Promise<T> {
    return this.ownOpening(
      (async () => {
        const access = await this.access(request, spaceId, signal);
        try {
          const value = await operation(access);
          access.assertCurrent();
          return value;
        } catch (error) {
          if (access.signal.aborted) return fail('asset-cancelled');
          throw error;
        } finally {
          access.release();
        }
      })(),
    );
  }

  private records(): readonly MemberAssetRecord[] {
    const parsed = MemberAssetRegistrySchema.safeParse(this.workbench.memberAssetRecords());
    if (!parsed.success) return fail('asset-unavailable');
    return parsed.data;
  }

  private async sourceFacts(
    request: MemberRequest,
    access: Access,
  ): Promise<MemberAssetSourceSnapshot> {
    access.assertCurrent();
    if (!this.sourceProvider || this.options.sources !== this.sourceProvider)
      return fail('asset-unavailable');
    const value = await this.sourceProvider(request, { spaceId: access.spaceId }, access.signal);
    access.assertCurrent();
    if (
      this.options.sources !== this.sourceProvider ||
      value.actorId !== access.actorId ||
      value.spaceId !== access.spaceId ||
      value.items.length > 200
    )
      return fail('asset-unavailable');
    const keys = new Set<string>();
    for (const item of value.items) {
      const summary = MemberAssetLegacySummarySchema.safeParse(item.summary);
      const definition = MemberAssetDefinitionSchema.safeParse(item.definition);
      if (
        !summary.success ||
        !definition.success ||
        summary.data.source.spaceId !== access.spaceId ||
        summary.data.kind !== definition.data.kind ||
        item.requirements.length > MEMBER_ASSET_LIMITS.dependencies
      )
        return fail('asset-unavailable');
      if (
        !MemberAssetLegacySourceValueSchema.safeParse({
          actorId: access.actorId,
          spaceId: access.spaceId,
          source: summary.data.source,
          definition: definition.data,
          requirements: item.requirements,
        }).success
      )
        return fail('asset-unavailable');
      const key = `${summary.data.kind}:${summary.data.source.assetId}`;
      if (keys.has(key)) return fail('asset-unavailable');
      keys.add(key);
    }
    return structuredClone(value);
  }

  async sources(request: MemberRequest, raw: { spaceId: string }, signal: AbortSignal) {
    const query = MemberAssetListQuerySchema.safeParse(raw);
    if (!query.success || query.data.kind || query.data.includeDrafts !== undefined)
      return fail('asset-invalid');
    return this.scoped(request, query.data.spaceId, signal, async (access) => {
      const value = await this.sourceFacts(request, access);
      return MemberAssetLegacyListValueSchema.parse({
        actorId: access.actorId,
        spaceId: access.spaceId,
        items: value.items.map((item) => item.summary),
      });
    });
  }

  async source(request: MemberRequest, raw: MemberAssetLegacySource, signal: AbortSignal) {
    const query = MemberAssetLegacySourceSchema.safeParse(raw);
    if (!query.success) return fail('asset-invalid');
    return this.scoped(request, query.data.spaceId, signal, async (access) => {
      const value = await this.sourceFacts(request, access);
      const item = value.items.find(
        (item) => canonicalPayload(item.summary.source) === canonicalPayload(query.data),
      );
      if (!item) return fail('asset-reference-denied');
      return MemberAssetLegacySourceValueSchema.parse({
        actorId: access.actorId,
        spaceId: access.spaceId,
        source: item.summary.source,
        definition: item.definition,
        requirements: item.requirements,
      });
    });
  }

  private find(records: readonly MemberAssetRecord[], spaceId: string, assetId: string) {
    const record = records.find((item) => item.spaceId === spaceId && item.assetId === assetId);
    if (!record) return fail('asset-not-found');
    return record;
  }

  private maintain(access: Access, record: MemberAssetRecord): void {
    access.assertCurrent();
    if (record.spaceId !== access.spaceId || !record.maintainerIds.includes(access.actorId))
      return fail('asset-forbidden');
  }

  private fixed(record: MemberAssetRecord, versionId: string): MemberAssetPublishedVersion {
    const version = record.published.find((item) => item.reference.versionId === versionId);
    if (!version) return fail('asset-not-found');
    if (hash(memberAssetVersionDigestInput(version)) !== version.reference.sha256)
      return fail('asset-unavailable');
    return version;
  }

  private summary(access: Access, record: MemberAssetRecord, withDraft = false) {
    const canMaintain = record.maintainerIds.includes(access.actorId);
    const selected =
      withDraft && canMaintain && record.draft
        ? record.draft
        : (record.published.at(-1) ?? (canMaintain ? record.draft : undefined));
    return {
      spaceId: record.spaceId,
      assetId: record.assetId,
      kind: record.kind,
      name: selected?.definition.name ?? record.assetId,
      description: selected?.definition.description ?? '',
      ownerId: record.ownerId,
      maintainerIds: [...record.maintainerIds],
      version: record.version,
      canMaintain,
      canPublish: canMaintain && !!record.draft,
      hasDraft: canMaintain && !!record.draft,
      versions: record.published.map(({ reference, number, publishedBy, publishedAt }) => ({
        reference,
        number,
        publishedBy,
        publishedAt,
      })),
    };
  }

  async list(request: MemberRequest, raw: MemberAssetListQuery, signal: AbortSignal) {
    const query = MemberAssetListQuerySchema.safeParse(raw);
    if (!query.success) return fail('asset-invalid');
    return this.scoped(request, query.data.spaceId, signal, async (access) => {
      const items = this.records().filter(
        (item) =>
          item.spaceId === access.spaceId &&
          (!query.data.kind || query.data.kind === item.kind) &&
          (item.published.length > 0 ||
            (query.data.includeDrafts &&
              item.draft &&
              item.maintainerIds.includes(access.actorId))),
      );
      return MemberAssetListValueSchema.parse({
        actorId: access.actorId,
        spaceId: access.spaceId,
        items: items.map((item) => this.summary(access, item, query.data.includeDrafts)),
      });
    });
  }

  async read(request: MemberRequest, raw: MemberAssetReadQuery, signal: AbortSignal) {
    const query = MemberAssetReadQuerySchema.safeParse(raw);
    if (!query.success) return fail('asset-invalid');
    return this.scoped(request, query.data.spaceId, signal, async (access) => {
      const record = this.find(this.records(), access.spaceId, query.data.assetId);
      const draft = 'draft' in query.data;
      if (draft) this.maintain(access, record);
      const selected =
        'draft' in query.data ? record.draft : this.fixed(record, query.data.versionId);
      if (!selected) return fail('asset-not-found');
      const { blob, ...definition } = selected;
      const requirements = this.importRequirements(access, this.records(), selected);
      return MemberAssetReadValueSchema.parse({
        actorId: access.actorId,
        asset: this.summary(access, record, draft),
        selection: draft
          ? { kind: 'draft', expectedVersion: record.version }
          : { kind: 'published', reference: (selected as MemberAssetPublishedVersion).reference },
        definition: definition.definition,
        dependencies: definition.dependencies,
        ...(definition.source ? { source: definition.source } : {}),
        ...(blob ? { file: this.fileDeclaration(blob) } : {}),
        ...(requirements.length ? { requirements } : {}),
      });
    });
  }

  async reference(request: MemberRequest, raw: MemberAssetReference, signal: AbortSignal) {
    const reference = MemberAssetReferenceSchema.safeParse(raw);
    if (!reference.success) return fail('asset-invalid');
    return this.scoped(request, reference.data.spaceId, signal, async (access) => {
      const record = this.find(this.records(), access.spaceId, reference.data.assetId);
      const version = this.fixed(record, reference.data.versionId);
      if (canonicalPayload(version.reference) !== canonicalPayload(reference.data))
        return fail('asset-reference-denied');
      this.dependencies(access, this.records(), version.dependencies);
      return MemberAssetReferenceValueSchema.parse({
        actorId: access.actorId,
        reference: version.reference,
        definition: version.definition,
        dependencies: version.dependencies,
        ...(version.blob ? { file: this.fileDeclaration(version.blob) } : {}),
      });
    });
  }

  private fileDeclaration(blob: {
    attachmentId: string;
    name: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
  }) {
    const { attachmentId: _privateHandle, ...file } = blob;
    return file;
  }

  private uploadReceipt(
    record: MemberAssetRecord,
    upload: MemberAssetRecord['uploads'][number],
  ): MemberAssetFileReceipt {
    if (
      upload.state !== 'committed' ||
      !upload.blob ||
      !upload.resultVersion ||
      upload.blob.attachmentId !== `sha256:${upload.blob.sha256}` ||
      canonicalPayload(this.fileDeclaration(upload.blob)) !== canonicalPayload(upload.declare)
    )
      return fail('asset-unavailable');
    return {
      spaceId: record.spaceId,
      assetId: record.assetId,
      idempotencyKey: upload.idempotencyKey,
      assetVersion: upload.resultVersion,
      file: this.fileDeclaration(upload.blob),
    };
  }

  reserveFile(request: MemberRequest, input: MemberAssetFileReserve, signal: AbortSignal) {
    return this.ownOpening(this.reserveFileInner(request, input, signal));
  }

  private async reserveFileInner(
    request: MemberRequest,
    raw: MemberAssetFileReserve,
    caller: AbortSignal,
  ) {
    const parsed = MemberAssetFileReserveSchema.safeParse(raw);
    if (!parsed.success) return fail('asset-invalid');
    const input = parsed.data;
    const slot = canonicalPayload({ spaceId: input.spaceId, assetId: input.assetId });
    // Authentication openings have their own bounded admission. Do not reveal
    // object occupancy/quota to an unqualified caller, even when all uploads
    // are retained awaiting their real physical drain.
    if (this.openingUploads >= MEMBER_ASSET_LIMITS.activeUploads) return fail('asset-unavailable');
    this.openingUploads++;
    let access: Access | undefined;
    let opening = true;
    let claimed = false;
    let retained = false;
    try {
      access = await this.access(request, input.spaceId, caller);
      const active = access;
      const current = this.find(this.records(), input.spaceId, input.assetId);
      this.maintain(active, current);
      if (current.kind !== 'file') return fail('asset-invalid');
      if (this.fileSlots.has(slot)) return fail('asset-upload-pending');
      if (this.fileSlots.size >= MEMBER_ASSET_LIMITS.activeUploads) return fail('asset-quota');
      this.fileSlots.add(slot);
      claimed = true;
      this.openingUploads--;
      opening = false;
      const fingerprint = hash({ actorId: active.actorId, operation: 'upload-file', input });
      const reserved = await this.workbench.memberAssetCommand<FileReservation>(
        active.signal,
        active.assertCurrent,
        async (records) => {
          const record = this.find(records, input.spaceId, input.assetId);
          this.maintain(active, record);
          if (record.kind !== 'file') return fail('asset-invalid');
          const old = record.uploads.find((item) => item.idempotencyKey === input.idempotencyKey);
          if (old) {
            if (old.fingerprint !== fingerprint) return fail('asset-request-reused');
            if (old.state === 'cancelled') return fail('asset-cancelled');
            if (old.state === 'committed')
              return {
                value: {
                  mode: 'committed',
                  stamp: record.version,
                  receipt: this.uploadReceipt(record, old),
                },
              };
            if (!record.draft || record.version !== old.reservedVersion)
              return fail('asset-conflict');
            return { value: { mode: 'pending', stamp: record.version } };
          }
          if (record.receipts.some((item) => item.idempotencyKey === input.idempotencyKey))
            return fail('asset-request-reused');
          if (!record.draft || record.version !== input.expectedVersion)
            return fail('asset-conflict');
          if (record.uploads.length >= MEMBER_ASSET_LIMITS.receipts) return fail('asset-quota');
          const next = structuredClone(record);
          next.version++;
          next.uploads.push({
            idempotencyKey: input.idempotencyKey,
            fingerprint,
            expectedVersion: input.expectedVersion,
            reservedVersion: next.version,
            declare: input.declare,
            state: 'pending',
          });
          return {
            records: records.map((item) => (item === record ? next : item)),
            value: { mode: 'pending', stamp: next.version },
          };
        },
      );
      active.assertCurrent();
      if (
        this.closed ||
        this.workbench.memberAssetVersion(input.spaceId, input.assetId) !== reserved.stamp
      )
        return fail('asset-conflict');
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const ticket: MemberAssetFileTicket = Object.freeze({ kind: 'member-asset-file-ticket' });
      const state: FileTicketState = {
        ticket,
        access: active,
        controller,
        input,
        fingerprint,
        done,
        finish,
        stamp: reserved.stamp,
        mode: reserved.mode,
        released: false,
      };
      this.tickets.set(ticket, state);
      this.files.add(state);
      retained = true;
      const grant = {
        signal: AbortSignal.any([active.signal, controller.signal]),
        assertCurrent: () => this.assertFileTicket(state),
      };
      try {
        grant.assertCurrent();
      } catch (error) {
        await this.abortFile(ticket);
        throw error;
      }
      return reserved.mode === 'committed'
        ? { kind: 'replayed' as const, receipt: reserved.receipt, ticket, grant }
        : { kind: 'reserved' as const, ticket, grant };
    } finally {
      if (opening) this.openingUploads--;
      if (!retained) {
        try {
          access?.release();
        } finally {
          if (claimed) this.fileSlots.delete(slot);
        }
      }
    }
  }

  private assertFileTicket(state: FileTicketState): void {
    state.access.assertCurrent();
    if (this.closed || state.released || state.controller.signal.aborted || !this.files.has(state))
      return fail('asset-cancelled');
    if (this.workbench.memberAssetVersion(state.input.spaceId, state.input.assetId) !== state.stamp)
      return fail('asset-conflict');
  }

  commitFile(
    ticket: MemberAssetFileTicket,
    raw: MemberAssetFileBlob,
  ): Promise<MemberAssetFileReceipt> {
    return this.ownOpening(this.commitFileInner(ticket, raw));
  }

  private async commitFileInner(
    ticket: MemberAssetFileTicket,
    raw: MemberAssetFileBlob,
  ): Promise<MemberAssetFileReceipt> {
    const state = this.tickets.get(ticket);
    if (!state) return fail('asset-forbidden');
    this.assertFileTicket(state);
    const parsed = MemberAssetFileBlobSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.attachmentId !== `sha256:${parsed.data.sha256}` ||
      canonicalPayload(this.fileDeclaration(parsed.data)) !== canonicalPayload(state.input.declare)
    )
      return fail('asset-file-invalid');
    const blob = parsed.data;
    const result = await this.workbench.memberAssetCommand(
      state.access.signal,
      () => this.assertFileTicket(state),
      async (records) => {
        const record = this.find(records, state.input.spaceId, state.input.assetId);
        this.maintain(state.access, record);
        const old = record.uploads.find(
          (item) => item.idempotencyKey === state.input.idempotencyKey,
        );
        if (!old || old.fingerprint !== state.fingerprint) return fail('asset-request-reused');
        if (old.state === 'committed') {
          if (canonicalPayload(old.blob) !== canonicalPayload(blob))
            return fail('asset-request-reused');
          return { value: this.uploadReceipt(record, old) };
        }
        if (
          !record.draft ||
          record.version !== state.stamp ||
          old.state !== 'pending' ||
          old.reservedVersion !== state.stamp
        )
          return fail('asset-conflict');
        const next = structuredClone(record);
        next.version++;
        const draft = next.draft;
        const upload = next.uploads.find((item) => item.idempotencyKey === old.idempotencyKey);
        if (!draft || !upload) return fail('asset-unavailable');
        draft.blob = blob;
        upload.state = 'committed';
        upload.resultVersion = next.version;
        upload.blob = blob;
        return {
          records: records.map((item) => (item === record ? next : item)),
          value: this.uploadReceipt(next, upload),
        };
      },
    );
    if (state.mode === 'pending') state.stamp = result.assetVersion;
    state.mode = 'committed';
    this.assertFileTicket(state);
    return result;
  }

  async abortFile(ticket: MemberAssetFileTicket): Promise<void> {
    const state = this.tickets.get(ticket);
    if (!state) return fail('asset-forbidden');
    if (state.released) return;
    // E calls only after the actual per-stream drain. Fencing never frees it.
    try {
      state.access.release();
      state.released = true;
      this.files.delete(state);
      this.fileSlots.delete(
        canonicalPayload({ spaceId: state.input.spaceId, assetId: state.input.assetId }),
      );
      state.finish();
    } catch {
      this.cleanupFailed = true;
      state.finish();
      return fail('asset-unavailable');
    }
  }

  readFile(request: MemberRequest, input: MemberAssetFileRead, signal: AbortSignal) {
    return this.ownOpening(this.readFileInner(request, input, signal));
  }

  private async readFileInner(
    request: MemberRequest,
    raw: MemberAssetFileRead,
    caller: AbortSignal,
  ) {
    const query = MemberAssetFileReadSchema.safeParse(raw);
    if (!query.success) return fail('asset-invalid');
    if (this.reads.size + this.openingReads >= MEMBER_ASSET_LIMITS.activeUploads)
      return fail('asset-quota');
    this.openingReads++;
    let access: Access | undefined;
    let retained = false;
    try {
      access = await this.access(request, query.data.spaceId, caller);
      const active = access;
      const record = this.find(this.records(), active.spaceId, query.data.assetId);
      const version = this.fixed(record, query.data.versionId);
      if (record.kind !== 'file' || !version.blob) return fail('asset-file-invalid');
      active.assertCurrent();
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let released = false;
      const state: FileReadState = {
        access: active,
        controller,
        done,
        release: () => {
          if (released) return;
          try {
            active.release();
            released = true;
            this.reads.delete(state);
            finish();
          } catch {
            this.cleanupFailed = true;
            finish();
            fail('asset-unavailable');
          }
        },
      };
      this.reads.add(state);
      retained = true;
      const grant = {
        signal: AbortSignal.any([active.signal, controller.signal]),
        assertCurrent: () => {
          active.assertCurrent();
          if (this.closed || released || controller.signal.aborted) return fail('asset-cancelled');
          if (this.workbench.memberAssetVersion(active.spaceId, record.assetId) !== record.version)
            return fail('asset-conflict');
        },
      };
      try {
        grant.assertCurrent();
      } catch (error) {
        state.release();
        throw error;
      }
      return { blob: structuredClone(version.blob), grant, release: state.release };
    } finally {
      this.openingReads--;
      if (!retained) access?.release();
    }
  }

  private dependencies(
    access: Access,
    records: readonly MemberAssetRecord[],
    values: MemberAssetPublishedVersion['dependencies'],
  ): void {
    for (const item of values) {
      if (item.reference.spaceId !== access.spaceId) return fail('asset-dependency-required');
      const source = this.find(records, access.spaceId, item.reference.assetId);
      const version = this.fixed(source, item.reference.versionId);
      if (canonicalPayload(version.reference) !== canonicalPayload(item.reference))
        return fail('asset-reference-denied');
    }
    access.assertCurrent();
  }

  private validateDefinition(definition: MemberAssetDefinition): void {
    if (definition.kind === 'template') {
      try {
        parseWorkflowTemplate(definition.content);
      } catch {
        return fail('asset-invalid');
      }
    }
    if (
      (definition.kind === 'skill' && !definition.content.trim()) ||
      (definition.kind === 'expert' && !definition.instructions.trim())
    )
      return fail('asset-invalid');
  }

  private async publishedDefinition(
    definition: MemberAssetDefinition,
    assetId: string,
    versionId: string,
    number: number,
  ): Promise<MemberAssetDefinition> {
    this.validateDefinition(definition);
    if (definition.kind === 'file') return structuredClone(definition);
    const oldOrigin = definition.origin;
    const original = oldOrigin ? this.workbench.memberAssetPackage(oldOrigin.versionId) : undefined;
    if (oldOrigin && !original) return fail('asset-unavailable');
    const preserved: PackageFile[] = [];
    for (const path of oldOrigin?.filePaths ?? []) {
      const file = original?.files.find((item) => item.path === path);
      if (!file) return fail('asset-unavailable');
      preserved.push(file);
    }
    const entryPath =
      definition.kind === 'skill'
        ? (oldOrigin?.entryPath ?? 'SKILL.md')
        : definition.kind === 'template'
          ? (oldOrigin?.entryPath ?? 'workflow.json')
          : oldOrigin?.format === 'zhuma-expert'
            ? oldOrigin.entryPath
            : `expert-${versionId}.json`;
    let text: string;
    if (definition.kind === 'skill') {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(assetId) || definition.description.length > 1024)
        return fail('asset-invalid');
      const previousEntry = original?.files.find((file) => file.path === entryPath);
      if (previousEntry) {
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
          packageFileText(previousEntry).replace(/^\uFEFF/u, ''),
        );
        if (!match) return fail('asset-invalid');
        // Preserve the original directory-matched Skill name, invocation policy,
        // license and metadata. Editing a copied body must not reset those fields.
        const metadata = parseDocument(match[1]!, {
          schema: 'core',
          strict: true,
          uniqueKeys: true,
        });
        if (metadata.errors.length || metadata.warnings.length) return fail('asset-invalid');
        metadata.set('description', definition.description || definition.name);
        text = `---\n${metadata.toString()}---\n${definition.content}`;
      } else
        text = `---\nname: ${JSON.stringify(assetId)}\ndescription: ${JSON.stringify(definition.description || definition.name)}\n---\n${definition.content}`;
    } else if (definition.kind === 'template') text = definition.content;
    else
      text = JSON.stringify({
        format: 'zhuma-expert',
        schemaVersion: 1,
        id: assetId,
        version: String(number),
        name: definition.name,
        role: definition.role,
        capabilities: definition.capabilities,
        instructions: definition.instructions,
      });
    const files = [
      ...preserved.filter((item) => item.path !== entryPath),
      { path: entryPath, data: Buffer.from(text).toString('base64') },
    ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
    let preview;
    try {
      preview = previewResourcePackage(files, parseWorkflowTemplate);
    } catch {
      return fail('asset-invalid');
    }
    const item = preview.items.find(
      (candidate) => candidate.key === entryPath && candidate.kind === definition.kind,
    );
    if (!item || item.missing.length) return fail('asset-invalid');
    const legal = preserved
      .filter((file) =>
        /^(?:LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT|AUTHORS|README)(?:\.|$)/iu.test(
          file.path.split('/').at(-1) ?? '',
        ),
      )
      .map((file) => file.path);
    const filePaths = [...new Set([...item.filePaths, ...legal])];
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    await this.workbench.putMemberAssetPackage({ versionId, files, digest });
    return {
      ...definition,
      origin: {
        versionId,
        format: item.format,
        entryPath,
        filePaths,
        totalBytes: files
          .filter((file) => filePaths.includes(file.path))
          .reduce((bytes, file) => bytes + packageFileBytes(file), 0),
        missing: [],
        sourceId: assetId,
        sourceVersion: String(number),
      },
    };
  }

  async command(
    request: MemberRequest,
    raw: MemberAssetCommand,
    signal: AbortSignal,
  ): Promise<MemberAssetCommandValue> {
    const parsed = MemberAssetCommandSchema.safeParse(raw);
    if (!parsed.success) return fail('asset-invalid');
    const input = parsed.data;
    return this.scoped(request, input.spaceId, signal, async (access) => {
      const fingerprint = hash({ actorId: access.actorId, command: input });
      let sourceAccess: Access | undefined;
      let sourceCheck: (() => Promise<void>) | undefined;
      let publicationCheck: (() => Promise<void>) | undefined;
      const authorize = async () => {
        access.assertCurrent();
        sourceAccess?.assertCurrent();
        await sourceCheck?.();
        await publicationCheck?.();
        access.assertCurrent();
        sourceAccess?.assertCurrent();
      };
      try {
        const result = await this.workbench.memberAssetCommand(
          access.signal,
          authorize,
          async (records) => {
            const previous = records.find(
              (item) => item.spaceId === input.spaceId && item.assetId === input.assetId,
            );
            if (previous) {
              if (input.operation === 'set-maintainers') {
                if (
                  access.actorId !== previous.ownerId &&
                  access.directory.administratorForSpace?.(access.spaceId) !== access.actorId
                )
                  return fail('asset-forbidden');
              } else this.maintain(access, previous);
              const receipt = previous.receipts.find(
                (item) => item.idempotencyKey === input.idempotencyKey,
              );
              if (receipt) {
                if (receipt.fingerprint !== fingerprint) return fail('asset-request-reused');
                return {
                  value: MemberAssetCommandValueSchema.parse({
                    disposition: 'replayed',
                    actorId: access.actorId,
                    resultVersion: receipt.resultVersion,
                    asset: this.summary(access, previous, true),
                    ...(receipt.versionId
                      ? { reference: this.fixed(previous, receipt.versionId).reference }
                      : {}),
                  }),
                };
              }
            }
            if (input.operation === 'create-draft' || input.operation === 'copy') {
              if (previous || records.some((item) => item.assetId === input.assetId))
                return fail('asset-conflict');
              if (records.length >= MEMBER_ASSET_LIMITS.assets) return fail('asset-quota');
              let draft: NonNullable<MemberAssetRecord['draft']>;
              if (input.operation === 'create-draft') {
                if ('origin' in input.definition && input.definition.origin)
                  return fail('asset-invalid');
                draft = { definition: input.definition, dependencies: input.dependencies };
              } else {
                sourceAccess = await this.access(request, input.source.spaceId, signal);
                if ('assetKind' in input.source) {
                  const found = await this.sourceFacts(request, sourceAccess);
                  const source = found.items.find(
                    (item) =>
                      canonicalPayload(item.summary.source) === canonicalPayload(input.source),
                  );
                  if (
                    !source ||
                    !source.summary.canCopy ||
                    source.summary.source.kind === 'unknown'
                  )
                    return fail('asset-reference-denied');
                  if (
                    source.requirements.length !== input.dependencies.length ||
                    source.requirements.some(
                      (item) =>
                        !input.dependencies.some(
                          (mapped) =>
                            mapped.slotId === item.slotId && mapped.reference.kind === item.kind,
                        ),
                    )
                  )
                    return fail('asset-dependency-required');
                  const selectedSource = source.summary.source;
                  const retainedAccess = sourceAccess;
                  sourceCheck = async () => {
                    const current = await this.sourceFacts(request, retainedAccess);
                    if (
                      !current.items.some(
                        (item) =>
                          item.summary.canCopy &&
                          canonicalPayload(item.summary.source) ===
                            canonicalPayload(selectedSource),
                      )
                    )
                      return fail('asset-reference-denied');
                  };
                  draft = {
                    definition: { ...source.definition, name: input.name },
                    dependencies: input.dependencies,
                    source: selectedSource,
                  };
                } else {
                  const source = this.find(records, input.source.spaceId, input.source.assetId);
                  const version = this.fixed(source, input.source.versionId);
                  if (canonicalPayload(version.reference) !== canonicalPayload(input.source))
                    return fail('asset-reference-denied');
                  if (
                    version.dependencies.length !== input.dependencies.length ||
                    version.dependencies.some(
                      (item) =>
                        !input.dependencies.some(
                          (mapped) =>
                            mapped.slotId === item.slotId &&
                            mapped.reference.kind === item.reference.kind,
                        ),
                    )
                  )
                    return fail('asset-dependency-required');
                  draft = {
                    definition: { ...structuredClone(version.definition), name: input.name },
                    dependencies: input.dependencies,
                    source: { kind: 'asset', reference: version.reference },
                    ...(version.blob ? { blob: version.blob } : {}),
                  };
                }
              }
              this.dependencies(access, records, input.dependencies);
              const next = MemberAssetRecordSchema.parse({
                schemaVersion: 1,
                spaceId: input.spaceId,
                assetId: input.assetId,
                kind: draft.definition.kind,
                ownerId: access.actorId,
                maintainerIds: [access.actorId],
                version: 1,
                draft,
                published: [],
                uploads: [],
                receipts: [
                  {
                    idempotencyKey: input.idempotencyKey,
                    fingerprint,
                    operation: input.operation,
                    resultVersion: 1,
                  },
                ],
              });
              return {
                records: [...records, next],
                value: MemberAssetCommandValueSchema.parse({
                  disposition: 'applied',
                  actorId: access.actorId,
                  resultVersion: 1,
                  asset: this.summary(access, next, true),
                }),
              };
            }
            if (!previous) return fail('asset-not-found');
            if (previous.version !== input.expectedVersion) return fail('asset-conflict');
            if (previous.receipts.length >= MEMBER_ASSET_LIMITS.receipts)
              return fail('asset-quota');
            const next = structuredClone(previous);
            next.version++;
            let published: MemberAssetPublishedVersion | undefined;
            if (input.operation === 'update-draft') {
              if (input.definition.kind !== previous.kind) return fail('asset-invalid');
              this.dependencies(access, records, input.dependencies);
              const old = previous.draft ?? previous.published.at(-1);
              let definition = structuredClone(input.definition);
              if (
                definition.kind !== 'file' &&
                definition.origin &&
                canonicalPayload(definition.origin) !==
                  canonicalPayload(
                    old && 'origin' in old.definition ? (old.definition.origin ?? null) : null,
                  )
              )
                return fail('asset-invalid');
              if (
                definition.kind !== 'file' &&
                old &&
                'origin' in old.definition &&
                old.definition.origin
              )
                definition = { ...definition, origin: old.definition.origin };
              next.draft = {
                definition,
                dependencies: input.dependencies,
                ...(old?.source ? { source: old.source } : {}),
                ...(old?.blob ? { blob: old.blob } : {}),
              };
            } else if (input.operation === 'publish') {
              if (!previous.draft) return fail('asset-invalid');
              if (previous.published.length >= MEMBER_ASSET_LIMITS.versions)
                return fail('asset-quota');
              if (previous.kind === 'file' && !previous.draft.blob)
                return fail('asset-file-invalid');
              this.dependencies(access, records, previous.draft.dependencies);
              const required = this.importRequirements(access, records, previous.draft);
              if (
                required.some(
                  (item) =>
                    !previous.draft!.dependencies.some(
                      (dependency) =>
                        dependency.slotId === item.slotId &&
                        dependency.reference.kind === item.kind,
                    ),
                )
              )
                return fail('asset-dependency-required');
              if (previous.kind !== 'file') {
                const fingerprint = await this.publicationCatalog(access, records, previous.kind);
                publicationCheck = async () => {
                  if (
                    (await this.publicationCatalog(access, records, previous.kind)) !== fingerprint
                  )
                    return fail('asset-conflict');
                };
              }
              const versionId = randomUUID();
              const number = previous.published.length + 1;
              const definition = await this.publishedDefinition(
                previous.draft.definition,
                previous.assetId,
                versionId,
                number,
              );
              published = {
                ...previous.draft,
                definition,
                reference: {
                  spaceId: access.spaceId,
                  assetId: previous.assetId,
                  kind: previous.kind,
                  versionId,
                  sha256: '0'.repeat(64),
                },
                number,
                publishedBy: access.actorId,
                publishedAt: this.options.now?.() ?? new Date().toISOString(),
              };
              published.reference.sha256 = hash(memberAssetVersionDigestInput(published));
              next.published.push(published);
              next.draft = { ...previous.draft, definition };
            } else if (input.operation === 'set-maintainers') {
              if (
                !input.maintainerIds.includes(previous.ownerId) ||
                new Set(input.maintainerIds).size !== input.maintainerIds.length ||
                input.maintainerIds.some(
                  (id) => id !== previous.ownerId && !access.directory.isMember(access.spaceId, id),
                )
              )
                return fail('asset-invalid');
              next.maintainerIds = [...input.maintainerIds];
            } else if (input.operation === 'remove-draft') next.draft = null;
            else if (input.operation === 'cancel-upload') {
              const upload = next.uploads.find((item) => item.idempotencyKey === input.uploadKey);
              if (!upload) return fail('asset-not-found');
              if (upload.state === 'pending') upload.state = 'cancelled';
            }
            // Any row change invalidates the old physical upload stamp. Pending
            // declarations remain explicit cancelled facts, never optimistic drain.
            for (const upload of next.uploads)
              if (upload.state === 'pending') upload.state = 'cancelled';
            next.receipts.push({
              idempotencyKey: input.idempotencyKey,
              fingerprint,
              operation: input.operation,
              resultVersion: next.version,
              ...(published ? { versionId: published.reference.versionId } : {}),
            });
            const changed = records.map((item) => (item === previous ? next : item));
            if (!MemberAssetRegistrySchema.safeParse(changed).success) return fail('asset-quota');
            return {
              records: changed,
              value: MemberAssetCommandValueSchema.parse({
                disposition: 'applied',
                actorId: access.actorId,
                resultVersion: next.version,
                asset: this.summary(access, next, true),
                ...(published ? { reference: published.reference } : {}),
              }),
            };
          },
        );
        if (result.disposition === 'applied') this.fenceFiles(input.spaceId, input.assetId);
        return result;
      } finally {
        sourceAccess?.release();
      }
    });
  }
}
