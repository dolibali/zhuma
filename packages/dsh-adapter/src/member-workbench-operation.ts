import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { WorkbenchError } from '@zhuma/agent-core';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
// Existing v1 records remain readable. An unpinned legacy operation cannot be resumed.
const StoredIntentSchema = z.strictObject({
  actorId: id,
  spaceId: id,
  requestId: z.uuid(),
  objectId: id,
  commandType: z.enum([
    'create-project',
    'update-project',
    'create-task',
    'update-task',
    'confirm-task',
    'instantiate-template',
    'save-template',
  ]),
  expectedRevision: z.number().int().nonnegative(),
  fingerprint: digest,
  contextFingerprint: digest.optional(),
  templatePriorFingerprint: digest.nullable().optional(),
  templateResultFingerprint: digest.optional(),
});
export const MemberWorkbenchIntentSchema = StoredIntentSchema.required({
  contextFingerprint: true,
}).superRefine((intent, context) => {
  if (
    intent.commandType === 'save-template' &&
    (intent.templatePriorFingerprint === undefined || !intent.templateResultFingerprint)
  )
    context.addIssue({
      code: 'custom',
      message: 'Template operation requires fixed before/result hashes.',
    });
});
export type MemberWorkbenchIntent = z.infer<typeof MemberWorkbenchIntentSchema>;
export const MemberWorkbenchOperationSchema = z.discriminatedUnion('state', [
  StoredIntentSchema.extend({ state: z.literal('pending') }),
  StoredIntentSchema.extend({
    state: z.literal('completed'),
    resultRevision: z.number().int().positive(),
  }),
]);
export type MemberWorkbenchOperation = z.infer<typeof MemberWorkbenchOperationSchema>;
export const MEMBER_WORKBENCH_OPERATION_LIMIT = 400;
export const MEMBER_WORKBENCH_COMPLETED_RETENTION = 200;

export const memberWorkbenchOperationDomainSpec = defineDomain({
  name: 'zhuma_member_operations',
  version: 1,
  tables: { intents: { valueSchema: MemberWorkbenchOperationSchema } },
});
type OperationDomain = Domain<typeof memberWorkbenchOperationDomainSpec>;
export interface MemberWorkbenchOperationStorage {
  get(key: string): MemberWorkbenchOperation | undefined;
  values(): readonly MemberWorkbenchOperation[];
  put(key: string, value: MemberWorkbenchOperation): Promise<void>;
  delete(key: string): Promise<void>;
}
export function memberWorkbenchOperationKey(
  intent: Pick<MemberWorkbenchIntent, 'actorId' | 'spaceId' | 'requestId'>,
): string {
  return `member-${createHash('sha256')
    .update(JSON.stringify([intent.actorId, intent.spaceId, intent.requestId]))
    .digest('hex')}`;
}

/** Only recovery metadata. No request body, Workbench copy, automatic replay or authorization grant. */
export class MemberWorkbenchOperations {
  constructor(private readonly storage: MemberWorkbenchOperationStorage) {}

  /** Same original journal only: hashes prove this request's own atomic asset result. */
  templatePins(
    input: Pick<MemberWorkbenchIntent, 'actorId' | 'spaceId' | 'requestId' | 'fingerprint'>,
  ):
    | Pick<MemberWorkbenchIntent, 'templatePriorFingerprint' | 'templateResultFingerprint'>
    | undefined {
    const raw = this.storage.get(memberWorkbenchOperationKey(input));
    if (!raw) return undefined;
    const previous = MemberWorkbenchOperationSchema.parse(raw);
    if (
      previous.commandType !== 'save-template' ||
      previous.fingerprint !== input.fingerprint ||
      previous.actorId !== input.actorId ||
      previous.spaceId !== input.spaceId ||
      previous.requestId !== input.requestId
    )
      throw new WorkbenchError('request-reused', '请求标识已用于另一个操作。');
    if (previous.templatePriorFingerprint === undefined || !previous.templateResultFingerprint)
      throw new WorkbenchError('operation-unresolved', '原模板操作缺少固定结果，需要核实。');
    return {
      templatePriorFingerprint: previous.templatePriorFingerprint,
      templateResultFingerprint: previous.templateResultFingerprint,
    };
  }

