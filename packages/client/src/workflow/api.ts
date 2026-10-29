import { ExecutionError } from '../execution/ExecutionApi.js';
import { workspacePublishRanges, type WorkspacePublishRange } from '../run/workspace-approvals.js';
import type {
  NativeRunModel,
  NativeRunModelChoice,
  NativeRunWorkspaceChoice,
} from '../run/native-run-contract.js';

export type WorkflowTarget = {
  readonly taskId: string;
  readonly planId: string;
  readonly revision: number;
};
export type WorkflowLocation = WorkflowTarget & { readonly spaceId: string };
export type WorkflowWorkspace =
  | { readonly kind: 'text-only' }
  | {
      readonly kind: 'local';
      readonly id: string;
      readonly publish?: readonly WorkspacePublishRange[];
    };
export interface WorkflowView {
  readonly target: WorkflowLocation;
  readonly title: string;
  readonly state:
    'inactive' | 'running' | 'waiting' | 'stopping' | 'paused' | 'completed' | 'requires-resume';
  readonly planStarted: boolean;
  readonly requiresResume: boolean;
  readonly activeRunCount: number;
  readonly expertNodeCount: number;
  readonly controlledNodeCount?: number;
  readonly controlledReviewNodeCount?: number;
  readonly revisions?: readonly {
    readonly nodeId: string;
    readonly used: number;
    readonly limit: number;
  }[];
  readonly expertReviewRequired?: boolean;
  readonly automaticReview?: boolean;
  readonly attention?: string;
  readonly intent: {
    readonly intentId: string;
    readonly generation: number;
    readonly version: number;
    readonly concurrent: number;
    readonly automaticRevisions?: number;
  } | null;
  readonly selection: {
    readonly model: NativeRunModel;
    readonly workspace: WorkflowWorkspace | { readonly kind: 'unavailable' };
  } | null;
}
export interface WorkflowOptions extends WorkflowView {
  readonly models:
    | { readonly kind: 'ready'; readonly items: readonly NativeRunModelChoice[] }
    | { readonly kind: 'unavailable'; readonly message: string };
  readonly workspaces: readonly NativeRunWorkspaceChoice[];
  readonly maxConcurrent?: number;
}
export type WorkflowStart = WorkflowTarget & {
  readonly requestId: string;
  readonly model: NativeRunModel;
  readonly workspace: WorkflowWorkspace;
  readonly concurrent: number;
  readonly automaticRevisions?: number;
};
export type WorkflowControl = WorkflowTarget & {
  readonly requestId: string;
  readonly intentId: string;
  readonly generation: number;
};
export interface WorkflowApi {
  options(target: WorkflowTarget, signal: AbortSignal): Promise<WorkflowOptions>;
  read(target: WorkflowTarget, signal: AbortSignal): Promise<WorkflowView>;
  start(input: WorkflowStart, signal: AbortSignal): Promise<WorkflowView>;
  resume(
    input: WorkflowControl & {
      readonly expectedVersion: number;
      readonly workspace?: WorkflowWorkspace;
    },
    signal: AbortSignal,
  ): Promise<WorkflowView>;
  stop(input: WorkflowControl, signal: AbortSignal): Promise<WorkflowView>;
}
const invalid = (): never => {
  throw new ExecutionError('validation', '工作流状态无法核实，请刷新。');
};
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
function string(value: unknown, max = 200): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : invalid();
}
function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}
function array(value: unknown, max = 256): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : invalid();
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === 'string' && choices.includes(value as T) ? (value as T) : invalid();
}
function model(value: unknown): NativeRunModel {
  const item = object(value);
  return {
    provider: string(item.provider),
    model: string(item.model),
    maxTokens: integer(item.maxTokens, 1, 65_536),
    ...(item.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: string(item.reasoningEffort) }),
  };
}
function workspace(value: unknown): WorkflowWorkspace | { readonly kind: 'unavailable' } {
  const item = object(value);
  switch (item.kind) {
    case 'local':
      return {
        kind: 'local',
        id: string(item.id),
        ...(item.publish === undefined ? {} : { publish: workflowPublishRanges(item.publish) }),
      };
    case 'text-only':
      return { kind: 'text-only' };
    case 'unavailable':
      return { kind: 'unavailable' };
    default:
      return invalid();
  }
}
export function workflowPublishRanges(raw: unknown): WorkspacePublishRange[] {
  const ranges = workspacePublishRanges(raw);
  if (new TextEncoder().encode(JSON.stringify(ranges)).byteLength > 4096) invalid();
  return ranges;
}
function selectedWorkspace(raw: WorkflowWorkspace): WorkflowWorkspace {
  const value = workspace(raw);
  if (value.kind === 'unavailable') return invalid();
  return value;
}
function view(value: unknown, expected: WorkflowLocation): WorkflowView {
  const item = object(value),
    raw = object(item.target);
  const target = {
    spaceId: string(raw.spaceId),
    taskId: string(raw.taskId),
    planId: string(raw.planId),
    revision: integer(raw.revision, 1),
  };
  if (
    target.spaceId !== expected.spaceId ||
    target.taskId !== expected.taskId ||
    target.planId !== expected.planId ||
    target.revision !== expected.revision
  )
    invalid();
  const intent = item.intent === null ? null : object(item.intent);
  const selection = item.selection === null ? null : object(item.selection);
  const state = oneOf(item.state, [
    'inactive',
    'running',
    'waiting',
    'stopping',
    'paused',
    'completed',
    'requires-resume',
  ]);
  const planStarted = boolean(item.planStarted);
  const requiresResume = boolean(item.requiresResume);
  if ((state === 'inactive') !== (intent === null) || (intent === null) !== (selection === null))
    invalid();
  if ((intent !== null && !planStarted) || requiresResume !== (state === 'requires-resume'))
    invalid();
  const revisions =
    item.revisions === undefined
      ? undefined
      : array(item.revisions, 512).map((raw) => {
          const row = object(raw),
            limit = integer(row.limit, 0, 2);
          return { nodeId: string(row.nodeId), used: integer(row.used, 0, limit), limit };
        });
  if (
    revisions &&
    (!intent ||
      new Set(revisions.map((row) => row.nodeId)).size !== revisions.length ||
      (intent.automaticRevisions !== undefined &&
        revisions.some((row) => row.limit !== intent.automaticRevisions)))
  )
    invalid();
  return {
    target,
    title: string(item.title, 1000),
    state,
    planStarted,
    requiresResume,
    activeRunCount: integer(item.activeRunCount, 0, 512),
    expertNodeCount: integer(item.expertNodeCount, 0, 1000),
    ...(item.controlledNodeCount === undefined
      ? {}
      : { controlledNodeCount: integer(item.controlledNodeCount, 0, 1000) }),
    ...(item.controlledReviewNodeCount === undefined
      ? {}
      : { controlledReviewNodeCount: integer(item.controlledReviewNodeCount, 0, 1000) }),
    ...(revisions === undefined ? {} : { revisions }),
    ...(item.expertReviewRequired === undefined
      ? {}
      : { expertReviewRequired: boolean(item.expertReviewRequired) }),
    ...(item.automaticReview === undefined
      ? {}
      : { automaticReview: boolean(item.automaticReview) }),
    ...(item.attention === undefined ? {} : { attention: string(item.attention, 500) }),
    intent: intent
      ? {
          intentId: string(intent.intentId),
          generation: integer(intent.generation, 1),
          version: integer(intent.version, 1),
          concurrent: integer(intent.concurrent, 1, 4),
          ...(intent.automaticRevisions === undefined
            ? {}
            : { automaticRevisions: integer(intent.automaticRevisions, 0, 2) }),
        }
      : null,
    selection: selection
      ? { model: model(selection.model), workspace: workspace(selection.workspace) }
      : null,
  };
}
function options(value: unknown, expected: WorkflowLocation): WorkflowOptions {
  const item = object(value),
    models = object(item.models);
  return {
    ...view(item, expected),
    ...(item.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: integer(item.maxConcurrent, 1, 4) }),
    models:
      models.kind === 'ready'
        ? {
            kind: 'ready',
            items: array(models.items).map((raw) => {
              const choice = object(raw);
              return {
                id: string(choice.id, 500),
                label: string(choice.label, 300),
                value: model(choice.value),
              };
            }),
          }
        : models.kind === 'unavailable'
          ? { kind: 'unavailable', message: string(models.message, 500) }
          : invalid(),
    workspaces: array(item.workspaces, 100).map((raw) => {
      const choice = object(raw);
      return {
        id: string(choice.id),
        label: string(choice.label),
        access: oneOf(choice.access, ['read', 'write']),
        publish: boolean(choice.publish),
        ...(choice.publication === undefined
          ? {}
          : { publication: oneOf(choice.publication, ['per-run']) }),
      };
    }),
  };
}

