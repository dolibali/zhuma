/** Original Workbench queue/JSON serialization; lease/directory issuers here
 * are explicit contracts. Real original member-lease integration is separate. */
import { randomUUID, createHash } from 'node:crypto';
import { MemberAssetService } from '../dist/member-asset-service.js';
import { setup, signal } from './member-workbench-fixture.mjs';

export const digest = (data) => createHash('sha256').update(data).digest('hex');
export const rejects = (code) => (error) => error?.code === code;
export const source = (data) =>
  (async function* () {
    yield data;
  })();
export function assets(t, options = {}) {
  const packages = new Map();
  let beforePackageWrite = async () => {};
  const f = setup({
    ...options,
    packages: {
      get: (id) => packages.get(id),
      put: async (value) => {
        await beforePackageWrite();
        packages.set(value.versionId, structuredClone(value));
      },
    },
  });
  f.directory.administratorForSpace = (spaceId) => (spaceId === 'personal-ann' ? 'ann' : 'cy');
  const requests = Object.fromEntries(
    ['ann', 'bob', 'cy', 'dana'].map((actor) => [actor, { headers: {} }]),
  );
  const identities = new WeakMap(
    Object.entries(requests).map(([actor, request]) => [request, actor]),
  );
  const controllers = new Map();
  const lifetime = new AbortController();
  let issued = 0,
    released = 0;
  let owner;
  const carriers = new Set(),
    manualTickets = new Set(),
    manualReads = new Set();
  const create = () =>
    new MemberAssetService(f.workbench, {
      signal: lifetime.signal,
      directory: () => f.directory,
      memberLease: async (request) => {
        const actor = identities.get(request);
        if (!actor || !f.sessions.has(actor)) throw Error('PRIVATE-IDENTITY');
        await options.beforeLease?.();
        const controller = new AbortController();
        const set = controllers.get(actor) ?? new Set();
        controllers.set(actor, set);
        set.add(controller);
        issued++;
        let done = false;
        return {
          memberId: actor,
          expiresAt: Date.now() + 3600000,
          signal: controller.signal,
          assertCurrent(spaceId) {
            if (done || !f.sessions.has(actor) || !f.grants.has(`${spaceId}/${actor}`))
              throw Error('PRIVATE-DENIED');
          },
          release() {
            if (!done) {
              done = true;
              released++;
              set.delete(controller);
            }
          },
        };
      },
      sources: async (request, query, active) => {
        const actor = identities.get(request);
        if (!actor) throw Error('PRIVATE-REQUEST');
        return f
          .service(actor, { catalog: async () => options.catalog ?? { experts: [], assets: [] } })
          .assetSources(query, active);
      },
      catalog: async (spaceId) => ({
        experts: [
          ...(options.catalog?.experts ?? []),
          ...owner.publishedDefinitions(spaceId).experts,
        ],
        assets: [...(options.catalog?.assets ?? []), ...owner.publishedDefinitions(spaceId).assets],
      }),
      now: () => '2026-10-30T06:00:00.000Z',
    });
  owner = create();
  t.after(async () => {
    for (const carrier of carriers) await carrier.close();
    for (const ticket of manualTickets) await owner.abortFile(ticket);
    for (const read of manualReads) read.release();
    await owner.close();
  });
  const h = {
    f,
    packages,
    requests,
    carriers,
    get owner() {
      return owner;
    },
    get leases() {
      return { issued, released };
    },
    packageWrite(fn) {
      beforePackageWrite = fn;
    },
    async command(input, actor = 'ann') {
      return owner.command(requests[actor], input, signal());
    },
    async create(kind = 'file', patch = {}, actor = 'ann') {
      const definition =
        kind === 'expert'
          ? {
              kind,
              name: 'Reviewer',
              description: 'Independent review',
              role: 'Review',
              capabilities: ['evidence'],
              instructions: 'Check the actual evidence.',
            }
          : kind === 'skill'
            ? {
                kind,
                name: 'Review',
                description: 'Check evidence',
                content: 'Check the actual evidence.',
              }
            : { kind, name: 'Team file', description: 'Original bytes' };
      const input = {
        operation: 'create-draft',
        spaceId: 'north',
        assetId: randomUUID(),
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
        definition,
        dependencies: [],
        ...patch,
      };
      return { input, result: await h.command(input, actor) };
    },
    uploadInput(assetId, data, patch = {}) {
      return {
        spaceId: 'north',
        assetId,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        declare: {
          name: 'report.txt',
          mediaType: 'text/plain',
          byteSize: data.length,
          sha256: digest(data),
        },
        ...patch,
      };
    },
    async reserve(input, actor = 'ann') {
      const result = await owner.reserveFile(requests[actor], input, signal());
      manualTickets.add(result.ticket);
      return result;
    },
    async readFile(input, actor = 'ann') {
      const result = await owner.readFile(requests[actor], input, signal());
      manualReads.add(result);
      return result;
    },
    async reopen() {
      for (const ticket of manualTickets) await owner.abortFile(ticket);
      for (const read of manualReads) read.release();
      manualTickets.clear();
      manualReads.clear();
      await owner.close();
      f.reopen();
      owner = create();
    },
    revoke(actor, spaceId = 'north') {
      f.grants.delete(`${spaceId}/${actor}`);
      for (const controller of controllers.get(actor) ?? []) controller.abort();
    },
  };
  return h;
}
