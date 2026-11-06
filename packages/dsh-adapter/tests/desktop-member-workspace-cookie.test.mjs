/** Actual Connection, identity, workspace source and execution approval service
 * over Node HTTP. Memory storage and a temporary directory; no Electron/model. */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Registry from '@deepseek-ai/dsh-workspace';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Sandbox from '@deepseek-ai/dsh-sandbox-policy';
import {
  createDesktopMemberCookieBridge,
  isDesktopOwnerControlPost,
} from '../dist/desktop-member-cookie.js';
import { apply as applyExecution, inject as executionInject } from '../dist/execution-plugin.js';
import { hashPassword } from '../dist/identity-session.js';
import { openHostWorkspaceApprovals } from '../dist/host-workspace-approvals.js';
import { createHostRunSources } from '../dist/host-run-sources.js';
import { spaceDirectoryFor } from '../dist/space-directory.js';
import {
  openHostWorkspaceApprovalHttp,
  hostWorkspaceApprovalEndpoints,
} from '../dist/host-workspace-approval-http.js';
import { boundedProjectSpaces } from '../dist/project-space.js';
import { bootIdentity } from './member-host.mjs';
import { fixture } from '../../../tests/fixtures/workbench.mjs';

test(
  'desktop workspace HTTP: original owner and member can list/approve/revoke; foreign origins and owner-only requests remain denied',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'zhuma-desktop-workspace-cookie-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, 'project');
    await mkdir(directory);
    const password = randomBytes(24).toString('hex');
    const host = await bootIdentity(
      { accounts: [{ id: 'chen', passwordHash: hashPassword(password) }], notes: [] },
      'multi-member',
      {
        spaces: [{ id: 'project', kind: 'team', name: 'Project' }],
        memberships: [{ spaceId: 'project', accountId: 'chen' }],
      },
      { publish() {} },
    );
    const fibers = [],
      lifetime = new AbortController();
    let execution, controls, transport, lastCookie;
    const server = http.createServer((req, res) => {
      lastCookie = req.headers.cookie;
      if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
        host.ctx.connection.authorizeIndex(req, res);
        if (!res.writableEnded) res.end();
      } else
        void host.web.dispatch(req, res).catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
    try {
      for (const [plugin, config] of [
        [Sessions],
        [Projections],
        [Persistence, { root: join(root, 'sessions'), compression: 'none' }],
        [Registry],
        [Sandbox, { workspaceRoot: directory, mode: 'workspace-write' }],
      ]) {
        const fiber = host.ctx.plugin(plugin, config);
        fibers.push(fiber);
        await fiber;
      }
      const workspace = await host.ctx
        .get('workspaceRegistry')
        .create(directory, 'Temporary project');
      const { state } = fixture();
      await spaceDirectoryFor(host.ctx).assignProjectSpace('project', 'project');
      execution = host.ctx.plugin(
        { inject: [...executionInject], apply: applyExecution },
        {
          readWorkbench: () => state,
          projectSpaces: boundedProjectSpaces([{ projectId: 'project', spaceId: 'project' }]),
          publishRunService(service) {
            // Reuse the real member lease/directory issuer. Native Run operations
            // are outside this HTTP contract and must never succeed here.
            const noRun = () => assert.fail('This HTTP contract must not start or qualify a Run');
            service.installRunHost(
              createHostRunSources(host.ctx, {
                directory: host.directoryLifecycle,
                configuration: { assertConfiguration: noRun, assertWorkspace: noRun },
                native: { migrationOrigin: noRun, migrationDrain: noRun },
                signal: lifetime.signal,
              }),
            );
            controls = openHostWorkspaceApprovals(host.ctx, {
              execution: service,
              signal: lifetime.signal,
            });
            return () => controls.close();
          },
        },
      );
      await execution;
      transport = openHostWorkspaceApprovalHttp(host.ctx, {
        current: () => controls.operations,
        limits: { bodyBytes: 32768, bodyTimeoutMs: 1000 },
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const owned = await fetch(host.ctx.connection.authenticatedUrl(`${origin}/`), {
        redirect: 'manual',
      });
      assert.equal(owned.status, 303);
      const ownerCookie = owned.headers.get('set-cookie').split(';', 1)[0];
      await owned.body?.cancel();
      const bridge = createDesktopMemberCookieBridge();
      const scope = { spaceId: 'project', projectId: 'project' };
      async function call(path, body, extraHeaders = {}) {
        const input = new Request(`dsh-app://app${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: 'dsh-app://app', 'content-type': 'application/json', ...extraHeaders },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const response = await bridge.forward(input, origin, ownerCookie, (cookie) =>
          fetch(`${origin}${path}`, {
            method: input.method,
            headers: {
              host: new URL(origin).host,
              cookie,
              'content-type': 'application/json',
              ...(isDesktopOwnerControlPost(input) ? { origin } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: input.signal,
            redirect: 'manual',
          }).catch((error) => {
            throw new Error(`Workspace HTTP ${input.method} ${path}`, { cause: error });
          }),
        );
        assert.equal(response.headers.get('set-cookie'), null);
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined };
      }
      const payload = (endpoint, value) => ({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `zhuma-workspaces/${endpoint}`,
        payload: value,
      });
      const rpc = (endpoint, value) =>
        call(`/api/zhuma-workspaces/${endpoint}`, payload(endpoint, value));
      const checked = (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.body.result.ok, true, JSON.stringify(response.body.result.error));
        return response.body.result.value;
      };
      assert.equal((await rpc('options', scope)).status, 401);
      assert.equal((await call('/zhuma-id/login', { accountId: 'chen', password })).status, 200);
      assert.equal((await call('/zhuma-id/session')).status, 200);
      const authenticatedCookie = lastCookie;
      for (const endpoint of hostWorkspaceApprovalEndpoints) {
        for (const [cookie, rawOrigin, expected] of [
          [ownerCookie, origin, 401],
          [authenticatedCookie, undefined, 403],
          [authenticatedCookie, 'https://outside.invalid', 403],
        ]) {
          const response = await fetch(`${origin}/api/zhuma-workspaces/${endpoint}`, {
            method: 'POST',
            headers: {
              host: new URL(origin).host,
              cookie,
              'content-type': 'application/json',
              ...(rawOrigin ? { origin: rawOrigin } : {}),
            },
            body: JSON.stringify(payload(endpoint, scope)),
          });
          assert.equal(response.status, expected);
          await response.body?.cancel();
        }
      }
      const view = checked(await rpc('options', scope));
      assert.equal(view.available, true);
      assert.equal(view.directories.length, 1);
      assert.equal(view.directories[0].id, workspace.id);
      assert.deepEqual(view.approvals, []);
      const approved = checked(
        await rpc('approve', {
          ...scope,
          requestId: randomUUID(),
          workspaceId: workspace.id,
          expectedGeneration: 0,
          access: 'write',
          publish: [],
        }),
      );
      assert.equal(approved.current.status, 'approved');
      assert.equal(approved.current.generation, 1);
      assert.equal((await call('/zhuma-id/session')).status, 200);
      const revoked = checked(
        await rpc('revoke', {
          ...scope,
          requestId: randomUUID(),
          approvalId: approved.current.id,
          expectedGeneration: 1,
        }),
      );
      assert.equal(revoked.current.status, 'revoked');
      assert.equal(revoked.current.generation, 2);
      assert.equal(checked(await rpc('options', scope)).approvals[0].status, 'revoked');
      assert.equal((await call('/zhuma-id/session')).status, 200);
      const logout = await fetch(`${origin}/zhuma-id/logout`, {
        method: 'POST',
        headers: {
          host: new URL(origin).host,
          cookie: authenticatedCookie,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(logout.status, 200);
      await logout.body?.cancel();
      for (const endpoint of hostWorkspaceApprovalEndpoints)
        assert.equal((await rpc(endpoint, scope)).status, 401);
      assert.equal((await call('/zhuma-id/session')).status, 401);
    } finally {
      lifetime.abort();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await transport?.close();
      await execution?.dispose();
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await host.dispose();
    }
  },
);
