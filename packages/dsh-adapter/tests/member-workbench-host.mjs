/** Real published DSH components, isolated JSON storage and member HTTP. Not the final Host assembly or GUI. */
import { Context } from '@deepseek-ai/cordis';
import WebServer from '@deepseek-ai/dsh-host-webserver';
import Credentials from '@deepseek-ai/dsh-credentials-local';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyIdentity, identityInject, hashPassword } from '../dist/identity-session.js';
import { configureDeploymentMode } from '../dist/member-session.js';
import { applySpaceDirectory, spaceDirectoryFor } from '../dist/space-directory.js';
import { workbenchDomainSpec } from '../dist/workbench-plugin.js';
import { WorkbenchService } from '../dist/workbench-service.js';
import { openMemberWorkbenchHttp } from '../dist/member-workbench-http.js';
import { memberWorkbenchDirectoryFor } from '../dist/member-workbench-directory.js';
import { openMemberWorkbenchOperations } from '../dist/member-workbench-operation.js';
import { people, spaces, memberships } from './member-workbench-fixture.mjs';

export const password = 'isolated-contract-password';
const accounts = people.map((id) => ({ id, passwordHash: hashPassword(password) }));
export async function startMemberWorkbenchHost(
  directory,
  { faultStage, catalog, beforeWorkbenchWrite } = {},
) {
  const ctx = new Context();
  const fibers = [];
  let domain;
  let operationHandle;
  let httpHandle;
  async function close() {
    if (httpHandle) await httpHandle.close();
    if (operationHandle) await operationHandle.close();
    if (domain) await domain.close();
    for (const fiber of fibers.toReversed()) await fiber.dispose();
  }
  async function load(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
    return fiber;
  }
  try {
    await mkdir(join(directory, 'storages'), { recursive: true });
    await load(Storage);
    await load(JsonStorage, { root: join(directory, 'storages') });
    await load(StorageDomain, { backend: 'json' });
    await load(Credentials, { path: join(directory, 'credentials.yaml'), watch: false });
    await load(WebServer, { host: '127.0.0.1', port: 0 });
    await load(Connection);
    await load(RemoteAccess);
    configureDeploymentMode(ctx, 'multi-member');
    const directoryFiber = await load(
      { inject: ['storageDomain'], apply: applySpaceDirectory },
      {
        spaces,
        memberships: memberships.map(([spaceId, accountId]) => ({ spaceId, accountId })),
      },
    );
    const identityFiber = await load(
      { inject: [...identityInject], apply: applyIdentity },
      { accounts },
    );
    const trusted = spaceDirectoryFor(ctx);
    domain = await ctx.storageDomain.open(workbenchDomainSpec);
    operationHandle = await openMemberWorkbenchOperations(ctx.storageDomain);
    const operations = operationHandle.journal;
    const originalBegin = operations.begin.bind(operations);
    const originalComplete = operations.complete.bind(operations);
    operations.begin = async (intent) => {
      if (faultStage === 'before-intent') throw Error('synthetic before intent');
      await originalBegin(intent);
      if (faultStage === 'after-intent') throw Error('synthetic after intent');
    };
    operations.complete = async (intent, revision) => {
      if (faultStage === 'before-complete') throw Error('synthetic before completion');
      await originalComplete(intent, revision);
      if (faultStage === 'after-complete') throw Error('synthetic after completion');
    };
    const service = new WorkbenchService(
      {
        read: () => domain.global.get(),
        write: async (value) => {
          await beforeWorkbenchWrite?.(value);
          if (faultStage === 'after-assign') throw Error('synthetic Workbench write failure');
          await domain.global.set(value);
        },
      },
      {
        get: (id) => domain.table('planning').get(id),
        put: (audit) => domain.table('planning').put(audit.id, audit),
      },
    );
    const httpFiber = await load({
      inject: ['connection', 'storageDomain'],
      apply(ctx) {
        httpHandle = openMemberWorkbenchHttp(ctx, {
          workbench: service,
          directory: () => memberWorkbenchDirectoryFor(ctx),
          writer: () => trusted,
          operations,
          ...(catalog ? { catalog } : {}),
        });
      },
    });
    ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler: (req, res) => {
        if (ctx.connection.authorizeIndex(req, res))
          res.writeHead(200).end('Member workbench HTTP contract');
      },
    });
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const ownerReply = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    const owner = ownerReply.headers.get('set-cookie')?.split(';', 1)[0];
    await ownerReply.body?.cancel();
    if (!owner) throw Error('owner transport was not established');
    async function post(path, payload, cookie, headers = {}) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          cookie: cookie ? `${owner}; ${cookie}` : owner,
          ...headers,
        },
        body: JSON.stringify(payload),
        redirect: 'manual',
      });
      const body = await response.text();
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        /* HTTP rejection can have no JSON. */
      }
      return { status: response.status, json, headers: response.headers };
    }
    return {
      ctx,
      identityFiber,
      directoryFiber,
      httpHandle,
      httpFiber,
      directory: trusted,
      service,
      close,
      post,
      async login(id) {
        const response = await post('/zhuma-id/login', { accountId: id, password });
        if (response.status !== 200) throw Error(`login status ${response.status}`);
        return response.headers.get('set-cookie').split(';', 1)[0];
      },
      rpc(endpoint, payload, cookie, extraHeaders) {
        return post(
          `/api/zhuma-member/${endpoint}`,
          {
            type: 'client-request',
            rpcId: randomUUID(),
            method: `zhuma-member/${endpoint}`,
            payload,
          },
          cookie,
          extraHeaders,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