  inspect(raw: MemberWorkbenchIntent): MemberWorkbenchOperation | undefined {
    const intent = MemberWorkbenchIntentSchema.parse(raw);
    const previous = this.storage.get(memberWorkbenchOperationKey(intent));
    if (!previous) return undefined;
    const {
      state: _state,
      contextFingerprint,
      ...fields
    } = MemberWorkbenchOperationSchema.parse(previous);
    const { resultRevision: _revision, ...original } = fields as MemberWorkbenchIntent & {
      resultRevision?: number;
    };
    const { contextFingerprint: requestedContext, ...requested } = intent;
    if (JSON.stringify(original) !== JSON.stringify(requested))
      throw new WorkbenchError('request-reused', '请求标识已用于另一个操作。');
    if (!contextFingerprint)
      throw new WorkbenchError(
        'operation-unresolved',
        '原操作没有固定授权定义，需要核实后再处理。',
      );
    if (contextFingerprint !== requestedContext)
      throw new WorkbenchError(
        'context-changed',
        '授权定义已变化，请核对原操作，不能采用最新版本重试。',
      );
    return structuredClone(previous);
  }

  /** Called only within the shared Workbench writer queue, after authorization and full dry-run validation. */
  async begin(intent: MemberWorkbenchIntent): Promise<void> {
    if (this.inspect(intent)) return;
    const createsTask = (type: MemberWorkbenchIntent['commandType']) =>
      type === 'create-task' || type === 'instantiate-template';
    const reserved = this.storage
      .values()
      .find(
        (record) =>
          record.state === 'pending' &&
          record.objectId === intent.objectId &&
          ((record.commandType === 'create-project' && intent.commandType === 'create-project') ||
            (record.commandType === 'save-template' && intent.commandType === 'save-template') ||
            (createsTask(record.commandType) && createsTask(intent.commandType))),
      );
    if (reserved)
      throw new WorkbenchError(
        reserved.spaceId === intent.spaceId ? 'conflict' : 'not-found',
        '对象不可用。',
      );
    await this.trimCompleted();
    if (this.storage.values().length >= MEMBER_WORKBENCH_OPERATION_LIMIT)
      throw new WorkbenchError('operation-limit', '未收口的操作过多，请先恢复原操作。');
    await this.storage.put(memberWorkbenchOperationKey(intent), {
      ...MemberWorkbenchIntentSchema.parse(intent),
      state: 'pending',
    });
  }

  async complete(intent: MemberWorkbenchIntent, resultRevision: number): Promise<void> {
    if (resultRevision !== intent.expectedRevision + 1)
      throw new WorkbenchError('operation-unresolved', '操作结果需要核实，不能重复执行。');
    const previous = this.inspect(intent);
    if (!previous || (previous.state === 'completed' && previous.resultRevision !== resultRevision))
      throw new WorkbenchError('operation-unresolved', '操作结果需要核实，不能重复执行。');
    if (previous.state === 'pending')
      await this.storage.put(
        memberWorkbenchOperationKey(intent),
        MemberWorkbenchOperationSchema.parse({ ...intent, state: 'completed', resultRevision }),
      );
    await this.trimCompleted();
  }

  private async trimCompleted(): Promise<void> {
    // Pending intents are never removed, including after the ordinary Workbench receipt falls out.
    const completed = this.storage
      .values()
      .filter((record) => record.state === 'completed')
      .sort(
        (a, b) =>
          a.resultRevision - b.resultRevision ||
          memberWorkbenchOperationKey(a).localeCompare(memberWorkbenchOperationKey(b)),
      );
    for (const old of completed.slice(
      0,
      Math.max(0, completed.length - MEMBER_WORKBENCH_COMPLETED_RETENTION),
    ))
      await this.storage.delete(memberWorkbenchOperationKey(old));
  }
}

interface StorageDomainSeam {
  open(spec: typeof memberWorkbenchOperationDomainSpec): Promise<OperationDomain>;
}
/** A opens once with the other domains and owns close/disposal; opening never replays pending work. */
export async function openMemberWorkbenchOperations(
  storageDomain: StorageDomainSeam,
): Promise<{ journal: MemberWorkbenchOperations; close(): Promise<void> }> {
  const domain = await storageDomain.open(memberWorkbenchOperationDomainSpec);
  const table = domain.table('intents');
  return {
    journal: new MemberWorkbenchOperations({
      get: (key) => table.get(key),
      values: () => [...table.entries()].map(([, value]) => value),
      put: (key, value) => table.put(key, value),
      delete: async (key) => {
        await table.delete(key);
      },
    }),
    close: () => domain.close(),
  };
}