/** Shares the original member Run transport and its account/space/view fences. */
export function createWorkflowApi(
  call: (endpoint: string, payload: object, signal: AbortSignal) => Promise<unknown>,
  spaceId: string,
): WorkflowApi {
  const location = (target: WorkflowTarget): WorkflowLocation => ({
    spaceId,
    taskId: target.taskId,
    planId: target.planId,
    revision: target.revision,
  });
  const control = (input: WorkflowControl) => ({
    ...location(input),
    requestId: input.requestId,
    intentId: input.intentId,
    generation: input.generation,
  });
  return {
    async options(target, signal) {
      return options(await call('options', location(target), signal), location(target));
    },
    async read(target, signal) {
      return view(await call('read', location(target), signal), location(target));
    },
    async start(input, signal) {
      const target = location(input);
      const next = view(
        await call(
          'start',
          {
            ...target,
            requestId: input.requestId,
            model: input.model,
            workspace: selectedWorkspace(input.workspace),
            concurrent: input.concurrent,
            ...(input.automaticRevisions === undefined
              ? {}
              : { automaticRevisions: input.automaticRevisions }),
          },
          signal,
        ),
        target,
      );
      if (!next.planStarted || !next.intent) invalid();
      return next;
    },
    async resume(input, signal) {
      const next = view(
        await call(
          'resume',
          {
            ...control(input),
            expectedVersion: input.expectedVersion,
            ...(input.workspace === undefined
              ? {}
              : { workspace: selectedWorkspace(input.workspace) }),
          },
          signal,
        ),
        location(input),
      );
      if (
        next.intent?.intentId !== input.intentId ||
        next.intent.generation !== input.generation + 1
      )
        invalid();
      return next;
    },
    async stop(input, signal) {
      const next = view(await call('stop', control(input), signal), location(input));
      if (next.intent?.intentId !== input.intentId || next.intent.generation !== input.generation)
        invalid();
      return next;
    },
  };
}
