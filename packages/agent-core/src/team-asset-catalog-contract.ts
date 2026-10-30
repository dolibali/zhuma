import { z } from 'zod';
import {
  MEMBER_ASSET_LIMITS,
  MemberAssetListValueSchema,
  MemberAssetSummarySchema,
  MemberAssetLegacyListValueSchema,
  MemberAssetLegacySummarySchema,
} from './member-asset-contract.js';
import {
  KNOWLEDGE_LIMITS,
  KnowledgeListValueSchema,
  KnowledgePageSummarySchema,
  KnowledgeVersionRefSchema,
} from './knowledge-contract.js';

/** Portable read projection only. Original asset and knowledge services retain
 * all facts, permissions, commands and body reads. No catalog row is a grant. */
export const TEAM_ASSET_CATALOG_SOURCE_VERSION = 'zhuma-team-asset-catalog@1' as const;
export const TeamAssetCategorySchema = z.enum(['all', 'material', 'template', 'expert', 'skill']);
const category = TeamAssetCategorySchema.exclude(['all']);
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const maximumItems = MEMBER_ASSET_LIMITS.assets + KNOWLEDGE_LIMITS.pagesPerLibrary + 200;
export const TeamAssetCatalogQuerySchema = z.strictObject({
  spaceId: KnowledgeVersionRefSchema.shape.spaceId,
  category: TeamAssetCategorySchema.default('all'),
  search: z.string().trim().max(200).default(''),
  offset: natural.max(maximumItems).default(0),
  limit: z.number().int().positive().max(100).default(50),
});
export type TeamAssetCatalogQuery = z.input<typeof TeamAssetCatalogQuerySchema>;
export const TeamAssetCatalogRowSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('asset'), category, asset: MemberAssetSummarySchema }),
  z.strictObject({
    source: z.literal('knowledge'),
    category: z.literal('material'),
    page: KnowledgePageSummarySchema,
  }),
  z.strictObject({
    source: z.enum(['builtin', 'package', 'member-template', 'unknown']),
    category,
    legacy: MemberAssetLegacySummarySchema,
  }),
]);
export type TeamAssetCatalogRow = z.infer<typeof TeamAssetCatalogRowSchema>;
const countsSchema = z.strictObject({
  all: natural.max(maximumItems),
  material: natural.max(maximumItems),
  template: natural.max(maximumItems),
  expert: natural.max(maximumItems),
  skill: natural.max(maximumItems),
});
export const TeamAssetCatalogValueSchema = z
  .strictObject({
    sourceVersion: z.literal(TEAM_ASSET_CATALOG_SOURCE_VERSION),
    actorId: KnowledgeListValueSchema.shape.actorId,
    spaceId: KnowledgeVersionRefSchema.shape.spaceId,
    category: TeamAssetCategorySchema,
    search: z.string().max(200),
    offset: natural.max(maximumItems),
    limit: z.number().int().positive().max(100),
    /** One logical asset OR one published online page is one item. Versions
     * and dependency children never increase this count. */
    countUnit: z.literal('items'),
    total: natural.max(maximumItems),
    counts: countsSchema,
    items: z.array(TeamAssetCatalogRowSchema).max(100),
    nextOffset: natural.max(maximumItems).nullable(),
  })
  .superRefine((value, ctx) => {
    const { counts } = value;
    if (
      counts.all !== counts.material + counts.template + counts.expert + counts.skill ||
      value.total !== counts[value.category] ||
      value.items.length !== Math.min(value.limit, Math.max(0, value.total - value.offset)) ||
      value.nextOffset !==
        (value.offset + value.items.length < value.total
          ? value.offset + value.items.length
          : null) ||
      new Set(value.items.map(teamAssetCatalogRowKey)).size !== value.items.length ||
      value.items.some((row) =>
        row.source === 'asset'
          ? row.asset.spaceId !== value.spaceId ||
            row.category !== (row.asset.kind === 'file' ? 'material' : row.asset.kind)
          : row.source === 'knowledge'
            ? row.page.reference.spaceId !== value.spaceId
            : row.legacy.source.spaceId !== value.spaceId ||
              row.source !== row.legacy.source.kind ||
              row.category !== (row.legacy.kind === 'file' ? 'material' : row.legacy.kind),
      ) ||
      (value.category !== 'all' && value.items.some((row) => row.category !== value.category))
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent catalog projection.' });
  });
export type TeamAssetCatalogValue = z.infer<typeof TeamAssetCatalogValueSchema>;

export class TeamAssetCatalogError extends Error {
  constructor(readonly code: 'asset-invalid' | 'asset-unavailable' | 'asset-quota') {
    super('资产目录暂不可核对。');
    this.name = 'TeamAssetCatalogError';
  }
}
/** Stable source-qualified identity; a knowledge page id is never an asset id.
 * Fixed version selection remains in the untouched original row reference. */
export function teamAssetCatalogRowKey(row: TeamAssetCatalogRow): string {
  return row.source === 'asset'
    ? JSON.stringify(['asset', row.asset.spaceId, row.asset.assetId])
    : row.source === 'knowledge'
      ? JSON.stringify([
          'knowledge',
          row.page.reference.spaceId,
          row.page.reference.libraryId,
          row.page.reference.pageId,
        ])
      : JSON.stringify(['legacy', row.legacy.source.spaceId, row.legacy.source.assetId]);
}
const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
const rowName = (row: TeamAssetCatalogRow) =>
  row.source === 'asset'
    ? row.asset.name
    : row.source === 'knowledge'
      ? row.page.title
      : row.legacy.name;

/** No I/O or permission filtering. The caller supplies only responses obtained
 * from all original services using the SAME member request and selected scope.
 * Missing, incomplete, mixed or duplicate sources fail instead of becoming zero
 * counts, an arbitrary latest version, or a locally filtered permission view. */
export function projectTeamAssetCatalog(
  rawQuery: unknown,
  rawAssets: unknown,
  rawKnowledgePages: unknown,
  rawLegacySources: unknown,
): TeamAssetCatalogValue {
  const query = TeamAssetCatalogQuerySchema.safeParse(rawQuery);
  if (!query.success) throw new TeamAssetCatalogError('asset-invalid');
  const assets = MemberAssetListValueSchema.safeParse(rawAssets);
  const legacy = MemberAssetLegacyListValueSchema.safeParse(rawLegacySources);
  const knowledge = z
    .array(KnowledgeListValueSchema)
    .min(1)
    .max(KNOWLEDGE_LIMITS.pagesPerLibrary + 1)
    .safeParse(rawKnowledgePages);
  if (!assets.success || !knowledge.success || !legacy.success)
    throw new TeamAssetCatalogError('asset-unavailable');
  const input = query.data;
  if (
    assets.data.spaceId !== input.spaceId ||
    assets.data.items.some((row) => row.spaceId !== input.spaceId) ||
    legacy.data.actorId !== assets.data.actorId ||
    legacy.data.spaceId !== input.spaceId ||
    legacy.data.items.some((row) => row.source.spaceId !== input.spaceId)
  )
    throw new TeamAssetCatalogError('asset-unavailable');
  const seenCursors = new Set<string>();
  const rows: TeamAssetCatalogRow[] = assets.data.items.map((asset) => ({
    source: 'asset',
    category: asset.kind === 'file' ? 'material' : asset.kind,
    asset,
  }));
  rows.push(
    ...legacy.data.items.map((row) => ({
      source: row.source.kind,
      category: row.kind === 'file' ? ('material' as const) : row.kind,
      legacy: row,
    })),
  );
  let pages = 0;
  for (const [index, response] of knowledge.data.entries()) {
    if (
      response.actorId !== assets.data.actorId ||
      response.spaceId !== input.spaceId ||
      response.libraryId !== input.spaceId ||
      (index < knowledge.data.length - 1
        ? response.nextCursor === null
        : response.nextCursor !== null) ||
      (response.nextCursor !== null && seenCursors.has(response.nextCursor))
    )
      throw new TeamAssetCatalogError('asset-unavailable');
    if (response.nextCursor !== null) seenCursors.add(response.nextCursor);
    pages += response.pages.length;
    if (pages > KNOWLEDGE_LIMITS.pagesPerLibrary) throw new TeamAssetCatalogError('asset-quota');
    for (const page of response.pages) {
      if (
        page.reference.spaceId !== input.spaceId ||
        page.reference.libraryId !== response.libraryId
      )
        throw new TeamAssetCatalogError('asset-unavailable');
      rows.push({ source: 'knowledge', category: 'material', page });
    }
  }
  if (new Set(rows.map(teamAssetCatalogRowKey)).size !== rows.length)
    throw new TeamAssetCatalogError('asset-unavailable');
  const terms = normalized(input.search).split(/\s+/u).filter(Boolean);
  const filtered = rows.filter((row) => {
    const text = normalized(
      row.source === 'asset'
        ? `${row.asset.name}\n${row.asset.description}`
        : row.source === 'knowledge'
          ? row.page.title
          : `${row.legacy.name}\n${row.legacy.description}`,
    );
    return terms.every((term) => text.includes(term));
  });
  const counts = { all: filtered.length, material: 0, template: 0, expert: 0, skill: 0 };
  for (const row of filtered) counts[row.category]++;
  const selected = filtered.filter(
    (row) => input.category === 'all' || row.category === input.category,
  );
  selected.sort((a, b) => {
    const nameA = normalized(rowName(a));
    const nameB = normalized(rowName(b));
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return teamAssetCatalogRowKey(a) < teamAssetCatalogRowKey(b) ? -1 : 1;
  });
  const items = selected.slice(input.offset, input.offset + input.limit);
  return TeamAssetCatalogValueSchema.parse({
    ...input,
    sourceVersion: TEAM_ASSET_CATALOG_SOURCE_VERSION,
    actorId: assets.data.actorId,
    countUnit: 'items',
    total: selected.length,
    counts,
    items,
    nextOffset: input.offset + items.length < selected.length ? input.offset + items.length : null,
  });
}
