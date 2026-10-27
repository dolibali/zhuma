/** Build-source privacy contracts and an optional pinned-compiler probe; no installer or GUI proof. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  assertNoAbsoluteSourceRegions,
  verifyBuildSourcePaths,
} from '../../../scripts/desktop/verify-build-source-paths.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = join(root, 'upstream/deepseek-harness');
const files = [
  'tsdown.config.ts',
  'apps/desktop/tsdown.config.ts',
  'scripts/build.ts',
  'apps/desktop/scripts/prepare-dsh.ts',
  'packages/experimental/inspector/scripts/devtools/vite.ts',
];
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-source-privacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function patched(t) {
  const directory = await temporary(t);
  for (const file of files) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await copyFile(join(sdk, file), join(directory, file));
  }
  if (process.env.ZHUMA_SOURCE_PRIVACY_BASELINE !== '1')
    execFileSync(
      'git',
      [
        'apply',
        ...files.map((file) => `--include=${file}`),
        join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
      ],
      { cwd: directory },
    );
  return directory;
}
function parsed(text) {
  return ts.createSourceFile('config.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function expression(text, bindings) {
  text = text.replaceAll(
    'import.meta.url',
    JSON.stringify('file:///sdk/apps/desktop/tsdown.config.ts'),
  );
  const javascript = ts.transpileModule(`const result = ${text};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(bindings), `${javascript}\nreturn result;`)(
    ...Object.values(bindings),
  );
}
test('SDK patched source contract: root host/client and every independent desktop bundle disable only debug regions', async (t) => {
  const directory = await patched(t);
  const rootSource = parsed(await readFile(join(directory, files[0]), 'utf8'));
  const rootFactory = rootSource.statements.find(ts.isExportAssignment).expression.arguments[0];
  const factory = expression(
    rootFactory.getText(rootSource).replaceAll('import.meta.dirname', "'/sdk'"),
    {
      isBuildFaceClient: (face) => face === 'client',
      globSync: () => ['packages/client/example/package.json'],
      workspacePackageGlobs: () => ['packages/client/example'],
      typertPlugin: () => ({}),
      WORKSPACE_TYPERT_FACES: [],
    },
  );
  for (const face of ['host', 'client']) {
    const config = factory({ env: { DSH_BUILD_FACE: face } });
    assert.equal(config.inputOptions?.experimental?.attachDebugInfo, 'none');
    assert.equal(
      config.outputOptions?.comments,
      undefined,
      'legal comments retain original policy',
    );
    assert.equal(config.sourcemap, undefined, 'original map policy retained');
  }
  const desktopSource = parsed(await readFile(join(directory, files[1]), 'utf8'));
  const desktopArray = desktopSource.statements.find(ts.isExportAssignment).expression.arguments[0];
  const desktop = expression(desktopArray.getText(desktopSource), {
    packagedImportsPlugin: () => ({}),
    mainProcessImports: {},
    preloadImports: {},
    clientVersionDefine: {},
  });
  assert.equal(desktop.length, 7);
  for (const config of desktop)
    assert.equal(config.inputOptions?.experimental?.attachDebugInfo, 'none');
  const devtoolsSource = parsed(await readFile(join(directory, files[4]), 'utf8'));
  const property = (node, name) =>
    node.properties.find((p) => p.name?.getText(devtoolsSource) === name)?.initializer;
  const viteOptions = [];
  function inspect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(devtoolsSource) === 'build')
      viteOptions.push(
        property(
          property(
            property(property(node.arguments[0], 'build'), 'rolldownOptions'),
            'experimental',
          ),
          'attachDebugInfo',
        ),
      );
    ts.forEachChild(node, inspect);
  }
  inspect(devtoolsSource);
  assert.equal(viteOptions.length, 2, 'independent injected and main DevTools Vite builds');
  for (const option of viteOptions) assert.equal(option?.text, 'none');
  const welcomeOptions = [];
  function inspectWelcome(node) {
    if (ts.isCallExpression(node) && node.expression.getText(desktopSource) === 'build') {
      let value = node.arguments[0];
      for (const name of ['build', 'rolldownOptions', 'experimental', 'attachDebugInfo'])
        value = value?.properties?.find(
          (p) => p.name?.getText(desktopSource) === name,
        )?.initializer;
      welcomeOptions.push(value?.text);
    }
    ts.forEachChild(node, inspectWelcome);
  }
  inspectWelcome(desktopSource);
  assert.deepEqual(welcomeOptions, ['none'], 'nested welcome Vite call has its own native option');
});

const kinds = ['css', 'inline-css', 'global-css', 'devtools:css'];
const marker = (kind, buildRoot = '/build/sdk') =>
  `//#region \\0dsh-${kind}:${buildRoot}/packages/client/example/src/test.css.mjs`;
test('source verifier contract: reject the four confirmed and unknown absolute line-comment shapes without echoing paths', () => {
  for (const kind of kinds) {
    for (const buildRoot of ['/build/sdk', 'C:\\build\\sdk', '\\\\host\\share\\sdk']) {
      assert.throws(
        () =>
          assertNoAbsoluteSourceRegions(`  ${marker(kind, buildRoot)}\nexport const value = 1;`),
        (error) =>
          /Absolute build-source region marker/.test(error.message) &&
          !error.message.includes(buildRoot),
      );
    }
  }
  for (const text of [
    '//#region /unknown/root/input.js',
    '//#region \\0future-css:/unknown/root/input.css.mjs',
    '//#region file:///unknown/root/input.js',
    'export const value = 1;\n//#region /unknown/root/trailing.js',
  ])
    assert.throws(() => assertNoAbsoluteSourceRegions(text), /Absolute build-source/);
});
test('source verifier contract: preserve licenses, public examples, strings, templates and relative labels', () => {
  const text = [
    '/*! @license Copyright Example */',
    '// Public example: /Users/example/project',
    `const quoted = ${JSON.stringify(marker('css'))};`,
    'const regex = /\\/\\/#region \\\\0dsh-css:\\/synthetic\\/sdk\\/file.css.mjs/;',
    'const template = `',
    marker('inline-css'),
    '${1}',
    marker('global-css'),
    '`;',
    '/*',
    marker('devtools:css'),
    '*/',
    '//#region packages/client/example/src/index.js',
    '//#region \\0dsh-css:packages/client/example/src/test.css.mjs',
    '//# sourceMappingURL=client.js.map',
  ].join('\n');
  assert.equal(
    parsed(text).parseDiagnostics.length,
    0,
    'valid string/template/block/regex controls',
  );
  assert.doesNotThrow(() => assertNoAbsoluteSourceRegions(text));
});
test('source verifier contract: reject real comments at closing punctuation and within template expressions', () => {
  const comment = marker('css', '/synthetic/build');
  for (const text of [
    `export const value = [\n${comment}\n];`,
    `export const value = {\n${comment}\n};`,
    `const value = example(\n${comment}\n);`,
    `function example(\n${comment}\n) {}`,
    `function example() {\n${comment}\n}`,
    `const value = 1\n${comment}\n;`,
    'const value = `text ${[\n' + comment + '\n]}`;',
    `const value = [/pattern/,\n${comment}\n];`,
  ]) {
    assert.equal(parsed(text).parseDiagnostics.length, 0, 'valid JavaScript punctuation boundary');
    assert.throws(() => assertNoAbsoluteSourceRegions(text), /Absolute build-source/);
  }
});
test('source verifier contract: scan generated SDK and copied runtime outputs read-only, reject absent output', async (t) => {
  const directory = await temporary(t);
  const artifact = 'packages/client/example/lib/client.js';
  const runtime = 'node_modules/@deepseek-ai/example/lib/client.js';
  await assert.rejects(async () => verifyBuildSourcePaths(directory), /matched no generated/);
  await mkdir(dirname(join(directory, artifact)), { recursive: true });
  const raw = `${marker('css')}\nexport const value = 1;\n`;
  await writeFile(join(directory, artifact), raw);
  assert.throws(
    () => verifyBuildSourcePaths(directory),
    /packages\/client\/example\/lib\/client.js/,
  );
  assert.equal(
    await readFile(join(directory, artifact), 'utf8'),
    raw,
    'gate never rewrites output',
  );
  await writeFile(join(directory, artifact), '/*! @license preserved */\nexport const value = 1;');
  assert.doesNotThrow(() => verifyBuildSourcePaths(directory));
  await mkdir(dirname(join(directory, runtime)), { recursive: true });
  await writeFile(join(directory, runtime), raw);
  assert.throws(
    () =>
      verifyBuildSourcePaths(directory, [
        'node_modules/@deepseek-ai/*/{lib,dist}/**/*.{js,mjs,cjs}',
      ]),
    /Build source verification failed/,
  );
});
test('SDK patched source contract: source checks run before original artifact records and runtime signing/descriptors', async (t) => {
  const directory = await patched(t);
  const build = parsed(await readFile(join(directory, files[2]), 'utf8'));
  const main = build.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'main',
  );
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(build));
    ts.forEachChild(node, visit);
  }
  visit(main);
  assert.ok(calls.indexOf('verifyBuildSourcePaths') > calls.indexOf('runAggregate'));
  assert.ok(calls.indexOf('writeClientBuildRecord') > calls.indexOf('verifyBuildSourcePaths'));
  const runtime = await readFile(join(directory, files[3]), 'utf8');
  const verification = runtime.indexOf('verifyBuildSourcePaths(DSH_OUTPUT_ROOT,');
  assert.ok(verification > runtime.indexOf("'runtime:materialize-modules'"));
  assert.ok(verification < runtime.indexOf("'sign:dsh-native'"));
  assert.ok(verification < runtime.indexOf("'runtime:write-descriptor'"));
  const prepare = await readFile(join(root, 'scripts/desktop/prepare.mjs'), 'utf8');
  assert.match(prepare, /readFileSync\(sourceVerifier\)/);
  assert.match(prepare, /copyFileSync\(sourceVerifier, stagedSourceVerifier\)/);
  assert.match(prepare, /sha256\(readFileSync\(stagedSourceVerifier\)\)/);
});

