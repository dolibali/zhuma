import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalPayload } from '@zhuma/agent-core';
import {
  IdentityInitializationError,
  type IdentityInitializationHandle,
  type IdentityInitializationOptions,
  type IdentitySetupPreparation,
} from './identity-session.js';
import {
  readSpaceDirectoryInitialization,
  spaceDirectoryInitializationFingerprint,
  type OpenedSpaceDirectoryHandle,
} from './space-directory.js';
import type { OpenedWorkbench } from './workbench-plugin.js';
import {
  hostTeamCatalogGrantsSchema,
  hostTeamCatalogManifest,
  hostTeamCatalogPin,
  type HostTeamCatalogGrants,
} from './host-team-catalog.js';
import {
  HostLocalSetupError,
  hostLocalSetupInputSchema,
  localSetupPackIds,
  type HostLocalSetupInput,
  type HostLocalSetupOperations,
  type HostLocalSetupSnapshot,
} from './host-local-setup-http.js';

const contextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  teamCatalog: hostTeamCatalogGrantsSchema,
});
const setupSchema = z.object({
  requestId: z.uuid(),
  setupFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  setupContext: contextSchema,
});
const labels = {
  'zhuma-work-planning': ['工作规划专家', '拆解目标、分工与工作依赖'],
  'zhuma-interaction-review': ['交互评审专家', '评审界面、流程与可用性'],
  'zhuma-workflow-diagram': ['工作流图专家', '整理流程和工作层级'],
  'zhuma-engineering-docs': ['工程文档专家', '整理技术方案与交付文档'],
} as const;
const unavailable = (): never => {
  throw new HostLocalSetupError('unavailable');
};
function normalize(grants: HostTeamCatalogGrants): HostTeamCatalogGrants {
  return hostTeamCatalogGrantsSchema
    .parse(grants)
    .map((grant) => ({
      ...grant,
      packs: [...grant.packs].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    }))
    .sort((a, b) => a.spaceId.localeCompare(b.spaceId, 'en'));
}
function fingerprint(grants: HostTeamCatalogGrants, directoryFingerprint: string) {
  return createHash('sha256')
    .update(
      canonicalPayload({
        schemaVersion: 1,
        directoryFingerprint,
        catalogPin: hostTeamCatalogPin(grants),
      }),
    )
    .digest('hex');
}

