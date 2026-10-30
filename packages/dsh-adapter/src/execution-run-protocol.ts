import { z } from 'zod';
import {
  remoteBackendRegistrySchema,
  type RemoteBackendRegistry,
} from './remote-run-authority-state.js';

/** Existing v1 globals remain readable. Once native writers are installed, an explicit
 * durable marker makes the old Host's strict {schemaVersion:1} schema reject reopening.
 * This uses the existing execution global, not a second Run store or a JSON-file edit.
 */
export const executionRunGlobalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    nativeExecutionWriter: z.literal(1).optional(),
    nativeReviewWriter: z.literal(1).optional(),
    workspaceApprovalWriter: z.literal(1).optional(),
    remoteExecutionWriter: z.literal(1).optional(),
    remoteExecutionFileWriter: z.literal(1).optional(),
    remoteExecutionAcceptedFileWriter: z.literal(1).optional(),
    remoteExecutionReviewWriter: z.literal(1).optional(),
    remoteExecutionKnowledgeWriter: z.literal(1).optional(),
    remoteExecutionTeamAssetWriter: z.literal(1).optional(),
    remoteWorkflowWriter: z.literal(1).optional(),
    remoteExecution: remoteBackendRegistrySchema.optional(),
  })
  .refine((value) => value.nativeReviewWriter !== 1 || value.nativeExecutionWriter === 1)
  .refine((value) => value.workspaceApprovalWriter !== 1 || value.nativeExecutionWriter === 1)
  .refine((value) => (value.remoteExecutionWriter === 1) === (value.remoteExecution !== undefined))
  .refine((value) => value.remoteExecutionFileWriter !== 1 || value.remoteExecutionWriter === 1)
  .refine(
    (value) => value.remoteExecutionKnowledgeWriter !== 1 || value.remoteExecutionWriter === 1,
  )
  .refine(
    (value) => value.remoteExecutionTeamAssetWriter !== 1 || value.remoteExecutionWriter === 1,
  )
  .refine(
    (value) => value.remoteExecutionAcceptedFileWriter !== 1 || value.remoteExecutionWriter === 1,
  )
  .refine(
    (value) =>
      value.remoteExecutionReviewWriter !== 1 ||
      (value.remoteExecutionWriter === 1 && value.nativeReviewWriter === 1),
  )
  .refine((value) => value.remoteExecutionWriter !== 1 || value.nativeExecutionWriter === 1)
  .refine((value) => value.remoteWorkflowWriter !== 1 || value.remoteExecutionWriter === 1);

export type ExecutionWriterGlobal = {
  schemaVersion: 1;
  nativeExecutionWriter: 1;
  nativeReviewWriter?: 1;
  workspaceApprovalWriter?: 1;
  remoteExecutionWriter?: 1;
  remoteExecutionFileWriter?: 1;
  remoteExecutionAcceptedFileWriter?: 1;
  remoteExecutionReviewWriter?: 1;
  remoteExecutionKnowledgeWriter?: 1;
  remoteExecutionTeamAssetWriter?: 1;
  remoteWorkflowWriter?: 1;
  remoteExecution?: RemoteBackendRegistry;
};

export class ExecutionRunProtocolError extends Error {
  constructor(readonly code: 'run-writer-unavailable' | 'run-writer-incompatible') {
    super('当前执行存储不能用于本地运行。');
    this.name = 'ExecutionRunProtocolError';
  }
}
export function requireExecutionRunWriter(global: unknown): void {
  const parsed = executionRunGlobalSchema.safeParse(global);
  if (!parsed.success) throw new ExecutionRunProtocolError('run-writer-incompatible');
  if (parsed.data.nativeExecutionWriter !== 1)
    throw new ExecutionRunProtocolError('run-writer-unavailable');
}
/** B performs this explicit one-time global write only AFTER every old node write path
 * uses the shared native-aware queue/guards and BEFORE admitting the first native begin.
 * Repeating it returns the same value; it never changes nodes, plans or their receipts.
 */
