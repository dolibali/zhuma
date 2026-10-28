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
 *
 * The domain chain serializes each durable write, and memory changes only
 * inside that queued job. Checks that decide whether a write is legal have
 * to share a critical section with the awaited write; this module keeps that
 * section on one directory queue.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError, canonicalPayload } from '@zhuma/agent-core';
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
  /** Only new member-created spaces carry management authority. Legacy seeds do not. */
  management: z
    .strictObject({
      requestId: z.uuid(),
      administratorId: z.string().min(1).max(64).regex(ID_PATTERN),
      phase: z.enum(['pending', 'ready']),
    })
    .optional(),
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
  /**
   * `importing` while a seed is unfinished, `writer` once the writer has taken
   * the directory, otherwise `null` (empty, or a finished import).
   */
  importState: z.enum(['importing', 'writer']).nullable(),
  /** Identity of the seed that started an import; `null` until the first import write. */
  importSeed: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

const ImportSchema = z.strictObject({
  spaces: z.array(SpaceSchema),
  memberships: z.array(MembershipSchema).optional(),
  projectSpaces: z.array(ProjectSpaceRecordSchema).optional(),
});

export const spaceDirectoryDomainSpec = defineDomain({
  name: 'zhuma_spaces',
  version: 1,
  global: {
    schema: GlobalSchema,
    initial: { importComplete: false, importState: null, importSeed: null },
  },
  tables: {
    spaces: { valueSchema: SpaceSchema },
    memberships: { valueSchema: MembershipSchema },
    project_spaces: { valueSchema: ProjectSpaceRecordSchema },
  },
});

type SpaceRecord = z.infer<typeof SpaceSchema>;
type MembershipRecord = z.infer<typeof MembershipSchema>;
type ProjectSpaceRecordRow = z.infer<typeof ProjectSpaceRecordSchema>;
type GlobalRecord = z.infer<typeof GlobalSchema>;
type SpaceDirectoryDomain = Domain<typeof spaceDirectoryDomainSpec>;

export type SpaceKind = 'personal' | 'team';

/** Minimal display fields for one authorized space. */
export interface AuthorizedSpace {
  readonly id: string;
  readonly kind: SpaceKind;
  readonly name: string;
}

/**
 * Explicit seed. An empty directory may be seeded once. A finished import
 * ignores later seeds. Rows written through the writer reject a seed. An
 * unfinished import resumes only from the same seed; anything else fails closed.
 */
export interface SpaceDirectoryImport {
  readonly spaces: readonly AuthorizedSpace[];
  readonly memberships?:
    readonly { readonly spaceId: string; readonly accountId: string }[] | undefined;
  readonly projectSpaces?:
    readonly { readonly projectId: string; readonly spaceId: string }[] | undefined;
}

export type SpaceDirectoryInitializationStatus =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'pending'; readonly fingerprint: string }
  | { readonly kind: 'configured'; readonly fingerprint: string | null }
  | { readonly kind: 'recovery-required' };
