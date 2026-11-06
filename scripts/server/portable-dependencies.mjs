/** Preserve pnpm's locked dependency graph; copy only links to public SDK workspaces. */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';

const inside = (root, file) => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
export async function installedDependencyRoot(runtime, ownerFile, name) {
  const root = await realpath(runtime),
    owner = await realpath(ownerFile);
  assert(inside(root, owner), 'Runtime owner escaped the payload.');
  for (const base of createRequire(owner).resolve.paths(name) ?? []) {
    if (!inside(root, base)) continue;
    let target;
    try {
      target = await realpath(join(base, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    assert(inside(root, target), `Runtime dependency escaped the payload: ${name}`);
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name, `Runtime dependency name differs: ${name}`);
    // Never skip a wrong version to find a later matching package: Node would use this first hit.
    return { directory: target, manifest };
  }
  throw new Error(`Runtime dependency is absent: ${name}`);
}
export async function materializeExternalWorkspaceLinks(runtime, sdk) {
  const root = await realpath(runtime),
    sourceRoot = await realpath(sdk),
    groups = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const source = await realpath(file);
        if (inside(root, source)) continue;
        assert(inside(sourceRoot, source), 'Deployment link escaped the fixed SDK.');
        const local = relative(sourceRoot, source).split(sep).join('/');
        assert(
          /^(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|native\/[^/]+\/packages\/[^/]+|apps\/[^/]+)$/u.test(
            local,
          ),
          'Deployment link is not a public SDK package.',
        );
        const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
        assert(
          typeof manifest.name === 'string' &&
            file.endsWith(sep + manifest.name.split('/').join(sep)),
          'Deployment workspace name differs.',
        );
        if (!groups.has(source)) groups.set(source, { manifest, links: [] });
        groups.get(source).links.push(file);
      } else if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  // One original workspace remains one runtime module, including Schema/Cordis identity.
  // Reuse its root alias when present; never overwrite a different installed version.
  for (const [source, item] of groups) {
    const alias = join(root, 'node_modules', item.manifest.name);
    let canonical = join(
      root,
      'node_modules/.zhuma-workspaces',
      encodeURIComponent(item.manifest.name) + '@' + item.manifest.version,
    );
    if (item.links.includes(alias)) canonical = alias;
    if (item.links.includes(canonical)) await rm(canonical);
    await mkdir(dirname(canonical), { recursive: true });
    await cp(source, canonical, {
      recursive: true,
      dereference: true,
      filter(candidate) {
        const parts = relative(source, candidate).split(sep);
        return !parts.includes('node_modules') && !parts.includes('.git');
      },
    });
    item.canonical = canonical;
    for (const file of item.links) {
      if (file === canonical) continue;
      await rm(file);
      await symlink(relative(dirname(file), canonical), file, 'dir');
    }
  }
  // Copied workspace dependencies must still resolve to the exact source lock graph.
  for (const [source, item] of groups)
    for (const name of Object.keys(item.manifest.dependencies ?? {})) {
      const original = await installedDependencyRoot(
        sourceRoot,
        join(source, 'package.json'),
        name,
      );
      const installed = await installedDependencyRoot(
        root,
        join(item.canonical, 'package.json'),
        name,
      );
      assert.equal(
        installed.manifest.version,
        original.manifest.version,
        `Workspace dependency version differs: ${name}`,
      );
    }
  return groups.size;
}
/** Apply the original file policy to virtual-store package contents without deleting the store itself. */
export function portableRuntimeFileExclusion(path, target, officeEngine, originalPolicy) {
  const parts = path.split(/[\\/]/u);
  if (parts[0] === '.pnpm') {
    if (parts[1] === 'lock.yaml') return 'package-manager lock';
    if (parts.length <= 2) return undefined;
    path = parts.slice(parts[1] === 'node_modules' ? 1 : 2).join('/');
  }
  return originalPolicy(path, target, officeEngine);
}
