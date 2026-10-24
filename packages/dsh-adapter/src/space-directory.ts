/**
 * Trusted, persistent space facts: which spaces exist, who belongs to them,
 * and which project belongs to which space.
 *
 * The directory lives in the `zhuma_spaces` storage domain on the server, so
 * project归属 and membership survive a restart and a revoked membership stops
 * being visible the moment the durable delete lands. Nothing here infers
 * membership from notes, from a browser-supplied actor, or from a project id.
 *
 * Reads are synchronous from the domain's authoritative in-memory state;
 * writes are durable first (the domain write chain rejects leave memory
 * untouched). `spaceForProject` stays async to satisfy the
 * {@link ProjectSpaceDirectory} contract the execution service consumes.
 */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError } from '@zhuma/agent-core';
import { PROJECT_SPACE_LIMIT } from './project-space.js';
import type { ProjectSpaceDirectory, ProjectSpaceLookup } from './project-space.js';

const ID_MAX = 100;
const ID_PATTERN = /^[\w-]+$/u;
const NAME_MAX = 200;

/** One host trusts at most this many spaces, mirroring the project cap. */
export const SPACE_DIRECTORY_SPACE_LIMIT = 100;
/** Membership rows are bounded by spaces × the identity account cap. */
export const SPACE_DIRECTORY_MEMBERSHIP_LIMIT = 1000;

const SpaceSchema = z.strictObject({
  id: z.string().min(1).max(ID_MAX).regex(ID_PATTERN),
  kind: z.enum(['personal', 'team']),
  name: z.string().min(1).max(NAME_MAX),
});

const MembershipSchema = z.strictObject({
  spaceId: z.string().min(1).max(ID_MAX).regex(ID_PATTERN),
  accountId: z.string().min(1).max(ID_MAX).regex(ID_PATTERN),
});

const ProjectSpaceRecordSchema = z.strictObject({
  projectId: z.string().min(1).max(ID_MAX).regex(ID_PATTERN),
  spaceId: z.string().min(1).max(ID_MAX).regex(ID_PATTERN),
});

const GlobalSchema = z.strictObject({
  importComplete: z.boolean(),
});

const ImportSchema = z.strictObject({
  spaces: z.array(SpaceSchema),
  memberships: z.array(MembershipSchema).optional(),
  projectSpaces: z.array(ProjectSpaceRecordSchema).optional(),
});

export const spaceDirectoryDomainSpec = defineDomain({
  name: 'zhuma_spaces',
  version: 1,
  global: { schema: GlobalSchema, initial: { importComplete: false } },
  tables: {
    spaces: { valueSchema: SpaceSchema },
    memberships: { valueSchema: MembershipSchema },
    project_spaces: { valueSchema: ProjectSpaceRecordSchema },
  },
});

type SpaceRecord = z.infer<typeof SpaceSchema>;
type MembershipRecord = z.infer<typeof MembershipSchema>;
type ProjectSpaceRecordRow = z.infer<typeof ProjectSpaceRecordSchema>;
type SpaceDirectoryDomain = Domain<typeof spaceDirectoryDomainSpec>;

export type SpaceKind = 'personal' | 'team';

/** Minimal display fields for one authorized space. */
export interface AuthorizedSpace {
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
}

/** Explicit seed for an empty directory; an occupied directory is never overwritten. */
export interface SpaceDirectoryImport {
  readonly spaces: readonly AuthorizedSpace[];
  readonly memberships?:
    readonly { readonly spaceId: string; readonly accountId: string }[] | undefined;
  readonly projectSpaces?:
    readonly { readonly projectId: string; readonly spaceId: string }[] | undefined;
}

/**
 * Trusted read side. `spacesForMember` enumerates every space the account
 * belongs to, including spaces with no projects and no notes. `isMember` is
 * the same fact for one space. Neither touches the notes table.
 */
export interface SpaceDirectory extends ProjectSpaceDirectory {
  /** All spaces, for startup diagnostics; unauthorized callers never see this. */
  spaces(): readonly AuthorizedSpace[];
  space(spaceId: string): AuthorizedSpace | undefined;
  isMember(spaceId: string, accountId: string): boolean;
  spacesForMember(accountId: string): readonly AuthorizedSpace[];
}

/** Durable write side. Every mutation persists before the memory state moves. */
export interface SpaceDirectoryWriter {
  createSpace(space: AuthorizedSpace): Promise<void>;
  grantMembership(spaceId: string, accountId: string): Promise<void>;
  revokeMembership(spaceId: string, accountId: string): Promise<void>;
  /** First assignment only; an already-assigned project rejects with `conflict`. */
  assignProjectSpace(projectId: string, spaceId: string): Promise<void>;
}

