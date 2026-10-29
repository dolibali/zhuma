import type { Context } from '@deepseek-ai/cordis';
import { WorkbenchError } from '@zhuma/agent-core';
import { identityDomainSpec } from './identity-session.js';
import { spaceDirectoryFor } from './space-directory.js';
import type { MemberWorkbenchDirectory } from './member-workbench-dto.js';

function unavailable(): never {
  throw new WorkbenchError('unavailable', '成员目录暂不可用。');
}

/**
 * Host-only projection over the same opened facts. Pinned to the public
 * DomainFacility.get / KvTable.keys diagnostic read surface in DSH 0.2.1-rc.2.
 * It is NOT identity readiness or an authorization grant: callers must retain
 * live resolveMember checks before/after reads and before commands commit.
 * The caller context must declare storageDomain injection.
 * Never opens/closes domains, reads account values, or caches a member set.
 */
export function memberWorkbenchDirectoryFor(ctx: Context): MemberWorkbenchDirectory | undefined {
  try {
    const facility = ctx.storageDomain;
    const identity = facility.get(identityDomainSpec.name);
    const spaces = spaceDirectoryFor(ctx);
    if (!identity || !spaces) return undefined;
    const current = () => {
      if (
        ctx.storageDomain !== facility ||
        facility.get(identityDomainSpec.name) !== identity ||
        spaceDirectoryFor(ctx) !== spaces
      )
        unavailable();
    };
    const read = <T>(operation: () => T): T => {
      try {
        current();
        const value = operation();
        current();
        return value;
      } catch {
        return unavailable();
      }
    };
    return {
      spaces: () => read(() => spaces.spaces()),
      space: (id) => read(() => spaces.space(id)),
      isMember: (space, account) => read(() => spaces.isMember(space, account)),
      spacesForMember: (account) => read(() => spaces.spacesForMember(account)),
      administratorForSpace: (spaceId) => read(() => spaces.administratorForSpace(spaceId)),
      spaceForProject: async (id) => {
        try {
          current();
          const value = await spaces.spaceForProject(id);
          current();
          return value;
        } catch {
          return { ok: false, reason: 'unavailable' };
        }
      },
      membersForSpace: (spaceId) =>
        read(() => {
          if (!spaces.space(spaceId)) unavailable();
          const members: { id: string }[] = [];
          for (const id of identity.table('accounts').keys()) {
            if (spaces.isMember(spaceId, id)) members.push({ id });
          }
          return members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        }),
    };
  } catch {
    return unavailable();
  }
}
