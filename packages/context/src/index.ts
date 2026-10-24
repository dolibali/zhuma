import type { TaskSnapshot } from '@zhuma/agent-core';

export type EvidenceConfidence = 'tool-verified' | 'user-confirmed' | 'inferred';

export interface ContextEvidence {
  readonly id: string;
  readonly source: 'code' | 'api' | 'document' | 'schema';
  readonly locator: string;
  readonly revision: string;
  readonly confidence: EvidenceConfidence;
  readonly summary: string;
}

export interface ContextPack {
  readonly taskId: string;
  readonly planRevision: number;
  readonly evidence: readonly ContextEvidence[];
}

/** Snapshot supplied evidence; never upgrades inferred information into verified facts. */
export function createContextPack(
  task: Pick<TaskSnapshot, 'id' | 'planRevision'>,
  evidence: readonly ContextEvidence[],
): ContextPack {
  const seen = new Set<string>();
  const snapshot = evidence.map((item) => {
    if (seen.has(item.id)) throw new Error(`Duplicate evidence id: ${item.id}`);
    seen.add(item.id);
    return Object.freeze({ ...item });
  });
  return Object.freeze({
    taskId: task.id,
    planRevision: task.planRevision,
    evidence: Object.freeze(snapshot),
  });
}

export type {
  ContextItemKind,
  ContextBlockReason,
  ContextFileProbe,
  ContextSourceInput,
  ContextCitation,
  ContextBlock,
  RunContextManifest,
  WorkspaceClaim,
} from './run-context.js';
export {
  CONTEXT_ITEM_KINDS,
  assembleRunContext,
  isolateWorkspaceId,
  claimWritableWorkspace,
  releaseWritableWorkspace,
} from './run-context.js';
