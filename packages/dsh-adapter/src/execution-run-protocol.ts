import { z } from 'zod';

/** Existing v1 globals remain readable. Once native writers are installed, an explicit
 * durable marker makes the old Host's strict {schemaVersion:1} schema reject reopening.
 * This uses the existing execution global, not a second Run store or a JSON-file edit.
 */
export const executionRunGlobalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nativeExecutionWriter: z.literal(1).optional(),
});

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
export function prepareExecutionRunWriter(global: unknown): {
  schemaVersion: 1;
  nativeExecutionWriter: 1;
} {
  const parsed = executionRunGlobalSchema.safeParse(global);
  if (!parsed.success) throw new ExecutionRunProtocolError('run-writer-incompatible');
  return { schemaVersion: 1, nativeExecutionWriter: 1 };
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
}

/** Explicit B queue hook; never called by reads/projection or authority construction.
 * The current reader must observe the durable write before native admission is possible.
 */
export async function enableExecutionRunWriter(
  readGlobal: () => unknown,
  writeGlobal: (next: { schemaVersion: 1; nativeExecutionWriter: 1 }) => Promise<void>,
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
