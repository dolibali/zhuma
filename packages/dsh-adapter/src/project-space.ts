import { WorkbenchError } from '@zhuma/agent-core';

/** Workbench projects are capped at 100, so a space catalog is too. */
export const PROJECT_SPACE_LIMIT = 100;

const ID_MAX = 100;
const ID_PATTERN = /^[\w-]+$/u;

export interface ProjectSpaceRecord {
  readonly projectId: string;
  readonly spaceId: string;
}

export type ProjectSpaceLookup =
  | { readonly ok: true; readonly spaceId: string }
  | { readonly ok: false; readonly reason: 'unknown' | 'unavailable' };

/**
 * Trusted space for one project.
 * The caller supplies a project id and receives a space id. It does not send a space id in.
 */
export interface ProjectSpaceDirectory {
  spaceForProject(projectId: string): Promise<ProjectSpaceLookup>;
}

export type ProjectSpaceDecision = 'ok' | 'hidden' | 'unavailable';

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ID_MAX &&
    ID_PATTERN.test(value)
  );
}

/**
 * Copy an explicit catalog. One project has one space. The two ids may differ.
 * An oversized, conflicting, or ill-formed catalog is rejected at construction.
 */
export function boundedProjectSpaces(
  records: readonly ProjectSpaceRecord[],
): ProjectSpaceDirectory {
  if (!Array.isArray(records)) {
    throw new WorkbenchError('validation', '项目空间归属的标识无效。');
  }
  if (records.length > PROJECT_SPACE_LIMIT) {
    throw new WorkbenchError('validation', '项目空间归属超过上限。');
  }
  const byProject = new Map<string, string>();
  for (const record of records) {
    if (record == null || typeof record !== 'object') {
      throw new WorkbenchError('validation', '项目空间归属的标识无效。');
    }
    if (!validId(record.projectId) || !validId(record.spaceId)) {
      throw new WorkbenchError('validation', '项目空间归属的标识无效。');
    }
    const prior = byProject.get(record.projectId);
    if (prior !== undefined && prior !== record.spaceId) {
      throw new WorkbenchError('validation', '同一个项目不能属于两个空间。');
    }
    byProject.set(record.projectId, record.spaceId);
  }
  return {
    async spaceForProject(projectId: string): Promise<ProjectSpaceLookup> {
      if (!validId(projectId)) return { ok: false, reason: 'unknown' };
      const spaceId = byProject.get(projectId);
      if (spaceId === undefined) return { ok: false, reason: 'unknown' };
      return { ok: true, spaceId };
    },
  };
}

/** Compare a directory answer with the member's spaces. A project id is never tried as a space id. */
export function decideProjectSpace(
  lookup: ProjectSpaceLookup | null | undefined,
  memberSpaceIds: readonly string[],
): ProjectSpaceDecision {
  if (lookup == null || typeof lookup !== 'object' || !Array.isArray(memberSpaceIds)) {
    return 'unavailable';
  }
  if (!lookup.ok) return lookup.reason === 'unknown' ? 'hidden' : 'unavailable';
  if (!validId(lookup.spaceId)) return 'unavailable';
  return memberSpaceIds.includes(lookup.spaceId) ? 'ok' : 'hidden';
}
