/** Real published DSH HTTP/Connection, product login cookies, directory,
 * knowledge JSON and AttachmentLocal. Synthetic accounts; no Agent/Run/GUI proof. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { startMemberWorkbenchHost } from './member-workbench-host.mjs';
import { openKnowledgeService } from '../dist/knowledge-service.js';
import { openKnowledgeHttp, knowledgeEndpoints } from '../dist/knowledge-http.js';
import { enableMemberWeb } from '../dist/member-web-transport.js';
import { applyIdentity, identityInject } from '../dist/identity-session.js';
import { spaceDirectoryFor } from '../dist/space-directory.js';

const envelope = (endpoint, payload) => ({
  type: 'client-request',
  rpcId: randomUUID(),
  method: `zhuma-knowledge/${endpoint}`,
  payload,
});
const proposal = (patch = {}) => ({
  spaceId: 'north',
  libraryId: 'north',
  pageId: 'guide',
  expectedVersion: 0,
  idempotencyKey: randomUUID(),
  content: { title: 'Guide', format: 'markdown', text: 'Proposed fixed draft.', sources: [] },
  ...patch,
});
async function host(t) {
  const home = await mkdtemp(join(tmpdir(), 'zhuma-knowledge-http-'));
  let member, identity, attachment, service, http;
  t.after(async () => {
    await http?.close();
    await service?.close();
    await attachment?.dispose();
    await identity?.dispose();
    await member?.close();
    await rm(home, { recursive: true, force: true });
  });
  member = await startMemberWorkbenchHost(home);
  // The Workbench fixture mounts identity without execution leases. Remount
  // the original persisted identity with its real directory binding; login
  // and every proposal below still use the original product cookie issuer.
  await member.identityFiber.dispose();
  const directory = spaceDirectoryFor(member.ctx);
  identity = member.ctx.plugin({
    inject: [...identityInject],
    apply(child) {
      return applyIdentity(child, undefined, {
        currentDirectoryBinding: () => ({
          directory,
          signal: directory.signal,
          isCurrent: () => spaceDirectoryFor(child) === directory,
        }),
      });
    },
  });
  await identity;
  attachment = member.ctx.plugin(LocalAttachmentStore, { dshHome: join(home, 'knowledge-files') });
  await attachment;
  service = await openKnowledgeService(member.ctx, {
    readWorkbench: () => member.service.snapshot(),
  });
  const calls = { proposals: 0, writes: 0 };
  const propose = service.proposeDraft.bind(service),
    put = service.store.put.bind(service.store);
  service.proposeDraft = (...args) => {
    calls.proposals++;
    return propose(...args);
  };
  service.store.put = (...args) => {
    calls.writes++;
    return put(...args);
  };
  enableMemberWeb(member.ctx);
  let current = service;
  http = openKnowledgeHttp(member.ctx, () => current);
  const origin = `http://127.0.0.1:${member.ctx.webServer.port}`;
  const cookies = {};
  for (const actor of ['ann', 'bob', 'dana']) cookies[actor] = await member.login(actor);
  async function raw(endpoint, body, { cookie = cookies.ann, headers = {} } = {}) {
    const response = await fetch(`${origin}/api/zhuma-knowledge/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body,
      redirect: 'manual',
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text ? JSON.parse(text) : undefined,
    };
  }
  return {
    ...member,
    http,
    service,
    calls,
    origin,
    cookies,
    raw,
    call: (endpoint, payload, options) =>
      raw(endpoint, JSON.stringify(envelope(endpoint, payload)), options),
    durable: async () => {
      try {
        return await readFile(join(home, 'storages', 'zhuma_knowledge.json'));
      } catch (error) {
        if (error.code === 'ENOENT') return null; // Original Domain is lazy until a write.
        throw error;
      }
    },
    unpublish: () => {
      current = undefined;
    },
  };
}
const value = (reply) => {
  assert.equal(reply.status, 200);
  assert.equal(reply.json.result.ok, true, JSON.stringify(reply.json));
  return reply.json.result.value;
};

test('project knowledge HTTP: original member project creation and fixed publication feed two exact relation operations', async (t) => {
  const h = await host(t);
  const created = await h.rpc(
    'command',
    {
      spaceId: 'north',
      requestId: randomUUID(),
      expectedRevision: 0,
      command: {
        type: 'create-project',
        project: { id: 'project', name: 'Project', description: '' },
      },
    },
    h.cookies.ann,
  );
  assert.equal(created.json.result.ok, true, JSON.stringify(created.json));
  const query = { spaceId: 'north', projectId: 'project' };
  assert.equal(value(await h.call('project-links', query)).relationshipVersion, 0);
  const saved = value(await h.call('save-draft', proposal()));
  const published = value(
    await h.call('publish', {
      spaceId: 'north',
      libraryId: 'north',
      pageId: 'guide',
      expectedVersion: saved.pageRevision,
      idempotencyKey: randomUUID(),
    }),
  );
  const input = {
    ...query,
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    links: [{ reference: published.reference, required: false }],
  };
  assert.equal(value(await h.call('save-project-links', input)).disposition, 'saved');
  const before = await h.durable();
  assert.equal(value(await h.call('save-project-links', input)).disposition, 'replayed');
  const found = value(await h.call('project-links', query, { cookie: h.cookies.bob }));
  assert.equal(found.actorId, 'bob');
  assert.deepEqual(found.snapshot.links, input.links);
  assert.equal(found.links[0].required, false);
  const denied = await h.call('project-links', query, { cookie: h.cookies.dana });
  assert.equal(denied.json.result.ok, false);
  const anonymous = await h.call('save-project-links', input, { cookie: '' });
  assert.equal(anonymous.status, 401);
  const mismatched = envelope('read', query);
  assert.equal((await h.raw('project-links', JSON.stringify(mismatched))).status, 400);
  assert.deepEqual(await h.durable(), before);
});

test('knowledge proposal HTTP: one ninth exact reuses member/page-author save, marks only draft provenance and never publishes', async (t) => {
  const h = await host(t),
    input = proposal();
  assert.deepEqual(knowledgeEndpoints, [
    'libraries',
    'list',
    'search',
    'read',
    'drafts',
    'draft',
    'save-draft',
    'propose-draft',
    'publish',
    'project-links',
    'save-project-links',
  ]);
  const reply = await h.call('propose-draft', input),
    saved = value(reply);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal(saved.actorId, 'ann');
  assert.equal(saved.operation, 'save-draft');
  assert.equal(saved.disposition, 'saved');
  const draft = value(
    await h.call('draft', { spaceId: 'north', libraryId: 'north', pageId: 'guide' }),
  );
  assert.equal(draft.ownerActorId, 'ann');
  assert.equal(draft.draft.authorship, 'agent');
  assert.equal(draft.draft.text, input.content.text);
  assert.equal(draft.published, null);
  assert.equal(h.calls.proposals, 1);
  assert.equal(h.calls.writes, 1);
  const before = await h.durable();
  const forged = await h.raw(
    'propose-draft',
    JSON.stringify(
      envelope('publish', {
        spaceId: 'north',
        libraryId: 'north',
        pageId: 'guide',
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.equal(forged.status, 400);
  assert.deepEqual(await h.durable(), before);
});

test('knowledge proposal HTTP: escaped valid content shares save budget; concurrent same-key replay and changed content preserve one draft receipt', async (t) => {
  const h = await host(t),
    input = proposal({
      content: { title: 'Escaped text', format: 'text', text: '\u0000'.repeat(8192), sources: [] },
    });
  assert.ok(Buffer.byteLength(JSON.stringify(envelope('propose-draft', input))) > 16_384);
  const result = await Promise.all([
    h.call('propose-draft', input),
    h.call('propose-draft', input),
  ]);
  assert.deepEqual(result.map((r) => value(r).disposition).sort(), ['replayed', 'saved']);
  assert.equal(h.calls.writes, 1);
  const before = await h.durable();
  const changed = await h.call('propose-draft', {
    ...input,
    content: { ...input.content, text: 'changed' },
  });
  assert.equal(changed.json.result.error.code, 'conflict');
  assert.deepEqual(await h.durable(), before);
});

test('knowledge proposal HTTP: same-team non-author, wrong space, actor injection and revoked membership cannot change owned content', async (t) => {
  const h = await host(t);
  value(await h.call('propose-draft', proposal()));
  const before = await h.durable();
  const cases = [
    [proposal({ expectedVersion: 1 }), h.cookies.bob],
    [proposal({ pageId: 'foreign-new' }), h.cookies.dana],
    [{ ...proposal({ expectedVersion: 1 }), actorId: 'bob' }, h.cookies.ann],
    [proposal({ expectedVersion: 0 }), h.cookies.ann],
  ];
  for (const [input, cookie] of cases) {
    const rejected = await h.call('propose-draft', input, { cookie });
    assert.equal(rejected.json.result.ok, false);
    assert.ok(
      ['not-found', 'forbidden', 'invalid', 'conflict'].includes(rejected.json.result.error.code),
    );
    assert.deepEqual(await h.durable(), before);
  }
  await h.directory.revokeMembership('north', 'ann');
  const revoked = await h.call('propose-draft', proposal({ expectedVersion: 1 }));
  assert.equal(revoked.json.result.ok, false);
  assert.deepEqual(await h.durable(), before);
  assert.equal(h.calls.writes, 1);
});

function unfinished(
  h,
  { cookie, origin = h.origin, type = 'application/json', contentLength = 100000 } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest(
      `${h.origin}/api/zhuma-knowledge/propose-draft`,
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': type,
          'content-length': String(contentLength),
          ...(cookie ? { cookie } : {}),
        },
      },
      (response) => {
        const parts = [];
        response.on('data', (chunk) => parts.push(chunk));
        response.on('end', () => {
          settled = true;
          resolve({ status: response.statusCode, body: Buffer.concat(parts).toString() });
          request.destroy();
        });
      },
    );
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    request.setTimeout(2000, () => {
      request.destroy(Error('authorization consumed an unfinished body'));
    });
    request.write('{'); // Deliberately never end the declared request body.
  });
}

test('knowledge proposal HTTP: missing/forged member, foreign Origin and wrong media type reject before the unfinished body completes', async (t) => {
  const h = await host(t),
    before = await h.durable();
  for (const [options, status] of [
    [{}, 401],
    [{ cookie: 'zhuma-member=forged' }, 401],
    [{ cookie: h.cookies.ann, origin: 'https://foreign.invalid' }, 403],
    [{ cookie: h.cookies.ann, type: 'text/plain' }, 415],
  ])
    assert.equal((await unfinished(h, options)).status, status);
  assert.equal(h.calls.proposals, 0);
  assert.equal(h.calls.writes, 0);
  assert.deepEqual(await h.durable(), before);
});

test('knowledge proposal HTTP: malformed envelopes and declared oversized bodies fail before the service, absent owner and close fail closed', async (t) => {
  const h = await host(t),
    before = await h.durable();
  for (const body of [
    '{',
    JSON.stringify(envelope('save-draft', proposal())),
    JSON.stringify({ ...envelope('propose-draft', proposal()), rpcId: 123 }),
  ]) {
    assert.equal((await h.raw('propose-draft', body)).status, 400);
  }
  // The original Host rejects declared overflow before reading the body. Keep
  // it unfinished so fetch cannot race that real early reply with a large write.
  const oversized = await unfinished(h, {
    cookie: h.cookies.ann,
    contentLength: 1024 * 1024 + 1,
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).result.error.code, 'limit');
  assert.equal(h.calls.proposals, 0);
  assert.equal(h.calls.writes, 0);
  assert.deepEqual(await h.durable(), before);
  h.unpublish();
  const absent = await h.call('propose-draft', proposal());
  assert.equal(absent.status, 503);
  assert.equal(absent.json.result.error.code, 'unavailable');
  await h.http.close();
  assert.equal(h.calls.proposals, 0);
  assert.equal(h.calls.writes, 0);
  assert.deepEqual(await h.durable(), before);
});
