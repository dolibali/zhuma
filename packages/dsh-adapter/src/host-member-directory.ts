import type { Context } from '@deepseek-ai/cordis';
import { WorkbenchError } from '@zhuma/agent-core';
import { identityDomainSpec } from './identity-session.js';
import { spaceDirectoryFor } from './space-directory.js';
import { memberWorkbenchDirectoryFor } from './member-workbench-directory.js';
import type { MemberWorkbenchDirectory } from './member-workbench-dto.js';

/** Cache only the original projection's identity, never member/permission data.
 * Every projected method retains its original owner and live-read checks. */
export function createHostMemberDirectory(
  ctx: Context,
): () => MemberWorkbenchDirectory | undefined {
  let cached:
    | {
        facility: unknown;
        identity: unknown;
        spaces: unknown;
        view: MemberWorkbenchDirectory;
      }
    | undefined;
  return () => {
    try {
      const facility = ctx.storageDomain;
      const identity = facility.get(identityDomainSpec.name);
      const spaces = spaceDirectoryFor(ctx);
      if (!identity || !spaces) {
        cached = undefined;
        return undefined;
      }
      if (cached?.facility === facility && cached.identity === identity && cached.spaces === spaces)
        return cached.view;
      cached = undefined;
      const view = memberWorkbenchDirectoryFor(ctx);
      if (!view) return undefined;
      if (
        ctx.storageDomain !== facility ||
        facility.get(identityDomainSpec.name) !== identity ||
        spaceDirectoryFor(ctx) !== spaces
      )
        throw new Error('Member directory owner changed');
      cached = { facility, identity, spaces, view };
      return view;
    } catch {
      cached = undefined;
      throw new WorkbenchError('unavailable', '成员目录暂不可用。');
    }
  };
}
