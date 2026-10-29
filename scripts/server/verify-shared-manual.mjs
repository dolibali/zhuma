/** Real original CLI/domain/member HTTP + real Client codecs and private
 * Credentials. Direct local-owner calls are a transport fixture, not GUI proof. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { startLocalServer, stopLocalServer } from './runtime.mjs';
import { HostSharedBackend } from '../../packages/dsh-adapter/dist/host-shared-backend.js';
import { createSharedBackendClient } from '../../packages/client/dist/identity/shared-backend.js';
import { createIdentityApi } from '../../packages/client/dist/identity/api.js';
import { createIdentityLifecycleApi } from '../../packages/client/dist/identity/lifecycle-api.js';
import { createMemberWorkbenchApi } from '../../packages/client/dist/workbench/member-api.js';
import { createExecutionHttpApi } from '../../packages/client/dist/execution/http.js';

const { values } = parseArgs({
  options: { sdk: { type: 'string' }, plugin: { type: 'string' } },
});
if (!values.sdk || !values.plugin) throw new Error('Pass explicit --sdk and frozen --plugin');
const sdk = resolve(values.sdk);
const { Context } = await import(pathToFileURL(join(sdk, 'vendor/cordis/lib/index.js')).href);
const { default: Credentials } = await import(
  pathToFileURL(join(sdk, 'packages/credentials/credentials-local/lib/index.js')).href
);
const directory = await mkdtemp(join(tmpdir(), 'zhuma-shared-manual-'));
const members = [],
  checks = [];
let child, origin;
const signal = () => AbortSignal.timeout(20_000);
const password = 'synthetic-manual-passphrase';
async function boot() {
  child = await startLocalServer({
    sdk: values.sdk,
    plugin: values.plugin,
    data: join(directory, 'backend'),
    port: 0,
  });
  origin = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Official backend startup timed out')), 45_000);
    const inspect = (chunk) => {
      const url = chunk.toString().match(/dsh web: (https?:\/\/\S+\?token=\S+)/u)?.[1];
      if (url) {
        clearTimeout(timer);
        done(new URL(url).origin);
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      fail(new Error('Official backend exited before readiness'));
    });
  });
  // Only the origin is used; never exchange/read/store the remote owner token.
}
async function member(accountId) {
  const ctx = new Context();
  const provider = ctx.plugin(Credentials, {
    path: join(directory, `${accountId}.yaml`),
    watch: false,
  });
  await provider;
  const owner = new HostSharedBackend(ctx);
  const client = createSharedBackendClient(
    {
      async call(_channel, endpoint, payload, wait) {
        const value =
          endpoint === 'zhuma-backend/status'
            ? await owner.status()
            : endpoint === 'zhuma-backend/select'
              ? await owner.select(payload)
              : await owner.request(payload, wait ?? signal());
        return { ok: true, value };
      },
    },
    () => {},
  );
  const identity = createIdentityApi(client.fetcher);
  const lifecycle = createIdentityLifecycleApi(client.fetcher);
  const value = { client, owner, provider, identity, lifecycle, accountId };
  members.push(value);
  await client.refresh();
  await client.select(origin, signal());
  await lifecycle.register({ requestId: randomUUID(), accountId, password }, signal());
  await identity.login({ accountId, password }, signal());
  return value;
}
function execution(member, spaceId) {
  return createExecutionHttpApi(
    member.client.fetcher,
    () => assert.fail('Unexpected expired member'),
    member.accountId,
    {
      spaceId,
      isCurrent: () => true,
      onUnavailable: () => assert.fail('Unexpected scope loss'),
    },
  );
}
const target = (node) => ({
  taskId: node.taskId,
  planId: node.planId,
  revision: node.revision,
  nodeId: node.nodeId,
});
const node = (id, patch = {}) => ({
  id,
  title: id === 'write' ? '整理接口约定' : '按已接受约定编写交付说明',
  description: '',
  assigneeId: 'ann',
  reviewRequired: false,
  reviewerIds: [],
  dependsOn: [],
  skillIds: [],
  mcpIds: [],
  input: '',
  output: '文字产物',
  rationale: '',
  position: { x: 0, y: 0 },
  ...patch,
});
try {
  await boot();
  const ann = await member('ann'),
    bob = await member('bob');
  const { spaceId } = await ann.lifecycle.createTeam(
    { requestId: randomUUID(), name: '正常人工交付团队' },
    signal(),
  );
  await ann.lifecycle.setMember(
    { requestId: randomUUID(), spaceId, accountId: 'bob', action: 'add' },
    signal(),
  );
  const workbench = createMemberWorkbenchApi(
    {
      actorId: 'ann',
      spaceId,
      isCurrent: () => true,
      onUnauthenticated: () => assert.fail('Unexpected identity loss'),
      onUnavailable: () => assert.fail('Unexpected directory loss'),
    },
    ann.client.fetcher,
  );
  let snapshot = await workbench.snapshot(signal());
  const command = async (command) => {
    snapshot = await workbench.command(
      { requestId: randomUUID(), expectedRevision: snapshot.state.revision, command },
      signal(),
    );
  };
  await command({
    type: 'create-project',
    project: { id: 'manual-project', name: '人工评审与下游', description: '' },
  });
  await command({
    type: 'create-task',
    task: {
      id: 'manual-task',
      projectId: 'manual-project',
      title: '文字交付、评审与下游',
      goal: '在原成员入口完成正式评审',
      ownerId: 'ann',
      participantIds: ['ann', 'bob'],
      workflows: [
        {
          id: 'main',
          name: '工作流',
          parentNodeId: null,
          nodes: [
            node('write', { reviewRequired: true, reviewerIds: ['bob'] }),
            node('downstream', { dependsOn: ['write'] }),
          ],
        },
      ],
    },
  });
  await command({ type: 'confirm-task', taskId: 'manual-task' });
  const plan = snapshot.state.appliedPlans.find((plan) => plan.taskId === 'manual-task');
  assert.ok(plan);
  const author = execution(ann, spaceId),
    reviewer = execution(bob, spaceId);
  await author.startPlan(
    {
      taskId: plan.taskId,
      planId: plan.id,
      revision: plan.revision,
      idempotencyKey: randomUUID(),
      spaceId,
    },
    signal(),
  );
  let write = (await author.inbox(signal())).nodes.find((item) => item.nodeId === 'write');
  assert.ok(write);
  const metadataResponse = await ann.client.fetcher('/api/zhuma-member/local-run-options', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: signal(),
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'zhuma-member/local-run-options',
      payload: { ...target(write), spaceId },
    }),
  });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.result.ok, true);
  assert.equal(metadata.result.value.currentRunId, null);
  assert.equal(metadata.result.value.currentRun, null);
  assert.equal(metadata.result.value.nodeVersion, write.version);
  assert.equal(metadata.result.value.models.kind, 'unavailable');
  assert.equal(Object.hasOwn(metadata.result.value, 'workspaces'), false);
  assert.equal(metadata.result.value.start.kind, 'available');
  assert.deepEqual(
    (await author.inbox(signal())).nodes.find((item) => item.nodeId === 'write'),
    write,
  );
  checks.push(
    'exact-member-local-metadata-keeps-actual-node-version-without-backend-model-or-directory-selection',
  );
  const saved = await author.saveDeliveryDraft(
    {
      ...target(write),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      text: '第一版：订单支持取消。',
      files: [],
      links: [],
    },
    signal(),
  );
  assert.equal((await author.readDeliveryDraft(target(write), signal())).text, saved.text);
  write = await author.submit(
    {
      ...target(write),
      expectedVersion: write.version,
      idempotencyKey: randomUUID(),
      text: saved.text,
    },
    signal(),
  );
  assert.equal(write.status, 'in-review');
  checks.push('normal-member-private-proxy-manual-start-draft-submit');
  let reviewed = (await reviewer.inbox(signal())).nodes.find((item) => item.nodeId === 'write');
  assert.equal(reviewed.artifacts.at(-1).text, saved.text);
  reviewed = await reviewer.ballot(
    {
      ...target(reviewed),
      expectedVersion: reviewed.version,
      idempotencyKey: randomUUID(),
      roundId: reviewed.currentRoundId,
      artifactVersionId: reviewed.artifacts.at(-1).id,
      action: 'request-changes',
      comment: '补充取消后的退款规则。',
    },
    signal(),
  );
  assert.equal(reviewed.status, 'needs-revision');
  const revision = await author.revision(target(write), signal());
  assert.ok(revision.notes.some((note) => note.body.includes('退款规则')));
  checks.push('fixed-review-text-visible-returned-opinion-visible-to-author');
  write = (await author.inbox(signal())).nodes.find((item) => item.nodeId === 'write');
  const revisedText = '第二版：订单支持取消，已支付订单原路退款。';
  write = await author.submit(
    {
      ...target(write),
      expectedVersion: write.version,
      idempotencyKey: randomUUID(),
      text: revisedText,
    },
    signal(),
  );
  reviewed = (await reviewer.inbox(signal())).nodes.find((item) => item.nodeId === 'write');
  assert.equal(reviewed.artifacts.at(-1).text, revisedText);
  reviewed = await reviewer.ballot(
    {
      ...target(reviewed),
      expectedVersion: reviewed.version,
      idempotencyKey: randomUUID(),
      roundId: reviewed.currentRoundId,
      artifactVersionId: reviewed.artifacts.at(-1).id,
      action: 'approve',
    },
    signal(),
  );
  assert.equal(reviewed.status, 'completed');
  const downstream = (await author.inbox(signal())).nodes.find(
    (item) => item.nodeId === 'downstream',
  );
  assert.equal(downstream.status, 'ready');
  const input = downstream.inputs.find((item) => item.access === 'visible');
  assert.ok(input);
  const read = async (api) =>
    api.upstreamContent(
      {
        ...target(downstream),
        sourceNodeId: input.sourceNodeId,
        artifactVersionId: input.artifactVersionId,
        expectedArtifactVersion: input.version,
      },
      signal(),
    );
  assert.equal((await read(author)).content.text, revisedText);
  checks.push('resubmit-fixed-second-version-review-approve-unlocks-downstream-accepted-body');
  const backendId = (await ann.owner.status()).backendId;
  await stopLocalServer(child);
  child = undefined;
  await boot();
  await ann.client.select(origin, signal());
  await ann.identity.login({ accountId: 'ann', password }, signal());
  assert.equal((await ann.owner.status()).backendId, backendId);
  assert.equal((await read(execution(ann, spaceId))).content.text, revisedText);
  checks.push('original-backend-cold-restart-retains-fixed-accepted-body');
  const bytes = await readFile(join(resolve(values.plugin), 'index.js'));
  console.log(
    JSON.stringify(
      {
        scope: 'actual-original-backend-manual-product-member-http-with-local-owner-call-fixture',
        checks,
        host: createHash('sha256').update(bytes).digest('hex'),
        limits: [
          'No GUI, paid model, native Agent or file bytes exercised',
          'Local owner RPC transport is a direct-call fixture; domain and remote HTTP are real',
          'No remote SDK owner exchange or private profile use',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (child) await stopLocalServer(child);
  for (const member of members.toReversed()) {
    member.client.close();
    await member.owner.close();
    await member.provider.dispose();
  }
  await rm(directory, { recursive: true, force: true });
}
