// Original Service/DSH JSON. The member, SDK workspace/owner confirmation and
// native drain are explicit contracts; no actual directory approval UI/model.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { open } from './execution-service-run-fixture.mjs';

export const approvalCommand = (patch = {}) => ({
  requestId: randomUUID(),
  spaceId: 'north',
  projectId: 'project',
  workspaceId: 'registered',
  expectedGeneration: 0,
  access: 'write',
  publish: [{ kind: 'directory', path: 'deliverables' }],
  ...patch,
});
export function approvalSource(h) {
  const life = new AbortController(),
    hooks = {},
    calls = { prepare: 0, check: 0, release: 0 };
  const source = {
    signal: life.signal,
    async prepare(original, input, signal) {
      calls.prepare++;
      assert.equal(h.members.get(original), input.actorId);
      await hooks.prepare?.(input, signal);
      if (input.command.operation === 'approve' && hooks.missing)
        throw Error('PRIVATE_DIRECTORY_MISSING');
      const qualification = {
        commandFingerprint: input.commandFingerprint,
        ...(input.command.operation === 'approve'
          ? {
              identity: {
                workspaceId: input.command.workspaceId,
                createdAt: hooks.createdAt ?? '2026-10-01T00:00:00.000Z',
                pathFingerprint:
                  hooks.pathFingerprint ??
                  createHash('sha256').update('ISOLATED_CANONICAL_PATH_CONTRACT').digest('hex'),
              },
            }
          : {}),
        conflictingRunScopes: hooks.conflicts ?? [],
        signal: life.signal,
        assertCurrent() {
          calls.check++;
          life.signal.throwIfAborted();
          return hooks.assert?.(input);
        },
        release() {
          calls.release++;
          return hooks.release?.();
        },
      };
      return hooks.qualification?.(qualification) ?? qualification;
    },
  };
  const owner = h.service.openWorkspaceApprovalOwner(source);
  return { ...h, source, life, hooks, calls, owner };
}
export async function approvalHost(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'zhuma-workspace-approval-'));
  const h = await open(root, { seed: false, ...options });
  // A real C view must be supplied by the production Host; this is a contract.
  const drainLife = new AbortController();
  h.service.runHost.migrationDrain = () => ({
    signal: drainLife.signal,
    basis: 'flushed-and-closed',
    assertCurrent() {
      if (!h.faults.drained) throw Error('CONTRACT_DRAIN_UNAVAILABLE');
    },
  });
  t.after(async () => {
    await h.close();
    await rm(root, { recursive: true, force: true });
  });
  return approvalSource({ ...h, root, drainLife });
}