const toolchain = process.env.ZHUMA_DESKTOP_SOURCE_TOOLCHAIN ?? sdk;
const toolEntry = join(toolchain, 'node_modules/tsdown/dist/index.mjs');
for (const compiler of ['tsdown', 'vite', 'vite-minified'])
  test(
    `pinned ${compiler} compiler contract: four CSS region leaks fail before, native option preserves legal text, runtime tokens and valid maps`,
    {
      skip: !existsSync(toolEntry) && 'requires an explicitly installed pinned SDK toolchain',
    },
    async (t) => {
      const directory = await temporary(t);
      const { build, Rolldown } = await import(pathToFileURL(toolEntry).href);
      const manifest = JSON.parse(
        await readFile(join(toolchain, 'node_modules/tsdown/package.json'), 'utf8'),
      );
      assert.equal(manifest.version, '0.22.2');
      assert.equal(Rolldown.VERSION, '1.1.1');
      const viteEntry = join(toolchain, 'node_modules/vite/dist/node/index.js');
      const vite = compiler.startsWith('vite')
        ? await import(pathToFileURL(viteEntry).href)
        : undefined;
      if (vite) {
        const require = createRequire(await realpath(viteEntry));
        assert.equal(require('vite/package.json').version, '8.2.2');
        assert.equal(require('rolldown/package.json').version, '1.2.7');
      }
      const entry =
        kinds.map((kind, i) => `import css${i} from '${kind}';`).join('\n') +
        '\nexport const styles = [css0, css1, css2, css3];\n';
      function tokens(code) {
        const source = ts.createSourceFile(
          'bundle.js',
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const result = [];
        function visit(node) {
          const children = node.getChildren(source);
          if (children.length) children.forEach(visit);
          else result.push([node.kind, node.getText(source)]);
        }
        visit(source);
        return result;
      }
      const observations = [];
      for (const [index, mode] of ['simple', 'none', 'none'].entries()) {
        const cwd = join(directory, index === 2 ? 'different-long-build-root' : 'sdk');
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
        await writeFile(join(cwd, 'entry.js'), entry);
        const outDir = join(cwd, mode);
        const plugins = [
          {
            name: 'original-css-virtual-id-shapes',
            resolveId(request) {
              if (!kinds.includes(request)) return null;
              const suffix =
                request === 'devtools:css'
                  ? '/node_modules/.pnpm/chrome-devtools-frontend@1.0.1638082/node_modules/chrome-devtools-frontend/front_end/panels/test.css.mjs'
                  : '/packages/client/example/src/test.module.css.mjs';
              return '\0dsh-' + request + ':' + cwd + suffix;
            },
            load(id) {
              const kind = kinds.find((kind) => id.startsWith('\0dsh-' + kind + ':'));
              if (!kind) return null;
              return `/*! @license KEEP-${kind} */\nconst css = ${JSON.stringify('.example{color:red}')};\n(globalThis.__zhumaSourcePrivacyProbe ??= []).push(css);\nexport default css;`;
            },
          },
        ];
        if (vite)
          await vite.build({
            configFile: false,
            root: cwd,
            logLevel: 'silent',
            plugins,
            build: {
              outDir,
              emptyOutDir: false,
              minify: compiler === 'vite-minified' ? 'oxc' : false,
              sourcemap: true,
              target: 'es2022',
              lib: { entry: join(cwd, 'entry.js'), formats: ['es'], fileName: () => 'entry.js' },
              rolldownOptions: { experimental: { attachDebugInfo: mode } },
            },
          });
        else
          await build({
            cwd,
            config: false,
            entry: ['entry.js'],
            outDir,
            format: 'esm',
            dts: false,
            sourcemap: true,
            clean: false,
            fixedExtension: false,
            logLevel: 'silent',
            plugins,
            inputOptions: { experimental: { attachDebugInfo: mode } },
          });
        const code = await readFile(join(outDir, 'entry.js'), 'utf8');
        const mapText = await readFile(join(outDir, 'entry.js.map'), 'utf8');
        const map = JSON.parse(mapText);
        const styles = (await import(pathToFileURL(join(outDir, 'entry.js')).href)).styles;
        t.after(() => {
          delete globalThis.__zhumaSourcePrivacyProbe;
        });
        // Vite's existing Oxc minification policy drops inline licenses in both modes;
        // its original DevTools generator separately emits the license files. Do not change that policy.
        if (compiler !== 'vite-minified')
          for (const kind of kinds) assert.ok(code.includes('KEEP-' + kind));
        assert.ok(map.sourcesContent.includes(entry));
        const output = ts.createSourceFile(
          'entry.js',
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        let array;
        function locate(node) {
          if (ts.isArrayLiteralExpression(node) && node.elements.length === 4) array = node;
          ts.forEachChild(node, locate);
        }
        locate(output);
        assert.ok(array);
        const generated = output.getLineAndCharacterOfPosition(array.getStart(output));
        const mapped = new SourceMap(map).findEntry(generated.line, generated.character);
        assert.equal(mapped.originalLine, 4);
        observations.push({
          code,
          map,
          tokens: tokens(code),
          styles,
          legal: code.match(/\/\*![\s\S]*?\*\//g) ?? [],
        });
      }
      assert.equal((observations[0].code.match(/\/\/#region \\0dsh-/g) ?? []).length, 4);
      assert.throws(
        () => assertNoAbsoluteSourceRegions(observations[0].code),
        /Absolute build-source/,
      );
      for (const after of observations.slice(1)) {
        assert.doesNotThrow(() => assertNoAbsoluteSourceRegions(after.code));
        assert.equal(after.code.includes('//#region'), false);
        assert.deepEqual(after.tokens, observations[0].tokens);
        assert.deepEqual(after.styles, observations[0].styles);
        assert.deepEqual(after.legal, observations[0].legal);
      }
      assert.equal(
        observations[1].code,
        observations[2].code,
        'output independent of physical build root',
      );
      assert.equal(observations[1].map.mappings, observations[2].map.mappings);
      assert.deepEqual(observations[1].map.sourcesContent, observations[2].map.sourcesContent);
    },
  );
