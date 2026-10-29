import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { applySpaceDirectory, spaceDirectoryFor } from '../dist/space-directory.js';
import {
  installMemberResolver,
  uninstallMemberResolver,
  memberCredential,
} from '../dist/member-session.js';
import { KnowledgeError, openKnowledgeService } from '../dist/knowledge-service.js';

// Real original member lease, trusted directory, DSH JSON and attachment bytes.
// Session/account records and HTTP admission policy are synthetic contracts;
// this does not exercise a real login, renderer or Agent/model.
export async function knowledgeHost(t, options = {}) {
  const owned = !options.root,
    root = options.root ?? (await mkdtemp(join(tmpdir(), 'zhuma-knowledge-')));
  const ctx = new Context(),
    fibers = [],
    watchers = new Set(),
    sessions = new Map();
  for (const [plugin, config] of [
    [Storage],
    [JsonStorage, { root }],
    [Domain, { backend: 'json' }],
    [LocalAttachmentStore, { dshHome: join(root, 'attachments') }],
    [
      {
        inject: ['storageDomain'],
        apply: (child) =>
          applySpaceDirectory(child, {
            spaces: [
              { id: 'north', kind: 'team', name: '北区' },
              { id: 'south', kind: 'team', name: '南区' },
              { id: 'personal-ann', kind: 'personal', name: '个人' },
            ],
            memberships: [
              ['north', 'ann'],
              ['north', 'bob'],
              ['north', 'cy'],
              ['south', 'cy'],
              ['south', 'dana'],
              ['personal-ann', 'ann'],
            ].map(([spaceId, accountId]) => ({ spaceId, accountId })),
          }),
      },
    ],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber;
  }
  const directory = spaceDirectoryFor(ctx),
    binding = {
      directory,
      signal: directory.signal,
      isCurrent: () => spaceDirectoryFor(ctx) === directory,
    };
  const secret = randomBytes(32),
    accounts = ['ann', 'bob', 'cy', 'dana'];
  installMemberResolver(ctx, {
    secret,
    requestRejection: (headers) =>
      headers.host === '127.0.0.1:4000' && headers.origin === 'http://127.0.0.1:4000'
        ? undefined
        : 403,
    findSession: (id) => sessions.get(id),
    spaceIdsFor: (account) => directory.spacesForMember(account).map((space) => space.id),
    singleUserAccountId: () => undefined,
    admitOwner: () => false,
    execution: {
      accountExists: (id) => accounts.includes(id),
      currentDirectoryBinding: () => binding,
      onChange(callback) {
        watchers.add(callback);
        return () => watchers.delete(callback);
      },
    },
  });
  const requests = Object.fromEntries(
    accounts.map((account) => {
      const sessionId = randomUUID(),
        expiresAt = Date.now() + 3_600_000;
      sessions.set(sessionId, { accountId: account, expiresAt });
      return [
        account,
        {
          headers: {
            host: '127.0.0.1:4000',
            origin: 'http://127.0.0.1:4000',
            cookie: `zhuma-member=${memberCredential(secret, sessionId, expiresAt)}`,
          },
        },
      ];
    }),
  );
  // Synthetic Host-owned personal ownership facts, separate from memberships.
  const personalOwners = new Map([['personal-ann', 'ann']]);
  const service = await openKnowledgeService(ctx, {
    ...(options.readWorkbench ? { readWorkbench: options.readWorkbench } : {}),
    ...(options.omitPersonalOwner
      ? {}
      : {
          assertPersonalOwner(spaceId, actorId) {
            if (spaceDirectoryFor(ctx) !== directory || directory.signal.aborted)
              throw new KnowledgeError('unavailable');
            const owner = personalOwners.get(spaceId);
            if (!owner) throw new KnowledgeError('unavailable');
            if (owner !== actorId) throw new KnowledgeError('not-found');
          },
        }),
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await service.close();
    uninstallMemberResolver(ctx);
    for (const fiber of fibers.reverse()) await fiber.dispose();
  };
  t.after(async () => {
    await close();
    if (owned) await rm(root, { recursive: true, force: true });
  });
  const blob = async (text, original = false) => {
    const data = Buffer.from(text),
      name = original ? 'original.md' : 'knowledge.md';
    const ref = await ctx.attachments.saveFile({ data, name });
    return { ...ref, checksum: createHash('sha256').update(data).digest('hex') };
  };
  const seed = async ({
    spaceId = 'north',
    pageId = 'api',
    ownerActorId = 'ann',
    title = '接口鉴权',
    text = '接口使用令牌验证。',
    sources = [],
    versions,
    original,
  } = {}) => {
    const published = versions ?? [
      {
        version: 1,
        title,
        format: 'markdown',
        body: await blob(text),
        ...(original === undefined ? {} : { original: await blob(original, true) }),
        sources,
        publishedAt: '2026-10-28T00:00:00.000Z',
      },
    ];
    const page = {
      schemaVersion: 1,
      spaceId,
      libraryId: spaceId,
      pageId,
      ownerActorId,
      version: published.length,
      versions: published,
    };
    await service.store.put(page);
    return page;
  };
  return {
    ctx,
    root,
    service,
    directory,
    requests,
    blob,
    seed,
    close,
    watchers,
    personalOwners,
    async replaceDirectory() {
      await fibers.at(-1).dispose();
      const fiber = ctx.plugin({
        inject: ['storageDomain'],
        apply: (child) => applySpaceDirectory(child, { spaces: [] }),
      });
      fibers.push(fiber);
      await fiber;
      return spaceDirectoryFor(ctx);
    },
    async revoke(spaceId, actorId) {
      await directory.revokeMembership(spaceId, actorId);
      for (const watcher of [...watchers]) watcher();
    },
  };
}
export function value(result) {
  if (!result.ok) throw Error(JSON.stringify(result));
  return result.value;
}
