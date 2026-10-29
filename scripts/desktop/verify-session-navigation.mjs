import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, rm, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
  options: {
    sdk: { type: 'string' },
    'build-sdk': { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.sdk) throw Error('Pass --sdk with the public fixed SDK');
const sdk = resolve(values.sdk),
  buildSdk = resolve(values['build-sdk'] ?? values.sdk),
  source = join(root, 'upstream/deepseek-harness');
const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8'));
for (const cwd of new Set([sdk, source, buildSdk]))
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
    lock.upstreams.deepseekHarness.commit,
  );
const temp = await mkdtemp(join(tmpdir(), 'zhuma-navigation-'));
try {
  await cp(
    join(source, 'packages/client/ui-workspace/src'),
    join(temp, 'packages/client/ui-workspace/src'),
    { recursive: true },
  );
  execFileSync('git', ['init', '--quiet'], { cwd: temp });
  const patch = join(root, 'patches/deepseek-harness/zhuma-desktop.patch');
  execFileSync('git', ['apply', '--include=packages/client/ui-workspace/src/client/*', patch], {
    cwd: temp,
  });
  await symlink(
    join(sdk, 'packages/client/ui-workspace/node_modules'),
    join(temp, 'node_modules'),
    'dir',
  );
  await build({
    entryPoints: [join(temp, 'packages/client/ui-workspace/src/client/navigation.ts')],
    outfile: join(temp, 'navigation.mjs'),
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  await writeFile(
    join(temp, 'probe.mjs'),
    `
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
const {UiWorkspaceService}=await import('./navigation.mjs');
const checks=[];
function store(value){const listeners=new Set();return {getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},set(next){value=next;for(const fn of listeners)fn()}}}
function bench(saved){
 const backing=new Map(saved?[['dsh.sessions.current',JSON.stringify(saved)]]:[]);
 globalThis.localStorage={getItem:key=>backing.get(key)??null,setItem:(key,value)=>backing.set(key,value),removeItem:key=>backing.delete(key)};
 const ctx=new Context(),retained=[],revealed=[];
 let navigation=new AbortController();
 ctx.provide('layout',{beginNavigation(){navigation.abort();navigation=new AbortController();return navigation.signal},selectPanel(value){revealed.push(value)}});
 const workspaces=store({items:[],archivedSessionIds:[],pinnedSessionIds:[],phase:'pending',state:'loading',error:null});
 const sessions=store({ids:[],byId:{},phase:'pending',projectionsBySession:{}});
 const nav=new UiWorkspaceService(ctx,{}, {list:workspaces}, {list:sessions,retain(target){retained.push(target);return {sessionId:typeof target==='string'?target:target.childSessionId,release(){}}},subagentAddress(){return undefined},create(){throw Error('Navigation must not create Sessions')}},{pinSessionOrder(){}},()=>{});
 return {ctx,nav,retained,revealed,workspaces,sessions};
}
async function flush(){await tick();await tick()}
{
 const b=bench();b.nav.openSession('ordinary');assert.deepEqual(b.retained,['ordinary']);assert.deepEqual(b.revealed,[null]);await b.ctx.fiber.dispose();checks.push('unregistered-ordinary-path-preserved');
}
{
 const b=bench();let calls=0;b.nav.registerSessionNavigationGuard((target)=>{calls++;assert.equal(target,'task');return false});b.nav.openSession('task');assert.deepEqual(b.retained,[]);await flush();assert.equal(calls,1);assert.deepEqual(b.retained,[]);assert.deepEqual(b.revealed,[]);await b.ctx.fiber.dispose();checks.push('task-handled-before-retain-or-reveal');
}
{
 const b=bench(),pending=Promise.withResolvers();b.nav.registerSessionNavigationGuard(()=>pending.promise);b.nav.openSession('ordinary');await flush();assert.deepEqual(b.retained,[]);pending.resolve(true);await flush();assert.deepEqual(b.retained,['ordinary']);await b.ctx.fiber.dispose();checks.push('ordinary-retain-after-explicit-allow-only');
}
{
 const b=bench();b.nav.registerSessionNavigationGuard(()=>{throw Error('closed fixture')});b.nav.openSession('task');await flush();assert.deepEqual(b.retained,[]);await b.ctx.fiber.dispose();checks.push('lookup-error-never-falls-back');
}
{
 const b=bench(),pending=Promise.withResolvers();const stop=b.nav.registerSessionNavigationGuard(()=>pending.promise);b.nav.openSession('late');await flush();stop();const release=b.nav.registerSessionNavigationGuard(()=>true);stop();pending.resolve(true);await flush();assert.deepEqual(b.retained,[]);b.nav.openSession('current');await flush();assert.deepEqual(b.retained,['current']);release();await b.ctx.fiber.dispose();checks.push('replacement-and-late-unregister-fenced');
}
{
 const b=bench(),pending=Promise.withResolvers();b.nav.registerSessionNavigationGuard(()=>pending.promise);b.nav.openSession('late');await flush();b.ctx.layout.beginNavigation();pending.resolve(true);await flush();assert.deepEqual(b.retained,[]);await b.ctx.fiber.dispose();checks.push('other-panel-navigation-cancels-late-result');
}
{
 const b=bench(),pending=Promise.withResolvers();let oldSignal;b.nav.registerSessionNavigationGuard((target,signal)=>{if(target==='old'){oldSignal=signal;return pending.promise}return true});b.nav.openSession('old');await flush();b.nav.openSession('new');await flush();pending.resolve(true);await flush();assert.equal(oldSignal.aborted,true);assert.deepEqual(b.retained,['new']);await b.ctx.fiber.dispose();checks.push('new-session-selection-supersedes-old');
}
{
 const b=bench(),target={parentSessionId:'task-parent',childSessionId:'task-child'};let received;b.nav.registerSessionNavigationGuard(value=>{received=value;return false});b.nav.openSession(target);await flush();assert.equal(received,target);assert.deepEqual(b.retained,[]);await b.ctx.fiber.dispose();checks.push('actual-subagent-address-before-retain');
}
{
 const b=bench({sessionId:'saved-task'});let looked;b.nav.registerSessionNavigationGuard(target=>{looked=target;return false});b.sessions.set({ids:['saved-task'],byId:{'saved-task':{id:'saved-task',blank:false,updatedAt:0}},phase:'ready',projectionsBySession:{}});b.workspaces.set({items:[],archivedSessionIds:[],pinnedSessionIds:[],phase:'ready',state:'idle',error:null});await flush();assert.equal(looked,'saved-task');assert.deepEqual(b.retained,[]);await b.ctx.fiber.dispose();checks.push('cold-saved-selection-shares-central-guard');
}
{
 const b=bench(),pending=Promise.withResolvers();b.nav.registerSessionNavigationGuard(()=>pending.promise);b.nav.openSession('late');await flush();await b.ctx.fiber.dispose();pending.resolve(true);await flush();assert.deepEqual(b.retained,[]);checks.push('disposed-navigation-never-retains');
}
console.log(JSON.stringify({scope:'actual-patched-sdk-navigation-class-with-controller-fixtures',checks,limits:['Not a full SDK typecheck/build or browser/desktop/member-authority proof','No Agent, model, profile or task route is started']}));
`,
  );
  const output = execFileSync(process.execPath, [join(temp, 'probe.mjs')], {
    cwd: temp,
    encoding: 'utf8',
  });
  let artifact;
  if (values.output) {
    // Build only this original browser plugin with its official CSS, externals,
    // purity gate and ModuleLoader wrapper. Never rebuild or mutate the SDK.
    for (const file of [
      'packages/client/ui-workspace/package.json',
      'packages/client/tsdown.client.ts',
      'packages/client/modules/src/client/manifest.ts',
      'packages/client/web/src/platform.ts',
      'scripts/client-build-environment.ts',
      'scripts/experimental-package-policy.ts',
      'scripts/bundle-input-isolation.ts',
    ]) {
      await mkdir(dirname(join(temp, file)), { recursive: true });
      await cp(join(source, file), join(temp, file));
    }
    await symlink(
      join(buildSdk, 'node_modules'),
      join(temp, 'packages/client/node_modules'),
      'dir',
    );
    await symlink(
      join(buildSdk, 'packages/client/ui-workspace/node_modules'),
      join(temp, 'packages/client/ui-workspace/node_modules'),
      'dir',
    );
    await writeFile(
      join(temp, 'build-client.mjs'),
      `import {clientBundle} from './packages/client/tsdown.client.ts';
import {build} from ${JSON.stringify(pathToFileURL(join(buildSdk, 'node_modules/tsdown/dist/index.mjs')).href)};
const directory=new URL('./packages/client/ui-workspace',import.meta.url).pathname;
process.chdir(directory);
const config=clientBundle(directory,['lib/types/index.js'])({env:{}}).find(value=>value.name==='@deepseek-ai/dsh-client-ui-workspace/client');
if(!config) throw Error('Original Workspace client preset is unavailable');
await build({...config,config:false,cwd:directory,sourcemap:false});`,
    );
    execFileSync(
      process.execPath,
      ['--experimental-transform-types', join(temp, 'build-client.mjs')],
      {
        cwd: temp,
        // Only public build inputs; no inherited HOME, profile or model variables.
        env: { PATH: process.env.PATH, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const lib = join(temp, 'packages/client/ui-workspace/lib');
    assert.deepEqual(await readdir(lib), ['client.js']);
    const bytes = await readFile(join(lib, 'client.js'));
    for (const marker of [
      '__ModuleLoader__',
      '@deepseek-ai/dsh-client-ui-workspace',
      'registerSessionNavigationGuard',
    ])
      assert(bytes.includes(Buffer.from(marker)));
    const target = resolve(values.output);
    for (const input of [sdk, buildSdk, source])
      assert(target !== input && !target.startsWith(input + '/'), 'Output must be outside the SDK');
    artifact = {
      scope: 'actual-original-ui-workspace-browser-client-bundle',
      pin: lock.upstreams.deepseekHarness.commit,
      patch: createHash('sha256')
        .update(await readFile(patch))
        .digest('hex'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    await mkdir(target, { recursive: true });
    for (const [file, data] of [
      ['client.js', bytes],
      ['SOURCE.json', Buffer.from(JSON.stringify(artifact, null, 2) + '\n')],
    ]) {
      try {
        await writeFile(join(target, file), data, { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assert((await readFile(join(target, file))).equals(data), 'Existing output differs');
      }
    }
  }
  console.log(
    JSON.stringify({
      ...JSON.parse(output),
      pin: lock.upstreams.deepseekHarness.commit,
      patch: createHash('sha256')
        .update(await readFile(patch))
        .digest('hex'),
      ...(artifact ? { artifact, output: resolve(values.output) } : {}),
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