export function prepareExecutionRunWriter(global: unknown): ExecutionWriterGlobal {
  const parsed = executionRunGlobalSchema.safeParse(global);
  if (!parsed.success) throw new ExecutionRunProtocolError('run-writer-incompatible');
  return {
    schemaVersion: 1,
    nativeExecutionWriter: 1,
    ...(parsed.data.nativeReviewWriter === 1 ? { nativeReviewWriter: 1 } : {}),
    ...(parsed.data.remoteWorkflowWriter === 1 ? { remoteWorkflowWriter: 1 } : {}),
    ...(parsed.data.remoteExecutionReviewWriter === 1 ? { remoteExecutionReviewWriter: 1 } : {}),
    ...(parsed.data.remoteExecutionKnowledgeWriter === 1
      ? { remoteExecutionKnowledgeWriter: 1 }
      : {}),
    ...(parsed.data.remoteExecutionTeamAssetWriter === 1
      ? { remoteExecutionTeamAssetWriter: 1 }
      : {}),
    ...(parsed.data.workspaceApprovalWriter === 1 ? { workspaceApprovalWriter: 1 } : {}),
    ...(parsed.data.remoteExecutionFileWriter === 1 ? { remoteExecutionFileWriter: 1 } : {}),
    ...(parsed.data.remoteExecutionAcceptedFileWriter === 1
      ? { remoteExecutionAcceptedFileWriter: 1 }
      : {}),
    ...(parsed.data.remoteExecutionWriter === 1
      ? { remoteExecutionWriter: 1, remoteExecution: parsed.data.remoteExecution! }
      : {}),
  };
}

/** Same execution global; the old native-aware Host's strict schema also rejects it. */
export function requireExecutionReviewWriter(global: unknown): void {
  requireExecutionRunWriter(global);
  if (executionRunGlobalSchema.parse(global).nativeReviewWriter !== 1)
    throw new ExecutionRunProtocolError('run-writer-unavailable');
}
export function prepareExecutionReviewWriter(global: unknown): ExecutionWriterGlobal {
  return { ...prepareExecutionRunWriter(global), nativeReviewWriter: 1 };
}
export function requireWorkspaceApprovalWriter(global: unknown): void {
  requireExecutionRunWriter(global);
  if (executionRunGlobalSchema.parse(global).workspaceApprovalWriter !== 1)
    throw new ExecutionRunProtocolError('run-writer-unavailable');
}
export async function enableWorkspaceApprovalWriter(
  readGlobal: () => unknown,
  writeGlobal: (next: ExecutionWriterGlobal) => Promise<void>,
  nodes: readonly object[],
): Promise<void> {
  const global = readGlobal();
  assertExecutionRunStoreCompatibility(global, nodes);
  if (executionRunGlobalSchema.parse(global).workspaceApprovalWriter === 1) return;
  try {
    await writeGlobal({ ...prepareExecutionRunWriter(global), workspaceApprovalWriter: 1 });
  } catch {
    throw new ExecutionRunProtocolError('run-writer-unavailable');
  }
  requireWorkspaceApprovalWriter(readGlobal());
}
/** Startup must not silently adopt native rows which lack their compatibility barrier. */
export function assertExecutionRunStoreCompatibility(
  global: unknown,
  nodes: readonly object[],
): void {
  if (!executionRunGlobalSchema.safeParse(global).success)
    throw new ExecutionRunProtocolError('run-writer-incompatible');
  const parsed = executionRunGlobalSchema.parse(global);
  const registry = parsed.remoteExecution;
  for (const node of nodes) {
    const raw = (
      node as {
        nativeExecution?: {
          runs?: {
            remote?: {
              backendId?: unknown;
              files?: unknown;
              acceptedFiles?: unknown;
              knowledge?: unknown;
              teamAssets?: unknown;
              workflow?: unknown;
            };
            composition?: {
              payload?: { knowledgeTool?: unknown; teamAssetTool?: unknown; teamAssets?: unknown };
            };
          }[];
        };
      }
    ).nativeExecution;
    if (
      raw?.runs?.some((run) => run.remote?.workflow !== undefined) &&
      parsed.remoteWorkflowWriter !== 1
    )
      throw new ExecutionRunProtocolError('run-writer-incompatible');
    const review = (
      node as {
        nativeExecution?: {
          review?: { attempts?: { remote?: { backendId?: unknown; workflow?: unknown } }[] };
        };
      }
    ).nativeExecution?.review;
    if (
      review?.attempts?.some((attempt) => attempt.remote?.workflow !== undefined) &&
      parsed.remoteWorkflowWriter !== 1
    )
      throw new ExecutionRunProtocolError('run-writer-incompatible');
    if (
      Array.isArray(review?.attempts) &&
      review.attempts.some(
        (attempt) =>
          Object.hasOwn(attempt, 'remote') &&
          (!registry ||
            parsed.remoteExecutionReviewWriter !== 1 ||
            attempt.remote?.backendId !== registry.backendId),
      )
    )
      throw new ExecutionRunProtocolError('run-writer-incompatible');
    if (
      Array.isArray(raw?.runs) &&
      raw.runs.some(
        (run) =>
          ((run.composition?.payload?.knowledgeTool !== undefined ||
            run.remote?.knowledge !== undefined) &&
            (parsed.remoteExecutionKnowledgeWriter !== 1 ||
              run.remote?.knowledge !== 'zhuma-native-knowledge@1' ||
              run.composition?.payload?.knowledgeTool === undefined)) ||
          ((run.composition?.payload?.teamAssetTool !== undefined ||
            run.composition?.payload?.teamAssets !== undefined ||
            run.remote?.teamAssets !== undefined) &&
            (parsed.remoteExecutionTeamAssetWriter !== 1 ||
              run.remote?.teamAssets !== 'zhuma-native-team-assets@1' ||
              !run.composition?.payload?.teamAssetTool ||
              !run.composition?.payload?.teamAssets)) ||
          (Object.hasOwn(run, 'remote') &&
            (!registry ||
              run.remote?.backendId !== registry.backendId ||
              (run.remote?.files !== undefined &&
                (parsed.remoteExecutionFileWriter !== 1 ||
                  run.remote.files !== 'zhuma-native-output-file@1')) ||
              (run.remote?.acceptedFiles !== undefined &&
                (parsed.remoteExecutionAcceptedFileWriter !== 1 ||
                  run.remote.acceptedFiles !== 'zhuma-accepted-files@2')))),
      )
    )
      throw new ExecutionRunProtocolError('run-writer-incompatible');
  }
  if (nodes.some((node) => Object.hasOwn(node, 'nativeExecution')))
    requireExecutionRunWriter(global);
  if (
    nodes.some((node) => {
      const raw = (node as { nativeExecution?: unknown }).nativeExecution;
      return raw && typeof raw === 'object' && Object.hasOwn(raw, 'review');
    })
  )
    requireExecutionReviewWriter(global);
}

