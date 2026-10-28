import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  applyWorkbenchCommand,
  canonicalPayload,
  emptyWorkbench,
  parseWorkflowTemplate,
  previewResourcePackage,
  StoredAssetPackageSchema,
  WorkbenchError,
  type Workbench,
  type WorkbenchCommand,
  type ImportPackageInput,
} from '@zhuma/agent-core';
import type { MemberWorkbenchCatalog } from './member-workbench-dto.js';
import type { SpaceDirectory } from './space-directory.js';

declare const ZHUMA_PUBLIC_TEAM_PACKAGES: unknown;
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const reference = z.strictObject({ id, version: z.literal('1.0.0') });
export const hostTeamCatalogGrantsSchema = z
  .array(
    z.strictObject({
      spaceId: id,
      packs: z.array(reference).min(1).max(4),
    }),
  )
  .max(100)
  .superRefine((grants, ctx) => {
    if (
      new Set(grants.map((item) => item.spaceId)).size !== grants.length ||
      grants.some((item) => new Set(item.packs.map((pack) => pack.id)).size !== item.packs.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate team catalog grant.' });
  });
export type HostTeamCatalogGrants = z.infer<typeof hostTeamCatalogGrantsSchema>;
const publicPackageSchema = z.strictObject({
  id,
  version: z.literal('1.0.0'),
  versionId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z
    .array(z.strictObject({ path: z.string(), data: z.string() }))
    .min(1)
    .max(100),
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function unavailable(): never {
  throw new WorkbenchError('team-catalog-unavailable', '团队基础专家目录暂不可用。');
}
type ImportCommand = Extract<WorkbenchCommand, { type: 'import-package' }>;
function publicPackages(source?: unknown) {
  const raw =
    source ??
    (typeof ZHUMA_PUBLIC_TEAM_PACKAGES === 'undefined' ? undefined : ZHUMA_PUBLIC_TEAM_PACKAGES);
  const packages = z.array(publicPackageSchema).length(4).parse(raw);
  if (
    new Set(packages.map((item) => item.id)).size !== packages.length ||
    packages.some((item) => hash(item.files) !== item.digest)
  )
    unavailable();
  return packages;
}
/** Public source metadata for a future genuine owner setup UI; it enables no space. */
export function hostTeamCatalogManifest(source?: unknown) {
  return publicPackages(source).map(({ files: _files, ...metadata }) => metadata);
}
/** Bind the explicit space selection and original package bytes, never mint authority. */
export function hostTeamCatalogPin(raw: HostTeamCatalogGrants, source?: unknown): string {
  const grants = hostTeamCatalogGrantsSchema
    .parse(raw)
    .map((grant) => ({
      ...grant,
      packs: [...grant.packs].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    }))
    .sort((a, b) => a.spaceId.localeCompare(b.spaceId, 'en'));
  const manifest = hostTeamCatalogManifest(source);
  const selected = [
    ...new Set(grants.flatMap((grant) => grant.packs.map((pack) => `${pack.id}@${pack.version}`))),
  ]
    .sort()
    .map((key) => {
      const item = manifest.find((pack) => `${pack.id}@${pack.version}` === key);
      if (!item) unavailable();
      return item;
    });
  return createHash('sha256')
    .update(canonicalPayload({ grants, packages: selected }))
    .digest('hex');
}

/** Only fixed public package selections. No user directory, legacy catalog fallback or grants. */
export async function openHostTeamCatalog(options: {
  grants: HostTeamCatalogGrants;
  directory(): Pick<SpaceDirectory, 'space'> | undefined;
  readWorkbench(): Workbench;
  readPackage(versionId: string): unknown;
  importPackage(request: {
    requestId: string;
    expectedRevision: number;
    command: ImportCommand;
  }): Promise<unknown>;
  signal: AbortSignal;
  /** Completed first setup may only verify its already-published immutable records. */
  initialize?: boolean;
  /** Shared member backend only: original public packs for real teams without
   * an explicit selection. This is not a Config/HTTP grant or execution permit. */
  defaultForTeams?: true;
  /** Host-private build/test source, never a Config or HTTP field. */
  packages?: unknown;
}): Promise<(spaceId: string) => Promise<MemberWorkbenchCatalog>> {
  const grants = hostTeamCatalogGrantsSchema.parse(options.grants);
  const defaultForTeams = options.defaultForTeams;
  const signal = options.signal;
  const readWorkbench = options.readWorkbench,
    readPackage = options.readPackage;
  const readDirectory = options.directory;
  const directory = readDirectory();
  if (!directory) unavailable();
  const readSpace = directory.space;
  const active = () => {
    if (
      signal.aborted ||
      options.signal !== signal ||
      options.readWorkbench !== readWorkbench ||
      options.readPackage !== readPackage ||
      options.directory !== readDirectory ||
      options.defaultForTeams !== defaultForTeams ||
      readDirectory() !== directory ||
      directory.space !== readSpace ||
      grants.some((grant) => readSpace.call(directory, grant.spaceId)?.kind !== 'team')
    )
      unavailable();
  };
  active();
  const packages = publicPackages(options.packages);
  const defaults = defaultForTeams ? packages.map(({ id, version }) => ({ id, version })) : [];
  const definitions = new Map<
    string,
    {
      value: MemberWorkbenchCatalog;
      record: z.infer<typeof StoredAssetPackageSchema>;
      command: ImportCommand;
    }
  >();
  for (const wanted of [...grants.flatMap((grant) => grant.packs), ...defaults]) {
    if (definitions.has(wanted.id)) continue;
    const pack = packages.find((item) => item.id === wanted.id && item.version === wanted.version);
    if (
      !pack ||
      hash(pack.files) !== pack.digest ||
      !pack.files.some((file) => file.path === 'LICENSE.txt')
    )
      unavailable();
    const preview = previewResourcePackage(pack.files, parseWorkflowTemplate);
    const experts = preview.items.filter((item) => item.kind === 'expert');
    if (
      experts.length !== 1 ||
      experts[0]!.sourceId !== pack.id ||
      experts[0]!.sourceVersion !== pack.version ||
      preview.items.some((item) => item.missing.length || !['expert', 'skill'].includes(item.kind))
    )
      unavailable();
    const input: ImportPackageInput = {
      versionId: pack.versionId,
      files: pack.files,
      choices: preview.items.map((item) => ({
        key: item.key,
        id: item.kind === 'expert' ? pack.id : item.name,
        replace: false,
        name: item.name,
        description: item.description,
        role: item.role,
        capabilities: item.capabilities,
        available: true,
      })),
    };
    const command: ImportCommand = { type: 'import-package', input };
    const expected = applyWorkbenchCommand(emptyWorkbench(), command);
    const files = preview.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const record = StoredAssetPackageSchema.parse({
      versionId: pack.versionId,
      files,
      digest: hash(files),
    });
    definitions.set(pack.id, {
      value: { experts: expected.participants, assets: expected.assets },
      record,
      command,
    });
  }
  function verifyDefinition(
    current: Workbench,
    value: MemberWorkbenchCatalog,
    requireAll: boolean,
  ) {
    for (const [expected, candidates] of [
      [value.experts, current.participants],
      [value.assets, current.assets],
    ] as const)
      for (const item of expected) {
        const matches = candidates.filter((candidate) => candidate.id === item.id);
        if (
          matches.length > 1 ||
          (requireAll && matches.length !== 1) ||
          (matches[0] && canonicalPayload(matches[0]) !== canonicalPayload(item))
        )
          unavailable();
      }
  }
  function verifyPackage(expected: z.infer<typeof StoredAssetPackageSchema>, required: boolean) {
    active();
    const raw = readPackage(expected.versionId);
    if (raw === undefined && !required) return;
    const parsed = StoredAssetPackageSchema.safeParse(raw);
    if (!parsed.success || canonicalPayload(parsed.data) !== canonicalPayload(expected))
      unavailable();
  }
  // Startup imports use the original serialized command/receipt and immutable package table.
  // No read endpoint initializes a catalog, and a cold reopen verifies rather than reimports.
  for (const definition of definitions.values()) {
    active();
    const current = readWorkbench();
    verifyDefinition(current, definition.value, false);
    verifyPackage(definition.record, false);
    const present = [...definition.value.experts, ...definition.value.assets].every((item) =>
      [...current.participants, ...current.assets].some((candidate) => candidate.id === item.id),
    );
    if (!present || readPackage(definition.record.versionId) === undefined) {
      if (options.initialize === false) unavailable();
      const command = structuredClone(definition.command);
      for (const choice of command.input.choices)
        choice.replace = [...current.participants, ...current.assets].some(
          (item) => item.id === choice.id,
        );
      await options.importPackage({
        requestId: `team-starter-${definition.record.versionId}`,
        expectedRevision: current.revision,
        command,
      });
    }
    active();
    verifyDefinition(readWorkbench(), definition.value, true);
    verifyPackage(definition.record, true);
  }
  return async (spaceId) => {
    active();
    const grant = grants.find((item) => item.spaceId === spaceId);
    const selected = grant?.packs ?? defaults;
    if (!selected.length || directory.space(spaceId)?.kind !== 'team')
      return { experts: [], assets: [] };
    const experts: MemberWorkbenchCatalog['experts'][number][] = [],
      assets: MemberWorkbenchCatalog['assets'][number][] = [];
    for (const ref of selected) {
      const definition = definitions.get(ref.id);
      if (!definition) unavailable();
      verifyDefinition(readWorkbench(), definition.value, true);
      verifyPackage(definition.record, true);
      experts.push(...definition.value.experts);
      assets.push(...definition.value.assets);
    }
    active();
    if (options.directory() !== directory) unavailable();
    return structuredClone({ experts, assets });
  };
}
