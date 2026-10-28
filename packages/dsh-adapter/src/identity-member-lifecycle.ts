import { z } from 'zod';
import { WorkbenchError } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import type { ExecutionMemberLease } from './execution-run-authority.js';
import type { OpenedSpaceDirectoryHandle } from './space-directory.js';

const accountId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/u);
const spaceId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const requestId = z.uuid();
const password = z.string().min(8).max(200);
export const identityRegistrationSchema = z.strictObject({ requestId, accountId, password });
export const identityTeamCreationSchema = z.strictObject({
  requestId,
  name: z.string().trim().min(1).max(160),
});
export const identityTeamMembersSchema = z.strictObject({ spaceId });
export const identityTeamMemberCommandSchema = z.strictObject({
  requestId,
  spaceId,
  accountId,
  action: z.enum(['add', 'remove']),
});
export const identityPasswordChangeSchema = z.strictObject({
  oldPassword: z.string().min(1).max(200),
  newPassword: password,
});

/** Private recovery intents live in the ORIGINAL identity domain, never a read grant. */
export const identityLifecycleOperationSchema = z.discriminatedUnion('kind', [
  identityRegistrationSchema.omit({ password: true }).extend({
    kind: z.literal('register'),
    phase: z.enum(['pending', 'complete']),
    verifier: z.string().min(1).max(300),
  }),
  identityTeamCreationSchema.extend({
    kind: z.literal('create-team'),
    phase: z.enum(['pending', 'complete']),
    actorId: accountId,
  }),
  identityTeamMemberCommandSchema.extend({
    kind: z.literal('member'),
    phase: z.enum(['pending', 'complete']),
    actorId: accountId,
  }),
]);
type Operation = z.infer<typeof identityLifecycleOperationSchema>;
export interface IdentityLifecycleAccount {
  readonly id: string;
  readonly passwordHash: string;
  readonly credentialRevision?: number | undefined;
}
export interface IdentityTeamView {
  readonly id: string;
  readonly name: string;
  readonly role: 'administrator' | 'member';
}
export interface IdentityMemberLifecycleHandle {
  readonly signal: AbortSignal;
  register(
    request: MemberRequest,
    input: unknown,
  ): Promise<{
    readonly accountId: string;
    readonly personalSpaceId: string;
    readonly disposition: 'created' | 'replayed';
  }>;
  changePassword(
    request: MemberRequest,
    input: unknown,
  ): Promise<{ readonly reauthenticate: true }>;
  teams(
    request: MemberRequest,
  ): Promise<{ readonly accountId: string; readonly teams: readonly IdentityTeamView[] }>;
  createTeam(
    request: MemberRequest,
    input: unknown,
  ): Promise<{
    readonly spaceId: string;
    readonly disposition: 'created' | 'replayed';
  }>;
  members(
    request: MemberRequest,
    input: unknown,
  ): Promise<{
    readonly spaceId: string;
    readonly administratorId: string | null;
    readonly accountIds: readonly string[];
  }>;
  setMember(
    request: MemberRequest,
    input: unknown,
  ): Promise<{
    readonly spaceId: string;
    readonly accountId: string;
    readonly disposition: 'applied' | 'replayed';
  }>;
}
export interface IdentityMemberLifecycleOptions {
  publish(handle: IdentityMemberLifecycleHandle): () => void;
  /** Additional public expert IDs in the Host's current catalog. No browser-supplied list. */
  reservedAccountIds?(): readonly string[];
}
export interface IdentityMemberLifecycleSource {
  readonly signal: AbortSignal;
  check(request: MemberRequest): void;
  rateLimit(request: MemberRequest, key: string): void;
  assertAccountIdAvailable(accountId: string): void;
  directory(): OpenedSpaceDirectoryHandle | undefined;
  lease(request: MemberRequest): Promise<ExecutionMemberLease>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  prepareRegistration(): Promise<void>;
  accounts: {
    get(id: string): IdentityLifecycleAccount | undefined;
    put(id: string, account: IdentityLifecycleAccount): Promise<void>;
    readonly size: number;
  };
  operations: {
    get(id: string): Operation | undefined;
    put(id: string, operation: Operation): Promise<void>;
    values(): Iterable<Operation>;
    readonly size: number;
  };
  hash(password: string): Promise<string>;
  matches(verifier: string, password: string): Promise<boolean>;
}
const fail = (code: string): never => {
  throw new WorkbenchError(code, '账号或团队操作暂不可用。');
};
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fail('validation');
};