/** Explicit B queue hook; never called by reads/projection or authority construction.
 * The current reader must observe the durable write before native admission is possible.
 */
export async function enableExecutionRunWriter(
  readGlobal: () => unknown,
  writeGlobal: (next: ExecutionWriterGlobal) => Promise<void>,
  nodes: readonly object[],
): Promise<void> {
  const global = readGlobal();
  assertExecutionRunStoreCompatibility(global, nodes);
  if (executionRunGlobalSchema.parse(global).nativeExecutionWriter === 1) return;
  try {
    await writeGlobal(prepareExecutionRunWriter(global));
  } catch {
    throw new ExecutionRunProtocolError('run-writer-unavailable');
  }
  requireExecutionRunWriter(readGlobal());
}

/** Only the original queued write path calls this, after validating preparation.
 * Re-read the actual durable global before allowing even the first v2 node put. */
export async function enableExecutionReviewWriter(
  readGlobal: () => unknown,
  writeGlobal: (next: ExecutionWriterGlobal) => Promise<void>,
  nodes: readonly object[],
): Promise<void> {
  const global = readGlobal();
  assertExecutionRunStoreCompatibility(global, nodes);
  if (executionRunGlobalSchema.parse(global).nativeReviewWriter === 1) return;
  try {
    await writeGlobal(prepareExecutionReviewWriter(global));
  } catch {
    throw new ExecutionRunProtocolError('run-writer-unavailable');
  }
  requireExecutionReviewWriter(readGlobal());
}