function invalid(message: string): WorkbenchError {
  return new WorkbenchError('validation', message);
}

function membershipKey(spaceId: string, accountId: string): string {
  return `${spaceId}/${accountId}`;
}

function validateImport(imported: SpaceDirectoryImport): void {
  if (imported.spaces.length > SPACE_DIRECTORY_SPACE_LIMIT) {
    throw invalid('空间目录超过上限。');
  }
  const memberships = imported.memberships ?? [];
  const projectSpaces = imported.projectSpaces ?? [];
  if (memberships.length > SPACE_DIRECTORY_MEMBERSHIP_LIMIT) {
    throw invalid('空间成员记录超过上限。');
  }
  if (projectSpaces.length > PROJECT_SPACE_LIMIT) {
    throw invalid('项目空间归属超过上限。');
  }
  const spaceIds = new Set<string>();
  for (const space of imported.spaces) {
    if (spaceIds.has(space.id)) throw invalid('空间标识重复。');
    spaceIds.add(space.id);
  }
  const membershipKeys = new Set<string>();
  for (const membership of memberships) {
    if (!spaceIds.has(membership.spaceId)) throw invalid('成员记录引用了不存在的空间。');
    const key = membershipKey(membership.spaceId, membership.accountId);
    if (membershipKeys.has(key)) throw invalid('空间成员记录重复。');
    membershipKeys.add(key);
  }
  const assigned = new Map<string, string>();
  for (const record of projectSpaces) {
    if (!spaceIds.has(record.spaceId)) throw invalid('项目归属引用了不存在的空间。');
    const prior = assigned.get(record.projectId);
    if (prior !== undefined && prior !== record.spaceId) {
      throw invalid('同一个项目不能属于两个空间。');
    }
    assigned.set(record.projectId, record.spaceId);
  }
}

class OpenedSpaceDirectory implements SpaceDirectory, SpaceDirectoryWriter {
  constructor(private readonly domain: SpaceDirectoryDomain) {}

