/** Original member issuer, operation journal, Workbench JSON and attachment IO.
 * Account/transport admission are contract fixtures, not GUI/model acceptance. */
import { randomUUID } from 'node:crypto';
import { assetHost } from './member-asset-host-fixture.mjs';
import { MemberWorkbenchService } from '../dist/member-workbench-service.js';
import { openMemberWorkbenchOperations } from '../dist/member-workbench-operation.js';
import { resolveMember } from '../dist/member-session.js';
import { request, signal } from './member-workbench-fixture.mjs';

export async function fixedFilesHost(t, options = {}) {
  const hooks = [];
  const h = await assetHost({ after: (fn) => hooks.push(fn) }, options);
  const operations = await openMemberWorkbenchOperations(h.ctx.storageDomain);
  const directory = {
    spaces: () => h.directory.spaces(),
    space: (id) => h.directory.space(id),
    isMember: (space, actor) => h.directory.isMember(space, actor),
    spacesForMember: (actor) => h.directory.spacesForMember(actor),
    spaceForProject: (id) => h.directory.spaceForProject(id),
    membersForSpace: (space) => h.directory.memberIdsForSpace(space).map((id) => ({ id })),
    administratorForSpace: (space) => h.personalOwners.get(space),
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await operations.close();
    await h.close();
  };
  t.after(async () => {
    await close();
    for (const hook of hooks) await hook();
  });
  const member = (actor = 'ann', patch = {}) =>
    new MemberWorkbenchService(h.workbench, {
      directory: () => directory,
      writer: () => h.directory,
      resolve: () => resolveMember(h.ctx, h.requests[actor]),
      catalog: async (space) => h.owner.publishedDefinitions(space),
      operations: operations.journal,
      now: () => '2026-10-30T09:00:00.000Z',
      ...patch,
    });
  const command = (value, actor = 'ann', space = 'north') =>
    member(actor).command(request(h.workbench.snapshot().revision, value, space), signal());
  const publishFile = async (text, { prior, spaceId = 'north', actor = 'ann' } = {}) => {
    const assetId = prior?.reference.assetId ?? randomUUID();
    if (!prior)
      await h.owner.command(
        h.requests[actor],
        {
          operation: 'create-draft',
          spaceId,
          assetId,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          definition: { kind: 'file', name: '接口资料', description: '固定版本' },
          dependencies: [],
        },
        signal(),
      );
    const data = Buffer.from(text);
    const input = h.uploadInput(assetId, data, {
      spaceId,
      expectedVersion: prior?.published.asset.version ?? 1,
    });
    const receipt = await h.upload(input, data, actor);
    await h.files.idle();
    const published = await h.owner.command(
      h.requests[actor],
      {
        operation: 'publish',
        spaceId,
        assetId,
        expectedVersion: receipt.assetVersion,
        idempotencyKey: randomUUID(),
      },
      signal(),
    );
    return { reference: published.reference, published, data, input };
  };
  return { ...h, close, member, command, publishFile, operations: operations.journal };
}
