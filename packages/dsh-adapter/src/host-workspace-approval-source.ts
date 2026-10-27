import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { symbols, type Context } from '@deepseek-ai/cordis';
import { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { canonicalPayload } from '@zhuma/agent-core';
import type { MemberRequest } from './member-session.js';
import {
  WORKSPACE_APPROVAL_LIMITS,
  workspaceApprovalCommandSchema,
  type WorkspaceApprovalCommand,
  type WorkspaceApprovalHostSource,
  type WorkspaceApprovalIdentity,
  type WorkspaceApprovalPreparation,
  type WorkspaceApprovalQualification,
} from './execution-workspace-approval-contract.js';

export interface HostWorkspaceDirectory {
  readonly id: string;
  readonly title: string;
  /** Owner-only display value. Approval commands never accept a path. */
  readonly path: string;
  readonly access: 'read' | 'write';
}
export class HostWorkspaceApprovalError extends Error {
  constructor(
    readonly code:
      | 'workspace-owner-required'
      | 'workspace-source-unavailable'
      | 'workspace-directory-unavailable'
      | 'workspace-policy-denied'
      | 'workspace-capacity',
  ) {
    super('工作目录授权操作未完成。');
    this.name = 'HostWorkspaceApprovalError';
  }
}
function fail(code: HostWorkspaceApprovalError['code']): never {
  throw new HostWorkspaceApprovalError(code);
}
const original = (value: unknown): unknown =>
  value && typeof value === 'object' ? (Reflect.get(value, symbols.original) ?? value) : value;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nested = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
interface Root {
  readonly identity: WorkspaceApprovalIdentity;
  readonly path: string;
  readonly title: string;
}

/** Actual SDK metadata plus one explicit owner action. The private permit only
 * connects this HTTP action to D's original prepare call; it is never an IO
 * grant, a persisted approval store or a browser-supplied confirmation flag. */
export function createHostWorkspaceApprovalSource(
  ctx: Context,
  options: { readonly signal: AbortSignal },
) {
  const parentSignal = options.signal;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const connection = ctx.get('connection');
  const connectionIdentity = original(connection);
  const permits = new WeakMap<
    MemberRequest,
    { readonly command: string; readonly signal: AbortSignal }
  >();
  const jobs = new Set<Promise<unknown>>();
  let registryIdentity: WorkspaceRegistry | undefined;
  let sandboxIdentity: SandboxPolicyService | undefined;
  let closing: Promise<void> | undefined;

  function active() {
    if (signal.aborted || options.signal !== parentSignal) fail('workspace-source-unavailable');
  }
  function assertOwner(request: MemberRequest) {
    active();
    const current = ctx.get('connection');
    if (!connection || !current || original(current) !== connectionIdentity)
      fail('workspace-source-unavailable');
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
        headers.append(name, item);
    if (current.requestRejection({ headers })) fail('workspace-owner-required');
    const admitted = current.admit({ headers });
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner')
      fail('workspace-owner-required');
  }
  function registry() {
    active();
    const current = ctx.get('workspaceRegistry');
    const identity = original(current);
    if (
      !current ||
      !(identity instanceof WorkspaceRegistry) ||
      identity.get !== WorkspaceRegistry.prototype.get ||
      identity.list !== WorkspaceRegistry.prototype.list ||
      (registryIdentity && registryIdentity !== identity)
    )
      fail('workspace-source-unavailable');
    registryIdentity ??= identity;
    return current;
  }
  function policy() {
    active();
    const current = ctx.get('sandboxPolicy');
    const identity = original(current);
    if (
      !current ||
      !(identity instanceof SandboxPolicyService) ||
      identity.resolve !== SandboxPolicyService.prototype.resolve ||
      (sandboxIdentity && sandboxIdentity !== identity)
    )
      fail('workspace-source-unavailable');
    sandboxIdentity ??= identity;
    // Selecting a product permission cannot raise the SDK's actual mode.
    const value = current.resolve({});
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value.mode))
      fail('workspace-source-unavailable');
    return value;
  }
  function root(workspaceId: string): Root {
    try {
      const record = registry().get(WorkspaceId(workspaceId));
      if (
        !record ||
        !isAbsolute(record.path) ||
        realpathSync(record.path) !== record.path ||
        !statSync(record.path).isDirectory() ||
        typeof record.createdAt !== 'string'
      )
        fail('workspace-directory-unavailable');
      return {
        identity: {
          workspaceId,
          createdAt: record.createdAt,
          pathFingerprint: digest(record.path),
        },
        path: record.path,
        title: (record.title || basename(record.path)).slice(0, 160),
      };
    } catch (error) {
      if (error instanceof HostWorkspaceApprovalError) throw error;
      return fail('workspace-directory-unavailable');
    }
  }
  function equalRoot(expected: Root) {
    const current = root(expected.identity.workspaceId);
    if (
      current.path !== expected.path ||
      canonicalPayload(current.identity) !== canonicalPayload(expected.identity)
    )
      fail('workspace-directory-unavailable');
  }
  function prepare(
    originalRequest: MemberRequest,
    input: WorkspaceApprovalPreparation,
    wait: AbortSignal,
  ): Promise<WorkspaceApprovalQualification> {
    return Promise.resolve().then(() => {
      assertOwner(originalRequest);
      wait.throwIfAborted();
      const permit = permits.get(originalRequest);
      if (!permit || permit.signal.aborted || permit.command !== canonicalPayload(input.command))
        fail('workspace-owner-required');
      const operation = new AbortController();
      const life = AbortSignal.any([signal, permit.signal, operation.signal, wait]);
      const commandFingerprint = input.commandFingerprint;
      const roots = new Map<string, Root>();
      const selected =
        input.command.operation === 'approve' ? root(input.command.workspaceId) : undefined;
      const sdkMode = selected ? policy().mode : undefined;
      if (
        selected &&
        input.command.operation === 'approve' &&
        input.command.access === 'write' &&
        sdkMode === 'read-only'
      )
        fail('workspace-policy-denied');
      if (selected) roots.set(selected.identity.workspaceId, selected);
      if (input.runs.length > WORKSPACE_APPROVAL_LIMITS.observedRuns) fail('workspace-capacity');
      const conflicts =
        input.command.operation === 'revoke'
          ? []
          : input.runs.flatMap((run) => {
              let candidate = roots.get(run.workspace.rootId);
              if (!candidate) {
                candidate = root(run.workspace.rootId);
                roots.set(run.workspace.rootId, candidate);
              }
              return selected &&
                (nested(selected.path, candidate.path) || nested(candidate.path, selected.path))
                ? [structuredClone(run.scope)]
                : [];
            });
      const assertCurrent = (): undefined => {
        life.throwIfAborted();
        assertOwner(originalRequest);
        if (
          permits.get(originalRequest) !== permit ||
          permit.command !== canonicalPayload(input.command) ||
          input.commandFingerprint !== commandFingerprint
        )
          fail('workspace-owner-required');
        for (const value of roots.values()) equalRoot(value);
        if (selected && policy().mode !== sdkMode) fail('workspace-policy-denied');
        return undefined;
      };
      assertCurrent();
      return Object.freeze({
        commandFingerprint,
        ...(selected ? { identity: Object.freeze({ ...selected.identity }) } : {}),
        conflictingRunScopes: Object.freeze(conflicts),
        signal: life,
        assertCurrent,
        release() {
          operation.abort();
        },
      });
    });
  }
  const source: WorkspaceApprovalHostSource = Object.freeze({ signal, prepare });
  return {
    source,
    assertOwner,
    /** Call only for an explicit, same-origin owner POST. D still authenticates
     * the original member and current project/space in its own queue. */
    confirmed<T>(
      request: MemberRequest,
      raw: WorkspaceApprovalCommand,
      perform: () => Promise<T>,
    ): Promise<T> {
      assertOwner(request);
      const command = workspaceApprovalCommandSchema.parse(raw);
      if (jobs.size >= WORKSPACE_APPROVAL_LIMITS.concurrent || permits.has(request))
        fail('workspace-capacity');
      const permitLife = new AbortController();
      const permit = Object.freeze({
        command: canonicalPayload(command),
        signal: permitLife.signal,
      });
      permits.set(request, permit);
      const work = Promise.resolve()
        .then(() => {
          assertOwner(request);
          return perform();
        })
        .finally(() => {
          permitLife.abort();
          if (permits.get(request) === permit) permits.delete(request);
        });
      jobs.add(work);
      void work.finally(() => jobs.delete(work)).catch(() => undefined);
      return work;
    },
    /** Read-only owner projection. The caller first obtains D's authorized list;
     * directory registration itself never creates a product approval. */
    directories(request: MemberRequest): readonly HostWorkspaceDirectory[] {
      assertOwner(request);
      const access = policy().mode === 'read-only' ? 'read' : 'write';
      return registry()
        .list()
        .slice(-WORKSPACE_APPROVAL_LIMITS.approvals)
        .flatMap((record) => {
          try {
            const selected = root(record.id);
            return [
              Object.freeze({
                id: record.id,
                title: selected.title,
                path: selected.path,
                access,
              }),
            ];
          } catch (error) {
            if (
              error instanceof HostWorkspaceApprovalError &&
              error.code === 'workspace-directory-unavailable'
            )
              return [];
            throw error;
          }
        });
    },
    close(): Promise<void> {
      if (closing) return closing;
      lifetime.abort();
      return (closing = (async () => {
        while (jobs.size) await Promise.allSettled([...jobs]);
      })());
    },
  };
}
