import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import {
  canonicalPayload,
  KNOWLEDGE_LIMITS,
  KnowledgeLibrariesRequestSchema,
  KnowledgeListRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeReadRequestSchema,
  KnowledgeDraftRequestSchema,
  KnowledgeDraftsRequestSchema,
  KnowledgeSaveDraftRequestSchema,
  KnowledgePublishRequestSchema,
  KnowledgeProjectLinksRequestSchema,
  KnowledgeSaveProjectLinksRequestSchema,
  KnowledgeProjectSnapshotSchema,
  KnowledgeProjectLinksValueSchema,
  type KnowledgeProjectLinksValue,
  type KnowledgeProjectLinksWriteValue,
  type KnowledgeProjectSnapshot,
  type Workbench,
  type KnowledgeErrorCode,
  type KnowledgeResult,
  type KnowledgeLibrary,
  type KnowledgeLibrariesValue,
  type KnowledgeListValue,
  type KnowledgeSearchValue,
  type KnowledgeReadValue,
  type KnowledgePageSummary,
  type KnowledgeVersionRef,
  type KnowledgeDraftValue,
  type KnowledgeWriteValue,
  type KnowledgeDraftsValue,
} from '@zhuma/agent-core';
import { openExecutionMemberLease, type MemberRequest } from './member-session.js';
import { scanActorField } from './execution-identity.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import { spaceDirectoryFor, type OpenedSpaceDirectoryHandle } from './space-directory.js';
import {
  openKnowledgeStorage,
  KnowledgeBytes,
  type KnowledgeStorage,
  type KnowledgePageRecord,
  type KnowledgePublished,
  type KnowledgeWriteReceipt,
  type KnowledgeProjectLinksRecord,
} from './knowledge-storage.js';

