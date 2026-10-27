import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ExecutionResult, ExecutionService } from './execution-service.js';
import type { MemberRequest } from './member-session.js';
import {
  workspaceApprovalCommandSchema,
  type WorkspaceApprovalMutation,
  type WorkspaceApprovalOutcome,
  type WorkspaceApprovalOwner,
  type WorkspaceApprovalRow,
} from './execution-workspace-approval-contract.js';
import {
  createHostWorkspaceApprovalSource,
  HostWorkspaceApprovalError,
  type HostWorkspaceDirectory,
} from './host-workspace-approval-source.js';

const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
export const hostWorkspaceApprovalLocationSchema = z.strictObject({ spaceId: id, projectId: id });
export interface HostWorkspaceApprovalView {
  readonly available: boolean;
  readonly directories: readonly HostWorkspaceDirectory[];
  readonly approvals: readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly generation: number;
    readonly status: 'approved' | 'revoked';
    readonly access: 'read' | 'write' | null;
    readonly publish: readonly { readonly kind: 'file' | 'directory'; readonly path: string }[];
  }[];
}
export interface HostWorkspaceApprovalOperations {
  options(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<HostWorkspaceApprovalView>>;
  approve(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
  revoke(
    original: MemberRequest,
    payload: unknown,
    wait?: AbortSignal,
  ): Promise<ExecutionResult<unknown>>;
}
function publicFailure(code = 'workspace-source-unavailable'): ExecutionResult<never> {
  return { ok: false, error: { code, message: '工作目录授权操作未完成。', details: {} } };
}
function projectMutation(
  result: WorkspaceApprovalOutcome<WorkspaceApprovalMutation>,
): ExecutionResult<unknown> {
  if (!result.ok) return publicFailure(result.error.code);
  const { disposition, receipt, current } = result.value;
  return {
    ok: true,
    value: {
      disposition,
      receipt: structuredClone(receipt),
      current: projectRow(current),
    },
  };
}
function projectRow(row: WorkspaceApprovalRow): HostWorkspaceApprovalView['approvals'][number] {
  return {
    id: row.id,
    workspaceId: row.identity.workspaceId,
    generation: row.generation,
    status: row.status,
    access: row.policy?.access ?? null,
    publish: structuredClone(row.policy?.publish ?? []),
  };
}

/** Private D owner and actual SDK source. The public view is a projection only;
 * neither paths nor selected rows can authorize a later Run or file operation. */
export function openHostWorkspaceApprovals(
  ctx: Context,
  options: {
    readonly execution: Pick<ExecutionService, 'openWorkspaceApprovalOwner'>;
    readonly signal: AbortSignal;
  },
) {
  const producer = createHostWorkspaceApprovalSource(ctx, { signal: options.signal });
  const owner: WorkspaceApprovalOwner = options.execution.openWorkspaceApprovalOwner(
    producer.source,
  );
  const failure = (error: unknown) =>
    publicFailure(error instanceof HostWorkspaceApprovalError ? error.code : undefined);
  const operations: HostWorkspaceApprovalOperations = {
    async options(original, payload, wait) {
      try {
        wait?.throwIfAborted();
        producer.assertOwner(original);
        const parsed = hostWorkspaceApprovalLocationSchema.safeParse(payload);
        if (!parsed.success) return publicFailure('invalid-request');
        const first = await owner.list(original, parsed.data, wait);
        if (!first.ok) return publicFailure(first.error.code);
        let directories: readonly HostWorkspaceDirectory[] = [],
          available = true;
        try {
          directories = producer.directories(original);
        } catch (error) {
          if (
            !(error instanceof HostWorkspaceApprovalError) ||
            error.code === 'workspace-owner-required'
          )
            throw error;
          available = false;
        }
        const final = await owner.list(original, parsed.data, wait);
        if (!final.ok) return publicFailure(final.error.code);
        wait?.throwIfAborted();
        producer.assertOwner(original);
        return {
          ok: true,
          value: { available, directories, approvals: final.value.map(projectRow) },
        };
      } catch (error) {
        return failure(error);
      }
    },
    async approve(original, payload, wait) {
      try {
        const raw =
          payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : undefined;
        const parsed = workspaceApprovalCommandSchema.safeParse({ ...raw, operation: 'approve' });
        if (
          (raw && Object.hasOwn(raw, 'operation')) ||
          !parsed.success ||
          parsed.data.operation !== 'approve'
        )
          return publicFailure('invalid-request');
        const command = parsed.data;
        const { operation: _operation, ...body } = command;
        return projectMutation(
          await producer.confirmed(original, command, () => owner.approve(original, body, wait)),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async revoke(original, payload, wait) {
      try {
        const raw =
          payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : undefined;
        const parsed = workspaceApprovalCommandSchema.safeParse({ ...raw, operation: 'revoke' });
        if (
          (raw && Object.hasOwn(raw, 'operation')) ||
          !parsed.success ||
          parsed.data.operation !== 'revoke'
        )
          return publicFailure('invalid-request');
        const command = parsed.data;
        const { operation: _operation, ...body } = command;
        return projectMutation(
          await producer.confirmed(original, command, () => owner.revoke(original, body, wait)),
        );
      } catch (error) {
        return failure(error);
      }
    },
  };
  return { operations, owner, close: () => producer.close() };
}
