#!/usr/bin/env node
/** Focused original SDK Gateway dispatch contracts. No profile, model or GUI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { sdk: { type: 'string' } } });
if (!values.sdk) throw new Error('Pass --sdk with the built fixed public SDK');
const sdk = resolve(values.sdk),
  source = join(root, 'upstream/deepseek-harness');
const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
for (const path of [sdk, source])
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(),
    lock.upstreams.deepseekHarness.commit,
  );
const directory = await mkdtemp(join(tmpdir(), 'zhuma-session-admission-'));
try {
  await cp(join(source, 'packages/api/gateway/src'), join(directory, 'packages/api/gateway/src'), {
    recursive: true,
  });
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync(
    'git',
    [
      'apply',
      '--include=packages/api/gateway/src/*',
      join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
    ],
    { cwd: directory },
  );
  await symlink(
    join(sdk, 'packages/api/gateway/node_modules'),
    join(directory, 'node_modules'),
    'dir',
  );
  await build({
    entryPoints: [join(directory, 'packages/api/gateway/src/index.ts')],
    outfile: join(directory, 'gateway.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    logLevel: 'silent',
  });
  const probe = `
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import Registry from '@deepseek-ai/dsh-typert-registry';
import Access from '@deepseek-ai/dsh-api-remote-access';
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import Gateway from './gateway.mjs';
let invoked = 0, looked = 0, admitted = 0, archiveWrites = 0, stopEvents = 0;
class Sessions extends Service {
  typertRemote = bindTypertRemote(this, 'admissionFixture', { namespace: 'session' });
  constructor(ctx) { super(ctx, 'admissionFixture'); }
  invoke(agent, request) { invoked++; return { id: agent.id, sessionId: request.sessionId }; }
  async *follow(agent, request) { invoked++; yield { id: agent.id, sessionId: request.sessionId }; }
}
class Workspaces extends Service {
  typertRemote = bindTypertRemote(this, 'admissionWorkspaceFixture', { namespace: 'workspace' });
  constructor(ctx) { super(ctx, 'admissionWorkspaceFixture'); }
  archiveSession(request) { archiveWrites++; if (request.stopActivity === true) stopEvents++; return { archivedSessionIds: [request.sessionId] }; }
}
const methods = ['create', 'prompt', 'updateQueue', 'cancel', 'rename', 'fork', 'selectModel', 'attachment', 'projections', 'page'];
const codec = (schema) => ({ mode: 'strict', typeSymbol: '@zhuma/probe#Value', create: () => schema });
async function setup(required) {
  const ctx = new Context(); await ctx.plugin(Registry); await ctx.plugin(Access); await ctx.plugin(Gateway, { sessionAdmissionRequired: required }); await ctx.plugin(Sessions); await ctx.plugin(Workspaces);
  ctx.typert.lookups.register('admissionFixture', { parameter: 'agent', wire: 'agentId', hostTypeSymbol: '@zhuma/probe#Agent', wireTypeSymbol: '@zhuma/probe#AgentId', resolve: (id) => { looked++; return { id }; } });
  ctx.typert.register({ package: '@zhuma/probe', face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: [...methods, 'follow'].map(method => ({
    id: '@zhuma/probe#session/' + method, namespace: 'session', service: 'admissionFixture', method, implementation: method === 'follow' ? 'follow' : 'invoke', invocation: { kind: 'direct' },
    ...(method === 'follow' ? { mode: 'stream' } : {}), parameters: [{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'admissionFixture', codec: { ...codec(z.string()), typeSymbol: '@zhuma/probe#AgentId' } }, { name: 'request', wire: 'request', source: 'json', codec: codec(z.object({ sessionId: z.string() })) }], result: codec(z.object({ id: z.string(), sessionId: z.string() })),
  })) });
  ctx.typert.register({ package: '@zhuma/archive-probe', face: 'host', model: { services: [], events: [], objects: [] }, schemas: [], invocations: [{
    id: '@zhuma/archive-probe#workspace/archiveSession', namespace: 'workspace', service: 'admissionWorkspaceFixture', method: 'archiveSession', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(z.object({ sessionId: z.string(), stopActivity: z.boolean().optional() })) }], result: codec(z.object({ archivedSessionIds: z.array(z.string()) })),
  }] });
  const peer = new Peer(ctx, { principal: { kind: 'owner' } });
  const request = (method, id) => ({ namespace: 'session', method, args: { agentId: id, request: { sessionId: id } }, peer });
  const archive = (id) => ({ namespace: 'workspace', method: 'archiveSession', args: { request: { sessionId: id, stopActivity: true } }, peer });
  return { ctx, request, archive };
}
const h = await setup(true);
try {
  await assert.rejects(h.ctx.typertGateway.invoke(h.request('prompt', 'task')));
  assert.equal(looked, 0); assert.equal(invoked, 0);
  const unregister = h.ctx.typertGateway.registerSessionAdmission(async (_method, args) => { admitted++; return args.request.sessionId === 'ordinary'; });
  for (const method of methods) await assert.rejects(h.ctx.typertGateway.invoke(h.request(method, 'task')));
  await assert.rejects(h.ctx.typertGateway.stream(h.request('follow', 'task')));
  assert.equal(looked, 0); assert.equal(invoked, 0);
  await assert.rejects(h.ctx.typertGateway.invoke({ ...h.request('prompt', 'ordinary'), args: { agentId: 'ordinary', request: { sessionId: 42 } } }));
  assert.equal(admitted, methods.length + 1);
  await assert.rejects(h.ctx.typertGateway.invoke(h.archive('task')));
  assert.equal(archiveWrites, 0); assert.equal(stopEvents, 0);
  assert.deepEqual(await h.ctx.typertGateway.invoke(h.archive('ordinary')), { archivedSessionIds: ['ordinary'] });
  assert.equal(archiveWrites, 1); assert.equal(stopEvents, 1);
  assert.deepEqual(await h.ctx.typertGateway.invoke(h.request('prompt', 'ordinary')), { id: 'ordinary', sessionId: 'ordinary' });
  assert.equal(looked, 1); assert.equal(invoked, 1);
  unregister();
  await assert.rejects(h.ctx.typertGateway.invoke(h.request('prompt', 'ordinary')));
  assert.equal(looked, 1); assert.equal(invoked, 1);
  const pending = Promise.withResolvers();
  const stop = h.ctx.typertGateway.registerSessionAdmission(() => pending.promise);
  const late = h.ctx.typertGateway.invoke(h.request('prompt', 'ordinary')); stop(); pending.resolve(true);
  await assert.rejects(late); assert.equal(looked, 1); assert.equal(invoked, 1);
} finally { await h.ctx.fiber.dispose(); }
const plain = await setup(false);
try { assert.equal((await plain.ctx.typertGateway.invoke(plain.request('prompt', 'ordinary'))).sessionId, 'ordinary'); }
finally { await plain.ctx.fiber.dispose(); }
console.log(JSON.stringify({ checks: ['required-before-registration', 'ten-unary-task-commands-before-lookup', 'mux-follow-before-lookup', 'schema-before-admission', 'ordinary-unchanged', 'unload-fails-closed', 'late-admission-refused', 'unconfigured-sdk-unchanged', 'task-archive-no-write-or-stop', 'ordinary-archive-preserved'], taskLookups: 0, taskInvocations: 0, taskArchiveWrites: 0, taskArchiveStops: 0 }));
`;
  await writeFile(join(directory, 'probe.mjs'), probe);
  const output = execFileSync(process.execPath, [join(directory, 'probe.mjs')], {
    cwd: directory,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: directory, DSH_HOME: join(directory, 'dsh') },
    timeout: 30_000,
  });
  const result = JSON.parse(output.trim().split('\n').at(-1));
  const report = {
    scope: 'actual-patched-sdk-gateway-dispatch-contract-no-native-agent-model-gui',
    ...result,
    patch: createHash('sha256')
      .update(await readFile(join(root, 'patches/deepseek-harness/zhuma-desktop.patch')))
      .digest('hex'),
    limits: [
      'Fixture service and lookup; not a real SessionController or native Agent',
      'No GUI, two-Host or cross-machine acceptance',
    ],
  };
  await mkdir(join(root, '.artifacts/server'), { recursive: true });
  await writeFile(
    join(root, '.artifacts/server/session-admission-proof.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