/** Composes original identity/directory initialization with the original fixed public package writer. */
export function openHostLocalSetup(options: {
  readonly workbench: OpenedWorkbench;
  readonly directory: () => OpenedSpaceDirectoryHandle | undefined;
  readonly configuredCatalog?: HostTeamCatalogGrants;
}) {
  const lifetime = new AbortController();
  let source: IdentityInitializationHandle | undefined;
  let ready:
    | {
        source: IdentityInitializationHandle;
        stamp: string;
        catalog: Awaited<ReturnType<OpenedWorkbench['openTeamCatalog']>>;
      }
    | undefined;
  const configured =
    options.configuredCatalog === undefined ? undefined : normalize(options.configuredCatalog);
  const packs: HostLocalSetupSnapshot['packs'] = localSetupPackIds.map((id) => {
    if (!hostTeamCatalogManifest().some((pack) => pack.id === id && pack.version === '1.0.0'))
      return unavailable();
    return { id, version: '1.0.0', name: labels[id][0], role: labels[id][1] };
  });
  function current(expected?: IdentityInitializationHandle) {
    if (
      lifetime.signal.aborted ||
      !source ||
      source.signal.aborted ||
      (expected && source !== expected)
    )
      return unavailable();
    return source;
  }
  function parse(raw: unknown) {
    const result = setupSchema.safeParse(raw);
    if (!result.success) throw new HostLocalSetupError('recovery-required');
    const value = result.data,
      grants = normalize(value.setupContext.teamCatalog);
    // This first-setup operation creates one actual team, not grants inferred from existing catalog rows.
    if (
      grants.length !== 1 ||
      grants[0]!.spaceId !== `team-${value.requestId}` ||
      canonicalPayload(grants) !== canonicalPayload(value.setupContext.teamCatalog) ||
      (configured && canonicalPayload(configured) !== canonicalPayload(grants))
    )
      throw new HostLocalSetupError('conflict');
    const directory = options.directory();
    if (!directory || directory.signal.aborted) return unavailable();
    const state = directory.initializationStatus();
    if (
      state.kind !== 'configured' ||
      !state.fingerprint ||
      directory.space(grants[0]!.spaceId)?.kind !== 'team'
    )
      return unavailable();
    if (fingerprint(grants, state.fingerprint) !== value.setupFingerprint)
      throw new HostLocalSetupError('conflict');
    return {
      value,
      grants,
      directory,
      stamp: canonicalPayload(value),
      directoryFingerprint: state.fingerprint,
    };
  }
  async function establish(
    raw: unknown,
    expected: IdentityInitializationHandle,
    initialize = false,
  ) {
    current(expected);
    const check = parse(raw);
    if (!ready || ready.source !== expected || ready.stamp !== check.stamp) {
      const catalog = await options.workbench.openTeamCatalog({
        grants: check.grants,
        directory: options.directory,
        initialize,
      });
      current(expected);
      const after = parse(expected.readSetup());
      if (after.stamp !== check.stamp || after.directory !== check.directory) return unavailable();
      const visible = await catalog(check.grants[0]!.spaceId);
      current(expected);
      if (
        visible.experts.length !== check.grants[0]!.packs.length ||
        check.grants[0]!.packs.some(
          (pack) =>
            !visible.experts.some(
              (expert) => expert.id === pack.id && expert.origin?.sourceVersion === pack.version,
            ),
        )
      )
        return unavailable();
      ready = { source: expected, stamp: check.stamp, catalog };
    }
    return check;
  }
  const initialization: IdentityInitializationOptions = {
    publish(handle) {
      if (lifetime.signal.aborted) return unavailable();
      source = handle;
      ready = undefined;
      return () => {
        if (source === handle) {
          source = undefined;
          ready = undefined;
        }
      };
    },
    async beforeComplete(input: IdentitySetupPreparation) {
      const owner = current();
      if (
        owner.status().kind !== 'pending' ||
        input.signal !== owner.signal ||
        input.accountIds.length !== 1 ||
        input.signal.aborted
      )
        return unavailable();
      const original = owner.readSetup();
      const check = parse(original);
      if (
        check.value.requestId !== input.requestId ||
        check.value.setupFingerprint !== input.setupFingerprint ||
        canonicalPayload(check.value.setupContext) !== canonicalPayload(input.setupContext) ||
        check.directoryFingerprint !== input.directoryFingerprint ||
        !check.directory.isMember(check.grants[0]!.spaceId, input.accountIds[0]!) ||
        localSetupPackIds.some((id) => input.accountIds.includes(id))
      )
        throw new HostLocalSetupError('conflict');
      await establish(original, owner, true);
      current(owner);
      return undefined;
    },
  };
  const operations: HostLocalSetupOperations = {
    status() {
      const owner = current(),
        status = owner.status();
      if (status.kind === 'configured' && owner.readSetup()) {
        const checked = parse(owner.readSetup());
        if (!ready || ready.source !== owner || ready.stamp !== checked.stamp) return unavailable();
      }
      return { ...status, packs };
    },
    async initialize(raw: HostLocalSetupInput) {
      const input = hostLocalSetupInputSchema.parse(raw),
        owner = current();
      // Human and expert participants share the original Workbench id namespace.
      // Refuse this before any identity/directory write, rather than creating an unusable team.
      if (localSetupPackIds.some((id) => id === input.accountId))
        throw new HostLocalSetupError('invalid-input');
      const teamId = `team-${input.requestId}`;
      const directory = readSpaceDirectoryInitialization({
        spaces: [
          { id: `personal-${input.accountId}`, kind: 'personal', name: '个人空间' },
          { id: teamId, kind: 'team', name: input.teamName },
        ],
        memberships: [
          { spaceId: `personal-${input.accountId}`, accountId: input.accountId },
          { spaceId: teamId, accountId: input.accountId },
        ],
        projectSpaces: [],
      });
      const grants = normalize([
        { spaceId: teamId, packs: input.packIds.map((id) => ({ id, version: '1.0.0' })) },
      ]);
      if (configured && canonicalPayload(configured) !== canonicalPayload(grants))
        throw new HostLocalSetupError('conflict');
      try {
        const result = await owner.initializeAccount({
          requestId: input.requestId,
          accountId: input.accountId,
          password: input.password,
          directory,
          setupContext: { schemaVersion: 1, teamCatalog: grants },
          setupFingerprint: fingerprint(grants, spaceDirectoryInitializationFingerprint(directory)),
        });
        current(owner);
        if (owner.readSetup()) await establish(owner.readSetup(), owner);
        if (result.kind === 'initialized') {
          const checked = parse(owner.readSetup());
          const team = checked.directory.space(checked.grants[0]!.spaceId);
          if (
            checked.value.requestId !== input.requestId ||
            !team ||
            team.kind !== 'team' ||
            !checked.directory.isMember(team.id, input.accountId)
          )
            return unavailable();
          return {
            ...operations.status(),
            createdTeam: { id: team.id, kind: 'team', name: team.name },
          };
        }
        return operations.status();
      } catch (error) {
        if (error instanceof HostLocalSetupError) throw error;
        if (error instanceof IdentityInitializationError) throw new HostLocalSetupError(error.code);
        throw new HostLocalSetupError('unavailable');
      }
    },
  };
  return {
    initialization,
    operations,
    async restore() {
      const owner = current();
      if (owner.status().kind === 'configured' && owner.readSetup())
        await establish(owner.readSetup(), owner);
    },
    async catalog(spaceId: string) {
      const owner = current();
      if (owner.status().kind !== 'configured' || !ready) return { experts: [], assets: [] };
      const checked = parse(owner.readSetup());
      if (ready.source !== owner || ready.stamp !== checked.stamp) return unavailable();
      return ready.catalog(spaceId);
    },
    hasSetup() {
      return current().readSetup() !== undefined;
    },
    close() {
      lifetime.abort();
      ready = undefined;
      source = undefined;
    },
  };
}