export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(code);
  }
}
export interface KnowledgeServiceOptions {
  /** SAME original opened Workbench; absent/closed is unavailable, never a legacy fallback. */
  readonly readWorkbench?: () => Workbench;
  /** Host-only synchronous assertion over the SAME current trusted directory.
   * No browser field, space-name convention or first page author is an owner grant.
   * Unknown old personal spaces must throw KnowledgeError('unavailable'). */
  readonly assertPersonalOwner?: (spaceId: string, actorId: string) => void;
}
const unavailable = () => {
  throw new KnowledgeError('unavailable');
};
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalPayload(value)).digest('hex');
const decode = (value: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
interface Access {
  readonly actorId: string;
  readonly spaceId: string;
  readonly directory: OpenedSpaceDirectoryHandle;
  readonly lease: ExecutionMemberLease;
  readonly signal: AbortSignal;
  check(): void;
}
function reference(page: KnowledgePageRecord, version: KnowledgePublished): KnowledgeVersionRef {
  return {
    spaceId: page.spaceId,
    libraryId: page.libraryId,
    pageId: page.pageId,
    version: version.version,
    checksum: version.body.checksum,
  };
}
function summary(page: KnowledgePageRecord, version: KnowledgePublished): KnowledgePageSummary {
  return {
    reference: reference(page, version),
    title: version.title,
    format: version.format,
    ownerActorId: page.ownerActorId,
    pageRevision: page.version,
    bytes: version.body.bytes,
    publishedAt: version.publishedAt,
  };
}
function snippet(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Array.from(text.slice(0, Math.max(0, at))).length - 50);
  const chars = Array.from(text),
    end = Math.min(chars.length, start + 238);
  return `${start ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

/** Original trusted member leases and directory; no caller permission flag is
 * accepted. A mounts this once and owns shutdown before the DSH providers. */
export class KnowledgeService {
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly cursorKey = randomBytes(32);
  private closing?: Promise<void>;
  constructor(
    private readonly ctx: Context,
    private readonly store: KnowledgeStorage,
    private readonly bytes: KnowledgeBytes,
    private readonly options: KnowledgeServiceOptions = {},
  ) {}

  private run<T>(
    request: MemberRequest,
    raw: unknown,
    signal: AbortSignal | undefined,
    work: (access: Access) => Promise<T> | T,
  ): Promise<KnowledgeResult<T>> {
    if (this.lifetime.signal.aborted)
      return Promise.resolve({
        ok: false,
        error: { code: 'unavailable', message: '知识服务暂不可用。' },
      });
    if (this.operations.size >= 32)
      return Promise.resolve({
        ok: false,
        error: { code: 'limit', message: '知识请求超过当前限制。' },
      });
    const job = Promise.resolve().then(async (): Promise<KnowledgeResult<T>> => {
      let lease: ExecutionMemberLease | undefined;
      const bounded = AbortSignal.any([
        this.lifetime.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30_000),
      ]);
      try {
        bounded.throwIfAborted();
        try {
          lease = await openExecutionMemberLease(this.ctx, request);
        } catch {
          throw new KnowledgeError('unauthenticated');
        }
        if (scanActorField(raw) !== 'clean') throw new KnowledgeError('invalid');
        const shape = z.object({ spaceId: z.string().min(1).max(100) }).parse(raw);
        const directory = spaceDirectoryFor(this.ctx);
        if (!directory) return unavailable();
        const current = lease;
        const joined = AbortSignal.any([bounded, current.signal, directory.signal]);
        const access: Access = {
          actorId: current.memberId,
          spaceId: shape.spaceId,
          directory,
          lease: current,
          signal: joined,
          check: () => {
            joined.throwIfAborted();
            if (spaceDirectoryFor(this.ctx) !== directory || directory.signal.aborted)
              return unavailable();
            try {
              current.assertCurrent(shape.spaceId);
            } catch {
              throw new KnowledgeError('forbidden');
            }
            const space = directory.space(shape.spaceId);
            if (!space || !directory.isMember(shape.spaceId, current.memberId))
              throw new KnowledgeError('not-found');
            if (space.kind === 'personal') {
              const assert = this.options.assertPersonalOwner;
              if (!assert) return unavailable();
              try {
                assert(space.id, current.memberId);
              } catch (error) {
                if (error instanceof KnowledgeError) throw error;
                return unavailable();
              }
            }
          },
        };
        access.check();
        const value = await work(access);
        access.check();
        return { ok: true, value: structuredClone(value) };
      } catch (error) {
        const code: KnowledgeErrorCode = bounded.aborted
          ? 'cancelled'
          : error instanceof KnowledgeError
            ? error.code
            : error instanceof z.ZodError
              ? 'invalid'
              : 'unavailable';
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'invalid'
                ? '知识请求格式无效。'
                : code === 'not-found'
                  ? '知识条目不存在或无权读取。'
                  : code === 'conflict'
                    ? '知识已变化，请刷新后重试。'
                    : code === 'limit'
                      ? '知识请求超过当前限制，请缩小范围。'
                      : code === 'cancelled'
                        ? '知识操作已取消。'
                        : code === 'unauthenticated'
                          ? '请先登录成员账号。'
                          : code === 'forbidden'
                            ? '当前账号无权执行此操作。'
                            : '知识服务暂不可用。',
          },
        };
      } finally {
        lease?.release();
      }
    });
    this.operations.add(job);
    void job.then(
      () => this.operations.delete(job),
      () => this.operations.delete(job),
    );
    return job;
  }

  private library(access: Access, libraryId: string): KnowledgeLibrary {
    access.check();
    const space = access.directory.space(access.spaceId);
    if (!space || libraryId !== space.id) throw new KnowledgeError('not-found');
    return { id: space.id, spaceId: space.id, kind: space.kind, name: space.name, canCreate: true };
  }
  private async project(access: Access, projectId: string): Promise<void> {
    access.check();
    const read = this.options.readWorkbench;
    if (typeof read !== 'function') return unavailable();
    const exists = () => {
      access.check();
      if (this.options.readWorkbench !== read) return unavailable();
      const projects = read().projects.filter((project) => project.id === projectId);
      if (projects.length !== 1) throw new KnowledgeError('not-found');
    };
    exists();
    const lookup = await access.directory.spaceForProject(projectId);
    exists();
    if (!lookup.ok && lookup.reason === 'unavailable') return unavailable();
    if (!lookup.ok || lookup.spaceId !== access.spaceId) throw new KnowledgeError('not-found');
  }
  private projectSnapshotValue(
    access: Access,
    projectId: string,
    row: KnowledgeProjectLinksRecord | undefined,
  ): KnowledgeProjectSnapshot {
    const value = {
      sourceVersion: 'zhuma-project-knowledge@1' as const,
      spaceId: access.spaceId,
      projectId,
      relationshipVersion: row?.version ?? 0,
      links: row?.links ?? [],
    };
    return KnowledgeProjectSnapshotSchema.parse({ ...value, checksum: digest(value) });
  }
  projectLinks(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeProjectLinksValue>> {
    return this.run(request, raw, signal, async (access) => {
      const input = KnowledgeProjectLinksRequestSchema.parse(raw);
      await this.project(access, input.projectId);
      const row = this.store.projectLinks(access.spaceId, input.projectId);
      const links = (row?.links ?? []).map((link) => {
        const { page, version } = this.fixed(access, link.reference);
        return {
          ...link,
          title: version.title,
          format: version.format,
          bytes: version.body.bytes,
          hasUpdate: page.versions.at(-1)!.version > version.version,
        };
      });
      await this.project(access, input.projectId);
      if (
        digest(this.store.projectLinks(access.spaceId, input.projectId) ?? null) !==
        digest(row ?? null)
      )
        throw new KnowledgeError('conflict');
      // Sources can be removed or withdrawn while project-space lookup yields.
      for (const link of row?.links ?? []) this.fixed(access, link.reference);
      return KnowledgeProjectLinksValueSchema.parse({
        actorId: access.actorId,
        spaceId: access.spaceId,
        projectId: input.projectId,
        relationshipVersion: row?.version ?? 0,
        links,
        snapshot: this.projectSnapshotValue(access, input.projectId, row),
      });
    });
  }
  /** Original member/project-authorized fixed refs only. No Node/Run grant,
   * callback into the execution queue, content read, latest substitution or write. */
  async projectSnapshot(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeProjectSnapshot>> {
    const result = await this.projectLinks(request, raw, signal);
    return result.ok ? { ok: true, value: structuredClone(result.value.snapshot) } : result;
  }
  saveProjectLinks(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeProjectLinksWriteValue>> {
    return this.run(request, raw, signal, (access) =>
      this.store.exclusive(async () => {
        const input = KnowledgeSaveProjectLinksRequestSchema.parse(raw);
        await this.project(access, input.projectId);
        const previous = this.store.projectLinks(access.spaceId, input.projectId);
        for (const link of input.links) this.fixed(access, link.reference);
        const fingerprint = digest({
          operation: 'save-project-links',
          actorId: access.actorId,
          input,
        });
        const receipt = previous?.receipts.find((item) => item.key === input.idempotencyKey);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new KnowledgeError('conflict');
          await this.project(access, input.projectId);
          for (const link of input.links) this.fixed(access, link.reference);
          return {
            actorId: access.actorId,
            spaceId: access.spaceId,
            projectId: input.projectId,
            relationshipVersion: receipt.version,
            disposition: 'replayed' as const,
          };
        }
        if ((previous?.version ?? 0) !== input.expectedVersion)
          throw new KnowledgeError('conflict');
        if (
          (previous?.receipts.length ?? 0) >= KNOWLEDGE_LIMITS.receiptsPerProject ||
          !Number.isSafeInteger(input.expectedVersion + 1)
        )
          throw new KnowledgeError('limit');
        await this.store.protectProjectLinks();
        // The durable format marker is a yielding boundary of its own. A failed
        // or revoked request may retain marker 2, but cannot write an unauthorized relation.
        await this.project(access, input.projectId);
        for (const link of input.links) this.fixed(access, link.reference);
        const version = input.expectedVersion + 1;
        access.check();
        await this.store.putProjectLinks({
          schemaVersion: 1,
          spaceId: access.spaceId,
          projectId: input.projectId,
          version,
          links: input.links,
          receipts: [
            ...(previous?.receipts ?? []),
            { key: input.idempotencyKey, fingerprint, version },
          ],
        });
        await this.project(access, input.projectId);
        return {
          actorId: access.actorId,
          spaceId: access.spaceId,
          projectId: input.projectId,
          relationshipVersion: version,
          disposition: 'saved' as const,
        };
      }),
    );
  }
  private page(access: Access, libraryId: string, pageId: string): KnowledgePageRecord {
    const library = this.library(access, libraryId),
      page = this.store.get(access.spaceId, pageId);
    if (
      !page ||
      page.spaceId !== access.spaceId ||
      page.libraryId !== library.id ||
      (library.kind === 'personal' && page.ownerActorId !== access.actorId)
    )
      throw new KnowledgeError('not-found');
    return page;
  }
  private fixed(
    access: Access,
    ref: KnowledgeVersionRef,
    visited = new Set<string>(),
    budget = { remaining: 64 },
  ): { page: KnowledgePageRecord; version: KnowledgePublished } {
    if (ref.spaceId !== access.spaceId) throw new KnowledgeError('not-found');
    const key = canonicalPayload(ref);
    if (visited.has(key) || budget.remaining-- <= 0) return unavailable();
    visited.add(key);
    const page = this.page(access, ref.libraryId, ref.pageId),
      version = page.versions.find((item) => item.version === ref.version);
    if (!version || version.body.checksum !== ref.checksum) throw new KnowledgeError('not-found');
    for (const source of version.sources) this.fixed(access, source, new Set(visited), budget);
    return { page, version };
  }
  private published(
    access: Access,
    libraryId: string,
  ): { page: KnowledgePageRecord; version: KnowledgePublished }[] {
    const library = this.library(access, libraryId);
    return this.store
      .pages(access.spaceId)
      .filter(
        (page) =>
          page.libraryId === library.id &&
          (library.kind !== 'personal' || page.ownerActorId === access.actorId) &&
          page.versions.length > 0,
      )
      .map((page) => {
        const version = page.versions.at(-1)!;
        this.fixed(access, reference(page, version));
        return { page, version };
      });
  }
  private async body(
    access: Access,
    page: KnowledgePageRecord,
    version: KnowledgePublished,
    part: 'body' | 'original',
  ): Promise<Uint8Array> {
    const ref = reference(page, version),
      original = digest(version);
    const blob = part === 'body' ? version.body : version.original;
    if (!blob) throw new KnowledgeError('not-found');
    const check = () => {
      access.check();
      const current = this.fixed(access, ref);
      if (digest(current.version) !== original || current.page.ownerActorId !== page.ownerActorId)
        throw new KnowledgeError('conflict');
    };
    check();
    const result = await this.bytes.read(blob, access.signal, check);
    check();
    return result;
  }

  libraries(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeLibrariesValue>> {
    return this.run(request, raw, signal, (access) => {
      KnowledgeLibrariesRequestSchema.parse(raw);
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraries: [this.library(access, access.spaceId)],
      };
    });
  }
  list(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeListValue>> {
    return this.run(request, raw, signal, (access) => {
      const input = KnowledgeListRequestSchema.parse(raw);
      const pages = this.published(access, input.libraryId)
        .map(({ page, version }) => summary(page, version))
        .sort(
          (a, b) =>
            a.title.localeCompare(b.title) || a.reference.pageId.localeCompare(b.reference.pageId),
        );
      const binding = {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryId: input.libraryId,
        query: '',
        fingerprint: digest(pages),
      };
      const offset = input.cursor ? this.cursor(input.cursor, binding) : 0;
      const end = Math.min(offset + input.limit, pages.length);
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryId: input.libraryId,
        pages: pages.slice(offset, end),
        nextCursor: end < pages.length ? this.issueCursor(binding, end) : null,
      };
    });
  }
  search(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeSearchValue>> {
    return this.run(request, raw, signal, async (access) => {
      const input = KnowledgeSearchRequestSchema.parse(raw);
      const pages = input.libraryIds.flatMap((libraryId) => this.published(access, libraryId));
      if (
        pages.length > KNOWLEDGE_LIMITS.searchPages ||
        pages.reduce((n, { version }) => n + version.body.bytes, 0) > KNOWLEDGE_LIMITS.searchBytes
      )
        throw new KnowledgeError('limit');
      const terms = input.query.normalize('NFKC').toLowerCase().split(/\s+/u),
        hits: { value: KnowledgeSearchValue['hits'][number]; score: number }[] = [];
      for (const { page, version } of pages) {
        const text = decode(await this.body(access, page, version, 'body'));
        const title = version.title.normalize('NFKC').toLowerCase(),
          body = text.normalize('NFKC').toLowerCase();
        if (!terms.every((term) => title.includes(term) || body.includes(term))) continue;
        const score = terms.filter((term) => title.includes(term)).length;
        hits.push({
          score,
          value: {
            ...summary(page, version),
            snippet: snippet(text, terms.find((term) => body.includes(term)) ?? terms[0]!),
          },
        });
      }
      hits.sort(
        (a, b) =>
          b.score - a.score ||
          a.value.title.localeCompare(b.value.title) ||
          a.value.reference.pageId.localeCompare(b.value.reference.pageId),
      );
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryIds: input.libraryIds,
        query: input.query,
        hits: hits.slice(0, input.limit).map((hit) => hit.value),
        complete: true,
      };
    });
  }
  read(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeReadValue>> {
    return this.run(request, raw, signal, async (access) => {
      const input = KnowledgeReadRequestSchema.parse(raw),
        page = this.page(access, input.libraryId, input.pageId),
        version = page.versions.find((item) => item.version === input.version);
      if (!version || (input.checksum && input.checksum !== version.body.checksum))
        throw new KnowledgeError('not-found');
      const bytes = await this.body(access, page, version, input.part),
        start = input.offset;
      if (start > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80))
        throw new KnowledgeError('invalid');
      let end = Math.min(start + input.length, bytes.length);
      while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end === start && start < bytes.length) throw new KnowledgeError('invalid');
      const blob = input.part === 'body' ? version.body : version.original!;
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        reference: reference(page, version),
        part: input.part,
        title: version.title,
        format: version.format,
        text: decode(bytes.subarray(start, end)),
        offset: start,
        length: end - start,
        nextOffset: end,
        totalBytes: bytes.length,
        partChecksum: blob.checksum,
        sources: version.sources,
      };
    });
  }

  private owned(access: Access, libraryId: string, pageId: string): KnowledgePageRecord {
    const page = this.page(access, libraryId, pageId);
    if (page.ownerActorId !== access.actorId) throw new KnowledgeError('not-found');
    return page;
  }

  drafts(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeDraftsValue>> {
    return this.run(request, raw, signal, (access) => {
      const input = KnowledgeDraftsRequestSchema.parse(raw);
      this.library(access, input.libraryId);
      const pages: KnowledgeDraftsValue['pages'] = this.store
        .pages(access.spaceId)
        .filter(
          (page) =>
            page.libraryId === input.libraryId &&
            page.ownerActorId === access.actorId &&
            page.draft,
        )
        .map((page) => {
          this.owned(access, input.libraryId, page.pageId);
          const pending = page.draft!;
          return {
            spaceId: access.spaceId,
            libraryId: input.libraryId,
            pageId: page.pageId,
            ownerActorId: page.ownerActorId,
            title: pending.title,
            format: pending.format,
            pageRevision: page.version,
            bytes: pending.body.bytes,
            authorship: pending.authorship,
            ...(pending.savedAt ? { savedAt: pending.savedAt } : {}),
            hasPublished: page.versions.length > 0,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title) || a.pageId.localeCompare(b.pageId));
      const binding = {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryId: input.libraryId,
        query: 'drafts',
        fingerprint: digest(pages),
      };
      const offset = input.cursor ? this.cursor(input.cursor, binding) : 0;
      const end = Math.min(offset + input.limit, pages.length);
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryId: input.libraryId,
        pages: pages.slice(offset, end),
        nextCursor: end < pages.length ? this.issueCursor(binding, end) : null,
      };
    });
  }
  private checkSources(access: Access, sources: readonly KnowledgeVersionRef[]): void {
    const seen = new Set<string>();
    for (const source of sources) {
      const key = canonicalPayload(source);
      if (seen.has(key)) throw new KnowledgeError('invalid');
      seen.add(key);
      this.fixed(access, source);
    }
  }
  private writeValue(
    access: Access,
    page: KnowledgePageRecord,
    receipt: KnowledgeWriteReceipt,
    disposition: KnowledgeWriteValue['disposition'],
  ): KnowledgeWriteValue {
    return {
      actorId: access.actorId,
      spaceId: access.spaceId,
      libraryId: page.libraryId,
      pageId: page.pageId,
      pageRevision: receipt.pageRevision,
      operation: receipt.operation,
      disposition,
      ...(receipt.reference ? { reference: receipt.reference } : {}),
    };
  }
  private replay(
    access: Access,
    page: KnowledgePageRecord | undefined,
    key: string,
    operation: KnowledgeWriteReceipt['operation'],
    fingerprint: string,
  ): KnowledgeWriteValue | undefined {
    const receipt = page?.receipts.find((item) => item.key === key);
    if (!page || !receipt) return undefined;
    if (receipt.operation !== operation || receipt.fingerprint !== fingerprint)
      throw new KnowledgeError('conflict');
    return this.writeValue(access, page, receipt, 'replayed');
  }
  private writeBudget(page: KnowledgePageRecord | undefined, expectedVersion: number): void {
    if ((page?.version ?? 0) !== expectedVersion) throw new KnowledgeError('conflict');
    if (
      (page?.receipts.length ?? 0) >= KNOWLEDGE_LIMITS.receiptsPerPage ||
      !Number.isSafeInteger(expectedVersion + 1)
    )
      throw new KnowledgeError('limit');
  }

  draft(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeDraftValue>> {
    return this.run(request, raw, signal, async (access) => {
      const input = KnowledgeDraftRequestSchema.parse(raw),
        page = this.owned(access, input.libraryId, input.pageId),
        pending = page.draft,
        published = page.versions.at(-1);
      const check = () => {
        access.check();
        const current = this.owned(access, input.libraryId, input.pageId);
        if (
          current.version !== page.version ||
          digest(current.draft ?? null) !== digest(pending ?? null)
        )
          throw new KnowledgeError('conflict');
        if (pending) this.checkSources(access, pending.sources);
      };
      check();
      const body = pending && decode(await this.bytes.read(pending.body, access.signal, check));
      const original =
        pending?.original && decode(await this.bytes.read(pending.original, access.signal, check));
      check();
      return {
        actorId: access.actorId,
        spaceId: access.spaceId,
        libraryId: input.libraryId,
        pageId: input.pageId,
        ownerActorId: page.ownerActorId,
        pageRevision: page.version,
        draft: pending
          ? {
              title: pending.title,
              format: pending.format,
              text: body!,
              authorship: pending.authorship,
              ...(original === undefined ? {} : { originalText: original }),
              sources: pending.sources,
            }
          : null,
        published: published ? reference(page, published) : null,
        publishedHasOriginal: published?.original !== undefined,
      };
    });
  }

  saveDraft(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeWriteValue>> {
    return this.save(request, raw, 'member', signal);
  }
  /** Host-only Agent tool entry. It can propose an owned draft, never publish. */
  proposeDraft(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeWriteValue>> {
    return this.save(request, raw, 'agent', signal);
  }
  private save(
    request: MemberRequest,
    raw: unknown,
    authorship: 'member' | 'agent',
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeWriteValue>> {
    return this.run(request, raw, signal, (access) =>
      this.store.exclusive(async () => {
        const input = KnowledgeSaveDraftRequestSchema.parse(raw);
        this.library(access, input.libraryId);
        const previous = this.store.get(access.spaceId, input.pageId);
        if (previous) this.owned(access, input.libraryId, input.pageId);
        const fingerprint = digest({
          operation: 'save-draft',
          actorId: access.actorId,
          authorship,
          input,
        });
        const replayed = this.replay(
          access,
          previous,
          input.idempotencyKey,
          'save-draft',
          fingerprint,
        );
        if (replayed) return replayed;
        this.writeBudget(previous, input.expectedVersion);
        if (
          !previous &&
          this.store.pages(access.spaceId).length >= KNOWLEDGE_LIMITS.pagesPerLibrary
        )
          throw new KnowledgeError('limit');
        this.checkSources(access, input.content.sources);
        const body = await this.bytes.save(
          input.content.text,
          input.content.format,
          false,
          access.signal,
          () => access.check(),
        );
        const original =
          input.content.originalText === undefined
            ? undefined
            : await this.bytes.save(
                input.content.originalText,
                input.content.format,
                true,
                access.signal,
                () => access.check(),
              );
        this.checkSources(access, input.content.sources);
        const revision = input.expectedVersion + 1;
        const receipt: KnowledgeWriteReceipt = {
          key: input.idempotencyKey,
          operation: 'save-draft',
          fingerprint,
          pageRevision: revision,
        };
        const page: KnowledgePageRecord = {
          schemaVersion: 1,
          spaceId: access.spaceId,
          libraryId: input.libraryId,
          pageId: input.pageId,
          ownerActorId: access.actorId,
          version: revision,
          versions: previous?.versions ?? [],
          draft: {
            title: input.content.title,
            format: input.content.format,
            body,
            ...(original ? { original } : {}),
            sources: input.content.sources,
            authorship,
            savedAt: new Date().toISOString(),
          },
          receipts: [...(previous?.receipts ?? []), receipt],
        };
        access.check();
        await this.store.put(page);
        access.check();
        return this.writeValue(access, page, receipt, 'saved');
      }),
    );
  }

  publish(
    request: MemberRequest,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<KnowledgeWriteValue>> {
    return this.run(request, raw, signal, (access) =>
      this.store.exclusive(async () => {
        const input = KnowledgePublishRequestSchema.parse(raw),
          page = this.owned(access, input.libraryId, input.pageId),
          fingerprint = digest({ operation: 'publish', actorId: access.actorId, input });
        const replayed = this.replay(access, page, input.idempotencyKey, 'publish', fingerprint);
        if (replayed) return replayed;
        this.writeBudget(page, input.expectedVersion);
        const pending = page.draft;
        if (!pending || pending.body.bytes === 0) throw new KnowledgeError('invalid');
        if (page.versions.length >= KNOWLEDGE_LIMITS.versionsPerPage)
          throw new KnowledgeError('limit');
        const check = () => {
          access.check();
          this.checkSources(access, pending.sources);
        };
        check();
        await this.bytes.read(pending.body, access.signal, check);
        if (pending.original) await this.bytes.read(pending.original, access.signal, check);
        check();
        const published: KnowledgePublished = {
          version: page.versions.length + 1,
          title: pending.title,
          format: pending.format,
          body: pending.body,
          ...(pending.original ? { original: pending.original } : {}),
          sources: pending.sources,
          publishedAt: new Date().toISOString(),
        };
        const receipt: KnowledgeWriteReceipt = {
          key: input.idempotencyKey,
          operation: 'publish',
          fingerprint,
          pageRevision: page.version + 1,
          reference: reference(page, published),
        };
        const next: KnowledgePageRecord = {
          ...page,
          version: receipt.pageRevision,
          versions: [...page.versions, published],
          receipts: [...page.receipts, receipt],
        };
        delete next.draft;
        access.check();
        await this.store.put(next);
        access.check();
        return this.writeValue(access, next, receipt, 'published');
      }),
    );
  }

  private issueCursor(binding: object, offset: number): string {
    const payload = Buffer.from(
      JSON.stringify({ binding, offset, expires: Date.now() + 120_000 }),
    ).toString('base64url');
    return `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('base64url')}`;
  }
  private cursor(token: string, binding: object): number {
    try {
      const [payload, signature, ...extra] = token.split('.');
      if (!payload || !signature || extra.length) throw Error();
      const actual = Buffer.from(signature, 'base64url'),
        expected = createHmac('sha256', this.cursorKey).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const value = z
        .strictObject({
          binding: z.unknown(),
          offset: z.number().int().nonnegative(),
          expires: z.number(),
        })
        .parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (
        value.expires < Date.now() ||
        canonicalPayload(value.binding) !== canonicalPayload(binding)
      )
        throw Error();
      return value.offset;
    } catch {
      throw new KnowledgeError('conflict');
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.operations]);
      await this.bytes.idle();
      await this.store.close();
    })();
    return this.closing;
  }
}
export async function openKnowledgeService(
  ctx: Context,
  options: KnowledgeServiceOptions = {},
): Promise<KnowledgeService> {
  const store = await openKnowledgeStorage(ctx);
  try {
    return new KnowledgeService(ctx, store, new KnowledgeBytes(ctx.attachments), options);
  } catch {
    await store.close();
    throw new KnowledgeError('unavailable');
  }
}
