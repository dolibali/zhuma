import { ExecutionError, readArtifactFileReference } from '../execution/ExecutionApi.js';
import type {
  ProjectArtifactsApi,
  ProjectArtifactsList,
  ProjectArtifactContent,
  ProjectArtifactCursor,
  ProjectArtifactRef,
} from './project-artifacts-contract.js';

function invalid(): never {
  throw new ExecutionError('validation', '项目成果与当前版本不一致，请刷新后重试。');
}
function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : invalid();
}
function text(raw: unknown, max = 200): string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= max ? raw : invalid();
}
function number(raw: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min && raw <= max
    ? raw
    : invalid();
}
function array(raw: unknown, max: number): unknown[] {
  return Array.isArray(raw) && raw.length <= max ? raw : invalid();
}
function ref(raw: unknown, spaceId: string, projectId: string): ProjectArtifactRef {
  const value = object(raw);
  if (value.spaceId !== spaceId || value.projectId !== projectId) invalid();
  return {
    spaceId,
    projectId,
    taskId: text(value.taskId),
    planId: text(value.planId),
    revision: number(value.revision, 1),
    nodeId: text(value.nodeId),
    artifactVersionId: text(value.artifactVersionId, 1000),
  };
}
function cursor(raw: unknown): ProjectArtifactCursor {
  const value = object(raw),
    selection = text(value.selection, 64);
  if (!/^[a-f0-9]{64}$/u.test(selection)) invalid();
  return {
    selection,
    taskId: text(value.taskId),
    planId: text(value.planId),
    revision: number(value.revision, 1),
    offset: number(value.offset, 0, 2400),
  };
}
function sameRef(a: ProjectArtifactRef, b: ProjectArtifactRef) {
  return (
    a.spaceId === b.spaceId &&
    a.projectId === b.projectId &&
    a.taskId === b.taskId &&
    a.planId === b.planId &&
    a.revision === b.revision &&
    a.nodeId === b.nodeId &&
    a.artifactVersionId === b.artifactVersionId
  );
}
/** Only the original member transport supplies this caller. Cursor and exact
 * version refs remain read locators; the Host rechecks live project authority. */
export function createProjectArtifactsApi(
  call: (query: object, signal: AbortSignal) => Promise<unknown>,
  spaceId: string,
): ProjectArtifactsApi {
  return {
    async list(query, signal): Promise<ProjectArtifactsList> {
      if (query.spaceId !== spaceId) invalid();
      const projectId = text(query.projectId),
        limit = query.limit === undefined ? 20 : number(query.limit, 1, 20);
      const value = object(
        await call(
          {
            view: 'list',
            spaceId,
            projectId,
            limit,
            ...(query.cursor ? { cursor: cursor(query.cursor) } : {}),
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (
        value.view !== 'list' ||
        value.spaceId !== spaceId ||
        value.projectId !== projectId ||
        value.coverage !== 'latest-confirmed-plans'
      )
        invalid();
      const items = array(value.items, limit).map((raw) => {
        const item = object(raw);
        if (typeof item.hasText !== 'boolean') invalid();
        return {
          ref: ref(item.ref, spaceId, projectId),
          version: number(item.version, 1),
          taskTitle: text(item.taskTitle, 160),
          nodeTitle: text(item.nodeTitle, 8400),
          nodeStatus: text(item.nodeStatus, 100),
          submittedBy: text(item.submittedBy),
          hasText: item.hasText,
          linkCount: number(item.linkCount, 0, 20),
          fileCount: number(item.fileCount, 0, 20),
        };
      });
      if (new Set(items.map((item) => JSON.stringify(item.ref))).size !== items.length) invalid();
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) invalid();
      return {
        view: 'list',
        spaceId,
        projectId,
        coverage: 'latest-confirmed-plans',
        items,
        ...(value.nextCursor === undefined ? {} : { nextCursor: cursor(value.nextCursor) }),
      };
    },
    async content(query, signal): Promise<ProjectArtifactContent> {
      const expected = ref(query, spaceId, text(object(query).projectId));
      const value = object(await call({ view: 'content', ref: expected }, signal));
      signal.throwIfAborted();
      const received = ref(value.ref, spaceId, expected.projectId),
        content = object(value.content);
      if (value.view !== 'content' || !sameRef(received, expected)) invalid();
      if (
        content.text !== undefined &&
        (typeof content.text !== 'string' || content.text.length > 100000)
      )
        invalid();
      const links = array(content.links, 20).map((item) => text(item, 2048));
      const files = array(content.files, 20).map(readArtifactFileReference);
      if (
        files.some((file) => file.accessPolicyId !== `space:${spaceId}`) ||
        new Set(files.map((file) => file.id)).size !== files.length
      )
        invalid();
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) invalid();
      return {
        view: 'content',
        ref: received,
        version: number(value.version, 1),
        content: {
          ...(typeof content.text === 'string' ? { text: content.text } : {}),
          links,
          files,
        },
      };
    },
  };
}
