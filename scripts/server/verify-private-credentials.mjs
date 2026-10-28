#!/usr/bin/env node
/** Real fixed SDK Credentials/Cordis proxy integration over fresh synthetic
 * files only. No existing profile, provider secret, browser cookie or model. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createMemberLocalPrivateStore } from '../../packages/dsh-adapter/dist/host-member-local-credentials.js';
import { MemberLocalExecutionSecrets } from '../../packages/dsh-adapter/dist/member-local-execution-secrets.js';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
if (!values.sdk) throw new Error('Pass --sdk with the fixed public SDK cut');
const sdk = resolve(values.sdk);
const { Context, symbols } = await import(
  pathToFileURL(join(sdk, 'vendor/cordis/lib/index.js')).href
);
const { default: Credentials } = await import(
  pathToFileURL(join(sdk, 'packages/credentials/credentials-local/lib/index.js')).href
);
const directory = await mkdtemp(join(tmpdir(), 'zhuma-private-provider-probe-'));
const filename = join(directory, 'synthetic-credentials.yaml');
const backendId = '00000000-0000-4000-8000-000000000001',
  actorId = 'synthetic-member';
const slot = `zhuma.member-local.device.${'a'.repeat(64)}`;
const contexts = [];
async function open() {
  const ctx = new Context();
  const fiber = ctx.plugin(Credentials, { path: filename, watch: false });
  contexts.push(fiber);
  await fiber;
  return { ctx, fiber };
}
try {
  const { ctx, fiber } = await open();
  const one = ctx.get('credentials'),
    two = ctx.get('credentials');
  assert.equal(Reflect.get(one, symbols.original), Reflect.get(two, symbols.original));
  const store = createMemberLocalPrivateStore(ctx, new AbortController().signal);
  assert.equal(await store.read(slot), undefined);
  assert.deepEqual(await store.modify(slot, () => ({ version: 1, synthetic: true })), {
    version: 1,
    synthetic: true,
  });
  assert.deepEqual(await store.read(slot), { version: 1, synthetic: true });
  const a = new MemberLocalExecutionSecrets(store),
    b = new MemberLocalExecutionSecrets(
      createMemberLocalPrivateStore(ctx, new AbortController().signal),
    );
  const [device, concurrent] = await Promise.all([
    a.device(backendId, actorId),
    b.device(backendId, actorId),
  ]);
  assert.equal(device.deviceId, concurrent.deviceId);
  assert.equal((await stat(filename)).mode & 0o077, 0);
  const reading = store.read(slot),
    closing = fiber.dispose();
  await assert.rejects(reading, { code: 'unavailable' });
  await closing;
  await assert.rejects(store.read(slot), { code: 'unavailable' });
  const { ctx: cold } = await open();
  const recovered = await new MemberLocalExecutionSecrets(
    createMemberLocalPrivateStore(cold, new AbortController().signal),
  ).device(backendId, actorId);
  assert.equal(recovered.deviceId, device.deviceId);
  const report = {
    scope: 'actual-sdk-credentials-cordis-proxy-synthetic-file-no-profile-model',
    proxyViewsDiffer: one !== two,
    checks: [
      'original-provider-identity',
      'real-provider-read-atomic-modify',
      'concurrent-device-idempotency',
      'private-file-mode',
      'late-close-and-closed-refusal',
      'cold-original-device-readback',
    ],
    limits: ['No backend connection/native Agent/model or two-Host execution acceptance'],
  };
  await mkdir(join(root, '.artifacts/server'), { recursive: true });
  await writeFile(
    join(root, '.artifacts/server/private-credentials-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fiber of contexts.reverse()) await fiber.dispose();
  await rm(directory, { recursive: true, force: true });
}
