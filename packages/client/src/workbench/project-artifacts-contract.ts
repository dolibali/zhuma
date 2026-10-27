import type { ArtifactFileRef } from '@zhuma/agent-core';

/** Public fields match the frozen #211 projection; none of these are grants. */
export interface ProjectArtifactRef {
  readonly spaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly nodeId: string;
  readonly artifactVersionId: string;
}
export interface ProjectArtifactCursor {
  readonly selection: string;
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
  readonly offset: number;
}
export interface ProjectArtifactSummary {
  readonly ref: ProjectArtifactRef;
  readonly version: number;
  readonly taskTitle: string;
  readonly nodeTitle: string;
  readonly nodeStatus: string;
  readonly submittedBy: string;
  readonly hasText: boolean;
  readonly linkCount: number;
  readonly fileCount: number;
}
export interface ProjectArtifactsList {
  readonly view: 'list';
  readonly spaceId: string;
  readonly projectId: string;
  readonly coverage: 'latest-confirmed-plans';
  readonly items: readonly ProjectArtifactSummary[];
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
/** A supplies the original member/space transport and a NEW identity whenever
 * its actor generation changes. This leaf neither resolves nor supplies actor. */
export interface ProjectArtifactsApi {
  list(
    query: {
      readonly spaceId: string;
      readonly projectId: string;
      readonly limit?: number;
      readonly cursor?: ProjectArtifactCursor;
    },
    signal: AbortSignal,
  ): Promise<ProjectArtifactsList>;
  content(ref: ProjectArtifactRef, signal: AbortSignal): Promise<ProjectArtifactContent>;
}
