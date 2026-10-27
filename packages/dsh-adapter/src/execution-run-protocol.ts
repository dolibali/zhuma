import { z } from 'zod';

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
  })
  .refine((value) => value.nativeReviewWriter !== 1 || value.nativeExecutionWriter === 1)
  .refine((value) => value.workspaceApprovalWriter !== 1 || value.nativeExecutionWriter === 1);

export type ExecutionWriterGlobal = {
  schemaVersion: 1;
  nativeExecutionWriter: 1;
  nativeReviewWriter?: 1;
  workspaceApprovalWriter?: 1;
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
    ...(parsed.data.workspaceApprovalWriter === 1 ? { workspaceApprovalWriter: 1 } : {}),
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
