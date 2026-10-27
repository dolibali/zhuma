import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { approvalHost, approvalCommand } from './execution-workspace-approval-fixture.mjs';
import { checked, refused } from './execution-service-run-fixture.mjs';
import { WORKSPACE_APPROVAL_LIMITS } from '../dist/execution-workspace-approval-contract.js';

// Ported from E's independently reached original Service/JSON capacity case.
// Member and SDK owner qualification remain explicit contracts, not real UI.
test(
  'workspace approval: repeated tombstone receipts cannot consume remaining active approvals revocation reserve',
  { timeout: 120000 },
  async (t) => {
    const h = await approvalHost(t);
    for (let index = 0; index < 100; index++)
      checked(
        await h.owner.approve(
          h.request,
          approvalCommand({
            workspaceId: randomUUID(),
            access: 'read',
            publish: [],
          }),
        ),
      );
    const revoke = (row) => ({
      requestId: randomUUID(),
      spaceId: 'north',
      projectId: 'project',
      approvalId: row.id,
      expectedGeneration: row.generation,
    });
    let blocked;
    fill: for (const original of h.owner.snapshot().state.approvals.slice(0, 99)) {
      for (let count = 0; count < 16; count++) {
        const row = h.owner.snapshot().state.approvals.find((item) => item.id === original.id),
          command = revoke(row),
          result = await h.owner.revoke(h.request, command);
        if (!result.ok) {
          refused(result, 'workspace-approval-capacity');
          blocked = { row, command };
          break fill;
        }
      }
    }
    assert.ok(blocked, 'reachable tombstone receipt growth reaches the unchanged byte budget');
    assert.equal(blocked.row.status, 'revoked');
    const full = h.owner.snapshot().state,
      active = full.approvals.filter((row) => row.status === 'approved'),
      bytes = Buffer.byteLength(JSON.stringify(full));
    assert.equal(full.approvals.length, 100);
    assert.ok(active.length > 0);
    assert.ok(bytes <= WORKSPACE_APPROVAL_LIMITS.stateBytes);
    let revoked = 0;
    for (const row of active) {
      const result = await h.owner.revoke(h.request, revoke(row));
      assert.equal(
        result.ok,
        true,
        `remaining active revocation failed: ${result.ok ? '' : result.error.code}`,
      );
      revoked++;
    }
    const settled = h.owner.snapshot().state;
    assert.ok(
      bytes + active.length * WORKSPACE_APPROVAL_LIMITS.revokeReserveBytes <=
        WORKSPACE_APPROVAL_LIMITS.stateBytes,
    );
    assert.equal(revoked, active.length);
    assert.equal(settled.approvals.filter((row) => row.status === 'approved').length, 0);
    assert.equal(settled.approvals.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(settled)) <= WORKSPACE_APPROVAL_LIMITS.stateBytes);
  },
);
