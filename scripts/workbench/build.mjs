import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicTeamStarterPackages } from '../lib/team-starter-packages.mjs';
import { publicMemberTemplates } from '../lib/member-template-defaults.mjs';
import { publicMemberEngineeringSkills } from '../lib/member-engineering-skills.mjs';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hostOnly = process.argv.slice(2).includes('--host-only');
if (process.argv.slice(2).some((arg) => arg !== '--host-only'))
  throw new Error('Unknown workbench build option');
const adapterManifest = JSON.parse(
  await readFile(resolve(root, 'packages/dsh-adapter/package.json'), 'utf8'),
);
const compile = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-b',
    ...(hostOnly ? ['packages/agent-core', 'packages/context'] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (compile.error || compile.status !== 0) throw new Error('Workbench type build failed.');
const out = resolve(root, '.build/workbench');
await mkdir(out, { recursive: true });
let codeArtsBuild;
if (!hostOnly) {
  codeArtsBuild = await build({
    absWorkingDir: root,
    entryPoints: ['packages/dsh-adapter/src/executors/codearts/main.ts'],
    outfile: resolve(out, 'codearts-acp.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
  });
  const policyBuild = await build({
    absWorkingDir: root,
    entryPoints: ['packages/dsh-adapter/src/host-codearts-policy.ts'],
    outfile: resolve(out, 'codearts-policy.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    metafile: true,
    external: ['@deepseek-ai/cordis'],
    banner: {
      js: 'import { createRequire as __zhumaCreateRequire } from "node:module"; const require = __zhumaCreateRequire(import.meta.url);',
    },
  });
  for (const result of [codeArtsBuild, policyBuild])
    if (
      Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .some(
          (item) => item.external && !isBuiltin(item.path) && item.path !== '@deepseek-ai/cordis',
        )
    )
      throw Error('CodeArts launch artifacts gained an external runtime dependency.');
  codeArtsBuild.metafile.inputs = {
    ...codeArtsBuild.metafile.inputs,
    ...policyBuild.metafile.inputs,
  };
  const launchSources = Object.fromEntries(
    await Promise.all(
      Object.keys(codeArtsBuild.metafile.inputs)
        .filter((path) => path.startsWith('packages/'))
        .sort()
        .map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(resolve(root, path)))
            .digest('hex'),
        ]),
    ),
  );
  await writeFile(
    resolve(out, 'codearts-acp.manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        sourceFiles: launchSources,
        entry: 'codearts-acp.js',
        sha256: createHash('sha256')
          .update(await readFile(resolve(out, 'codearts-acp.js')))
          .digest('hex'),
        acpProtocolSdk: adapterManifest.dependencies['@agentclientprotocol/sdk'],
        policySha256: createHash('sha256')
          .update(await readFile(resolve(out, 'codearts-policy.js')))
          .digest('hex'),
        scope: 'Self-contained launch artifact; not CLI, model, login or business readiness',
      },
      null,
      2,
    ) + '\n',
  );
}
const engineeringSkills = await publicMemberEngineeringSkills();
// The official Web bundle exposes Connection to this plugin, not every SDK
// peer of its base bundle. Bundle only the pure definition/key helpers; live
// services and Cordis must continue to come from the official Host instance.
const bundledSdkHelpers = new Set([
  // Only AttachmentId's pure string brand; the live provider stays ctx.attachments.
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage',
]);
const hostBuild = await build({
  absWorkingDir: root,
  entryPoints: ['packages/dsh-adapter/src/host-plugin.ts'],
  outfile: resolve(out, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  metafile: true,
  target: 'node24',
  sourcemap: false,
  // Derived from the original public source files; no runtime repo/profile path.
  define: {
    ZHUMA_PUBLIC_TEAM_PACKAGES: JSON.stringify(await publicTeamStarterPackages()),
    ZHUMA_PUBLIC_MEMBER_TEMPLATES: JSON.stringify(await publicMemberTemplates()),
    ZHUMA_PUBLIC_ENGINEERING_SKILLS: JSON.stringify(engineeringSkills.bundle),
  },
  // Bundled ZIP dependencies are CommonJS and use Node built-ins. Keep their
  // require calls valid in the official Host's ESM plugin, without runtime installs.
  banner: {
    js: 'import { createRequire as __zhumaCreateRequire } from "node:module"; const require = __zhumaCreateRequire(import.meta.url);',
  },
  plugins: [
    {
      name: 'official-host-services',
      setup(builder) {
        builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
          bundledSdkHelpers.has(args.path) ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
const hostSdkImports = Object.values(hostBuild.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.path.startsWith('@deepseek-ai/'))
  .map((entry) => entry.path);
const verifiedHostExternals = new Set([
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  // The official Web overlay declares these exact SDK peers and lock entries.
  // They remain the Host's live modules, including persistence error identity.
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-sandbox-policy',
]);
if (
  !hostSdkImports.includes('@deepseek-ai/dsh-client-connection') ||
  hostSdkImports.some((name) => !verifiedHostExternals.has(name))
)
  throw new Error('Workbench Host gained an unverified external SDK dependency.');
const hostCode = await readFile(resolve(out, 'index.js'), 'utf8');
if (
  /\b(?:class\s+(?:AttachmentStore|CredentialProvider|Storage|BackendRegistry|DomainFacility|DomainImpl|JsonStorageBackend)|(?:AttachmentStore|CredentialProvider|Storage|BackendRegistry|DomainFacility|DomainImpl|JsonStorageBackend)(?:\d+)?\s*=\s*class)\b/u.test(
    hostCode,
  )
)
  throw new Error('Workbench bundled a live SDK storage or credentials service implementation.');
if (hostOnly) {
  const launch = JSON.parse(await readFile(resolve(out, 'codearts-acp.manifest.json'), 'utf8'));
  if (!launch.sourceFiles || !Object.keys(launch.sourceFiles).length)
    throw Error('Launch inputs missing; run the complete workbench build.');
  for (const [path, digest] of Object.entries(launch.sourceFiles)) {
    if (
      !path.startsWith('packages/') ||
      path.includes('..') ||
      createHash('sha256')
        .update(await readFile(resolve(root, path)))
        .digest('hex') !== digest
    )
      throw Error('Launch inputs changed; run the complete workbench build.');
  }
  // A Host refresh cannot silently change the already assembled peer graph/UI.
  const previous = JSON.parse(await readFile(resolve(out, 'package.json'), 'utf8'));
  const peers = [...new Set(hostSdkImports)].sort();
  if (
    JSON.stringify(Object.keys(previous.peerDependencies).sort()) !== JSON.stringify(peers) ||
    peers.some(
      (name) =>
        previous.peerDependencies[name] !==
        (adapterManifest.dependencies?.[name] ?? adapterManifest.devDependencies?.[name]),
    )
  )
    throw new Error('Host SDK peers changed; run the complete workbench build first.');
  for (const name of ['client.js', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'])
    await readFile(resolve(out, name));
  for (const name of ['codearts-acp.js', 'codearts-acp.manifest.json', 'codearts-policy.js'])
    await readFile(resolve(out, name));
  const retainedLicenses = await readFile(resolve(out, 'THIRD_PARTY_LICENSES.txt'), 'utf8');
  if (engineeringSkills.licenses.some(({ text }) => !retainedLicenses.includes(text)))
    throw new Error('Engineering Skill licenses changed; run the complete workbench build.');
  console.log('Built Host only in .build/workbench; existing Client and legal files retained.');
} else {
  const memberWebBuild = await build({
    absWorkingDir: root,
    entryPoints: ['packages/client/src/web/entry.tsx'],
    outfile: resolve(out, 'member-web.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    target: 'es2022',
    loader: { '.css': 'text' },
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (Object.keys(memberWebBuild.metafile.inputs).some((name) => name.includes('@deepseek-ai')))
    throw new Error('Member Web must not bundle SDK owner/runtime modules.');
  const clientBuild = await build({
    absWorkingDir: root,
    entryPoints: ['packages/client/src/workbench/plugin.tsx'],
    outfile: resolve(out, 'client.js'),
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    metafile: true,
    target: 'es2022',
    loader: { '.css': 'text' },
    minify: true,
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js: 'window.__ModuleLoader__.load({id:"@zhuma/workbench",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    },
    footer: { js: 'return module.exports;}});' },
  });
  await writeFile(
    resolve(out, 'package.json'),
    JSON.stringify(
      {
        name: '@zhuma/workbench',
        version: adapterManifest.version,
        private: true,
        license: 'MIT',
        type: 'module',
        main: './index.js',
        zhuma: { codeArtsLaunch: 1 },
        exports: {
          '.': './index.js',
          './client': './client.js',
          './package.json': './package.json',
        },
        peerDependencies: Object.fromEntries(
          [...new Set(hostSdkImports)].sort().map((name) => {
            // Every external is already pinned in the owning package manifest.
            const version =
              adapterManifest.dependencies?.[name] ?? adapterManifest.devDependencies?.[name];
            if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u.test(version))
              throw new Error(`Missing exact Host SDK peer version: ${name}`);
            return [name, version];
          }),
        ),
        dsh: {
          client: {
            platform: 'web',
            inject: [
              '@deepseek-ai/dsh-client-ui-layout',
              '@deepseek-ai/dsh-client-ui-sidebar',
              '@deepseek-ai/dsh-client-ui-renderer',
              '@deepseek-ai/dsh-client-ui-theme',
              '@deepseek-ai/dsh-client-ui-workspace',
              '@deepseek-ai/dsh-client-connection',
            ],
          },
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Built Host/Client plugin in .build/workbench');

  await writeFile(resolve(out, 'LICENSE'), await readFile(resolve(root, 'LICENSE')));
  // Preserve the full license text for every bundled dependency, including transitive modules.
  const licenses = new Map();
  licenses.set(
    'Zhuma engineering workflow sources',
    await readFile(resolve(root, 'resources/workflows/engineering-starter/LICENSE.txt'), 'utf8'),
  );
  for (const { name, text } of engineeringSkills.licenses)
    licenses.set(`Zhuma engineering Skill ${name}`, `${name}\n${text}`);
  for (const input of [
    ...Object.keys(hostBuild.metafile.inputs),
    ...Object.keys(clientBuild.metafile.inputs),
    ...Object.keys(memberWebBuild.metafile.inputs),
    ...Object.keys(codeArtsBuild.metafile.inputs),
  ]) {
    if (!input.includes('node_modules/')) continue;
    let directory = dirname(resolve(root, input));
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (manifest.name && !manifest.name.startsWith('@zhuma/')) {
          if (!licenses.has(manifest.name)) {
            const files = (await readdir(directory)).filter((name) =>
              /^(licen[sc]e|copying|notice)(\.|$)/iu.test(name),
            );
            if (!files.length) throw new Error(`Missing bundled license: ${manifest.name}`);
            const content = await Promise.all(
              files.map((name) => readFile(resolve(directory, name), 'utf8')),
            );
            licenses.set(
              manifest.name,
              `${manifest.name}@${manifest.version}\n${content.join('\n')}`,
            );
          }
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
  }
  await writeFile(
    resolve(out, 'THIRD_PARTY_LICENSES.txt'),
    [...licenses.values()].sort().join('\n\n--------------------\n\n'),
  );
}
