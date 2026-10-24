import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const compile = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/typescript/bin/tsc'), '-b'],
  { cwd: root, stdio: 'inherit' },
);
if (compile.error || compile.status !== 0) throw new Error('Workbench type build failed.');
const out = resolve(root, '.build/workbench');
await mkdir(out, { recursive: true });
// The official Web bundle exposes Connection to this plugin, not every SDK
// peer of its base bundle. Bundle only the pure definition/key helpers; live
// services and Cordis must continue to come from the official Host instance.
const bundledSdkHelpers = new Set([
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
]);
if (
  !hostSdkImports.includes('@deepseek-ai/dsh-client-connection') ||
  hostSdkImports.some((name) => !verifiedHostExternals.has(name))
)
  throw new Error('Workbench Host gained an unverified external SDK dependency.');
const hostCode = await readFile(resolve(out, 'index.js'), 'utf8');
if (
  /\b(?:class\s+(?:CredentialProvider|Storage|BackendRegistry|DomainFacility|DomainImpl|JsonStorageBackend)|(?:CredentialProvider|Storage|BackendRegistry|DomainFacility|DomainImpl|JsonStorageBackend)(?:\d+)?\s*=\s*class)\b/u.test(
    hostCode,
  )
)
  throw new Error('Workbench bundled a live SDK storage or credentials service implementation.');
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
      version: '0.1.0',
      private: true,
      license: 'UNLICENSED',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: {
        client: {
          platform: 'web',
          inject: [
            '@deepseek-ai/dsh-client-ui-layout',
            '@deepseek-ai/dsh-client-ui-sidebar',
            '@deepseek-ai/dsh-client-ui-renderer',
            '@deepseek-ai/dsh-client-ui-theme',
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

// Preserve the full license text for every bundled dependency, including transitive modules.
const licenses = new Map();
for (const input of [
  ...Object.keys(hostBuild.metafile.inputs),
  ...Object.keys(clientBuild.metafile.inputs),
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