export interface SpaceDirectoryOpenOptions {
  /** Only the original Host's setup control plane may resume a pending import.
   * Member reads and ordinary writes remain unavailable until it completes. */
  readonly allowPendingInitialization?: boolean;
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

interface NormalizedImport {
  readonly spaces: readonly SpaceRecord[];
  readonly memberships: readonly MembershipRecord[];
  readonly projectSpaces: readonly ProjectSpaceRecordRow[];
}

type DirectoryPhase = 'empty' | 'writer' | 'importing' | 'complete';

function invalid(message: string): WorkbenchError {
  return new WorkbenchError('validation', message);
}

function membershipKey(spaceId: string, accountId: string): string {
  return `${spaceId}/${accountId}`;
}

function sameSpace(left: SpaceRecord, right: SpaceRecord): boolean {
  return left.id === right.id && left.kind === right.kind && left.name === right.name;
}

function sameMembership(left: MembershipRecord, right: MembershipRecord): boolean {
  return left.spaceId === right.spaceId && left.accountId === right.accountId;
}

function sameProject(left: ProjectSpaceRecordRow, right: ProjectSpaceRecordRow): boolean {
  return left.projectId === right.projectId && left.spaceId === right.spaceId;
}

function validateImport(imported: NormalizedImport): void {
  if (imported.spaces.length > SPACE_DIRECTORY_SPACE_LIMIT) {
    throw invalid('空间目录超过上限。');
  }
  if (imported.memberships.length > SPACE_DIRECTORY_MEMBERSHIP_LIMIT) {
    throw invalid('空间成员记录超过上限。');
  }
  if (imported.projectSpaces.length > PROJECT_SPACE_LIMIT) {
    throw invalid('项目空间归属超过上限。');
  }
  const spaceIds = new Set<string>();
  for (const space of imported.spaces) {
    if (spaceIds.has(space.id)) throw invalid('空间标识重复。');
    spaceIds.add(space.id);
  }
  const membershipKeys = new Set<string>();
  for (const membership of imported.memberships) {
    if (!spaceIds.has(membership.spaceId)) throw invalid('成员记录引用了不存在的空间。');
    const key = membershipKey(membership.spaceId, membership.accountId);
    if (membershipKeys.has(key)) throw invalid('空间成员记录重复。');
    membershipKeys.add(key);
  }
  const assigned = new Map<string, string>();
  for (const record of imported.projectSpaces) {
    if (!spaceIds.has(record.spaceId)) throw invalid('项目归属引用了不存在的空间。');
    const prior = assigned.get(record.projectId);
    if (prior !== undefined && prior !== record.spaceId) {
      throw invalid('同一个项目不能属于两个空间。');
    }
    assigned.set(record.projectId, record.spaceId);
  }
}

function parseImport(imported: unknown): NormalizedImport {
  const parsed = ImportSchema.safeParse(imported);
  if (!parsed.success) throw invalid('空间目录导入无效。');
  const memberships = parsed.data.memberships ?? [];
  const projectSpaces = parsed.data.projectSpaces ?? [];
  // Reject duplicate members and conflicting assignments before identical rows are folded.
  validateImport({ spaces: parsed.data.spaces, memberships, projectSpaces });
  const spaces = [...parsed.data.spaces].sort((left, right) => left.id.localeCompare(right.id));
  const foldedProjects: ProjectSpaceRecordRow[] = [];
  const seenProjects = new Set<string>();
  const projectInput = [...projectSpaces].sort((left, right) =>
    left.projectId.localeCompare(right.projectId),
  );
  for (const record of projectInput) {
    if (seenProjects.has(record.projectId)) continue;
    seenProjects.add(record.projectId);
    foldedProjects.push({ projectId: record.projectId, spaceId: record.spaceId });
  }
  const foldedMembers = [...memberships].sort((left, right) =>
    membershipKey(left.spaceId, left.accountId).localeCompare(
      membershipKey(right.spaceId, right.accountId),
    ),
  );
  return { spaces, memberships: foldedMembers, projectSpaces: foldedProjects };
}

function importSeed(imported: NormalizedImport): string {
  const canonical = JSON.stringify({
    spaces: imported.spaces.map((space) => [space.id, space.kind, space.name]),
    memberships: imported.memberships.map((membership) => [
      membership.spaceId,
      membership.accountId,
    ]),
    projectSpaces: imported.projectSpaces.map((record) => [record.projectId, record.spaceId]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Same normalized seed used by the original directory importer, not authority. */
export function spaceDirectoryInitializationFingerprint(imported: SpaceDirectoryImport): string {
  return importSeed(parseImport(imported));
}

/** Validate and copy a Host initializer through the same original import schema. */
export function readSpaceDirectoryInitialization(imported: unknown): SpaceDirectoryImport {
  return parseImport(imported);
}

function directoryHasRows(domain: SpaceDirectoryDomain): boolean {
  return (
    domain.table('spaces').size > 0 ||
    domain.table('memberships').size > 0 ||
    domain.table('project_spaces').size > 0
  );
}

function readPhase(domain: SpaceDirectoryDomain): DirectoryPhase {
  const global = domain.global.get();
  if (global.importComplete) return 'complete';
  if (global.importState === 'importing') return 'importing';
  if (global.importState === 'writer' || directoryHasRows(domain)) return 'writer';
  return 'empty';
}

async function putSame<K extends string, V>(
  table: {
    get(key: K): V | undefined;
    put(key: K, value: V): Promise<void>;
  },
  key: K,
  value: V,
  same: (left: V, right: V) => boolean,
): Promise<void> {
  const existing = table.get(key);
  if (existing === undefined) {
    await table.put(key, value);
    return;
  }
  if (!same(existing, value)) throw invalid('导入与已有记录不一致。');
}

async function applyImportRows(
  domain: SpaceDirectoryDomain,
  imported: NormalizedImport,
): Promise<void> {
  for (const space of imported.spaces) {
    await putSame(domain.table('spaces'), space.id, space, sameSpace);
  }
  for (const membership of imported.memberships) {
    await putSame(
      domain.table('memberships'),
      membershipKey(membership.spaceId, membership.accountId),
      membership,
      sameMembership,
    );
  }
  for (const record of imported.projectSpaces) {
    await putSame(domain.table('project_spaces'), record.projectId, record, sameProject);
  }
}

/**
 * Empty directories accept a first seed. The importing marker and seed identity
 * land before any row, and `importComplete` lands last. A matching seed may
 * continue an unfinished import. A different seed, or no seed, fails closed.
 * Writer-owned rows and a finished import are not seeded again.
 */
async function reconcileImport(
  domain: SpaceDirectoryDomain,
  imported: SpaceDirectoryImport | undefined,
): Promise<void> {
  const phase = readPhase(domain);
  if (phase === 'complete') return;
  if (phase === 'writer') {
    if (imported !== undefined) {
      throw new WorkbenchError('conflict', '空间目录已由写入占用，不能再用导入覆盖。');
    }
    return;
  }
  if (imported === undefined) {
    if (phase === 'importing') throw invalid('导入尚未完成，缺少同一份导入数据。');
    return;
  }
  const parsed = parseImport(imported);
  const seed = importSeed(parsed);
  const current = domain.global.get();
  if (phase === 'importing') {
    if (current.importSeed !== seed) {
      throw invalid('导入尚未完成，恢复数据与未完成的导入不一致。');
    }
  } else {
    const marker: GlobalRecord = {
      importComplete: false,
      importState: 'importing',
      importSeed: seed,
    };
    await domain.global.set(marker);
  }
  await applyImportRows(domain, parsed);
  await domain.global.set({ importComplete: true, importState: null, importSeed: seed });
}

class OpenedSpaceDirectory implements SpaceDirectory, SpaceDirectoryWriter {
  private readonly lifetime = new AbortController();
  readonly signal = this.lifetime.signal;
  private closing: Promise<void> | undefined;
  /** Next mutation waits until the previous check and its durable write have both finished. */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly domain: SpaceDirectoryDomain) {}

  private active(): void {
    if (this.signal.aborted) throw new WorkbenchError('unavailable', '空间目录已关闭。');
  }
  private available(): void {
    this.active();
    if (readPhase(this.domain) === 'importing')
      throw new WorkbenchError('unavailable', '空间目录初始化尚未完成。');
  }
  initializationStatus(): SpaceDirectoryInitializationStatus {
    this.active();
    const global = this.domain.global.get();
    if (
      (global.importComplete && global.importState !== null) ||
      (global.importState === 'importing' && !global.importSeed)
    )
      return { kind: 'recovery-required' };
    switch (readPhase(this.domain)) {
      case 'complete':
        return { kind: 'configured', fingerprint: global.importSeed };
      case 'importing':
        return { kind: 'pending', fingerprint: global.importSeed! };
      case 'writer':
        return { kind: 'recovery-required' };
      case 'empty':
        return global.importSeed ? { kind: 'recovery-required' } : { kind: 'unconfigured' };
    }
  }
  async initializeImport(
    imported: SpaceDirectoryImport,
  ): Promise<{ readonly kind: 'initialized'; readonly fingerprint: string }> {
    const normalized = parseImport(imported),
      fingerprint = importSeed(normalized);
    return this.exclusive(async () => {
      const status = this.initializationStatus();
      if (
        status.kind === 'recovery-required' ||
        ((status.kind === 'pending' || status.kind === 'configured') &&
          status.fingerprint !== fingerprint)
      )
        throw new WorkbenchError('conflict', '空间目录初始化与原有记录不一致。');
      const expected = [
        [this.domain.table('spaces'), new Map(normalized.spaces.map((row) => [row.id, row]))],
        [
          this.domain.table('memberships'),
          new Map(
            normalized.memberships.map((row) => [membershipKey(row.spaceId, row.accountId), row]),
          ),
        ],
        [
          this.domain.table('project_spaces'),
          new Map(normalized.projectSpaces.map((row) => [row.projectId, row])),
        ],
      ] as const;
      for (const [table, rows] of expected) {
        const byKey = new Map<string, unknown>(rows);
        for (const [key, row] of table.entries())
          if (canonicalPayload(row) !== canonicalPayload(byKey.get(key) ?? null))
            throw new WorkbenchError('conflict', '空间目录存在未知的初始化记录。');
        // An already completed directory may have been deliberately changed.
        // Retrying setup cannot silently restore a revoked membership.
        if (status.kind === 'configured' && table.size !== byKey.size)
          throw new WorkbenchError('conflict', '已完成的空间目录发生了变化。');
      }
      await reconcileImport(this.domain, normalized);
      this.active();
      return { kind: 'initialized', fingerprint };
    });
  }

  /**
   * Hold the decision and the awaited domain write together. `put` itself only
   * enqueues the durable job; the memory row appears when that job finishes.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  spaces(): readonly AuthorizedSpace[] {
    this.available();
    const list: AuthorizedSpace[] = [];
    for (const [, record] of this.domain.table('spaces').entries()) {
      if (record.management?.phase === 'pending') continue;
      list.push({ id: record.id, kind: record.kind, name: record.name });
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  space(spaceId: string): AuthorizedSpace | undefined {
    this.available();
    const record = this.domain.table('spaces').get(spaceId);
    if (record === undefined || record.management?.phase === 'pending') return undefined;
    return { id: record.id, kind: record.kind, name: record.name };
  }

  isMember(spaceId: string, accountId: string): boolean {
    this.available();
    return (
      this.space(spaceId) !== undefined &&
      this.domain.table('memberships').get(membershipKey(spaceId, accountId)) !== undefined
    );
  }

  administratorForSpace(spaceId: string): string | undefined {
    if (!this.space(spaceId)) return undefined;
    return this.domain.table('spaces').get(spaceId)?.management?.administratorId;
  }

  memberIdsForSpace(spaceId: string): readonly string[] {
    if (!this.space(spaceId)) return [];
    return [...this.domain.table('memberships').entries()]
      .map(([, row]) => row)
      .filter((row) => row.spaceId === spaceId)
      .map((row) => row.accountId)
      .sort();
  }

  /** A recoverable original-directory write; partial spaces are invisible to all read grants. */
  async provisionMemberSpace(
    space: AuthorizedSpace,
    administratorId: string,
    requestId: string,
    assertCurrent: () => void,
  ): Promise<void> {
    const input = SpaceSchema.parse({
      ...space,
      management: { administratorId, requestId, phase: 'pending' },
    });
    await this.exclusive(async () => {
      const check = () => {
        this.available();
        assertCurrent();
      };
      check();
      const spaces = this.domain.table('spaces'),
        members = this.domain.table('memberships');
      const prior = spaces.get(space.id),
        key = membershipKey(space.id, administratorId);
      if (
        prior &&
        (!sameSpace(prior, input) ||
          prior.management?.administratorId !== administratorId ||
          prior.management.requestId !== requestId)
      )
        throw new WorkbenchError('conflict', '空间创建意图与已有记录不一致。');
      if (prior?.management?.phase === 'ready') {
        if (!members.get(key)) throw new WorkbenchError('conflict', '已创建空间的成员发生变化。');
        return;
      }
      if (
        (!prior && spaces.size >= SPACE_DIRECTORY_SPACE_LIMIT) ||
        (!members.get(key) && members.size >= SPACE_DIRECTORY_MEMBERSHIP_LIMIT)
      )
        throw invalid('空间目录超过上限。');
      // Mark writer ownership before its first row, including a failed first registration.
      await this.noteWriter();
      check();
      if (!prior) {
        await spaces.put(space.id, input);
        check();
      }
      if (!members.get(key)) {
        await members.put(key, { spaceId: space.id, accountId: administratorId });
        check();
      }
      await spaces.put(space.id, {
        ...input,
        management: { ...input.management!, phase: 'ready' },
      });
      check();
    });
  }

  /** Checks the ORIGINAL member capability inside the same directory writer queue. */
  async setManagedMembership(
    spaceId: string,
    accountId: string,
    action: 'add' | 'remove',
    administratorId: string,
    assertCurrent: () => void,
  ): Promise<void> {
    const input = MembershipSchema.parse({ spaceId, accountId });
    await this.exclusive(async () => {
      this.available();
      assertCurrent();
      if (
        this.space(spaceId)?.kind !== 'team' ||
        this.administratorForSpace(spaceId) !== administratorId ||
        !this.isMember(spaceId, administratorId) ||
        (action === 'remove' && accountId === administratorId)
      )
        throw new WorkbenchError('forbidden', '仅创建管理员可以管理团队成员。');
      const members = this.domain.table('memberships'),
        key = membershipKey(spaceId, accountId);
      if (action === 'add') {
        if (!members.get(key)) {
          if (members.size >= SPACE_DIRECTORY_MEMBERSHIP_LIMIT)
            throw invalid('空间成员记录超过上限。');
          await members.put(key, input);
        }
      } else if (members.get(key)) await members.delete(key);
      this.available();
      assertCurrent();
    });
  }

  spacesForMember(accountId: string): readonly AuthorizedSpace[] {
    this.available();
    const list: AuthorizedSpace[] = [];
    for (const [, membership] of this.domain.table('memberships').entries()) {
      if (membership.accountId !== accountId) continue;
      const space = this.space(membership.spaceId);
      if (space !== undefined) list.push(space);
    }
    return list.sort((a, b) => a.id.localeCompare(b.id));
  }

  spaceForProjectNow(projectId: string): ProjectSpaceLookup {
    if (this.signal.aborted) return { ok: false, reason: 'unavailable' };
    try {
      this.available();
      const record = this.domain.table('project_spaces').get(projectId);
      if (record === undefined) return { ok: false, reason: 'unknown' };
      return { ok: true, spaceId: record.spaceId };
    } catch {
      // A closed domain rejects reads; report the directory as unavailable
      // instead of leaking an exception through the authorization gate.
      return { ok: false, reason: 'unavailable' };
    }
  }

  async spaceForProject(projectId: string): Promise<ProjectSpaceLookup> {
    return this.spaceForProjectNow(projectId);
  }

  async createSpace(space: AuthorizedSpace): Promise<void> {
    const parsed = SpaceSchema.safeParse(space);
    if (!parsed.success) throw invalid('空间标识无效。');
    await this.exclusive(async () => {
      this.available();
      const table = this.domain.table('spaces');
      if (table.get(space.id) !== undefined) throw new WorkbenchError('conflict', '空间已存在。');
      if (table.size >= SPACE_DIRECTORY_SPACE_LIMIT) throw invalid('空间目录超过上限。');
      await table.put(space.id, parsed.data);
      await this.noteWriter();
    });
  }

  async grantMembership(spaceId: string, accountId: string): Promise<void> {
    const parsed = MembershipSchema.safeParse({ spaceId, accountId });
    if (!parsed.success) throw invalid('空间成员标识无效。');
    await this.exclusive(async () => {
      this.available();
      if (this.domain.table('spaces').get(spaceId) === undefined) {
        throw invalid('空间不存在。');
      }
      const table = this.domain.table('memberships');
      const key = membershipKey(spaceId, accountId);
      if (table.get(key) !== undefined) return;
      if (table.size >= SPACE_DIRECTORY_MEMBERSHIP_LIMIT) {
        throw invalid('空间成员记录超过上限。');
      }
      await table.put(key, parsed.data);
      await this.noteWriter();
    });
  }

  async revokeMembership(spaceId: string, accountId: string): Promise<void> {
    await this.exclusive(async () => {
      this.available();
      // Durable delete first; later reads agree with the medium.
      await this.domain.table('memberships').delete(membershipKey(spaceId, accountId));
    });
  }

  async assignProjectSpace(projectId: string, spaceId: string): Promise<void> {
    const parsed = ProjectSpaceRecordSchema.safeParse({ projectId, spaceId });
    if (!parsed.success) throw invalid('项目空间归属的标识无效。');
    await this.exclusive(async () => {
      this.available();
      if (this.domain.table('spaces').get(spaceId) === undefined) {
        throw invalid('空间不存在。');
      }
      const table = this.domain.table('project_spaces');
      if (table.get(projectId) !== undefined) {
        throw new WorkbenchError('conflict', '项目已有空间归属。');
      }
      if (table.size >= PROJECT_SPACE_LIMIT) throw invalid('项目空间归属超过上限。');
      await table.put(projectId, parsed.data);
      await this.noteWriter();
    });
  }

  /** Remember that rows now come from the writer, so a later seed cannot treat them as empty. */
  private async noteWriter(): Promise<void> {
    const current = this.domain.global.get();
    if (current.importComplete || current.importState !== null) return;
    const marker: GlobalRecord = { importComplete: false, importState: 'writer', importSeed: null };
    await this.domain.global.set(marker);
  }

  /** Close the domain; later reads reject and `spaceForProject` reports unavailable. */
  close(): Promise<void> {
    // Reserve the close before notifying listeners, including reentrant close calls.
    this.closing ??= this.exclusive(() => this.domain.close());
    this.lifetime.abort();
    return this.closing;
  }
}

export interface OpenedSpaceDirectoryHandle extends SpaceDirectory, SpaceDirectoryWriter {
  readonly signal: AbortSignal;
  administratorForSpace(spaceId: string): string | undefined;
  memberIdsForSpace(spaceId: string): readonly string[];
  provisionMemberSpace(
    space: AuthorizedSpace,
    administratorId: string,
    requestId: string,
    assertCurrent: () => void,
  ): Promise<void>;
  setManagedMembership(
    spaceId: string,
    accountId: string,
    action: 'add' | 'remove',
    administratorId: string,
    assertCurrent: () => void,
  ): Promise<void>;
  initializationStatus(): SpaceDirectoryInitializationStatus;
  initializeImport(
    imported: SpaceDirectoryImport,
  ): Promise<{ readonly kind: 'initialized'; readonly fingerprint: string }>;
  /** Host authorization reads the same current domain; closed/failed sources refuse. */
  spaceForProjectNow(projectId: string): ProjectSpaceLookup;
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
  options?: SpaceDirectoryOpenOptions,
): Promise<void> {
  const seam = (ctx as { storageDomain?: StorageDomainSeam }).storageDomain;
  if (seam === undefined || typeof seam.open !== 'function') {
    throw new Error('space directory startup refused: storageDomain is not available');
  }
  const directory = await openSpaceDirectory(seam, imported, options);
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
 * Open the trusted directory on the host's storage.
 *
 * Empty: optional seed, marker first, rows next, `importComplete` last.
 * Writer-owned: open for read and write; a seed is refused and nothing is overwritten.
 * Import unfinished: only the same seed may finish; a missing or different seed
 * closes the domain and throws, so a partial directory is not usable.
 * Import finished: the seed is ignored and the directory opens unchanged.
 */
export async function openSpaceDirectory(
  storageDomain: StorageDomainSeam,
  imported?: SpaceDirectoryImport,
  options?: SpaceDirectoryOpenOptions,
): Promise<OpenedSpaceDirectoryHandle> {
  const domain = await storageDomain.open(spaceDirectoryDomainSpec);
  try {
    if (!(
      options?.allowPendingInitialization &&
      imported === undefined &&
      readPhase(domain) === 'importing'
    ))
      await reconcileImport(domain, imported);
  } catch (error) {
    await domain.close().catch(() => {});
    throw error;
  }
  return new OpenedSpaceDirectory(domain);
}
