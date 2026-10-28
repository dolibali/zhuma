/** Build-stage and filesystem contracts; native archive/smoke proof is run separately on explicit inputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import {
  assertPythonBytecodeUnchanged,
  pythonBytecodeSnapshot,
  verifyRuntimePrivacy,
} from '../../../scripts/desktop/verify-runtime-privacy.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = join(root, 'upstream/deepseek-harness');
const sourceFile = 'scripts/primary-runtime/prepare.ts';
const runtimeFile = 'apps/desktop/scripts/prepare-dsh.ts';
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zhuma-python-privacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function patched(t) {
  const directory = await temporary(t);
  for (const file of [sourceFile, runtimeFile]) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await copyFile(join(sdk, file), join(directory, file));
  }
  if (process.env.ZHUMA_PYTHON_PRIVACY_BASELINE !== '1')
    execFileSync(
      'git',
      [
        'apply',
        `--include=${sourceFile}`,
        `--include=${runtimeFile}`,
        join(root, 'patches/deepseek-harness/zhuma-desktop.patch'),
      ],
      { cwd: directory },
    );
  return directory;
}
const header = () => Buffer.from([0xcb, 0x0d, 0x0d, 0x0a, ...Array(12).fill(0), 0x63]);
async function cache(root, name, bytes = header()) {
  const directory = join(root, 'dependencies/python/lib/python3.12/example');
  await mkdir(join(directory, '__pycache__'), { recursive: true });
  await writeFile(join(directory, `${name}.py`), 'value = 1\n');
  const path = join(directory, '__pycache__', `${name}.cpython-312.pyc`);
  await writeFile(path, bytes);
  return path;
}
test('Python cache filesystem contract: preserve source/cache/license bytes and reject additions, changes and removals', async (t) => {
  const directory = await temporary(t);
  const files = await Promise.all(['one', 'two', 'three'].map((name) => cache(directory, name)));
  const license = join(directory, 'LICENSE');
  await writeFile(license, 'Copyright retained\n');
  const before = pythonBytecodeSnapshot(directory, '3.12.14');
  assert.equal(before.size, 3);
  assert.doesNotThrow(() => verifyRuntimePrivacy(directory));
  assert.doesNotThrow(() => assertPythonBytecodeUnchanged(directory, '3.12.14', before));
  assert.equal(await readFile(license, 'utf8'), 'Copyright retained\n');
  assert.deepEqual(await readFile(files[0]), header());
  await writeFile(files[0], Buffer.concat([header(), Buffer.from('changed')]));
  assert.throws(
    () => assertPythonBytecodeUnchanged(directory, '3.12.14', before),
    /changed Python bytecode/,
  );
  await writeFile(files[0], header());
  const added = await cache(directory, 'four');
  assert.throws(
    () => assertPythonBytecodeUnchanged(directory, '3.12.14', before),
    /changed Python bytecode/,
  );
  await rm(added);
  await rm(files[0]);
  assert.throws(
    () => assertPythonBytecodeUnchanged(directory, '3.12.14', before),
    /changed Python bytecode/,
  );
});
test('Python cache filesystem contract: unknown headers, cache versions, paths, links and sourceless files fail closed without deletion', async (t) => {
  for (const variant of ['header', 'tag', 'legacy', 'source', 'link']) {
    const directory = await temporary(t);
    const path = await cache(directory, 'example');
    let retained = path;
    if (variant === 'header') await writeFile(path, Buffer.from('unrecognized'));
    if (variant === 'tag') {
      retained = path.replace('cpython-312', 'cpython-311');
      await writeFile(retained, await readFile(path));
      await rm(path);
    }
    if (variant === 'legacy') {
      retained = join(dirname(dirname(path)), 'example.pyc');
      await writeFile(retained, await readFile(path));
      await rm(path);
    }
    if (variant === 'source') await rm(join(dirname(dirname(path)), 'example.py'));
    if (variant === 'link') {
      const target = join(directory, 'cache-data');
      await writeFile(target, await readFile(path));
      await rm(path);
      await symlink(target, path, process.platform === 'win32' ? 'file' : undefined);
    }
    assert.throws(
      () => pythonBytecodeSnapshot(directory, '3.12.14'),
      /Python bytecode validation failed/,
    );
    assert.ok(lstatSync(retained), 'validator never removes an unknown cache');
  }
});
test('runtime privacy filesystem contract: reject logical/physical private roots in binary payloads, retain unrelated examples', async (t) => {
  const directory = await temporary(t);
  const payload = join(directory, 'payload');
  await mkdir(payload);
  const logical = join(directory, 'alias');
  await symlink(payload, logical, process.platform === 'win32' ? 'junction' : 'dir');
  const file = join(payload, 'bytes.pyc');
  for (const privateRoot of [realpathSync(payload), logical])
    for (const encoding of ['utf8', 'utf16le']) {
      await writeFile(
        file,
        Buffer.concat([Buffer.from([0, 1]), Buffer.from(privateRoot, encoding)]),
      );
      assert.throws(
        () => verifyRuntimePrivacy(logical),
        (error) => error.message === 'Runtime privacy validation failed',
      );
    }
  const original = Buffer.from(
    'Public examples /Users/example and /tmp/example are unrelated to this runtime.',
  );
  await writeFile(file, original);
  assert.doesNotThrow(() => verifyRuntimePrivacy(logical));
  assert.deepEqual(await readFile(file), original);
  await rm(file);
  await symlink(
    join(directory, 'outside'),
    file,
    process.platform === 'win32' ? 'file' : undefined,
  );
  assert.throws(() => verifyRuntimePrivacy(payload), /Runtime privacy validation failed/);
});

async function smokeFunction(t, onCommand) {
  const directory = await patched(t);
  const text = await readFile(join(directory, sourceFile), 'utf8');
  const source = ts.createSourceFile('prepare.ts', text, ts.ScriptTarget.Latest, true);
  const node = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'smokePrimaryRuntime',
  );
  const javascript = ts.transpileModule(
    node
      .getText(source)
      .replace('export function', 'function')
      .replaceAll('import.meta.dirname', JSON.stringify('/fixture/sdk/scripts/primary-runtime')),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  const bindings = {
    parsePrimaryRuntime: (value) => value,
    readFileSync,
    join,
    dirname,
    lstatSync,
    readlinkSync,
    verifyRuntimePrivacy,
    pythonBytecodeSnapshot,
    assertPythonBytecodeUnchanged,
    workspaceDependencyPaths: (root) => ({
      python: join(root, 'dependencies/python/bin/python3'),
      node: join(root, 'node'),
      pnpm: join(root, 'pnpm'),
    }),
    execFileSync: onCommand,
  };
  return new Function(...Object.keys(bindings), javascript + '\nreturn smokePrimaryRuntime;')(
    ...Object.values(bindings),
  );
}
async function payloadFixture(t) {
  const directory = await temporary(t);
  const bin = join(directory, 'dependencies/python/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'python3.12'), 'fixture interpreter');
  for (const name of ['python', 'python3'])
    await symlink('python3.12', join(bin, name), process.platform === 'win32' ? 'file' : undefined);
  await writeFile(
    join(directory, 'runtime.json'),
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      python: '3.12.14',
      pythonPackages: { numpy: '2.3.5' },
      node: '24.21.0',
      pnpm: '11.28.5',
    }),
  );
  await cache(directory, 'original');
  return directory;
}
test('patched Python smoke contract: force inherited no-bytecode env on every original child without changing caller/global env', async (t) => {
  const payload = await payloadFixture(t);
  const commands = [];
  const run = await smokeFunction(t, (command, args, options) =>
    commands.push({ command, args, options }),
  );
  const environment = { PYTHONDONTWRITEBYTECODE: '0', KEEP: 'ordinary' };
  const globalValue = process.env.PYTHONDONTWRITEBYTECODE;
  run(payload, environment);
  assert.equal(
    commands.length,
    5,
    'original interpreter, Office smoke, pip, Node and pnpm checks retained',
  );
  for (const command of commands) {
    assert.equal(command.options.env.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(command.options.env.KEEP, 'ordinary');
  }
  assert.deepEqual(commands[0].args.slice(0, 3), ['-I', '-B', '-c']);
  assert.deepEqual(commands[2].args, ['-I', '-B', '-m', 'pip', 'check']);
  assert.equal(commands[1].args[2], '/fixture/sdk/scripts/primary-runtime/smoke.py');
  assert.equal(environment.PYTHONDONTWRITEBYTECODE, '0');
  assert.equal(process.env.PYTHONDONTWRITEBYTECODE, globalValue);
});
test('patched Python smoke contract: late cache writes fail the original smoke before successful return', async (t) => {
  const payload = await payloadFixture(t);
  const path = join(
    payload,
    'dependencies/python/lib/python3.12/example/__pycache__/original.cpython-312.pyc',
  );
  const run = await smokeFunction(t, () => appendFileSync(path, 'changed'));
  assert.throws(() => run(payload, {}), /changed Python bytecode/);
});
test('patched runtime source contract: verify copied payload and complete runtime before signing/manifests/descriptors; recipe hashes the checker', async (t) => {
  const directory = await patched(t);
  const prepare = await readFile(join(directory, sourceFile), 'utf8');
  assert.match(
    prepare,
    /await copyPrimaryRuntime\(output, destination, manifest\)\s+pythonBytecodeSnapshot\(destination, manifest.python\)\s+verifyRuntimePrivacy\(destination\)/,
  );
  const runtime = await readFile(join(directory, runtimeFile), 'utf8');
  const guard = runtime.indexOf('verifyRuntimePrivacy(RUNTIME_ROOT)');
  assert.ok(guard > runtime.indexOf("'runtime:materialize-modules'"));
  assert.ok(guard < runtime.indexOf("'sign:dsh-native'"));
  assert.ok(guard < runtime.indexOf("'runtime:manifests'"));
  assert.ok(guard < runtime.indexOf("'runtime:write-descriptor'"));
  const recipe = await readFile(join(root, 'scripts/desktop/prepare.mjs'), 'utf8');
  assert.match(recipe, /readFileSync\(runtimeVerifier\)/);
  assert.match(recipe, /copyFileSync\(runtimeVerifier, stagedRuntimeVerifier\)/);
  assert.match(recipe, /sha256\(readFileSync\(stagedRuntimeVerifier\)\)/);
});