/** One identity writer, the original directory, and genuine revocable member leases. */
export function createIdentityMemberLifecycle(
  source: IdentityMemberLifecycleSource,
): IdentityMemberLifecycleHandle {
  function check(request: MemberRequest) {
    if (source.signal.aborted) return fail('unavailable');
    source.check(request);
  }
  function directory() {
    const value = source.directory();
    if (!value || value.signal.aborted) return fail('unavailable');
    return value;
  }
  function idle(resource: (operation: Operation) => boolean, request: string) {
    for (const op of source.operations.values())
      if (op.phase === 'pending' && op.requestId !== request && resource(op))
        return fail('recovery-required');
    if (!source.operations.get(request) && source.operations.size >= 2000)
      return fail('quota-exceeded');
  }
  async function member<T>(
    request: MemberRequest,
    work: (
      lease: ExecutionMemberLease,
      dir: OpenedSpaceDirectoryHandle,
      assert: (space?: string) => void,
    ) => Promise<T>,
  ) {
    check(request);
    const lease = await source.lease(request).catch(() => fail('unauthenticated'));
    try {
      const dir = directory();
      const anchor = dir.spacesForMember(lease.memberId)[0]?.id;
      if (!anchor) return fail('not-found');
      const assert = (space = anchor) => {
        check(request);
        if (directory() !== dir) return fail('unavailable');
        if (!dir.space(space) || !dir.isMember(space, lease.memberId)) return fail('not-found');
        try {
          lease.assertCurrent(space);
        } catch {
          return fail('unauthenticated');
        }
        if (!source.accounts.get(lease.memberId)) return fail('unauthenticated');
      };
      assert();
      return await source.exclusive(async () => {
        assert();
        return work(lease, dir, assert);
      });
    } finally {
      lease.release();
    }
  }
  function admin(dir: OpenedSpaceDirectoryHandle, space: string, actor: string) {
    if (dir.space(space)?.kind !== 'team' || !dir.isMember(space, actor)) return fail('not-found');
    if (dir.administratorForSpace(space) !== actor) return fail('forbidden');
  }
  return Object.freeze<IdentityMemberLifecycleHandle>({
    signal: source.signal,
    async register(request, raw) {
      check(request);
      const input = parse(identityRegistrationSchema, raw);
      source.rateLimit(request, `register:${input.accountId}`);
      return source.exclusive(async () => {
        check(request);
        const dir = directory();
        idle((op) => op.kind === 'register' && op.accountId === input.accountId, input.requestId);
        let op = source.operations.get(input.requestId);
        if (op && (op.kind !== 'register' || op.accountId !== input.accountId))
          return fail('conflict');
        const existing = source.accounts.get(input.accountId);
        if (!op && existing) return fail('conflict');
        if (op?.phase !== 'complete') source.assertAccountIdAvailable(input.accountId);
        if (!op && source.accounts.size >= 100) return fail('quota-exceeded');
        if (op) {
          if (op.kind !== 'register' || !(await source.matches(op.verifier, input.password)))
            return fail('conflict');
        } else {
          const verifier = await source.hash(input.password);
          check(request);
          source.assertAccountIdAvailable(input.accountId);
          await source.prepareRegistration();
          op = {
            kind: 'register',
            phase: 'pending',
            requestId: input.requestId,
            accountId: input.accountId,
            verifier,
          };
          await source.operations.put(input.requestId, op);
        }
        if (op.kind !== 'register') return fail('conflict');
        check(request);
        if (directory() !== dir) return fail('unavailable');
        const personalSpaceId = `personal-${input.accountId}`;
        if (op.phase === 'complete') {
          if (
            !existing ||
            existing.passwordHash !== op.verifier ||
            !dir.isMember(personalSpaceId, input.accountId)
          )
            return fail('conflict');
          return { accountId: input.accountId, personalSpaceId, disposition: 'replayed' as const };
        }
        await dir.provisionMemberSpace(
          { id: personalSpaceId, kind: 'personal', name: `${input.accountId}的个人空间` },
          input.accountId,
          input.requestId,
          () => check(request),
        );
        check(request);
        if (directory() !== dir) return fail('unavailable');
        if (existing && existing.passwordHash !== op.verifier) return fail('conflict');
        source.assertAccountIdAvailable(input.accountId);
        // The account becomes usable only after its personal space and membership are durable.
        if (!existing)
          await source.accounts.put(input.accountId, {
            id: input.accountId,
            passwordHash: op.verifier,
          });
        check(request);
        await source.operations.put(input.requestId, { ...op, phase: 'complete' });
        return { accountId: input.accountId, personalSpaceId, disposition: 'created' as const };
      });
    },
    async changePassword(request, raw) {
      const input = parse(identityPasswordChangeSchema, raw);
      return member(request, async (lease, _dir, assert) => {
        source.rateLimit(request, `password:${lease.memberId}`);
        const account = source.accounts.get(lease.memberId)!;
        if (!(await source.matches(account.passwordHash, input.oldPassword)))
          return fail('invalid-login');
        const passwordHash = await source.hash(input.newPassword);
        assert();
        if (source.accounts.get(lease.memberId)?.passwordHash !== account.passwordHash)
          return fail('conflict');
        const revision = (account.credentialRevision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) return fail('unavailable');
        await source.accounts.put(account.id, {
          ...account,
          passwordHash,
          credentialRevision: revision,
        });
        return { reauthenticate: true as const };
      });
    },
    async teams(request) {
      return member(request, async (lease, dir, assert) => {
        const teams = dir
          .spacesForMember(lease.memberId)
          .filter((space) => space.kind === 'team')
          .map((space) => ({
            id: space.id,
            name: space.name,
            role:
              dir.administratorForSpace(space.id) === lease.memberId
                ? ('administrator' as const)
                : ('member' as const),
          }));
        assert();
        return { accountId: lease.memberId, teams };
      });
    },
    async createTeam(request, raw) {
      const input = parse(identityTeamCreationSchema, raw);
      return member(request, async (lease, dir, assert) => {
        let op = source.operations.get(input.requestId);
        if (
          op &&
          (op.kind !== 'create-team' || op.actorId !== lease.memberId || op.name !== input.name)
        )
          return fail('conflict');
        idle(
          (item) => item.kind === 'create-team' && item.actorId === lease.memberId,
          input.requestId,
        );
        if (!op) {
          op = { ...input, kind: 'create-team', actorId: lease.memberId, phase: 'pending' };
          await source.operations.put(input.requestId, op);
        }
        assert();
        const spaceId = `team-${input.requestId}`;
        await dir.provisionMemberSpace(
          { id: spaceId, name: input.name, kind: 'team' },
          lease.memberId,
          input.requestId,
          assert,
        );
        assert(spaceId);
        const replay = op.phase === 'complete';
        if (!replay) await source.operations.put(input.requestId, { ...op, phase: 'complete' });
        return { spaceId, disposition: replay ? ('replayed' as const) : ('created' as const) };
      });
    },
    async members(request, raw) {
      const input = parse(identityTeamMembersSchema, raw);
      return member(request, async (_lease, dir, assert) => {
        assert(input.spaceId);
        if (dir.space(input.spaceId)?.kind !== 'team') return fail('not-found');
        const accountIds = dir
          .memberIdsForSpace(input.spaceId)
          .filter((id) => source.accounts.get(id) !== undefined);
        const administratorId = dir.administratorForSpace(input.spaceId) ?? null;
        assert(input.spaceId);
        return { spaceId: input.spaceId, administratorId, accountIds };
      });
    },
    async setMember(request, raw) {
      const input = parse(identityTeamMemberCommandSchema, raw);
      return member(request, async (lease, dir, assert) => {
        const guard = () => {
          assert(input.spaceId);
          admin(dir, input.spaceId, lease.memberId);
        };
        guard();
        if (!source.accounts.get(input.accountId)) return fail('not-found');
        if (input.action === 'remove' && input.accountId === lease.memberId)
          return fail('forbidden');
        idle((item) => item.kind === 'member' && item.spaceId === input.spaceId, input.requestId);
        let op = source.operations.get(input.requestId);
        if (
          op &&
          (op.kind !== 'member' ||
            op.actorId !== lease.memberId ||
            op.spaceId !== input.spaceId ||
            op.accountId !== input.accountId ||
            op.action !== input.action)
        )
          return fail('conflict');
        if (op?.phase === 'complete')
          return {
            spaceId: input.spaceId,
            accountId: input.accountId,
            disposition: 'replayed' as const,
          };
        if (!op) {
          op = { ...input, actorId: lease.memberId, kind: 'member', phase: 'pending' };
          await source.operations.put(input.requestId, op);
        }
        guard();
        await dir.setManagedMembership(
          input.spaceId,
          input.accountId,
          input.action,
          lease.memberId,
          guard,
        );
        guard();
        await source.operations.put(input.requestId, { ...op, phase: 'complete' });
        return {
          spaceId: input.spaceId,
          accountId: input.accountId,
          disposition: 'applied' as const,
        };
      });
    },
  });
}