  spaces(): readonly AuthorizedSpace[] {
    const list: AuthorizedSpace[] = [];
    for (const [, record] of this.domain.table('spaces').entries()) {
      list.push({ id: record.id, kind: record.kind, name: record.name });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  space(spaceId: string): AuthorizedSpace | undefined {
    const record = this.domain.table('spaces').get(spaceId);
    if (record === undefined) return undefined;
    return { id: record.id, kind: record.kind, name: record.name };
  }

  isMember(spaceId: string, accountId: string): boolean {
    return this.domain.table('memberships').get(membershipKey(spaceId, accountId)) !== undefined;
  }

  spacesForMember(accountId: string): readonly AuthorizedSpace[] {
    const list: AuthorizedSpace[] = [];
    for (const [, membership] of this.domain.table('memberships').entries()) {
      if (membership.accountId !== accountId) continue;
      const space = this.space(membership.spaceId);
      if (space !== undefined) list.push(space);
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  async spaceForProject(projectId: string): Promise<ProjectSpaceLookup> {
    try {
      const record = this.domain.table('project_spaces').get(projectId);
      if (record === undefined) return { ok: false, reason: 'unknown' };
      return { ok: true, spaceId: record.spaceId };
    } catch {
      // A closed domain rejects reads; report the directory as unavailable
      // instead of leaking an exception through the authorization gate.
      return { ok: false, reason: 'unavailable' };
    }
  }

  async createSpace(space: AuthorizedSpace): Promise<void> {
    const parsed = SpaceSchema.safeParse(space);
    if (!parsed.success) throw invalid('空间标识无效。');
    const table = this.domain.table('spaces');
    if (table.get(space.id) !== undefined) throw new WorkbenchError('conflict', '空间已存在。');
    if (table.size >= SPACE_DIRECTORY_SPACE_LIMIT) throw invalid('空间目录超过上限。');
    await table.put(space.id, parsed.data);
  }

  async grantMembership(spaceId: string, accountId: string): Promise<void> {
    const parsed = MembershipSchema.safeParse({ spaceId, accountId });
    if (!parsed.success) throw invalid('空间成员标识无效。');
    if (this.domain.table('spaces').get(spaceId) === undefined) {
      throw invalid('空间不存在。');
    }
    const table = this.domain.table('memberships');
    const key = membershipKey(spaceId, accountId);
    if (table.get(key) !== undefined) return; // already granted: idempotent
    if (table.size >= SPACE_DIRECTORY_MEMBERSHIP_LIMIT) {
      throw invalid('空间成员记录超过上限。');
    }
    await table.put(key, parsed.data);
  }

  async revokeMembership(spaceId: string, accountId: string): Promise<void> {
    // Durable delete first; later reads agree with the medium.
    await this.domain.table('memberships').delete(membershipKey(spaceId, accountId));
  }

  async assignProjectSpace(projectId: string, spaceId: string): Promise<void> {
    const parsed = ProjectSpaceRecordSchema.safeParse({ projectId, spaceId });
    if (!parsed.success) throw invalid('项目空间归属的标识无效。');
    if (this.domain.table('spaces').get(spaceId) === undefined) {
      throw invalid('空间不存在。');
    }
    const table = this.domain.table('project_spaces');
    if (table.get(projectId) !== undefined) {
      throw new WorkbenchError('conflict', '项目已有空间归属。');
    }
    if (table.size >= PROJECT_SPACE_LIMIT) throw invalid('项目空间归属超过上限。');
    await table.put(projectId, parsed.data);
  }

  /** Close the domain; later reads reject and `spaceForProject` reports unavailable. */
  async close(): Promise<void> {
    await this.domain.close();
  }
}

export interface OpenedSpaceDirectoryHandle extends SpaceDirectory, SpaceDirectoryWriter {
  close(): Promise<void>;
}

interface StorageDomainSeam {
  open(spec: typeof spaceDirectoryDomainSpec): Promise<SpaceDirectoryDomain>;
}

/** Registration is per host root, so plugin child contexts resolve the same directory. */
const directories = new WeakMap<object, OpenedSpaceDirectoryHandle>();

function directoryHost(ctx: object): object {
  const root = (ctx as { root?: unknown }).root;
  return typeof root === 'object' && root !== null ? root : ctx;
}

/**
 * The directory mounted on this host, if any. Identity and execution read it
 * lazily at each call, so a directory mounted after `applyIdentity` still
 * takes effect; with no directory mounted, member space enumeration is empty
 * (a safe default: nothing is authorized by inference). The handle also
 * carries the writer side for the host that owns the directory.
 */
export function spaceDirectoryFor(ctx: object): OpenedSpaceDirectoryHandle | undefined {
  return directories.get(directoryHost(ctx));
}

/**
 * Open the trusted directory on the host's storage and register it on the
 * host root. Cordis treats a plugin `apply` result as an effect, so this
 * mount returns nothing; callers read the handle via {@link spaceDirectoryFor}.
 * The disposer unregisters first, then closes the domain; reads after
 * disposal see no directory rather than a stale one.
 */
export async function applySpaceDirectory(
  ctx: Context,
  imported?: SpaceDirectoryImport,
): Promise<void> {
  const seam = (ctx as { storageDomain?: StorageDomainSeam }).storageDomain;
  if (seam === undefined || typeof seam.open !== 'function') {
    throw new Error('space directory startup refused: storageDomain is not available');
  }
  const directory = await openSpaceDirectory(seam, imported);
  const host = directoryHost(ctx);
  if (directories.has(host)) {
    await directory.close();
    throw new Error('space directory startup refused: already mounted on this host');
  }
  directories.set(host, directory);
  ctx.effect(() => {
    return async () => {
      directories.delete(host);
      await directory.close();
    };
  });
}

/**
 * Open the trusted directory on the host's storage. An explicit import seeds
 * an empty domain (the import marker is written last, so a crash mid-import
 * is retried from the same import on the next open); a domain that already
 * finished importing ignores the import argument and is never overwritten.
 */
export async function openSpaceDirectory(
  storageDomain: StorageDomainSeam,
  imported?: SpaceDirectoryImport,
): Promise<OpenedSpaceDirectoryHandle> {
  const domain = await storageDomain.open(spaceDirectoryDomainSpec);
  try {
    if (!domain.global.get().importComplete && imported !== undefined) {
      const parsed = ImportSchema.safeParse(imported);
      if (!parsed.success) throw invalid('空间目录导入无效。');
      validateImport(parsed.data);
      for (const space of parsed.data.spaces) {
        await domain.table('spaces').put(space.id, space);
      }
      for (const membership of parsed.data.memberships ?? []) {
        await domain
          .table('memberships')
          .put(membershipKey(membership.spaceId, membership.accountId), membership);
      }
      for (const record of parsed.data.projectSpaces ?? []) {
        await domain.table('project_spaces').put(record.projectId, record);
      }
      await domain.global.set({ importComplete: true });
    }
  } catch (error) {
    await domain.close().catch(() => {});
    throw error;
  }
  return new OpenedSpaceDirectory(domain);
}
