import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fromRoot, PACKAGE_DIRECTORIES } from './lib/paths.mjs';

const allowedInternal = {
  'agent-core': [],
  context: ['@zhuma/agent-core'],
  'dsh-adapter': ['@zhuma/agent-core', '@zhuma/context'],
  client: ['@zhuma/agent-core'],
};
const errors = [];
const rootManifest = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(fromRoot('runtime.lock.json'), 'utf8'));
if (rootManifest.name !== 'zhuma' || !rootManifest.private)
  errors.push('Invalid root identity or publishing guard.');
if (rootManifest.packageManager !== `pnpm@${lock.toolchain.pnpm}`)
  errors.push('Root pnpm version and runtime.lock.json differ.');
for (const file of ['.node-version', '.nvmrc']) {
  if (readFileSync(fromRoot(file), 'utf8').trim() !== lock.toolchain.node)
    errors.push(`${file} and runtime.lock.json differ.`);
}
const workspace = readFileSync(fromRoot('pnpm-workspace.yaml'), 'utf8');
const globs = workspace
  .split('\n')
  .filter((line) => /^\s+-\s+/.test(line))
  .map((line) => line.trim());
if (globs.length !== 1 || globs[0] !== '- packages/*')
  errors.push('Root workspace must contain only packages/*.');
const actual = readdirSync(fromRoot('packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (actual.join(',') !== [...PACKAGE_DIRECTORIES].sort().join(','))
  errors.push('Package directory list changed; update boundary checks.');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

for (const name of PACKAGE_DIRECTORIES) {
  const root = fromRoot('packages', name);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== `@zhuma/${name}` || manifest.private !== true)
    errors.push(`${name}: invalid package identity/publishing guard`);
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const [dependency, version] of Object.entries(declared)) {
    if (dependency.startsWith('@zhuma/')) {
      if (!allowedInternal[name].includes(dependency) || version !== 'workspace:*')
        errors.push(`${name}: invalid internal dependency ${dependency}`);
    }
  }
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspectImport = (specifier) => {
      if (specifier.startsWith('.')) {
        const relative = path.relative(root, path.resolve(path.dirname(file), specifier));
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          errors.push(`${name}: cross-package relative import ${specifier}`);
        return;
      }
      if (specifier.startsWith('@zhuma/')) {
        if (!allowedInternal[name].includes(specifier))
          errors.push(`${name}: forbidden import ${specifier}`);
      } else if (specifier.startsWith('node:')) {
        if (name !== 'dsh-adapter') errors.push(`${name}: Host-only import ${specifier}`);
      } else {
        const base = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!Object.hasOwn(declared, base)) errors.push(`${name}: undeclared import ${specifier}`);
        if (specifier.startsWith('@deepseek-ai/') && name !== 'dsh-adapter' && name !== 'client')
          errors.push(`${name}: DSH dependency leaked into a domain package`);
      }
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        inspectImport(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        inspectImport(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
if (errors.length) {
  errors.forEach((error) => console.error(`ERROR: ${error}`));
  process.exitCode = 1;
} else {
  console.log('Workspace, package names, version pins and source import boundaries OK.');
}
