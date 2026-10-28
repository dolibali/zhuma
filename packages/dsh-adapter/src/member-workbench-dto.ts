import { z } from 'zod';
import {
  PlanRequestSchema,
  ProjectSchema,
  WorkTaskSchema,
  type Participant,
  type PlanProposal,
  type TeamAsset,
  type Workbench,
} from '@zhuma/agent-core';
import type { AuthorizedSpace, SpaceDirectory, SpaceDirectoryWriter } from './space-directory.js';
import type { MemberResolution } from './member-session.js';
import type { PlanningModel } from './workbench-service.js';
import type { MemberWorkbenchOperations } from './member-workbench-operation.js';

const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/u);
export const MemberWorkbenchScopeSchema = z.strictObject({ spaceId: id });
// The server owns status, timestamps and fixed template provenance.
export const MemberTaskInputSchema = WorkTaskSchema.omit({
  status: true,
  updatedAt: true,
  templateSource: true,
});
export const MemberWorkbenchCommandSchema = z.strictObject({
  spaceId: id,
  requestId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  command: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('create-project'), project: ProjectSchema }),
    z.strictObject({ type: z.literal('update-project'), project: ProjectSchema }),
    z.strictObject({ type: z.literal('create-task'), task: MemberTaskInputSchema }),
    z.strictObject({ type: z.literal('update-task'), task: MemberTaskInputSchema }),
    z.strictObject({ type: z.literal('confirm-task'), taskId: id }),
    z.strictObject({
      type: z.literal('instantiate-template'),
      input: z.strictObject({
        templateId: id,
        sourceSpaceId: id.optional(),
        task: MemberTaskInputSchema.omit({ workflows: true }).extend({ id: z.uuid() }),
        roleBindings: z.record(id, id.nullable()),
        resourceBindings: z.record(id, id.nullable()),
      }),
    }),
    z.strictObject({
      type: z.literal('save-template'),
      input: z.strictObject({
        templateId: z.uuid(),
        sourceTaskId: id,
        sourceSpaceId: id.optional(),
        name: z.string().trim().min(1).max(160),
        description: z.string().max(8000),
      }),
    }),
  ]),
});
export const MemberWorkbenchPlanSchema = PlanRequestSchema.extend({ spaceId: id }).strict();
export type MemberWorkbenchCommand = z.infer<typeof MemberWorkbenchCommandSchema>;
export type MemberWorkbenchPlan = z.infer<typeof MemberWorkbenchPlanSchema>;

/** Trusted Host injection. No browser fields can supply this directory or resource grant. */
export interface MemberWorkbenchDirectory extends SpaceDirectory {
  membersForSpace(spaceId: string): readonly { readonly id: string; readonly name?: string }[];
  /** The same live directory's managed personal owner; absence never infers ownership. */
  administratorForSpace?(spaceId: string): string | undefined;
}
export interface MemberWorkbenchCatalog {
  readonly experts: readonly Participant[];
  readonly assets: readonly TeamAsset[];
}
export interface MemberWorkbenchOptions {
  readonly directory: () => MemberWorkbenchDirectory | undefined;
  readonly writer: () => Pick<SpaceDirectoryWriter, 'assignProjectSpace'> | undefined;
  /** Re-resolves the live session at asynchronous authorization/commit boundaries. */
  readonly resolve: () => Promise<MemberResolution>;
  /** Absent means no authorized experts/assets; never fall back to the global legacy catalog. */
  readonly catalog?: (spaceId: string) => Promise<MemberWorkbenchCatalog>;
  readonly model?: () => PlanningModel | undefined;
  readonly now?: () => string;
  readonly operations?: MemberWorkbenchOperations;
}
export interface MemberWorkbenchSnapshot {
  readonly actorId: string;
  readonly spaceId: string;
  readonly space: AuthorizedSpace;
  /** Filtered projection, not a second store. Receipts are deliberately empty. */
  readonly state: Workbench;
  readonly model: string | null;
  readonly capabilities: {
    readonly createProject: boolean;
    readonly createTask: boolean;
    readonly planning: boolean;
    readonly resources: 'not-connected' | 'authorized';
    readonly tasks: readonly {
      readonly taskId: string;
      readonly edit: boolean;
      readonly confirm: boolean;
      readonly plan: boolean;
    }[];
  };
}
export interface MemberWorkbenchPlanValue {
  readonly actorId: string;
  readonly spaceId: string;
  readonly proposal: PlanProposal;
}
export type MemberWorkbenchResult<T = MemberWorkbenchSnapshot | MemberWorkbenchPlanValue> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
