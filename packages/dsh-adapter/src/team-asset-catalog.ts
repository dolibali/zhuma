import {
  KNOWLEDGE_LIMITS,
  KnowledgeLibrariesValueSchema,
  KnowledgeListValueSchema,
  MemberAssetListValueSchema,
  MemberAssetLegacyListValueSchema,
  TeamAssetCatalogQuerySchema,
  TeamAssetCatalogError,
  canonicalPayload,
  projectTeamAssetCatalog,
  type KnowledgeListValue,
  type MemberAssetAuthority,
  type TeamAssetCatalogValue,
} from '@zhuma/agent-core';
import type { KnowledgeService } from './knowledge-service.js';
import type { MemberAssetLegacyAuthority } from './member-asset-source-contract.js';
import type { MemberRequest } from './member-session.js';

export interface TeamAssetCatalogSources {
  readonly assets: Pick<MemberAssetAuthority<MemberRequest>, 'list'> &
    Pick<MemberAssetLegacyAuthority, 'sources'>;
  readonly knowledge: Pick<KnowledgeService, 'libraries' | 'list'>;
}
/** Read-only composition, not a new permission/metadata store. Both owners must
 * be the SAME Host's original current services. Every source sees the original
 * member request; the final original asset read rechecks current authorization.
 * This is not a transaction across two fact owners. Rows retain original pins;
 * using a row always requires its original service's fresh authorization. */
export class TeamAssetCatalogService {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly current: () => TeamAssetCatalogSources | undefined) {}

  list(request: MemberRequest, raw: unknown, signal: AbortSignal): Promise<TeamAssetCatalogValue> {
    if (this.lifetime.signal.aborted || signal.aborted)
      return Promise.reject(new TeamAssetCatalogError('asset-unavailable'));
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    const operation = this.listInner(request, raw, active);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  private async listInner(request: MemberRequest, raw: unknown, signal: AbortSignal) {
    const query = TeamAssetCatalogQuerySchema.safeParse(raw);
    if (!query.success) throw new TeamAssetCatalogError('asset-invalid');
    const source = this.current();
    const assetOwner = source?.assets,
      knowledgeOwner = source?.knowledge;
    const check = () => {
      const current = this.current();
      if (
        signal.aborted ||
        !source ||
        current?.assets !== assetOwner ||
        current?.knowledge !== knowledgeOwner
      )
        throw new TeamAssetCatalogError('asset-unavailable');
    };
    check();
    if (!source || !assetOwner || !knowledgeOwner)
      throw new TeamAssetCatalogError('asset-unavailable');
    const scope = { spaceId: query.data.spaceId };
    // Include only drafts returned under the original maintainer rules. The
    // wrapper never infers ownership from an id or filters another actor's list.
    const assets = MemberAssetListValueSchema.parse(
      await assetOwner.list(request, { ...scope, includeDrafts: true }, signal),
    );
    check();
    if (
      assets.spaceId !== scope.spaceId ||
      assets.items.some((row) => row.spaceId !== scope.spaceId)
    )
      throw new TeamAssetCatalogError('asset-unavailable');
    const legacy = MemberAssetLegacyListValueSchema.parse(
      await assetOwner.sources(request, scope, signal),
    );
    check();
    if (legacy.actorId !== assets.actorId || legacy.spaceId !== scope.spaceId)
      throw new TeamAssetCatalogError('asset-unavailable');
    const found = await knowledgeOwner.libraries(request, scope, signal);
    check();
    if (!found.ok) throw new TeamAssetCatalogError('asset-unavailable');
    const libraries = KnowledgeLibrariesValueSchema.parse(found.value);
    if (
      libraries.actorId !== assets.actorId ||
      libraries.spaceId !== scope.spaceId ||
      libraries.libraries.length !== 1 ||
      libraries.libraries[0]!.id !== scope.spaceId ||
      libraries.libraries[0]!.spaceId !== scope.spaceId
    )
      throw new TeamAssetCatalogError('asset-unavailable');
    const pages: KnowledgeListValue[] = [],
      seen = new Set<string>();
    let cursor: string | undefined,
      count = 0;
    for (;;) {
      const result = await knowledgeOwner.list(
        request,
        {
          ...scope,
          libraryId: libraries.libraries[0]!.id,
          limit: KNOWLEDGE_LIMITS.listResults,
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      check();
      if (!result.ok) throw new TeamAssetCatalogError('asset-unavailable');
      const page = KnowledgeListValueSchema.parse(result.value);
      if (
        page.actorId !== assets.actorId ||
        page.spaceId !== scope.spaceId ||
        page.libraryId !== scope.spaceId
      )
        throw new TeamAssetCatalogError('asset-unavailable');
      count += page.pages.length;
      if (
        count > KNOWLEDGE_LIMITS.pagesPerLibrary ||
        pages.length >= KNOWLEDGE_LIMITS.pagesPerLibrary + 1
      )
        throw new TeamAssetCatalogError('asset-quota');
      pages.push(page);
      if (page.nextCursor === null) break;
      if (!page.nextCursor || seen.has(page.nextCursor))
        throw new TeamAssetCatalogError('asset-unavailable');
      cursor = page.nextCursor;
      seen.add(cursor);
    }
    // No report/inbox/compensation or mutation: just the original scoped list.
    const final = MemberAssetListValueSchema.parse(
      await assetOwner.list(request, { ...scope, includeDrafts: true }, signal),
    );
    check();
    if (canonicalPayload(final) !== canonicalPayload(assets))
      throw new TeamAssetCatalogError('asset-unavailable');
    return projectTeamAssetCatalog(query.data, assets, pages, legacy);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      while (this.pending.size) await Promise.allSettled([...this.pending]);
    })());
  }
}
