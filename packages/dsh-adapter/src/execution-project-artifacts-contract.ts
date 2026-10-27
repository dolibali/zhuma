import { z } from 'zod';
import { WorkTaskSchema, type ArtifactFileRef } from '@zhuma/agent-core';

export const PROJECT_ARTIFACT_LIMITS = Object.freeze({
  pageSize: 20,
  scannedNodes: 200,
  listBytes: 128 * 1024,
  contentBytes: 1024 * 1024,
  textCharacters: 100_000,
  requestBytes: 8192,
});
const id = WorkTaskSchema.shape.id;
const natural = z.number().int().nonnegative().refine(Number.isSafeInteger);
const versionId = z.string().min(1).max(1000);
export const projectArtifactRefSchema = z.strictObject({
  spaceId: id,
  projectId: id,
  taskId: id,
  planId: id,
  revision: natural.positive(),
  nodeId: id,
  artifactVersionId: versionId,
});
export type ProjectArtifactRef = z.infer<typeof projectArtifactRefSchema>;
export const projectArtifactCursorSchema = z.strictObject({
  selection: z.string().regex(/^[a-f0-9]{64}$/u),
  taskId: id,
  planId: id,
  revision: natural.positive(),
  offset: natural.max(2400),
});
export type ProjectArtifactCursor = z.infer<typeof projectArtifactCursorSchema>;
export const projectArtifactsQuerySchema = z
  .discriminatedUnion('view', [
    z.strictObject({
      view: z.literal('list'),
      spaceId: id,
      projectId: id,
      limit: natural.positive().max(PROJECT_ARTIFACT_LIMITS.pageSize).default(20),
      cursor: projectArtifactCursorSchema.optional(),
    }),
    z.strictObject({ view: z.literal('content'), ref: projectArtifactRefSchema }),
  ])
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= PROJECT_ARTIFACT_LIMITS.requestBytes,
  );
export type ProjectArtifactsQuery = z.infer<typeof projectArtifactsQuerySchema>;
/** Caller input; list.limit defaults to 20 in the parsed Query. */
export type ProjectArtifactsRequest = z.input<typeof projectArtifactsQuerySchema>;
export interface ProjectArtifactSummary {
  readonly ref: ProjectArtifactRef;
  readonly version: number;
  readonly taskTitle: string;
  readonly nodeTitle: string;
  readonly nodeStatus: string;
  readonly submittedBy: string;
  /** List reads never scan, copy or encode the stored body. */
  readonly hasText: boolean;
  readonly linkCount: number;
  readonly fileCount: number;
}
export interface ProjectArtifactsList {
  readonly view: 'list';
  readonly spaceId: string;
  readonly projectId: string;
  /** Explicit first-release coverage; old plans never masquerade as current. */
  readonly coverage: 'latest-confirmed-plans';
  readonly items: readonly ProjectArtifactSummary[];
  /** A position hint, never a read grant or a cross-page snapshot promise. */
  readonly nextCursor?: ProjectArtifactCursor;
}
export interface ProjectArtifactContent {
  readonly view: 'content';
  readonly ref: ProjectArtifactRef;
  readonly version: number;
  readonly content: {
    readonly text?: string;
    readonly links: readonly string[];
    readonly files: readonly ArtifactFileRef[];
  };
}
export type ProjectArtifactsValue = ProjectArtifactsList | ProjectArtifactContent;
